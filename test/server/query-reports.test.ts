import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileStore, queryRunList, queryRun, queryTrend } from '../../src/server/report-store.js';
import { reportFileName } from '../../src/eval-core/artifact-file-names.js';
import type {
  BatchEvaluationReport,
  Report,
  ReportStore,
  VariantSummary,
} from '../../src/types/index.js';

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
    results: ['s1', 's2'].map((sample_id) => ({
      sample_id,
      variants: {
        [variant]: {
          ok: true,
          durationMs: 1000,
          durationApiMs: 1000,
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          execCostUSD: 0.04,
          judgeCostUSD: 0.01,
          costUSD: 0.05,
          numTurns: 1,
          outputPreview: 'ok',
          compositeScore: avgScore,
        },
      },
    })),
  };
}

function makeBatchReport(id: string): BatchEvaluationReport {
  const baseline = makeReport('child-baseline', 'baseline', '2024-01-01T00:00:00Z', 0.7)
    .summary.baseline;
  const review = makeReport('child-review', 'review', '2024-01-01T00:00:00Z', 0.8)
    .summary.review;
  return {
    kind: 'batch-evaluation',
    id,
    mode: 'skill',
    meta: {
      mode: 'skill',
      schemaVersion: 4,
      model: 'sonnet',
      executor: 'claude',
      skillDir: '/workspace/skills',
      sampleCount: 2,
      taskCount: 4,
      totalArtifacts: 1,
      totalCostUSD: 0.2,
      timestamp: '2024-01-01T00:00:00Z',
      cliVersion: '0.8.1',
      nodeVersion: '20.0.0',
      executorRuntime: {
        executor: 'claude',
        model: 'sonnet',
        runtimeKind: 'agent-cli',
        fingerprint: 'claude:sonnet',
        capabilities: {
          systemPrompt: 'native',
          costUSD: 'reported',
          trace: 'native',
          skillIsolation: 'full',
        },
      },
      executorRuntimes: {
        review: {
          executor: 'claude',
          model: 'sonnet',
          runtimeKind: 'agent-cli',
          fingerprint: 'claude:sonnet',
          capabilities: {
            systemPrompt: 'native',
            costUSD: 'reported',
            trace: 'native',
            skillIsolation: 'full',
          },
        },
      },
      judgeModels: [{
        executor: 'claude',
        model: 'haiku',
        runtime: {
          executor: 'claude',
          model: 'haiku',
          runtimeKind: 'agent-cli',
          fingerprint: 'claude:haiku',
          capabilities: {
            systemPrompt: 'native',
            costUSD: 'reported',
            trace: 'native',
            skillIsolation: 'full',
          },
        },
      }],
    },
    items: [{
      name: 'review',
      skillPath: '/workspace/skills/review',
      samplesPath: '/workspace/skills/review/.omk/samples.json',
      reportId: 'child-review',
      reportPath: '/workspace/.omk/reports/child-review.report.json',
      status: 'completed',
      sampleCount: 2,
      totalCostUSD: 0.2,
      artifactHash: 'abc123',
      summary: { baseline, review },
    }],
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

describe('createFileStore kind-only report loading（无旧格式读兼容）', () => {
  it('无顶层 kind 的历史普通报告不再读取（硬切换、无旧格式兼容）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-legacy-report-'));
    try {
      const legacy = makeReport('legacy-run', 'v1', '2024-01-01T00:00:00Z', 0.8) as unknown as Record<string, unknown>;
      delete legacy.kind;
      delete legacy.id;
      writeFileSync(join(dir, reportFileName('legacy-run')), JSON.stringify(legacy, null, 2));

      const store = createFileStore(dir);
      assert.equal(await store.get('legacy-run'), null);
      assert.deepEqual(await store.list(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('带额外未知顶层判别字段的历史普通报告不读取', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-legacy-extra-discriminant-report-'));
    try {
      const legacy = makeReport('legacy-extra-discriminant-run', 'v1', '2024-01-01T00:00:00Z', 0.8) as unknown as Record<string, unknown>;
      legacy.legacyDiscriminant = 'evaluation';
      delete legacy.kind;
      delete legacy.id;
      writeFileSync(join(dir, reportFileName('legacy-extra-discriminant-run')), JSON.stringify(legacy, null, 2));

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

      const raw = JSON.parse(readFileSync(join(dir, reportFileName('new-run')), 'utf-8')) as Record<string, unknown>;
      assert.equal(raw.kind, 'evaluation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('拒绝文件名、写入键和报告 id 互相错配', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-report-id-mismatch-'));
    try {
      const store = createFileStore(dir);
      writeFileSync(
        join(dir, reportFileName('expected')),
        JSON.stringify(makeReport('other', 'v1', '2024-01-01T00:00:00Z', 0.8)),
      );

      assert.equal(await store.get('expected'), null);
      assert.deepEqual(await store.list(), []);
      await assert.rejects(
        store.save('expected', makeReport('other', 'v1', '2024-01-01T00:00:00Z', 0.8)),
        /invalid report/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非法 id 不得通过文件名清洗别名读取或删除合法报告', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-report-id-alias-'));
    try {
      const store = createFileStore(dir);
      await store.save(
        'victim_report',
        makeReport('victim_report', 'v1', '2024-01-01T00:00:00Z', 0.8),
      );

      assert.equal(await store.get('victim/report'), null);
      assert.equal(await store.remove('victim/report'), false);
      assert.equal((await store.get('victim_report'))?.id, 'victim_report');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('拒绝损坏的核心测量字段，而不是把占位值送进 Studio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-report-schema-'));
    try {
      const invalidSummary = makeReport(
        'invalid-summary',
        'v1',
        '2024-01-01T00:00:00Z',
        0.8,
      ) as unknown as Record<string, unknown>;
      const summary = invalidSummary.summary as Record<string, Record<string, unknown>>;
      summary.v1.successCount = 3;
      writeFileSync(
        join(dir, reportFileName('invalid-summary')),
        JSON.stringify(invalidSummary),
      );

      const invalidTimestamp = makeReport(
        'invalid-timestamp',
        'v1',
        'not-a-time',
        0.8,
      );
      writeFileSync(
        join(dir, reportFileName('invalid-timestamp')),
        JSON.stringify(invalidTimestamp),
      );

      const invalidCost = makeReport(
        'invalid-cost',
        'v1',
        '2024-01-01T00:00:00Z',
        0.8,
      );
      invalidCost.summary.v1.avgCostPerSample = 99;
      writeFileSync(
        join(dir, reportFileName('invalid-cost')),
        JSON.stringify(invalidCost),
      );

      const invalidTiming = makeReport(
        'invalid-timing',
        'v1',
        '2024-01-01T00:00:00Z',
        0.8,
      );
      invalidTiming.results[0].variants.v1.timing = {
        execMs: 100,
        gradeMs: 50,
        totalMs: 999,
      };
      writeFileSync(
        join(dir, reportFileName('invalid-timing')),
        JSON.stringify(invalidTiming),
      );

      const store = createFileStore(dir);
      assert.equal(await store.get('invalid-summary'), null);
      assert.equal(await store.get('invalid-timestamp'), null);
      assert.equal(await store.get('invalid-cost'), null);
      assert.equal(await store.get('invalid-timing'), null);
      assert.deepEqual(await store.list(), []);
      await assert.rejects(
        store.save('invalid-summary', invalidSummary as unknown as Report),
        /invalid report/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('批量报告的 meta 必须能由 items 重算，且 item 只能包含 baseline 与自身 skill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-batch-report-schema-'));
    try {
      const store = createFileStore(dir);
      const valid = makeBatchReport('batch-valid');
      await store.save(valid.id, valid);
      assert.equal((await store.get(valid.id))?.id, valid.id);

      const wrongTaskCount = makeBatchReport('batch-wrong-task-count');
      wrongTaskCount.meta.taskCount += 1;
      await assert.rejects(
        store.save(wrongTaskCount.id, wrongTaskCount),
        /invalid report/,
      );

      const wrongSummaryIdentity = makeBatchReport('batch-wrong-summary');
      wrongSummaryIdentity.items[0].summary = {
        baseline: wrongSummaryIdentity.items[0].summary.baseline,
        other: wrongSummaryIdentity.items[0].summary.review,
      };
      await assert.rejects(
        store.save(wrongSummaryIdentity.id, wrongSummaryIdentity),
        /invalid report/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list 缓存不向调用方暴露可变内部对象，并在写入后立即失效', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-report-cache-isolation-'));
    try {
      const store = createFileStore(dir);
      await store.save('r1', makeReport('r1', 'v1', '2024-01-01T00:00:00Z', 0.8));

      const first = await store.list();
      first[0].id = 'mutated';
      first[0].meta.timestamp = '2099-01-01T00:00:00Z';
      const second = await store.list();
      assert.equal(second[0].id, 'r1');
      assert.equal(second[0].meta.timestamp, '2024-01-01T00:00:00Z');

      await store.save('r2', makeReport('r2', 'v1', '2024-01-02T00:00:00Z', 0.9));
      assert.deepEqual((await store.list()).map((report) => report.id), ['r2', 'r1']);
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
      writeFileSync(join(dir, reportFileName('legacy-extra-discriminant-batch')), JSON.stringify(legacyBatch, null, 2));

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
      writeFileSync(join(dir, reportFileName('legacy-batch')), JSON.stringify(legacyBatch, null, 2));

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
