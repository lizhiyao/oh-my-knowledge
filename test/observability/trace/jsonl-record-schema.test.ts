import { describe, expect, it } from 'vitest';
import { assembleRecord, type RecordSchemaNode } from '../../../src/observability/trace/jsonl-record-schema.js';
import { reescapeJsonString } from '../../../src/observability/trace/evidence-text.js';

/**
 * 装配读取器的全部风险都在「声明的字段有没有被如实取出」与「没声明的大字段有没有被顺手解掉」，
 * 所以基准一律取 `JSON.parse` 的结果，而不是手写期望值；span 的契约是「那段字节再解析回去
 * 必须等于原值」，写出侧的重转义另有用例把关。
 */

const VALUE: RecordSchemaNode = { read: 'value' };
const SPAN: RecordSchemaNode = { read: 'span' };

function record(text: string) {
  const buffer = Buffer.from(text, 'utf8');
  return { buffer, result: assembleRecord(buffer, '/source.jsonl', SCHEMA) };
}

const SCHEMA: RecordSchemaNode = {
  read: 'object',
  members: {
    type: VALUE,
    timestamp: VALUE,
    missingAtTop: VALUE,
    payload: {
      read: 'object',
      members: {
        type: VALUE,
        callId: VALUE,
        count: VALUE,
        flag: VALUE,
        nothing: VALUE,
        list: { read: 'array', element: VALUE },
        nested: { read: 'object', members: { deep: VALUE, text: VALUE } },
        output: SPAN,
        big: SPAN,
      },
    },
  },
};

/** 一份带各类转义与嵌套的记录文本：值都由 JSON.stringify 生成，避免把测试数据写成语法错误。 */
const LOG = JSON.stringify({
  type: 'response_item',
  timestamp: '2026-07-25T00:00:00Z',
  payload: {
    type: 'function_call_output',
    callId: 'c-1',
    count: 2,
    flag: true,
    nothing: null,
    nested: { deep: '\ud83d\ude00', text: 'a/b\nc\ée"' },
    list: [1, '两', { x: 1 }],
    output: '长文本 \u0041 end',
    big: 'z'.repeat(4096),
  },
});

