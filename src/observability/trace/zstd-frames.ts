/**
 * 逐帧读取多帧串联的 zstd 日志文件。
 *
 * DSH 的 session.jsonl.zstd 是「每追加一条记录就独立压一帧」的串联流：真机一份 1.4 MB 的文件
 * 里有 3175 帧。Node 内建 zstd 的两个 API 都只解第一帧就停（1.4 MB 只回 279 字节），而且喂给
 * 它不完整的帧**不报错**、安静交出被截断的明文。相邻魔数也不能当帧边界：块体内可以巧合出现
 * 魔数，从那里切开同样是被截断。所以帧边界只信帧头与块头算出来的结构。
 *
 * 明文按帧交付，压缩字节用滚动窗口读：内存里最多留「一个读块 + 一帧残料」，不像整档那样按
 * 文件大小常驻——未压缩路径本来就是 64 KiB 分块读的，压缩路径不能开这个倒车。
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_MAGIC_BYTES = 4;
const DEFAULT_COMPRESSED_CHUNK_BYTES = 256 * 1024;
/** 残料上限：一帧的压缩字节最多长这样，超过就是结构不成立，不再无限攒。 */
const MAX_PENDING_COMPRESSED_BYTES = 512 * 1024 * 1024;

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

type FrameParse = { status: 'complete'; end: number } | { status: 'incomplete' } | { status: 'corrupt'; reason: string };

/**
 * 按 RFC 8878 的帧格式算出一帧的字节范围：帧头 → 逐块头 → 可选内容校验和。
 *
 * `incomplete` 只表示「窗口还没读够」，调用方应当再读一块；结构性矛盾（块体越界、没有
 * last-block 就到文件尾）在文件读尽后判为 `corrupt`。
 *
 * 帧内容长度字段只用来跳过它自身，**不参与校验**：本机 Node 的 zstd 写入器给单段帧写的这个
 * 值可以远小于实际产出（实测声明 222、解出 478），拿它判截断会误杀正常帧。截断由块走查发现
 * ——块体长度越过剩余字节就是截断，这条有对应用例。
 */
function parseFrame(bytes: Buffer, truncated: boolean): FrameParse {
  if (bytes.length < ZSTD_MAGIC_BYTES + 1) {
    return truncated ? { status: 'corrupt', reason: '文件短于帧头' } : { status: 'incomplete' };
  }
  if (bytes.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) {
    return { status: 'corrupt', reason: '首字节不是 zstd 帧魔数' };
  }
  const descriptor = bytes[ZSTD_MAGIC_BYTES];
  const dictionaryIdFlag = descriptor & 0b11;
  const hasContentChecksum = ((descriptor >> 2) & 0b1) === 1;
  const singleSegment = ((descriptor >> 5) & 0b1) === 1;
  const contentSizeFlag = (descriptor >> 6) & 0b11;

  let cursor = ZSTD_MAGIC_BYTES + 1;
  if (!singleSegment) cursor += 1; // Window_Descriptor
  cursor += [0, 1, 2, 4][dictionaryIdFlag];
  // 帧内容长度字段：flag 0 通常不写，但 Single_Segment 帧下写 1 字节（实测 Node 造的短帧
  // 就是这一型，按 0 或 4 算都会把块头读错位）。
  const contentSizeBytes = singleSegment && contentSizeFlag === 0
    ? 1
    : [0, 2, 4, 8][contentSizeFlag];
  if (bytes.length < cursor + contentSizeBytes) {
    return truncated ? { status: 'corrupt', reason: '帧内容长度字段被截断' } : { status: 'incomplete' };
  }
  cursor += contentSizeBytes;

  for (;;) {
    if (bytes.length < cursor + 3) {
      return truncated ? { status: 'corrupt', reason: '块头被截断' } : { status: 'incomplete' };
    }
    const header = bytes.readUIntLE(cursor, 3);
    cursor += 3;
    const isLastBlock = (header & 0b1) === 1;
    const blockType = (header >> 1) & 0b11;
    // Block_Size 占 bit3..26；RLE 块只占 1 字节，块头里的长度是重复次数而不是存储长度。
    const blockSize = header >>> 3;
    if (blockType === 0b11) return { status: 'corrupt', reason: '保留的块类型' };
    const storedBytes = blockType === 0b01 ? 1 : blockSize;
    if (bytes.length < cursor + storedBytes) {
      return truncated ? { status: 'corrupt', reason: '块体被截断' } : { status: 'incomplete' };
    }
    cursor += storedBytes;
    if (isLastBlock) break;
  }
  if (hasContentChecksum) {
    if (bytes.length < cursor + 4) {
      return truncated ? { status: 'corrupt', reason: '内容校验和被截断' } : { status: 'incomplete' };
    }
    cursor += 4;
  }
  return { status: 'complete', end: cursor };
}

/**
 * 按帧顺序产出明文。`maxDecodedBytes` 计的是**已交付的明文字节**：真机放大 2.36 倍，
 * 按压缩后大小设闸会放过远超预算的解压峰值。`compressedChunkBytes` 仅供测试把帧强行跨读块。
 */
export function* iterateZstdFramePlainText(
  filePath: string,
  maxDecodedBytes: number,
  compressedChunkBytes = DEFAULT_COMPRESSED_CHUNK_BYTES,
): Generator<Buffer, void, void> {
  if (!zstdDecompressionAvailable()) throw new ZstdDecompressionUnavailableError(filePath);
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch (cause) {
    throw new Error(`无法读取压缩 trace 输入文件：${filePath}`, { cause });
  }

  let pending = Buffer.alloc(0);
  let delivered = 0;
  let exhausted = false;
  try {
    for (;;) {
      const parsed = parseFrame(pending, exhausted);
      if (parsed.status === 'incomplete') {
        const chunk = Buffer.allocUnsafe(Math.max(1, compressedChunkBytes));
        const read = readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) {
          exhausted = true;
          if (pending.length === 0) return;
          continue;
        }
        pending = Buffer.concat([pending, chunk.subarray(0, read)]);
        if (pending.length > MAX_PENDING_COMPRESSED_BYTES) {
          throw new ZstdFrameDecodeError(filePath, '单帧压缩长度超出上限');
        }
        continue;
      }
      if (parsed.status === 'corrupt') throw new ZstdFrameDecodeError(filePath, parsed.reason);

      const frame = pending.subarray(0, parsed.end);
      pending = pending.subarray(parsed.end);
      let plain: Buffer;
      try {
        plain = zstdDecompressSync(frame, {
          maxOutputLength: Math.min(maxDecodedBytes - delivered, Number.MAX_SAFE_INTEGER),
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZstdDecodedSizeLimitError(maxDecodedBytes, filePath);
        }
        throw new ZstdFrameDecodeError(filePath, '帧内容无法解压');
      }
      delivered += plain.length;
      if (plain.length > 0) yield plain;
    }
  } finally {
    closeSync(fd);
  }
}
