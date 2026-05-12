import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GapSignalRef, ToolCallInfo } from '../types/index.js';
import { extractGapSignalsFromTrace } from '../analysis/gap-analyzer.js';
import { ccTracesToResultEntries, type SkillSegment } from './trace-adapter.js';
import { isSearchToolCall, toolCallQuery } from '../shared/tool-search.js';
import { buildObservationExperienceReport, type ObservationExperienceReport } from './experience.js';
import type { ObservationReviewState } from './review-state.js';

export const DEFAULT_PROJECT_OBSERVATIONS_DIR = join(process.cwd(), '.omk', 'observations');
export const DEFAULT_GLOBAL_OBSERVATIONS_DIR = join(homedir(), '.oh-my-knowledge', 'observations');
export const DEFAULT_OBSERVATIONS_DIR = DEFAULT_PROJECT_OBSERVATIONS_DIR;

export type ObservationSignalType = 'failed_search' | 'repeated_failure' | 'hedging' | 'explicit_marker';
export type ObservationSourceKind = 'claude' | 'markdown_log' | 'unknown';
export type ObservationSeverityReasonCode =
  | 'knowledge_gap_suspected'
  | 'repeated_failure_suspected'
  | 'explicit_gap_marker'
  | 'exploratory_probe'
  | 'skill_asset_unavailable'
  | 'soft_hedging_signal'
  | 'tool_or_runtime_noise';
export type ObservationSignalSubtype =
  | 'hard_miss'
  | 'repeated_failure'
  | 'exploratory_miss'
  | 'tool_error'
  | 'permission_error'
  | 'bash_probe'
  | 'not_found'
  | 'transient_file_missing'
  | 'skill_asset_read_failed'
  | 'permission_denied'
  | 'tool_limit'
  | 'tool_failure'
  | 'regex_only'
  | 'llm_classified'
  | 'marker';

export interface ObservationEvidence {
  tool?: string;
  query?: string;
  path?: string;
  outputSnippet?: string;
  assistantSnippet?: string;
  markerToken?: string;
  messageIndex?: number;
  messageUuid?: string;
  toolUseId?: string;
  segmentTimestamp?: string;
}

export interface ObservationMessageRef {
  role: 'user' | 'assistant' | 'other';
  snippet: string;
  messageIndex: number;
  uuid?: string;
  timestamp?: string;
}

export interface ObservationMessageWindow {
  before: ObservationMessageRef[];
  event: ObservationMessageRef[];
  after: ObservationMessageRef[];
  resolutionAfter: 'resolved' | 'unresolved' | 'unknown';
}

export interface ObservationInboxItem {
  id: string;
  skillName: string;
  artifactVersion: string | 'unknown';
  artifactHash?: string;
  cwd?: string;
  sessionId: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  signalType: ObservationSignalType;
  signalSubtype: ObservationSignalSubtype;
  confidence: number;
  attributionConfidence: number;
  severity: 'high' | 'medium' | 'low' | 'noise';
  severityReasonCode?: ObservationSeverityReasonCode;
  severityReason?: string;
  evidence: ObservationEvidence;
  messageWindow?: ObservationMessageWindow;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  recentSessionIds: string[];
  representativeEvidence: ObservationEvidence[];
}

export interface ObservationInboxReport {
  kind: 'observe-inbox';
  schemaVersion: 1;
  meta: {
    tracePath: string;
    generatedAt: string;
    segmentCount: number;
    itemCount: number;
    skillInvocationCounts?: Record<string, number>;
    skillSessionCounts?: Record<string, number>;
    skillInvocationLastSeen?: Record<string, string>;
    skillToolCallCounts?: Record<string, Record<string, number>>;
  };
  items: ObservationInboxItem[];
  experience?: ObservationExperienceReport;
}

export interface ObservationSkillRollup {
  skillName: string;
  invocationCount: number;
  sessionCount: number;
  observationCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  noiseCount: number;
  latestSeen: string;
}

