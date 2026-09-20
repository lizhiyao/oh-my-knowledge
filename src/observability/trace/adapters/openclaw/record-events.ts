/** OpenClaw JSONL 单条记录 → Trace IR 事件。 */

import type { TraceEvent } from '../../trace-ir.js';
import {
  normalizeTraceTimestamp,
  unknownTraceEvent,
} from '../../trace-ir.js';
import { normalizeToolIdentity } from '../../../../executors/core/tool-identity.js';
import { tokenCount } from '../../../../executors/core/token-usage.js';
import { isToolResultFailureText } from '../../../../executors/tool-call-status.js';
import {
  classifyUserMessageOrigin,
  isRecordObject,
  isValidUsageCounters,
  lifecycleEventFromLegacy,
} from '../jsonl-records.js';

/** OpenClaw 记录只按结构字段解读，不绑定 Claude 族记录词汇。 */
export interface OpenClawRecord {
  type?: unknown;
  [key: string]: unknown;
}

export function asOpenClawRecord(value: unknown): OpenClawRecord | undefined {
  return isRecordObject(value) ? value : undefined;
}

export function openClawRecordToTraceEvents(
  raw: OpenClawRecord,
  sessionId: string,
  sourceIndex: number,
): TraceEvent[] {
  const sourceType = typeof raw.type === 'string' ? raw.type : 'unknown';
  const timestamp = normalizeTraceTimestamp(raw.timestamp);
  const sourceEventId = 'id' in raw && typeof raw.id === 'string' ? raw.id : undefined;
  const eventId = (suffix: string): string => `${sessionId}:${sourceIndex}:${suffix}`;

  if (raw.type === 'session') {
    return [{
      eventKind: 'lifecycle',
      eventId: eventId('session-started'),
      sourceEventId,
      sourceIndex,
      sourceType,
      timestamp,
      phase: 'session_started',
    }];
  }

  const lifecycle = lifecycleEventFromLegacy(
    raw as Record<string, unknown>,
    sessionId,
    sourceIndex,
    sourceType,
    timestamp,
  );
  if (lifecycle) return [lifecycle];
  if (isKnownOpenClawMetadataRecord(raw)) return [];
  if (raw.type !== 'message') {
    return [unknownTraceEvent(
      { sourceEventId, sourceIndex, sourceType, timestamp },
      eventId('unknown'),
      raw,
    )];
  }

  const messageRecord = raw as {
    id?: unknown;
    timestamp?: unknown;
    message?: {
      role?: unknown;
      content?: unknown;
      model?: unknown;
      usage?: unknown;
      stopReason?: unknown;
      api?: unknown;
      provider?: unknown;
      toolCallId?: unknown;
      toolName?: unknown;
      isError?: unknown;
    };
  };
  const message = messageRecord.message;
  if (!message || typeof message.role !== 'string') {
    return [unknownTraceEvent(
      { sourceEventId, sourceIndex, sourceType, timestamp },
      eventId('unknown-message'),
      raw,
    )];
  }

  if (message.role === 'user') {
    return splitOpenClawRuntimeMetadata(openClawContentText(message.content))
      .map((text, partIndex): TraceEvent => ({
        eventKind: 'message',
        eventId: eventId(`message-${partIndex}`),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        role: 'user',
        origin: classifyUserMessageOrigin({ entrypoint: 'openclaw' }, text),
        text,
      }));
  }

  if (message.role === 'assistant') {
    const events: TraceEvent[] = [];
    const model = typeof message.model === 'string' ? message.model : undefined;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = typeof message.content === 'string'
      ? message.content
      : content.flatMap((part) =>
        isRecordObject(part) && part.type === 'text' && typeof part.text === 'string'
          ? [part.text]
          : [],
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
      });
    }
    content.forEach((part, partIndex) => {
      if (
        !isRecordObject(part)
        || part.type !== 'toolCall'
        || typeof part.id !== 'string'
        || typeof part.name !== 'string'
      ) return;
      const sourceName = part.name.trim();
      // OpenClaw's native shell tool is named `exec`. Keep that protocol fact in
      // this adapter instead of teaching the source-neutral identity layer that
      // every custom tool named `exec` is a shell.
      const tool = sourceName.toLowerCase() === 'exec'
        ? { name: 'Bash', sourceName }
        : normalizeToolIdentity({ sourceName });
      events.push({
        eventKind: 'tool_call',
        eventId: eventId(`tool-call-${partIndex}`),
        sourceEventId,
        sourceIndex,
        sourceType,
        timestamp,
        callId: part.id,
        tool,
        input: normalizeOpenClawToolInput(
          tool.name,
          isRecordObject(part.arguments) ? part.arguments : {},
        ),
        model,
      });
    });
    if (isRecordObject(message.usage)) {
      const inputTokens = message.usage.input ?? message.usage.input_tokens;
      const outputTokens = message.usage.output ?? message.usage.output_tokens;
      const cacheReadTokens = message.usage.cacheRead ?? message.usage.cache_read_input_tokens;
      const cacheCreationTokens = message.usage.cacheWrite ?? message.usage.cache_creation_input_tokens;
      if (isValidUsageCounters(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)) {
        events.push({
          eventKind: 'usage',
          eventId: eventId('usage'),
          sourceEventId,
          sourceIndex,
          sourceType,
          timestamp,
          model,
          inputTokens: tokenCount(inputTokens),
          outputTokens: tokenCount(outputTokens),
          cacheReadTokens: tokenCount(cacheReadTokens),
          cacheCreationTokens: tokenCount(cacheCreationTokens),
        });
      } else {
        events.push(unknownTraceEvent(
          { sourceEventId, sourceIndex, sourceType, timestamp },
          eventId('invalid-usage'),
          raw,
        ));
      }
    }
    return events;
  }

  if (message.role === 'toolResult') {
    const toolUseId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
    if (!toolUseId) {
      return [unknownTraceEvent(
        { sourceEventId, sourceIndex, sourceType, timestamp },
        eventId('orphan-tool-result'),
        raw,
      )];
    }
    const content = openClawToolResultText(message.content);
    const hasRuntimeStatus = typeof message.isError === 'boolean';
    const inferredFailure = !hasRuntimeStatus && isToolResultFailureText(content);
    return [{
      eventKind: 'tool_result',
      eventId: eventId('tool-result'),
      sourceEventId,
      sourceIndex,
      sourceType,
      timestamp,
      callId: toolUseId,
      output: content,
      status: hasRuntimeStatus
        ? message.isError === true ? 'failure' : 'success'
        : inferredFailure ? 'failure' : 'unknown',
      statusSource: hasRuntimeStatus ? 'runtime' : inferredFailure ? 'inferred' : 'unknown',
    }];
  }

  return [unknownTraceEvent(
    { sourceEventId, sourceIndex, sourceType, timestamp },
    eventId('unknown-role'),
    raw,
  )];
}

function isKnownOpenClawMetadataRecord(raw: OpenClawRecord): boolean {
  if (raw.type === 'model_change') return true;
  if (raw.type !== 'custom') return false;
  return (raw as { customType?: unknown }).customType === 'model-snapshot';
}

function splitOpenClawRuntimeMetadata(text: string): string[] {
  const match = text.match(/^(Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*)([\s\S]*)$/);
  if (!match) return text ? [text] : [];
  const metadata = match[1].trim();
  const rest = match[2].trim();
  return rest ? [metadata, rest] : [metadata];
}

function normalizeOpenClawToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'Read' && typeof input.path === 'string' && typeof input.file_path !== 'string') {
    return { ...input, file_path: input.path };
  }
  return input;
}

function openClawToolResultText(content: unknown): string {
  return openClawContentText(content);
}

export function openClawContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (isRecordObject(part) && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}
