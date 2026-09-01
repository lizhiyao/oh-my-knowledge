import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReportFileName, randomRunToken, reportFilePath } from '../measurement-artifacts/file-names.js';
import type {
  BuildObservationInboxReportOptions,
  GapSignalRef,
  ObservationCaptureCoverage,
  ObservationEvidence,
  ObservationExperienceReport,
  ObservationInboxItem,
  ObservationInboxReport,
  ObservationMessageRef,
  ObservationMessageWindow,
  ObservationSessionTimeRange,
  ObservationSeverityReasonCode,
  ObservationSignalSubtype,
  ObservationSignalType,
  ObservationSkillRollup,
  ObservationSourceKind,
  TraceIngestionSummary,
  ToolCallInfo,
} from '../types/index.js';
import { extractGapSignalsFromTrace } from '../analysis/gap-analyzer.js';
import {
  loadTraceSessions,
  segmentTraceBySkill,
  tracesToAnalysisEntries,
  skillSegmentTimestampObserved,
  type TraceSession,
  type SkillSegment,
} from './trace-adapter.js';
import { normalizeTraceTimestamp, type TraceEvent } from './trace-ir.js';
import { isSearchToolCall, toolCallQuery } from '../shared/tool-search.js';
import { isToolCallFailure, isToolCallSuccess } from '../shared/tool-call-status.js';
import { isTraceSourceKind as isObservationSourceKind } from '../shared/trace-source-kind.js';
import {
  incrementRecordCount,
  ownRecordValue,
  setOwnRecordValue,
  sumRecordCounts,
} from '../shared/record-count.js';
import { durationMsBetween } from '../shared/time.js';
import {
  buildObservationExperienceReport,
  compactObservationExperienceReport,
  normalizeObservationExperienceReport,
  type PersistedObservationExperienceReport,
} from './experience.js';
import { parseDiagnosisBundle } from '../shared/diagnosis-schema.js';
import { parseTraceIngestionSummary } from './trace-ingestion.js';
import { createTraceSessionIndex, traceSessionRefIdentity } from './trace-session-index.js';
import { isInstalledSkillAssetPath } from './trace-attribution.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import { writeObservationSourceRecordArchives } from './source-record-archive.js';
import { loadExplicitObservationCaptureItems } from './explicit-capture.js';
import { isObservationCaptureCoverage } from './capture-coverage.js';
import {
  normalizeObservationKeyInput,
  observationInboxItemKey,
} from './inbox-identity.js';
import {
  DEFAULT_GLOBAL_OBSERVATIONS_DIR,
  DEFAULT_OBSERVATIONS_DIR,
  DEFAULT_PROJECT_OBSERVATIONS_DIR,
} from './observation-paths.js';

export {
  DEFAULT_GLOBAL_OBSERVATIONS_DIR,
  DEFAULT_OBSERVATIONS_DIR,
  DEFAULT_PROJECT_OBSERVATIONS_DIR,
  normalizeObservationKeyInput,
};

export type {
  BuildObservationInboxReportOptions,
  ObservationCaptureCoverage,
  ObservationEvidence,
  ObservationInboxItem,
  ObservationInboxReport,
  ObservationMessageRef,
  ObservationMessageWindow,
  ObservationSessionTimeRange,
  ObservationSeverityReasonCode,
  ObservationSignalSubtype,
  ObservationSignalType,
  ObservationSkillRollup,
  ObservationSourceKind,
};

export type PersistedObservationInboxReport = Omit<ObservationInboxReport, 'experience'> & {
  experience?: PersistedObservationExperienceReport;
};

// observe inbox（观测收件箱）产物根目录。导出名沿用 *_OBSERVATIONS_DIR 以少动 importer,
// 但落盘目录已统一到 observe-inbox 词根(命令 omk observe inbox / kind observe-inbox)。
// 项目级 .omk/observe-inbox 优先、全局兜底 —— 这套 project/global 归属是既有正常行为,本次只改名不改归属。
const OBSERVATION_INBOX_SCHEMA_VERSION = 2;
const UNOBSERVED_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Legacy migration only. New reports take sourceKind from Trace IR. */
export function inferObservationSourceKind(sourceTrace: string): ObservationSourceKind {
  const normalized = sourceTrace.replaceAll('\\', '/').toLowerCase();
  if (/(?:^|\/)\.?openclaw(?:\/|$)/.test(normalized)) return 'openclaw';
  if (/(?:^|\/)\.?codex\/sessions(?:\/|$)/.test(normalized)) return 'codex';
  if (/(?:^|\/)\.?claude(?:\/|$)/.test(normalized)) return 'claude';
  if (normalized.endsWith('.log')) return 'markdown_log';
  return 'unknown';
}

function markerTokenFromSignal(signal: GapSignalRef): string {
  const evidence = signal.evidence as { marker?: unknown } | undefined;
  const marker = typeof evidence?.marker === 'string' ? evidence.marker : '';
  const context = signal.context ?? '';
  return marker || (context.match(/【推断】|【知识缺口】|【未知】|\[inferred\]|\[unknown\]|\[knowledge\s*gap\]/i)?.[0] ?? 'explicit_marker');
}

function snippet(value: unknown, max = 240): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function isSuccessfulSearch(tc: ToolCallInfo): boolean {
  if (!isSearchToolCall(tc) || !isToolCallSuccess(tc)) return false;
  const out = snippet(tc.output, 1000) ?? '';
  return out !== '' && !/No matches found/i.test(out);
}

function bashCommand(tc: ToolCallInfo): string {
  const input = (tc.input && typeof tc.input === 'object') ? tc.input as Record<string, unknown> : {};
  return String(input.command ?? '');
}

function isBashProbe(tc: ToolCallInfo): boolean {
  if (tc.tool !== 'Bash') return false;
  const command = bashCommand(tc);
  if (/2>\s*\/dev\/null|\|\|\s*(true|echo\b)/.test(command)) return true;
  return /\b(ls|test)\b.+(?:\/|\.\/|\.\.|~)/.test(command);
}

function failedSearchSubtype(tc: ToolCallInfo, allCalls: ToolCallInfo[], index: number, skillName: string): ObservationSignalSubtype {
  const out = snippet(tc.output, 1000) ?? '';
  if (isBashProbe(tc)) return 'bash_probe';
  if (/permission denied|not authorized|eacces/i.test(out)) return 'permission_denied';
  const q = toolCallQuery(tc);
  const failedPath = q.path || q.query || '';
  if (tc.tool === 'Read' && isSkillAssetPath(failedPath, skillName)) return 'skill_asset_read_failed';
  if (/enoent|no such file or directory|path does not exist|file does not exist|not found|did you mean/i.test(out) && isTransientPath(failedPath)) return 'transient_file_missing';
  if (/enoent|no such file or directory|path does not exist|file does not exist|not found|did you mean/i.test(out)) return 'not_found';
  if (/exceeds maximum allowed tokens|maximum allowed tokens|token limit|timed out|timeout/i.test(out)) return 'tool_limit';
  if (isToolCallFailure(tc)) return 'tool_failure';
  const laterSuccess = allCalls.slice(index + 1).some((later) => isSuccessfulSearch(later) && isSameTopicSearch(tc, later));
  return laterSuccess ? 'exploratory_miss' : 'hard_miss';
}

function isTransientPath(value: string): boolean {
  return /(?:^|\s)(?:\/private)?\/tmp\/|(?:^|\s)\/var\/folders\/|figma_[\w.-]+\.(?:png|jpg|jpeg|webp)\b/i.test(value);
}

function isSkillAssetPath(value: string, skillName: string): boolean {
  return isInstalledSkillAssetPath(value, skillName);
}

function topicTokens(value: string): Set<string> {
  return new Set(
    normalizeObservationKeyInput(value)
      .split(/[^a-z0-9_\u4e00-\u9fff]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !['find', 'grep', 'head', 'tail', 'cat', 'src', 'path', 'file', 'repo'].includes(part)),
  );
}

