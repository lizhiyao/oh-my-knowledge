import type { ToolCallInfo, ToolCallStatus } from './contracts/trace.js';

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

export function isToolResultFailureText(value: unknown): boolean {
  if (toolResultFailureJson(value)) return true;
  const text = typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return /(?:^|\b)(?:status|state)\s*[:=]\s*["']?(?:error|failed|failure)["']?/i.test(text)
    || /\berror\s*[:=]\s*(?!false|null|0\b).+/i.test(text);
}

function toolResultFailureJson(value: unknown): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (value && typeof value === 'object') return containsToolFailureSignal(value, 0);
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false;
  try {
    return containsToolFailureSignal(JSON.parse(trimmed), 0);
  } catch {
    return false;
  }
}

function containsToolFailureSignal(value: unknown, depth: number): boolean {
  if (depth > 5 || value === null || value === undefined) return false;
  if (typeof value === 'string') return toolResultFailureJson(value);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsToolFailureSignal(item, depth + 1));

  const record = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if ((normalizedKey === 'status' || normalizedKey === 'state') && typeof raw === 'string' && /^(error|failed|failure)$/i.test(raw.trim())) return true;
    if ((normalizedKey === 'iserror' || normalizedKey === 'is_error') && raw === true) return true;
    if (normalizedKey === 'success' && raw === false) return true;
    if (normalizedKey === 'error' && raw !== false && raw !== null && raw !== undefined && raw !== '') return true;
    if ((normalizedKey === 'body' || normalizedKey === 'result' || normalizedKey === 'data') && containsToolFailureSignal(raw, depth + 1)) return true;
  }
  return false;
}
