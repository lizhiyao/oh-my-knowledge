import type { ToolCallInfo, TurnInfo } from '../executors/contracts/trace.js';
import { safeSliceForJson } from './json-safe-truncation.js';

export const MAX_PERSISTED_TURN_CONTENT = 2000;
export const MAX_PERSISTED_TOOL_OUTPUT = 1000;

export function truncateToolCallsForPersistence(toolCalls: ToolCallInfo[]): ToolCallInfo[] {
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    output: typeof toolCall.output === 'string'
      ? safeSliceForJson(toolCall.output, MAX_PERSISTED_TOOL_OUTPUT)
      : toolCall.output,
  }));
}

export function truncateTurnsForPersistence(turns: TurnInfo[]): TurnInfo[] {
  return turns.map((turn) => ({
    ...turn,
    content: safeSliceForJson(turn.content, MAX_PERSISTED_TURN_CONTENT),
    ...(turn.toolCalls && {
      toolCalls: truncateToolCallsForPersistence(turn.toolCalls),
    }),
  }));
}
