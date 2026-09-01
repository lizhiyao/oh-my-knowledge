/** Skill segmentation and source-neutral analysis projection for loaded traces. */

import { createHash } from 'node:crypto';
import type { ToolCallInfo, TraceSourceMetadata, TurnInfo } from '../types/index.js';
import type { AnalysisEntry, AnalysisVariantResult } from '../analysis/contracts.js';
import { incrementRecordCount } from '../shared/record-count.js';
import {
  truncateToolCallsForPersistence,
  truncateTurnsForPersistence,
} from '../shared/trace-projection.js';
import { sumTokenCounts, tokenCount } from '../shared/token-usage.js';
import { legacyCcSessionToTraceSession, type CcSession } from './trace-source.js';
import type {
  TraceEvent,
  TraceMessageEvent,
  TraceSession,
  TraceSourceKind,
  TraceToolCallEvent,
} from './trace-ir.js';
import { normalizeTraceTimestamp } from './trace-ir.js';
import {
  extractAttributionSkillRefFromEvent,
  extractBusinessActionSkillRefFromEvent,
  extractCommandSkillRefFromEvent,
  extractSkillReadFileRefFromEvent,
  extractSkillScriptCommandRefFromEvent,
  extractSkillToolUseRefFromEvent,
  stripCommandEnvelopeText,
  type SkillRef,
} from './trace-attribution.js';

export interface SkillSegment {
  skillName: string;
  attribution?: {
    source: 'skill-tool' | 'command-name' | 'business-action' | 'read-skill-md' | 'skill-script' | 'general';
    confidence: number;
    rawSkillRef?: string;
    pluginName?: string;
    commandName?: string;
  };
  sessionId: string;
  traceSessionId?: string;
  traceId?: string;
  sourceTrace?: string;
  sourceKind?: TraceSourceKind;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  sourceMetadata?: TraceSourceMetadata;
  segmentIndex: number;
  startRecordIndex?: number;
  endRecordIndex?: number;
  startTimestamp: string;
  endTimestamp: string;
  /** False when timestamps are unavailable and the epoch value is only a deterministic placeholder. */
  timestampObserved?: boolean;
  cwd?: string;
  turns: TurnInfo[];
  toolCalls: ToolCallInfo[];
  metrics: {
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** True only after a valid source usage event was attributed to this segment. */
    tokenUsageObserved: boolean;
    numTurns: number;
    numToolCalls: number;
    numToolFailures: number;
    numToolCancelled?: number;
    numToolUnknown: number;
  };
}

export const UNOBSERVED_TRACE_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function skillSegmentTimestampObserved(segment: SkillSegment): boolean {
  return segment.timestampObserved
    ?? segment.startTimestamp !== UNOBSERVED_TRACE_TIMESTAMP;
}

// ---------- Segment by skill ----------

/**
 * 扫描 Trace IR events, 按 skill 信号把 tool calls 切成多段。
 * 一个 session 可能产生 1-N 个 SkillSegment。
 */
