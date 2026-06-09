import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileStore, queryRunList, queryRun, queryTrend } from '../../src/server/report-store.js';
import type { Report, ReportStore, VariantSummary } from '../../src/types/index.js';

function makeReport(id: string, variant: string, timestamp: string, avgScore: number | undefined): Report {
  const summary: Record<string, VariantSummary> = {
    [variant]: {
      totalSamples: 2,
      successCount: 2,
      errorCount: 0,
      errorRate: 0,
      avgDurationMs: 1000,
      avgInputTokens: 100,
      avgOutputTokens: 200,
      avgTotalTokens: 300,
      totalCostUSD: 0.1,
      totalExecCostUSD: 0.08,
      totalJudgeCostUSD: 0.02,
      avgCostPerSample: 0.05,
      avgNumTurns: 1,
      avgCompositeScore: avgScore,
    },
  };
  return {
    kind: 'evaluation',
    id,
    meta: {
      variants: [variant],
      model: 'sonnet',
      judgeModels: [{ executor: 'claude', model: 'haiku' }],
      executor: 'claude',
      sampleCount: 2,
      taskCount: 2,
      totalCostUSD: 0.1,
      timestamp,
      cliVersion: '0.8.1',
      nodeVersion: '20.0.0',
      artifactHashes: { [variant]: 'abc123' },
    },
    summary,
    results: [],
  };
}

function createMockReportStore(reports: Report[]): ReportStore {
  const map = new Map(reports.map((r) => [r.id, r]));
  return {
    list: async () => [...reports],
    get: async (id: string) => map.get(id) ?? null,
    save: async () => { },
    update: async () => null,
    remove: async () => false,
    exists: async (id: string) => map.has(id),
    findByVariant: async (name: string) => reports.filter((r) => r.meta.variants.includes(name)),
    findByArtifactHash: async (hash: string) => reports.filter((r) => Object.values(r.meta.artifactHashes).includes(hash)),
  };
}

describe('queryRunList', () => {
  it('返回列表项包含 id、meta、summary', async () => {
    const reports = [makeReport('r1', 'v1', '2024-01-01T00:00:00Z', 0.8)];
    const store = createMockReportStore(reports);
    const list = await queryRunList(store);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'r1');
    assert.equal(list[0].kind, 'evaluation');
    assert.ok(list[0].meta);
    assert.ok(list[0].summary);
    assert.equal(list[0].meta.model, 'sonnet');
  });
});

describe('createFileStore legacy report loading', () => {
  it('把无 kind 的历史普通报告归一化为 evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-legacy-report-'));
    try {
      const legacy = makeReport('legacy-run', 'v1', '2024-01-01T00:00:00Z', 0.8) as unknown as Record<string, unknown>;
      delete legacy.kind;
      delete legacy.id;
      writeFileSync(join(dir, 'legacy-run.json'), JSON.stringify(legacy, null, 2));

      const store = createFileStore(dir);
      const report = await store.get('legacy-run');
      assert.equal(report?.kind, 'evaluation');
      assert.equal(report?.id, 'legacy-run');
      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].kind, 'evaluation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不兼容带额外未知顶层判别字段的历史普通报告', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-legacy-extra-discriminant-report-'));
    try {
      const legacy = makeReport('legacy-extra-discriminant-run', 'v1', '2024-01-01T00:00:00Z', 0.8) as unknown as Record<string, unknown>;
      legacy.legacyDiscriminant = 'evaluation';
      delete legacy.kind;
      delete legacy.id;
      writeFileSync(join(dir, 'legacy-extra-discriminant-run.json'), JSON.stringify(legacy, null, 2));

      const store = createFileStore(dir);
      assert.equal(await store.get('legacy-extra-discriminant-run'), null);
      assert.deepEqual(await store.list(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('保存 report 时只写 canonical kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-kind-report-'));
    try {
      const store = createFileStore(dir);
      await store.save('new-run', makeReport('new-run', 'v1', '2024-01-01T00:00:00Z', 0.8));

      const raw = JSON.parse(readFileSync(join(dir, 'new-run.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(raw.kind, 'evaluation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不兼容带额外未知顶层判别字段的历史批量报告', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-legacy-extra-discriminant-batch-report-'));
    try {
      const legacyBatch = {
        legacyDiscriminant: 'batch-evaluation',
        id: 'legacy-extra-discriminant-batch',
        mode: 'skill',
        meta: {
          mode: 'skill',
          model: 'sonnet',
          executor: 'claude',
          skillDir: 'skills',
          sampleCount: 1,
          taskCount: 2,
          totalArtifacts: 1,
          totalCostUSD: 0,
          timestamp: '2024-01-01T00:00:00Z',
          cliVersion: '0.8.1',
          nodeVersion: '20.0.0',
          judgeModels: [{ executor: 'claude', model: 'haiku' }],
        },
        items: [],
      };
      writeFileSync(join(dir, 'legacy-extra-discriminant-batch.json'), JSON.stringify(legacyBatch, null, 2));

      const store = createFileStore(dir);
      assert.equal(await store.get('legacy-extra-discriminant-batch'), null);
      assert.deepEqual(await store.list(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不把旧混合批量报告误认为 evaluation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-legacy-batch-'));
    try {
      const legacyBatch = makeReport('legacy-batch', 'v1', '2024-01-01T00:00:00Z', 0.8) as unknown as Record<string, unknown>;
      delete legacyBatch.kind;
      legacyBatch.overview = { totalArtifacts: 1, totalSamples: 1, totalCostUSD: 0, artifacts: [] };
      legacyBatch.artifacts = [];
      writeFileSync(join(dir, 'legacy-batch.json'), JSON.stringify(legacyBatch, null, 2));

      const store = createFileStore(dir);
      assert.equal(await store.get('legacy-batch'), null);
      assert.deepEqual(await store.list(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('queryRun', () => {
  const reports = [makeReport('r1', 'v1', '2024-01-01T00:00:00Z', 0.9)];
  const store = createMockReportStore(reports);

  it('返回指定 id 的 report', async () => {
    const report = await queryRun(store, 'r1');
    assert.equal(report!.id, 'r1');
  });

  it('不存在的 id 返回 null', async () => {
    const report = await queryRun(store, 'nonexistent');
    assert.equal(report, null);
  });
});

describe('queryTrend', () => {
  it('返回指定 variant 的趋势数据', async () => {
    const reports = [
      makeReport('r1', 'v1', '2024-01-01T00:00:00Z', 0.7),
      makeReport('r2', 'v1', '2024-01-02T00:00:00Z', 0.85),
    ];
    const store = createMockReportStore(reports);
    const result = await queryTrend(store, 'v1');
    assert.equal(result.variant, 'v1');
    assert.equal(result.points.length, 2);
    assert.equal(result.points[0].avgCompositeScore, 0.7);
    assert.equal(result.points[1].avgCompositeScore, 0.85);
    assert.equal(result.runs.length, 2);
  });
});
