/**
 * createOverlayReportStore(项目盖全局)语义验收。
 *
 * 两类语义刻意不同:
 *   - 浏览(list / findByVariant):记录优先 —— 项目有报告只看项目,空则全局兜底。
 *   - 寻址(get / exists / findByArtifactHash):项目→全局兜底 / 跨两处合并 —— 拿具体 id / 内容哈
 *     找文件时两处都查,resume / gold-compare / baseline 复用不因写默认翻项目而落空,复用数字不降。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOverlayReportStore } from '../../src/server/report-store.js';

function mkTmp(tag: string): string {
  const d = join(tmpdir(), `omk-overlay-${tag}-${Date.now()}-${Math.round(performance.now())}`);
  mkdirSync(d, { recursive: true });
  return d;
}

interface MiniReportOpts {
  id: string;
  variant: string;
  hash: string;
  timestamp: string;
}

function writeReport(dir: string, opts: MiniReportOpts): void {
  const doc = {
    kind: 'evaluation',
    id: opts.id,
    meta: { timestamp: opts.timestamp, variants: [opts.variant], artifactHashes: { [opts.variant]: opts.hash } },
    summary: { [opts.variant]: {} },
    results: [],
  };
  writeFileSync(join(dir, `${opts.id}.json`), JSON.stringify(doc));
}

describe('createOverlayReportStore 项目盖全局', () => {
  it('都空 → list/get 皆空', async () => {
    const proj = mkTmp('empty-p');
    const glob = mkTmp('empty-g');
    try {
      const store = createOverlayReportStore(proj, glob);
      assert.deepEqual(await store.list(), []);
      assert.equal(await store.get('nope'), null);
      assert.equal(await store.exists('nope'), false);
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('仅全局有 → 浏览看全局,寻址命中全局', async () => {
    const proj = mkTmp('g-only-p');
    const glob = mkTmp('g-only-g');
    try {
      writeReport(glob, { id: 'rg', variant: 'vg', hash: 'hashG', timestamp: '2026-01-01T00:00:00Z' });
      const store = createOverlayReportStore(proj, glob);
      assert.equal((await store.list()).length, 1, '项目空 → 全局兜底');
      assert.equal((await store.get('rg'))?.id, 'rg');
      assert.equal(await store.exists('rg'), true);
      assert.equal((await store.findByVariant('vg')).length, 1, '项目空 → findByVariant 全局兜底');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('项目有报告 → 浏览只看项目(隐藏全局堆),但寻址仍兜底全局', async () => {
    const proj = mkTmp('both-p');
    const glob = mkTmp('both-g');
    try {
      writeReport(glob, { id: 'rg', variant: 'vg', hash: 'hashG', timestamp: '2026-01-01T00:00:00Z' });
      writeReport(proj, { id: 'rp', variant: 'vp', hash: 'hashP', timestamp: '2026-02-02T00:00:00Z' });
      const store = createOverlayReportStore(proj, glob);

      // 浏览(list / findByVariant):记录优先,项目非空 → 只看项目,全局被隐藏(避免 studio 混进跨项目堆)。
      const listed = await store.list();
      assert.equal(listed.length, 1, '项目非空 → list 只项目');
      assert.equal(listed[0].id, 'rp');
      assert.equal((await store.findByVariant('vg')).length, 0, '记录优先:全局 variant 不出现在浏览里');
      assert.equal((await store.findByVariant('vp')).length, 1);

      // 寻址(get / exists):项目→全局兜底,即便项目非空也能拿到全局那份(resume / gold-compare 不落空)。
      assert.equal((await store.get('rg'))?.id, 'rg', 'get 项目→全局兜底');
      assert.equal((await store.get('rp'))?.id, 'rp');
      assert.equal(await store.exists('rg'), true);
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('findByArtifactHash 跨两处合并(项目优先 dedup)→ baseline 复用数字不降', async () => {
    const proj = mkTmp('hash-p');
    const glob = mkTmp('hash-g');
    try {
      writeReport(glob, { id: 'rg', variant: 'vg', hash: 'hashG', timestamp: '2026-01-01T00:00:00Z' });
      writeReport(proj, { id: 'rp', variant: 'vp', hash: 'hashP', timestamp: '2026-02-02T00:00:00Z' });
      const store = createOverlayReportStore(proj, glob);
      // 关键:项目非空时 findByArtifactHash 仍覆盖全局(与 findByVariant 的记录优先不同),
      // 否则 eval 写默认翻项目后复用会漏掉全局 baseline → 复用命中率降 → 报告数字漂移。
      assert.equal((await store.findByArtifactHash('hashG')).length, 1, '项目非空仍命中全局 hash');
      assert.equal((await store.findByArtifactHash('hashP')).length, 1, '命中项目 hash');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('remove:项目找不到再试全局', async () => {
    const proj = mkTmp('rm-p');
    const glob = mkTmp('rm-g');
    try {
      writeReport(glob, { id: 'rg', variant: 'vg', hash: 'hashG', timestamp: '2026-01-01T00:00:00Z' });
      writeReport(proj, { id: 'rp', variant: 'vp', hash: 'hashP', timestamp: '2026-02-02T00:00:00Z' });
      const store = createOverlayReportStore(proj, glob);
      assert.equal(await store.remove('rg'), true, '项目无 → 删全局');
      assert.equal(await store.get('rg'), null, '删后取不到');
      assert.equal(await store.remove('rp'), true, '删项目那份');
      assert.equal(await store.remove('missing'), false, '两处都无 → false');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });
});