export function segmentTraceBySkill(session: TraceSession): SkillSegment[] {
  const segments: SkillSegment[] = [];
  const orderedEvents = session.events
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.sourceIndex - b.event.sourceIndex || a.order - b.order)
    .map(({ event }) => event);
  let currentSkill = 'general';
  let currentSkillSource: string | undefined;
  let currentSegment = createEmptySegment(session, currentSkill, 0, 0);
  let segmentIndex = 0;
  const lastSourceIndex = orderedEvents.reduce((max, event) => Math.max(max, event.sourceIndex), 0);

  const pendingToolUses = new Map<string, Array<{ toolCall: ToolCallInfo; segmentRef: SkillSegment }>>();
  const assistantTurnsBySourceIndex = new Map<number, TurnInfo>();
  const humanTurnsBySourceIndex = new Map<number, TurnInfo>();
  const invalidTokenUsage = new WeakSet<SkillSegment>();

  const markSegmentRecord = (segment: SkillSegment, recordIndex: number): void => {
    segment.endRecordIndex = Math.max(
      segment.endRecordIndex ?? segment.startRecordIndex ?? recordIndex,
      recordIndex,
    );
  };

  const flushCurrent = (endRecordIndex?: number): boolean => {
    if (currentSegment.turns.length > 0 || currentSegment.toolCalls.length > 0) {
      if (typeof endRecordIndex === 'number') {
        const start = currentSegment.startRecordIndex ?? 0;
        currentSegment.endRecordIndex = Math.max(start, Math.min(lastSourceIndex, endRecordIndex));
      }
      segments.push(currentSegment);
      return true;
    }
    return false;
  };

  const isCurrentSkillRef = (ref: SkillRef): boolean =>
    ref.skillName === currentSkill && (ref.pluginName ?? '') === (currentSkillSource ?? '');

  const startNewSegment = (ref: SkillRef, recordIndex: number, timestamp?: string, attribution?: SkillSegment['attribution']): void => {
    // 空段被新信号替换时,不推进 segmentIndex(保持整洁的 0-based 编号)
    const wasNonEmpty = flushCurrent(recordIndex - 1);
    if (wasNonEmpty) segmentIndex += 1;
    currentSegment = createEmptySegment(
      session,
      ref.skillName,
      segmentIndex,
      recordIndex,
      timestamp,
      attribution,
    );
    currentSkill = ref.skillName;
    currentSkillSource = ref.pluginName;
  };

  const eventGroups = groupEventsBySourceIndex(orderedEvents);
  for (const eventGroup of eventGroups) {
    const boundary = skillBoundaryForEventGroup(eventGroup, session, currentSegment);
    if (boundary && !isCurrentSkillRef(boundary.ref)) {
      startNewSegment(
        boundary.ref,
        eventGroup[0].sourceIndex,
        eventGroup.find((event) => event.timestamp)?.timestamp,
        boundary.attribution,
      );
    }

    for (const event of eventsInCorrelationOrder(eventGroup)) {
      const recordIndex = event.sourceIndex;
      updateSegmentTimestamp(currentSegment, event.timestamp);
      if (event.eventKind === 'message' && event.role === 'user') {
        if (event.origin === 'human') {
          const textContent = stripCommandEnvelopeText(event.text);
          if (textContent) {
            const existing = humanTurnsBySourceIndex.get(recordIndex);
            if (existing && currentSegment.turns.includes(existing)) {
              existing.content = existing.content
                ? `${existing.content}\n${textContent}`
                : textContent;
            } else {
              const turn: TurnInfo = { role: 'user', content: textContent };
              currentSegment.turns.push(turn);
              humanTurnsBySourceIndex.set(recordIndex, turn);
            }
          }
        }
        updateSegmentTimestamp(currentSegment, event.timestamp);
        markSegmentRecord(currentSegment, recordIndex);
        continue;
      }

      if (event.eventKind === 'message' && event.role === 'assistant') {
        updateSegmentSourceModel(currentSegment, session.sourceMetadata, event.model);
        if (event.text) {
          const existing = assistantTurnsBySourceIndex.get(recordIndex);
          if (existing && currentSegment.turns.includes(existing)) {
            existing.content = existing.content
              ? `${existing.content}\n${event.text}`
              : event.text;
          } else {
            const turn: TurnInfo = { role: 'assistant', content: event.text };
            currentSegment.turns.push(turn);
            assistantTurnsBySourceIndex.set(recordIndex, turn);
            currentSegment.metrics.numTurns += 1;
          }
        }
        updateSegmentTimestamp(currentSegment, event.timestamp);
        markSegmentRecord(currentSegment, recordIndex);
        continue;
      }

      if (event.eventKind === 'tool_call') {
        updateSegmentSourceModel(currentSegment, session.sourceMetadata, event.model);
        const toolCall: ToolCallInfo = {
          tool: event.tool.name,
          ...(event.tool.sourceName ? { sourceTool: event.tool.sourceName } : {}),
          ...(event.tool.namespace ? { toolNamespace: event.tool.namespace } : {}),
          ...(event.tool.provider ? { toolProvider: event.tool.provider } : {}),
          input: event.input,
          output: '',
          status: 'unknown',
          statusSource: 'unknown',
          success: false,
          messageIndex: recordIndex,
          messageUuid: event.sourceEventId ?? event.eventId,
          callInstanceId: event.callInstanceId ?? event.eventId,
          toolUseId: event.callId,
          timestamp: event.timestamp,
          sourceTrace: session.sourcePath,
          sourceKind: session.sourceKind,
          traceRole: session.role,
          traceLabel: session.label,
        };
        currentSegment.toolCalls.push(toolCall);
        currentSegment.metrics.numToolCalls += 1;
        const pending = pendingToolUses.get(event.callId) ?? [];
        pending.push({ toolCall, segmentRef: currentSegment });
        pendingToolUses.set(event.callId, pending);

        let turn = assistantTurnsBySourceIndex.get(recordIndex);
        if (!turn || !currentSegment.turns.includes(turn)) {
          turn = { role: 'assistant', content: '' };
          currentSegment.turns.push(turn);
          assistantTurnsBySourceIndex.set(recordIndex, turn);
          currentSegment.metrics.numTurns += 1;
        }
        turn.toolCalls = [...(turn.toolCalls ?? []), toolCall];
        updateSegmentTimestamp(currentSegment, event.timestamp);
        markSegmentRecord(currentSegment, recordIndex);
        continue;
      }

      if (event.eventKind === 'tool_result') {
        const queue = pendingToolUses.get(event.callId);
        const matchingIndex = event.callInstanceId
          ? queue?.findIndex((candidate) =>
              candidate.toolCall.callInstanceId === event.callInstanceId
            )
          : undefined;
        const pending = matchingIndex !== undefined && matchingIndex >= 0
          ? queue?.splice(matchingIndex, 1)[0]
          : event.callInstanceId
            ? undefined
            : queue?.shift();
        if (pending) {
          pending.toolCall.output = event.output;
          pending.toolCall.status = event.status;
          pending.toolCall.statusSource = event.statusSource;
          pending.toolCall.success = event.status === 'success';
          if (event.status === 'failure') pending.segmentRef.metrics.numToolFailures += 1;
          if (event.status === 'cancelled') {
            pending.segmentRef.metrics.numToolCancelled =
              (pending.segmentRef.metrics.numToolCancelled ?? 0) + 1;
          }
          if (event.status === 'unknown') pending.segmentRef.metrics.numToolUnknown += 1;
          updateSegmentTimestamp(pending.segmentRef, event.timestamp);
          if (pending.segmentRef === currentSegment) {
            markSegmentRecord(pending.segmentRef, recordIndex);
          } else {
            // The result completes the originating call, but its source record
            // belongs to the segment active after the explicit boundary.
            markSegmentRecord(currentSegment, recordIndex);
          }
          if (queue?.length === 0) pendingToolUses.delete(event.callId);
        } else {
          updateSegmentTimestamp(currentSegment, event.timestamp);
          markSegmentRecord(currentSegment, recordIndex);
        }
        continue;
      }

      if (event.eventKind === 'usage') {
        if (!invalidTokenUsage.has(currentSegment)) {
          const nextUsage = [
            safeTokenCountAddition(currentSegment.metrics.inputTokens, event.inputTokens),
            safeTokenCountAddition(currentSegment.metrics.outputTokens, event.outputTokens),
            safeTokenCountAddition(currentSegment.metrics.cacheReadTokens, event.cacheReadTokens),
            safeTokenCountAddition(currentSegment.metrics.cacheCreationTokens, event.cacheCreationTokens),
          ];
          if (
            nextUsage.some((value) => value === undefined)
            || safeTokenCountSum(nextUsage as number[]) === undefined
          ) {
            currentSegment.metrics.inputTokens = 0;
            currentSegment.metrics.outputTokens = 0;
            currentSegment.metrics.cacheReadTokens = 0;
            currentSegment.metrics.cacheCreationTokens = 0;
            currentSegment.metrics.tokenUsageObserved = false;
            invalidTokenUsage.add(currentSegment);
          } else {
            [
              currentSegment.metrics.inputTokens,
              currentSegment.metrics.outputTokens,
              currentSegment.metrics.cacheReadTokens,
              currentSegment.metrics.cacheCreationTokens,
            ] = nextUsage as number[];
            currentSegment.metrics.tokenUsageObserved = true;
          }
        }
        updateSegmentSourceModel(currentSegment, session.sourceMetadata, event.model);
        updateSegmentTimestamp(currentSegment, event.timestamp);
      }
      markSegmentRecord(currentSegment, recordIndex);
    }
  }

  for (const queue of pendingToolUses.values()) {
    for (const pending of queue) {
      pending.segmentRef.metrics.numToolUnknown += 1;
    }
  }
  flushCurrent(lastSourceIndex);
  return segments;
}

