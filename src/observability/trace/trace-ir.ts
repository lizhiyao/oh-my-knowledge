import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolCallStatus, ToolCallStatusSource } from '../../executors/contracts/trace.js';
import type { TraceIngestionSummary, TraceSourceKind, TraceSourceMetadata } from '../contracts/trace.js';
import { normalizeRfc3339Timestamp } from '../../shared/timestamp.js';
import type { NormalizedToolIdentity } from '../../executors/core/tool-identity.js';

export type { TraceSourceKind } from '../contracts/trace.js';
export type TraceRole = 'standalone' | 'main' | 'subagent';
export type TraceMessageRole = 'user' | 'assistant' | 'system';
export type TraceMessageOrigin = 'human' | 'runtime' | 'skill-context' | 'synthetic';
export type TraceToolStatus = ToolCallStatus;
export type TraceToolStatusSource = ToolCallStatusSource;
export type TraceModelActivityKind = 'reasoning';
export type TraceModelActivityVisibility = 'plaintext' | 'opaque';
export type TraceModelActivityContentSource = 'summary' | 'content' | 'text';
export type TraceRuntimeContextKind = 'session_context' | 'execution_context' | 'settings' | 'goal';
export type TraceAgentActivityKind = 'communication' | 'status' | 'lifecycle';
export type TraceObservedEffectKind = 'file_change';

/**
 * 未识别记录的原始证据在派生层保留的上限。超过上限时只留字节数与摘要：原始日志始终是
 * 证据本体，事件里的 `sourceIndex` 加会话的 `sourcePath` 就是回指位置，派生层不需要
 * 复制整条记录（个别宿主的一条记录就有 MB 级 base64）。
 */
export const MAX_TRACE_RAW_EVIDENCE_BYTES = 8 * 1024;

export interface TraceMessageAttachment {
  attachmentKind: 'image' | 'file';
  /** Privacy-safe display name. Source-local paths remain available only in raw logs. */
  name: string;
}

/** Source-neutral tool identity, including provider namespaces when present. */
export type TraceToolRef = NormalizedToolIdentity;

interface TraceEventBase {
  eventId: string;
  /** Source-native record/message id, when the source exposes one. */
  sourceEventId?: string;
  /**
   * 同一事实在宿主日志里的全部原生记录 id。宿主常对一次执行写两套视图且 id 命名空间不相交，
   * 只有把两侧的 id 都登记下来，跨视图去重才能按身份精确判定，而不是按「同类事件数」近似。
   */
  sourceIds?: string[];
  sourceIndex: number;
  sourceType: string;
  timestamp?: string;
  turnId?: string;
}

export interface TraceMessageEvent extends TraceEventBase {
  eventKind: 'message';
  role: TraceMessageRole;
  origin: TraceMessageOrigin;
  text: string;
  /** Human-facing text after a source adapter removes transport/UI envelopes. */
  displayText?: string;
  attachments?: TraceMessageAttachment[];
  model?: string;
  attributionSkill?: string;
}

export interface TraceToolCallEvent extends TraceEventBase {
  eventKind: 'tool_call';
  callId: string;
  callInstanceId?: string;
  tool: TraceToolRef;
  input: Record<string, unknown>;
  model?: string;
}

export interface TraceToolResultEvent extends TraceEventBase {
  eventKind: 'tool_result';
  callId: string;
  callInstanceId?: string;
  output: string;
  status: TraceToolStatus;
  statusSource: TraceToolStatusSource;
  /** 宿主报告的进程退出码；只在运行时记录里写明时才有，不从输出文本推断。 */
  exitCode?: number;
  /** 宿主报告的该次调用时长。 */
  durationMs?: number;
}

