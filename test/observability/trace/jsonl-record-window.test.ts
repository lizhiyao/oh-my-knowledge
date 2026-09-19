import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  arrayItems,
  decodedCharLength,
  memberPath,
  memberWindow,
  objectMembers,
  readString,
  readValue,
  scanJsonValue,
  stringIsNonEmpty,
  trimmedCharLength,
  type JsonWindow,
} from '../../../src/observability/trace/jsonl-record-window.js';

/**
 * 这一层的全部价值都押在一条承诺上：按需取到的字段值与「整条 `JSON.parse` 之后取属性」逐字相同。
 * 所以这里的断言一律以「同一份字节 → `toString` → `JSON.parse`」为基准（那正是整档路径做的事），
 * 而不是手写期望值；语料用定种子生成器铺开转义风格、重复键、多字节与深嵌套，
 * 保证跑出来的比对是逐字段的穷举，不是抽样。
 */

type Rand = () => number;

function makeRand(seed: number): Rand {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rand: Rand, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)];
}

/** 只用空格／制表／回车：换行会终结一行，真实记录里不可能出现。 */
function blank(rand: Rand): string {
  if (rand() < 0.4) return '';
  let text = '';
  const count = 1 + Math.floor(rand() * 3);
  for (let index = 0; index < count; index += 1) text += pick(rand, [' ', '\t', '\r']);
  return text;
}

const KEY_POOL = ['a', 'type', 'payload', 'b', '', '__proto__', 'constructor', 'toString', 'x y', 'é', '中', '/', '"', '\\'];

/** 一个字符可能出现的 JSON 文本形式：原始字节、`\uXXXX`、`\/`、代理对、短转义。 */
function charForms(ch: string): string[] {
  const code = ch.codePointAt(0)!;
  if (ch === '"') return ['\\"'];
  if (ch === '\\') return ['\\\\'];
  if (ch === '/') return ['/', '\\/'];
  if (code < 0x20) {
    const short: Record<number, string> = { 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r' };
    return short[code] ? [short[code], `\\u${code.toString(16).padStart(4, '0')}`] : [`\\u${code.toString(16).padStart(4, '0')}`];
  }
  if (code > 0xffff) {
    const high = 0xd800 + ((code - 0x10000) >> 10);
    const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
    return [ch, `\\u${high.toString(16)}\\u${low.toString(16)}`];
  }
  return [ch, `\\u${code.toString(16).padStart(4, '0')}`];
}

const CHAR_POOL = [...'ab/\\"', '\n', '\t', '\b', '\f', '\r', '\u0001', 'é', '中', '\u00a0', '\u2028', '\u20ac', '\ufffd',
  '\ud83d\ude00', '\u{1f9a0}', '0', '-', '.', ' ', '\u0000'];

function emitString(rand: Rand): string {
  const count = Math.floor(rand() * 8);
  let text = '"';
  for (let index = 0; index < count; index += 1) {
    const ch = pick(rand, CHAR_POOL);
    text += ch === '\ud83d\ude00' ? pick(rand, charForms('\u{1f600}')) : pick(rand, charForms(ch));
  }
  return `${text}"`;
}

const NUMBER_POOL = ['0', '-0', '0.5', '1', '-1', '1e3', '1E+3', '1e-3', '123456789012345678901234567890', '-0.0',
  '100', '0e0', '3.141592653589793', '-1e21', '5e-324', '1e400'];

function emitValue(rand: Rand, depth: number): string {
  // 顶层固定为对象：真实记录都是对象，且只有对象才穷举得到 memberPath 的键路径。
  const kinds = depth === 0
    ? ['object']
    : depth >= 3
      ? ['string', 'number', 'literal']
      : ['string', 'number', 'literal', 'object', 'array'];
  switch (pick(rand, kinds)) {
    case 'string':
      return emitString(rand);
    case 'number':
      return pick(rand, NUMBER_POOL);
    case 'literal':
      return pick(rand, ['true', 'false', 'null']);
    case 'array': {
      if (rand() < 0.15) return `[${blank(rand)}]`;
      const items: string[] = [];
      const count = 1 + Math.floor(rand() * 3);
      for (let index = 0; index < count; index += 1) items.push(emitValue(rand, depth + 1));
      return `[${blank(rand)}${items.join(`,${blank(rand)}`)}${blank(rand)}]`;
    }
    default: {
      if (rand() < 0.15) return `{${blank(rand)}}`;
      const members: { key: string; value: string }[] = [];
      const count = 1 + Math.floor(rand() * 4);
      for (let index = 0; index < count; index += 1) {
        members.push({ key: emitString(rand), value: emitValue(rand, depth + 1) });
      }
      if (rand() < 0.3 && members.length > 1) {
        // 重复键：同一份键文本再出现一次，但值必须不同，否则测不出「后写胜出」。
        members.push({ key: members[0].key, value: emitValue(rand, depth + 1) });
      }
      const parts = members.map((member) => `${member.key}:${blank(rand)}${member.value}`);
      return `{${blank(rand)}${parts.join(`,${blank(rand)}`)}${blank(rand)}}`;
    }
  }
}

/** 基准：整档路径就是「字节 → toString → JSON.parse」，这里逐字照抄那条路。 */
function oracle(buffer: Buffer): unknown {
  return JSON.parse(buffer.toString('utf8'));
}

function windowOf(buffer: Buffer, path: readonly (string | number)[]): JsonWindow {
  const top = scanJsonValue(buffer, 0, buffer.length);
  if (!top) throw new Error('顶层值校验失败');
  const found = memberPath(buffer, top, path);
  if (!found) throw new Error(`路径没有窗口：${JSON.stringify(path)}`);
  return found;
}

function pathsOf(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  const found: (string | number)[][] = [prefix];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...pathsOf(item, [...prefix, index])));
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      found.push(...pathsOf((value as Record<string, unknown>)[key], [...prefix, key]));
    }
  }
  return found;
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((current, segment) => (current as Record<string | number, unknown>)[segment], value);
}