function eventsInCorrelationOrder(events: TraceEvent[]): TraceEvent[] {
  return events
    .map((event, order) => ({ event, order }))
    .sort((left, right) =>
      correlationRank(left.event) - correlationRank(right.event) || left.order - right.order
    )
    .map(({ event }) => event);
}

function correlationRank(event: TraceEvent): number {
  if (event.eventKind === 'tool_call') return 0;
  if (event.eventKind === 'tool_result') return 2;
  return 1;
}

interface SkillBoundary {
  ref: SkillRef;
  attribution: NonNullable<SkillSegment['attribution']>;
}

function groupEventsBySourceIndex(events: TraceEvent[]): TraceEvent[][] {
  const groups: TraceEvent[][] = [];
  for (const event of events) {
    const current = groups.at(-1);
    if (current?.[0]?.sourceIndex === event.sourceIndex) current.push(event);
    else groups.push([event]);
  }
  return groups;
}

function skillBoundaryForEventGroup(
  events: TraceEvent[],
  session: TraceSession,
  currentSegment: SkillSegment,
): SkillBoundary | null {
  const humanMessages = events.filter(
    (event): event is TraceMessageEvent =>
      event.eventKind === 'message' && event.role === 'user' && event.origin === 'human',
  );
  const assistantMessages = events.filter(
    (event): event is TraceMessageEvent =>
      event.eventKind === 'message' && event.role === 'assistant',
  );
  const toolCalls = events.filter(
    (event): event is TraceToolCallEvent => event.eventKind === 'tool_call',
  );

  for (const event of toolCalls) {
    const ref = extractSkillToolUseRefFromEvent(event);
    if (ref) {
      return {
        ref,
        attribution: {
          source: 'skill-tool',
          confidence: 0.95,
          rawSkillRef: ref.rawSkillRef,
          pluginName: ref.pluginName,
        },
      };
    }
  }
  for (const event of humanMessages) {
    const ref = extractCommandSkillRefFromEvent(event);
    if (ref) {
      return {
        ref,
        attribution: {
          source: 'command-name',
          confidence: 0.85,
          rawSkillRef: ref.rawSkillRef,
          pluginName: ref.pluginName,
          commandName: `/${ref.rawSkillRef}`,
        },
      };
    }
  }
  for (const event of humanMessages) {
    const ref = extractBusinessActionSkillRefFromEvent(event);
    if (ref) {
      return {
        ref,
        attribution: {
          source: 'business-action',
          confidence: 0.85,
          rawSkillRef: ref.rawSkillRef,
          pluginName: ref.pluginName,
          commandName: ref.rawSkillRef,
        },
      };
    }
  }
  for (const event of assistantMessages) {
    const ref = extractAttributionSkillRefFromEvent(event);
    if (ref) {
      return {
        ref,
        attribution: {
          source: 'command-name',
          confidence: 0.85,
          rawSkillRef: ref.rawSkillRef,
          pluginName: ref.pluginName,
          commandName: `/${ref.rawSkillRef}`,
        },
      };
    }
  }
  for (const event of [...humanMessages, ...assistantMessages, ...toolCalls]) {
    const ref = extractSkillScriptCommandRefFromEvent(event);
    if (ref) {
      return {
        ref,
        attribution: {
          source: 'skill-script',
          confidence: event.eventKind === 'message' && event.role === 'user' ? 0.75 : 0.7,
          rawSkillRef: ref.rawSkillRef,
          pluginName: ref.pluginName,
          commandName: ref.rawSkillRef,
        },
      };
    }
  }
  for (const event of toolCalls) {
    const ref = extractSkillReadFileRefFromEvent(event);
    if (ref && shouldCutOnReadSkill(currentSegment)) {
      return {
        ref,
        attribution: {
          source: 'read-skill-md',
          confidence: 0.5,
          rawSkillRef: ref.rawSkillRef,
          pluginName: ref.pluginName,
        },
      };
    }
  }
  return null;
}

