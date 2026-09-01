/** Codex rollout JSONL -> source-neutral Trace IR. */

import { basename } from 'node:path';
import type {
  TraceEvent,
  TraceSession,
  TraceToolRef,
  TraceToolStatus,
} from '../../trace-ir.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  normalizeTraceTimestamp,
  traceTimestampBounds,
} from '../../trace-ir.js';
import type { TraceSourceMetadata } from '../../../contracts/trace.js';
import {
  nonNegativeMetric,
  optionalTokenCount,
  splitInclusiveInputTokens,
  tokenCount,
} from '../../../../shared/token-usage.js';
import { normalizeToolIdentity } from '../../../../shared/tool-identity.js';
import { extractCodexExecCommands } from './exec-command.js';
import {
  codexUserAttachments,
  codexUserDisplayText,
  codexUserMessageOrigin,
  isCodexEventMessageType,
  isCodexRecordConsumedWithoutDirectEvent,
  isCodexResponseItemType,
} from './protocol.js';
import {
  codexRuntimeToolOutcome,
  codexToolOutputOutcome,
  codexToolStatusFromValue,
} from './tool-status.js';

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
      return isCodexResponseItemType(payloadType);
    }
    return raw.type === 'event_msg'
      && isCodexEventMessageType(payloadType);
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
  const duplicateAgentReasoningIndexes = indexDuplicateAgentReasoningMessages(rawRecords);
  let activeModel: string | undefined;
  let activeTurnId: string | undefined;
  let emittedSessionContext = false;
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

    if (record.type === 'session_meta') {
      // Desktop may repeat session_meta during a long rollout. One normalized
      // context event is enough; source records retain every native copy.
      if (emittedSessionContext) return;
      emittedSessionContext = true;
      const runtimeName = stringValue(payload.originator);
      const runtimeVersion = stringValue(payload.cli_version);
      const availableTools = codexAvailableTools(payload.dynamic_tools);
      const instructions = codexPlaintext(payload.base_instructions);
      const memoryMode = stringValue(payload.memory_mode);
      const historyMode = stringValue(payload.history_mode);
      const contextWindowId = nestedString(payload.context_window, 'window_id');
      const modelProvider = stringValue(payload.model_provider);
      const multiAgentVersion = stringValue(payload.multi_agent_version);
      if (
        runtimeName
        || runtimeVersion
        || availableTools
        || instructions
        || memoryMode
        || historyMode
        || contextWindowId
        || modelProvider
        || multiAgentVersion
      ) {
        events.push({
          ...base,
          eventKind: 'runtime_context',
          eventId: eventId('session-context'),
          runtimeKind: 'session_context',
          runtimeName,
          runtimeVersion,
          modelProvider,
          multiAgentVersion,
          memoryMode,
          historyMode,
          contextWindowId,
          availableTools,
          instructions: instructions || undefined,
          summary: codexSessionContextSummary({
            runtimeName,
            runtimeVersion,
            memoryMode,
            historyMode,
            availableTools,
          }),
        });
      }
      return;
    }

    if (record.type === 'turn_context') {
      activeModel = stringValue(payload.model) ?? activeModel;
      activeTurnId = stringValue(payload.turn_id) ?? activeTurnId;
      events.push({
        ...base,
        turnId: activeTurnId,
        eventKind: 'runtime_context',
        eventId: eventId('runtime-context'),
        runtimeKind: 'execution_context',
        cwd: stringValue(payload.cwd),
        workspaceRoots: stringArray(payload.workspace_roots),
        currentDate: stringValue(payload.current_date),
        timezone: stringValue(payload.timezone),
        model: activeModel,
        reasoningEffort: stringValue(payload.effort),
        personality: stringValue(payload.personality),
        approvalPolicy: stringValue(payload.approval_policy),
        approvalReviewer: stringValue(payload.approvals_reviewer),
        permissionProfile: nestedString(payload.permission_profile, 'type'),
        sandboxMode: nestedString(payload.sandbox_policy, 'type'),
        collaborationMode: stringValue(payload.collaboration_mode)
          ?? nestedString(payload.collaboration_mode, 'mode'),
        realtimeActive: booleanValue(payload.realtime_active),
        multiAgentMode: stringValue(payload.multi_agent_mode),
        multiAgentVersion: stringValue(payload.multi_agent_version),
        instructions: stringValue(payload.user_instructions),
        summary: stringValue(payload.summary),
      });
      return;
    }

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
          model: activeModel,
        });
      } else if (stringValue(payload.encrypted_content)) {
        events.push({
          ...base,
          eventKind: 'model_activity',
          eventId: eventId('model-activity'),
          activityKind: 'reasoning',
          contentVisibility: 'opaque',
          model: activeModel,
        });
      }
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
          displayText: normalizedRole === 'user' ? codexUserDisplayText(text) : undefined,
          attachments: normalizedRole === 'user' ? codexUserAttachments(text) : undefined,
          model: normalizedRole === 'assistant' ? activeModel : undefined,
        });
      }
      return;
    }

    if (record.type === 'response_item' && payloadType === 'agent_message') {
      const text = codexContentText(payload.content);
      const passthrough = isObject(payload.internal_chat_message_metadata_passthrough)
        ? payload.internal_chat_message_metadata_passthrough
        : {};
      events.push({
        ...base,
        sourceEventId: stringValue(payload.id),
        turnId: stringValue(passthrough.turn_id) ?? activeTurnId,
        eventKind: 'agent_activity',
        eventId: eventId('agent-communication'),
        activityKind: 'communication',
        author: stringValue(payload.author),
        recipient: stringValue(payload.recipient),
        text: text || undefined,
      });
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
        codexToolStatusFromValue(payload.status),
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
      const explicitStatus = codexToolStatusFromValue(payloadStatus);
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
      const explicitStatus = codexToolStatusFromValue(payloadStatus);
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
      const runtimeOutcome = codexRuntimeToolOutcome(mcpEnd ?? patchEnd);
      const payloadStatus = stringValue(payload.status);
      const hasRuntimeStatus = runtimeOutcome.present || payloadStatus !== undefined;
      const explicitStatus = runtimeOutcome.present
        ? runtimeOutcome.status
        : codexToolStatusFromValue(payloadStatus);
      const outputOutcome = codexToolOutputOutcome(output);
      const inferredFailure = outputOutcome.status === 'failure';
      const inferredSuccess = outputOutcome.status === 'success';
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
      // Codex also emits rate-limit-only snapshots under the token_count
      // protocol name. They describe account capacity, not task token usage.
      // Keep the source record for provenance without manufacturing a usage
      // event or reporting a known protocol shape as unknown.
      if (!usage && payload.info == null && isObject(payload.rate_limits)) return;
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

    if (record.type === 'event_msg' && payloadType === 'turn_interrupted') {
      events.push({
        ...base,
        turnId: stringValue(payload.turn_id) ?? activeTurnId,
        eventKind: 'lifecycle',
        eventId: eventId('lifecycle'),
        phase: 'turn_interrupted',
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
          displayText: codexUserDisplayText(text),
          attachments: codexUserAttachments(text),
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

    if (record.type === 'event_msg' && payloadType === 'agent_reasoning') {
      if (duplicateAgentReasoningIndexes.has(sourceIndex)) return;
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
          model: activeModel,
        });
      }
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'thread_settings_applied') {
      const settings = isObject(payload.thread_settings) ? payload.thread_settings : payload;
      activeModel = stringValue(settings.model) ?? activeModel;
      events.push({
        ...base,
        eventKind: 'runtime_context',
        eventId: eventId('runtime-settings'),
        runtimeKind: 'settings',
        model: activeModel,
        modelProvider: stringValue(settings.model_provider_id),
        serviceTier: stringValue(settings.service_tier),
        reasoningEffort: stringValue(settings.reasoning_effort),
        reasoningSummary: stringValue(settings.reasoning_summary),
        personality: stringValue(settings.personality),
        cwd: stringValue(settings.cwd),
        approvalPolicy: stringValue(settings.approval_policy),
        approvalReviewer: stringValue(settings.approvals_reviewer),
        permissionProfile: nestedString(settings.permission_profile, 'type'),
        sandboxMode: nestedString(settings.sandbox_policy, 'type'),
        collaborationMode: stringValue(settings.collaboration_mode)
          ?? nestedString(settings.collaboration_mode, 'mode'),
        summary: stringValue(settings.summary),
      });
      return;
    }

    if (record.type === 'event_msg' && payloadType === 'thread_goal_updated') {
      const goal = isObject(payload.goal) ? payload.goal : {};
      events.push({
        ...base,
        eventKind: 'runtime_context',
        eventId: eventId('runtime-goal'),
        runtimeKind: 'goal',
        goal: stringValue(payload.goal)
          ?? stringValue(goal.objective)
          ?? stringValue(goal.text),
        goalStatus: stringValue(goal.status),
        summary: stringValue(payload.summary),
      });
      return;
    }

    if (record.type === 'compacted' || (record.type === 'event_msg' && payloadType === 'context_compacted')) {
      const replacementHistory = Array.isArray(payload.replacement_history)
        ? payload.replacement_history
        : undefined;
      events.push({
        ...base,
        eventKind: 'context_compaction',
        eventId: eventId('context-compaction'),
        summary: stringValue(payload.summary) ?? stringValue(payload.message),
        replacementItemCount: replacementHistory?.length,
      });
      return;
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
    if (isCodexRecordConsumedWithoutDirectEvent(record.type, payloadType)) return;
    events.push({
      ...base,
      eventKind: 'unknown',
      eventId: eventId('unknown'),
      raw: value,
    });
  });

  for (const end of mcpEnds.ordered) {
    const endKey = mcpCallOccurrenceKey(end.callId, end.occurrence);
    const outcome = codexRuntimeToolOutcome(end);
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
    const outcome = codexRuntimeToolOutcome(end);
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

function codexAvailableTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const name = stringValue(entry.name);
    if (!name) return [];
    const namespace = stringValue(entry.namespace);
    return [namespace ? `${namespace}.${name}` : name];
  });
  return names.length > 0 ? Array.from(new Set(names)) : undefined;
}

