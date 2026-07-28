/** Codex rollout JSONL -> source-neutral Trace IR. */

import { basename } from 'node:path';
import { isToolResultFailureText } from './text-signals.js';
import type {
  TraceEvent,
  TraceMessageOrigin,
  TraceSession,
  TraceToolRef,
  TraceToolStatus,
} from './trace-ir.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  normalizeTraceTimestamp,
  traceTimestampBounds,
} from './trace-ir.js';
import type { TraceSourceMetadata } from '../types/index.js';
import {
  nonNegativeMetric,
  optionalTokenCount,
  splitInclusiveInputTokens,
  tokenCount,
} from '../shared/token-usage.js';
import { normalizeToolIdentity } from '../shared/tool-identity.js';
import { extractCodexExecCommands } from './codex-exec-command.js';

interface CodexRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface McpCallEnd {
  callId: string;
  occurrence: number;
  sourceIndex: number;
  sourceEventId?: string;
  sourceType: string;
  timestamp?: string;
  isError?: boolean;
  status?: string;
  tool?: string;
  server?: string;
  input?: Record<string, unknown>;
  output?: string;
  turnId?: string;
  model?: string;
}

interface McpCallEndIndex {
  ordered: McpCallEnd[];
  byOccurrence: Map<string, McpCallEnd>;
  bySourceIndex: Map<number, McpCallEnd>;
}

interface PatchApplyEnd {
  callId: string;
  occurrence: number;
  sourceIndex: number;
  sourceType: string;
  timestamp?: string;
  isError?: boolean;
  status?: string;
  output?: string;
  turnId?: string;
  model?: string;
}

interface PatchApplyEndIndex {
  ordered: PatchApplyEnd[];
  byOccurrence: Map<string, PatchApplyEnd>;
  bySourceIndex: Map<number, PatchApplyEnd>;
}

interface ExternalToolEndIndex {
  byOccurrence: Set<string>;
}

const CODEX_RESPONSE_ITEM_TYPES = new Set([
  'message',
  'reasoning',
  'tool_search_call',
  'tool_search_output',
  'web_search_call',
  'image_generation_call',
  'function_call',
  'custom_tool_call',
  'function_call_output',
  'custom_tool_call_output',
]);

const CODEX_EVENT_MESSAGE_TYPES = new Set([
  'token_count',
  'task_started',
  'task_complete',
  'turn_aborted',
  'user_message',
  'agent_message',
  'mcp_tool_call_end',
  'patch_apply_end',
  'agent_reasoning',
  'thread_settings_applied',
  'web_search_end',
  'context_compacted',
  'image_generation_end',
  'thread_goal_updated',
]);

export function isCodexJsonl(records: unknown[]): boolean {
  return records.some((record) => {
    const raw = asCodexRecord(record);
    if (!isObject(raw?.payload)) return false;
    const payloadType = stringValue(raw.payload.type);
    if (raw.type === 'session_meta') {
      return stringValue(raw.payload.id) !== undefined
        || stringValue(raw.payload.session_id) !== undefined;
    }
    if (raw.type === 'turn_context') {
      return stringValue(raw.payload.turn_id) !== undefined
        || stringValue(raw.payload.model) !== undefined;
    }
    if (raw.type === 'response_item') {
      return payloadType !== undefined && CODEX_RESPONSE_ITEM_TYPES.has(payloadType);
    }
    return raw.type === 'event_msg'
      && payloadType !== undefined
      && CODEX_EVENT_MESSAGE_TYPES.has(payloadType);
  });
}

export function isCodexGuardianRollout(records: unknown[]): boolean {
  return records.some((record) => {
    const raw = asCodexRecord(record);
    if (raw?.type !== 'session_meta') return false;
    const payload = isObject(raw.payload) ? raw.payload : {};
    const source = isObject(payload.source) ? payload.source : {};
    const subagent = source.subagent;
    return (typeof subagent === 'string' && subagent === 'guardian')
      || (isObject(subagent) && stringValue(subagent.other) === 'guardian');
  });
}