function isSameTopicSearch(a: ToolCallInfo, b: ToolCallInfo): boolean {
  const qa = toolCallQuery(a);
  const qb = toolCallQuery(b);
  if (qa.query) {
    const queryTokens = topicTokens(qa.query);
    if (queryTokens.size === 0) return false;
    // Bash 的 output 通常只是 path-echo (ls/cat/test 直接打印路径), 路径里的 cwd / repo
    // token 会污染同主题判定。所以 Bash later success 只用 basename(structured path) 比对,
    // 不读 output。Read 的 output 是文件内容, 用基名 + 内容做比对更可信。
    const isBashLater = b.tool === 'Bash';
    const laterText = qb.query
      ?? (isBashLater
        ? basenameForTopic(qb.path)
        : `${basenameForTopic(qb.path)} ${snippet(b.output, 1000) ?? ''}`);
    const laterTokens = topicTokens(laterText);
    for (const token of queryTokens) {
      if (laterTokens.has(token) || normalizeObservationKeyInput(laterText).includes(token)) return true;
    }
    return false;
  }
  const left = qa.path ?? '';
  const right = qb.query ?? qb.path ?? '';
  const aTokens = topicTokens(left);
  const bTokens = topicTokens(right);
  for (const token of aTokens) {
    if (bTokens.has(token)) return true;
  }
  return false;
}

