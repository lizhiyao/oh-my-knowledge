import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

/**
 * 按字节偏移索引的惰性 JSONL 记录视图。
 *
 * 会话日志的解析原本一次性把整份文件的记录对象留在内存里，采集一份 1 GiB 级日志的峰值驻留
 * 会到 3.6 GiB——文件越大就越采不动。这里只留每行的字节偏移（每条 8 字节）与一次性的解析
 * 结果标记，记录对象在离开当前下标后即可回收：适配器看到的仍是「有 length、可 forEach／
 * some／find 访问的数组」，映射逻辑与顺序完全不变。
 *
 * 每次访问都会读并解析该行，因此顺序扫描越多越费 CPU（实测 1.3 GiB 档 wall 从 21 s 涨到 29 s）。
 * 换来的是记录对象不再整档常驻：同一份日志的采集峰值从 3.6 GiB 降到 1.5 GiB，但驻留仍随文件
 * 大小线性增长（逐条解析的分配量与文件同阶），要彻底解耦得让事件本身流式产出，见 #974 的 follow-up。
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

function scanLineOffsets(fd: number, size: number): { offsets: number[]; maxLineBytes: number } {
  const offsets: number[] = [];
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
          maxLineBytes = Math.max(maxLineBytes, lineEnd - lineStartInFile);
        }
        lineStartInFile = lineEnd;
        pendingHasContent = false;
        continue;
      }
      if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) pendingHasContent = true;
    }
  }
  if (pendingHasContent) {
    offsets.push(lineStartInFile);
    maxLineBytes = Math.max(maxLineBytes, size - lineStartInFile);
  }
  return { offsets, maxLineBytes };
}

/**
 * 打开一份 JSONL 日志，返回可按序号取用的记录数组视图。调用方用完必须 `close()`。
 */
export function openStreamedJsonlRecords<T = unknown>(filePath: string): StreamedJsonlRecords<T> & {
  close: () => void;
} {
  const fd = openSync(filePath, 'r');
  const size = fstatSync(fd).size;
  const { offsets, maxLineBytes } = scanLineOffsets(fd, size);
  const outcomes = new Uint8Array(offsets.length);
  let malformed = 0;
  let ignored = 0;
  let closed = false;
  // 读缓冲区按实测最长行分配，而不是按文件大小或上限预留：整档扫描一次就已经知道最长行。
  const scratch = Buffer.allocUnsafe(Math.min(Math.max(maxLineBytes, 1), MAX_LINE_BYTES));

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
    const end = position + 1 < offsets.length ? offsets[position + 1] : size;
    const length = end - start;
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
