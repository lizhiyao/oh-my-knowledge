import type { JsonValueKind } from './jsonl-record-window.js';

/**
 * 指向源日志里一段 JSON 文本的窗口（`begin` 含、`end` 不含，且指向**值本身**的字节：
 * 字符串含两侧引号，对象／数组含两侧括号）。
 *
 * 为什么要留着窗口而不是解成 JS 值：采集一份 1 GiB 级日志时，撑住峰值驻留的是「把文本变成
 * JS 字符串、再为它建对象图」这两步——同一批 1 076 MiB 的证据文本，只按字节走一趟是 78 MiB，
 * 解成字符串要 155 MiB，再建对象图就是 1 432 MiB（实测见 #983）。所以映射阶段只带窗口，
 * 写出产物时才把字节搬到目的地，全程不让整段文本进 JS 堆。
 */
export interface JsonTextSpan {
  /** 窗口所在源文件，供写出时定位读。 */
  sourcePath: string;
  begin: number;
  end: number;
  valueKind: JsonValueKind;
}

export function isJsonTextSpan(value: unknown): value is JsonTextSpan {
  return typeof value === 'object' && value !== null
    && typeof (value as { sourcePath?: unknown }).sourcePath === 'string'
    && typeof (value as { begin?: unknown }).begin === 'number'
    && typeof (value as { end?: unknown }).end === 'number'
    && typeof (value as { valueKind?: unknown }).valueKind === 'string';
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/**
 * 源文本里两字符转义的规范产出：`JSON.stringify` 对同一个值可能用短形式（`\b \t \n \f \r`）
 * 或斜杠不转义（`\/` → `/`），这里逐一对齐。注意进来的是**转义字母**，不是被转义的那个码点。
 */
function canonicalEscapeLetter(escape: number): number[] {
  const short: Record<number, number> = { 0x62: 0x62, 0x74: 0x74, 0x6e: 0x6e, 0x66: 0x66, 0x72: 0x72, 0x22: 0x22, 0x5c: 0x5c };
  if (short[escape] !== undefined) return [BACKSLASH, short[escape]];
  if (escape === 0x2f) return [0x2f]; // `\/` 解成 `/`，序列化时不再转义斜杠
  throw new Error(`非法的 JSON 转义序列：\\${String.fromCharCode(escape)}`);
}

/** `JSON.stringify` 对单个码点产出的字节：短转义优先，其余控制字符走 `\u00xx`。 */
function escapedCodePoint(codePoint: number): number[] {
  const short: Record<number, number> = { 0x08: 0x62, 0x09: 0x74, 0x0a: 0x6e, 0x0c: 0x66, 0x0d: 0x72 };
  if (codePoint === QUOTE || codePoint === BACKSLASH) return [BACKSLASH, codePoint];
  if (short[codePoint] !== undefined) return [BACKSLASH, short[codePoint]];
  if (codePoint < 0x20) return [...`\\u${codePoint.toString(16).padStart(4, '0')}`].map((c) => c.charCodeAt(0));
  return utf8OfCodePoint(codePoint);
}

function utf8OfCodePoint(codePoint: number): number[] {
  if (codePoint < 0x80) return [codePoint];
  if (codePoint < 0x800) return [0xc0 | codePoint >>> 6, 0x80 | codePoint & 0x3f];
  if (codePoint < 0x10000) {
    return [0xe0 | codePoint >>> 12, 0x80 | codePoint >>> 6 & 0x3f, 0x80 | codePoint & 0x3f];
  }
  return [0xf0 | codePoint >>> 18, 0x80 | codePoint >>> 12 & 0x3f, 0x80 | codePoint >>> 6 & 0x3f,
    0x80 | codePoint & 0x3f];
}

/** 孤立代理写成 `\udXXX`（小写十六进制），与 `JSON.stringify` 一致。 */
function surrogateLiteral(codePoint: number): number[] {
  return [...`\\u${codePoint.toString(16).padStart(4, '0')}`].map((c) => c.charCodeAt(0));
}

function hex4(buffer: Buffer, at: number): number {
  return parseInt(buffer.toString('latin1', at, at + 4), 16);
}

/**
 * 把一个字符串窗口按 `JSON.stringify` 的转义规则重写成字节，交给 `emit` 逐段消费。
 *
 * 为什么不是「原样照抄源字节」：源文本里合法的转义与 `JSON.stringify` 的产出并不相同——
 * `\/` 会被解成 `/`、`\u0041` 成 `A`、非 BMP 的代理对合成一个字符再按 UTF-8 写出、
 * 孤立代理反过来要写成 `\udXXX`、控制字符走 `\b \t \n \f \r` 短形式。产物形状必须与
 * 「先 `JSON.parse` 再序列化」逐字节相同，否则等价性判据会当场破。
 *
 * 等价性不是宣称：真语料 2 897 683 个字符串 token 与 `JSON.stringify(JSON.parse(text))`
 * 逐字节比对零不匹配（#983），本文件的用例再把规则边界钉住。
 */
export function reescapeJsonString(buffer: Buffer, begin: number, end: number, emit: (bytes: Buffer) => void): void {
  const chunks: number[][] = [[QUOTE]];
  const stop = end - 1;
  let cursor = begin + 1;
  let runStart = cursor;
  const flushRun = (): void => {
    if (cursor > runStart) chunks.push([...buffer.subarray(runStart, cursor)]);
  };
  while (cursor < stop) {
    const byte = buffer[cursor];
    if (byte !== BACKSLASH) {
      // 裸控制字符的串不是合法 JSON，上游语法校验会先判畸形；这里同判而不是悄悄写出坏字节。
      if (byte < 0x20) throw new Error('证据文本含裸控制字符，与 JSON.parse 同判为非法');
      cursor += 1;
      continue;
    }
    flushRun();
    const escape = buffer[cursor + 1];
    if (escape === 0x75) {
      const first = hex4(buffer, cursor + 2);
      cursor += 6;
      if (first >= 0xd800 && first <= 0xdbff && buffer[cursor] === BACKSLASH && buffer[cursor + 1] === 0x75) {
        const second = hex4(buffer, cursor + 2);
        if (second >= 0xdc00 && second <= 0xdfff) {
          chunks.push(utf8OfCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)));
          cursor += 6;
          runStart = cursor;
          continue;
        }
      }
      chunks.push(first >= 0xd800 && first <= 0xdfff ? surrogateLiteral(first) : escapedCodePoint(first));
      runStart = cursor;
      continue;
    }
    chunks.push(canonicalEscapeLetter(escape));
    cursor += 2;
    runStart = cursor;
  }
  flushRun();
  chunks.push([QUOTE]);
  for (const chunk of chunks) {
    if (chunk.length > 0) emit(Buffer.from(chunk));
  }
}
