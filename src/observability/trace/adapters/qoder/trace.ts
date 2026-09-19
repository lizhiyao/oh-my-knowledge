/** Qoder CLI session JSONL -> source-neutral Trace IR. */

import { basename, dirname } from 'node:path';
import type {
  TraceEvent,
  TraceMessageOrigin,
  TraceSession,
  TraceUsageEvent,
} from '../../trace-ir.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  normalizeTraceTimestamp,
  traceTimestampBounds,
  unknownTraceEvent,
} from '../../trace-ir.js';
import type { TraceSourceMetadata } from '../../../contracts/trace.js';
import { normalizeToolIdentity } from '../../../../executors/core/tool-identity.js';
import { nonNegativeMetric, tokenCount } from '../../../../executors/core/token-usage.js';
import { isToolResultFailureText } from '../../../../executors/tool-call-status.js';
import { isClaudeBuiltinCommand, stripCommandEnvelopeText } from '../../attribution.js';
import {
  isRuntimeProtocolPromptText,
  isSyntheticUserMessageText,
} from '../../message-classification.js';

/**
 * Qoder CLI keeps Claude-Code-family transcripts: the same `user` / `assistant`
 * records with `sessionId`, `uuid`, `parentUuid` and an Anthropic-shaped
 * `message`. It therefore shares a record vocabulary with Claude Code, and the
 * only reliable way to tell the two products apart is the Qoder-specific
 * bookkeeping records and transcript fields below. Both signals were verified
 * against real transcripts on disk: genuine Claude Code files carry neither.
 */
interface QoderRecord {
  type?: unknown;
  sessionId?: unknown;
  [key: string]: unknown;
}

/** Record types only Qoder writes. They are session bookkeeping, not evidence. */
const QODER_BOOKKEEPING_RECORD_TYPES = new Set([
  'workspace-directories',
  'runtime-config',
  'active-leaf',
]);

/**
 * Known session-metadata record types: the Claude-family transcript vocabulary
 * plus Qoder's own title bookkeeping. They are never surfaced as `unknown`
 * noise events.
 */
const QODER_KNOWN_METADATA_RECORD_TYPES = new Set([
  'assistant',
  'user',
  'attachment',
  'pr-link',
  'mode',
  'permission-mode',
  'last-prompt',
  'ai-title',
  // Written when the user renames a session; carries only `customTitle`.
  'custom-title',
  'agent-name',
  'system',
  'file-history-snapshot',
  'queue-operation',
  ...QODER_BOOKKEEPING_RECORD_TYPES,
]);

/**
 * `origin.kind` is the transcript's own claim about who produced a user record.
 * Claude Code 2.1.x writes the same field, so it is only read here (never used
 * to identify the source), and the value is treated as authoritative when the
 * source reports it.
 */
const QODER_ORIGIN_KIND_TO_MESSAGE_ORIGIN: Readonly<Record<string, TraceMessageOrigin>> = {
  human: 'human',
  typed: 'human',
  prompt: 'human',
  synthetic: 'synthetic',
  summary: 'synthetic',
  compact: 'synthetic',
  'skill-context': 'skill-context',
  system: 'runtime',
  runtime: 'runtime',
  hook: 'runtime',
  'task-notification': 'runtime',
  'malformed-tool-use-retry': 'runtime',
};

/** An unrecognized `origin.kind` is still a source claim that it is not human. */
const QODER_UNRECOGNIZED_ORIGIN_KIND_MESSAGE_ORIGIN: TraceMessageOrigin = 'runtime';

/**
 * 格式判定的最小单位：单条记录是否构成 Qoder 格式的证据。「文件里是否存在这样一条记录」
 * 由 `source.ts` 的单遍扫描合成——判定不再每个格式各自把整档重解析一遍。
 */
export function qoderFormatEvidence(value: unknown): boolean {
  const record = asQoderRecord(value);
  if (!record) return false;
  if (typeof record.type === 'string' && QODER_BOOKKEEPING_RECORD_TYPES.has(record.type)) {
    return true;
  }
  if (record.type !== 'user' && record.type !== 'assistant') return false;
  if (typeof record.sessionId !== 'string') return false;
  // Qoder-only transcript fields. `humanInput` is the echoed prompt the CLI
  // attached to a user turn, and `requestSetId` groups one request's records;
  // neither exists in Claude Code output.
  return typeof record.requestSetId === 'string' || isObject(record.humanInput);
}