function basenameForTopic(value: string | undefined): string {
  if (!value) return '';
  return value.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function confidenceForSubtype(subtype: ObservationSignalSubtype, signal?: GapSignalRef): number {
  if (signal?.type === 'repeated_failure') return 0.95;
  if (subtype === 'repeated_failure') return 0.95;
  if (subtype === 'hard_miss') return 0.9;
  if (subtype === 'exploratory_miss' || subtype === 'bash_probe') return 0.4;
  if (subtype === 'skill_asset_read_failed') return 0.4;
  if (subtype === 'tool_error' || subtype === 'permission_error' || subtype === 'not_found' || subtype === 'transient_file_missing' || subtype === 'permission_denied' || subtype === 'tool_limit' || subtype === 'tool_failure') return 0.2;
  if (subtype === 'regex_only') return 0.3;
  if (subtype === 'llm_classified') {
    const c = Number(signal?.classifierVerdict?.confidence);
    return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5;
  }
  return 0.5;
}

function severityFor(signalType: ObservationSignalType, subtype: ObservationSignalSubtype, confidence: number): ObservationInboxItem['severity'] {
  if (signalType === 'repeated_failure' || signalType === 'explicit_marker' || signalType === 'user_feedback') return 'high';
  if (subtype === 'hard_miss') return 'high';
  if (signalType === 'hedging' && confidence >= 0.7) return 'high';
  if (subtype === 'exploratory_miss' || subtype === 'bash_probe') return 'medium';
  if (subtype === 'skill_asset_read_failed') return 'medium';
  if (subtype === 'tool_error' || subtype === 'permission_error' || subtype === 'not_found' || subtype === 'transient_file_missing' || subtype === 'permission_denied' || subtype === 'tool_limit' || subtype === 'tool_failure' || subtype === 'regex_only') return 'noise';
  return 'low';
}

function buildSessionTimeRanges(sessions: TraceSession[]): ObservationSessionTimeRange[] {
  return sessions.map((session): ObservationSessionTimeRange => ({
    sessionId: session.runId,
    traceId: session.traceId,
    sessionGroupId: session.rootRunId,
    sourceTrace: session.sourcePath,
    sourceKind: session.sourceKind,
    traceRole: session.role,
    traceLabel: session.label,
    cwd: session.cwd,
    startTimestamp: session.startTimestamp,
    endTimestamp: session.endTimestamp,
    durationMs: durationMsBetween(session.startTimestamp, session.endTimestamp),
  })).sort((a, b) =>
    (a.startTimestamp ?? '').localeCompare(b.startTimestamp ?? '')
    || a.sourceTrace.localeCompare(b.sourceTrace)
  );
}

function buildOverallSessionTimeRange(ranges: ObservationSessionTimeRange[]): ObservationInboxReport['meta']['sessionTimeRange'] {
  const starts = ranges.map((range) => range.startTimestamp).filter((value): value is string => Boolean(value));
  const ends = ranges.map((range) => range.endTimestamp).filter((value): value is string => Boolean(value));
  if (starts.length === 0 || ends.length === 0) return { from: '', to: '' };
  const from = starts.reduce((min, value) => value < min ? value : min, starts[0]);
  const to = ends.reduce((max, value) => value > max ? value : max, ends[0]);
  return { from, to, durationMs: durationMsBetween(from, to) };
}

const SEVERITY_REASON_ZH: Record<ObservationSeverityReasonCode, string> = {
  repeated_failure_suspected: '同类搜索连续失败 3 次以上，是强缺口信号，高于单次 hard_miss。',
  explicit_gap_marker: 'agent 主动输出了知识缺口/未知标记，需要优先人工确认。',
  knowledge_gap_suspected: '{tool}失败后，session 内未找到同主题成功证据，疑似知识缺口。',
  exploratory_probe: 'skill 运行过程中出现了试路径、试目录或前序失败后后续成功的行为；先抽样确认，不直接判为要改 skill。',
  skill_asset_unavailable: '读取该 skill 自身资源失败，可能是路径错位、资源未提交或 ignore 配置问题。',
  soft_hedging_signal: '模型文本里出现了不确定表达，属于低置信文本信号，需要结合上下文人工判断。',
  user_reported_knowledge_issue: '用户明确提交了真实使用中的 knowledge 问题；当前只保留用户授权提交的部分证据，需人工复核后再进入样本集。',
  tool_or_runtime_noise: '更像路径、权限、文件太大、临时文件或工具运行问题；通常不作为 skill 内容缺失。',
};

const SEVERITY_REASON_EN: Record<ObservationSeverityReasonCode, string> = {
  repeated_failure_suspected: 'Similar searches failed at least three times; this is stronger than a single hard miss.',
  explicit_gap_marker: 'The agent explicitly marked an unknown or knowledge gap; review this first.',
  knowledge_gap_suspected: '{tool}failed and no later same-topic success was found in the session.',
  exploratory_probe: 'The event looks like path probing, directory probing, or an earlier miss followed by later success; sample it before changing the skill.',
  skill_asset_unavailable: 'The agent failed to read an asset inside the skill itself; check path alignment, committed resources, or ignore rules.',
  soft_hedging_signal: 'The agent used uncertain wording; treat this as a low-confidence text signal.',
  user_reported_knowledge_issue: 'The user explicitly submitted a knowledge issue from real usage; only the authorized partial evidence is retained until human review.',
  tool_or_runtime_noise: 'This looks like a path, permission, token limit, transient file, or runtime tool issue rather than missing skill content.',
};

export function severityReasonFor(item: Pick<ObservationInboxItem, 'signalType' | 'signalSubtype' | 'severity' | 'confidence' | 'evidence' | 'severityReasonCode'>, lang: 'zh' | 'en' = 'zh'): string {
  const code = item.severityReasonCode ?? severityReasonCodeFor(item);
  const tool = item.evidence.tool ? `${item.evidence.tool} ` : '';
  const dictionary = lang === 'en' ? SEVERITY_REASON_EN : SEVERITY_REASON_ZH;
  return dictionary[code].replace('{tool}', tool);
}

export function legacySeverityReasonFor(item: Pick<ObservationInboxItem, 'signalType' | 'signalSubtype' | 'severity' | 'confidence' | 'evidence'>): string {
  const tool = item.evidence.tool ? `${item.evidence.tool} ` : '';
  if (item.signalType === 'repeated_failure') return '同类搜索连续失败 3 次以上，是强缺口信号，高于单次 hard_miss。';
  if (item.signalType === 'explicit_marker') return 'agent 主动输出了知识缺口/未知标记，需要优先人工确认。';
  if (item.signalSubtype === 'hard_miss') return `${tool}失败后，session 内未找到同主题成功证据，疑似知识缺口。`;
  if (item.signalSubtype === 'bash_probe') return 'skill 运行过程中，agent 调用了一条 Bash 命令；命令里用了 2>/dev/null 或 || true/echo 这类“失败也继续”的写法，更像是在试路径，不直接判为要改 skill。';
  if (item.signalSubtype === 'exploratory_miss') return '前序搜索失败，但后续出现成功搜索证据，更像探索性试错。';
  if (item.signalSubtype === 'tool_limit') return `${tool}触发 token/超时等工具限制，与知识库覆盖无直接关系。`;
  if (item.signalSubtype === 'transient_file_missing') return `${tool}访问的是 /tmp 或临时生成文件，默认按临时文件丢失处理，不作为 skill 内容缺失。`;
  if (item.signalSubtype === 'skill_asset_read_failed') return `${tool}读取该 skill 自身资源失败，可能是路径错位、资源未提交或 ignore 配置问题。`;
  if (item.signalSubtype === 'not_found') return `${tool}访问的文件或路径不存在，先按路径/环境噪声处理。`;
  if (item.signalSubtype === 'permission_denied') return `${tool}访问被权限拒绝，先按权限/环境噪声处理。`;
  if (item.signalSubtype === 'tool_failure') return `${tool}调用失败，先按运行时工具问题处理。`;
  if (item.signalSubtype === 'regex_only') return '仅命中 hedging 正则，假阳风险较高，默认作为低优先级噪声。';
  if (item.signalSubtype === 'llm_classified') return 'hedging 经过分类器确认，confidence 来自分类器输出。';
  return '低置信信号，需要结合 evidence 和上下文人工判断。';
}

export function severityReasonCodeFor(item: Pick<ObservationInboxItem, 'signalType' | 'signalSubtype' | 'severity' | 'confidence'>): ObservationSeverityReasonCode {
  if (item.signalType === 'user_feedback') return 'user_reported_knowledge_issue';
  if (item.signalSubtype === 'repeated_failure') return 'repeated_failure_suspected';
  if (item.signalType === 'explicit_marker') return 'explicit_gap_marker';
  if (item.signalSubtype === 'hard_miss') return 'knowledge_gap_suspected';
  if (item.signalSubtype === 'skill_asset_read_failed') return 'skill_asset_unavailable';
  if (item.signalSubtype === 'exploratory_miss' || item.signalSubtype === 'bash_probe') return 'exploratory_probe';
  if (item.signalType === 'hedging') return 'soft_hedging_signal';
  return 'tool_or_runtime_noise';
}

function itemsFromSegment(segment: SkillSegment): ObservationInboxItem[] {
  // inbox 只观察真实 skill 调用场景。'general' 是 trace-adapter 对裸对话的
  // 兜底归因（无 Skill tool / 无 <command-name> / 无 Read SKILL.md），
  // attributionConfidence 仅 0.3，没有 skill 改进价值，直接过滤。
  if (segment.skillName === 'general') return [];

  const evidenceStreamId = traceSessionRefIdentity(segment);
  const sampleId = `${evidenceStreamId}:${segment.segmentIndex}`;
  const signals = extractGapSignalsFromTrace({
    sampleId,
    turns: segment.turns,
    toolCalls: segment.toolCalls,
  });
  const items: ObservationInboxItem[] = [];
  const toolCalls = segment.toolCalls;
  const failedSignalsSeen = new Set<number>();

  for (const signal of signals) {
    let subtype: ObservationSignalSubtype;
    let evidence: ObservationEvidence = {};

    if (signal.type === 'failed_search') {
      const matchIndex = toolCalls.findIndex((tc, i) => {
        if (failedSignalsSeen.has(i)) return false;
        const q = toolCallQuery(tc);
        const signalPattern = String(signal.evidence?.pattern ?? '');
        const sameQuery = !signalPattern
          || q.query === signalPattern
          || (tc.tool === 'Bash' && Boolean(q.query && (q.query.startsWith(signalPattern) || signalPattern.startsWith(q.query.slice(0, signalPattern.length)))));
        return tc.tool === signal.evidence?.tool
          && sameQuery
          && (!signal.evidence?.path || q.path === signal.evidence.path);
      });
      const tc = matchIndex >= 0 ? toolCalls[matchIndex] : undefined;
      if (matchIndex >= 0) failedSignalsSeen.add(matchIndex);
      subtype = tc ? failedSearchSubtype(tc, toolCalls, matchIndex, segment.skillName) : 'hard_miss';
      const q = tc ? toolCallQuery(tc) : { query: String(signal.evidence?.pattern ?? ''), path: String(signal.evidence?.path ?? '') };
      evidence = {
        tool: snippet(signal.evidence?.tool ?? tc?.tool, 80),
        query: snippet(q.query),
        path: snippet(q.path),
        outputSnippet: snippet(tc?.output),
        messageIndex: tc?.messageIndex,
        messageUuid: tc?.messageUuid,
        callInstanceId: tc?.callInstanceId,
        toolUseId: tc?.toolUseId,
        segmentTimestamp: tc?.timestamp ?? segment.startTimestamp,
      };
    } else if (signal.type === 'repeated_failure') {
      subtype = 'repeated_failure';
      evidence = { tool: snippet(signal.evidence?.tool, 80), outputSnippet: snippet(signal.context) };
    } else if (signal.type === 'hedging') {
      subtype = signal.classifierVerdict ? 'llm_classified' : 'regex_only';
      evidence = { assistantSnippet: snippet(signal.context) };
    } else {
      subtype = 'marker';
      evidence = { markerToken: snippet(markerTokenFromSignal(signal), 80), assistantSnippet: snippet(signal.context) };
    }

    const signalType = signal.type as ObservationSignalType;
    const confidence = confidenceForSubtype(subtype, signal);
    const severity = severityFor(signalType, subtype, confidence);
    const item: ObservationInboxItem = {
      id: hashString([evidenceStreamId, segment.segmentIndex, signal.type, subtype, JSON.stringify(evidence)].join('\u0000')),
      skillName: segment.skillName,
      artifactVersion: 'unknown',
      cwd: segment.cwd,
      sessionId: segment.sessionId,
      traceId: evidenceStreamId,
      sourceTrace: '',
      sourceKind: 'unknown',
      signalType,
      signalSubtype: subtype,
      confidence,
      attributionConfidence: segment.attribution?.confidence ?? 0.3,
      severity,
      severityReasonCode: severityReasonCodeFor({ signalType, signalSubtype: subtype, severity, confidence }),
      evidence,
      firstSeen: segment.startTimestamp,
      lastSeen: segment.endTimestamp,
      occurrences: 1,
      timestampedOccurrences: skillSegmentTimestampObserved(segment) ? 1 : 0,
      recentSessionIds: [segment.sessionId],
      recentTraceIds: [evidenceStreamId],
      representativeEvidence: [evidence],
    };
    items.push(item);
  }

  return items;
}

function skillSessionCountKey(segment: SkillSegment): string {
  if (segment.traceRole && segment.traceRole !== 'standalone') return segment.sessionId;
  return traceSessionRefIdentity(segment);
}

/**
 * 不再附带 diagnostics 字段 —— observability 不再反向驱动 diagnosis。
 * 需要 diagnostics 的调用方(如 CLI observe ingest)拿到 report 后,自行调
 * `buildObserveDiagnosticsFromReport(report)` 写入 `report.diagnostics`。
 */
export function buildObservationInboxReport(tracePath: string, options: BuildObservationInboxReportOptions = {}): ObservationInboxReport {
  const { sessions, ingestion } = tracesToAnalysisEntries(tracePath);
  return buildObservationInboxReportFromTraceSessions(tracePath, sessions, ingestion, options);
}

/** Build the existing inbox artifact from an in-memory source-neutral corpus. */
export function buildObservationInboxReportFromTraceSessions(
  tracePath: string,
  sessions: TraceSession[],
  ingestion: TraceIngestionSummary,
  options: BuildObservationInboxReportOptions = {},
): ObservationInboxReport {
  const segments = sessions.flatMap(segmentTraceBySkill);
  const skillSegments = segments.filter((segment) => segment.skillName !== 'general');
  const generatedAt = new Date().toISOString();
  const sessionTimeRanges = buildSessionTimeRanges(sessions);
  const sessionTimeRange = buildOverallSessionTimeRange(sessionTimeRanges);
  const skillInvocationCounts: Record<string, number> = {};
  const skillInvocationLastSeen: Record<string, string> = {};
  const skillToolCallCounts: Record<string, Record<string, number>> = {};
  const sessionsBySkill = new Map<string, Set<string>>();
  let timestampedSegmentCount = 0;
  for (const segment of skillSegments) {
    incrementRecordCount(skillInvocationCounts, segment.skillName);
    if (skillSegmentTimestampObserved(segment)) {
      timestampedSegmentCount += 1;
      const previousLastSeen = ownRecordValue(skillInvocationLastSeen, segment.skillName);
      if (!previousLastSeen || segment.endTimestamp > previousLastSeen) {
        setOwnRecordValue(skillInvocationLastSeen, segment.skillName, segment.endTimestamp);
      }
    }
    const toolCounts = ownRecordValue(skillToolCallCounts, segment.skillName) ?? {};
    for (const toolCall of segment.toolCalls) {
      incrementRecordCount(toolCounts, toolCall.tool);
    }
    setOwnRecordValue(skillToolCallCounts, segment.skillName, toolCounts);
    const set = sessionsBySkill.get(segment.skillName) ?? new Set<string>();
    set.add(skillSessionCountKey(segment));
    sessionsBySkill.set(segment.skillName, set);
  }
  const skillSessionCounts = Object.fromEntries(
    Array.from(sessionsBySkill.entries()).map(([skill, sessionIds]) => [skill, sessionIds.size]),
  );
  const sessionIndex = createTraceSessionIndex(sessions);
  const messageRefsByTraceId = new Map<string, ObservationMessageRef[]>();
  const messageRefsForSegment = (segment: SkillSegment): ObservationMessageRef[] | undefined => {
    const session = sessionIndex.resolve(segment);
    if (!session) return undefined;
    if (messageRefsByTraceId.has(session.traceId)) {
      return messageRefsByTraceId.get(session.traceId);
    }
    const messages = messageRefsFromEvents(session.events);
    messageRefsByTraceId.set(session.traceId, messages);
    return messages;
  };
  const aggregationState = createInboxAggregationState();
  const occurrenceItems: ObservationInboxItem[] = [];
  for (const segment of skillSegments) {
    const sourceTrace = segment.sourceTrace ?? tracePath;
    const resolvedSession = sessionIndex.resolve(segment);
    const traceId = segment.traceId
      ?? resolvedSession?.traceId
      ?? traceSessionRefIdentity(segment);
    const sourceKind = segment.sourceKind ?? resolvedSession?.sourceKind ?? 'unknown';
    const segmentItems = itemsFromSegment(segment).map((item) => {
      const evidence: ObservationEvidence = {
        ...item.evidence,
        traceId,
        sessionId: segment.sessionId,
        sourceTrace,
        sourceKind,
      };
      const withSource = {
        ...item,
        traceId,
        sourceTrace,
        sourceKind,
        evidence,
        recentTraceIds: [traceId],
        representativeEvidence: [evidence],
      };
      return {
        ...withSource,
        messageWindow: buildObservationMessageWindow(
          withSource,
          3,
          messageRefsForSegment(segment),
        ),
      };
    });
    occurrenceItems.push(...segmentItems);
    addInboxItemsToState(aggregationState, segmentItems);
  }
  const items = finishInboxAggregation(aggregationState);
  // Experience 归因必须基于每次实际发生的 signal。收件箱聚合会跨 session
  // 合并同类项，firstSeen/lastSeen 和 sourceTrace 已不足以反推原 invocation。
  // occurrence 仍引用聚合 item 的稳定 ID，保证 experience 引用可在 report.items
  // 中解析，同时保留本次发生的 trace/session/timestamp 作为归因事实。
  const experienceItems = occurrenceItems.map((item) => ({
    ...item,
    id: aggregationState.byKey.get(observationInboxItemKey(item))?.id ?? item.id,
  }));
  const experience = buildObservationExperienceReport({
    sessions,
    segments: skillSegments,
    items: experienceItems,
    generatedAt,
    reviewState: options.reviewState,
  });
  const report: ObservationInboxReport = {
    kind: 'observe-inbox',
    schemaVersion: OBSERVATION_INBOX_SCHEMA_VERSION,
    meta: {
      tracePath,
      generatedAt,
      sessionCount: sessions.length,
      sessionTimeRange,
      sessionTimeRanges,
      ingestion,
      segmentCount: skillSegments.length,
      itemCount: items.length,
      skillInvocationCounts,
      skillSessionCounts,
      skillInvocationLastSeen,
      skillToolCallCounts,
      timestampedSegmentCount,
      timestampCoverage: skillSegments.length > 0
        ? timestampedSegmentCount / skillSegments.length
        : 0,
    },
    items,
    experience,
  };
  return report;
}

interface InboxAggregationState {
  byKey: Map<string, ObservationInboxItem>;
  sessionLastSeenByKey: Map<string, Map<string, string>>;
  traceLastSeenByKey: Map<string, Map<string, string>>;
  primaryOccurrenceIdByKey: Map<string, string>;
}

function createInboxAggregationState(): InboxAggregationState {
  return {
    byKey: new Map<string, ObservationInboxItem>(),
    sessionLastSeenByKey: new Map<string, Map<string, string>>(),
    traceLastSeenByKey: new Map<string, Map<string, string>>(),
    primaryOccurrenceIdByKey: new Map<string, string>(),
  };
}

function addInboxItemsToState(state: InboxAggregationState, items: ObservationInboxItem[]): void {
  for (const item of items) {
    const key = observationInboxItemKey(item);
    const sessionLastSeen = state.sessionLastSeenByKey.get(key) ?? new Map<string, string>();
    const traceLastSeen = state.traceLastSeenByKey.get(key) ?? new Map<string, string>();
    const traceIdentity = item.traceId
      ?? item.evidence.traceId
      ?? `${item.sourceTrace}\u0000${item.sessionId}`;
    const previousSessionLastSeen = sessionLastSeen.get(item.sessionId);
    if (!previousSessionLastSeen || item.lastSeen > previousSessionLastSeen) {
      sessionLastSeen.set(item.sessionId, item.lastSeen);
    }
    state.sessionLastSeenByKey.set(key, sessionLastSeen);
    const previousTraceLastSeen = traceLastSeen.get(traceIdentity);
    if (!previousTraceLastSeen || item.lastSeen > previousTraceLastSeen) {
      traceLastSeen.set(traceIdentity, item.lastSeen);
    }
    state.traceLastSeenByKey.set(key, traceLastSeen);
    const existing = state.byKey.get(key);
    if (!existing) {
      state.primaryOccurrenceIdByKey.set(key, item.id);
      state.byKey.set(key, {
        ...item,
        id: hashString(`aggregate\u0000${key}`),
        timestampedOccurrences: timestampedOccurrencesOf(item),
        representativeEvidence: [item.evidence],
        recentSessionIds: [item.sessionId],
        recentTraceIds: [traceIdentity],
      });
      continue;
    }
    const existingTimestampedOccurrences = timestampedOccurrencesOf(existing);
    const itemTimestampedOccurrences = timestampedOccurrencesOf(item);
    existing.occurrences = sumRecordCounts(existing.occurrences, item.occurrences);
    if (itemTimestampedOccurrences > 0) {
      if (existingTimestampedOccurrences === 0 || item.firstSeen < existing.firstSeen) {
        existing.firstSeen = item.firstSeen;
      }
      if (existingTimestampedOccurrences === 0 || item.lastSeen > existing.lastSeen) {
        existing.lastSeen = item.lastSeen;
      }
    }
    existing.timestampedOccurrences = sumRecordCounts(
      existingTimestampedOccurrences,
      itemTimestampedOccurrences,
    );
    const shouldReplaceEvidence =
      severityRank(item.severity) > severityRank(existing.severity)
      || (
        item.severity === existing.severity
        && (
          item.confidence > existing.confidence
          || (item.confidence === existing.confidence && item.lastSeen > existing.lastSeen)
          || (
            item.confidence === existing.confidence
            && item.lastSeen === existing.lastSeen
            && item.id.localeCompare(state.primaryOccurrenceIdByKey.get(key) ?? '') < 0
          )
        )
      );
    if (shouldReplaceEvidence) {
      state.primaryOccurrenceIdByKey.set(key, item.id);
      existing.severity = item.severity;
      existing.evidence = item.evidence;
      existing.sessionId = item.sessionId;
      existing.sourceTrace = item.sourceTrace;
      existing.sourceKind = item.sourceKind;
      replaceOptionalProperty(existing, 'severityReasonCode', item.severityReasonCode);
      replaceOptionalProperty(existing, 'messageWindow', item.messageWindow);
      replaceOptionalProperty(existing, 'traceId', item.traceId);
      replaceOptionalProperty(existing, 'cwd', item.cwd);
      replaceOptionalProperty(existing, 'captureCoverage', item.captureCoverage);
    }
    existing.confidence = Math.max(existing.confidence, item.confidence);
    existing.attributionConfidence = Math.max(existing.attributionConfidence, item.attributionConfidence);
    existing.recentSessionIds = Array.from(sessionLastSeen.entries())
      .sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]))
      .map(([sessionId]) => sessionId)
      .slice(0, 3);
    existing.recentTraceIds = Array.from(traceLastSeen.entries())
      .sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0]))
      .map(([identity]) => identity)
      .slice(0, 3);
    existing.representativeEvidence = stableRepresentativeEvidence(
      existing.evidence,
      [...existing.representativeEvidence, item.evidence],
    );
  }
}