/** @deprecated Compatibility entry point for Claude-shaped fixtures. */
export function segmentBySkill(session: TraceSession | CcSession): SkillSegment[] {
  return segmentTraceBySkill('events' in session ? session : legacyCcSessionToTraceSession(session));
}

function updateSegmentSourceModel(
  segment: SkillSegment,
  sessionMetadata: TraceSourceMetadata | undefined,
  model: string | undefined,
): void {
  if (!model) return;
  const baseMetadata = { ...sessionMetadata };
  delete baseMetadata.model;
  const models = new Set(
    segment.sourceMetadata?.model?.split(', ').filter(Boolean) ?? [],
  );
  models.add(model);
  segment.sourceMetadata = {
    ...baseMetadata,
    ...segment.sourceMetadata,
    model: Array.from(models).join(', '),
  };
}

function createEmptySegment(session: TraceSession, skillName: string, index: number, recordIndex: number, timestamp?: string, attribution?: SkillSegment['attribution']): SkillSegment {
  const observedTimestamp = normalizeTraceTimestamp(timestamp);
  const ts = observedTimestamp ?? UNOBSERVED_TRACE_TIMESTAMP;
  return {
    skillName,
    attribution: attribution ?? { source: 'general', confidence: 0.3 },
    sessionId: session.rootRunId,
    traceSessionId: session.runId,
    traceId: session.traceId,
    sourceTrace: session.sourcePath,
    sourceKind: session.sourceKind,
    traceRole: session.role,
    traceLabel: session.label,
    segmentIndex: index,
    startRecordIndex: recordIndex,
    endRecordIndex: recordIndex,
    startTimestamp: ts,
    endTimestamp: ts,
    timestampObserved: observedTimestamp !== undefined,
    cwd: session.cwd,
    turns: [],
    toolCalls: [],
    metrics: {
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokenUsageObserved: false,
      numTurns: 0,
      numToolCalls: 0,
      numToolFailures: 0,
      numToolCancelled: 0,
      numToolUnknown: 0,
    },
  };
}

