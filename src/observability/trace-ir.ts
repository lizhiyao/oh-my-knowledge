import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ToolCallStatus,
  ToolCallStatusSource,
  TraceIngestionSummary,
  TraceSourceMetadata,
} from '../types/index.js';
import type { TraceSourceKind } from '../types/trace.js';
import { normalizeRfc3339Timestamp } from '../shared/timestamp.js';
import type { NormalizedToolIdentity } from '../shared/tool-identity.js';

export type { TraceSourceKind } from '../types/trace.js';
export type TraceRole = 'standalone' | 'main' | 'subagent';
export type TraceMessageRole = 'user' | 'assistant' | 'system';
export type TraceMessageOrigin = 'human' | 'runtime' | 'skill-context' | 'synthetic';
export type TraceToolStatus = ToolCallStatus;
export type TraceToolStatusSource = ToolCallStatusSource;
export type TraceModelActivityKind = 'reasoning';
export type TraceModelActivityVisibility = 'plaintext' | 'opaque';
export type TraceModelActivityContentSource = 'summary' | 'content' | 'text';
export type TraceRuntimeContextKind = 'session_context' | 'execution_context' | 'settings' | 'goal';
export type TraceAgentActivityKind = 'communication' | 'status';

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
}

export interface TraceUsageEvent extends TraceEventBase {
  eventKind: 'usage';
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
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
  phase: 'session_started' | 'session_ended' | 'turn_started' | 'turn_completed' | 'turn_aborted' | 'turn_interrupted';
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

export interface TraceUnknownEvent extends TraceEventBase {
  eventKind: 'unknown';
  raw?: unknown;
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

export function traceEventTimestamp(event: TraceEvent): string | undefined {
  return event.timestamp;
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

export function traceToolDisplayName(tool: TraceToolRef): string {
  return tool.displayName ?? tool.name;
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