describe('按声明装配一条记录', () => {
  it('声明到的字段与整条 JSON.parse 逐项相等，未声明的键读不到就抛错', () => {
    const { result } = record(LOG);
    expect(result.outcome).toBe('record');
    const assembled = result.record as Record<string, any>;
    const parsed = JSON.parse(LOG) as Record<string, any>;
    expect(assembled.type).toBe(parsed.type);
    expect(assembled.timestamp).toBe(parsed.timestamp);
    expect(assembled.missingAtTop).toBeUndefined();
    expect(assembled.payload.type).toBe(parsed.payload.type);
    expect(assembled.payload.callId).toBe(parsed.payload.callId);
    expect(assembled.payload.count).toBe(2);
    expect(assembled.payload.flag).toBe(true);
    expect(assembled.payload.nothing).toBeNull();
    expect(assembled.payload.nested).toEqual(parsed.payload.nested);
    expect(assembled.payload.list).toEqual(parsed.payload.list);
    expect(() => (assembled.payload as Record<string, unknown>).undeclared).toThrow(/未声明/);
    expect(() => (assembled as Record<string, unknown>).other).toThrow(/未声明/);
  });

  it('span 字段不解值：窗口字节再解析回原值，且大字段一个字节都不进解码', () => {
    const { buffer, result } = record(LOG);
    const parsed = JSON.parse(LOG) as Record<string, any>;
    const assembled = result.record as Record<string, any>;
    for (const key of ['output', 'big']) {
      const span = assembled.payload[key];
      expect(span.sourcePath).toBe('/source.jsonl');
      expect(span.valueKind).toBe('string');
      expect(JSON.parse(buffer.toString('utf8', span.begin, span.end))).toBe(parsed.payload[key]);
    }
    // 声明成 span 的字段不得被解成 JS 字符串：整段 4 KiB 的 `big` 也不该出现解码痕迹。
    const realToString = Buffer.prototype.toString;
    const decoded: number[] = [];
    Buffer.prototype.toString = function (this: Buffer, encoding?: unknown, begin?: unknown, end?: unknown): string {
      if (typeof begin === 'number' && typeof end === 'number' && end - begin > 1024) decoded.push(end - begin);
      return (realToString as (...a: unknown[]) => string).call(this, encoding, begin, end);
    } as typeof Buffer.prototype.toString;
    try {
      assembleRecord(buffer, '/source.jsonl', SCHEMA);
    } finally {
      Buffer.prototype.toString = realToString;
    }
    expect(decoded).toEqual([]);
  });

  it('重复键与 JSON.parse 同判：键序停在首次，值取最后一次', () => {
    const text = '{"type":"a","type":"b","payload":{"k":1,"k":[2]}}';
    const schema: RecordSchemaNode = {
      read: 'object',
      members: { type: VALUE, payload: { read: 'object', members: { k: VALUE } } },
    };
    const assembled = (assembleRecord(Buffer.from(text, 'utf8'), '/s.jsonl', schema).record) as Record<string, any>;
    expect(assembled.type).toBe('b');
    expect(Object.keys(assembled)).toEqual(['type', 'payload']);
    expect(assembled.payload.k).toEqual([2]);
    expect(Object.keys(assembled.payload)).toEqual(['k']);
  });

  it('声明形状与实际不符时给真实值，不把合法记录判成畸形', () => {
    const text = '{"type":"x","payload":"我不是对象"}';
    const schema: RecordSchemaNode = {
      read: 'object',
      members: { type: VALUE, payload: { read: 'object', members: { k: VALUE } } },
    };
    const result = assembleRecord(Buffer.from(text, 'utf8'), '/s.jsonl', schema);
    expect(result.outcome).toBe('record');
    expect((result.record as Record<string, unknown>).payload).toBe('我不是对象');
  });

  it('合法／畸形／非对象三档判定与 JSON.parse 同判（含语法边角）', () => {
    const texts = [
      '{"type":"t"}', '{"type":"t","payload":{"count":0}}', '{"type":"t","payload":{"count":-1.5e+3}}',
      '{"a":1,"a":2}', '', '   ', '{"a":1,}', '{"a":}', '{a:1}', '[1,2]', '42', '"s"', 'null', '{"a":1} x',
      '{"a":"\\x"}', '{"a":"\\u00"}', '{"a":01}', '{"a":1.}', '{"a":+1}', '{"a":.5}', '{"a":[1,]}',
      '{"a":{"b":}}', '\ufeff{"a":1}', '{"a":"\\u0001"}', '{"a":"\u0001"}', '{"a":{"b":[{\'c\':1}]}}'.replace("'", '"'),
    ];
    for (const text of texts) {
      const buffer = Buffer.from(text, 'utf8');
      let outcome: 'record' | 'malformed' | 'ignored';
      try {
        const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
        outcome = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? 'record' : 'ignored';
      } catch {
        outcome = 'malformed';
      }
      expect(assembleRecord(buffer, '/s.jsonl', SCHEMA).outcome, text).toBe(outcome);
    }
  });

  it('写出侧：span 经重转义后与「解析再序列化」逐字节相同', () => {
    const { buffer, result } = record(LOG);
    const assembled = result.record as Record<string, any>;
    const parsed = JSON.parse(LOG) as Record<string, any>;
    const collected: Buffer[] = [];
    reescapeJsonString(buffer, assembled.payload.output.begin, assembled.payload.output.end, (bytes) => collected.push(bytes));
    expect(Buffer.concat(collected).toString('utf8')).toBe(JSON.stringify(parsed.payload.output));
    expect(assembled.payload.output.begin).toBeLessThan(assembled.payload.output.end);
  });
});
