/** 工具族：调用／结果两侧的记录，含跨视图归属、出现序游标与 Codex 专有的工具身份归一。 */

import type { TraceEvent, TraceToolRef } from '../../trace-ir.js';
import { normalizeToolIdentity } from '../../../../executors/core/tool-identity.js';
import type {
  CodexConversionState,
  CodexFamilyOutcome,
  CodexRecordContext,
} from './conversion-contract.js';
import { familyOutcome } from './conversion-contract.js';
import { extractCodexExecCommands } from './exec-command.js';
import {
  mcpCallOccurrenceKey,
  takeOccurrence,
  type McpCallEnd,
} from './record-indexes.js';
import { isObject, parseToolInput, stringValue } from './record-fields.js';
import { codexContentText } from './record-text.js';
import {
  codexRuntimeToolOutcome,
  codexToolOutputOutcome,
  codexToolStatusFromValue,
} from './tool-status.js';
import {
  codexPayloadIds,
  toolCallEvent,
  toolResultEvent,
} from './tool-event-factory.js';

/** 分支顺序与原 if 链一致：跨族的先后由 `record-conversion.ts` 的分发表保证。 */
export function convertCodexToolRecord(
  ctx: CodexRecordContext,
  state: CodexConversionState,
): CodexFamilyOutcome {
  const {
    base,
    eventId,
    execResults,
    externalEnds,
    mcpEnds,
    payload,
    payloadType,
    patchEnds,
    record,
    sourceIndex,
  } = ctx;
  const {
    callOccurrences,
    execMergeCursor,
    externalCallOccurrences,
    externalResultOccurrences,
    representedMcpCalls,
    representedMcpResults,
    representedPatchCalls,
    representedPatchResults,
    resultOccurrences,
  } = state;
  const events: TraceEvent[] = [];

  if (record.type === 'response_item' && payloadType === 'tool_search_call') {
    const callId = stringValue(payload.call_id) ?? stringValue(payload.id) ?? `codex-tool-search-${sourceIndex}`;
    events.push(toolCallEvent(
      eventId('tool-call'),
      base,
      callId,
      normalizeToolIdentity({ sourceName: 'tool_search' }),
      parseToolInput(payload.arguments),
      state.activeModel,
    ));
    return familyOutcome(events);
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
    return familyOutcome(events);
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
      state.activeModel,
    ));
    events.push(toolResultEvent(
      eventId('tool-result'),
      base,
      callId,
      JSON.stringify({ status: stringValue(payload.status) }),
      explicitStatus !== 'unknown' ? explicitStatus : completed ? 'success' : 'unknown',
      explicitStatus !== 'unknown' ? 'runtime' : completed ? 'inferred' : 'unknown',
    ));
    return familyOutcome(events);
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
      state.activeModel,
    ));
    events.push(toolResultEvent(
      eventId('tool-result'),
      base,
      callId,
      JSON.stringify({ status: stringValue(payload.status), resultBytes: result.length }),
      explicitStatus !== 'unknown' ? explicitStatus : inferredSuccess ? 'success' : 'unknown',
      explicitStatus !== 'unknown' ? 'runtime' : inferredSuccess ? 'inferred' : 'unknown',
    ));
    return familyOutcome(events);
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
    const callIds = codexPayloadIds(payload);
    events.push({
      ...toolCallEvent(eventId('tool-call'), base, callId, normalized.tool, normalized.input, state.activeModel),
      ...(callIds.length > 0 ? { sourceIds: callIds } : {}),
    });
    return familyOutcome(events);
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
    const execQueue = execResults.mergedByCallId.get(callId);
    const execCursor = execMergeCursor.get(callId) ?? 0;
    const execView = execQueue?.[execCursor];
    if (execQueue && execCursor < execQueue.length) execMergeCursor.set(callId, execCursor + 1);
    events.push({
      ...toolResultEvent(
        eventId('tool-result'),
        base,
        callId,
        output,
        hasRuntimeStatus ? explicitStatus : inferredStatus,
        hasRuntimeStatus
          ? 'runtime'
          : inferredStatus === 'unknown' ? 'unknown' : 'inferred',
      ),
      ...(execView
        ? {
          exitCode: execView.exitCode,
          durationMs: execView.durationMs,
          sourceIds: [...new Set([...codexPayloadIds(payload), ...execView.ids])].filter(Boolean),
        }
        : {}),
    });
    return familyOutcome(events);
  }

  return { disposition: 'pass' };
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