function codexSessionContextSummary(input: {
  runtimeName?: string;
  runtimeVersion?: string;
  memoryMode?: string;
  historyMode?: string;
  availableTools?: string[];
}): string | undefined {
  const runtime = [input.runtimeName, input.runtimeVersion].filter(Boolean).join(' ');
  const parts = [
    runtime,
    input.memoryMode ? `memory ${input.memoryMode}` : '',
    input.historyMode ? `history ${input.historyMode}` : '',
    input.availableTools ? `${input.availableTools.length} tools` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
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

function codexReasoningPlaintext(
  payload: Record<string, unknown>,
): { text: string; contentSource: 'summary' | 'content' | 'text' } | undefined {
  const summary = codexPlaintext(payload.summary);
  if (summary) return { text: summary, contentSource: 'summary' };
  const content = codexPlaintext(payload.content);
  if (content) return { text: content, contentSource: 'content' };
  const text = codexPlaintext(
    payload.text ?? payload.reasoning_text ?? payload.reasoningText,
  );
  return text ? { text, contentSource: 'text' } : undefined;
}

function codexPlaintext(value: unknown, depth = 0): string {
  if (depth > 3) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => codexPlaintext(part, depth + 1))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  if (!isObject(value)) return '';
  for (const key of ['text', 'input_text', 'output_text', 'summary_text']) {
    const text = stringValue(value[key]);
    if (text) return text;
  }
  return codexPlaintext(value.content, depth + 1);
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
    const mirrorText = role === 'user' ? codexUserDisplayText(text) : text;
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
      if (adjacentPayload.type !== 'message' || adjacentPayload.role !== role) return false;
      const adjacentText = codexContentText(adjacentPayload.content);
      if (!adjacentText) return false;
      return role === 'user'
        ? Boolean(mirrorText) && codexUserDisplayText(adjacentText) === mirrorText
        : adjacentText === text;
    });
    if (mirrored) duplicateIndexes.add(sourceIndex);
  });
  return duplicateIndexes;
}

