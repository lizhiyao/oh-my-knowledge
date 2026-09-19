/**
 * 记录字节窗口上的按需取值读取层（#983）。
 *
 * 采集一份 1 GiB 级会话日志时，撑住内存斜率的不是遍历遍数，而是「逐条把记录解成 JS 对象」：
 * 同一套偏移扫描与逐行读，只做字节扫是 56 MiB，整行解成字符串是 134 MiB，再加上 `JSON.parse`
 * 就是与文件大小同阶的 1 400～1 503 MiB（见 streamed-records.ts 头注与 #983 那张对照表）。
 * 这一层把最后那一步换成「先只校验语法、只定位需要字段的字节窗口，值再单独解」。
 *
 * 保真的关键是分工：**字节层只回答结构与语法，从不解释 JSON 的值**。一个字段最终解成什么，
 * 由 `JSON.parse` 吃那一段字节窗口决定——而那段字节与整条记录里该字节的文本逐字节相同，
 * 所以转义、`\u`、代理对、多字节、数字字面量、深嵌套的解码结果不可能与整条解析分叉。
 * 本层的正确性要求因此收敛成一条：**窗口边界必须落在整条解析所看到的那段文本上**。据此：
 *
 * - 语法逐项校验（对象键必须是字符串、成员与元素不能为空、数字不允许前导零／`+`／`NaN`、
 *   串内裸控制字符与非法转义序列都判失败），使「扫描失败」与「`JSON.parse` 抛错」对同一份
 *   字节同判——三档计数里的畸形记录口径不能靠调用顺序凑齐。
 * - 重复键后写胜出，且键序停在首次出现位置：这两条一起照搬 `JSON.parse` 的建键语义。
 * - 记录字节只存在于调用方传入的那段缓冲里，本层不留任何跨记录的状态。
 */

const QUOTE = 0x22;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const BACKSLASH = 0x5c;
const LOWER_B = 0x62;
const LOWER_E = 0x65;
const LOWER_F = 0x66;
const LOWER_N = 0x6e;
const LOWER_R = 0x72;
const LOWER_T = 0x74;
const LOWER_U = 0x75;
const LBRACE = 0x7b;
const RBRACE = 0x7d;

export type JsonValueKind = 'object' | 'array' | 'string' | 'number' | 'literal';

/** 一段合法 JSON 值的字节边界：`begin` 含、`end` 不含，区间内不含首尾空白。 */
export interface JsonWindow {
  valueKind: JsonValueKind;
  begin: number;
  end: number;
}

export interface JsonObjectMember {
  /** 键的字节窗口，含两侧引号；需要键文本时用 readValue。 */
  key: JsonWindow;
  value: JsonWindow;
}

/** 串外空白：JSON 只认这四类，串内的裸控制字符另判非法，两个集合不能合成一个。 */
function isBlank(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function skipBlank(buffer: Buffer, at: number, limit: number): number {
  let cursor = at;
  while (cursor < limit && isBlank(buffer[cursor])) cursor += 1;
  return cursor;
}

function isHex(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66) || (byte >= 0x41 && byte <= 0x46);
}

/**
 * 跳过字符串字面量，返回收尾引号之后的位置；未闭合、含裸控制字符或含非法转义时返回 -1。
 * 只跳不解：转义的具体值留给 `JSON.parse`，这里只判定语法是否成立。
 */
function scanString(buffer: Buffer, at: number, limit: number): number {
  let cursor = at + 1;
  for (;;) {
    if (cursor >= limit) return -1;
    const byte = buffer[cursor];
    if (byte === QUOTE) return cursor + 1;
    if (byte === BACKSLASH) {
      const escape = buffer[cursor + 1];
      if (escape === LOWER_U) {
        for (let index = 0; index < 4; index += 1) {
          if (!isHex(buffer[cursor + 2 + index])) return -1;
        }
      } else if (
        escape !== QUOTE && escape !== BACKSLASH && escape !== 0x2f && escape !== LOWER_B && escape !== LOWER_F &&
        escape !== LOWER_N && escape !== LOWER_R && escape !== LOWER_T
      ) {
        return -1;
      }
      cursor += escape === LOWER_U ? 6 : 2;
      continue;
    }
    // 串内裸 <0x20：`JSON.parse` 在此抛错，这里必须同样判失败，否则同一条记录会在两条路上
    // 分别是「合法」与「畸形」，三档计数就此分叉。
    if (byte < 0x20) return -1;
    cursor += 1;
  }
}

