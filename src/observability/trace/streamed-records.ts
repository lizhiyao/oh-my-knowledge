import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { type RecordSchemaNode, assembleRecord } from './jsonl-record-schema.js';
import { trimmedCharLength } from './jsonl-record-window.js';

/**
 * 大日志的记录读取层：先按字节偏移索引，再按声明 schema 一趟装配出每条记录被消费的字段。
 *
 * 与整档解析的等价性是实测的，不是推出来的：同一份语料 2 411 份文件／1 387 MiB，逐份比
 * 「装配视图产出的会话」与「整档 `JSON.parse` 产出的会话」的序列化指纹，含三档计数（源记录／
 * 畸形／非对象）逐项相等，0 处分叉。装配表没覆盖到的分支（会产出 `unknown` 事件的族、以及任何
 * 新记录族）退回整条 `JSON.parse`，所以没进表的记录语义与改造前逐字相同。
 *
 * 但这一层**没有**把采集峰值与文件大小解耦，两条取用形状都被实测否证（2026-09-19 真机 CLI
 * 单文件采集，`maximum resident`，四档各 3 次）：
 *
 * | 取用形状 | 203 MiB | 428 MiB | 704 MiB | 1 357 MiB | 1 357 MiB 的 wall |
 * | --- | --- | --- | --- | --- | --- |
 * | 改造前：每次取用整条解析、用完即弃 | 646 | 749 | 982 | 1 487 MiB | 23 s |
 * | 装配＋常驻投影 | 781 | 1 097 | 1 601 | 2 864 MiB | 36 s |
 * | 装配＋不常驻 | 545 | 546 | 874 | 1 433 MiB | 227 s |
 *
 * 常驻会把 `event_msg/item_completed`（真实语料里占文件字节量的 36%）这类大记录连同其证据一起
 * 留在内存里，峰值变成约 2 倍文件大小；不常驻又要把适配器 13 趟整档遍历各自重做一遍装配，wall
 * 涨 10 倍。也就是说峰值跟着**必须落到 JS 里的证据总量**走，不跟着「用哪种方式解字节」走：
 * 同一份 1 357 MiB 日志里事件与派生产物要带走约 1 076 MiB 文本，把它换成逐字段解字符串并不消除
 * 同阶的分配，只换它的形状。要真正解耦，得让大证据正文压根不进 JS——按字节窗口带着走，写出时
 * 再流式拼接（#983 的 #31／#32／#33 段）。
 *
 * 使用约定（都不写在类型上，改读取面时必须逐条查）：
 * ① 视图只支持按下标与 `length` 取用（含 `forEach`／`some`／`find` 等只读数组方法，写方法一律
 *    抛错）；`Object.keys`／扩展运算走的是数组自身属性，拿不到记录。
 * ② 畸形与非对象下标返回 `undefined`，消费方必须像适配器那样先判空。
 * ③ 装配守卫只对**取用未声明的键**抛错；`'k' in record` 与 `Object.keys(record)` 不抛，而是把
 *    没装的键当成不存在——所以声明表必须由真实语料的消费侧读面枚举生成，且枚举时要把会话结果
 *    也序列化一遍（事件会把记录子树整个带走，只数「被逐个读过的键」会少装字段）。
 * ④ 装配表里绝不能出现会产出 `unknown` 事件的分支：`rawBytes`／`rawDigest` 按整条记录的序列化
 *    算，少一个键就改变产物数字。新增记录族默认走整条解析，是安全的一侧。
 */

// 每条记录的解析结果标记；0 也是 Uint8Array 的初始值，表示该序号还没解析过。
const OUTCOME_PENDING = 0;
const OUTCOME_RECORD = 1;
const OUTCOME_MALFORMED = 2;
const OUTCOME_IGNORED = 3;
/** 装配分支之外的记录：合法、可取用，但**不进投影**——每次都重新整条解析后用完即弃。 */
const OUTCOME_WHOLE = 4;

export interface StreamedJsonlStats {
  sourceRecordCount: number;
  malformedRecordCount: number;
  ignoredValueCount: number;
}

export interface StreamedJsonlRecords<T = unknown> {
  values: T[];
  stats: () => StreamedJsonlStats;
}