function updateSegmentTimestamp(seg: SkillSegment, timestamp?: string): void {
  const normalized = normalizeTraceTimestamp(timestamp);
  if (!normalized) return;
  seg.timestampObserved = true;
  if (seg.startTimestamp === UNOBSERVED_TRACE_TIMESTAMP) {
    seg.startTimestamp = normalized;
    seg.endTimestamp = normalized;
  } else {
    if (normalized < seg.startTimestamp) seg.startTimestamp = normalized;
    if (!seg.endTimestamp || normalized > seg.endTimestamp) seg.endTimestamp = normalized;
  }
  // 重算 durationMs
  try {
    const start = new Date(seg.startTimestamp).getTime();
    const end = new Date(seg.endTimestamp).getTime();
    if (!Number.isNaN(start) && !Number.isNaN(end)) seg.metrics.durationMs = Math.max(0, end - start);
  } catch { /* skip */ }
}

function shouldCutOnReadSkill(currentSegment: SkillSegment): boolean {
  return currentSegment.skillName === 'general'
    || currentSegment.attribution?.source === 'read-skill-md';
}

function safeTokenCountAddition(current: number, value: unknown): number | undefined {
  const addition = tokenCount(value);
  return current <= Number.MAX_SAFE_INTEGER - addition ? current + addition : undefined;
}