/** 校验数字字面量并返回结束位置（RFC 8259 语法：不允许前导零、`+`、`.5`、`1.`、`NaN`）。 */
function scanNumber(buffer: Buffer, at: number, limit: number): number {
  let cursor = at;
  if (buffer[cursor] === MINUS) cursor += 1;
  const lead = buffer[cursor];
  if (lead === undefined) return -1;
  if (lead === ZERO) {
    cursor += 1;
  } else if (lead > ZERO && lead <= NINE) {
    while (cursor < limit && buffer[cursor] >= ZERO && buffer[cursor] <= NINE) cursor += 1;
  } else {
    return -1;
  }
  if (buffer[cursor] === DOT) {
    cursor += 1;
    if (!isDigit(buffer[cursor])) return -1;
    while (cursor < limit && isDigit(buffer[cursor])) cursor += 1;
  }
  if (buffer[cursor] === LOWER_E || buffer[cursor] === 0x45) {
    cursor += 1;
    if (buffer[cursor] === MINUS || buffer[cursor] === 0x2b) cursor += 1;
    if (!isDigit(buffer[cursor])) return -1;
    while (cursor < limit && isDigit(buffer[cursor])) cursor += 1;
  }
  return cursor;
}

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= ZERO && byte <= NINE;
}

/** 校验 `true`／`false`／`null` 并返回结束位置；不匹配返回 -1。 */
function scanWord(buffer: Buffer, at: number, limit: number, word: string): number {
  if (at + word.length > limit) return -1;
  for (let index = 0; index < word.length; index += 1) {
    if (buffer[at + index] !== word.charCodeAt(index)) return -1;
  }
  return at + word.length;
}

/** 容器之内的一个值：`begin` 处开始，校验完整子树，返回其字节窗口；非法返回 undefined。 */
function scanInnerValue(buffer: Buffer, begin: number, limit: number): JsonWindow | undefined {
  const cursor = skipBlank(buffer, begin, limit);
  if (cursor >= limit) return undefined;
  const lead = buffer[cursor];
  if (lead === QUOTE) {
    const end = scanString(buffer, cursor, limit);
    return end < 0 ? undefined : { valueKind: 'string', begin: cursor, end };
  }
  if (lead === LBRACE || lead === LBRACKET) {
    const end = scanContainer(buffer, cursor, limit, lead === LBRACE ? RBRACE : RBRACKET);
    return end < 0 ? undefined : { valueKind: lead === LBRACE ? 'object' : 'array', begin: cursor, end };
  }
  if (lead === MINUS || isDigit(lead)) {
    const end = scanNumber(buffer, cursor, limit);
    return end < 0 || end === cursor ? undefined : { valueKind: 'number', begin: cursor, end };
  }
  const word = lead === LOWER_T ? 'true' : lead === LOWER_F ? 'false' : lead === LOWER_N ? 'null' : '';
  if (!word) return undefined;
  const end = scanWord(buffer, cursor, limit, word);
  return end < 0 ? undefined : { valueKind: 'literal', begin: cursor, end };
}

/** 校验容器并返回闭合符之后的位置；`members` 给了就顺带收集成员（对象为键值对，数组为元素窗口）。 */
type MemberSink = JsonObjectMember[] | JsonWindow[];