export interface BuildObservationInboxReportOptions {
  reviewState?: ObservationReviewState;
}

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function normalizeObservationKeyInput(value: string): string {
  const trimmed = value.trim();
  const protocolMatch = trimmed.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  const prefix = protocolMatch?.[1] ?? '';
  const body = protocolMatch?.[2] ?? trimmed;
  return (prefix + body
    .toLowerCase()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/:\d+(:\d+)?\b/g, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, ''));
}

export function inferObservationSourceKind(sourceTrace: string): ObservationSourceKind {
  if (sourceTrace.endsWith('.jsonl')) return 'claude';
  if (sourceTrace.endsWith('.log')) return 'markdown_log';
  return 'unknown';
}

function keyFor(item: Pick<ObservationInboxItem, 'skillName' | 'cwd' | 'sourceKind' | 'signalType' | 'signalSubtype' | 'evidence'>): string {
  const raw = item.signalSubtype === 'bash_probe'
    ? 'bash_probe'
    : item.signalType === 'explicit_marker'
    ? item.evidence.markerToken || item.signalSubtype
    : item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || '';
  return [
    item.sourceKind,
    item.skillName,
    item.cwd ?? '',
    item.signalType,
    item.signalSubtype,
    normalizeObservationKeyInput(raw),
  ].join('\u0000');
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
  if (!isSearchToolCall(tc) || tc.success === false) return false;
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
  if (tc.success === false) return 'tool_failure';
  const laterSuccess = allCalls.slice(index + 1).some((later) => isSuccessfulSearch(later) && isSameTopicSearch(tc, later));
  return laterSuccess ? 'exploratory_miss' : 'hard_miss';
}

function isTransientPath(value: string): boolean {
  return /(?:^|\s)(?:\/private)?\/tmp\/|(?:^|\s)\/var\/folders\/|figma_[\w.-]+\.(?:png|jpg|jpeg|webp)\b/i.test(value);
}

function isSkillAssetPath(value: string, skillName: string): boolean {
  if (!value || !skillName) return false;
  return value.includes(`/.claude/skills/${skillName}/`) || value.includes(`.claude/skills/${skillName}/`);
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
  if (signalType === 'repeated_failure' || signalType === 'explicit_marker') return 'high';
  if (subtype === 'hard_miss') return 'high';
  if (signalType === 'hedging' && confidence >= 0.7) return 'high';
  if (subtype === 'exploratory_miss' || subtype === 'bash_probe') return 'medium';
  if (subtype === 'skill_asset_read_failed') return 'medium';
  if (subtype === 'tool_error' || subtype === 'permission_error' || subtype === 'not_found' || subtype === 'transient_file_missing' || subtype === 'permission_denied' || subtype === 'tool_limit' || subtype === 'tool_failure' || subtype === 'regex_only') return 'noise';
  return 'low';
}

const SEVERITY_REASON_ZH: Record<ObservationSeverityReasonCode, string> = {
  repeated_failure_suspected: '同类搜索连续失败 3 次以上，是强缺口信号，高于单次 hard_miss。',
  explicit_gap_marker: 'agent 主动输出了知识缺口/未知标记，需要优先人工确认。',
  knowledge_gap_suspected: '{tool}失败后，session 内未找到同主题成功证据，疑似知识缺口。',
  exploratory_probe: 'skill 运行过程中出现了试路径、试目录或前序失败后后续成功的行为；先抽样确认，不直接判为要改 skill。',
  skill_asset_unavailable: '读取该 skill 自身资源失败，可能是路径错位、资源未提交或 ignore 配置问题。',
  soft_hedging_signal: '模型文本里出现了不确定表达，属于低置信文本信号，需要结合上下文人工判断。',
  tool_or_runtime_noise: '更像路径、权限、文件太大、临时文件或工具运行问题；通常不作为 skill 内容缺失。',
};