export function parseCodexSessionFile(filePath: string, rawRecords: unknown[]): TraceSession {
  const meta = rawRecords.map(asCodexRecord).find((record) => record?.type === 'session_meta');
  const metaPayload = isObject(meta?.payload) ? meta.payload : {};
  const runId = stringValue(metaPayload.id)
    ?? stringValue(metaPayload.session_id)
    ?? basename(filePath).replace(/\.jsonl$/, '');
  const parentRunId = stringValue(metaPayload.parent_thread_id);
  const subagentKind = codexSubagentKind(metaPayload);
  const cwd = stringValue(metaPayload.cwd);
  const entrypoint = codexEntrypoint(metaPayload);
  const role = parentRunId || metaPayload.thread_source === 'subagent' || subagentKind
    ? 'subagent'
    : 'main';
  const events = correlateTraceToolEvents(convertCodexRecords(rawRecords, runId));
  const bounds = traceTimestampBounds([
    ...events.map((event) => event.timestamp),
    meta?.timestamp,
    metaPayload.timestamp,
  ]);

  return {
    runId,
    rootRunId: parentRunId ?? runId,
    parentRunId,
    traceId: createTraceId({ sourceKind: 'codex', runId, sourcePath: filePath }),
    groupPath: `codex:${parentRunId ?? runId}`,
    role,
    label: role === 'subagent' ? `subagent/${runId}` : `main/${basename(filePath)}`,
    sourcePath: filePath,
    sourceKind: 'codex',
    events,
    cwd,
    gitBranch: isObject(metaPayload.git) ? stringValue(metaPayload.git.branch) : undefined,
    entrypoint,
    sourceMetadata: codexSourceMetadata(rawRecords, metaPayload),
    ...bounds,
  };
}

