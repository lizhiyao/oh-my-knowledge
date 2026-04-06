import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryRunList, queryRun, queryTrend } from '../../src/server/report-store.js';
import type { Report, ReportStore, VariantSummary } from '../../src/types.js';

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
    id,
    meta: {
      variants: [variant],
      model: 'sonnet',
      judgeModel: 'haiku',
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
    assert.ok(list[0].meta);
    assert.ok(list[0].summary);
    assert.equal(list[0].meta.model, 'sonnet');
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