const SEVERITY_REASON_EN: Record<ObservationSeverityReasonCode, string> = {
  repeated_failure_suspected: 'Similar searches failed at least three times; this is stronger than a single hard miss.',
  explicit_gap_marker: 'The agent explicitly marked an unknown or knowledge gap; review this first.',
  knowledge_gap_suspected: '{tool}failed and no later same-topic success was found in the session.',
  exploratory_probe: 'The event looks like path probing, directory probing, or an earlier miss followed by later success; sample it before changing the skill.',
  skill_asset_unavailable: 'The agent failed to read an asset inside the skill itself; check path alignment, committed resources, or ignore rules.',
  soft_hedging_signal: 'The agent used uncertain wording; treat this as a low-confidence text signal.',
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

  const sampleId = `${segment.sessionId}:${segment.segmentIndex}`;
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
      id: hashString([segment.sessionId, segment.sourceTrace ?? '', segment.segmentIndex, signal.type, subtype, JSON.stringify(evidence)].join('\u0000')),
      skillName: segment.skillName,
      artifactVersion: 'unknown',
      cwd: segment.cwd,
      sessionId: segment.sessionId,
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
      recentSessionIds: [segment.sessionId],
      representativeEvidence: [evidence],
    };
    items.push(item);
  }

  return items;
}

export function buildObservationInboxReport(tracePath: string, options: BuildObservationInboxReportOptions = {}): ObservationInboxReport {
  const { sessions, segments } = ccTracesToResultEntries(tracePath);
  const generatedAt = new Date().toISOString();
  const skillInvocationCounts: Record<string, number> = {};
  const skillInvocationLastSeen: Record<string, string> = {};
  const skillToolCallCounts: Record<string, Record<string, number>> = {};
  const sessionsBySkill = new Map<string, Set<string>>();
  for (const segment of segments) {
    if (segment.skillName === 'general') continue;
    skillInvocationCounts[segment.skillName] = (skillInvocationCounts[segment.skillName] ?? 0) + 1;
    if (!skillInvocationLastSeen[segment.skillName] || segment.endTimestamp > skillInvocationLastSeen[segment.skillName]) {
      skillInvocationLastSeen[segment.skillName] = segment.endTimestamp;
    }
    const toolCounts = skillToolCallCounts[segment.skillName] ?? {};
    for (const toolCall of segment.toolCalls) {
      toolCounts[toolCall.tool] = (toolCounts[toolCall.tool] ?? 0) + 1;
    }
    skillToolCallCounts[segment.skillName] = toolCounts;
    const set = sessionsBySkill.get(segment.skillName) ?? new Set<string>();
    set.add(segment.sessionId);
    sessionsBySkill.set(segment.skillName, set);
  }
  const skillSessionCounts = Object.fromEntries(
    Array.from(sessionsBySkill.entries()).map(([skill, sessionIds]) => [skill, sessionIds.size]),
  );
  const aggregationState = createInboxAggregationState();
  for (const segment of segments) {
    const sourceTrace = segment.sourceTrace ?? tracePath;
    const segmentItems = itemsFromSegment(segment).map((item) => {
      const withSource = {
        ...item,
        sourceTrace,
        sourceKind: inferObservationSourceKind(sourceTrace),
      };
      return {
        ...withSource,
        messageWindow: buildObservationMessageWindow(withSource),
      };
    });
    addInboxItemsToState(aggregationState, segmentItems);
  }
  const items = finishInboxAggregation(aggregationState);
  const experience = buildObservationExperienceReport({ sessions, segments, items, generatedAt, reviewState: options.reviewState });
  return {
    kind: 'observe-inbox',
    schemaVersion: 1,
    meta: {
      tracePath,
      generatedAt,
      segmentCount: segments.length,
      itemCount: items.length,
      skillInvocationCounts,
      skillSessionCounts,
      skillInvocationLastSeen,
      skillToolCallCounts,
    },
    items,
    experience,
  };
}

interface InboxAggregationState {
  byKey: Map<string, ObservationInboxItem>;
  sessionLastSeenByKey: Map<string, Map<string, string>>;
}

