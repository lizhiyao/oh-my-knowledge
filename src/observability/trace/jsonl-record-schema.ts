import type { JsonTextSpan } from './evidence-text.js';
import type { JsonValueKind } from './jsonl-record-window.js';

/**
 * 一趟扫描装配一条记录的多个字段（#974 判据②的读取形状）。
 *
 * 为什么不是「按键逐次定位」也不是「先建整层成员表」：前者一条记录取 N 个字段就把整层重扫 N 遍
 * （实测 704 MiB 档 wall 从 12 s 涨到 104 s），后者每趟要为每条记录解出所有键名并建一张表
 * （1 357 MiB 档约 166 万个键名分配/趟，实测 15 s/趟）。按声明的 schema 走一趟、只把声明到的
 * 值装进普通对象，才能同时拿到「一次扫描」与「不建对象图」。
 *
 * schema 同时是三件事：读什么、装成什么形状、以及**允许读什么**。最后一件事由守卫负责——
 * 消费点取用没声明过的键会当场抛错，而不是悄悄拿到 `undefined` 少一份证据。
 * 装配产物是普通对象（值都是真实解出的 JS 值或字节窗口），所以适配器与产物序列化看到的形状
 * 与整档解析一致。
 *
 * `span` 声明的字段只留字节窗口不解释值：给 `tool_result.output` 这类大证据正文用——
 * 同一批 1 076 MiB 文本，按字节走一趟 78 MiB，解成字符串要 155 MiB，再建对象图是 1 432 MiB。
 */

const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const BACKSLASH = 0x5c;
const MINUS = 0x2d;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;

/** 一段字节在缓冲里的位置与它的 JSON 值类型。 */
interface ValueWindow {
  readonly valueKind: JsonValueKind;
  readonly begin: number;
  readonly end: number;
}

/** 装配到没进分支表的记录时向上冒泡的哨兵：调用方据此退回整条 `JSON.parse`。 */
const WHOLE = Symbol('record-whole');
/** 分支身份键在本层不存在（与「存在但不是字符串」分开：前者走 `-` 分支）。 */
const ABSENT = Symbol('branch-absent');
const INVALID = Symbol('branch-invalid');

export type RecordSchemaNode =
  | { readonly read: 'value' }
  | { readonly read: 'span' }
  | { readonly read: 'object'; readonly members: Readonly<Record<string, RecordSchemaNode>> }
  | { readonly read: 'array'; readonly element: RecordSchemaNode }
  | { readonly read: 'branch'; readonly on: string; readonly cases: Readonly<Record<string, RecordSchemaNode | undefined>> };

export interface AssembleResult {
  /**
   * `whole` 表示「这条记录不按声明装配」：分支没进表（新的记录族、或会产出 unknown 事件的族），
   * 调用方要退回整条 `JSON.parse`。unknown 事件的 `rawBytes`／`rawDigest` 按整条记录的序列化算，
   * 少装一个键就会改变产物数字，所以这类记录不能走装配。
   */
  readonly outcome: 'record' | 'malformed' | 'ignored' | 'whole';
  readonly record?: object;
}

/** 语法与值形状都按 `JSON.parse` 的接受集判；非法即判畸形，与整档路径同口径。 */
class Reader {
  private cursor = 0;

  constructor(
    private readonly buffer: Buffer,
    private readonly limit: number,
    private readonly sourcePath: string,
    private readonly origin: number,
  ) {}

