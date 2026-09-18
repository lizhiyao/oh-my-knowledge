import type { TraceEvent, TraceSession } from './trace-ir.js';

/**
 * 未识别记录的分桶口径版本。桶归属是采集期推导的结论，不是原始证据：口径表变化会让
 * 上一轮报告里的桶计数失效，采集侧据此强制重新解析，而不是把旧计数带进新口径。
 */
export const UNKNOWN_DISPOSITION_RULES_VERSION = 'unknown-disposition-v1' as const;

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

/** 累计快照记录：逐条求和会把 token 总量放大数倍，只保留原始证据。 */
const CODEX_CUMULATIVE_VIEW_RECORDS = new Set(['token_usage_record']);

/** 已识别但尚未决定映射成什么事件的 Codex item 族。 */
const CODEX_UNMAPPED_EVIDENCE_FAMILIES = new Set([
  'FileChange',
  'CommandExecution',
  'Extension',
  'SubAgentActivity',
  'CollabAgentToolCall',
  'ImageView',
  'DynamicToolCall',
  'EnteredReviewMode',
  'ExitedReviewMode',
]);

/** 登记表里出现过的族名：只有登记过的记录才可能被解释成重复视图或待映射证据。 */
const CODEX_RECOGNIZED_FAMILIES = new Set<string>([
  ...CODEX_DUPLICATE_VIEW_FAMILIES.keys(),
  ...CODEX_CUMULATIVE_VIEW_RECORDS,
  ...CODEX_UNMAPPED_EVIDENCE_FAMILIES,
]);

/**
 * 按桶统计一个会话里的未识别事件。
 *
 * 重复视图的判定只用会话内的事实，不依赖跨视图 id 关联：Codex 的两套视图 id 命名空间不相交，
 * 用 id 关联必然 0 命中。因此「同类已映射事件的数量」只作为重复视图的**上界**——超出上界的
 * 那部分不能宣称是重复视图，按唯一证据待映射处理。登记表里没有的族名一律算未支持缺口：把
 * 没读过的记录说成「刻意不映射」，等于用口径表把真正的能力缺口埋掉。宿主没有登记口径表时
 * 全部计入未支持缺口。
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
    if (CODEX_UNMAPPED_EVIDENCE_FAMILIES.has(family)) {
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

/** 从原始记录里取出族名：`item_completed` 用 item 类型，其余用记录类型。 */
function codexUnknownFamily(event: TraceEvent): string | undefined {
  if (event.eventKind !== 'unknown') return undefined;
  const record = isPlainObject(event.raw) ? event.raw : undefined;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