function createInboxAggregationState(): InboxAggregationState {
  return {
    byKey: new Map<string, ObservationInboxItem>(),
    sessionLastSeenByKey: new Map<string, Map<string, string>>(),
  };
}

function addInboxItemsToState(state: InboxAggregationState, items: ObservationInboxItem[]): void {
  for (const item of items) {
    const key = keyFor(item);
    const sessionLastSeen = state.sessionLastSeenByKey.get(key) ?? new Map<string, string>();
    const previousSessionLastSeen = sessionLastSeen.get(item.sessionId);
    if (!previousSessionLastSeen || item.lastSeen > previousSessionLastSeen) {
      sessionLastSeen.set(item.sessionId, item.lastSeen);
    }
    state.sessionLastSeenByKey.set(key, sessionLastSeen);
    const existing = state.byKey.get(key);
    if (!existing) {
      state.byKey.set(key, { ...item, representativeEvidence: [item.evidence], recentSessionIds: [item.sessionId] });
      continue;
    }
    existing.occurrences += item.occurrences;
    if (item.firstSeen < existing.firstSeen) existing.firstSeen = item.firstSeen;
    if (item.lastSeen > existing.lastSeen) existing.lastSeen = item.lastSeen;
    existing.confidence = Math.max(existing.confidence, item.confidence);
    existing.attributionConfidence = Math.max(existing.attributionConfidence, item.attributionConfidence);
    if (
      severityRank(item.severity) > severityRank(existing.severity)
      || (item.severity === existing.severity && item.confidence > existing.confidence)
    ) {
      existing.severity = item.severity;
      existing.severityReasonCode = item.severityReasonCode;
      existing.evidence = item.evidence;
      existing.messageWindow = item.messageWindow;
    }
    existing.recentSessionIds = Array.from(sessionLastSeen.entries())
      .sort((a, b) => b[1].localeCompare(a[1]))
      .map(([sessionId]) => sessionId)
      .slice(0, 3);
    existing.representativeEvidence.push(item.evidence);
    existing.representativeEvidence = existing.representativeEvidence.slice(0, 50);
  }
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
  const lastSeen = b.lastSeen.localeCompare(a.lastSeen);
  if (lastSeen !== 0) return lastSeen;
  return b.occurrences - a.occurrences;
}