function scanContainer(buffer: Buffer, at: number, limit: number, closer: number, members?: MemberSink): number {
  const isArray = closer === RBRACKET;
  let cursor = skipBlank(buffer, at + 1, limit);
  if (buffer[cursor] === closer) return cursor + 1;
  for (;;) {
    const start = skipBlank(buffer, cursor, limit);
    if (isArray) {
      const value = scanInnerValue(buffer, start, limit);
      if (!value) return -1;
      (members as JsonWindow[] | undefined)?.push(value);
      cursor = value.end;
    } else {
      if (buffer[start] !== QUOTE) return -1;
      const keyEnd = scanString(buffer, start, limit);
      if (keyEnd < 0) return -1;
      const key: JsonWindow = { valueKind: 'string', begin: start, end: keyEnd };
      const colon = skipBlank(buffer, keyEnd, limit);
      if (buffer[colon] !== COLON) return -1;
      const value = scanInnerValue(buffer, colon + 1, limit);
      if (!value) return -1;
      (members as JsonObjectMember[] | undefined)?.push({ key, value });
      cursor = value.end;
    }
    const next = skipBlank(buffer, cursor, limit);
    if (buffer[next] === closer) return next + 1;
    if (buffer[next] !== COMMA) return -1;
    cursor = next + 1;
  }
}

/**
 * 校验 `from`～`limit` 之间的**一个完整** JSON 值。值之后只能跟串外空白，
 * 否则整档路径会抛 `SyntaxError`，这里也必须返回 undefined。
 */
export function scanJsonValue(buffer: Buffer, from: number, limit: number): JsonWindow | undefined {
  const value = scanInnerValue(buffer, from, limit);
  if (!value) return undefined;
  return skipBlank(buffer, value.end, limit) === limit ? value : undefined;
}

/**
 * 对象窗口的成员表：顺序与键文本对齐 `JSON.parse` 的建键顺序，重复键只留一条、
 * 但取**最后一次**出现的值窗口——`JSON.parse` 就是按序建键后写覆盖前值。
 */
export function objectMembers(buffer: Buffer, window: JsonWindow): JsonObjectMember[] {
  if (window.valueKind !== 'object') return [];
  const raw: JsonObjectMember[] = [];
  if (scanContainer(buffer, window.begin, window.end, RBRACE, raw) !== window.end) return [];
  const order: string[] = [];
  const latest = new Map<string, JsonObjectMember>();
  for (const member of raw) {
    const name = readString(buffer, member.key);
    if (!latest.has(name)) order.push(name);
    latest.set(name, member);
  }
  return order.map((name) => latest.get(name)!);
}

/** 对象窗口里某个键的值窗口；键不存在或该层不是对象返回 undefined。重复键取最后一次出现。 */
export function memberWindow(buffer: Buffer, window: JsonWindow, key: string): JsonWindow | undefined {
  if (window.valueKind !== 'object') return undefined;
  let found: JsonWindow | undefined;
  let cursor = skipBlank(buffer, window.begin + 1, window.end);
  if (buffer[cursor] === RBRACE) return undefined;
  for (;;) {
    const keyStart = skipBlank(buffer, cursor, window.end);
    if (buffer[keyStart] !== QUOTE) return undefined;
    const keyEnd = scanString(buffer, keyStart, window.end);
    if (keyEnd < 0) return undefined;
    const colon = skipBlank(buffer, keyEnd, window.end);
    if (buffer[colon] !== COLON) return undefined;
    const value = scanInnerValue(buffer, colon + 1, window.end);
    if (!value) return undefined;
    if (keyEquals(buffer, keyStart, keyEnd, key)) found = value;
    const next = skipBlank(buffer, value.end, window.end);
    if (buffer[next] === RBRACE) return found;
    if (buffer[next] !== COMMA) return undefined;
    cursor = next + 1;
  }
}

/** 沿键路径下钻；任一层缺失或类型不符返回 undefined。数组下标用数字段。 */
export function memberPath(buffer: Buffer, window: JsonWindow, path: readonly (string | number)[]): JsonWindow | undefined {
  let current: JsonWindow | undefined = window;
  for (const segment of path) {
    if (!current) return undefined;
    if (typeof segment === 'number') {
      if (current.valueKind !== 'array') return undefined;
      const items = arrayItems(buffer, current);
      current = items[segment];
      continue;
    }
    current = memberWindow(buffer, current, segment);
  }
  return current;
}