export interface TraceUsageEvent extends TraceEventBase {
  eventKind: 'usage';
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

export interface TraceModelActivityEvent extends TraceEventBase {
  eventKind: 'model_activity';
  activityKind: TraceModelActivityKind;
  contentVisibility: TraceModelActivityVisibility;
  text?: string;
  contentSource?: TraceModelActivityContentSource;
  model?: string;
}

export interface TraceLifecycleEvent extends TraceEventBase {
  eventKind: 'lifecycle';
  phase:
    | 'session_started'
    | 'session_ended'
    | 'turn_started'
    | 'turn_completed'
    | 'turn_failed'
    | 'turn_aborted'
    | 'turn_interrupted'
    | 'turn_ended_unknown'
    | 'step_started'
    | 'step_completed'
    | 'review_started'
    | 'review_finished';
  reason?: string;
  durationMs?: number;
}

/** Source-neutral execution context visible to the agent for a turn or run. */
export interface TraceRuntimeContextEvent extends TraceEventBase {
  eventKind: 'runtime_context';
  runtimeKind: TraceRuntimeContextKind;
  runtimeName?: string;
  runtimeVersion?: string;
  cwd?: string;
  workspaceRoots?: string[];
  currentDate?: string;
  timezone?: string;
  model?: string;
  modelProvider?: string;
  serviceTier?: string;
  reasoningEffort?: string;
  reasoningSummary?: string;
  personality?: string;
  approvalPolicy?: string;
  approvalReviewer?: string;
  permissionProfile?: string;
  sandboxMode?: string;
  collaborationMode?: string;
  realtimeActive?: boolean;
  multiAgentMode?: string;
  multiAgentVersion?: string;
  memoryMode?: string;
  historyMode?: string;
  contextWindowId?: string;
  parentRunId?: string;
  delegationDepth?: number;
  sourceOrigin?: string;
  availableTools?: string[];
  instructions?: string;
  goal?: string;
  goalStatus?: string;
  summary?: string;
}

/** A source-reported context-window compaction boundary. */
export interface TraceContextCompactionEvent extends TraceEventBase {
  eventKind: 'context_compaction';
  summary?: string;
  replacementItemCount?: number;
}

/** Observable communication or status emitted by a cooperating agent. */
export interface TraceAgentActivityEvent extends TraceEventBase {
  eventKind: 'agent_activity';
  activityKind: TraceAgentActivityKind;
  agentId?: string;
  agentPath?: string;
  activity?: string;
  author?: string;
  recipient?: string;
  text?: string;
}

export interface TraceObservedEffectEvent extends TraceEventBase {
  eventKind: 'observed_effect';
  effectKind: TraceObservedEffectKind;
  /**
   * 相对会话 cwd 的路径。宿主的绝对本地路径仍只留在原始日志里，与 `TraceMessageAttachment`
   * 的隐私口径一致。
   */
  paths?: string[];
  changeCount?: number;
  addedLines?: number;
  deletedLines?: number;
  status?: TraceToolStatus;
  statusSource?: TraceToolStatusSource;
  durationMs?: number;
}

export interface TraceUnknownEvent extends TraceEventBase {
  eventKind: 'unknown';
  raw?: unknown;
  /** 原始记录的字节数，`rawTruncated` 为真时派生层只剩摘要与节选。 */
  rawBytes?: number;
  /** 原始记录规范化后的 sha256 前 16 位，用于确认两份产物是否同一证据。 */
  rawDigest?: string;
  rawTruncated?: boolean;
  /** 超限记录的开头节选：协议字段通常在记录前部，读侧的模式匹配仍可用。 */
  rawExcerpt?: string;
  /**
   * 适配器读出的记录族名与记录自身的原生 id——都是协议标识符而非内容，因此与 `raw` 不同，
   * 它们始终保留：`raw` 超限被摘要掉后，未识别记录的分桶口径仍能按族与身份判定，不会
   * 退化成「读不出」。
   */
  recordFamily?: string;
  recordId?: string;
}

/** 未识别记录的可读文本：完整记录优先，超限时退回节选。 */
export function unknownTraceEventText(event: TraceUnknownEvent): string {
  if (event.raw !== undefined) return safeStringify(event.raw);
  return event.rawExcerpt ?? '';
}

/**
 * 构造未识别事件：整条原始记录进派生层，但超过上限时只留字节数与摘要——回指位置由
 * `sourceIndex` 与所属会话的 `sourcePath` 提供，原始日志始终是证据本体。
 */
export function unknownTraceEvent(
  base: Partial<TraceEventBase> & Pick<TraceEventBase, 'sourceIndex' | 'sourceType'>,
  eventId: string,
  raw?: unknown,
): TraceUnknownEvent {
  const rest: Omit<TraceEventBase, 'eventId'> = {
    ...(base.sourceEventId === undefined ? {} : { sourceEventId: base.sourceEventId }),
    sourceIndex: base.sourceIndex,
    sourceType: base.sourceType,
    ...(base.timestamp === undefined ? {} : { timestamp: base.timestamp }),
    ...(base.turnId === undefined ? {} : { turnId: base.turnId }),
  };
  const record = isPlainRecord(raw) ? raw : undefined;
  const payload = record && isPlainRecord(record.payload) ? record.payload : undefined;
  const item = payload && isPlainRecord(payload.item) ? payload.item : undefined;
  // 族名优先取最具体的那一层协议标签：item 视图 > payload 类型 > 记录类型。
  const recordFamily = item?.type ?? payload?.type ?? record?.type;
  const recordId = item?.id ?? payload?.call_id ?? payload?.id ?? record?.id;
  const identity = {
    ...(typeof recordFamily === 'string' ? { recordFamily } : {}),
    ...(typeof recordId === 'string' ? { recordId } : {}),
  };
  const serialized = safeStringify(raw);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_TRACE_RAW_EVIDENCE_BYTES) {
    return { ...rest, eventKind: 'unknown', eventId, raw, rawBytes: bytes, ...identity };
  }
  return {
    ...rest,
    eventKind: 'unknown',
    eventId,
    rawBytes: bytes,
    rawDigest: createHash('sha256').update(serialized).digest('hex').slice(0, 16),
    rawTruncated: true,
    rawExcerpt: excerptText(serialized),
    ...identity,
  };
}

