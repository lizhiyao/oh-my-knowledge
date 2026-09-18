import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

/**
 * 按字节偏移索引的惰性 JSONL 记录视图。
 *
 * 会话日志的解析原本一次性把整份文件的记录对象留在内存里，采集一份 1 GiB 级日志的峰值驻留
 * 会到 3.6 GiB——文件越大就越采不动。这里只留每行的起止字节位置（每条记录约 16 字节）与一次性的
 * 解析结果标记，记录对象在离开当前下标后即可回收：适配器看到的仍是「有 length、可 forEach／
 * some／find 访问的数组」，映射逻辑与顺序完全不变。
 *
 * 每次访问都会读并解析该行，因此顺序扫描越多越费 CPU（实测 1.3 GiB 档 wall 从 21 s 涨到 29 s）。
 * 换来的是记录对象不再整档常驻：同一份日志的采集峰值从 3.6 GiB 降到 1.5 GiB。剩下那部分不是攒
 * 下来的事件（全部事件序列化合计 138 MiB），也不是遍历遍数——同一份文件只跑一遍「取完就丢」的
 * 遍历，maximum resident 就到 1 451 MiB（两次独立跑 1 451／1 512），同一进程里再跑 12 遍一次没多
 * （1 449 MiB，此时 heapUsed 36 MiB）。真正的量是「逐条把记录解成 JS 对象」：同一套偏移扫描与逐行
 * 读、读缓冲复用，只换每行做什么，428／704／1 357 MiB 三档下——纯字节扫 57／57／56 MiB、只解码成
 * JS 字符串 129／132／134 MiB（这两行基本不随文件大小走），加上 `JSON.parse` 是 340／597／
 * 1 400～1 503 MiB（最高档六次独立跑，与文件大小同阶）。这些页 V8 不还给系统，所以调堆上限和回收
 * 节奏都没用：old space 限到 64 MiB 后 heapUsed 只剩 16～29 MiB，maximum resident 仍 1 155～
 * 1 195 MiB；把完整 GC 提到每 200 条一次也只降到 938 MiB，叠加小堆是 920 MiB。要再往下压得让读取层
 * 不逐条建对象图，在字节缓冲上按需取出真正进 IR 的字段——那条路的形状就是「纯字节扫」那一行，
 * 见 #983。
 *
 * 使用约定：视图只支持按下标与 `length` 取用（含 `forEach`／`some`／`find` 等只读数组方法，
 * 写方法一律抛错），不要对它做 `Object.keys`／`JSON.stringify`／扩展运算——那些走的是自身属性，
 * 既拿不到记录也会把整份解析结果一次留住。畸形与非对象下标返回 `undefined`，消费方必须像
 * 适配器那样先判空，不能假设元素存在。
 */

// 每条记录的解析结果标记；0 也是 Uint8Array 的初始值，表示该序号还没解析过。
const OUTCOME_PENDING = 0;
const OUTCOME_RECORD = 1;
const OUTCOME_MALFORMED = 2;
const OUTCOME_IGNORED = 3;

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
export function openStreamedJsonlRecords<T = unknown>(filePath: string): StreamedJsonlRecords<T> & {
  close: () => void;
} {
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
  let malformed = 0;
  let ignored = 0;
  let closed = false;

  const parseAt = (position: number): T | undefined => {
    if (closed) throw new Error(`流式 trace 记录已关闭：${filePath}`);
    if (outcomes[position] === OUTCOME_MALFORMED) return undefined;
    if (outcomes[position] === OUTCOME_IGNORED) return undefined;
    if (outcomes[position] === OUTCOME_RECORD) {
      // 记录对象不常驻：同一序号被多次访问时重新解析，返回新的等值对象。
      return readAndParse(position) as T;
    }
    const parsed = readAndParse(position);
    if (parsed === undefined) {
      outcomes[position] = OUTCOME_MALFORMED;
      malformed += 1;
      return undefined;
    }
    if (!isRecordObject(parsed)) {
      outcomes[position] = OUTCOME_IGNORED;
      ignored += 1;
      return undefined;
    }
    outcomes[position] = OUTCOME_RECORD;
    return parsed as T;
  };

  const readAndParse = (position: number): unknown | undefined => {
    const start = offsets[position];
    const length = ends[position] - start;
    if (length > MAX_LINE_BYTES) throw recordTooLarge(filePath);
    const read = readSync(fd, scratch, 0, length, start);
    // 行切片自带结尾换行；JSON.parse 会跳过首尾空白，只有判超限时才取一次无尾空白的长度。
    const text = scratch.toString('utf8', 0, read);
    if (text.trimEnd().length > MAX_RECORD_CHARS) throw recordTooLarge(filePath);
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  /** 让三档计数覆盖到没被任何一遍访问过的下标：整档路径是每条都解析的，口径不能靠调用顺序凑齐。 */
  const settlePending = (): void => {
    for (let position = 0; position < offsets.length; position += 1) {
      if (outcomes[position] === OUTCOME_PENDING) parseAt(position);
    }
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
      settlePending();
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

function isRecordObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