const READ_CHUNK_BYTES = 1 << 20;
/** 与整档读取路径同一条单条记录上限，且同样按字符判定，避免同一份日志因走哪条路而结论不同。 */
const MAX_RECORD_CHARS = 32 * 1024 * 1024;
// UTF-8 一个字符最多 4 字节：行长超过 4 倍就必然超字符上限，先按字节拒绝，不去解码更大的行。
const MAX_LINE_BYTES = MAX_RECORD_CHARS * 4 + 1;

function recordTooLarge(filePath: string): Error {
  // 文案不写单位，与整档路径逐字相同：两条路径的判定都是「字符数超过 MAX_RECORD_CHARS」。
  return new Error(`trace JSONL 单条记录超过 ${MAX_RECORD_CHARS} 上限：${filePath}`);
}

function scanLineOffsets(fd: number, size: number): { offsets: number[]; ends: number[]; maxLineBytes: number } {
  const offsets: number[] = [];
  const ends: number[] = [];
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let filePosition = 0;
  let lineStartInFile = 0;
  let maxLineBytes = 0;
  let pendingHasContent = false;
  for (;;) {
    const read = readSync(fd, buffer, 0, buffer.length, filePosition);
    if (read === 0) break;
    filePosition += read;
    for (let index = 0; index < read; index++) {
      const byte = buffer[index];
      if (byte === 0x0a) {
        const lineEnd = filePosition - read + index + 1;
        if (pendingHasContent) {
          offsets.push(lineStartInFile);
          // 每条记录存自己的行尾，而不是「下一个索引」：被跳过的空白行必须留在切片之外，否则
          // 空白字节会挂在上一条记录尾部——VT/FF 都不是 JSON 合法空白，整条记录会因此解析失败。
          ends.push(lineEnd);
          maxLineBytes = Math.max(maxLineBytes, lineEnd - lineStartInFile);
        }
        lineStartInFile = lineEnd;
        pendingHasContent = false;
        continue;
      }
      // 与整档路径同一条「整行是空白就跳过」的口径：那边用 `String.prototype.trim` 判空，
      // 所以 VT(0x0b) 与 FF(0x0c) 也算空白——漏掉它们会让一行 \v 在惰性路径上被索引并计入畸形
      // 记录，两条路的三档计数就此分叉。trim 还会去掉 NBSP／ZWNBSP／U+2028 这类多字节空白，
      // 这里按单字节匹配不了；本机 2 432 份日志共 6 553 MiB 实测零命中，故留作已知边界而非
      // 在热路径上补 UTF-8 序列匹配。
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0b && byte !== 0x0c) {
        pendingHasContent = true;
      }
    }
  }
  if (pendingHasContent) {
    offsets.push(lineStartInFile);
    ends.push(size);
    maxLineBytes = Math.max(maxLineBytes, size - lineStartInFile);
  }
  return { offsets, ends, maxLineBytes };
}

/**
 * 打开一份 JSONL 日志，返回可按序号取用的记录数组视图。调用方用完必须 `close()`。
 */