  skipBlank(): void {
    while (this.cursor < this.limit) {
      const byte = this.buffer[this.cursor];
      if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) this.cursor += 1;
      else return;
    }
  }

  atEnd(): boolean {
    return this.cursor >= this.limit;
  }

  byteAt(index: number): number | undefined {
    return index < this.limit ? this.buffer[index] : undefined;
  }

  /**
   * 装配整条记录。根节点是分支声明时（按记录自身的身份键分派），产物的可读写入面由被选中的
   * 分支声明决定，守卫在 {@link Reader.materialize} 里已经加过；根节点是对象声明时补根层守卫。
   */
  materializeRoot(root: RecordSchemaNode): Record<string, unknown> | 'ignored' | undefined | typeof WHOLE {
    const top = this.readWindow();
    if (!top) return undefined;
    if (top.valueKind !== 'object') return 'ignored';
    this.cursor = top.begin;
    const produced = this.materialize(top, root, '$');
    if (produced === WHOLE) return WHOLE;
    if (typeof produced !== 'object' || produced === null || Array.isArray(produced)) return undefined;
    const object = produced as Record<string, unknown>;
    return root.read === 'object' ? guarded(object, root.members, '$') : object;
  }

  /** 值之后只能跟空白：整档路径在这里会抛，本层也必须判失败。 */
  finishTop(): boolean {
    this.skipBlank();
    return this.cursor >= this.limit;
  }

  /** 跳过一个值并返回其窗口，同时逐项校验语法（含转义形状与数字字面量）。 */
  readWindow(): ValueWindow | undefined {
    this.skipBlank();
    const begin = this.cursor;
    const lead = this.byteAt(begin);
    if (lead === undefined) return undefined;
    if (lead === LBRACE || lead === LBRACKET) {
      const end = this.scanContainer(lead === LBRACE ? RBRACE : RBRACKET);
      if (end < 0) return undefined;
      return { valueKind: lead === LBRACE ? 'object' : 'array', begin, end };
    }
    if (lead === QUOTE) {
      const end = this.scanString();
      if (end < 0) return undefined;
      return { valueKind: 'string', begin, end };
    }
    if (lead === MINUS || (lead >= ZERO && lead <= NINE)) {
      const end = this.scanNumber();
      if (end < 0) return undefined;
      return { valueKind: 'number', begin, end };
    }
    const word = lead === 0x74 ? 'true' : lead === 0x66 ? 'false' : lead === 0x6e ? 'null' : '';
    if (!word) return undefined;
    for (let index = 0; index < word.length; index += 1) {
      if (this.byteAt(begin + index) !== word.charCodeAt(index)) return undefined;
    }
    this.cursor = begin + word.length;
    return { valueKind: 'literal', begin, end: this.cursor };
  }

  /** 值的文本 → 真实 JS 值：交给 `JSON.parse` 吃这段字节，逐字等价由构造保证。 */
  decode(window: ValueWindow): unknown {
    if (window.valueKind !== 'string') return JSON.parse(this.text(window.begin, window.end));
    const inner = { begin: window.begin + 1, end: window.end - 1 };
    if (this.isPlainString(inner.begin, inner.end)) return this.buffer.toString('utf8', inner.begin, inner.end);
    return JSON.parse(this.text(window.begin, window.end)) as unknown;
  }

  /** 字节窗口以传入切片为原点；加上切片在文件里的绝对起点才是可对账的文件偏移。 */
  span(window: ValueWindow): JsonTextSpan {
    return {
      sourcePath: this.sourcePath,
      begin: window.begin + this.origin,
      end: window.end + this.origin,
      valueKind: window.valueKind,
    };
  }

  private text(begin: number, end: number): string {
    return this.buffer.toString('utf8', begin, end);
  }

  private isPlainString(begin: number, end: number): boolean {
    for (let cursor = begin; cursor < end; cursor += 1) {
      const byte = this.buffer[cursor];
      if (byte === BACKSLASH || byte === QUOTE || byte < 0x20) return false;
    }
    return true;
  }

  private scanString(): number {
    let cursor = this.cursor + 1;
    for (;;) {
      if (cursor >= this.limit) return -1;
      const byte = this.buffer[cursor];
      if (byte === BACKSLASH) {
        const escape = this.byteAt(cursor + 1);
        if (escape === 0x75) {
          for (let index = 0; index < 4; index += 1) if (!isHex(this.byteAt(cursor + 2 + index))) return -1;
        } else if (escape !== QUOTE && escape !== BACKSLASH && escape !== 0x2f && escape !== 0x62
          && escape !== 0x66 && escape !== 0x6e && escape !== 0x72 && escape !== 0x74) {
          return -1;
        }
        cursor += escape === 0x75 ? 6 : 2;
        continue;
      }
      if (byte === QUOTE) {
        this.cursor = cursor + 1;
        return this.cursor;
      }
      if (byte < 0x20) return -1;
      cursor += 1;
    }
  }

  private scanNumber(): number {
    let cursor = this.cursor;
    if (this.byteAt(cursor) === MINUS) cursor += 1;
    const lead = this.byteAt(cursor);
    if (lead === ZERO) {
      cursor += 1;
    } else if (lead !== undefined && lead > ZERO && lead <= NINE) {
      while (isDigit(this.byteAt(cursor))) cursor += 1;
    } else {
      return -1;
    }
    if (this.byteAt(cursor) === DOT) {
      cursor += 1;
      if (!isDigit(this.byteAt(cursor))) return -1;
      while (isDigit(this.byteAt(cursor))) cursor += 1;
    }
    const marker = this.byteAt(cursor);
    if (marker === 0x65 || marker === 0x45) {
      cursor += 1;
      const sign = this.byteAt(cursor);
      if (sign === MINUS || sign === 0x2b) cursor += 1;
      if (!isDigit(this.byteAt(cursor))) return -1;
      while (isDigit(this.byteAt(cursor))) cursor += 1;
    }
    this.cursor = cursor;
    return cursor;
  }

  /** 容器：只走结构与语法（值整体跳过），因为未被声明的字段不需要装配。 */
  private scanContainer(closer: number): number {
    const isArray = closer === RBRACKET;
    let cursor = this.nextBlank(this.cursor + 1);
    if (this.byteAt(cursor) === closer) {
      this.cursor = cursor + 1;
      return this.cursor;
    }
    for (;;) {
      const start = this.nextBlank(cursor);
      let valueBegin = start;
      if (!isArray) {
        if (this.byteAt(start) !== QUOTE) return -1;
        this.cursor = start;
        if (this.scanString() < 0) return -1;
        const colon = this.nextBlank(this.cursor);
        if (this.byteAt(colon) !== COLON) return -1;
        valueBegin = this.nextBlank(colon + 1);
      }
      this.cursor = valueBegin;
      if (!this.skipValue()) return -1;
      const next = this.nextBlank(this.cursor);
      if (this.byteAt(next) === closer) {
        this.cursor = next + 1;
        return this.cursor;
      }
      if (this.byteAt(next) !== COMMA) return -1;
      cursor = next + 1;
    }
  }

  /** 跳过一个值（含其全部子节点），返回结束位置；结构与转义非法则失败。 */
  private skipValue(): boolean {
    const begin = this.nextBlank(this.cursor);
    this.cursor = begin;
    const lead = this.byteAt(begin);
    if (lead === undefined) return false;
    if (lead === LBRACE || lead === LBRACKET) return this.scanContainer(lead === LBRACE ? RBRACE : RBRACKET) >= 0;
    if (lead === QUOTE) return this.scanString() >= 0;
    if (lead === MINUS || (lead >= ZERO && lead <= NINE)) return this.scanNumber() >= 0;
    const word = lead === 0x74 ? 'true' : lead === 0x66 ? 'false' : lead === 0x6e ? 'null' : '';
    if (!word) return false;
    for (let index = 0; index < word.length; index += 1) if (this.byteAt(begin + index) !== word.charCodeAt(index)) return false;
    this.cursor = begin + word.length;
    return true;
  }


  /** 定位读用：把游标挪到给定位置（装配子层时按窗口边界重来）。 */
  setCursor(index: number): void {
    this.cursor = index;
  }

  /**
   * 装配一个对象层：一次走完这层字节，声明过的键取真实值／取字节窗口／继续下钻，未声明的值只跳语法。
   * 进入时游标停在 `{` 上，结束时停在 `}` 之后。语法或结构不合法返回 undefined（＝整条记录畸形）。
   */
  assemble(
    members: Readonly<Record<string, RecordSchemaNode>>,
    path: string,
  ): Record<string, unknown> | undefined | typeof WHOLE {
    const produced: Record<string, unknown> = {};
    this.cursor += 1;
    this.skipBlank();
    if (this.byteAt(this.cursor) === RBRACE) {
      this.cursor += 1;
      return produced;
    }
    for (;;) {
      this.skipBlank();
      if (this.byteAt(this.cursor) !== QUOTE) return undefined;
      const keyBegin = this.cursor;
      if (this.scanString() < 0) return undefined;
      const name = this.decode({ valueKind: 'string', begin: keyBegin, end: this.cursor }) as string;
      this.skipBlank();
      if (this.byteAt(this.cursor) !== COLON) return undefined;
      this.cursor += 1; // 冒号之后才是值
      const node = members[name];
      const window = this.readWindow();
      if (!window) return undefined;
      if (node) {
        const value = this.materialize(window, node, `${path}.${name}`);
        if (value === WHOLE) return WHOLE;
        // 重复键：赋值天然就是 `JSON.parse` 的语义——键序停在首次出现位置，值取最后一次。
        produced[name] = value;
      }
      this.skipBlank();
      const closer = this.byteAt(this.cursor);
      if (closer === RBRACE) {
        this.cursor += 1;
        return produced;
      }
      if (closer !== COMMA) return undefined;
      this.cursor += 1;
    }
  }

  private assembleArray(
    element: RecordSchemaNode,
    path: string,
  ): unknown[] | undefined | typeof WHOLE {
    const produced: unknown[] = [];
    this.cursor += 1;
    this.skipBlank();
    if (this.byteAt(this.cursor) === RBRACKET) {
      this.cursor += 1;
      return produced;
    }
    for (;;) {
      const window = this.readWindow();
      if (!window) return undefined;
      const value = this.materialize(window, element, `${path}[${produced.length}]`);
      if (value === WHOLE) return WHOLE;
      produced.push(value);
      this.skipBlank();
      const closer = this.byteAt(this.cursor);
      if (closer === RBRACKET) {
        this.cursor += 1;
        return produced;
      }
      if (closer !== COMMA) return undefined;
      this.cursor += 1;
    }
  }

  /**
   * 按声明取出字段的值。声明的形状与记录里的实际形状不符时**按真实值给出**而不是判畸形：
   * 记录本身是合法 JSON，把声明写错不该改变三档计数的口径。
   */
  private materialize(window: ValueWindow, node: RecordSchemaNode, path: string): unknown {
    if (node.read === 'span') return this.span(window);
    if (node.read === 'value') return this.decode(window);
    if (node.read === 'branch') return this.followBranch(window, node, path);
    if (window.valueKind === 'array' && node.read === 'array') {
      const saved = this.cursor;
      this.cursor = window.begin;
      const produced = this.assembleArray(node.element, path);
      if (produced === WHOLE) return WHOLE;
      if (produced === undefined) {
        this.cursor = saved;
        return this.decode(window);
      }
      return produced;
    }
    if (window.valueKind === 'object' && node.read === 'object') {
      const saved = this.cursor;
      this.cursor = window.begin;
      const produced = this.assemble(node.members, path);
      if (produced === WHOLE) return WHOLE;
      if (produced === undefined) {
        this.cursor = saved;
        return this.decode(window);
      }
      return guarded(produced, node.members, path);
    }
    return this.decode(window);
  }

  /**
   * 分支节点：先看 `on` 键取到分支身份，再按该分支的声明装配同一个窗口。找不到身份、身份不是
   * 字符串、或该分支没进表，一律交回 {@link WHOLE}——调用方因此对没覆盖到的记录族保持原有语义。
   */
  private followBranch(window: ValueWindow, node: Extract<RecordSchemaNode, { read: 'branch' }>, path: string): unknown {
    if (window.valueKind !== 'object') return WHOLE;
    const saved = this.cursor;
    this.cursor = window.begin;
    const identity = this.branchKey(node.on);
    if (identity === INVALID) {
      this.cursor = saved;
      return WHOLE;
    }
    const target = node.cases[identity === ABSENT ? '-' : (identity as string)];
    if (!target) {
      this.cursor = saved;
      return WHOLE;
    }
    this.cursor = window.begin;
    const produced = this.materialize(window, target, `${path}.${node.on}`);
    // 无论分支内部走到哪，本层的结束位置由窗口给定：外层还要接着按 `,`／`}` 判定记录是否完整。
    this.cursor = produced === WHOLE ? saved : window.end;
    return produced;
  }

  /** 在本层成员里找分支身份键的值：只接受字符串，扫完整层没找到按 `undefined`（＝没有该键）。 */
  private branchKey(on: string): string | typeof ABSENT | typeof INVALID {
    this.cursor += 1;
    this.skipBlank();
    if (this.byteAt(this.cursor) === RBRACE) {
      this.cursor += 1;
      return ABSENT;
    }
    for (;;) {
      this.skipBlank();
      if (this.byteAt(this.cursor) !== QUOTE) return INVALID;
      const keyBegin = this.cursor;
      if (this.scanString() < 0) return INVALID;
      const name = this.decode({ valueKind: 'string', begin: keyBegin, end: this.cursor }) as string;
      this.skipBlank();
      if (this.byteAt(this.cursor) !== COLON) return INVALID;
      this.cursor += 1;
      const window = this.readWindow();
      if (!window) return INVALID;
      if (name === on) {
        // 身份键本身按声明给出：先确认结构合法（后面必须跟 , 或 }），再取值。
        this.skipBlank();
        const next = this.byteAt(this.cursor);
        if (next !== RBRACE && next !== COMMA) return INVALID;
        if (window.valueKind !== 'string') return INVALID;
        return this.decode(window) as string;
      }
      this.skipBlank();
      const closer = this.byteAt(this.cursor);
      if (closer === RBRACE) {
        this.cursor += 1;
        return ABSENT;
      }
      if (closer !== COMMA) return INVALID;
      this.cursor += 1;
    }
  }

  private nextBlank(from: number): number {
    let cursor = from;
    while (cursor < this.limit) {
      const byte = this.buffer[cursor];
      if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) cursor += 1;
      else return cursor;
    }
    return cursor;
  }
}

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= ZERO && byte <= NINE;
}