function excerptText(serialized: string): string {
  const buffer = Buffer.from(serialized, 'utf8').subarray(0, MAX_TRACE_RAW_EVIDENCE_BYTES);
  // 按字节切可能落在多字节字符中间，去掉行尾的替换字符。
  return buffer.toString('utf8').replace(/\uFFFD+$/, '');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export type TraceEvent =
  | TraceMessageEvent
  | TraceToolCallEvent
  | TraceToolResultEvent
  | TraceUsageEvent
  | TraceModelActivityEvent
  | TraceLifecycleEvent
  | TraceRuntimeContextEvent
  | TraceContextCompactionEvent
  | TraceAgentActivityEvent
  | TraceObservedEffectEvent
  | TraceUnknownEvent;

export interface TraceSession {
  /** Concrete source run/thread identifier. */
  runId: string;
  /** Root run shared by a main trace and its descendants. */
  rootRunId: string;
  parentRunId?: string;
  /** Unique evidence stream identifier. */
  traceId: string;
  groupPath: string;
  role: TraceRole;
  label: string;
  sourcePath: string;
  sourceKind: TraceSourceKind;
  events: TraceEvent[];
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  sourceMetadata?: TraceSourceMetadata;
  startTimestamp?: string;
  endTimestamp?: string;
}

export interface TraceCorpus {
  sessions: TraceSession[];
  ingestion: TraceIngestionSummary;
}

/**
 * Build a deterministic, transport-safe identity for one physical evidence
 * stream. Source paths remain available as provenance; the identifier itself
 * stays opaque so it can safely cross JSON, HTML, URLs, and review-state keys.
 */
export function createTraceId(input: {
  sourceKind: TraceSourceKind;
  runId: string;
  sourcePath: string;
  streamId?: string;
}): string {
  const stable = [
    input.sourceKind,
    input.runId,
    canonicalTraceSourcePath(input.sourcePath),
    input.streamId ?? '',
  ].join('\u0000');
  return `trace:${createHash('sha256').update(stable).digest('hex').slice(0, 32)}`;
}

function canonicalTraceSourcePath(sourcePath: string): string {
  try {
    return realpathSync(sourcePath);
  } catch {
    return resolve(sourcePath);
  }
}

export function normalizeTraceTimestamp(value: unknown): string | undefined {
  return normalizeRfc3339Timestamp(value);
}

export function traceTimestampBounds(values: Iterable<unknown>): {
  startTimestamp?: string;
  endTimestamp?: string;
} {
  let startTimestamp: string | undefined;
  let endTimestamp: string | undefined;
  for (const value of values) {
    const timestamp = normalizeTraceTimestamp(value);
    if (!timestamp) continue;
    if (!startTimestamp || timestamp < startTimestamp) startTimestamp = timestamp;
    if (!endTimestamp || timestamp > endTimestamp) endTimestamp = timestamp;
  }
  return { startTimestamp, endTimestamp };
}

/**
 * Correlate one concrete call occurrence with its result without treating a
 * source-native callId as globally unique. FIFO is the only source-neutral
 * assumption available when a runtime reuses call IDs.
 */
export function correlateTraceToolEvents(events: TraceEvent[]): TraceEvent[] {
  const pending = new Map<string, TraceToolCallEvent[]>();
  return events.map((event) => {
    if (event.eventKind === 'tool_call') {
      const callInstanceId = event.callInstanceId ?? event.eventId;
      const correlated = { ...event, callInstanceId };
      const queue = pending.get(event.callId) ?? [];
      queue.push(correlated);
      pending.set(event.callId, queue);
      return correlated;
    }
    if (event.eventKind === 'tool_result') {
      const queue = pending.get(event.callId);
      const matchingIndex = event.callInstanceId
        ? queue?.findIndex((candidate) => candidate.callInstanceId === event.callInstanceId)
        : undefined;
      const call = matchingIndex !== undefined && matchingIndex >= 0
        ? queue?.splice(matchingIndex, 1)[0]
        : event.callInstanceId
          ? undefined
          : queue?.shift();
      if (queue?.length === 0) pending.delete(event.callId);
      return {
        ...event,
        callInstanceId: event.callInstanceId
          ?? call?.callInstanceId
          ?? `orphan:${event.eventId}`,
      };
    }
    return event;
  });
}
