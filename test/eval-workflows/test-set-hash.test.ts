/**
 * computeTestSetHash 回归 — PR #95 review P2-1。
 *
 * 之前对目录 readFileSync() 抛 EISDIR → 返回 null,gap report 水印彻底丢失。
 * 修后:
 *   - 单文件 / sourceFiles 单元素:hash 该文件内容
 *   - 多文件目录模式:manifest = 排序文件名:文件 hash,再 hash;
 *     文件名变 / 内容变 / 加删文件都 invalidate;同样文件顺序不影响 hash
 */
import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _computeTestSetHashForTest as computeTestSetHash } from '../../src/eval-workflows/evaluation-pipeline.js';

describe('computeTestSetHash', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    tmpDirs.length = 0;
  });
  function mkDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'omk-hash-'));
    tmpDirs.push(d);
    return d;
  }

  it('单文件模式:hash 文件内容,12 hex chars', () => {
    const d = mkDir();
    const f = join(d, 'samples.json');
    writeFileSync(f, '[{"sample_id":"s1","prompt":"hello"}]');
    const h = computeTestSetHash(f);
    assert.ok(h);
    assert.match(h!, /^[0-9a-f]{12}$/);
  });

  it('目录模式:对目录路径不再抛 EISDIR;走 sourceFiles 路径', () => {
    const d = mkDir();
    const a = join(d, 'a.json');
    const b = join(d, 'b.json');
    writeFileSync(a, '[{"sample_id":"s1","prompt":"a"}]');
    writeFileSync(b, '[{"sample_id":"s2","prompt":"b"}]');
    // 老路径会对 d readFileSync 抛错 → null。新路径传 sourceFiles 走 manifest
    const h = computeTestSetHash(d, [a, b]);
    assert.ok(h);
    assert.match(h!, /^[0-9a-f]{12}$/);
  });

  it('目录模式:sourceFiles 顺序不影响 hash(内部排序)', () => {
    const d = mkDir();
    const a = join(d, 'a.json');
    const b = join(d, 'b.json');
    writeFileSync(a, '[{"sample_id":"s1","prompt":"a"}]');
    writeFileSync(b, '[{"sample_id":"s2","prompt":"b"}]');
    const h1 = computeTestSetHash(d, [a, b]);
    const h2 = computeTestSetHash(d, [b, a]);
    assert.equal(h1, h2);
  });

  it('目录模式:任一文件内容改 invalidate hash', () => {
    const d = mkDir();
    const a = join(d, 'a.json');
    const b = join(d, 'b.json');
    writeFileSync(a, '[{"sample_id":"s1","prompt":"a"}]');
    writeFileSync(b, '[{"sample_id":"s2","prompt":"b"}]');
    const h1 = computeTestSetHash(d, [a, b]);
    writeFileSync(b, '[{"sample_id":"s2","prompt":"b-modified"}]');
    const h2 = computeTestSetHash(d, [a, b]);
    assert.notEqual(h1, h2);
  });

  it('目录模式:加 / 删文件 invalidate hash', () => {
    const d = mkDir();
    const a = join(d, 'a.json');
    const b = join(d, 'b.json');
    writeFileSync(a, '[{"sample_id":"s1","prompt":"a"}]');
    writeFileSync(b, '[{"sample_id":"s2","prompt":"b"}]');
    const h1 = computeTestSetHash(d, [a, b]);
    const h2 = computeTestSetHash(d, [a]);
    assert.notEqual(h1, h2);
  });

  it('samplesPath 文件不存在且 sourceFiles 空 → null', () => {
    assert.equal(computeTestSetHash('/nonexistent.json', []), null);
    assert.equal(computeTestSetHash('/nonexistent.json'), null);
  });
});
