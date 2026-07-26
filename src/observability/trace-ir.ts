import type { TraceSourceMetadata } from '../types/index.js';

export type TraceSourceKind = 'claude' | 'codex' | 'openclaw' | 'markdown_log' | 'unknown';
export type TraceRole = 'standalone' | 'main' | 'subagent';
export type TraceMessageRole = 'user' | 'assistant' | 'system';
export type TraceMessageOrigin = 'human' | 'runtime' | 'skill-context' | 'synthetic';
export type TraceToolStatus = 'success' | 'failure' | 'cancelled' | 'unknown';
export type TraceToolStatusSource = 'runtime' | 'tool-output' | 'inferred' | 'unknown';

export interface TraceToolRef {
  /** Stable, source-neutral tool name used by omk analyzers. */
  name: string;
  /** Original source name, retained when normalization changes `name`. */
  sourceName?: string;
  /** Provider namespace such as `mcp__codex_apps__github`. */
  namespace?: string;
  /** Provider or connector name when the source exposes one separately. */
  provider?: string;
  /** Fully qualified human-readable identity such as `github.fetch_file`. */
  displayName?: string;
}

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
  model?: string;
  attributionSkill?: string;
}

export interface TraceToolCallEvent extends TraceEventBase {
  eventKind: 'tool_call';
  callId: string;
  tool: TraceToolRef;
  input: Record<string, unknown>;
  model?: string;
}

export interface TraceToolResultEvent extends TraceEventBase {
  eventKind: 'tool_result';
  callId: string;
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

export interface TraceLifecycleEvent extends TraceEventBase {
  eventKind: 'lifecycle';
  phase: 'session_started' | 'session_ended' | 'turn_started' | 'turn_completed' | 'turn_aborted' | 'turn_interrupted';
  reason?: string;
  durationMs?: number;
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
  | TraceLifecycleEvent
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

export function traceEventTimestamp(event: TraceEvent): string | undefined {
  return event.timestamp;
}

export function traceToolDisplayName(tool: TraceToolRef): string {
  return tool.displayName ?? tool.name;
}
