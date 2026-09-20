/**
 * 逐帧读取 zstd 压缩的日志文件。
 *
 * DSH 的会话文件是「每追加一条记录就独立压一帧」的串联流：一个 1.4 MB 的文件里有三千多帧。
 * Node 内建的 `zlib.zstdDecompressSync` 与 `createZstdDecompress()` 都只解第一帧就停（实测
 * 1.4 MB 只拿回 279 字节），而且喂给它不完整的帧**不报错**、安静交出被截断的明文——所以帧边界
 * 必须自己按 zstd 帧头与块头算出来，既为了前进，也为了发现截断。
 *
 * 相邻魔数不能当边界：压缩块体内可以巧合出现魔数（真机第一帧就同时有 224 与更后的合法起点），
 * 从巧合魔数切开的切片会解出被截断的记录。因此这里只信帧头声明的结构。
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_MAGIC_BYTES = 4;
/** 压缩字节按这块读入；同时限制一次扫描跨过的数据量。 */
const COMPRESSED_CHUNK_BYTES = 256 * 1024;
/** 单帧明文上限：防病态帧一次撑爆内存；每文件的预算由调用方给。 */
const MAX_FRAME_PLAIN_BYTES = 512 * 1024 * 1024;

export class ZstdDecompressionUnavailableError extends Error {
  constructor(filePath: string) {
    super(`当前 Node 运行时没有内建 zstd 解压能力，无法读取压缩会话：${filePath}`);
    this.name = 'ZstdDecompressionUnavailableError';
  }
}

/** 解码后的明文超出调用方预算；与「帧本身坏了」分开记，前者是容量、后者是格式。 */
export class ZstdDecodedSizeLimitError extends Error {
  constructor(readonly limitBytes: number, filePath: string) {
    super(`zstd 会话解压后超过 ${limitBytes} 字节上限：${filePath}`);
    this.name = 'ZstdDecodedSizeLimitError';
  }
}

/** 帧结构不成立（非 zstd 流、块越界、末帧被截断）：整文件失败，不交出半份记录。 */
export class ZstdFrameDecodeError extends Error {
  constructor(filePath: string, reason: string) {
    super(`zstd 会话帧结构不成立（${reason}）：${filePath}`);
    this.name = 'ZstdFrameDecodeError';
  }
}

export function zstdDecompressionAvailable(): boolean {
  return typeof zstdDecompressSync === 'function';
}

interface ZstdFrameLayout {
  /** 帧结束后的下一个字节偏移。 */
  end: number;
  /** 帧头声明的明文长度；没有声明时为 null。 */
  declaredPlainBytes: number | null;
}

/**
 * 按 RFC 8878 的帧格式算出一帧的字节范围：帧头 → 逐块头 → 可选校验和。
 * 任何不一致（魔数缺失、块体越界、没有 last-block 就到文件尾）都返回 null。
 */
function frameLayoutAt(bytes: Buffer, start: number): ZstdFrameLayout | null {
  if (start + ZSTD_MAGIC_BYTES + 1 > bytes.length || bytes.readUInt32LE(start) !== ZSTD_FRAME_MAGIC) {
    return null;
  }
  const descriptor = bytes[start + ZSTD_MAGIC_BYTES];
  const dictionaryIdFlag = descriptor & 0b11;
  const hasContentChecksum = ((descriptor >> 2) & 0b1) === 1;
  const singleSegment = ((descriptor >> 5) & 0b1) === 1;
  const contentSizeFlag = (descriptor >> 6) & 0b11;

  let cursor = start + ZSTD_MAGIC_BYTES + 1;
  if (!singleSegment) cursor += 1; // Window_Descriptor
  cursor += [0, 1, 2, 4][dictionaryIdFlag];
  // 帧内容长度字段：flag 0 通常是「不写」，但 Single_Segment 帧下它写 1 字节（实测 Node
  // 造的短帧就是这一型，按 0 或 4 算都会把块头读错位）。
  const contentSizeBytes = singleSegment && contentSizeFlag === 0
    ? 1
    : [0, 2, 4, 8][contentSizeFlag];
  let declaredPlainBytes: number | null = null;
  if (contentSizeBytes === 4) declaredPlainBytes = bytes.readUInt32LE(cursor);
  else if (contentSizeBytes === 2) declaredPlainBytes = bytes.readUInt16LE(cursor);
  else if (contentSizeBytes === 8) declaredPlainBytes = Number(bytes.readBigUInt64LE(cursor));
  cursor += contentSizeBytes;

  for (;;) {
    if (cursor + 3 > bytes.length) return null;
    const header = bytes.readUIntLE(cursor, 3);
    cursor += 3;
    const isLastBlock = (header & 0b1) === 1;
    const blockType = (header >> 1) & 0b11;
    // Block_Size 占 bit3..26，右移 3 位；RLE 块的内容只有 1 字节，块头里的长度是重复次数。
    const blockSize = header >>> 3;
    if (blockType === 0b11) return null;
    cursor += blockType === 0b01 ? 1 : blockSize;
    if (cursor > bytes.length) return null;
    if (isLastBlock) break;
  }
  if (hasContentChecksum) cursor += 4;
  return { end: cursor, declaredPlainBytes };
}

function decodeFrame(frame: Buffer, budgetBytes: number): Buffer {
  return zstdDecompressSync(frame, {
    maxOutputLength: Math.min(budgetBytes, MAX_FRAME_PLAIN_BYTES),
  });
}

/** 读整份压缩文件；文件容量上限由调用方判断，这里不另设第二套。 */
function readCompressed(filePath: string): Buffer {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch (cause) {
    throw new Error(`无法读取压缩 trace 输入文件：${filePath}`, { cause });
  }
  const chunks: Buffer[] = [];
  try {
    const buffer = Buffer.allocUnsafe(COMPRESSED_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
  } finally {
    closeSync(fd);
  }
  return Buffer.concat(chunks);
}

/**
 * 按帧顺序产出明文，调用方不需要持有整份解压结果。
 *
 * `maxDecodedBytes` 计的是**已交付的明文字节**：真机压缩比约 2.4 倍，按压缩后大小设闸会放过
 * 远超预算的解压峰值。
 */
export function* iterateZstdFramePlainText(
  filePath: string,
  maxDecodedBytes: number,
): Generator<Buffer, void, void> {
  if (!zstdDecompressionAvailable()) throw new ZstdDecompressionUnavailableError(filePath);
  const bytes = readCompressed(filePath);
  if (bytes.length === 0) return;

  let delivered = 0;
  let start = 0;
  while (start < bytes.length) {
    const layout = frameLayoutAt(bytes, start);
    if (!layout) throw new ZstdFrameDecodeError(filePath, '首帧或后续帧头不成立／块体越界');
    let plain: Buffer;
    try {
      plain = decodeFrame(bytes.subarray(start, layout.end), maxDecodedBytes - delivered);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ZstdDecodedSizeLimitError(maxDecodedBytes, filePath);
      }
      throw new ZstdFrameDecodeError(filePath, '帧内容无法解压');
    }
    if (layout.declaredPlainBytes !== null && layout.declaredPlainBytes !== plain.length) {
      // 帧头说 N 字节却只解出更少，就是被截断的证据；宁可整文件失败。
      throw new ZstdFrameDecodeError(filePath, `帧明文 ${plain.length} 与声明 ${layout.declaredPlainBytes} 不符`);
    }
    delivered += plain.length;
    if (plain.length > 0) yield plain;
    start = layout.end;
  }
}
