/** 对话族：用户与助手的消息、推理文本、跨 agent 通信，以及同一次写入的重复视图丢弃。 */

import type { TraceEvent } from '../../trace-ir.js';
import {
  codexUserAttachments,
  codexUserDisplayText,
  codexUserMessageOrigin,
} from './protocol.js';
import type {
  CodexConversionState,
  CodexFamilyOutcome,
  CodexRecordContext,
} from './conversion-contract.js';
import { familyOutcome } from './conversion-contract.js';
import { isObject, stringValue } from './record-fields.js';
import {
  codexContentText,
  codexPlaintext,
  codexReasoningPlaintext,
} from './record-text.js';

/** 分支顺序与原 if 链一致：跨族的先后由 `record-conversion.ts` 的分发表保证。 */
export function convertCodexConversationRecord(
  ctx: CodexRecordContext,
  state: CodexConversionState,
): CodexFamilyOutcome {
  const {
    base,
    duplicateAgentReasoningIndexes,
    duplicateEventMessageIndexes,
    eventId,
    payload,
    payloadType,
    record,
    sourceIndex,
  } = ctx;
  const events: TraceEvent[] = [];

  if (record.type === 'response_item' && payloadType === 'reasoning') {
    const reasoning = codexReasoningPlaintext(payload);
    if (reasoning) {
      events.push({
        ...base,
        eventKind: 'model_activity',
        eventId: eventId('model-activity'),
        activityKind: 'reasoning',
        contentVisibility: 'plaintext',
        text: reasoning.text,
        contentSource: reasoning.contentSource,
        model: state.activeModel,
      });
    } else if (stringValue(payload.encrypted_content)) {
      events.push({
        ...base,
        eventKind: 'model_activity',
        eventId: eventId('model-activity'),
        activityKind: 'reasoning',
        contentVisibility: 'opaque',
        model: state.activeModel,
      });
    }
    return familyOutcome(events);
  }

  if (record.type === 'response_item' && payloadType === 'message') {
    const role = stringValue(payload.role);
    const text = codexContentText(payload.content);
    if (
      (role === 'user' || role === 'assistant' || role === 'system' || role === 'developer')
      && text
    ) {
      const normalizedRole = role === 'developer' ? 'system' : role;
      events.push({
        ...base,
        eventKind: 'message',
        eventId: eventId('message'),
        role: normalizedRole,
        origin: normalizedRole === 'user'
          ? codexUserMessageOrigin(text)
          : normalizedRole === 'system' ? 'runtime' : 'synthetic',
        text,
        displayText: normalizedRole === 'user' ? codexUserDisplayText(text) : undefined,
        attachments: normalizedRole === 'user' ? codexUserAttachments(text) : undefined,
        model: normalizedRole === 'assistant' ? state.activeModel : undefined,
      });
    }
    return familyOutcome(events);
  }

  if (record.type === 'response_item' && payloadType === 'agent_message') {
    const text = codexContentText(payload.content);
    const passthrough = isObject(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : {};
    events.push({
      ...base,
      sourceEventId: stringValue(payload.id),
      turnId: stringValue(passthrough.turn_id) ?? state.activeTurnId,
      eventKind: 'agent_activity',
      eventId: eventId('agent-communication'),
      activityKind: 'communication',
      author: stringValue(payload.author),
      recipient: stringValue(payload.recipient),
      text: text || undefined,
    });
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'user_message') {
    const text = stringValue(payload.message);
    if (text) {
      if (duplicateEventMessageIndexes.has(sourceIndex)) return familyOutcome(events);
      events.push({
        ...base,
        eventKind: 'message',
        eventId: eventId('message'),
        role: 'user',
        origin: codexUserMessageOrigin(text),
        text,
        displayText: codexUserDisplayText(text),
        attachments: codexUserAttachments(text),
      });
    }
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'agent_message') {
    const text = stringValue(payload.message);
    if (text) {
      if (duplicateEventMessageIndexes.has(sourceIndex)) return familyOutcome(events);
      events.push({
        ...base,
        eventKind: 'message',
        eventId: eventId('message'),
        role: 'assistant',
        origin: 'synthetic',
        text,
        model: state.activeModel,
      });
    }
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'agent_reasoning') {
    if (duplicateAgentReasoningIndexes.has(sourceIndex)) return familyOutcome(events);
    const text = codexPlaintext(payload.text);
    if (text) {
      events.push({
        ...base,
        eventKind: 'model_activity',
        eventId: eventId('model-activity'),
        activityKind: 'reasoning',
        contentVisibility: 'plaintext',
        text,
        contentSource: 'text',
        model: state.activeModel,
      });
    }
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'sub_agent_activity') {
    events.push({
      ...base,
      sourceEventId: stringValue(payload.event_id),
      eventKind: 'agent_activity',
      eventId: eventId('agent-status'),
      activityKind: 'status',
      agentId: stringValue(payload.agent_thread_id),
      agentPath: stringValue(payload.agent_path),
      activity: stringValue(payload.kind),
    });
    return familyOutcome(events);
  }

  return { disposition: 'pass' };
}
