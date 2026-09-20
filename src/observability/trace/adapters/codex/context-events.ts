/** 运行时上下文族：会话元信息、执行环境、线程设置、目标与压缩事件的 IR 投影。 */

import type {
  CodexConversionState,
  CodexFamilyOutcome,
  CodexRecordContext,
} from './conversion-contract.js';
import { familyOutcome } from './conversion-contract.js';
import {
  booleanValue,
  isObject,
  nestedString,
  stringArray,
  stringValue,
} from './record-fields.js';
import { codexPlaintext } from './record-text.js';
import type { TraceEvent } from '../../trace-ir.js';

/** 分支顺序与原 if 链一致：跨族的先后由 `record-conversion.ts` 的分发表保证。 */
export function convertCodexContextRecord(
  ctx: CodexRecordContext,
  state: CodexConversionState,
): CodexFamilyOutcome {
  const { base, eventId, payload, payloadType, record } = ctx;
  const events: TraceEvent[] = [];

  if (record.type === 'session_meta') {
    // Desktop may repeat session_meta during a long rollout. One normalized
    // context event is enough; source records retain every native copy.
    if (state.emittedSessionContext) return familyOutcome(events);
    state.emittedSessionContext = true;
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
    return familyOutcome(events);
  }

  if (record.type === 'turn_context') {
    state.activeModel = stringValue(payload.model) ?? state.activeModel;
    state.activeTurnId = stringValue(payload.turn_id) ?? state.activeTurnId;
    events.push({
      ...base,
      turnId: state.activeTurnId,
      eventKind: 'runtime_context',
      eventId: eventId('runtime-context'),
      runtimeKind: 'execution_context',
      cwd: stringValue(payload.cwd),
      workspaceRoots: stringArray(payload.workspace_roots),
      currentDate: stringValue(payload.current_date),
      timezone: stringValue(payload.timezone),
      model: state.activeModel,
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
    return familyOutcome(events);
  }

  if (record.type === 'event_msg' && payloadType === 'thread_settings_applied') {
    const settings = isObject(payload.thread_settings) ? payload.thread_settings : payload;
    state.activeModel = stringValue(settings.model) ?? state.activeModel;
    events.push({
      ...base,
      eventKind: 'runtime_context',
      eventId: eventId('runtime-settings'),
      runtimeKind: 'settings',
      model: state.activeModel,
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
    return familyOutcome(events);
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
    return familyOutcome(events);
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
    return familyOutcome(events);
  }

  return { disposition: 'pass' };
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