function timestampedOccurrencesOf(item: ObservationInboxItem): number {
  return item.timestampedOccurrences
    ?? (item.firstSeen === UNOBSERVED_TIMESTAMP && item.lastSeen === UNOBSERVED_TIMESTAMP
      ? 0
      : item.occurrences);
}

function replaceOptionalProperty<
  T extends object,
  K extends keyof T,
>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

function stableRepresentativeEvidence(
  primary: ObservationEvidence,
  values: ObservationEvidence[],
): ObservationEvidence[] {
  const primaryKey = observationEvidenceIdentity(primary);
  const uniqueEvidence = new Map<string, ObservationEvidence>();
  for (const value of values) {
    uniqueEvidence.set(observationEvidenceIdentity(value), value);
  }
  uniqueEvidence.set(primaryKey, primary);
  const others = Array.from(uniqueEvidence.entries())
    .filter(([key]) => key !== primaryKey)
    .sort((a, b) =>
      (b[1].segmentTimestamp ?? '').localeCompare(a[1].segmentTimestamp ?? '')
      || a[0].localeCompare(b[0])
    )
    .map(([, value]) => value);
  return [primary, ...others].slice(0, 50);
}

function observationEvidenceIdentity(value: ObservationEvidence): string {
  return JSON.stringify([
    value.traceId ?? '',
    value.sessionId ?? '',
    value.sourceTrace ?? '',
    value.sourceKind ?? '',
    value.tool ?? '',
    value.query ?? '',
    value.path ?? '',
    value.outputSnippet ?? '',
    value.assistantSnippet ?? '',
    value.userFeedbackSnippet ?? '',
    value.submittedEvidenceSnippet ?? '',
    value.markerToken ?? '',
    value.messageIndex ?? null,
    value.messageUuid ?? '',
    value.callInstanceId ?? '',
    value.toolUseId ?? '',
    value.segmentTimestamp ?? '',
  ]);
}