/** 数组窗口的元素窗口（含语法校验）；该层不是数组或校验失败返回空表。 */
export function arrayItems(buffer: Buffer, window: JsonWindow): JsonWindow[] {
  if (window.valueKind !== 'array') return [];
  const items: JsonWindow[] = [];
  return scanContainer(buffer, window.begin, window.end, RBRACKET, items) === window.end ? items : [];
}

/**
 * 解出一个窗口的值。字符串走「无转义直接按字节解、含转义交给 `JSON.parse`」；
 * 其余类型一律 `JSON.parse` 那一段字节，因此与整条解析逐字相同。
 */
export function readValue(buffer: Buffer, window: JsonWindow): unknown {
  if (window.valueKind === 'string') return readString(buffer, window);
  return JSON.parse(buffer.toString('utf8', window.begin, window.end));
}

export function readString(buffer: Buffer, window: JsonWindow): string {
  const begin = window.begin + 1;
  const end = window.end - 1;
  if (isPlainStringSpan(buffer, begin, end)) return buffer.toString('utf8', begin, end);
  return JSON.parse(buffer.toString('utf8', window.begin, window.end)) as string;
}

/** 该区间是否「已经是值的文本」：不含引号、反斜杠与裸控制字符，因而可以跳过一次 `JSON.parse`。 */
function isPlainStringSpan(buffer: Buffer, begin: number, end: number): boolean {
  for (let cursor = begin; cursor < end; cursor += 1) {
    const byte = buffer[cursor];
    if (byte === BACKSLASH || byte === QUOTE || byte < 0x20) return false;
  }
  return true;
}

/**
 * 该串窗口解出来是否非空。判据就是「引号之间有没有字节」：一个字符都不需要解，
 * 因为合法 JSON 串里非空的字节内容必然解出非空的值。空白串算非空，与
 * `stringValue(record.payload?.x)` 真值判定同口径——这条是给「只问有没有、不问是什么」
 * 的大字段用的，省掉整段解码。
 */
export function stringIsNonEmpty(window: JsonWindow): boolean {
  return window.valueKind === 'string' && window.end - window.begin > 2;
}

/**
 * 该字符串窗口解成 JS 字符串后有多少个 UTF-16 单元：逐字节数码点、非 BMP 各记两个，
 * 与 `Buffer.toString('utf8')` 的替换行为对齐，因而不必先把整段解成字符串。
 * 只在「消费方拿这个数当证据字段」时使用；那种字段值本身就是这个数，多算一个字节都会改产物。
 */
export function decodedCharLength(buffer: Buffer, window: JsonWindow): number {
  return countChars(buffer, window.begin + 1, window.end - 1, true);
}