export function openStreamedJsonlRecords<T = unknown>(
  filePath: string,
  schema: RecordSchemaNode,
): StreamedJsonlRecords<T> & { close: () => void } {
  const fd = openSync(filePath, 'r');
  // 建立索引期间的任何失败都要还掉这个 fd：一轮要开上千家日志，泄漏会先把进程推到 EMFILE。
  let size: number;
  let offsets: number[];
  let ends: number[];
  let scratch: Buffer;
  try {
    size = fstatSync(fd).size;
    const scanned = scanLineOffsets(fd, size);
    offsets = scanned.offsets;
    ends = scanned.ends;
    // 读缓冲区按实测最长行分配，而不是按文件大小或上限预留：整档扫描一次就已经知道最长行。
    scratch = Buffer.allocUnsafe(Math.min(Math.max(scanned.maxLineBytes, 1), MAX_LINE_BYTES));
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const outcomes = new Uint8Array(offsets.length);
  // 只装装配分支的记录：值都是解出来的真实字段，体积与「事件本来就要带的证据」同阶。
  const projection: Array<T | undefined> = new Array<T | undefined>(offsets.length);
  let malformed = 0;
  let ignored = 0;
  let closed = false;

  /**
   * 把一段绝对字节区间读进**同一块** scratch 并返回它。视图只存数字，取字段时才走这里，
   * 所以一条记录被取用多少次都不会留下副本；返回缓冲的内容到下次读之前有效，解出来的值都是副本。
   */
  const bytesAt = (absoluteBegin: number, length: number): Buffer => {
    if (closed) throw new Error(`流式 trace 记录已关闭：${filePath}`);
    const read = readSync(fd, scratch, 0, length, absoluteBegin);
    if (read !== length) throw new Error(`流式 trace 记录读取不完整：${filePath}@${absoluteBegin}+${length}`);
    return scratch;
  };

  /**
   * 读并装配第 `position` 条记录。返回 `undefined` 时三档计数已经记好，与整档路径同口径。
   *
   * 单条上限的判定与整档路径同一条：解成字符串后去掉结尾空白的字符数。这里在字节缓冲上数同一个
   * 数——整档那句 `text.trimEnd().length` 要为判长度先把整行解成字符串。
   */
  /** 取用第 `position` 条记录；`keep` 为真时结果留在投影里，供后续整档遍历复用。 */
  const readRecord = (position: number): { value: T | undefined, keep: boolean } => {
    const start = offsets[position];
    const length = ends[position] - start;
    if (length > MAX_LINE_BYTES) throw recordTooLarge(filePath);
    const bytes = bytesAt(start, length).subarray(0, length);
    if (trimmedCharLength(bytes, 0, length) > MAX_RECORD_CHARS) throw recordTooLarge(filePath);
    const assembled = assembleRecord(bytes, filePath, schema, start);
    if (assembled.outcome === 'record') {
      outcomes[position] = OUTCOME_RECORD;
      return { value: assembled.record as T, keep: true };
    }
    if (assembled.outcome === 'malformed') {
      outcomes[position] = OUTCOME_MALFORMED;
      malformed += 1;
      return { value: undefined, keep: false };
    }
    if (assembled.outcome === 'ignored') {
      outcomes[position] = OUTCOME_IGNORED;
      ignored += 1;
      return { value: undefined, keep: false };
    }
    // 没进装配分支的记录：整条解析，与改造前逐字相同。这类记录（大输出、重复视图）往往就是
    // 文件里最重的部分，而适配器只从里面取事件身份与归属，序列化完就不要再留在内存里。
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      outcomes[position] = OUTCOME_MALFORMED;
      malformed += 1;
      return { value: undefined, keep: false };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      outcomes[position] = OUTCOME_IGNORED;
      ignored += 1;
      return { value: undefined, keep: false };
    }
    return { value: parsed as T, keep: false };
  };

  /** 让三档计数覆盖每个下标：整档路径是每条都解析的，口径不能靠调用顺序凑齐。 */
  const projectAll = (): void => {
    for (let position = 0; position < offsets.length; position += 1) parseAt(position);
  };

  const parseAt = (position: number): T | undefined => {
    if (closed) throw new Error(`流式 trace 记录已关闭：${filePath}`);
    const outcome = outcomes[position];
    if (outcome === OUTCOME_PENDING) {
      const read = readRecord(position);
      if (read.keep) projection[position] = read.value;
      else if (read.value !== undefined) outcomes[position] = OUTCOME_WHOLE;
      return read.value;
    }
    if (outcome === OUTCOME_RECORD) return projection[position];
    if (outcome === OUTCOME_WHOLE) return readRecord(position).value;
    return undefined;
  };

  const isIndex = (property: string): boolean => /^(?:0|[1-9][0-9]*)$/.test(property);

  const target = new Array(offsets.length) as T[];
  const values = new Proxy(target, {
    get(receiver, property) {
      if (typeof property === 'string') {
        if (isIndex(property)) {
          const index = Number(property);
          if (index < offsets.length) return parseAt(index);
        }
      }
      if (property === 'length') return offsets.length;
      const inherited = Reflect.get(receiver, property, receiver);
      if (typeof inherited === 'function') {
        return (inherited as (...args: unknown[]) => unknown).bind(values);
      }
      return inherited;
    },
    has(receiver, property) {
      if (typeof property === 'string' && isIndex(property)) {
        return Number(property) < offsets.length;
      }
      return Reflect.has(receiver, property);
    },
    set() {
      throw new Error('流式 trace 记录数组是只读的');
    },
  });

  return {
    values,
    stats: () => {
      projectAll();
      return {
        sourceRecordCount: offsets.length,
        malformedRecordCount: malformed,
        ignoredValueCount: ignored,
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

export function streamedJsonlBytes(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