function finishInboxAggregation(state: InboxAggregationState): ObservationInboxItem[] {
  return Array.from(state.byKey.values()).sort(compareInboxItems);
}

export function aggregateInboxItems(items: ObservationInboxItem[]): ObservationInboxItem[] {
  const state = createInboxAggregationState();
  addInboxItemsToState(state, items);
  return finishInboxAggregation(state);
}

function severityRank(severity: ObservationInboxItem['severity']): number {
  if (severity === 'high') return 4;
  if (severity === 'medium') return 3;
  if (severity === 'low') return 2;
  return 1;
}

function compareInboxItems(a: ObservationInboxItem, b: ObservationInboxItem): number {
  const severity = severityRank(b.severity) - severityRank(a.severity);
  if (severity !== 0) return severity;
  const confidence = b.confidence - a.confidence;
  if (confidence !== 0) return confidence;
  const timestampEvidence =
    Number(timestampedOccurrencesOf(b) > 0) - Number(timestampedOccurrencesOf(a) > 0);
  if (timestampEvidence !== 0) return timestampEvidence;
  const lastSeen = b.lastSeen.localeCompare(a.lastSeen);
  if (lastSeen !== 0) return lastSeen;
  return b.occurrences - a.occurrences;
}

export function saveObservationInboxReport(report: ObservationInboxReport, outDir: string = DEFAULT_OBSERVATIONS_DIR): string {
  const compact = compactObservationInboxReport(report);
  if (!normalizeObservationInboxReport(compact)) {
    throw new Error('拒绝写入无法回读的 observe inbox 报告。');
  }
  mkdirSync(outDir, { recursive: true });
  // 保留毫秒并追加随机段；即使同一毫秒生成两份 report，也不能静默互相覆盖。
  // 例: '2026-05-07T12:00:00.999Z' → '2026-05-07T12-00-00-999'
  const stamp = report.meta.generatedAt.replace(/[:.]/g, '-').replace(/Z$/, '');
  const path = reportFilePath(outDir, `${stamp}-${randomRunToken()}`);
  const sourceRecordArchives = writeObservationSourceRecordArchives(report, outDir, path);
  const persisted = sourceRecordArchives.length > 0
    ? { ...compact, meta: { ...compact.meta, sourceRecordArchives } }
    : compact;
  if (!normalizeObservationInboxReport(persisted)) {
    throw new Error('拒绝写入原始日志引用无效的 observe inbox 报告。');
  }
  writeJsonFileAtomic(path, persisted);
  return path;
}

export function compactObservationInboxReport(
  report: ObservationInboxReport,
): PersistedObservationInboxReport {
  const { experience, ...persisted } = report;
  return experience
    ? {
        ...persisted,
        experience: compactObservationExperienceReport(experience),
      }
    : persisted;
}

export function loadObservationInboxReports(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxReport[] {
  if (!existsSync(dir)) {
    if (dir === DEFAULT_PROJECT_OBSERVATIONS_DIR && existsSync(DEFAULT_GLOBAL_OBSERVATIONS_DIR)) {
      return loadObservationInboxReports(DEFAULT_GLOBAL_OBSERVATIONS_DIR);
    }
    return [];
  }
  return readdirSync(dir)
    .filter(isReportFileName)
    .map((file) => {
      try {
        const report = normalizeObservationInboxReport(JSON.parse(readFileSync(join(dir, file), 'utf-8')));
        if (!report) return null;
        report.items = report.items.map((item) => {
          return {
            ...item,
            sourceKind: item.sourceKind ?? inferObservationSourceKind(item.sourceTrace),
            severityReasonCode: item.severityReasonCode ?? severityReasonCodeFor(item),
            severityReason: undefined,
          };
        });
        // 不在 load 路径重建 diagnostics:`buildObserveDiagnosticsFromReport` 现在虽然会从
        // report.items[].cwd / experience 推断每个 skill 的 cwd(没把握就跳过该 skill 的
        // chain advisory,不再 fallback process.cwd()),但 load 时全跳过的话整个 trace
        // 都没有 Diagnosis。新版 build 路径由调用方(CLI observe ingest)在 build 之后
        // 显式驱动 diagnostics 装配后写入 JSON;老 inbox JSON 缺字段时让 Studio 显示
        // 「该 trace 暂无 Diagnosis,请重新 observe 一次」,比惰性重建安全。
        return report;
      } catch {
        return null;
      }
    })
    .filter((r): r is ObservationInboxReport => r?.kind === 'observe-inbox');
}

function normalizeObservationInboxReport(value: unknown): ObservationInboxReport | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Record<string, unknown>;
  const kind = report.kind === 'observe-inbox' ? report.kind : null;
  if (!kind) return null;
  if (report.schemaVersion !== OBSERVATION_INBOX_SCHEMA_VERSION) return null;
  if (!isObservationInboxMeta(report.meta) || !Array.isArray(report.items)) return null;
  if (!report.items.every(isObservationInboxItem)) return null;
  if (report.meta.itemCount !== report.items.length) return null;
  const items = (report.items as ObservationInboxItem[]).map((item) => ({
    ...item,
    timestampedOccurrences: timestampedOccurrencesOf(item),
  }));
  const experience = report.experience === undefined
    ? undefined
    : normalizeObservationExperienceReport(report.experience);
  if (report.experience !== undefined && !experience) return null;
  const diagnostics = report.diagnostics === undefined
    ? undefined
    : parseDiagnosisBundle(report.diagnostics);
  if (report.diagnostics !== undefined && !diagnostics) return null;
  if (
    !observationInboxReferencesAreConsistent(
      report.meta as ObservationInboxReport['meta'],
      items,
      experience ?? undefined,
    )
  ) return null;
  return {
    kind: 'observe-inbox',
    schemaVersion: OBSERVATION_INBOX_SCHEMA_VERSION,
    meta: report.meta as ObservationInboxReport['meta'],
    items,
    ...(experience ? { experience } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function observationInboxReferencesAreConsistent(
  meta: ObservationInboxReport['meta'],
  items: ObservationInboxItem[],
  experience?: ObservationExperienceReport,
): boolean {
  const archiveRefs = meta.sourceRecordArchives ?? [];
  const experienceSessionIds = new Set(experience?.sessions.map((session) => session.id) ?? []);
  if (
    new Set(archiveRefs.map((ref) => ref.experienceSessionId)).size !== archiveRefs.length
    || archiveRefs.some((ref) => !experienceSessionIds.has(ref.experienceSessionId))
  ) return false;
  const itemIds = new Set(items.map((item) => item.id));
  if (itemIds.size !== items.length) return false;
  if (
    items.some((item) =>
      new Set(item.recentSessionIds).size !== item.recentSessionIds.length
      || (
        item.recentTraceIds !== undefined
        && new Set(item.recentTraceIds).size !== item.recentTraceIds.length
      )
      || item.occurrences < item.recentSessionIds.length
      || item.occurrences < (item.recentTraceIds?.length ?? 0)
      || timestampedOccurrencesOf(item) > item.occurrences
      || (
        item.traceId !== undefined
        && (
          item.evidence.traceId !== item.traceId
          || !item.recentTraceIds?.includes(item.traceId)
        )
      )
      || (
        item.evidence.sourceTrace !== undefined
        && item.evidence.sourceTrace !== item.sourceTrace
      )
      || (
        item.evidence.sessionId !== undefined
        && item.evidence.sessionId !== item.sessionId
      )
      || (
        item.evidence.sourceKind !== undefined
        && item.evidence.sourceKind !== item.sourceKind
      )
      || item.representativeEvidence.length === 0
      || observationEvidenceIdentity(item.representativeEvidence[0])
        !== observationEvidenceIdentity(item.evidence)
      || new Set(item.representativeEvidence.map(observationEvidenceIdentity)).size
        !== item.representativeEvidence.length
    )
  ) return false;
  if (
    meta.sessionCount !== undefined
    && meta.sessionTimeRanges !== undefined
    && meta.sessionCount !== meta.sessionTimeRanges.length
  ) return false;
  if (
    meta.sessionTimeRanges !== undefined
    && (
      new Set(meta.sessionTimeRanges.map((range) =>
        range.traceId ?? `${range.sourceTrace}\u0000${range.sessionId}`
      )).size
        !== meta.sessionTimeRanges.length
      || !overallSessionTimeRangeMatches(meta.sessionTimeRange, meta.sessionTimeRanges)
    )
  ) return false;
  if (!experience) return true;
  if (
    meta.generatedAt !== experience.generatedAt
    || meta.segmentCount !== experience.invocations.length
    ||
    experience.invocations.some((invocation) =>
      invocation.relatedObservationIds.some((id) => !itemIds.has(id))
    )
  ) return false;

  const invocationCounts = Object.fromEntries(
    experience.skills.map((skill) => [skill.skillName, skill.invocationCount]),
  );
  const sessionCounts = Object.fromEntries(
    experience.skills.map((skill) => [skill.skillName, skill.sessionCount]),
  );
  const lastSeen = Object.fromEntries(
    experience.skills
      .filter((skill) => (
        skill.timestampedInvocationCount
        ?? (skill.firstSeen === UNOBSERVED_TIMESTAMP ? 0 : skill.invocationCount)
      ) > 0)
      .map((skill) => [skill.skillName, skill.lastSeen]),
  );
  const toolCounts = Object.fromEntries(
    experience.skills.map((skill) => [skill.skillName, skill.toolCounts]),
  );
  return (
    meta.skillInvocationCounts === undefined
    || inboxRecordsEqual(meta.skillInvocationCounts, invocationCounts)
  ) && (
    meta.skillSessionCounts === undefined
    || inboxRecordsEqual(meta.skillSessionCounts, sessionCounts)
  ) && (
    meta.skillInvocationLastSeen === undefined
    || inboxRecordsEqual(meta.skillInvocationLastSeen, lastSeen)
  ) && (
    meta.skillToolCallCounts === undefined
    || (
      inboxRecordKeysEqual(meta.skillToolCallCounts, toolCounts)
      && Object.keys(toolCounts).every((skillName) =>
        inboxRecordsEqual(
          meta.skillToolCallCounts?.[skillName] ?? {},
          toolCounts[skillName],
        )
      )
    )
  );
}

function overallSessionTimeRangeMatches(
  actual: ObservationInboxReport['meta']['sessionTimeRange'],
  ranges: ObservationSessionTimeRange[],
): boolean {
  if (!actual) return true;
  const expected = buildOverallSessionTimeRange(ranges);
  if (!expected) return false;
  return actual.from === expected.from
    && actual.to === expected.to
    && actual.durationMs === expected.durationMs;
}

function inboxRecordsEqual<T extends string | number>(
  left: Record<string, T>,
  right: Record<string, T>,
): boolean {
  return inboxRecordKeysEqual(left, right)
    && Object.keys(left).every((key) => left[key] === right[key]);
}

function inboxRecordKeysEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]);
}

