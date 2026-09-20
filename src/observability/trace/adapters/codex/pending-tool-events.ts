/**
 * 主循环结束后的补发：前置索引里的调用／结果只在该次调用没有被任何直接记录表示时才补事件，
 * 因此必须在整档分发跑完、`turnId`／`model` 回填之后执行，顺序不能提前。
 */

import type { TraceEvent, TraceToolStatus } from '../../trace-ir.js';
import { normalizeToolIdentity } from '../../../../executors/core/tool-identity.js';
import type {
  CodexConversionState,
  CodexRecordIndexes,
} from './conversion-contract.js';
import { mcpCallOccurrenceKey } from './record-indexes.js';
import { codexRuntimeToolOutcome, codexToolStatusFromValue } from './tool-status.js';
import {
  mcpToolRefFromEnd,
  toolCallEvent,
  toolResultEvent,
} from './tool-event-factory.js';

export function collectPendingCodexToolEvents(
  runId: string,
  indexes: CodexRecordIndexes,
  state: CodexConversionState,
): TraceEvent[] {
  const { mcpEnds, patchEnds, webSearchItems } = indexes;
  const {
    representedMcpCalls,
    representedMcpResults,
    representedPatchCalls,
    representedPatchResults,
  } = state;
  const events: TraceEvent[] = [];

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

  for (const end of webSearchItems.ordered) {
    const explicitStatus = codexToolStatusFromValue(end.status);
    const status: TraceToolStatus = explicitStatus !== 'unknown'
      ? explicitStatus
      : end.hasResults ? 'success' : 'unknown';
    events.push(toolCallEvent(
      `${runId}:${end.sourceIndex}:web-search-call`,
      {
        sourceEventId: end.sourceEventId,
        sourceIndex: end.sourceIndex,
        sourceType: end.sourceType,
        timestamp: end.timestamp,
        turnId: end.turnId,
      },
      end.callId,
      normalizeToolIdentity({ sourceName: 'web_search' }),
      end.input,
      end.model,
    ));
    events.push(toolResultEvent(
      `${runId}:${end.sourceIndex}:web-search-result`,
      {
        sourceEventId: end.sourceEventId,
        sourceIndex: end.sourceIndex,
        sourceType: end.sourceType,
        timestamp: end.timestamp,
        turnId: end.turnId,
      },
      end.callId,
      end.output,
      status,
      explicitStatus !== 'unknown' ? 'runtime' : end.hasResults ? 'inferred' : 'unknown',
    ));
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

  return events;
}
