/** Codex 工具事件的共同形状：调用／结果的字段组装与 MCP 身份投影只写一遍。 */

import type { TraceEvent, TraceToolRef, TraceToolStatus } from '../../trace-ir.js';
import { normalizeToolIdentity } from '../../../../executors/core/tool-identity.js';
import type { McpCallEnd } from './record-indexes.js';

/** 一条记录里可用来做跨视图身份判定的原生 id。 */
export function codexPayloadIds(payload: Record<string, unknown>): string[] {
  return [...new Set(
    ['call_id', 'id'].map((key) => (typeof payload[key] === 'string' ? payload[key] as string : undefined))
      .filter((id): id is string => id !== undefined),
  )];
}

export function mcpToolRefFromEnd(end: McpCallEnd): TraceToolRef {
  return normalizeToolIdentity({
    sourceName: 'mcp_tool_call',
    provider: end.server,
    authoritativeName: end.tool ?? 'unknown',
  });
}

export function toolCallEvent(
  eventId: string,
  base: Omit<TraceEventBase, 'eventId'>,
  callId: string,
  tool: TraceToolRef,
  input: Record<string, unknown>,
  model?: string,
): TraceEvent {
  return { ...base, eventKind: 'tool_call', eventId, callId, tool, input, model };
}

export function toolResultEvent(
  eventId: string,
  base: Omit<TraceEventBase, 'eventId'>,
  callId: string,
  output: string,
  status: TraceToolStatus,
  statusSource: 'runtime' | 'inferred' | 'unknown',
): TraceEvent {
  return { ...base, eventKind: 'tool_result', eventId, callId, output, status, statusSource };
}

export interface TraceEventBase {
  sourceEventId?: string;
  sourceIndex: number;
  sourceType: string;
  timestamp?: string;
  turnId?: string;
  eventId: string;
}
