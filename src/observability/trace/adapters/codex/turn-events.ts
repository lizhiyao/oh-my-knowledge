/** 轮次族：token 用量快照与轮次生命周期；两者共用同一份 activeModel／activeTurnId 运行时状态。 */

import type { TraceEvent } from '../../trace-ir.js';
import { unknownTraceEvent } from '../../trace-ir.js';
import {
  nonNegativeMetric,
  optionalTokenCount,
  splitInclusiveInputTokens,
  tokenCount,
} from '../../../../executors/core/token-usage.js';
import type {
  CodexConversionState,
  CodexFamilyOutcome,
  CodexRecordContext,
} from './conversion-contract.js';
import { familyOutcome } from './conversion-contract.js';
import { isObject, stringValue } from './record-fields.js';

/** 分支顺序与原 if 链一致：跨族的先后由 `record-conversion.ts` 的分发表保证。 */
export function convertCodexTurnRecord(
  ctx: CodexRecordContext,
  state: CodexConversionState,
): CodexFamilyOutcome {
  const { base, eventId, payload, payloadType, record, value } = ctx;
  const events: TraceEvent[] = [];

  if (record.type === 'event_msg' && payloadType === 'token_count') {
    const info = isObject(payload.info) ? payload.info : {};
    const usage = isObject(info.last_token_usage) ? info.last_token_usage : undefined;
    // Codex also emits rate-limit-only snapshots under the token_count
    // protocol name. They describe account capacity, not task token usage.
    // Keep the source record for provenance without manufacturing a usage
    // event or reporting a known protocol shape as unknown.
    if (!usage && payload.info == null && isObject(payload.rate_limits)) return familyOutcome(events);
    if (!isValidCodexTokenUsage(usage)) {
      events.push(unknownTraceEvent(base, eventId('invalid-usage'), value));
      return familyOutcome(events);
    }
    const totalUsage = isObject(info.total_token_usage) ? info.total_token_usage : undefined;
    const fingerprint = tokenUsageFingerprint(totalUsage);
    if (totalUsage && !fingerprint) {
      events.push(unknownTraceEvent(base, eventId('invalid-total-usage'), value));
    }
    if (fingerprint && fingerprint === state.previousTotalUsageFingerprint) return familyOutcome(events);
    const normalized = normalizeCodexTokenUsage(usage);
    state.previousTotalUsageFingerprint = fingerprint;
    events.push({
      ...base,
      eventKind: 'usage',
      eventId: eventId('usage'),
      model: state.activeModel,
      ...normalized,
    });
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'task_started') {
    state.activeTurnId = stringValue(payload.turn_id) ?? state.activeTurnId;
    events.push({
      ...base,
      turnId: state.activeTurnId,
      eventKind: 'lifecycle',
      eventId: eventId('lifecycle'),
      phase: 'turn_started',
    });
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'task_complete') {
    events.push({
      ...base,
      eventKind: 'lifecycle',
      eventId: eventId('lifecycle'),
      phase: 'turn_completed',
    });
    state.activeTurnId = undefined;
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'turn_aborted') {
    events.push({
      ...base,
      turnId: stringValue(payload.turn_id) ?? state.activeTurnId,
      eventKind: 'lifecycle',
      eventId: eventId('lifecycle'),
      phase: 'turn_aborted',
      reason: stringValue(payload.reason),
      durationMs: nonNegativeMetric(payload.duration_ms),
    });
    state.activeTurnId = undefined;
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'turn_interrupted') {
    events.push({
      ...base,
      turnId: stringValue(payload.turn_id) ?? state.activeTurnId,
      eventKind: 'lifecycle',
      eventId: eventId('lifecycle'),
      phase: 'turn_interrupted',
      reason: stringValue(payload.reason),
      durationMs: nonNegativeMetric(payload.duration_ms),
    });
    state.activeTurnId = undefined;
    return familyOutcome(events);
  }

  return { disposition: 'pass' };
}

function tokenUsageFingerprint(usage: Record<string, unknown> | undefined): string | undefined {
  if (!isValidCodexTokenUsage(usage)) return undefined;
  const keys = [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  const values = keys.map((key) => optionalTokenCount(usage[key]));
  return values.map((value) => value ?? 0).join(':');
}

function isValidCodexTokenUsage(usage: Record<string, unknown> | undefined): usage is Record<string, unknown> {
  if (!usage) return false;
  if (
    optionalTokenCount(usage.input_tokens) === undefined
    || optionalTokenCount(usage.output_tokens) === undefined
  ) {
    return false;
  }
  const optionalKeys = [
    'cached_input_tokens',
    'cache_write_input_tokens',
    'reasoning_output_tokens',
    'total_tokens',
  ];
  return optionalKeys.every((key) => (
    usage[key] === undefined || optionalTokenCount(usage[key]) !== undefined
  ));
}

function normalizeCodexTokenUsage(usage: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens?: number;
} {
  const input = splitInclusiveInputTokens(
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.cache_write_input_tokens,
  );
  return {
    ...input,
    outputTokens: tokenCount(usage.output_tokens),
    reasoningTokens: optionalTokenCount(usage.reasoning_output_tokens),
  };
}