function isObservationInboxMeta(value: unknown): value is ObservationInboxReport['meta'] {
  if (
    !isInboxRecord(value)
    || typeof value.tracePath !== 'string'
    || !isInboxTimestamp(value.generatedAt)
    || (value.sessionCount !== undefined && !isInboxCount(value.sessionCount))
    || !isInboxCount(value.segmentCount)
    || !isInboxCount(value.itemCount)
    || (
      value.ingestion !== undefined
      && parseTraceIngestionSummary(value.ingestion) === null
    )
    || (value.skillInvocationCounts !== undefined && !isInboxCountRecord(value.skillInvocationCounts))
    || (value.skillSessionCounts !== undefined && !isInboxCountRecord(value.skillSessionCounts))
    || (
      value.timestampedSegmentCount !== undefined
      && (
        !isInboxCount(value.timestampedSegmentCount)
        || value.timestampedSegmentCount > value.segmentCount
      )
    )
    || (
      value.timestampCoverage !== undefined
      && (
        !isInboxRate(value.timestampCoverage)
        || value.timestampedSegmentCount === undefined
        || !inboxRatesEqual(value.timestampCoverage, (
          value.segmentCount > 0
            ? (value.timestampedSegmentCount as number) / value.segmentCount
            : 0
        ))
      )
    )
    || (
      value.skillInvocationLastSeen !== undefined
      && !isInboxTimestampRecord(value.skillInvocationLastSeen)
    )
    || (
      value.skillToolCallCounts !== undefined
      && (
        !isInboxRecord(value.skillToolCallCounts)
        || !Object.values(value.skillToolCallCounts).every(isInboxCountRecord)
      )
    )
    || (
      value.sourceRecordArchives !== undefined
      && (
        !Array.isArray(value.sourceRecordArchives)
        || !value.sourceRecordArchives.every(isObservationSourceRecordArchiveRef)
      )
    )
  ) return false;
  if (
    value.sessionTimeRange !== undefined
    && (
      !isInboxRecord(value.sessionTimeRange)
      || !isInboxTimestampRangeOrEmpty(
        value.sessionTimeRange.from,
        value.sessionTimeRange.to,
      )
      || !isInboxDurationConsistent(
        value.sessionTimeRange.from,
        value.sessionTimeRange.to,
        value.sessionTimeRange.durationMs,
      )
    )
  ) return false;
  if (value.skillInvocationCounts !== undefined) {
    const invocationCounts = value.skillInvocationCounts as Record<string, number>;
    const invocationTotal = safeInboxCountSum(Object.values(invocationCounts));
    if (invocationTotal !== value.segmentCount) return false;
    if (
      value.skillSessionCounts !== undefined
      && Object.entries(value.skillSessionCounts as Record<string, number>).some(([skillName, count]) =>
        count > (invocationCounts[skillName] ?? 0)
      )
    ) return false;
    if (
      value.skillInvocationLastSeen !== undefined
      && Object.keys(value.skillInvocationLastSeen as Record<string, string>).some((skillName) =>
        !Object.hasOwn(invocationCounts, skillName)
      )
    ) return false;
    if (
      value.skillToolCallCounts !== undefined
      && Object.keys(value.skillToolCallCounts as Record<string, Record<string, number>>).some((skillName) =>
        !Object.hasOwn(invocationCounts, skillName)
      )
    ) return false;
  }
  return value.sessionTimeRanges === undefined
    || (
      Array.isArray(value.sessionTimeRanges)
      && value.sessionTimeRanges.every(isObservationSessionTimeRange)
    );
}

function isObservationSourceRecordArchiveRef(value: unknown): boolean {
  if (!isInboxRecord(value)
    || typeof value.experienceSessionId !== 'string'
    || !['available', 'partial', 'unavailable'].includes(String(value.status))
    || (value.relativePath !== undefined && typeof value.relativePath !== 'string')
    || !isInboxCount(value.recordCount)
    || !isInboxCount(value.omittedRecordCount)
    || !isInboxCount(value.byteCount)
    || typeof value.truncated !== 'boolean') return false;
  if (value.status === 'unavailable' && value.relativePath !== undefined) return false;
  if (value.status !== 'unavailable' && typeof value.relativePath !== 'string') return false;
  return value.reason === undefined || [
    'no_record_ranges',
    'source_missing',
    'unsupported_source',
    'read_failed',
    'archive_limit',
  ].includes(String(value.reason));
}

