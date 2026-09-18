import type { TraceEvent, TraceSession } from './trace-ir.js';

/**
 * 未识别记录的分桶口径版本。桶归属是采集期推导的结论，不是原始证据：口径表变化会让
 * 上一轮报告里的桶计数失效，采集侧据此强制重新解析，而不是把旧计数带进新口径。
 *
 * v2 相对 v1 的变化：Codex 的观测效果／状态族改为映射成事件（不再留在未知里），并且
 * 同一事实的第二次写入现在可以按原生 id 精确判定（映射事件会把两侧 id 都登记在
 * `sourceIds`），不再只靠「同类已映射事件数」的上界近似。
 */
export const UNKNOWN_DISPOSITION_RULES_VERSION = 'unknown-disposition-v2' as const;

export interface UnknownEventDispositionCounts {
  /** 适配器读不出语义的记录：真正的支持缺口，需要修适配器。 */
  unsupported: number;
  /** 同一事实的第二次写入或累计快照：映射成事件会变成双计，因此刻意不映射。 */
  duplicateView: number;
  /** 已识别的记录族，但该记录承载的是当前证据里唯一的副本，等映射口径决定。 */
  unmappedEvidence: number;
}

/** 与 `response_item` 视图承载同一事实的 Codex item 族。 */
const CODEX_DUPLICATE_VIEW_FAMILIES = new Map<string, (event: TraceEvent) => boolean>([
  ['Reasoning', (event) => event.eventKind === 'model_activity'],
  ['AgentMessage', (event) => event.eventKind === 'message' && event.role === 'assistant'],
  ['UserMessage', (event) => event.eventKind === 'message' && event.role === 'user'],
  ['ContextCompaction', (event) => event.eventKind === 'context_compaction'],
]);

/**
 * 已有映射口径、因此正常情况下不该出现在未知档里的族。它们仍以 unknown 存在时只有两种
 * 解释：与某条已映射事件同 id 的第二次写入（重复视图），或者映射 declined 后剩下的唯一
 * 副本（待映射证据）。判定只看身份，不做内容推断。
 */
const CODEX_IDENTITY_DEDUP_FAMILIES = new Set([
  'CommandExecution',
  'FileChange',
  'Extension',
  'SubAgentActivity',
  'CollabAgentToolCall',
  'DynamicToolCall',
  'ImageView',
  'EnteredReviewMode',
  'ExitedReviewMode',
]);

/** 累计快照记录：逐条求和会把 token 总量放大数倍，只保留原始证据。 */
const CODEX_CUMULATIVE_VIEW_RECORDS = new Set(['token_usage_record']);

/** 登记表里出现过的族名：只有登记过的记录才可能被解释成重复视图或待映射证据。 */
const CODEX_RECOGNIZED_FAMILIES = new Set<string>([
  ...CODEX_DUPLICATE_VIEW_FAMILIES.keys(),
  ...CODEX_IDENTITY_DEDUP_FAMILIES,
  ...CODEX_CUMULATIVE_VIEW_RECORDS,
]);

/**
 * 按桶统计一个会话里的未识别事件。
 *
 * 同一事实的第二次写入优先按原生身份判定：映射事件会把它见过的所有原生 id 记在
 * `sourceIds`／`sourceEventId`／`callId` 上，未识别记录携带的 id 命中即重复视图。命中不了
 * 再退回上界近似——Codex 的 `item-N` 与 `msg_*` 两套 id 命名空间不相交，这类跨视图身份
 * 本来就证明不了，因此「同类已映射事件的数量」只能作为重复视图的**上界**，超出上界的
 * 部分按唯一证据待映射处理。登记表里没有的族名一律算未支持缺口：把没读过的记录说成
 * 「刻意不映射」，等于用口径表把真正的能力缺口埋掉。宿主没有登记口径表时全部计入未支持。
 */