function convertCodexRecords(rawRecords: unknown[], runId: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  const mcpEnds = indexMcpCallEnds(rawRecords);
  const patchEnds = indexPatchApplyEnds(rawRecords);
  const externalEnds = indexExternalToolEnds(rawRecords);
  const callOccurrences = new Map<string, number>();
  const resultOccurrences = new Map<string, number>();
  const externalCallOccurrences = new Map<string, number>();
  const externalResultOccurrences = new Map<string, number>();
  const representedMcpCalls = new Set<string>();
  const representedMcpResults = new Set<string>();
  const representedPatchCalls = new Set<string>();
  const representedPatchResults = new Set<string>();
  const duplicateEventMessageIndexes = indexDuplicateEventMessages(rawRecords);
  let activeModel: string | undefined;
  let activeTurnId: string | undefined;
  let previousTotalUsageFingerprint: string | undefined;

  rawRecords.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    if (!record) return;
    const timestamp = normalizeTraceTimestamp(record.timestamp);
    const payload = isObject(record.payload) ? record.payload : {};
    const payloadType = stringValue(payload.type);
    const eventId = (suffix: string): string => `${runId}:${sourceIndex}:${suffix}`;
    const base = {
      sourceEventId: stringValue(payload.id),
      sourceIndex,
      sourceType: `${String(record.type ?? 'unknown')}:${payloadType ?? ''}`,
      timestamp,
      turnId: activeTurnId,
    };

    // Desktop may repeat session_meta during a long rollout. Metadata is read
    // once above and is transparent to the event stream; retaining later copies
    // as unknown events also breaks otherwise adjacent mirrored-message pairs.
    if (record.type === 'session_meta') return;

    if (record.type === 'turn_context') {
      activeModel = stringValue(payload.model) ?? activeModel;
      activeTurnId = stringValue(payload.turn_id) ?? activeTurnId;
      return;
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
          model: normalizedRole === 'assistant' ? activeModel : undefined,
        });
      }
      return;
    }

    if (record.type === 'response_item' && payloadType === 'tool_search_call') {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `codex-tool-search-${sourceIndex}`;
      events.push(toolCallEvent(
        eventId('tool-call'),
        base,
        callId,
        normalizeToolIdentity({ sourceName: 'tool_search' }),
        parseToolInput(payload.arguments),
        activeModel,
      ));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'tool_search_output') {
      const callId = stringValue(payload.call_id) ?? `codex-tool-search-${sourceIndex}`;
      const output = JSON.stringify({
        status: stringValue(payload.status),
        execution: stringValue(payload.execution),
        tools: summarizeDiscoveredTools(payload.tools),
      });
      events.push(toolResultEvent(
        eventId('tool-result'),
        base,
        callId,
        output,
        statusFromCodex(payload.status),
        stringValue(payload.status) ? 'runtime' : 'unknown',
      ));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'web_search_call') {
      const callId = stringValue(payload.id) ?? `codex-web-search-${sourceIndex}`;
      takeOccurrence(externalCallOccurrences, callId);
      const resultOccurrence = takeOccurrence(externalResultOccurrences, callId);
      const completed = externalEnds.byOccurrence.has(
        mcpCallOccurrenceKey(callId, resultOccurrence),
      );
      const payloadStatus = stringValue(payload.status);
      const explicitStatus = statusFromCodex(payloadStatus);
      events.push(toolCallEvent(
        eventId('tool-call'),
        base,
        callId,
        normalizeToolIdentity({ sourceName: 'web_search' }),
        isObject(payload.action) ? payload.action : {},
        activeModel,
      ));
      events.push(toolResultEvent(
        eventId('tool-result'),
        base,
        callId,
        JSON.stringify({ status: stringValue(payload.status) }),
        explicitStatus !== 'unknown' ? explicitStatus : completed ? 'success' : 'unknown',
        explicitStatus !== 'unknown' ? 'runtime' : completed ? 'inferred' : 'unknown',
      ));
      return;
    }

    if (record.type === 'response_item' && payloadType === 'image_generation_call') {
      const callId = stringValue(payload.id) ?? `codex-image-generation-${sourceIndex}`;
      const result = typeof payload.result === 'string' ? payload.result : '';
      takeOccurrence(externalCallOccurrences, callId);
      const resultOccurrence = takeOccurrence(externalResultOccurrences, callId);
      const completed = externalEnds.byOccurrence.has(
        mcpCallOccurrenceKey(callId, resultOccurrence),
      );
      const payloadStatus = stringValue(payload.status);
      const explicitStatus = statusFromCodex(payloadStatus);
      const inferredSuccess = result.length > 0 || completed;
      events.push(toolCallEvent(
        eventId('tool-call'),
        base,
        callId,
        normalizeToolIdentity({ sourceName: 'image_generation' }),
        { prompt: stringValue(payload.revised_prompt) },
        activeModel,
      ));
      events.push(toolResultEvent(
        eventId('tool-result'),
        base,
        callId,
        JSON.stringify({ status: stringValue(payload.status), resultBytes: result.length }),
        explicitStatus !== 'unknown' ? explicitStatus : inferredSuccess ? 'success' : 'unknown',
        explicitStatus !== 'unknown' ? 'runtime' : inferredSuccess ? 'inferred' : 'unknown',
      ));
      return;
    }

    if (
      record.type === 'response_item'
      && (payloadType === 'function_call' || payloadType === 'custom_tool_call')
    ) {
      const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `codex-call-${sourceIndex}`;
      const occurrence = takeOccurrence(callOccurrences, callId);
      takeOccurrence(externalCallOccurrences, callId);
      const mcpEndKey = mcpCallOccurrenceKey(callId, occurrence);
      const mcpEnd = mcpEnds.byOccurrence.get(mcpEndKey);
      if (mcpEnd) representedMcpCalls.add(mcpEndKey);
      const sourceName = stringValue(payload.name) ?? 'unknown';
      const patchEnd = sourceName.toLowerCase() === 'apply_patch'
        ? patchEnds.byOccurrence.get(mcpEndKey)
        : undefined;
      if (patchEnd) representedPatchCalls.add(mcpEndKey);
      const normalized = normalizeCodexTool(
        sourceName,
        payload.arguments ?? payload.input,
        mcpEnd,
        stringValue(payload.namespace),
      );
      events.push(toolCallEvent(eventId('tool-call'), base, callId, normalized.tool, normalized.input, activeModel));
      return;
    }

    if (
      record.type === 'response_item'
      && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')
    ) {
      const callId = stringValue(payload.call_id) ?? `codex-call-${sourceIndex}`;
      const occurrence = takeOccurrence(resultOccurrences, callId);
      const externalOccurrence = takeOccurrence(externalResultOccurrences, callId);
      const mcpEndKey = mcpCallOccurrenceKey(callId, occurrence);
      const mcpEnd = mcpEnds.byOccurrence.get(mcpEndKey);
      if (mcpEnd) representedMcpResults.add(mcpEndKey);
      const patchEnd = patchEnds.byOccurrence.get(mcpEndKey);
      if (patchEnd) representedPatchResults.add(mcpEndKey);
      const output = codexContentText(payload.output) || mcpEnd?.output || patchEnd?.output || '';
      const runtimeOutcome = runtimeToolEndOutcome(mcpEnd ?? patchEnd);
      const payloadStatus = stringValue(payload.status);
      const hasRuntimeStatus = runtimeOutcome.present || payloadStatus !== undefined;
      const explicitStatus = runtimeOutcome.present
        ? runtimeOutcome.status
        : statusFromCodex(payloadStatus);
      const bridgeFailure = codexToolOutputFailed(output);
      const bridgeSuccess = !bridgeFailure && codexToolOutputSucceeded(output);
      const inferredFailure = bridgeFailure || (!bridgeSuccess && isToolResultFailureText(output));
      const inferredSuccess = bridgeSuccess;
      const completedExternalCall = externalEnds.byOccurrence.has(
        mcpCallOccurrenceKey(callId, externalOccurrence),
      );
      const inferredStatus = inferredFailure
        ? 'failure'
        : inferredSuccess || completedExternalCall ? 'success' : 'unknown';
      events.push(toolResultEvent(
        eventId('tool-result'),
        base,
        callId,
        output,
        hasRuntimeStatus ? explicitStatus : inferredStatus,
        hasRuntimeStatus
          ? 'runtime'
          : inferredStatus === 'unknown' ? 'unknown' : 'inferred',
      ));
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'token_count') {
      const info = isObject(payload.info) ? payload.info : {};
      const usage = isObject(info.last_token_usage) ? info.last_token_usage : undefined;
      if (!isValidCodexTokenUsage(usage)) {
        events.push({
          ...base,
          eventKind: 'unknown',
          eventId: eventId('invalid-usage'),
          raw: value,
        });
        return;
      }
      const totalUsage = isObject(info.total_token_usage) ? info.total_token_usage : undefined;
      const fingerprint = tokenUsageFingerprint(totalUsage);
      if (totalUsage && !fingerprint) {
        events.push({
          ...base,
          eventKind: 'unknown',
          eventId: eventId('invalid-total-usage'),
          raw: value,
        });
      }
      if (fingerprint && fingerprint === previousTotalUsageFingerprint) return;
      const normalized = normalizeCodexTokenUsage(usage);
      previousTotalUsageFingerprint = fingerprint;
      events.push({
        ...base,
        eventKind: 'usage',
        eventId: eventId('usage'),
        model: activeModel,
        ...normalized,
      });
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'task_started') {
      activeTurnId = stringValue(payload.turn_id) ?? activeTurnId;
      events.push({
        ...base,
        turnId: activeTurnId,
        eventKind: 'lifecycle',
        eventId: eventId('lifecycle'),
        phase: 'turn_started',
      });
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'task_complete') {
      events.push({
        ...base,
        eventKind: 'lifecycle',
        eventId: eventId('lifecycle'),
        phase: 'turn_completed',
      });
      activeTurnId = undefined;
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'turn_aborted') {
      events.push({
        ...base,
        turnId: stringValue(payload.turn_id) ?? activeTurnId,
        eventKind: 'lifecycle',
        eventId: eventId('lifecycle'),
        phase: 'turn_aborted',
        reason: stringValue(payload.reason),
        durationMs: nonNegativeMetric(payload.duration_ms),
      });
      activeTurnId = undefined;
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'user_message') {
      const text = stringValue(payload.message);
      if (text) {
        if (duplicateEventMessageIndexes.has(sourceIndex)) return;
        events.push({
          ...base,
          eventKind: 'message',
          eventId: eventId('message'),
          role: 'user',
          origin: codexUserMessageOrigin(text),
          text,
        });
      }
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'agent_message') {
      const text = stringValue(payload.message);
      if (text) {
        if (duplicateEventMessageIndexes.has(sourceIndex)) return;
        events.push({
          ...base,
          eventKind: 'message',
          eventId: eventId('message'),
          role: 'assistant',
          origin: 'synthetic',
          text,
          model: activeModel,
        });
      }
      return;
    }

    if (payloadType === 'mcp_tool_call_end') {
      const end = mcpEnds.bySourceIndex.get(sourceIndex);
      if (end) {
        end.turnId = activeTurnId;
        end.model = activeModel;
      }
      return;
    }
    if (payloadType === 'patch_apply_end') {
      const end = patchEnds.bySourceIndex.get(sourceIndex);
      if (end) {
        end.turnId = activeTurnId;
        end.model = activeModel;
      }
      return;
    }
    if (isKnownNonMeasurementCodexRecord(record.type, payloadType)) return;
    events.push({
      ...base,
      eventKind: 'unknown',
      eventId: eventId('unknown'),
      raw: value,
    });
  });

  for (const end of mcpEnds.ordered) {
    const endKey = mcpCallOccurrenceKey(end.callId, end.occurrence);
    const outcome = runtimeToolEndOutcome(end);
    if (!representedMcpCalls.has(endKey)) {
      events.push({
        eventKind: 'tool_call',
        eventId: `${runId}:${end.sourceIndex}:mcp-tool-call`,
        sourceEventId: end.sourceEventId,
        sourceIndex: end.sourceIndex,
        sourceType: end.sourceType,
        timestamp: end.timestamp,
        turnId: end.turnId,
        callId: end.callId,
        tool: mcpToolRefFromEnd(end),
        input: end.input ?? {},
        model: end.model,
      });
    }
    if (representedMcpResults.has(endKey)) continue;
    events.push({
      eventKind: 'tool_result',
      eventId: `${runId}:${end.sourceIndex}:mcp-tool-result`,
      sourceEventId: end.sourceEventId,
      sourceIndex: end.sourceIndex,
      sourceType: end.sourceType,
      timestamp: end.timestamp,
      turnId: end.turnId,
      callId: end.callId,
      output: end.output ?? '',
      status: outcome.status,
      statusSource: outcome.present ? 'runtime' : 'unknown',
    });
  }

  for (const end of patchEnds.ordered) {
    const endKey = mcpCallOccurrenceKey(end.callId, end.occurrence);
    const outcome = runtimeToolEndOutcome(end);
    if (!representedPatchCalls.has(endKey)) {
      events.push({
        eventKind: 'tool_call',
        eventId: `${runId}:${end.sourceIndex}:patch-tool-call`,
        sourceIndex: end.sourceIndex,
        sourceType: end.sourceType,
        timestamp: end.timestamp,
        turnId: end.turnId,
        callId: end.callId,
        tool: { name: 'Edit', sourceName: 'apply_patch' },
        input: {},
        model: end.model,
      });
    }
    if (representedPatchResults.has(endKey)) continue;
    events.push({
      eventKind: 'tool_result',
      eventId: `${runId}:${end.sourceIndex}:patch-tool-result`,
      sourceIndex: end.sourceIndex,
      sourceType: end.sourceType,
      timestamp: end.timestamp,
      turnId: end.turnId,
      callId: end.callId,
      output: end.output ?? '',
      status: outcome.status,
      statusSource: outcome.present ? 'runtime' : 'unknown',
    });
  }

  events.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return events;
}

