/**
 * 测试集水印 hash 计算(spec §7.1)。
 *
 * 规则:
 *   - 文件层:按文件名排序后,把每个文件 basename + sha256 拼成 manifest
 *   - 语义层:调用方传入 report.meta.sampleHashes 时,再追加排序后的
 *     sample_id + 完整样本契约指纹(包含外部 mock / custom assertion 依赖)
 *   - 对完整 manifest 再 sha256,取前 12 hex chars。这样:
 *       1. 加 / 删 sample 文件 → hash 变
 *       2. 任一文件内容改 → hash 变
 *       3. 同样文件不同顺序 → hash 不变(排序后稳定)
 *
 * 历史问题: 之前对目录 readFileSync() 抛 EISDIR → 返回 null,gap report 水印丢失。
 *
 * 导出:
 *   - `computeTestSetHash`: pipeline 内部使用
 *   - `_computeTestSetHashForTest`: 单测专用别名,保留以兼容历史 import surface
 *     (`test/eval-workflows/test-set-hash.test.ts`)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export function computeTestSetHash(
  samplesPath: string,
  sourceFiles?: string[],
  sampleHashes?: Record<string, string>,
): string | null {
  // 优先 sourceFiles(目录模式可靠),fallback samplesPath 兼容老调用
  const files = sourceFiles && sourceFiles.length > 0
    ? [...sourceFiles].sort()
    : (samplesPath && existsSync(samplesPath) ? [samplesPath] : []);
  if (files.length === 0) return null;
  try {
    if (files.length === 1 && !sampleHashes) {
      return createHash('sha256').update(readFileSync(files[0], 'utf-8')).digest('hex').slice(0, 12);
    }
    const fileManifest = files.map((f) => {
      const base = f.split(/[/\\]/).pop() ?? f;
      const inner = createHash('sha256').update(readFileSync(f, 'utf-8')).digest('hex');
      return `file:${base}:${inner}`;
    });
    const sampleManifest = sampleHashes
      ? Object.entries(sampleHashes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sampleId, hash]) => `sample:${sampleId}:${hash}`)
      : [];
    const manifest = [...fileManifest, ...sampleManifest].join('\n');
    return createHash('sha256').update(manifest).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export function _computeTestSetHashForTest(
  samplesPath: string,
  sourceFiles?: string[],
  sampleHashes?: Record<string, string>,
): string | null {
  return computeTestSetHash(samplesPath, sourceFiles, sampleHashes);
}