export function parseQoderSessionFile(filePath: string, rawRecords: unknown[]): TraceSession {
  const records = rawRecords.map(asQoderRecord);
  const identity = resolveQoderIdentity(filePath, records);
  const firstMessageRecord = records.find((record) => record?.type === 'user' || record?.type === 'assistant');
  const events = correlateTraceToolEvents(records.flatMap((record, sourceIndex) =>
    record ? qoderRecordToTraceEvents(record, identity.runId, sourceIndex) : [],
  ));
  const bounds = traceTimestampBounds([
    ...events.map((event) => event.timestamp),
    normalizeTraceTimestamp(firstMessageRecord?.timestamp),
  ]);
  return {
    runId: identity.runId,
    rootRunId: identity.rootRunId,
    parentRunId: identity.parentRunId,
    traceId: createTraceId({ sourceKind: 'qoder', runId: identity.runId, sourcePath: filePath }),
    groupPath: dirname(filePath),
    role: identity.role,
    label: basename(filePath),
    sourcePath: filePath,
    sourceKind: 'qoder',
    events,
    cwd: firstStringValue(records, 'cwd'),
    gitBranch: firstStringValue(records, 'gitBranch'),
    entrypoint: firstStringValue(records, 'entrypoint'),
    sourceMetadata: qoderSourceMetadata(records),
    ...bounds,
  };
}

/**
 * Qoder repeats `cwd` / `gitBranch` / `entrypoint` on its transcript records but
 * not on the leading bookkeeping ones, so each session field is taken from the
 * first record that actually carries it.
 */
function firstStringValue(
  records: Array<QoderRecord | undefined>,
  key: keyof QoderRecord & string,
): string | undefined {
  for (const record of records) {
    const value = stringValue(record?.[key]);
    if (value) return value;
  }
  return undefined;
}

interface QoderIdentity {
  runId: string;
  rootRunId: string;
  parentRunId?: string;
  role: 'standalone' | 'subagent';
}

/**
 * A Qoder subagent transcript is written under `<session>/subagents/…` but keeps
 * the parent `sessionId` on every record and tags itself with `isSidechain` plus
 * a per-invocation `agentId`. Using the parent id as the run id would collapse a
 * main session and its subagents onto one identity and lose the linkage, so the
 * sidechain run keeps its own agent identity and points at the parent session.
 */
function resolveQoderIdentity(filePath: string, records: Array<QoderRecord | undefined>): QoderIdentity {
  const fallback = basename(filePath, '.jsonl');
  const messageRecords = records.filter((record) => record?.type === 'user' || record?.type === 'assistant');
  const sessionId = stringValue(records.find((record) => typeof record?.sessionId === 'string')?.sessionId)
    ?? fallback;
  const sidechainRecords = messageRecords.filter((record) => record?.isSidechain === true);
  if (messageRecords.length > 0 && sidechainRecords.length === messageRecords.length) {
    const agentIds = Array.from(new Set(sidechainRecords
      .map((record) => stringValue(record?.agentId))
      .filter((agentId): agentId is string => agentId !== undefined)));
    if (agentIds.length === 1) {
      return { runId: agentIds[0], rootRunId: sessionId, parentRunId: sessionId, role: 'subagent' };
    }
    return { runId: `${sessionId}:${basename(filePath, '.jsonl')}`, rootRunId: sessionId, parentRunId: sessionId, role: 'subagent' };
  }
  return { runId: sessionId, rootRunId: sessionId, role: 'standalone' };
}

function qoderSourceMetadata(records: Array<QoderRecord | undefined>): TraceSourceMetadata {
  const models = Array.from(new Set(records.flatMap((record) => {
    if (record?.type !== 'runtime-config') return [];
    const model = stringValue(record.model);
    return model ? [model] : [];
  })));
  return models.length > 0 ? { model: models.join(', ') } : {};
}

