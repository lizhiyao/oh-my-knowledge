import type { TraceSourceKind } from '../../shared/contracts/trace-source.js';

export type ToolCallStatus = 'success' | 'failure' | 'cancelled' | 'unknown';
export type ToolCallStatusSource = 'runtime' | 'tool-output' | 'inferred' | 'unknown';

export interface ToolCallInfo {
  /** Source-neutral tool identity used by assertions and aggregate reports. */
  tool: string;
  /** Runtime-native identity retained when `tool` was normalized. */
  sourceTool?: string;
  toolNamespace?: string;
  toolProvider?: string;
  input: unknown;
  output: unknown;
  /**
   * Source-neutral completion state. Older reports only have `success`; readers
   * must fall back to that boolean when this field is absent.
   */
  status?: ToolCallStatus;
  statusSource?: ToolCallStatusSource;
  success: boolean;
  messageIndex?: number;
  messageUuid?: string;
  /** Source-neutral identity for one concrete call occurrence. */
  callInstanceId?: string;
  toolUseId?: string;
  timestamp?: string;
  sourceTrace?: string;
  sourceKind?: TraceSourceKind;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
}

export interface TurnInfo {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallInfo[];
  durationMs?: number;
}