export function countUnknownEventDispositions(
  session: Pick<TraceSession, 'sourceKind' | 'events'>,
): UnknownEventDispositionCounts {
  const counts: UnknownEventDispositionCounts = { unsupported: 0, duplicateView: 0, unmappedEvidence: 0 };
  const unknownEvents = session.events.filter((event) => event.eventKind === 'unknown');
  if (unknownEvents.length === 0) return counts;
  if (session.sourceKind !== 'codex') {
    counts.unsupported = unknownEvents.length;
    return counts;
  }

  const mappedIdentities = new Set<string>();
  for (const event of session.events) {
    if (event.eventKind === 'unknown') continue;
    for (const id of event.sourceIds ?? []) mappedIdentities.add(id);
    if (event.sourceEventId) mappedIdentities.add(event.sourceEventId);
    if (event.eventKind === 'tool_call' || event.eventKind === 'tool_result') mappedIdentities.add(event.callId);
  }

  const remainingTwins = new Map<string, number>();
  for (const [family, isTwin] of CODEX_DUPLICATE_VIEW_FAMILIES) {
    remainingTwins.set(family, session.events.filter(isTwin).length);
  }

  for (const event of unknownEvents) {
    const family = codexUnknownFamily(event);
    if (family === undefined || !CODEX_RECOGNIZED_FAMILIES.has(family)) {
      counts.unsupported += 1;
      continue;
    }
    if (CODEX_CUMULATIVE_VIEW_RECORDS.has(family)) {
      counts.duplicateView += 1;
      continue;
    }
    const nativeId = codexUnknownNativeId(event);
    if (nativeId !== undefined && mappedIdentities.has(nativeId)) {
      counts.duplicateView += 1;
      continue;
    }
    if (CODEX_IDENTITY_DEDUP_FAMILIES.has(family)) {
      counts.unmappedEvidence += 1;
      continue;
    }
    const remaining = remainingTwins.get(family) ?? 0;
    if (remaining > 0) {
      remainingTwins.set(family, remaining - 1);
      counts.duplicateView += 1;
    } else {
      counts.unmappedEvidence += 1;
    }
  }
  return counts;
}

/**
 * 从事件上取族名。原始记录还在时按记录本身推导，保持与 v1 完全同口径——`recordFamily` 是
 * 适配器给出的「最具体协议标签」，取值顺序与这里不同，不能反过来改变已能读出记录的归档。
 * 只有记录被摘要掉时才用它兜底，避免大记录因为不进派生层而降级成未支持格式。
 */
function codexUnknownFamily(event: TraceEvent): string | undefined {
  if (event.eventKind !== 'unknown') return undefined;
  const fallback = event.raw === undefined ? truncatedRecordFamily(event) : undefined;
  if (fallback !== undefined) return fallback;
  const record = rawRecord(event);
  if (!record) return undefined;
  const recordType = typeof record.type === 'string' ? record.type : undefined;
  const payload = isPlainObject(record.payload) ? record.payload : undefined;
  const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
  if (payloadType === 'item_completed') {
    const item = isPlainObject(payload?.item) ? payload.item : undefined;
    return typeof item?.type === 'string' ? item.type : undefined;
  }
  return recordType ?? payloadType;
}

/** 未识别记录自己的原生 id：同样先按原始记录推导，被摘要掉时用适配器登记的身份位兜底。 */
function codexUnknownNativeId(event: TraceEvent): string | undefined {
  if (event.eventKind !== 'unknown') return undefined;
  if (event.raw === undefined && typeof event.recordId === 'string') return event.recordId;
  const record = rawRecord(event);
  if (!record) return undefined;
  const payload = isPlainObject(record.payload) ? record.payload : undefined;
  if (payload?.type === 'item_completed') {
    const item = isPlainObject(payload.item) ? payload.item : undefined;
    return typeof item?.id === 'string' ? item.id : undefined;
  }
  const id = typeof payload?.call_id === 'string' ? payload.call_id : payload?.id;
  return typeof id === 'string' ? id : undefined;
}

/** 摘要后的记录只剩协议标签：item 视图的族名与 `item_completed` 本身要分开看。 */
function truncatedRecordFamily(event: TraceEvent): string | undefined {
  if (event.eventKind !== 'unknown' || typeof event.recordFamily !== 'string') return undefined;
  return event.recordFamily === 'item_completed' ? undefined : event.recordFamily;
}

function rawRecord(event: TraceEvent): Record<string, unknown> | undefined {
  return event.eventKind === 'unknown' && isPlainObject(event.raw) ? event.raw : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
