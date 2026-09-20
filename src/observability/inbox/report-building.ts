/**
 * 观察收件箱报告的构建：从 trace 会话与工具调用推断来源、聚合条目并压成落盘报告。
 */
import { buildOverallSessionTimeRange } from './session-time-range.js';
import { severityReasonCodeFor } from './severity-reason.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ToolCallInfo } from '../../executors/contracts/trace.js';
import type {
  BuildObservationInboxReportOptions,
  ObservationEvidence,
  ObservationInboxItem,
  ObservationInboxReport,
  ObservationMessageRef,
  ObservationMessageWindow,
  ObservationSessionTimeRange,
  ObservationSignalSubtype,
  ObservationSignalType,
} from '../contracts/inbox.js';
import type { TraceSourceKind, TraceIngestionSummary } from '../contracts/trace.js';
import type { GapSignalRef } from '../analysis/contracts.js';
import { extractGapSignalsFromTrace } from '../analysis/gap-analyzer.js';
import {
  segmentTraceBySkill,
  tracesToAnalysisEntries,
  skillSegmentTimestampObserved,
  type TraceSession,
  type SkillSegment,
} from '../trace/index.js';
import { isSearchToolCall, toolCallQuery } from '../trace/tool-search.js';
import { isToolCallFailure, isToolCallSuccess } from '../../executors/tool-call-status.js';
import {
  incrementRecordCount,
  ownRecordValue,
  setOwnRecordValue,
  sumRecordCounts,
} from '../../shared/record-count.js';
import { durationMsBetween } from '../../shared/time.js';
import {
  buildObservationExperienceReport,
  compactObservationExperienceReport,
} from '../experience.js';
import { createTraceSessionIndex, traceSessionRefIdentity } from '../trace/session-index.js';
import { isInstalledSkillAssetPath } from '../trace/attribution.js';
import {
  normalizeObservationKeyInput,
  observationInboxItemKey,
} from './identity.js';

import type {
  PersistedObservationInboxReport,
} from './report-primitives.js';
import {
  OBSERVATION_INBOX_SCHEMA_VERSION,
  inferResolutionAfter,
  messageRefsFromEvents,
  observationEvidenceIdentity,
  readJsonlMessageRefs,
  snippet,
  timestampedOccurrencesOf,
} from './report-primitives.js';

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Legacy migration only. New reports take sourceKind from Trace IR. */
export function inferObservationSourceKind(sourceTrace: string): TraceSourceKind {
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

export { severityReasonFor, severityReasonCodeFor } from './severity-reason.js';

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
