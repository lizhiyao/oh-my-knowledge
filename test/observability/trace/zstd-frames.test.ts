import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  ZstdDecodedSizeLimitError,
  ZstdFrameDecodeError,
  iterateZstdFramePlainText,
} from '../../../src/observability/trace/zstd-frames.js';

/**
 * DSH 的会话文件是「每追加一条记录独立压一帧」的串联流。这里用同样的方式造夹具：
 * 逐条记录压成一帧再拼接，因此测试复现的是真实结构，而不是一帧大流。
 */
const RECORDS = [
  '{"type":"session","version":0,"id":"s-1","cwd":"/repo"}',
  '{"type":"user/message","seq":1,"data":{"text":"第一行"}}',
  '{"type":"assistant/message","seq":2,"data":{"text":"第二行"}}',
];

function framesOf(lines: string[]): Buffer {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))));
}

const multiFrame = framesOf(RECORDS);
const firstFramePlainText = Buffer.from(`${RECORDS[0]}\n`, 'utf8');

describe('zstd 会话逐帧读取', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'omk-zstd-frames-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, bytes: Buffer): string => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };
  const collect = (filePath: string, maxDecodedBytes = 8 * 1024 * 1024): Buffer[] =>
    [...iterateZstdFramePlainText(filePath, maxDecodedBytes)];

  it('按帧顺序交出完整明文，不丢帧也不并帧', () => {
    const chunks = collect(write('session.jsonl.zstd', multiFrame));
    assert.equal(Buffer.concat(chunks).toString('utf8'), RECORDS.map((r) => `${r}\n`).join(''));
    assert.equal(chunks.length, RECORDS.length, '一帧一段：帧数即记录数');
  });

  it('一次性 zlib 调用只能解出第一帧，所以帧边界必须自己定位', () => {
    // 真机对照：1.4 MB 的三千帧文件按整个 buffer 一次解只拿回 279 字节，会静默少掉整段证据。
    assert.equal(zstdDecompressSync(multiFrame).length, firstFramePlainText.length);
  });

  it('明文预算用尽时报容量错，而不是安静截断', () => {
    assert.throws(() => collect(write('budget.jsonl.zstd', multiFrame), 24), ZstdDecodedSizeLimitError);
  });

  it('非 zstd 流与截断尾帧都整文件失败，不交出半份记录', () => {
    const notZstd = write('not-zstd.jsonl.zstd', Buffer.from('{"type":"session"}\n', 'utf8'));
    assert.throws(() => collect(notZstd), ZstdFrameDecodeError);

    const truncated = write('truncated.jsonl.zstd', multiFrame.subarray(0, multiFrame.length - 12));
    assert.throws(() => collect(truncated), ZstdFrameDecodeError);
  });

  it('空文件没有帧，读出来就是空', () => {
    assert.deepEqual(collect(write('empty.jsonl.zstd', Buffer.alloc(0))), []);
  });
});
