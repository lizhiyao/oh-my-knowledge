/**
 * Codex rollout 记录 → Trace IR 的会话装配 orchestrator：索引与状态初始化、按记录族分发、
 * 尾部兜底与补发。
 *
 * 两条不变式：
 * 1. 分发顺序就是拆分前那条 if 链的先后顺序。四族的判定条件按 `(record.type, payloadType)`
 *    两两互斥，因此按族聚合后与逐条问询等价；新增分支必须留在所属族内，不要在入口插条件。
 * 2. `base` 在族分发之前按记录构造，`turnId` 取的是**改写前**的 `activeTurnId`；改写运行时
 *    状态是各分支自己的事，覆盖后的值只在本条事件里显式带回。
 * `item_completed` 命中不了索引时不消费本条记录，会继续落到 `patch_apply_end` 与 unknown
 * 兜底——这段 fall-through 是原行为。
 */

import type { TraceEvent } from '../../trace-ir.js';
import { normalizeTraceTimestamp, unknownTraceEvent } from '../../trace-ir.js';
import { convertCodexContextRecord } from './context-events.js';
import type {
  CodexConversionState,
  CodexFamilyHandler,
  CodexRecordContext,
  CodexRecordIndexes,
} from './conversion-contract.js';
import { convertCodexConversationRecord } from './conversation-events.js';
import {
  indexCodexExecResultViews,
  projectCodexAgentLifecycle,
  projectCodexObservedEffect,
  projectCodexReviewPhase,
} from './item-views.js';
import { collectPendingCodexToolEvents } from './pending-tool-events.js';
import { isCodexRecordConsumedWithoutDirectEvent } from './protocol.js';
import { asCodexRecord, isObject, stringValue } from './record-fields.js';
import {
  indexDuplicateAgentReasoningMessages,
  indexDuplicateEventMessages,
  indexExternalToolEnds,
  indexMcpCallEnds,
  indexPatchApplyEnds,
  indexWebSearchItemViews,
} from './record-indexes.js';
import { convertCodexToolRecord } from './tool-events.js';
import { convertCodexTurnRecord } from './turn-events.js';

const CODEX_RECORD_FAMILIES: readonly CodexFamilyHandler[] = [
  convertCodexContextRecord,
  convertCodexConversationRecord,
  convertCodexToolRecord,
  convertCodexTurnRecord,
];

export function convertCodexRecords(rawRecords: unknown[], runId: string, cwd?: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  const mcpEnds = indexMcpCallEnds(rawRecords);
  const webSearchItems = indexWebSearchItemViews(rawRecords);
  const patchEnds = indexPatchApplyEnds(rawRecords);
  const externalEnds = indexExternalToolEnds(rawRecords);
  // shell 结果视图与调用侧的归属在解析前一次算完，主循环只按 callId 顺序取用，
  // 避免受记录先后顺序与两侧出现序计数错开的影响。
  const execResults = indexCodexExecResultViews(rawRecords);
  const execMergeCursor = new Map<string, number>();
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
  const emittedSessionContext = false;
  let previousTotalUsageFingerprint: string | undefined;
  const indexes: CodexRecordIndexes = {
    mcpEnds,
    webSearchItems,
    patchEnds,
    externalEnds,
    execResults,
    duplicateEventMessageIndexes,
    duplicateAgentReasoningIndexes,
  };
  const state: CodexConversionState = {
    activeModel,
    activeTurnId,
    emittedSessionContext,
    previousTotalUsageFingerprint,
    callOccurrences,
    resultOccurrences,
    externalCallOccurrences,
    externalResultOccurrences,
    execMergeCursor,
    representedMcpCalls,
    representedMcpResults,
    representedPatchCalls,
    representedPatchResults,
  };

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
      turnId: state.activeTurnId,
    };
    const ctx: CodexRecordContext = {
      ...indexes,
      value,
      record,
      payload,
      payloadType,
      sourceIndex,
      base,
      eventId,
    };
    for (const convertRecord of CODEX_RECORD_FAMILIES) {
      const outcome = convertRecord(ctx, state);
      if (outcome.disposition === 'pass') continue;
      if (outcome.disposition === 'emit') events.push(...outcome.events);
      return;
    }

    if (payloadType === 'mcp_tool_call_end') {
      const end = mcpEnds.bySourceIndex.get(sourceIndex);
      if (end) {
        end.turnId = state.activeTurnId;
        end.model = state.activeModel;
      }
      return;
    }
    if (payloadType === 'item_completed') {
      // item_completed 里可直接映射的视图分四类：登记为 MCP 调用端的 item、WebSearch（含
      // 改由 Extension 承载的新形态）、已把执行属性并回工具结果的 shell 结果视图，以及
      // 不作为工具调用成立的观测效果／状态记录。其余 item 视图仍按 unknown 保留原始证据。
      const end = mcpEnds.bySourceIndex.get(sourceIndex);
      if (end) {
        end.turnId = state.activeTurnId;
        end.model = state.activeModel;
        return;
      }
      const webSearch = webSearchItems.bySourceIndex.get(sourceIndex);
      if (webSearch) {
        webSearch.turnId = state.activeTurnId;
        webSearch.model = state.activeModel;
        return;
      }
      if (webSearchItems.duplicateSourceIndexes.has(sourceIndex)) return;
      if (execResults.consumedSourceIndexes.has(sourceIndex)) return;
      const item = isObject(payload.item) ? payload.item : undefined;
      if (item) {
        const context = { base, eventId, cwd };
        const projected = projectCodexObservedEffect(item, payload, context)
          ?? projectCodexAgentLifecycle(item, context)
          ?? projectCodexReviewPhase(item, payload, context);
        if (projected) {
          events.push(projected);
          return;
        }
      }
    }
    if (payloadType === 'patch_apply_end') {
      const end = patchEnds.bySourceIndex.get(sourceIndex);
      if (end) {
        end.turnId = state.activeTurnId;
        end.model = state.activeModel;
      }
      return;
    }
    if (isCodexRecordConsumedWithoutDirectEvent(record.type, payloadType)) return;
    events.push(unknownTraceEvent(base, eventId('unknown'), value));
  });

  // 逐条 push，不用 `push(...arr)`：补发量随整档记录数增长，展开传参会在长 rollout 上撞实参上限。
  for (const event of collectPendingCodexToolEvents(runId, indexes, state)) events.push(event);

  events.sort((a, b) => a.sourceIndex - b.sourceIndex);
  return events;
}
