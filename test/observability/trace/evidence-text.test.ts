import { describe, expect, it } from 'vitest';
import { reescapeJsonString } from '../../../src/observability/trace/evidence-text.js';

/**
 * 重转义器的正确性就是「大证据字节直通」的全部风险所在：产物里那段文本必须与
 * 「先 `JSON.parse` 成字符串、再 `JSON.stringify` 写出」逐字节相同，否则等价性判据会破。
 * 所以这里的基准一律取那条「解码再序列化」的路径，而不是手写期望值。
 */

function reescaped(text: string): Buffer {
  const buffer = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  reescapeJsonString(buffer, 0, buffer.length, (bytes) => chunks.push(bytes));
  return Buffer.concat(chunks);
}

/** 基准：整档路径今天做的事。 */
function canonical(text: string): Buffer {
  return Buffer.from(JSON.stringify(JSON.parse(text)), 'utf8');
}

function seededCases(seed: number): string[] {
  let state = seed >>> 0;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const forms = (ch: string): string[] => {
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
  };
  const pool = [...'ab/\\"', '\n', '\t', '\b', '\f', '\r', '\u0001', '\u001f', 'é', '中', '\u00a0', '\u2028', '\u2029',
    '\u007f', '\ufffd', '\u{1f600}', '\u{1f9a0}', '0', ' '];
  const cases: string[] = [];
  for (let index = 0; index < 300; index += 1) {
    const length = Math.floor(rand() * 10);
    let text = '"';
    for (let at = 0; at < length; at += 1) {
      const ch = pool[Math.floor(rand() * pool.length)];
      const options = forms(ch);
      text += options[Math.floor(rand() * options.length)];
    }
    cases.push(`${text}"`);
  }
  return cases;
}

describe('证据文本的字节级重转义', () => {
  it('规则边界与「解码再序列化」逐字节相同', () => {
    const cases = [
      '""',
      '"a"',
      '"\\/slash"',
      '"\\u0041"',
      '"\\u4e2d文"',
      '"\\ud83d\\ude00"',
      '"\\ud83d"',
      '"\\udc00tail"',
      '"\\b\\t\\n\\f\\r"',
      '"\\u0000\\u001f"',
      '"\\u007f\\u0080"',
      '"\\u2028\\u2029"',
      '"é中\u{1f600}"',
      '"has \\"quote\\" and \\\\backslash\\\\"',
      '"\ufffd"',
      '"trailing space "',
      '"\\t\\r\\n inside"',
    ];
    // 裸控制字符在源文本里就是非法 JSON：上游扫描会先挡掉，这里也同判而不是悄悄产出一段坏字节。
    for (const bad of ['"\u0001"', '"\t"']) {
      expect(() => JSON.parse(bad)).toThrow();
      expect(() => reescaped(bad)).toThrow();
    }
    for (const text of cases) {
      expect(reescaped(text).equals(canonical(text)), text).toBe(true);
      expect(reescaped(text).toString('utf8'), text).toBe(JSON.stringify(JSON.parse(text)));
    }
  });

  it('定种子生成的转义组合逐一与基准相同', () => {
    let compared = 0;
    for (const text of seededCases(20260919)) {
      JSON.parse(text); // 语料生成必须只产出合法串，否则这条用例在比错东西。
      expect(reescaped(text).equals(canonical(text)), text).toBe(true);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(250);
  });

  it('原始字节按段直写，不整段重建字符串', () => {
    const chunks: Buffer[] = [];
    const buffer = Buffer.from('"aaaaaaaaaa"', 'utf8');
    reescapeJsonString(buffer, 0, buffer.length, (bytes) => chunks.push(bytes));
    // 一段无转义的正文应只产生「开引号 / 正文 / 闭引号」三块：证据字段可以按块写进产物，
    // 不需要先把整段文本攒成一个 JS 字符串。
    expect(chunks.length).toBe(3);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('"aaaaaaaaaa"');
  });
});