/**
 * Codex persists protocol and UI state alongside behavioral evidence. These
 * records are understood by this adapter but intentionally do not become Trace
 * IR events. Keeping them out of `unknown` means ingestion warnings remain a
 * forward-compatibility signal instead of firing on every normal rollout.
 */
function isKnownNonMeasurementCodexRecord(
  recordType: unknown,
  payloadType: string | undefined,
): boolean {
  if (recordType === 'compacted' || recordType === 'world_state') return true;
  if (recordType === 'response_item' && payloadType === 'reasoning') return true;
  if (recordType !== 'event_msg') return false;
  return payloadType === 'agent_reasoning'
    || payloadType === 'thread_settings_applied'
    || payloadType === 'web_search_end'
    || payloadType === 'context_compacted'
    || payloadType === 'image_generation_end'
    || payloadType === 'thread_goal_updated';
}

function mcpToolRefFromEnd(end: McpCallEnd): TraceToolRef {
  return normalizeToolIdentity({
    sourceName: 'mcp_tool_call',
    provider: end.server,
    authoritativeName: end.tool ?? 'unknown',
  });
}

function toolCallEvent(
  eventId: string,
  base: Omit<TraceEventBase, 'eventId'>,
  callId: string,
  tool: TraceToolRef,
  input: Record<string, unknown>,
  model?: string,
): TraceEvent {
  return { ...base, eventKind: 'tool_call', eventId, callId, tool, input, model };
}

