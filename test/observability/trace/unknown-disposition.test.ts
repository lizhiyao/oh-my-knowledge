import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  countUnknownEventDispositions,
  UNKNOWN_DISPOSITION_RULES_VERSION,
} from '../../../src/observability/trace/unknown-disposition.js';
import type { TraceEvent, TraceSession } from '../../../src/observability/trace/trace-ir.js';

/**
 * 分桶口径是采集期推导结论，不是原始证据：用例锁的是「哪一类记录进哪一档」，
 * 尤其锁住两件事——重复视图不能超出同类已映射事件的上界，没登记的族不能冒充「刻意不映射」。
 */

function unknown(record: unknown): TraceEvent {
  return {
    eventKind: 'unknown',
    eventId: `e:${String(record === null ? 'null' : JSON.stringify(record))}`,
    sourceIndex: 0,
    sourceType: 'test',
    raw: record,
  };
}

function mapped(event: Partial<TraceEvent> & { eventKind: TraceEvent['eventKind'] }, eventId: string): TraceEvent {
  return {
    sourceIndex: 0,
    sourceType: 'test',
    ...event,
    eventId,
  } as TraceEvent;
}

function itemCompleted(itemType: string, id: string): unknown {
  return { type: 'event_msg', payload: { type: 'item_completed', item: { type: itemType, id } } };
}

/** 原始记录超限后被摘要掉：只剩族名与身份位，分桶口径必须照常工作。 */
function truncatedUnknown(recordFamily: string, recordId: string): TraceEvent {
  return {
    eventKind: 'unknown',
    eventId: `e:${recordId}`,
    sourceIndex: 0,
    sourceType: 'test',
    recordFamily,
    recordId,
    rawBytes: 1_900_000,
    rawDigest: 'deadbeefdeadbeef',
    rawTruncated: true,
  };
}

function tally(events: TraceEvent[], sourceKind: TraceSession['sourceKind']) {
  return countUnknownEventDispositions({ sourceKind, events });
}

const reasoning = (id: string) => mapped({ eventKind: 'model_activity', activityKind: 'reasoning' }, id);
const assistantMessage = (id: string) => mapped({ eventKind: 'message', role: 'assistant' }, id);

describe('countUnknownEventDispositions', () => {
  it('口径表有版本号，桶归属变化必须让旧报告计数失效', () => {
    assert.equal(UNKNOWN_DISPOSITION_RULES_VERSION, 'unknown-disposition-v4');
  });

  it('没有未识别事件时三档都是 0', () => {
    const counts = tally([reasoning('m1')], 'codex');
    assert.deepEqual(counts, { unsupported: 0, duplicateView: 0, unmappedEvidence: 0 });
  });

  it('非 Codex 宿主一律按未支持格式计，不用 Codex 口径表替别的宿主编结论', () => {
    const counts = tally([unknown({ type: 'anything' }), unknown({ type: 'else' })], 'claude');
    assert.deepEqual(counts, { unsupported: 2, duplicateView: 0, unmappedEvidence: 0 });
  });

  it('同一事实的 item 视图按同类已映射事件为上界归档', () => {
    const withTwin = tally([
      reasoning('m1'),
      unknown(itemCompleted('Reasoning', 'item-1')),
    ], 'codex');
    assert.deepEqual(withTwin, { unsupported: 0, duplicateView: 1, unmappedEvidence: 0 });

    const overCap = tally([
      reasoning('m1'),
      unknown(itemCompleted('Reasoning', 'item-1')),
      unknown(itemCompleted('Reasoning', 'item-2')),
    ], 'codex');
    assert.deepEqual(
      overCap,
      { unsupported: 0, duplicateView: 1, unmappedEvidence: 1 },
      '超出上界的那条不能宣称是重复视图，否则真实缺口会被口径表埋掉',
    );
  });

  it('每类重复视图各用自己的上界，互不挪用', () => {
    const counts = tally([
      reasoning('m1'),
      unknown(itemCompleted('AgentMessage', 'item-1')),
    ], 'codex');
    assert.deepEqual(counts, { unsupported: 0, duplicateView: 0, unmappedEvidence: 1 });
  });

  it('累计快照记录不映射成事件，逐条求和会把 token 总量放大', () => {
    const counts = tally([
      mapped({ eventKind: 'usage' }, 'u1'),
      unknown({ type: 'token_usage_record', payload: { usage: { input_tokens: 1 } } }),
    ], 'codex');
    assert.deepEqual(counts, { unsupported: 0, duplicateView: 1, unmappedEvidence: 0 });
  });

  it('已识别但尚未决定映射口径的族进待映射证据', () => {
    const counts = tally([
      unknown(itemCompleted('CommandExecution', 'exec-1')),
      unknown(itemCompleted('FileChange', 'item-2')),
    ], 'codex');
    assert.deepEqual(counts, { unsupported: 0, duplicateView: 0, unmappedEvidence: 2 });
  });

  it('口径表没登记过的族算支持缺口，读不出原始记录的族名同样如此', () => {
    const counts = tally([
      unknown({ type: 'brand_new_record', payload: { type: 'mystery' } }),
      unknown({ type: 'event_msg', payload: { type: 'item_completed' } }),
      unknown(null),
    ], 'codex');
    assert.deepEqual(counts, { unsupported: 3, duplicateView: 0, unmappedEvidence: 0 });
  });

  it('assistant 与 user 消息视图分别对各自的已映射事件计数', () => {
    const counts = tally([
      assistantMessage('a1'),
      mapped({ eventKind: 'message', role: 'user' }, 'u1'),
      unknown(itemCompleted('AgentMessage', 'item-1')),
      unknown(itemCompleted('UserMessage', 'item-2')),
      unknown(itemCompleted('AgentMessage', 'item-3')),
    ], 'codex');
    assert.deepEqual(counts, { unsupported: 0, duplicateView: 2, unmappedEvidence: 1 });
  });

  it('映射事件登记了同一原生 id 时按身份判重复，不再吃同类事件上界', () => {
    const toolResult = mapped({
      eventKind: 'tool_result',
      callId: 'call-1',
      output: '',
      status: 'success',
      statusSource: 'runtime',
      sourceIds: ['call-1', 'exec-9'],
    }, 'r1');
    const counts = tally([
      toolResult,
      unknown(itemCompleted('CommandExecution', 'call-1')),
      unknown(itemCompleted('DynamicToolCall', 'exec-9')),
    ], 'codex');
    assert.deepEqual(
      counts,
      { unsupported: 0, duplicateView: 2, unmappedEvidence: 0 },
      '身份命中即重复视图：一个 shell 结果视图与一次工具调用同 id，与同类事件有多少条无关',
    );
  });

  it('原始记录被摘要掉后仍按族名与身份分桶，不降级成未支持格式', () => {
    const pending = tally([truncatedUnknown('Extension', 'exec-1')], 'codex');
    assert.deepEqual(pending, { unsupported: 0, duplicateView: 0, unmappedEvidence: 1 });

    const duplicate = tally([
      mapped({
        eventKind: 'tool_result',
        callId: 'call-2',
        output: '',
        status: 'success',
        statusSource: 'runtime',
        sourceIds: ['call-2'],
      }, 'r2'),
      truncatedUnknown('CollabAgentToolCall', 'call-2'),
    ], 'codex');
    assert.deepEqual(duplicate, { unsupported: 0, duplicateView: 1, unmappedEvidence: 0 });
  });
});
