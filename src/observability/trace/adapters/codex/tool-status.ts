import type { TraceToolStatus } from '../../trace-ir.js';
import { isToolResultFailureText } from '../../../../executors/tool-call-status.js';

export interface CodexToolOutcome {
  status: TraceToolStatus;
  present: boolean;
}

/** Normalize Codex status values before source adapters project Trace IR. */
export function codexToolStatusFromValue(value: unknown): TraceToolStatus {
  const status = stringValue(value)?.toLowerCase();
  if (status === 'failed' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'success' || status === 'succeeded' || status === 'completed' || status === 'complete') {
    return 'success';
  }
  return 'unknown';
}

/** Runtime end records are authoritative even when they only expose an Ok/Err envelope. */
export function codexRuntimeToolOutcome(
  end: { status?: unknown; isError?: boolean } | undefined,
): CodexToolOutcome {
  if (!end) return { status: 'unknown', present: false };
  if (end.status !== undefined) {
    const status = codexToolStatusFromValue(end.status);
    if (status === 'cancelled') return { status, present: true };
    if (status === 'failure' || end.isError === true) {
      return { status: 'failure', present: true };
    }
    if (status === 'success') return { status, present: true };
    return { status: 'unknown', present: true };
  }
  if (end.isError === true) return { status: 'failure', present: true };
  if (end.isError === false) return { status: 'success', present: true };
  return { status: 'unknown', present: false };
}

/** Extract the same authoritative outcome from a raw Codex runtime-end payload. */
export function codexRuntimeToolOutcomeFromPayload(
  payloadType: string | undefined,
  payload: Record<string, unknown>,
): CodexToolOutcome {
  if (payloadType === 'patch_apply_end') {
    const success = booleanValue(payload.success);
    return codexRuntimeToolOutcome({
      status: payload.status,
      isError: success === undefined ? undefined : !success,
    });
  }
  if (payloadType !== 'mcp_tool_call_end') return { status: 'unknown', present: false };
  const result = objectValue(payload.result) ?? {};
  const hasOk = Object.prototype.hasOwnProperty.call(result, 'Ok');
  const ok = objectValue(result.Ok);
  const hasErr = Object.prototype.hasOwnProperty.call(result, 'Err');
  const isError = booleanValue(payload.isError)
    ?? booleanValue(payload.is_error)
    ?? booleanValue(result.isError)
    ?? booleanValue(result.is_error)
    ?? booleanValue(ok?.isError)
    ?? booleanValue(ok?.is_error)
    ?? (hasErr ? true : hasOk ? false : undefined);
  return codexRuntimeToolOutcome({
    status: payload.status ?? result.status ?? ok?.status,
    isError,
  });
}

/** Infer bridge output status only when Codex did not record an explicit status. */
export function codexToolOutputOutcome(
  output: unknown,
  explicitStatus?: unknown,
): CodexToolOutcome {
  if (explicitStatus !== undefined) {
    return { status: codexToolStatusFromValue(explicitStatus), present: true };
  }
  const text = toolOutputText(output);
  if (codexToolOutputFailed(text)) {
    return { status: 'failure', present: true };
  }
  if (codexToolOutputSucceeded(text)) return { status: 'success', present: true };
  if (isToolResultFailureText(output)) return { status: 'failure', present: true };
  return { status: 'unknown', present: false };
}

function codexToolOutputFailed(output: string): boolean {
  return /\b(?:process|script)\s+(?:exited|failed)\s+with\s+(?:exit\s+)?code\s+[1-9]\d*\b/i.test(output)
    || /\bexit[_\s-]?code\s*[:=]\s*[1-9]\d*\b/i.test(output)
    || /\bapply_patch verification failed\b/i.test(output);
}

function codexToolOutputSucceeded(output: string): boolean {
  const trimmed = output.trim();
  return /\bprocess exited with code 0\b/i.test(trimmed)
    || /\bexit code:\s*0\b/i.test(trimmed)
    || /^script completed\b/i.test(trimmed)
    || /^success\.\s+(?:updated|added|deleted|moved)\b/i.test(trimmed)
    || /^plan updated\b/i.test(trimmed)
    || /^workspace dependencies are available\b/i.test(trimmed)
    || /^\[image\]$/i.test(trimmed);
}

function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
