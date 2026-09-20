/**
 * convertCodexRecords 的装配契约：记录上下文、跨记录状态与分发结果三态。
 *
 * 两条等价性约束，改动前必须先读 `record-conversion.ts`：
 * 1. 记录族按固定先后顺序分发，第一个非 `pass` 的结果即消费本条记录；
 * 2. `base.turnId` 取的是本条记录改写**前**的 `activeTurnId`，改写后覆盖是各分支自己的事。
 */

import type { TraceEvent } from '../../trace-ir.js';
import type { CodexExecResultAggregate } from './item-views.js';
import type { CodexRecord } from './record-fields.js';
import type {
  ExternalToolEndIndex,
  McpCallEndIndex,
  PatchApplyEndIndex,
  WebSearchItemIndex,
} from './record-indexes.js';
import type { TraceEventBase } from './tool-event-factory.js';

/** 整档一次算完的前置索引：会话级共享，族分发与终态回填都指向同一份对象。 */
export interface CodexRecordIndexes {
  mcpEnds: McpCallEndIndex;
  webSearchItems: WebSearchItemIndex;
  patchEnds: PatchApplyEndIndex;
  externalEnds: ExternalToolEndIndex;
  execResults: {
    mergedByCallId: Map<string, CodexExecResultAggregate[]>;
    consumedSourceIndexes: Set<number>;
  };
  duplicateEventMessageIndexes: Set<number>;
  duplicateAgentReasoningIndexes: Set<number>;
}

/** 跨记录可变状态：运行时游标、出现序计数与「已被直接记录表示」的标记集中一处，不散进闭包。 */
export interface CodexConversionState {
  activeModel: string | undefined;
  activeTurnId: string | undefined;
  emittedSessionContext: boolean;
  previousTotalUsageFingerprint: string | undefined;
  callOccurrences: Map<string, number>;
  resultOccurrences: Map<string, number>;
  externalCallOccurrences: Map<string, number>;
  externalResultOccurrences: Map<string, number>;
  execMergeCursor: Map<string, number>;
  representedMcpCalls: Set<string>;
  representedMcpResults: Set<string>;
  representedPatchCalls: Set<string>;
  representedPatchResults: Set<string>;
}

/** 单条记录的上下文：由 orchestrator 按记录构造，族 handler 只读它的字段与索引。 */
export interface CodexRecordContext extends CodexRecordIndexes {
  /** 原始记录值：unknown 档要把整条记录留进派生层，不能只留投影后的 payload。 */
  value: unknown;
  record: CodexRecord;
  payload: Record<string, unknown>;
  payloadType: string | undefined;
  sourceIndex: number;
  base: Omit<TraceEventBase, 'eventId'>;
  eventId: (suffix: string) => string;
}

/**
 * 分发结果三态：`pass` 不属于本族；`consumed` 属于本族但不产出事件（原代码里的 `return`
 * 与重复视图丢弃）；`emit` 产出这些事件。
 */
export type CodexFamilyOutcome =
  | { disposition: 'pass' }
  | { disposition: 'consumed' }
  | { disposition: 'emit'; events: TraceEvent[] };

export type CodexFamilyHandler = (
  ctx: CodexRecordContext,
  state: CodexConversionState,
) => CodexFamilyOutcome;

export function familyOutcome(events: TraceEvent[]): CodexFamilyOutcome {
  return events.length > 0 ? { disposition: 'emit', events } : { disposition: 'consumed' };
}