function qoderRecordToTraceEvents(
  raw: QoderRecord,
  runId: string,
  sourceIndex: number,
): TraceEvent[] {
  const sourceType = typeof raw.type === 'string' ? raw.type : 'unknown';
  const timestamp = normalizeTraceTimestamp(raw.timestamp);
  const sourceEventId = typeof raw.uuid === 'string'
    ? raw.uuid
    : typeof raw.id === 'string'
      ? raw.id
      : undefined;
  const eventId = (suffix: string): string => `${runId}:${sourceIndex}:${suffix}`;
  const base = { sourceEventId, sourceIndex, sourceType, timestamp };

  if (raw.type === 'user' || raw.type === 'assistant') {
    const messageParts = qoderMessageParts(raw);
    if (!messageParts) {
      return [unknownTraceEvent(base, eventId('unprojectable-message-record'), raw)];
    }
    return raw.type === 'user'
      ? qoderUserRecordEvents(raw, base, eventId, messageParts)
      : qoderAssistantRecordEvents(raw, base, eventId, messageParts);
  }

  if (raw.type === 'system') {
    return qoderSystemRecordEvents(raw, base, eventId);
  }

  if (raw.type === 'attachment') {
    const sessionStart = qoderSessionStartEvent(raw, base, eventId);
    return sessionStart ? [sessionStart] : [];
  }

  const lifecycle = qoderLifecycleEvent(raw, base, eventId, sourceType);
  if (lifecycle) return [lifecycle];
  if (isKnownQoderMetadataRecordType(sourceType)) return [];
  return [unknownTraceEvent(base, eventId('unknown'), raw)];
}

/**
 * Normalize the Anthropic-shaped payload of a `user` / `assistant` record.
 * `undefined` means the record carries no projectable message at all, which is
 * different from a message with an empty payload: the caller has to keep the
 * raw record as evidence instead of letting a known record type vanish.
 */
function qoderMessageParts(raw: QoderRecord): unknown[] | undefined {
  const message = isObject(raw.message) ? raw.message : undefined;
  if (!message) return undefined;
  const content = message.content;
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : undefined;
}

/**
 * A SessionStart hook run is the only session-start record Qoder writes. Other
 * attachment subtypes (goal state, skill listing, restored files, hook output
 * for later events) stay metadata-only, matching how the Claude Code path
 * treats its attachments.
 */
function qoderSessionStartEvent(
  raw: QoderRecord,
  base: EventBase,
  eventId: (suffix: string) => string,
): TraceEvent | undefined {
  const attachment = isObject(raw.attachment) ? raw.attachment : undefined;
  if (attachment?.type !== 'hook_output') return undefined;
  if (stringValue(attachment.hookEventName) !== 'SessionStart') return undefined;
  return {
    ...base,
    eventKind: 'lifecycle',
    eventId: eventId('session-started'),
    phase: 'session_started',
  };
}

function qoderUserRecordEvents(
  raw: QoderRecord,
  base: EventBase,
  eventId: (suffix: string) => string,
  parts: unknown[],
): TraceEvent[] {
  const events: TraceEvent[] = [];
  parts.forEach((part, partIndex) => {
    if (!isObject(part)) return;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      const text = stripQoderBuiltinCommandEnvelope(part.text);
      if (!text) return;
      events.push({
        ...base,
        eventKind: 'message',
        eventId: eventId(`message-${partIndex}`),
        role: 'user',
        origin: qoderUserMessageOrigin(raw, text),
        text,
      });
    } else if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
      const output = typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '');
      const explicit = typeof part.is_error === 'boolean';
      const inferredFailure = !explicit && isToolResultFailureText(output);
      events.push({
        ...base,
        eventKind: 'tool_result',
        eventId: eventId(`tool-result-${partIndex}`),
        callId: part.tool_use_id,
        output,
        status: explicit
          ? part.is_error === true ? 'failure' : 'success'
          : inferredFailure ? 'failure' : 'unknown',
        statusSource: explicit ? 'runtime' : inferredFailure ? 'inferred' : 'unknown',
      });
    }
  });
  return events;
}