function isHex(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66) || (byte >= 0x41 && byte <= 0x46);
}

/**
 * JS 运行时与序列化协议会探测的键：它们不是数据字段，读它们不代表消费点忘了声明。
 * `constructor` 等在对象上本就存在的键由 `property in target` 放行，不必列进来。
 */
const PROTOCOL_KEYS = new Set(['toJSON', 'then', 'catch', 'finally', 'inspect']);

/** 守卫：装配出来的对象只允许读声明过的键，取到没声明的键当场抛错而不是悄悄给 `undefined`。 */
function guarded(
  object: Record<string, unknown>,
  declared: Readonly<Record<string, RecordSchemaNode>>,
  path: string,
): Record<string, unknown> {
  const names = new Set(Object.keys(declared));
  return new Proxy(object, {
    get(target, property) {
      if (typeof property === 'string' && !(property in target) && !names.has(property) && !PROTOCOL_KEYS.has(property)) {
        throw new Error(`记录装配未声明该字段：${path}.${property}`);
      }
      return Reflect.get(target, property, target);
    },
  });
}

/**
 * 按 schema 装配一行记录。`malformed` 与整档路径的「`JSON.parse` 抛错」同判，`ignored` 对应
 * 「不是对象」的值——三档计数（源记录／畸形／非对象）不能因为走哪条路而分叉。
 */
export function assembleRecord(
  buffer: Buffer,
  sourcePath: string,
  root: RecordSchemaNode,
  origin = 0,
): AssembleResult {
  const reader = new Reader(buffer, buffer.length, sourcePath, origin);
  const produced = reader.materializeRoot(root);
  if (produced === WHOLE) return { outcome: 'whole' };
  if (produced === 'ignored') return { outcome: 'ignored' };
  if (!produced) return { outcome: 'malformed' };
  if (!reader.finishTop()) return { outcome: 'malformed' };
  return { outcome: 'record', record: produced };
}