function toolResultEvent(
  eventId: string,
  base: Omit<TraceEventBase, 'eventId'>,
  callId: string,
  output: string,
  status: TraceToolStatus,
  statusSource: 'runtime' | 'inferred' | 'unknown',
): TraceEvent {
  return { ...base, eventKind: 'tool_result', eventId, callId, output, status, statusSource };
}

interface TraceEventBase {
  sourceEventId?: string;
  sourceIndex: number;
  sourceType: string;
  timestamp?: string;
  turnId?: string;
  eventId: string;
}

function indexMcpCallEnds(records: unknown[]): McpCallEndIndex {
  const ordered: McpCallEnd[] = [];
  const byOccurrence = new Map<string, McpCallEnd>();
  const bySourceIndex = new Map<number, McpCallEnd>();
  const occurrences = new Map<string, number>();
  records.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    const payload = isObject(record?.payload) ? record.payload : {};
    if (payload.type !== 'mcp_tool_call_end') return;
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
    if (!callId) return;
    const occurrence = takeOccurrence(occurrences, callId);
    const invocation = isObject(payload.invocation) ? payload.invocation : {};
    const result = isObject(payload.result) ? payload.result : {};
    const hasOk = Object.prototype.hasOwnProperty.call(result, 'Ok');
    const ok = isObject(result.Ok) ? result.Ok : undefined;
    const hasErr = Object.prototype.hasOwnProperty.call(result, 'Err');
    const err = hasErr ? result.Err : undefined;
    const end: McpCallEnd = {
      callId,
      occurrence,
      sourceIndex,
      sourceEventId: stringValue(payload.id),
      sourceType: `${String(record?.type ?? 'unknown')}:${String(payload.type)}`,
      timestamp: normalizeTraceTimestamp(record?.timestamp),
      isError: booleanValue(payload.isError)
        ?? booleanValue(payload.is_error)
        ?? booleanValue(result.isError)
        ?? booleanValue(result.is_error)
        ?? booleanValue(ok?.isError)
        ?? booleanValue(ok?.is_error)
        ?? (hasErr ? true : hasOk ? false : undefined),
      status: stringValue(payload.status) ?? stringValue(result.status) ?? stringValue(ok?.status),
      tool: stringValue(invocation.tool) ?? stringValue(payload.tool),
      server: stringValue(invocation.server) ?? stringValue(invocation.provider) ?? stringValue(payload.server),
      input: parseToolInput(invocation.arguments ?? invocation.input ?? payload.arguments ?? payload.input),
      output: codexContentText(
        payload.output
        ?? result.output
        ?? result.content
        ?? ok?.content
        ?? ok?.structuredContent
        ?? err,
      ),
    };
    ordered.push(end);
    byOccurrence.set(mcpCallOccurrenceKey(callId, occurrence), end);
    bySourceIndex.set(sourceIndex, end);
  });
  return { ordered, byOccurrence, bySourceIndex };
}