function qoderAssistantRecordEvents(
  raw: QoderRecord,
  base: EventBase,
  eventId: (suffix: string) => string,
  content: unknown[],
): TraceEvent[] {
  const message = isObject(raw.message) ? raw.message : undefined;
  const model = stringValue(message?.model);
  const events: TraceEvent[] = [];
  const text = content.flatMap((part) =>
    isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  ).join('\n');
  if (text) {
    events.push({
      ...base,
      eventKind: 'message',
      eventId: eventId('message'),
      role: 'assistant',
      origin: 'synthetic',
      text,
      model,
      attributionSkill: stringValue(raw.attributionSkill),
    });
  }
  content.forEach((part, partIndex) => {
    if (!isObject(part)) return;
    if (part.type === 'thinking') {
      const reasoning = typeof part.thinking === 'string' ? part.thinking.trim() : '';
      if (reasoning) {
        events.push({
          ...base,
          eventKind: 'model_activity',
          eventId: eventId(`model-activity-${partIndex}`),
          activityKind: 'reasoning',
          contentVisibility: 'plaintext',
          text: reasoning,
          contentSource: 'text',
          model,
        });
      } else if (stringValue(part.signature)) {
        // Qoder redacts some reasoning chains to an opaque signature. Keep the
        // boundary observable without inventing reasoning text.
        events.push({
          ...base,
          eventKind: 'model_activity',
          eventId: eventId(`model-activity-${partIndex}`),
          activityKind: 'reasoning',
          contentVisibility: 'opaque',
          model,
        });
      }
      return;
    }
    if (part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
      events.push({
        ...base,
        eventKind: 'tool_call',
        eventId: eventId(`tool-call-${partIndex}`),
        callId: part.id,
        tool: normalizeToolIdentity({ sourceName: part.name }),
        input: isObject(part.input) ? part.input : {},
        model,
      });
    }
  });
  const usage = isObject(message?.usage) ? message.usage : undefined;
  if (usage) {
    const usageEvent = qoderUsageEvent(
      usage,
      eventId('usage'),
      base,
      model,
    );
    events.push(usageEvent ?? unknownTraceEvent(base, eventId('invalid-usage'), raw));
  }
  const failure = qoderApiFailureEvent(raw, base, eventId);
  if (failure) events.push(failure);
  return events;
}

function qoderSystemRecordEvents(
  raw: QoderRecord,
  base: EventBase,
  eventId: (suffix: string) => string,
): TraceEvent[] {
  if (raw.subtype === 'compact_boundary') {
    return [{
      ...base,
      eventKind: 'context_compaction',
      eventId: eventId('context-compaction'),
      summary: stringValue(raw.content),
    }];
  }
  if (raw.subtype === 'turn_duration') {
    return [{
      ...base,
      eventKind: 'lifecycle',
      eventId: eventId('turn-completed'),
      phase: 'turn_completed',
      durationMs: nonNegativeMetric(raw.durationMs),
    }];
  }
  const text = stringValue(raw.content) ?? stringValue(raw.message);
  if (text) {
    return [{
      ...base,
      eventKind: 'message',
      eventId: eventId('system-message'),
      role: 'system',
      origin: 'runtime',
      text,
    }];
  }
  return [unknownTraceEvent(base, eventId('unknown-system-record'), raw)];
}

/**
 * Qoder records a failed model request as an `assistant` flag carrying the
 * user-visible fallback text plus a machine-readable error code. Reporting it as
 * a failed turn keeps the source's own classification instead of letting the
 * fallback text read as a successful answer.
 */
function qoderApiFailureEvent(
  raw: QoderRecord,
  base: EventBase,
  eventId: (suffix: string) => string,
): TraceEvent | undefined {
  if (raw.isApiErrorMessage !== true) return undefined;
  return {
    ...base,
    eventKind: 'lifecycle',
    eventId: eventId('turn-failed'),
    phase: 'turn_failed',
    reason: stringValue(raw.error) ?? stringValue(raw.displayErrorCode),
  };
}

