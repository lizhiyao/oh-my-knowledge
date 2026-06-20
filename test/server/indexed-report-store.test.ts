/**
 * createIndexedReportStore 机器级总览验收:当前项目 + 全局 live ∪ 别项目索引卡片,按 id dedup;
 * get live 命中真身 / 别项目按卡片 path 读真身 / 悬空降级壳;findByVariant/Hash 跨项目;remove 删真身+卡片。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIndexedReportStore } from '../../src/server/indexed-report-store.js';
import { artifactIndexDir } from '../../src/eval-core/artifact-index.js';
import { reportFileName } from '../../src/eval-core/artifact-file-names.js';

interface MiniDoc { kind: 'evaluation'; id: string; meta: Record<string, unknown>; summary: Record<string, unknown>; results: unknown[]; }

function evalDoc(id: string, variant = 'v1', hash = 'h1', ts = '2026-06-14T00:00:00Z'): MiniDoc {
  return {
    kind: 'evaluation',
    id,
    meta: { timestamp: ts, variants: [variant], artifactHashes: { [variant]: hash } },
    summary: { [variant]: {} },
    results: [{ sample_id: 's1', variants: {} }],
  };
}

function writeReportFile(dir: string, doc: MiniDoc): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, reportFileName(doc.id)), JSON.stringify(doc));
}

function writeCard(id: string, path: string, doc: MiniDoc): void {
  const dir = artifactIndexDir('report');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ domain: 'report', id, path, kind: doc.kind, meta: doc.meta, summary: doc.summary }));
}

describe('createIndexedReportStore 机器级总览', () => {
  let proj: string;
  let glob: string;
  let other: string;
  let idxRoot: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    origEnv = process.env.OMK_ARTIFACT_INDEX_DIR;
    idxRoot = mkdtempSync(join(tmpdir(), 'omk-irs-idx-'));
    process.env.OMK_ARTIFACT_INDEX_DIR = idxRoot;
    proj = mkdtempSync(join(tmpdir(), 'omk-irs-proj-'));
    glob = mkdtempSync(join(tmpdir(), 'omk-irs-glob-'));
    other = mkdtempSync(join(tmpdir(), 'omk-irs-other-'));
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.OMK_ARTIFACT_INDEX_DIR;
    else process.env.OMK_ARTIFACT_INDEX_DIR = origEnv;
    for (const d of [idxRoot, proj, glob, other]) rmSync(d, { recursive: true, force: true });
  });

  it('list:当前项目 + 全局 live ∪ 别项目卡片,按 id dedup + 时序 desc', async () => {
    writeReportFile(proj, evalDoc('rp', 'vp', 'hp', '2026-03-01T00:00:00Z'));
    writeReportFile(glob, evalDoc('rg', 'vg', 'hg', '2026-02-01T00:00:00Z'));
    const otherDoc = evalDoc('ro', 'vo', 'ho', '2026-01-01T00:00:00Z');
    writeReportFile(other, otherDoc); // 别项目真身(卡片 path 指向它;悬空过滤要求真身在)
    writeCard('ro', join(other, reportFileName('ro')), otherDoc); // 别项目:仅卡片(本 store 不 live 扫 other)
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    assert.deepEqual((await store.list()).map((r) => r.id), ['rp', 'rg', 'ro']);
  });

  it('list:同 id 在 live 与卡片都有 → live 盖卡片,只一条', async () => {
    writeReportFile(proj, evalDoc('rp'));
    writeCard('rp', join(other, reportFileName('rp')), evalDoc('rp')); // 重复卡片
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    assert.equal((await store.list()).filter((r) => r.id === 'rp').length, 1);
  });

  it('get:live 命中完整真身;别项目按卡片 path 读真身(含 results)', async () => {
    writeReportFile(proj, evalDoc('rp'));
    const otherDoc = evalDoc('ro');
    writeReportFile(other, otherDoc);
    writeCard('ro', join(other, reportFileName('ro')), otherDoc);
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    const live = await store.get('rp');
    assert.equal(live?.kind === 'evaluation' ? live.results.length : -1, 1, 'live 完整 results');
    const viaCard = await store.get('ro');
    assert.equal(viaCard?.id, 'ro');
    assert.equal(viaCard?.kind === 'evaluation' ? viaCard.results.length : -1, 1, '别项目按 path 读到完整真身');
  });

  it('get 悬空:卡片在但真身没了 → 卡片壳(results:[]) 不抛、非 null', async () => {
    writeCard('ro', join(other, reportFileName('gone')), evalDoc('ro')); // 真身文件不存在
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    const got = await store.get('ro');
    assert.equal(got?.id, 'ro');
    assert.deepEqual(got?.kind === 'evaluation' ? got.results : null, [], '悬空降级为壳');
  });

  it('findByVariant / findByArtifactHash 跨项目(含别项目卡片)', async () => {
    const ro = evalDoc('ro', 'vo', 'ho');
    writeReportFile(other, ro);
    writeCard('ro', join(other, reportFileName('ro')), ro);
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    assert.equal((await store.findByVariant('vo')).length, 1);
    assert.equal((await store.findByArtifactHash('ho')).length, 1);
  });

  it('卡片缓存按 per-file 指纹失效:构造 store 后再写/删卡片,list 立即反映', async () => {
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    assert.deepEqual((await store.list()).map((r) => r.id), [], '初始空');
    writeReportFile(other, evalDoc('ro')); // 真身
    writeCard('ro', join(other, reportFileName('ro')), evalDoc('ro')); // 构造后新增卡片
    assert.deepEqual((await store.list()).map((r) => r.id), ['ro'], '新卡片立即可见(指纹失效)');
    await store.remove('ro'); // 删卡片
    assert.deepEqual((await store.list()).map((r) => r.id), [], '删后立即消失');
  });

  it('list 不展示悬空卡片(穿透缓存):首次可见进缓存后,仅删真身(卡片 JSON / 目录不变)→ 再 list 应消失', async () => {
    const ro = evalDoc('ro', 'vo', 'ho');
    writeReportFile(other, ro);
    writeCard('ro', join(other, reportFileName('ro')), ro);
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    assert.deepEqual((await store.list()).map((r) => r.id), ['ro'], '真身在 → 卡片可见(进 cardDocs 缓存)');
    rmSync(join(other, reportFileName('ro')), { force: true }); // 仅删真身,不动卡片 JSON / 卡片目录(不靠卡片目录指纹变化)
    assert.deepEqual((await store.list()).map((r) => r.id), [], '真身没了 → 真身 sentinel 使缓存失效,悬空卡片不再展示');
  });

  it('remove:删 live 真身 + 删卡片;别项目删不到真身但删卡片仍报成功、从 list 消失', async () => {
    writeReportFile(proj, evalDoc('rp'));
    writeCard('ro', join(other, reportFileName('ro')), evalDoc('ro'));
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    assert.equal(await store.remove('rp'), true, '删项目真身');
    assert.equal(await store.remove('ro'), true, '别项目删卡片即成功');
    assert.deepEqual((await store.list()).map((r) => r.id), []);
  });

  it('remove:同一 id 在项目与全局都有副本(迁移期) → 两份都删、不短路,删后 list/get 都不再命中', async () => {
    writeReportFile(proj, evalDoc('dup'));
    writeReportFile(glob, evalDoc('dup'));
    const store = createIndexedReportStore({ projectDir: proj, globalDir: glob });
    assert.equal((await store.list()).filter((r) => r.id === 'dup').length, 1, 'dedup 后只一条');
    assert.equal(await store.remove('dup'), true);
    assert.equal(await store.get('dup'), null, 'remove 后 get 不再命中(全局副本未被 || 短路漏删)');
    assert.deepEqual((await store.list()).map((r) => r.id), [], 'list 不再浮出全局同 id');
  });
});
