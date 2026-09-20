/**
 * 主循环之前的前置索引：跨视图身份、出现序与重复写入必须在整档扫完后才判得准，
 * 边解析边消费会因为记录先后顺序错开归属（见 `item-views.ts` 的同名约束）。
 */

import { normalizeTraceTimestamp } from '../../trace-ir.js';
import { isCodexWebSearchItemView } from './item-views.js';
import { codexUserDisplayText } from './protocol.js';
import {
  asCodexRecord,
  booleanValue,
  isObject,
  parseToolInput,
  stringValue,
} from './record-fields.js';
import {
  codexContentText,
  codexPlaintext,
  codexReasoningPlaintext,
  normalizeReasoningMirrorText,
} from './record-text.js';

export interface McpCallEnd {
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

export interface McpCallEndIndex {
  ordered: McpCallEnd[];
  byOccurrence: Map<string, McpCallEnd>;
  bySourceIndex: Map<number, McpCallEnd>;
}

export interface WebSearchItemEnd {
  callId: string;
  sourceIndex: number;
  sourceEventId?: string;
  sourceType: string;
  timestamp?: string;
  input: Record<string, unknown>;
  output: string;
  status?: string;
  hasResults: boolean;
  turnId?: string;
  model?: string;
}

export interface WebSearchItemIndex {
  ordered: WebSearchItemEnd[];
  bySourceIndex: Map<number, WebSearchItemEnd>;
  duplicateSourceIndexes: Set<number>;
}

export interface PatchApplyEnd {
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

export interface PatchApplyEndIndex {
  ordered: PatchApplyEnd[];
  byOccurrence: Map<string, PatchApplyEnd>;
  bySourceIndex: Map<number, PatchApplyEnd>;
}

export interface ExternalToolEndIndex {
  byOccurrence: Set<string>;
}

export function indexMcpCallEnds(records: unknown[]): McpCallEndIndex {
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

  // 较新的 Codex 版本不再写 mcp_tool_call_end，改由 item_completed 单独承载 MCP 调用与结果。
  // 同一 call_id 已有运行时结尾记录时不再重复登记，避免一次调用产生两组工具事件。
  const indexedCallIds = new Set(ordered.map((end) => end.callId));
  records.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    const payload = isObject(record?.payload) ? record.payload : {};
    if (payload.type !== 'item_completed') return;
    const item = isObject(payload.item) ? payload.item : undefined;
    if (!item || item.type !== 'McpToolCall') return;
    const callId = stringValue(item.id) ?? stringValue(item.call_id);
    if (!callId || indexedCallIds.has(callId)) return;
    indexedCallIds.add(callId);
    const occurrence = takeOccurrence(occurrences, callId);
    const result = item.result;
    const end: McpCallEnd = {
      callId,
      occurrence,
      sourceIndex,
      sourceEventId: callId,
      sourceType: `${String(record?.type ?? 'unknown')}:item_completed`,
      timestamp: normalizeTraceTimestamp(record?.timestamp),
      isError: booleanValue(item.isError)
        ?? booleanValue(item.is_error)
        ?? (isObject(result) ? booleanValue(result.isError) ?? booleanValue(result.is_error) : undefined),
      status: stringValue(item.status) ?? (isObject(result) ? stringValue(result.status) : undefined),
      tool: stringValue(item.tool),
      server: stringValue(item.server),
      input: parseToolInput(item.arguments ?? item.input),
      output: codexContentText(isObject(result) ? result.content ?? result : result ?? item.output),
    };
    ordered.push(end);
    byOccurrence.set(mcpCallOccurrenceKey(callId, occurrence), end);
    bySourceIndex.set(sourceIndex, end);
  });

  return { ordered, byOccurrence, bySourceIndex };
}

/**
 * WebSearch 的 item_completed 视图有两种身份：与 `response_item` 同一次调用的第二次写入，
 * 或该次搜索唯一的记录。只有身份对得上才算重复视图，其余按一次真实搜索综合工具事件。
 */
export function indexWebSearchItemViews(records: unknown[]): WebSearchItemIndex {
  const ordered: WebSearchItemEnd[] = [];
  const bySourceIndex = new Map<number, WebSearchItemEnd>();
  const duplicateSourceIndexes = new Set<number>();
  const mappedCallIds = new Set<string>();
  const responseViews: { sourceIndex: number; query: string }[] = [];

  records.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    if (record?.type !== 'response_item') return;
    const payload = isObject(record.payload) ? record.payload : {};
    const payloadType = stringValue(payload.type);
    if (payloadType === 'web_search_call') {
      const id = stringValue(payload.id);
      if (id) mappedCallIds.add(id);
      const action = isObject(payload.action) ? payload.action : {};
      responseViews.push({
        sourceIndex,
        query: stringValue(action.query) ?? stringValue(payload.query) ?? '',
      });
      return;
    }
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call' || payloadType === 'tool_search_call') {
      const id = stringValue(payload.call_id) ?? stringValue(payload.id);
      if (id) mappedCallIds.add(id);
    }
  });

  const synthesizedCallIds = new Set<string>();
  records.forEach((value, sourceIndex) => {
    const record = asCodexRecord(value);
    const payload = isObject(record?.payload) ? record.payload : {};
    if (payload.type !== 'item_completed') return;
    const item = isObject(payload.item) ? payload.item : undefined;
    if (!item || !isCodexWebSearchItemView(item)) return;
    const id = stringValue(item.id);
    const action = isObject(item.action) ? item.action : {};
    const query = stringValue(action.query) ?? stringValue(item.query) ?? '';
    const isAdjacentTwin = query !== '' && responseViews.some((view) => (
      view.query === query && Math.abs(view.sourceIndex - sourceIndex) <= 2
    ));
    if ((id !== undefined && (mappedCallIds.has(id) || synthesizedCallIds.has(id)))
      || isAdjacentTwin) {
      duplicateSourceIndexes.add(sourceIndex);
      return;
    }
    if (id) synthesizedCallIds.add(id);
    const results = Array.isArray(item.results) ? item.results : undefined;
    const status = stringValue(item.status);
    const outputPayload: Record<string, unknown> = {};
    if (status) outputPayload.status = status;
    if (results) outputPayload.results = results;
    const end: WebSearchItemEnd = {
      callId: id ?? `codex-web-search-${sourceIndex}`,
      sourceIndex,
      sourceEventId: id,
      sourceType: `${String(record?.type ?? 'unknown')}:item_completed`,
      timestamp: normalizeTraceTimestamp(record?.timestamp),
      input: action,
      output: Object.keys(outputPayload).length ? JSON.stringify(outputPayload) : '',
      status,
      hasResults: results !== undefined,
    };
    ordered.push(end);
    bySourceIndex.set(sourceIndex, end);
  });

  return { ordered, bySourceIndex, duplicateSourceIndexes };
}

export function indexPatchApplyEnds(records: unknown[]): PatchApplyEndIndex {
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

export function indexExternalToolEnds(records: unknown[]): ExternalToolEndIndex {
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

export function indexDuplicateEventMessages(records: unknown[]): Set<number> {
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

export function indexDuplicateAgentReasoningMessages(records: unknown[]): Set<number> {
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

export function takeOccurrence(counts: Map<string, number>, callId: string): number {
  const occurrence = counts.get(callId) ?? 0;
  counts.set(callId, occurrence + 1);
  return occurrence;
}

export function mcpCallOccurrenceKey(callId: string, occurrence: number): string {
  return `${callId}\u0000${occurrence}`;
}