function safeTokenCountSum(values: number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (total > Number.MAX_SAFE_INTEGER - value) return undefined;
    total += value;
  }
  return total;
}

// ---------- Segment → AnalysisEntry ----------

/**
 * SkillSegment[] → AnalysisEntry[]（omk 内部观测分析路径的标准输入）。
 *
 * 映射规则(详见 docs/skill-health-spec.md):
 *   - 每 segment 一个 AnalysisEntry
 *   - sample_id 锚定 traceId + skillName + startRecordIndex
 *   - variant key = skill 名(复用 omk 的 variant 维度作为 skill 分组维度)
 */
export function segmentsToAnalysisEntries(segments: SkillSegment[]): AnalysisEntry[] {
  return segments.map((seg): AnalysisEntry => ({
    sampleId: `trace:${createHash('sha256')
      .update([
        seg.traceId ?? seg.traceSessionId ?? seg.sessionId,
        seg.skillName,
        String(seg.startRecordIndex ?? 0),
      ].join('\u0000'))
      .digest('hex')
      .slice(0, 32)}`,
    variants: {
      [seg.skillName]: buildVariantResult(seg),
    },
  }));
}

function buildVariantResult(seg: SkillSegment): AnalysisVariantResult {
  const totalTokens = sumTokenCounts(
    seg.metrics.inputTokens,
    seg.metrics.outputTokens,
    seg.metrics.cacheReadTokens,
    seg.metrics.cacheCreationTokens,
  );
  const cancelledToolCalls = seg.metrics.numToolCancelled ?? 0;
  const comparableToolCalls = Math.max(
    0,
    seg.metrics.numToolCalls - seg.metrics.numToolUnknown - cancelledToolCalls,
  );
  const toolDistribution: Record<string, number> = {};
  for (const toolCall of seg.toolCalls) {
    incrementRecordCount(toolDistribution, toolCall.tool);
  }
  return {
    ok: true,
    durationMs: seg.metrics.durationMs,
    inputTokens: seg.metrics.inputTokens,
    outputTokens: seg.metrics.outputTokens,
    totalTokens,
    cacheReadTokens: seg.metrics.cacheReadTokens,
    cacheCreationTokens: seg.metrics.cacheCreationTokens,
    ...(!seg.metrics.tokenUsageObserved && { tokenUsageReportedByExecutor: false }),
    numTurns: seg.metrics.numTurns,
    numToolCalls: seg.metrics.numToolCalls,
    numToolFailures: seg.metrics.numToolFailures,
    numToolCancelled: cancelledToolCalls,
    numToolUnknown: seg.metrics.numToolUnknown,
    ...(comparableToolCalls > 0 && {
      toolSuccessRate: Number((
        (comparableToolCalls - seg.metrics.numToolFailures) / comparableToolCalls
      ).toFixed(2)),
    }),
    toolNames: Array.from(new Set(seg.toolCalls.map((tc) => tc.tool))),
    toolDistribution,
    turns: truncateTurnsForPersistence(seg.turns),
    toolCalls: truncateToolCallsForPersistence(seg.toolCalls),
  };
}