function qoderLifecycleEvent(
  raw: QoderRecord,
  base: EventBase,
  eventId: (suffix: string) => string,
  sourceType: string,
): TraceEvent | undefined {
  const phase = /^session[._-]started$/i.test(sourceType)
    ? 'session_started'
    : /^session[._-]ended$/i.test(sourceType)
      ? 'session_ended'
      : /^turn[._-]started$/i.test(sourceType)
        ? 'turn_started'
        : /^turn[._-](?:ended|completed)$/i.test(sourceType)
          ? 'turn_completed'
          : /^turn[._-]aborted$/i.test(sourceType)
            ? 'turn_aborted'
            : /^turn[._-]interrupted$/i.test(sourceType)
              ? 'turn_interrupted'
              : null;
  if (!phase) return undefined;
  return {
    ...base,
    eventKind: 'lifecycle',
    eventId: eventId('lifecycle'),
    phase,
    turnId: stringValue(raw.turnId),
    reason: stringValue(raw.reason),
    durationMs: nonNegativeMetric(raw.durationMs),
  };
}

function qoderUsageEvent(
  usage: Record<string, unknown>,
  eventId: string,
  base: EventBase,
  model?: string,
): TraceUsageEvent | undefined {
  const { input_tokens: input, output_tokens: output } = usage;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheCreation = usage.cache_creation_input_tokens;
  if (!isUsageCounter(input) || !isUsageCounter(output)) return undefined;
  if (cacheRead !== undefined && !isUsageCounter(cacheRead)) return undefined;
  if (cacheCreation !== undefined && !isUsageCounter(cacheCreation)) return undefined;
  return {
    ...base,
    eventKind: 'usage',
    eventId,
    model,
    inputTokens: tokenCount(input),
    outputTokens: tokenCount(output),
    cacheReadTokens: tokenCount(cacheRead),
    cacheCreationTokens: tokenCount(cacheCreation),
  };
}

function qoderUserMessageOrigin(record: QoderRecord, text: string): TraceMessageOrigin {
  const origin = record.origin;
  if (isObject(origin)) {
    const kind = stringValue(origin.kind);
    if (kind) {
      return QODER_ORIGIN_KIND_TO_MESSAGE_ORIGIN[kind.toLowerCase()]
        ?? QODER_UNRECOGNIZED_ORIGIN_KIND_MESSAGE_ORIGIN;
    }
  }
  return qoderHeuristicMessageOrigin(record, text);
}

/**
 * Fallback for Qoder user records without `origin`. These are the same
 * Claude-family text heuristics `source.ts` applies to Claude transcripts; keep
 * the two in step when either changes.
 */
function qoderHeuristicMessageOrigin(record: QoderRecord, text: string): TraceMessageOrigin {
  if (record.isMeta === true && typeof record.sourceToolUseID === 'string') return 'skill-context';
  if (/^Base directory for this skill:\s+.+(?:\n| )#\s+[a-z0-9][\w.-]*/i.test(text)) return 'skill-context';
  if (isQoderRuntimeInjectedText(text)) return 'runtime';
  if (isSyntheticUserMessageText(text)) return 'synthetic';
  return 'human';
}

function isQoderRuntimeInjectedText(text: string): boolean {
  const trimmed = text.trimStart();
  return /^Conversation info \(untrusted metadata\):\s*```json/i.test(trimmed)
    || isRuntimeProtocolPromptText(trimmed)
    || /^# AGENTS\.md instructions\b/i.test(trimmed)
    || /^<(?:app-context|environment_context|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|recommended_plugins)>/i.test(trimmed);
}

function stripQoderBuiltinCommandEnvelope(text: string): string {
  const match = /<command-name>\/([^<]+)<\/command-name>/.exec(text);
  return match?.[1] && isClaudeBuiltinCommand(match[1])
    ? stripCommandEnvelopeText(text)
    : text;
}

function isKnownQoderMetadataRecordType(value: string): boolean {
  return QODER_KNOWN_METADATA_RECORD_TYPES.has(value);
}

interface EventBase {
  sourceEventId?: string;
  sourceIndex: number;
  sourceType: string;
  timestamp?: string;
}

function asQoderRecord(value: unknown): QoderRecord | undefined {
  return isObject(value) ? value as QoderRecord : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isUsageCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
