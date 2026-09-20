/** Claude Code JSONL 单条记录 → Trace IR 事件。 */

import type {
  TraceEvent,
  TraceSourceKind,
  TraceUsageEvent,
} from '../../trace-ir.js';
import {
  normalizeTraceTimestamp,
  unknownTraceEvent,
} from '../../trace-ir.js';
import { normalizeToolIdentity } from '../../../../executors/core/tool-identity.js';
import { nonNegativeMetric, tokenCount } from '../../../../executors/core/token-usage.js';
import { isToolResultFailureText } from '../../../../executors/tool-call-status.js';
import {
  isClaudeBuiltinCommand,
  stripCommandEnvelopeText,
} from '../../attribution.js';
import {
  classifyUserMessageOrigin,
  isRecordObject,
  isValidUsageCounters,
  lifecycleEventFromLegacy,
} from '../jsonl-records.js';

export function claudeRecordToTraceEvents(
  raw: unknown,
  runId: string,
  sourceIndex: number,
  sourceKind: TraceSourceKind,
): TraceEvent[] {
  if (!isRecordObject(raw)) return [];
  const sourceType = typeof raw.type === 'string' ? raw.type : 'unknown';
  const timestamp = normalizeTraceTimestamp(raw.timestamp);
  const sourceEventId = typeof raw.uuid === 'string'
    ? raw.uuid
    : typeof raw.id === 'string'
      ? raw.id
      : undefined;
  const eventId = (suffix: string): string => `${runId}:${sourceIndex}:${suffix}`;

  if (sourceType === 'user' && isRecordObject(raw.message)) {
    const content = raw.message.content;
    const events: TraceEvent[] = [];
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    let partIndex = 0;
    for (const part of parts) {
      if (!isRecordObject(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        const text = sourceKind === 'claude'
          ? stripClaudeBuiltinCommandEnvelope(part.text)
          : part.text;
        if (!text) {
          partIndex += 1;
          continue;
        }
        events.push({
          eventKind: 'message',
          eventId: eventId(`message-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          role: 'user',
          origin: classifyUserMessageOrigin(raw, text),
          text,
        });
      } else if (
        part.type === 'tool_result'
        && typeof part.tool_use_id === 'string'
      ) {
        const output = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
        const explicit = typeof part.is_error === 'boolean';
        const inferredFailure = !explicit && isToolResultFailureText(output);
        events.push({
          eventKind: 'tool_result',
          eventId: eventId(`tool-result-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.tool_use_id,
          output,
          status: explicit
            ? part.is_error === true ? 'failure' : 'success'
            : inferredFailure ? 'failure' : 'unknown',
          statusSource: explicit ? 'runtime' : inferredFailure ? 'inferred' : 'unknown',
        });
      }
      partIndex += 1;
    }
    return events;
  }

  if (sourceType === 'assistant' && isRecordObject(raw.message)) {
    const events: TraceEvent[] = [];
    const content = Array.isArray(raw.message.content) ? raw.message.content : [];
    const model = typeof raw.message.model === 'string' ? raw.message.model : undefined;
    const text = content.flatMap((part) =>
      isRecordObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    ).join('\n');
    if (text) {
      events.push({
        eventKind: 'message',
        eventId: eventId('message'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        role: 'assistant',
        origin: 'synthetic',
        text,
        model,
        attributionSkill: typeof raw.attributionSkill === 'string' ? raw.attributionSkill : undefined,
      });
    }
    content.forEach((part, partIndex) => {
      if (isRecordObject(part) && (part.type === 'thinking' || part.type === 'reasoning')) {
        // 两个来源的推理块字段名不同：Claude 是 thinking，AI SDK 族宿主是 reasoning + text。
        const reasoning = typeof part.thinking === 'string'
          ? part.thinking.trim()
          : typeof part.text === 'string'
            ? part.text.trim()
            : '';
        if (reasoning) {
          events.push({
            eventKind: 'model_activity',
            eventId: eventId(`model-activity-${partIndex}`),
            sourceEventId,
            sourceIndex,
            sourceType,
            timestamp,
            activityKind: 'reasoning',
            contentVisibility: 'plaintext',
            text: reasoning,
            contentSource: 'text',
            model,
          });
        } else if (typeof part.signature === 'string' && part.signature.trim()) {
          // 推理被脱敏成签名时只登记边界，不编造推理文本。
          events.push({
            eventKind: 'model_activity',
            eventId: eventId(`model-activity-${partIndex}`),
            sourceEventId,
            sourceIndex,
            sourceType,
            timestamp,
            activityKind: 'reasoning',
            contentVisibility: 'opaque',
            model,
          });
        }
        return;
      }
      if (
        isRecordObject(part)
        && part.type === 'tool_use'
        && typeof part.id === 'string'
        && typeof part.name === 'string'
      ) {
        events.push({
          eventKind: 'tool_call',
          eventId: eventId(`tool-call-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.id,
          tool: normalizeToolIdentity({ sourceName: part.name }),
          input: isRecordObject(part.input) ? part.input : {},
          model,
        });
        return;
      }
      // 同族宿主复用 Claude 的落盘目录，但工具块是 AI SDK 命名：tool-call + toolCallId/toolName。
      if (
        isRecordObject(part)
        && part.type === 'tool-call'
        && typeof part.toolCallId === 'string'
        && typeof part.toolName === 'string'
      ) {
        events.push({
          eventKind: 'tool_call',
          eventId: eventId(`tool-call-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.toolCallId,
          tool: normalizeToolIdentity({ sourceName: part.toolName }),
          input: isRecordObject(part.input) ? part.input : {},
          model,
        });
      }
    });
    if (isRecordObject(raw.message.usage)) {
      const usageEvent = usageEventFromLegacy(
        raw.message.usage,
        eventId('usage'),
        sourceIndex,
        sourceType,
        timestamp,
        model,
      );
      events.push(usageEvent ?? unknownTraceEvent(
        { sourceEventId, sourceIndex, sourceType, timestamp },
        eventId('invalid-usage'),
        raw,
      ));
    }
    return events;
  }

  // 同族宿主把工具结果写成独立记录（type:"tool"），而不是 user 记录里的 tool_result 块。
  if (sourceType === 'tool' && isRecordObject(raw.message)) {
    const parts = Array.isArray(raw.message.content) ? raw.message.content : [];
    const events: TraceEvent[] = [];
    let partIndex = 0;
    for (const part of parts) {
      if (
        isRecordObject(part)
        && part.type === 'tool-result'
        && typeof part.toolCallId === 'string'
      ) {
        const output = claudeToolResultOutput(part.output);
        const explicit = typeof part.isError === 'boolean';
        const inferredFailure = !explicit && isToolResultFailureText(output);
        events.push({
          eventKind: 'tool_result',
          eventId: eventId(`tool-result-${partIndex}`),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          callId: part.toolCallId,
          output,
          status: explicit
            ? part.isError === true ? 'failure' : 'success'
            : inferredFailure ? 'failure' : 'unknown',
          statusSource: explicit ? 'runtime' : inferredFailure ? 'inferred' : 'unknown',
        });
      }
      partIndex += 1;
    }
    // 一块都没配上就退回 unknown 统计，别让新分支静默吞掉未知形态。
    if (events.length > 0) return events;
  }

  if (sourceType === 'system') {
    if (raw.subtype === 'turn_duration') {
      return [{
        eventKind: 'lifecycle',
        eventId: eventId('turn-completed'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        phase: 'turn_completed',
        durationMs: nonNegativeMetric(raw.durationMs),
      }];
    }
    const text = claudeSystemRecordText(raw);
    if (text) {
      return [{
        eventKind: 'message',
        eventId: eventId('system-message'),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        role: 'system',
        origin: 'runtime',
        text,
      }];
    }
    return [];
  }

  const lifecycle = lifecycleEventFromLegacy(raw, runId, sourceIndex, sourceType, timestamp);
  if (lifecycle) return [lifecycle];
  if (isKnownClaudeRecordType(sourceType)) return [];
  return [unknownTraceEvent(
    { sourceEventId, sourceIndex, sourceType, timestamp },
    eventId('unknown'),
    raw,
  )];
}

function stripClaudeBuiltinCommandEnvelope(text: string): string {
  const match = /<command-name>\/([^<]+)<\/command-name>/.exec(text);
  return match?.[1] && isClaudeBuiltinCommand(match[1])
    ? stripCommandEnvelopeText(text)
    : text;
}

export function isKnownClaudeRecordType(value: unknown): boolean {
  return value === 'assistant'
    || value === 'user'
    || value === 'attachment'
    || value === 'pr-link'
    || value === 'mode'
    || value === 'permission-mode'
    || value === 'last-prompt'
    || value === 'ai-title'
    || value === 'agent-name'
    || value === 'system'
    || value === 'file-history-snapshot'
    || value === 'queue-operation';
}

/** 同族宿主的 tool-result.output 实测只有字符串与 `{type,value}` 两种包装；其余形态保留为 JSON，不静默丢证据。 */
function claudeToolResultOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecordObject(value) && typeof value.value === 'string') return value.value;
  return value === undefined ? '' : JSON.stringify(value);
}

function claudeSystemRecordText(record: Record<string, unknown>): string {
  if (typeof record.content === 'string' && record.content.trim()) return record.content;
  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  if (record.subtype !== 'api_error' || !isRecordObject(record.error)) return '';
  if (typeof record.error.formatted === 'string' && record.error.formatted.trim()) {
    return record.error.formatted;
  }
  return typeof record.error.message === 'string' ? record.error.message : '';
}

function usageEventFromLegacy(
  usage: Record<string, unknown>,
  eventId: string,
  sourceIndex: number,
  sourceType: string,
  timestamp?: string,
  model?: string,
): TraceUsageEvent | null {
  if (!isValidUsageCounters(
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  )) return null;
  return {
    eventKind: 'usage',
    eventId,
    sourceIndex,
    sourceType,
    timestamp,
    model,
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
    cacheCreationTokens: tokenCount(usage.cache_creation_input_tokens),
  };
}