function isObservationSessionTimeRange(value: unknown): boolean {
  return isInboxRecord(value)
    && typeof value.sessionId === 'string'
    && (value.traceId === undefined || typeof value.traceId === 'string')
    && (value.sessionGroupId === undefined || typeof value.sessionGroupId === 'string')
    && typeof value.sourceTrace === 'string'
    && isObservationSourceKind(value.sourceKind)
    && (
      value.traceRole === undefined
      || value.traceRole === 'standalone'
      || value.traceRole === 'main'
      || value.traceRole === 'subagent'
    )
    && (value.traceLabel === undefined || typeof value.traceLabel === 'string')
    && (value.cwd === undefined || typeof value.cwd === 'string')
    && isInboxOptionalTimestamp(value.startTimestamp)
    && isInboxOptionalTimestamp(value.endTimestamp)
    && isInboxDurationConsistent(
      value.startTimestamp,
      value.endTimestamp,
      value.durationMs,
    );
}

function isObservationInboxItem(value: unknown): value is ObservationInboxItem {
  if (
    !isInboxRecord(value)
    || typeof value.id !== 'string'
    || typeof value.skillName !== 'string'
    || typeof value.artifactVersion !== 'string'
    || (value.artifactHash !== undefined && typeof value.artifactHash !== 'string')
    || (value.cwd !== undefined && typeof value.cwd !== 'string')
    || typeof value.sessionId !== 'string'
    || (value.traceId !== undefined && typeof value.traceId !== 'string')
    || typeof value.sourceTrace !== 'string'
    || (
      value.sourceKind !== undefined
      && !isObservationSourceKind(value.sourceKind)
    )
    || !isObservationSignalType(value.signalType)
    || !isObservationSignalSubtype(value.signalSubtype)
    || !isInboxRate(value.confidence)
    || !isInboxRate(value.attributionConfidence)
    || !isObservationSeverity(value.severity)
    || (
      value.severityReasonCode !== undefined
      && !isObservationSeverityReasonCode(value.severityReasonCode)
    )
    || (value.severityReason !== undefined && typeof value.severityReason !== 'string')
    || (
      value.captureCoverage !== undefined
      && !isObservationCaptureCoverage(value.captureCoverage)
    )
    || !isObservationEvidence(value.evidence)
    || !isInboxTimestampRange(value.firstSeen, value.lastSeen)
    || !isInboxCount(value.occurrences)
    || value.occurrences === 0
    || (
      value.timestampedOccurrences !== undefined
      && (
        !isInboxCount(value.timestampedOccurrences)
        || value.timestampedOccurrences > value.occurrences
      )
    )
    || !isInboxStringArray(value.recentSessionIds)
    || (
      value.recentTraceIds !== undefined
      && !isInboxStringArray(value.recentTraceIds)
    )
    || !Array.isArray(value.representativeEvidence)
    || !value.representativeEvidence.every(isObservationEvidence)
  ) return false;
  const timestampedOccurrences = value.timestampedOccurrences === undefined
    ? (
        value.firstSeen === UNOBSERVED_TIMESTAMP && value.lastSeen === UNOBSERVED_TIMESTAMP
          ? 0
          : value.occurrences
      )
    : value.timestampedOccurrences;
  if (
    timestampedOccurrences === 0
      ? value.firstSeen !== UNOBSERVED_TIMESTAMP || value.lastSeen !== UNOBSERVED_TIMESTAMP
      : value.firstSeen === UNOBSERVED_TIMESTAMP || value.lastSeen === UNOBSERVED_TIMESTAMP
  ) return false;
  return value.messageWindow === undefined || isObservationMessageWindow(value.messageWindow);
}

function isObservationEvidence(value: unknown): boolean {
  if (!isInboxRecord(value)) return false;
  const strings = [
    value.traceId,
    value.sessionId,
    value.sourceTrace,
    value.tool,
    value.query,
    value.path,
    value.outputSnippet,
    value.assistantSnippet,
    value.userFeedbackSnippet,
    value.submittedEvidenceSnippet,
    value.markerToken,
    value.messageUuid,
    value.callInstanceId,
    value.toolUseId,
    value.segmentTimestamp,
  ];
  return strings.slice(0, -1).every((field) => field === undefined || typeof field === 'string')
    && (value.sourceKind === undefined || isObservationSourceKind(value.sourceKind))
    && isInboxOptionalTimestamp(value.segmentTimestamp)
    && (
      value.messageIndex === undefined
      || isInboxCount(value.messageIndex)
    );
}

function isObservationMessageWindow(value: unknown): boolean {
  return isInboxRecord(value)
    && Array.isArray(value.before)
    && value.before.every(isObservationMessageRef)
    && Array.isArray(value.event)
    && value.event.every(isObservationMessageRef)
    && Array.isArray(value.after)
    && value.after.every(isObservationMessageRef)
    && (
      value.resolutionAfter === 'resolved'
      || value.resolutionAfter === 'unresolved'
      || value.resolutionAfter === 'unknown'
    );
}

function isObservationMessageRef(value: unknown): boolean {
  return isInboxRecord(value)
    && (
      value.role === 'user'
      || value.role === 'assistant'
      || value.role === 'other'
    )
    && typeof value.snippet === 'string'
    && isInboxCount(value.messageIndex)
    && (value.uuid === undefined || typeof value.uuid === 'string')
    && isInboxOptionalTimestamp(value.timestamp);
}

function isObservationSignalType(value: unknown): value is ObservationSignalType {
  return value === 'failed_search'
    || value === 'repeated_failure'
    || value === 'hedging'
    || value === 'explicit_marker'
    || value === 'user_feedback';
}

function isObservationSignalSubtype(value: unknown): value is ObservationSignalSubtype {
  return value === 'hard_miss'
    || value === 'repeated_failure'
    || value === 'exploratory_miss'
    || value === 'tool_error'
    || value === 'permission_error'
    || value === 'bash_probe'
    || value === 'not_found'
    || value === 'transient_file_missing'
    || value === 'skill_asset_read_failed'
    || value === 'permission_denied'
    || value === 'tool_limit'
    || value === 'tool_failure'
    || value === 'regex_only'
    || value === 'llm_classified'
    || value === 'marker'
    || value === 'explicit_user_feedback';
}

function isObservationSeverity(value: unknown): boolean {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'noise';
}

function isObservationSeverityReasonCode(value: unknown): boolean {
  return value === 'knowledge_gap_suspected'
    || value === 'repeated_failure_suspected'
    || value === 'explicit_gap_marker'
    || value === 'exploratory_probe'
    || value === 'skill_asset_unavailable'
    || value === 'soft_hedging_signal'
    || value === 'user_reported_knowledge_issue'
    || value === 'tool_or_runtime_noise';
}

function isInboxRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInboxCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isInboxRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function inboxRatesEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6;
}

function safeInboxCountSum(values: number[]): number | undefined {
  try {
    return sumRecordCounts(...values);
  } catch {
    return undefined;
  }
}

function isInboxTimestamp(value: unknown): value is string {
  return typeof value === 'string' && normalizeTraceTimestamp(value) !== undefined;
}

function isInboxOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isInboxTimestamp(value);
}

function isInboxTimestampRange(start: unknown, end: unknown): boolean {
  return isInboxTimestamp(start)
    && isInboxTimestamp(end)
    && Date.parse(start) <= Date.parse(end);
}

function isInboxTimestampRangeOrEmpty(start: unknown, end: unknown): boolean {
  return start === '' && end === '' || isInboxTimestampRange(start, end);
}

function isInboxDurationConsistent(start: unknown, end: unknown, duration: unknown): boolean {
  if (duration !== undefined && !isInboxCount(duration)) return false;
  if (start === undefined || end === undefined || start === '' || end === '') {
    return duration === undefined;
  }
  return typeof start === 'string'
    && typeof end === 'string'
    && isInboxTimestampRange(start, end)
    && duration === durationMsBetween(start, end);
}

function isInboxStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isInboxCountRecord(value: unknown): boolean {
  return isInboxRecord(value) && Object.values(value).every(isInboxCount);
}

function isInboxTimestampRecord(value: unknown): boolean {
  return isInboxRecord(value) && Object.values(value).every(isInboxTimestamp);
}

