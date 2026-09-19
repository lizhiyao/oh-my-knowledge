import { describe, expect, it } from 'vitest';
import { windowedRecord } from '../../../src/observability/trace/jsonl-lazy-record.js';

/**
 * 记录视图的等价性靠两条：一是与整档解析逐字相同（streamed-records.test.ts 那条端到端用例已经
 * 钉住），二是「只解真被读到的字段」——后者是 #983 的全部收益来源，也是唯一能被静默改回去的
 * 一件事：把视图换成整条 `JSON.parse`，所有行为用例照样绿，内存斜率却悄悄回到与文件大小同阶。
 * 所以这里数的是「每次解析吃进多少字节」，而不是解析次数：次数会随字段数变，字节数才不会。
 */

function viewOf(line: object | string) {
  const text = typeof line === 'string' ? line : JSON.stringify(line);
  const buffer = Buffer.from(text, 'utf8');
  const windowed = windowedRecord({ bytes: (b: number, len: number) => buffer.subarray(b, b + len) }, 0, buffer.length);
  if (windowed.viewKind !== 'record') throw new Error(`用例前提不成立：${windowed.viewKind}`);
  return windowed.record as Record<string, unknown>;
}

/**
 * 在 `run` 期间记录「有多少字节被解成值」：无转义的字符串走 `Buffer.toString`，其余走
 * `JSON.parse`，两条都要盯——只数 `JSON.parse` 会把快路看成「什么都没解」，那是假绿。
 * 无论成败都还原全局实现。
 */
function decodedSpans(run: () => unknown): number[] {
  const realParse = JSON.parse;
  const realToString = Buffer.prototype.toString;
  const spans: number[] = [];
  JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    spans.push(String(text).length);
    return realParse(text, reviver);
  }) as typeof JSON.parse;
  Buffer.prototype.toString = function (
    this: Buffer,
    encoding?: unknown,
    begin?: unknown,
    end?: unknown,
  ): string {
    if (typeof begin === 'number' && typeof end === 'number') spans.push(end - begin);
    return (realToString as (...a: unknown[]) => string).call(this, encoding, begin, end);
  } as typeof Buffer.prototype.toString;
  try {
    run();
    return spans;
  } finally {
    JSON.parse = realParse;
    Buffer.prototype.toString = realToString;
  }
}

const HUGE = 'x'.repeat(4 * 1024 * 1024);

function codexLine(): object {
  return {
    timestamp: '2026-07-25T00:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call-1',
      output: HUGE,
      encrypted_content: HUGE,
    },
  };
}

describe('记录窗口的按需取值视图', () => {
  it('只读小字段时，没被读到的兄弟字段一个字节都不进解析', () => {
    const record = viewOf(codexLine());
    const spans = decodedSpans(() => {
      const payload = record.payload as Record<string, unknown>;
      return [record.type, payload.type, payload.call_id];
    });
    // 被解出来的只有那几个小字段：一次都没有碰 4 MiB 的兄弟字段。
    expect(spans.reduce((total, span) => total + span, 0)).toBeLessThan(4096);
    expect(JSON.stringify(codexLine()).length).toBeGreaterThan(8 * 1024 * 1024);
  });

  it('取用大字段时按该字段的字节解，且解出的值与整条解析逐字相同', () => {
    const line = codexLine();
    const parsed = JSON.parse(JSON.stringify(line)) as { payload: { output: string } };
    const record = viewOf(line);
    const payload = record.payload as { output: string };
    const spans = decodedSpans(() => payload.output);
    expect(payload.output).toBe(parsed.payload.output);
    // 取用时恰好解这个字段自己的字节：大跨度只有一处（键名等小解码允许若干次），
    // 且不越过字段本身——把整条记录重解一遍会留下第二条同等跨度的记录。
    const big = spans.filter((span) => span > 1024);
    expect(big.map((span) => span > HUGE.length + 64)).toEqual([false]);
    expect(big[0]).toBeGreaterThanOrEqual(HUGE.length - 1);
    // 同尺寸的兄弟字段（encrypted_content）必须一次都没被解：总解码量不得达到两倍。
    expect(spans.reduce((total, span) => total + span, 0)).toBeLessThan(2 * HUGE.length);
  });

  it('视图在键序、属性枚举与序列化上与整条解析同形', () => {
    const line = {
      type: 'event_msg',
      timestamp: '2026-07-25T00:00:00.000Z',
      payload: { type: 'token_count', info: { total_tokens: 12 }, '带空格 键': [1, { deep: null }] },
    };
    const parsed = JSON.parse(JSON.stringify(line)) as Record<string, unknown>;
    const record = viewOf(line);
    expect(Object.keys(record)).toEqual(Object.keys(parsed));
    expect(Object.keys(record.payload as object)).toEqual(Object.keys(parsed.payload));
    expect(JSON.stringify(record)).toBe(JSON.stringify(parsed));
    expect({ ...record }).toEqual(parsed);
    expect('payload' in record).toBe(true);
    expect('missing' in record).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'timestamp')).toBe(true);
    expect(record.missing).toBeUndefined();
    expect(Object.entries(record).map(([key]) => key)).toEqual(['type', 'timestamp', 'payload']);
  });

  it('视图只读：写入、删除与重新定义属性都会响', () => {
    const record = viewOf(codexLine());
    expect(() => {
      (record as Record<string, unknown>).type = 'hijacked';
    }).toThrow(/只读/);
    expect(() => {
      delete (record as Record<string, unknown>).type;
    }).toThrow(/只读/);
    expect(() => {
      Object.defineProperty(record, 'extra', { value: 1 });
    }).toThrow(/只读/);
  });

  it('payload 以下不再是视图：解出来的子树是普通值，不会把整行字节钉住', () => {
    const line = { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'a' }, { text: 'b' }] } };
    const parsed = JSON.parse(JSON.stringify(line)) as Record<string, unknown>;
    const record = viewOf(line);
    const payload = record.payload as Record<string, unknown>;
    // 子树整体落地之后就不再随取用次数变化：同一份对象反复取用应命中同一个值。
    expect(payload.summary).toEqual((parsed.payload as Record<string, unknown>).summary);
    expect(Array.isArray(payload.summary)).toBe(true);
    const summary = payload.summary as Array<{ text: string }>;
    expect(summary.map((item) => item.text)).toEqual(['a', 'b']);
  });

  it('不是对象的记录值与畸形记录各自分类，与整档路径同一口径', () => {
    const buffers = ['[1,2,3]', '"text"', '42', 'null', '{broken', '   ', ''];
    for (const text of buffers) {
      const own = Buffer.from(text, 'utf8');
      const windowed = windowedRecord({ bytes: (b: number, len: number) => own.subarray(b, b + len) }, 0, own.length);
      const parses = (() => {
        try {
          JSON.parse(text);
          return true;
        } catch {
          return false;
        }
      })();
      if (!parses) expect(windowed.viewKind, text).toBe('malformed');
      else if (JSON.parse(text) === null || typeof JSON.parse(text) !== 'object' || Array.isArray(JSON.parse(text))) {
        expect(windowed.viewKind, text).toBe('ignored');
      } else {
        expect(windowed.viewKind, text).toBe('record');
      }
    }
  });
});