function indexDuplicateAgentReasoningMessages(records: unknown[]): Set<number> {
  const reasoningItems = records.flatMap((value, sourceIndex) => {
    const record = asCodexRecord(value);
    const payload = isObject(record?.payload) ? record.payload : {};
    if (record?.type !== 'response_item' || payload.type !== 'reasoning') return [];
    const reasoning = codexReasoningPlaintext(payload);
    if (!reasoning) return [];
    return [{
      sourceIndex,
      timestamp: normalizeTraceTimestamp(record.timestamp),
      text: normalizeReasoningMirrorText(reasoning.text),
    }];
  });

  const duplicateIndexes = new Set<number>();
  records.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    const payload = isObject(record?.payload) ? record.payload : {};
    if (record?.type !== 'event_msg' || payload.type !== 'agent_reasoning') return;
    const text = normalizeReasoningMirrorText(codexPlaintext(payload.text));
    if (!text) return;
    const timestamp = normalizeTraceTimestamp(record.timestamp);
    const mirrored = reasoningItems.some((item) => {
      if (Math.abs(item.sourceIndex - sourceIndex) > 8) return false;
      const timeDistance = timestamp && item.timestamp
        ? Math.abs(Date.parse(timestamp) - Date.parse(item.timestamp))
        : 0;
      return timeDistance <= 1_000 && item.text.includes(text);
    });
    if (mirrored) duplicateIndexes.add(sourceIndex);
  });
  return duplicateIndexes;
}

function normalizeReasoningMirrorText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function nestedString(value: unknown, key: string): string | undefined {
  return isObject(value) ? stringValue(value[key]) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