/** 一个前导字节所声明的序列宽度；不构成任何合法前导时返回 1（按一个替换字符处理）。 */
function expectedSequenceWidth(lead: number | undefined): number {
  if (lead === undefined) return 0;
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

/**
 * 一个 UTF-8 单元解出多少个 JS 字符、吃掉多少字节——按 WHATWG 的错误处理：
 * 前导字节非法，或次字节越出最短形式／代理区限定的范围，就吃掉前导字节本身；
 * 更后面的续接字节非法或被输入截断，则把「已经吃下的合法前缀」整体折成一个替换字符，
 * 那个非法字节留给下一轮重新判。逐字节各吐一个替换字符会把长度算多。
 */
function utf8Unit(buffer: Buffer, at: number, limit: number): [chars: number, consumed: number] {
  const lead = buffer[at];
  const width = expectedSequenceWidth(lead);
  if (width <= 1) return [1, 1];
  // 0xE0 的次字节从 A0 起、0xED 到 9F 止，0xF0 从 90 起、0xF4 到 8F 止：排除非最短形式与代理区。
  const subLow = lead === 0xe0 ? 0xa0 : lead === 0xf0 ? 0x90 : 0x80;
  const subHigh = lead === 0xed ? 0x9f : lead === 0xf4 ? 0x8f : 0xbf;
  for (let index = 1; index < width; index += 1) {
    if (at + index >= limit) return [1, limit - at];
    const byte = buffer[at + index];
    const valid = index === 1 ? byte >= subLow && byte <= subHigh : byte >= 0x80 && byte <= 0xbf;
    if (!valid) return [1, index];
  }
  return [width === 4 ? 2 : 1, width];
}

/** 该位置的完整合法序列宽度；不完整或非法一律返回 0（调用方不把它当任何码点）。 */
function utf8SequenceLength(buffer: Buffer, at: number, limit: number): number {
  const width = expectedSequenceWidth(buffer[at]);
  const [, consumed] = utf8Unit(buffer, at, limit);
  return consumed === width ? width : 0;
}

function countChars(buffer: Buffer, from: number, to: number, escapeAware: boolean): number {
  let total = 0;
  let cursor = from;
  while (cursor < to) {
    if (escapeAware && buffer[cursor] === BACKSLASH) {
      // 转义序列解出来恰好一个 UTF-16 单元：`\n` 两字节一个单元，`\uD83D` 六字节一个单元，
      // 代理对是两个 `\uXXXX`、两个单元，所以按「一个转义＝一个单元」数即可。
      total += 1;
      cursor += buffer[cursor + 1] === LOWER_U ? 6 : 2;
      continue;
    }
    const [chars, consumed] = utf8Unit(buffer, cursor, to);
    total += chars;
    cursor += Math.max(consumed, 1);
  }
  return total;
}

/**
 * `String.prototype.trim` 会去掉的多字节空白码点。单字节那部分（空格与 0x09～0x0d）另走快判，
 * 不进这张表。U+0085 与 U+00AD 看着像空白但不在 trim 集内，别顺手加进来。
 */
const BLANK_CODE_POINTS: readonly (readonly [codePoint: number, width: number])[] = [
  [0x3000, 3], [0x205f, 3], [0x200a, 3], [0x2009, 3], [0x2008, 3], [0x2007, 3], [0x2006, 3], [0x2005, 3], [0x2004, 3],
  [0x2003, 3], [0x2002, 3], [0x2001, 3], [0x2000, 3], [0x202f, 3], [0x2029, 3], [0x2028, 3], [0x1680, 3], [0xfeff, 3],
  [0xa0, 2],
];

/**
 * 行切片去掉结尾空白后的字符长度——与整档路径那句 `text.trimEnd().length` 同一口径，
 * 但全程按字节走，不为此把整行解成字符串。结尾空白从后往前判，判不动就停。
 */
export function trimmedCharLength(buffer: Buffer, from: number, to: number): number {
  let end = to;
  for (;;) {
    const width = trailingBlankWidth(buffer, from, end);
    if (width === 0) break;
    end -= width;
  }
  return countChars(buffer, from, end, false);
}

function trailingBlankWidth(buffer: Buffer, from: number, end: number): number {
  if (end <= from) return 0;
  const last = buffer[end - 1];
  if (last === 0x20 || (last >= 0x09 && last <= 0x0d)) return 1;
  if (last < 0x80) return 0;
  for (const [codePoint, width] of BLANK_CODE_POINTS) {
    if (end - from < width) continue;
    if (decodeCodePoint(buffer, end - width, end) === codePoint) return width;
  }
  return 0;
}

function decodeCodePoint(buffer: Buffer, at: number, limit: number): number {
  const width = utf8SequenceLength(buffer, at, limit);
  if (width <= 0) return -1;
  let value = buffer[at] & (0xff >> (width + 1));
  for (let index = 1; index < width; index += 1) value = (value << 6) | (buffer[at + index] & 0x3f);
  return value;
}

/** 原始键字节与目标键逐字节相同即命中；长度相同却不同字节必不命中，只有长度更短（含转义）才需要解出来比。 */
function keyEquals(buffer: Buffer, begin: number, end: number, key: string): boolean {
  const rawLength = end - begin - 2;
  if (rawLength < key.length) return false;
  if (rawLength === key.length) {
    for (let index = 0; index < key.length; index += 1) {
      if (buffer[begin + 1 + index] !== key.charCodeAt(index)) return false;
    }
    return true;
  }
  return readString(buffer, { valueKind: 'string', begin, end }) === key;
}