function indexPatchApplyEnds(records: unknown[]): PatchApplyEndIndex {
  const ordered: PatchApplyEnd[] = [];
  const byOccurrence = new Map<string, PatchApplyEnd>();
  const bySourceIndex = new Map<number, PatchApplyEnd>();
  const occurrences = new Map<string, number>();
  records.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    const payload = isObject(record?.payload) ? record.payload : {};
    if (payload.type !== 'patch_apply_end') return;
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
    if (!callId) return;
    const occurrence = takeOccurrence(occurrences, callId);
    const success = booleanValue(payload.success);
    const end: PatchApplyEnd = {
      callId,
      occurrence,
      sourceIndex,
      sourceType: `${String(record?.type ?? 'unknown')}:${String(payload.type)}`,
      timestamp: normalizeTraceTimestamp(record?.timestamp),
      isError: success === undefined ? undefined : !success,
      status: stringValue(payload.status),
      output: [stringValue(payload.stdout), stringValue(payload.stderr)].filter(Boolean).join('\n'),
    };
    ordered.push(end);
    byOccurrence.set(mcpCallOccurrenceKey(callId, occurrence), end);
    bySourceIndex.set(sourceIndex, end);
  });
  return { ordered, byOccurrence, bySourceIndex };
}

function indexExternalToolEnds(records: unknown[]): ExternalToolEndIndex {
  const byOccurrence = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const value of records) {
    const record = asCodexRecord(value);
    const payload = isObject(record?.payload) ? record.payload : {};
    if (payload.type !== 'web_search_end' && payload.type !== 'image_generation_end') continue;
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id);
    if (!callId) continue;
    byOccurrence.add(mcpCallOccurrenceKey(callId, takeOccurrence(occurrences, callId)));
  }
  return { byOccurrence };
}

