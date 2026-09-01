import type { ToolCallInfo, ToolCallStatus } from '../executors/contracts/trace.js';

type ToolCallOutcomeInput = Partial<Pick<ToolCallInfo, 'status' | 'success'>>;

const TOOL_CALL_STATUSES = new Set<ToolCallStatus>([
  'success',
  'failure',
  'cancelled',
  'unknown',
]);

export function toolCallStatus(call: ToolCallOutcomeInput): ToolCallStatus {
  if (call.status !== undefined) {
    return TOOL_CALL_STATUSES.has(call.status) ? call.status : 'unknown';
  }
  if (call.success === true) return 'success';
  if (call.success === false) return 'failure';
  return 'unknown';
}

export function isToolCallSuccess(call: ToolCallOutcomeInput): boolean {
  return toolCallStatus(call) === 'success';
}

export function isToolCallFailure(call: ToolCallOutcomeInput): boolean {
  return toolCallStatus(call) === 'failure';
}

export function isToolCallCancelled(call: ToolCallOutcomeInput): boolean {
  return toolCallStatus(call) === 'cancelled';
}

export function isToolCallUnknown(call: ToolCallOutcomeInput): boolean {
  return toolCallStatus(call) === 'unknown';
}