export function saveObservationInboxReport(report: ObservationInboxReport, outDir: string = DEFAULT_OBSERVATIONS_DIR): string {
  mkdirSync(outDir, { recursive: true });
  // 保留毫秒;同秒不同毫秒生成的两份 report 不应静默互相覆盖。
  // 例: '2026-05-07T12:00:00.999Z' → '2026-05-07T12-00-00-999'
  const stamp = report.meta.generatedAt.replace(/[:.]/g, '-').replace(/Z$/, '');
  const path = join(outDir, `${stamp}-observe-inbox.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

export function loadObservationInboxReports(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxReport[] {
  if (!existsSync(dir)) {
    if (dir === DEFAULT_PROJECT_OBSERVATIONS_DIR && existsSync(DEFAULT_GLOBAL_OBSERVATIONS_DIR)) {
      return loadObservationInboxReports(DEFAULT_GLOBAL_OBSERVATIONS_DIR);
    }
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith('-observe-inbox.json'))
    .map((file) => {
      try {
        const report = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as ObservationInboxReport;
        report.items = report.items.map((item) => {
          const sourceKind = (item as { sourceKind?: string }).sourceKind;
          return {
            ...item,
            sourceKind: sourceKind === 'openclaw'
              ? 'markdown_log'
              : (item.sourceKind ?? inferObservationSourceKind(item.sourceTrace)),
            severityReasonCode: item.severityReasonCode ?? severityReasonCodeFor(item),
            severityReason: undefined,
          };
        });
        return report;
      } catch {
        return null;
      }
    })
    .filter((r): r is ObservationInboxReport => r?.kind === 'observe-inbox');
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
  return aggregateInboxItems(reports.flatMap((report) => report.items));
}

export function summarizeObservationInboxBySkill(
  items: ObservationInboxItem[],
  reports: ObservationInboxReport[] = [],
): ObservationSkillRollup[] {
  const invocationCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillInvocationCounts ?? {})) {
      acc[skill] = (acc[skill] ?? 0) + count;
    }
    return acc;
  }, {} as Record<string, number>);
  const sessionCounts = reports.reduce((acc, report) => {
    for (const [skill, count] of Object.entries(report.meta.skillSessionCounts ?? {})) {
      acc[skill] = (acc[skill] ?? 0) + count;
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
      invocationCount: invocationCounts[skillName] ?? group.reduce((sum, item) => sum + item.occurrences, 0),
      sessionCount: sessionCounts[skillName] ?? new Set(group.flatMap((item) => item.recentSessionIds)).size,
      observationCount: group.length,
      highCount: group.filter((item) => item.severity === 'high').length,
      mediumCount: group.filter((item) => item.severity === 'medium').length,
      lowCount: group.filter((item) => item.severity === 'low').length,
      noiseCount: group.filter((item) => item.severity === 'noise').length,
      latestSeen: group.reduce((latest, item) => item.lastSeen > latest ? item.lastSeen : latest, ''),
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
  return aggregateInboxItems(reports.flatMap((report) => report.items)).find((item) => item.id === id) ?? null;
}

export function buildObservationMessageWindow(item: Pick<ObservationInboxItem, 'sourceTrace' | 'signalType' | 'evidence'>, radius = 3): ObservationMessageWindow | undefined {
  if (!item.sourceTrace.endsWith('.jsonl')) return undefined;
  const index = item.evidence.messageIndex;
  if (typeof index !== 'number' || index < 0 || !existsSync(item.sourceTrace)) return undefined;
  const messages = readJsonlMessageRefs(item.sourceTrace);
  if (messages.length === 0) return undefined;
  const position = messages.findIndex((message) => message.messageIndex === index);
  if (position < 0) return undefined;
  const before = messages.slice(Math.max(0, position - radius), position);
  const event = messages.slice(position, position + 1);
  let after = messages.slice(position + 1, Math.min(messages.length, position + radius + 1));
  if (item.evidence.toolUseId) {
    const result = messages.find((message) => message.messageIndex > index && message.snippet.includes(item.evidence.toolUseId!));
    if (result && !event.some((message) => message.messageIndex === result.messageIndex)) {
      event.push(result);
      after = after.filter((message) => message.messageIndex !== result.messageIndex);
    }
  }
  return {
    before,
    event,
    after,
    resolutionAfter: inferResolutionAfter(messages.slice(index + 1), item.signalType),
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
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((line, index): ObservationMessageRef | null => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;
        const type = String(record.type ?? 'other');
        if (type !== 'user' && type !== 'assistant') return null;
        const message = record.message as { role?: string; content?: unknown } | undefined;
        const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : type === 'assistant' ? 'assistant' : type === 'user' ? 'user' : 'other';
        return {
          role,
          snippet: snippet(extractRecordText(record), 500) ?? '',
          messageIndex: index,
          uuid: typeof record.uuid === 'string' ? record.uuid : undefined,
          timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
        };
      } catch {
        return null;
      }
    })
    .filter((message): message is ObservationMessageRef => message !== null && message.snippet !== '');
}

function extractRecordText(record: Record<string, unknown>): string {
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      const obj = part as Record<string, unknown>;
      if (obj.type === 'text') return String(obj.text ?? '');
      if (obj.type === 'tool_use') return `tool_use ${String(obj.name ?? '')} ${String(obj.id ?? '')} ${JSON.stringify(obj.input ?? {})}`;
      if (obj.type === 'tool_result') return `tool_result ${String(obj.tool_use_id ?? '')} ${String(obj.content ?? '')}`;
      if (obj.type === 'thinking') return '';
      return JSON.stringify(obj);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(record);
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
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, 50);
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, limit);
}