function takeOccurrence(counts: Map<string, number>, callId: string): number {
  const occurrence = counts.get(callId) ?? 0;
  counts.set(callId, occurrence + 1);
  return occurrence;
}

function mcpCallOccurrenceKey(callId: string, occurrence: number): string {
  return `${callId}\u0000${occurrence}`;
}

function runtimeToolEndOutcome(
  end: Pick<McpCallEnd, 'status' | 'isError'> | undefined,
): {
  status: TraceToolStatus;
  present: boolean;
} {
  if (!end) return { status: 'unknown', present: false };
  if (end.status !== undefined) {
    const status = statusFromCodex(end.status);
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

function normalizeCodexTool(
  sourceName: string,
  rawInput: unknown,
  mcpEnd?: McpCallEnd,
  sourceNamespace?: string,
): { tool: TraceToolRef; input: Record<string, unknown> } {
  const input = parseToolInput(rawInput);
  const sourceInput = stringValue(input.input);
  const execCommands = sourceName.toLowerCase() === 'exec' && sourceInput
    ? extractCodexExecCommands(sourceInput)
    : [];
  // Codex desktop's orchestration wrapper names its JavaScript command bridge
  // `exec`. This mapping is source-specific: a generic tool named `exec` must not
  // become shell execution outside the Codex adapter.
  const identitySourceName = sourceName.toLowerCase() === 'exec'
    ? 'command_execution'
    : sourceName;
  const normalizedTool = normalizeToolIdentity({
    sourceName: identitySourceName,
    namespace: sourceNamespace,
    provider: mcpEnd?.server,
    authoritativeName: mcpEnd?.tool,
  });
  const tool = identitySourceName === sourceName
    ? normalizedTool
    : { ...normalizedTool, sourceName };
  if (tool.name === 'Bash') {
    return {
      tool,
      input: {
        ...input,
        command: execCommands.length > 0
          ? execCommands.join('\n')
          : stringValue(input.command)
            ?? stringValue(input.cmd)
            ?? sourceInput
            ?? '',
        ...(execCommands.length > 0 ? { commands: execCommands } : {}),
      },
    };
  }
  if (tool.name === 'ViewImage') {
    return {
      tool,
      input: { ...input, file_path: stringValue(input.file_path) ?? stringValue(input.path) },
    };
  }
  return { tool, input };
}

function codexUserMessageOrigin(text: string): TraceMessageOrigin {
  const trimmed = text.trimStart();
  if (/^# AGENTS\.md instructions\b/i.test(trimmed)) return 'runtime';
  if (/^<(?:app-context|environment_context|permissions instructions|collaboration_mode|apps_instructions|plugins_instructions|skills_instructions|recommended_plugins)>/i.test(trimmed)) return 'runtime';
  return 'human';
}

function summarizeDiscoveredTools(value: unknown): Array<{ type?: string; name?: string; tools?: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const nested = Array.isArray(entry.tools)
      ? entry.tools.flatMap((tool) => isObject(tool) && stringValue(tool.name) ? [stringValue(tool.name)!] : [])
      : undefined;
    return [{
      type: stringValue(entry.type),
      name: stringValue(entry.name),
      ...(nested && nested.length > 0 ? { tools: nested } : {}),
    }];
  });
}

function statusFromCodex(value: unknown): TraceToolStatus {
  const status = stringValue(value)?.toLowerCase();
  if (status === 'failed' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'success' || status === 'succeeded' || status === 'completed' || status === 'complete') return 'success';
  return 'unknown';
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : { input: value };
  } catch {
    return { input: value };
  }
}

function codexContentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!isObject(part)) return '';
    const text = stringValue(part.text) ?? stringValue(part.output_text);
    if (text) return text;
    return part.type === 'input_image' ? '[image]' : '';
  }).filter(Boolean).join('\n');
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

function codexSourceMetadata(records: unknown[], metaPayload: Record<string, unknown>): TraceSourceMetadata {
  const models = Array.from(new Set(records.flatMap((value) => {
    const record = asCodexRecord(value);
    if (record?.type !== 'turn_context') return [];
    const payload = isObject(record.payload) ? record.payload : {};
    const model = stringValue(payload.model);
    return model ? [model] : [];
  })));
  return {
    provider: stringValue(metaPayload.model_provider) ?? 'openai',
    model: models.length > 0 ? models.join(', ') : undefined,
    modelApi: 'codex',
  };
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

function codexEntrypoint(metaPayload: Record<string, unknown>): string | undefined {
  const originator = stringValue(metaPayload.originator)?.toLowerCase().trim() ?? '';
  if (!originator) return undefined;
  if (originator.includes('desktop')) return 'codex-desktop';
  if (originator.includes('vscode')) return 'codex-vscode';
  if (originator.includes('sdk')) return 'codex-sdk';
  if (originator === 'claudian') return 'claudian';
  if (/(?:^|[-_ ])(?:cli|tui|exec)(?:$|[-_ ])/.test(originator)) return 'codex-cli';
  const normalized = originator.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized ? `codex-${normalized}` : undefined;
}

function codexSubagentKind(metaPayload: Record<string, unknown>): string | undefined {
  const source = isObject(metaPayload.source) ? metaPayload.source : {};
  const subagent = source.subagent;
  if (typeof subagent === 'string') return stringValue(subagent);
  return isObject(subagent) ? stringValue(subagent.other) : undefined;
}

function indexDuplicateEventMessages(records: unknown[]): Set<number> {
  const duplicateIndexes = new Set<number>();
  records.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    if (record?.type !== 'event_msg') return;
    const payload = isObject(record.payload) ? record.payload : {};
    const payloadType = stringValue(payload.type);
    const role = payloadType === 'user_message'
      ? 'user'
      : payloadType === 'agent_message' ? 'assistant' : undefined;
    const text = stringValue(payload.message);
    if (!role || !text) return;
    const nearbyRecords = [-1, 1].flatMap((direction) => {
      let candidateIndex = sourceIndex + direction;
      while (candidateIndex >= 0 && candidateIndex < records.length) {
        const candidate = asCodexRecord(records[candidateIndex]);
        if (candidate?.type !== 'session_meta') return [records[candidateIndex]];
        candidateIndex += direction;
      }
      return [];
    });
    const mirrored = nearbyRecords.some((candidate) => {
      const adjacent = asCodexRecord(candidate);
      if (adjacent?.type !== 'response_item') return false;
      const adjacentPayload = isObject(adjacent.payload) ? adjacent.payload : {};
      return adjacentPayload.type === 'message'
        && adjacentPayload.role === role
        && codexContentText(adjacentPayload.content) === text;
    });
    if (mirrored) duplicateIndexes.add(sourceIndex);
  });
  return duplicateIndexes;
}

function asCodexRecord(value: unknown): CodexRecord | undefined {
  return isObject(value) ? value as CodexRecord : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