export function loadLatestObservationInboxReport(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxReport | null {
  const reports = loadObservationInboxReports(dir);
  if (reports.length === 0) return null;
  return reports.sort((a, b) => b.meta.generatedAt.localeCompare(a.meta.generatedAt))[0] ?? null;
}

export function loadLatestObservationInboxReports(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxReport[] {
  const latest = loadLatestObservationInboxReport(dir);
  return latest ? [latest] : [];
}

export function queryObservationInbox(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxItem[] {
  const reports = loadLatestObservationInboxReports(dir);
  return aggregateInboxItems([
    ...reports.flatMap((report) => report.items),
    ...loadExplicitObservationCaptureItems(dir),
  ]);
}

export function summarizeObservationInboxBySkill(
  items: ObservationInboxItem[],
  reports: ObservationInboxReport[] = [],
): ObservationSkillRollup[] {
  const invocationCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillInvocationCounts ?? {})) {
      incrementRecordCount(acc, skill, count);
    }
    return acc;
  }, {} as Record<string, number>);
  const sessionCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillSessionCounts ?? {})) {
      incrementRecordCount(acc, skill, count);
    }
    return acc;
  }, {} as Record<string, number>);
  const bySkill = new Map<string, ObservationInboxItem[]>();
  for (const item of items) {
    const group = bySkill.get(item.skillName) ?? [];
    group.push(item);
    bySkill.set(item.skillName, group);
  }
  const skillNames = new Set([...Object.keys(invocationCounts), ...bySkill.keys()]);
  return Array.from(skillNames).map((skillName) => {
    const group = bySkill.get(skillName) ?? [];
    return {
      skillName,
      invocationCount: invocationCounts[skillName]
        ?? sumRecordCounts(...group.map((item) => item.occurrences)),
      sessionCount: sessionCounts[skillName] ?? new Set(group.flatMap((item) => item.recentSessionIds)).size,
      observationCount: group.length,
      highCount: group.filter((item) => item.severity === 'high').length,
      mediumCount: group.filter((item) => item.severity === 'medium').length,
      lowCount: group.filter((item) => item.severity === 'low').length,
      noiseCount: group.filter((item) => item.severity === 'noise').length,
      latestSeen: group
        .filter((item) => timestampedOccurrencesOf(item) > 0)
        .reduce((latest, item) => item.lastSeen > latest ? item.lastSeen : latest, ''),
    };
  }).sort((a, b) => {
    const riskA = a.highCount * 100 + a.mediumCount * 10 + a.lowCount;
    const riskB = b.highCount * 100 + b.mediumCount * 10 + b.lowCount;
    if (riskB !== riskA) return riskB - riskA;
    return b.invocationCount - a.invocationCount;
  });
}

export function findObservationInboxItem(id: string, dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxItem | null {
  const reports = loadObservationInboxReports(dir);
  for (const item of [...reports].reverse().flatMap((report) => report.items)) {
    if (item.id === id) return item;
  }
  return aggregateInboxItems([
    ...reports.flatMap((report) => report.items),
    ...loadExplicitObservationCaptureItems(dir),
  ]).find((item) => item.id === id) ?? null;
}

export function buildObservationMessageWindow(
  item: Pick<ObservationInboxItem, 'sourceTrace' | 'signalType' | 'evidence'>,
  radius = 3,
  preloadedMessages?: ObservationMessageRef[],
): ObservationMessageWindow | undefined {
  if (!item.sourceTrace.endsWith('.jsonl')) return undefined;
  const index = item.evidence.messageIndex;
  if (
    typeof index !== 'number'
    || index < 0
    || (preloadedMessages === undefined && !existsSync(item.sourceTrace))
  ) return undefined;
  const messages = preloadedMessages ?? readJsonlMessageRefs(item.sourceTrace);
  if (messages.length === 0) return undefined;
  const position = messages.findIndex((message) => {
    if (message.messageIndex !== index) return false;
    if (item.evidence.toolUseId) return message.snippet.includes(item.evidence.toolUseId);
    if (item.evidence.messageUuid) return message.uuid === item.evidence.messageUuid;
    return true;
  });
  if (position < 0) return undefined;
  const before = messages.slice(Math.max(0, position - radius), position);
  const event = messages.slice(position, position + 1);
  let after = messages.slice(position + 1, Math.min(messages.length, position + radius + 1));
  if (item.evidence.toolUseId) {
    const result = messages.find((message, messagePosition) =>
      messagePosition !== position
      && message.messageIndex >= index
      && message.snippet.includes(item.evidence.toolUseId!),
    );
    if (result && !event.includes(result)) {
      event.push(result);
      after = after.filter((message) => message !== result);
    }
  }
  return {
    before,
    event,
    after,
    resolutionAfter: inferResolutionAfter(messages.slice(position + 1), item.signalType),
  };
}

export function formatObservationShow(item: ObservationInboxItem): string {
  const window = item.messageWindow ?? buildObservationMessageWindow(item);
  const lines = [
    `Observation ${item.id}`,
    `skill=${item.skillName} severity=${item.severity} signal=${item.signalType}/${item.signalSubtype} confidence=${item.confidence.toFixed(2)} attribution=${item.attributionConfidence.toFixed(2)}`,
    `source=${item.sourceTrace}`,
    item.severityReasonCode ? `reason=${item.severityReasonCode}` : '',
    '',
  ].filter(Boolean);
  if (item.captureCoverage) {
    lines.push(
      `coverage=${item.captureCoverage.coverageStatus} capture=${item.captureCoverage.capturePath}`,
      `observed=${item.captureCoverage.observedEventKinds.join(',')}`,
      `unavailable=${item.captureCoverage.unavailableEventKinds.join(',')}`,
    );
  }
  if (item.evidence.userFeedbackSnippet) {
    lines.push(`userFeedback=${item.evidence.userFeedbackSnippet}`);
  }
  if (item.evidence.submittedEvidenceSnippet) {
    lines.push(`submittedEvidence=${item.evidence.submittedEvidenceSnippet}`);
  }
  if (!window) {
    lines.push('No message window available for this observation.');
    return lines.join('\n');
  }
  lines.push('--- 上文 ---');
  lines.push(...formatMessageRefs(window.before));
  lines.push('--- 失败点 / 触发点 ---');
  lines.push(...formatMessageRefs(window.event));
  lines.push('--- 下文 ---');
  lines.push(...formatMessageRefs(window.after));
  lines.push(`resolutionAfter=${window.resolutionAfter}`);
  return lines.join('\n');
}

function readJsonlMessageRefs(path: string): ObservationMessageRef[] {
  let events: TraceEvent[];
  try {
    events = loadTraceSessions(path)[0]?.events ?? [];
  } catch {
    return [];
  }
  return messageRefsFromEvents(events);
}

function messageRefsFromEvents(events: TraceEvent[]): ObservationMessageRef[] {
  return events.flatMap((event): ObservationMessageRef[] => {
    const common = {
      messageIndex: event.sourceIndex,
      uuid: event.sourceEventId ?? event.eventId,
      timestamp: event.timestamp,
    };
    if (event.eventKind === 'message') {
      const text = snippet(event.text, 500);
      const role = event.role === 'assistant'
        ? 'assistant'
        : event.role === 'user' ? 'user' : 'other';
      return text ? [{ ...common, role, snippet: text }] : [];
    }
    if (event.eventKind === 'tool_call') {
      const text = snippet(`tool_use ${event.tool.displayName ?? event.tool.name} ${event.callId} ${JSON.stringify(event.input)}`, 500);
      return text ? [{ ...common, role: 'assistant', snippet: text }] : [];
    }
    if (event.eventKind === 'tool_result') {
      const text = snippet(`tool_result ${event.callId} ${event.output}`, 500);
      return text ? [{ ...common, role: 'other', snippet: text }] : [];
    }
    return [];
  });
}

function inferResolutionAfter(messages: ObservationMessageRef[], signalType: ObservationSignalType): ObservationMessageWindow['resolutionAfter'] {
  if (signalType !== 'failed_search' && signalType !== 'repeated_failure') return 'unknown';
  const later = messages.map((message) => message.snippet).join('\n');
  if (/No matches found|does not exist|not found|permission denied|exceeds maximum allowed tokens/i.test(later) && !/tool_result [^\s]+ (?!No matches found)/i.test(later)) {
    return 'unresolved';
  }
  if (/tool_result [^\s]+ (?!No matches found).{10,}/i.test(later)) return 'resolved';
  return 'unknown';
}

function formatMessageRefs(messages: ObservationMessageRef[]): string[] {
  if (messages.length === 0) return ['(none)'];
  return messages.map((message) => `[${message.messageIndex}] ${message.role}${message.timestamp ? ` ${message.timestamp}` : ''}${message.uuid ? ` ${message.uuid}` : ''}\n${message.snippet}`);
}

export function selectExploreInboxItems(
  items: ObservationInboxItem[],
  limit: number,
  includeNoise = false,
  random: () => number = Math.random,
): ObservationInboxItem[] {
  const candidates = items
    .filter((item) => item.severity === 'medium' || item.severity === 'low' || (includeNoise && item.severity === 'noise'))
    .sort((a, b) =>
      Number(timestampedOccurrencesOf(b) > 0) - Number(timestampedOccurrencesOf(a) > 0)
      || b.lastSeen.localeCompare(a.lastSeen)
    )
    .slice(0, 50);
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, limit);
}