function generatedTexts(count: number, seed: number): string[] {
  const rand = makeRand(seed);
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    texts.push(`${blank(rand)}${emitValue(rand, 0)}${blank(rand)}`);
  }
  return texts;
}

describe('记录字节窗口的按需取值读取层', () => {
  it('逐字段解出的值与整条 JSON.parse 逐项相等（生成语料穷举每条路径）', () => {
    let compared = 0;
    for (const text of generatedTexts(400, 20260919)) {
      const buffer = Buffer.from(text, 'utf8');
      const parsed = oracle(buffer);
      const top = scanJsonValue(buffer, 0, buffer.length);
      expect(top, text).toBeDefined();
      for (const path of pathsOf(parsed)) {
        compared += 1;
        expect(readValue(buffer, windowOf(buffer, path))).toEqual(valueAt(parsed, path));
      }
    }
    // 比对条数本身也要断言：生成器退化成语义平凡的记录（例如只吐 `{}`）时，这条穷举就成了空转。
    // 门限按当前种子实际跑出的 2 513 条留三成余量，改种子／改生成器时要一起看这一行。
    expect(compared).toBeGreaterThan(1800);
  });

  it('每个前缀的语法判定与 JSON.parse 同判（合法／畸形不因扫描而分叉）', () => {
    const checked = { accept: 0, reject: 0 };
    const probe = (text: string): void => {
      const buffer = Buffer.from(text, 'utf8');
      let parses = true;
      try {
        JSON.parse(buffer.toString('utf8'));
      } catch {
        parses = false;
      }
      const scanned = scanJsonValue(buffer, 0, buffer.length) !== undefined;
      expect(scanned, `前缀 ${JSON.stringify(text)}`).toBe(parses);
      if (parses) checked.accept += 1;
      else checked.reject += 1;
    };
    for (const text of generatedTexts(24, 777)) {
      for (let cut = 0; cut <= text.length; cut += 1) probe(text.slice(0, cut));
    }
    // 两侧都要有足够样本，否则「同判」可能只是「双双全判错」。
    // 两侧都要有足够样本，否则「同判」可能只是「双双全判错」。门限同样按实测分布留余量：
    // 当前种子是接受 50／拒绝 2 千多级，所以接受侧压到 35、拒绝侧压在 2 万分之一以下没意义。
    expect(checked.accept).toBeGreaterThan(35);
    expect(checked.reject).toBeGreaterThan(240);
  });

  it('非法转义、控制字符与越界字面量判为畸形，与 JSON.parse 同判', () => {
    const rejected = [
      '', '   ', '{"a":1,}', '[1,]', '{1:2}', '{"a":"\\x"}', '{"a":"\\u00"}', '{"a":1}x', '01', '1.', '.5', '+1', 'NaN',
      'Infinity', '[1 2]', '{"a"}', '{"a":}', '["\\u00e9"', '"abc', '{"a":"\u0001"}', '[truefal]', '-0.0.0',
      '{"a":tru)}', '1 2', '\ufeff{}',
    ];
    // 转义形式的孤立代理是合法的（ES2019 起 JSON.parse 接受），必须放在接受侧。
    const accepted = [
      '"\\u0041"', '"\\uD800"', '{"a":1,"a":2}', '[-0]', '1e400', 'true', 'null', '{"":0}', '[[]]', '{ }', '[]',
      '{"a":"\\/"}', '"\\u2028"', '{"a":"\\u0001"}', '[0E+0]', '{"é":1}', '-0.0',
    ];
    for (const text of rejected) {
      const buffer = Buffer.from(text, 'utf8');
      expect(() => JSON.parse(buffer.toString('utf8'))).toThrow();
      expect(scanJsonValue(buffer, 0, buffer.length), text).toBeUndefined();
    }
    for (const text of accepted) {
      const buffer = Buffer.from(text, 'utf8');
      const parsed = oracle(buffer);
      const window = scanJsonValue(buffer, 0, buffer.length);
      expect(window, text).toBeDefined();
      expect(readValue(buffer, window!)).toEqual(parsed);
    }
  });

  it('重复键按 JSON.parse 的建键语义：键序停在首次，值取最后一次', () => {
    const buffer = Buffer.from('{"a":1,"b":2,"a":3,"c":4}', 'utf8');
    const top = scanJsonValue(buffer, 0, buffer.length)!;
    expect(objectMembers(buffer, top).map((member) => readString(buffer, member.key))).toEqual(['a', 'b', 'c']);
    expect(readValue(buffer, memberWindow(buffer, top, 'a')!)).toBe(3);
    expect(objectMembers(buffer, top).map((member) => readValue(buffer, member.value))).toEqual([3, 2, 4]);
    // 顶层整条解析同样是 {a:3,b:2,c:4}：键序与取值两件事都得一致。
    expect(readValue(buffer, top)).toEqual({ a: 3, b: 2, c: 4 });
    expect(Object.keys(readValue(buffer, top) as object)).toEqual(['a', 'b', 'c']);
  });

  it('键文本按原样解码：带转义的键与目标键同判', () => {
    const buffer = Buffer.from('{"\\u0061":1,"\\/":2,"b\\u0007":3}', 'utf8');
    const top = scanJsonValue(buffer, 0, buffer.length)!;
    expect(readValue(buffer, memberWindow(buffer, top, 'a')!)).toBe(1);
    expect(readValue(buffer, memberWindow(buffer, top, '/')!)).toBe(2);
    expect(readValue(buffer, memberWindow(buffer, top, 'b\u0007')!)).toBe(3);
    expect(memberWindow(buffer, top, 'nope')).toBeUndefined();
  });

  it('数组与对象窗口在类型不符／路径缺失时返回 undefined 或空表', () => {
    const buffer = Buffer.from('{"a":[1,2,3],"b":{"c":null},"n":1}', 'utf8');
    const top = scanJsonValue(buffer, 0, buffer.length)!;
    expect(arrayItems(buffer, memberWindow(buffer, top, 'a')!).map((item) => readValue(buffer, item))).toEqual([1, 2, 3]);
    expect(memberPath(buffer, top, ['a', 1])).toBeDefined();
    expect(readValue(buffer, memberPath(buffer, top, ['a', 1])!)).toBe(2);
    expect(memberPath(buffer, top, ['a', 9])).toBeUndefined();
    expect(memberPath(buffer, top, ['n', 0])).toBeUndefined();
    expect(memberPath(buffer, top, ['missing'])).toBeUndefined();
    expect(memberPath(buffer, top, ['b', 'deeper'])).toBeUndefined();
    expect(readValue(buffer, memberPath(buffer, top, ['b', 'c'])!)).toBeNull();
    expect(arrayItems(buffer, memberWindow(buffer, top, 'b')!)).toEqual([]);
  });

  it('只问有无内容的大字段不必修出值：与解出来判非空同判', () => {
    const buffer = Buffer.from('{"a":"","b":" ","c":"\\u0041","d":0,"e":[],"f":null}', 'utf8');
    const top = scanJsonValue(buffer, 0, buffer.length)!;
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const window = memberWindow(buffer, top, key)!;
      const decoded = readValue(buffer, window);
      // 口径取 stringValue(x) 的真值：非字符串一律折算成空串，只有「解出来非空的字符串」才为真。
      const truthy = typeof decoded === 'string' && decoded.length > 0;
      expect(stringIsNonEmpty(window), key).toBe(truthy);
    }
  });

  it('字符串窗口的 UTF-16 单元数与解码后的长度一致（含代理对与非法字节）', () => {
    const rand = makeRand(4242);
    for (const text of generatedTexts(300, 4242)) {
      const buffer = Buffer.from(text, 'utf8');
      const parsed = oracle(buffer);
      for (const path of pathsOf(parsed)) {
        const value = valueAt(parsed, path);
        if (typeof value !== 'string') continue;
        expect(decodedCharLength(buffer, windowOf(buffer, path)), `${text} @ ${path.join('.')}`).toBe(value.length);
      }
    }
    // 非法 UTF-8 只能按字节构造：解码成替换字符之后长度会变，这里把这条边界也铺上样本。
    const corrupt: number[][] = [[0x22, 0x80, 0x22], [0x22, 0xff, 0xff, 0x22], [0x22, 0xc3, 0x22], [0x22, 0xf0, 0x9f, 0x9a, 0x22],
      [0x22, 0xed, 0xa0, 0x80, 0x22], [0x22, 0xe2, 0x28, 0xa1, 0x22], [0x22, 0xf5, 0x80, 0x80, 0x80, 0x22]];
    for (const bytes of corrupt) {
      const buffer = Buffer.from(bytes);
      const window = scanJsonValue(buffer, 0, buffer.length)!;
      expect(window.valueKind).toBe('string');
      expect(decodedCharLength(buffer, window)).toBe(readString(buffer, window).length);
    }
    for (const bytes of corrupt) {
      const buffer = Buffer.from([...bytes, 0x20, 0x20, 0xc3]);
      expect(trimmedCharLength(buffer, 0, buffer.length)).toBe(buffer.toString('utf8').trimEnd().length);
      void rand;
    }
  });

  it('整行字符长度按字节算，与先解成字符串再 trimEnd 的结果一致', () => {
    const tails = ['', ' ', '\t', '\r', '  \t\r', '\u000b', '\u000c', '\u00a0', '\u2028', '\u2029', '\u2007', '\u205f',
      '\u3000', '\ufeff', '\u1680', '\u0085', '\u0085 ', ' \r\n'];
    for (const tail of tails) {
      for (const body of ['{"a":1}', '"é中"', '123', '[]', '中\ud83d\ude00']) {
        const text = `${body}${tail}`;
        const buffer = Buffer.from(text, 'utf8');
        expect(trimmedCharLength(buffer, 0, buffer.length), JSON.stringify(text)).toBe(
          buffer.toString('utf8').trimEnd().length,
        );
      }
    }
    // 定种子随机字节：把「非法序列不能被当成空白」这条也压一遍。
    const rand = makeRand(31337);
    for (let sample = 0; sample < 400; sample += 1) {
      const length = 1 + Math.floor(rand() * 24);
      const bytes = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(rand() * 256);
      expect(trimmedCharLength(bytes, 0, bytes.length)).toBe(bytes.toString('utf8').trimEnd().length);
    }
  });

  it('仓库真实样本的每条记录逐字段等价', () => {
    const fixture = readFileSync(new URL('../../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url), 'utf8');
    const lines = fixture.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    let paths = 0;
    for (const line of lines) {
      const buffer = Buffer.from(line, 'utf8');
      const parsed = oracle(buffer);
      for (const path of pathsOf(parsed)) {
        paths += 1;
        expect(readValue(buffer, windowOf(buffer, path))).toEqual(valueAt(parsed, path));
      }
    }
    expect(paths).toBeGreaterThan(lines.length);
  });
});
