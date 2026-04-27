import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVarianceData } from '../src/eval-workflows/run-evaluation.js';
import type { Report, VariantSummary } from '../src/types/index.js';

/**
 * Minimal factory for a Report with enough fields to exercise buildVarianceData's
 * cross-run aggregation, including per-layer (fact / behavior / quality) values.
 * All layer values omitted default to undefined so callers can opt into partial data.
 */
interface LayerSeed {
  composite?: number;
  fact?: number;
  behavior?: number;
  quality?: number;
  cost?: number;
  duration?: number;
}

function makeRun(runId: string, perVariant: Record<string, LayerSeed>): Report {
  const summary: Record<string, VariantSummary> = {};
  for (const [variant, seed] of Object.entries(perVariant)) {
    summary[variant] = {
      totalSamples: 5,
      successCount: 5,
      errorCount: 0,
      errorRate: 0,
      avgDurationMs: seed.duration ?? 2000,
      avgInputTokens: 100,
      avgOutputTokens: 500,
      avgTotalTokens: 600,
      totalCostUSD: seed.cost ?? 0.01,
      totalExecCostUSD: seed.cost ?? 0.01,
      totalJudgeCostUSD: 0,
      avgCostPerSample: (seed.cost ?? 0.01) / 5,
      avgNumTurns: 1,
      avgCompositeScore: seed.composite,
      avgFactScore: seed.fact,
      avgBehaviorScore: seed.behavior,
      avgJudgeScore: seed.quality,
    };
  }
  return {
    id: runId,
    meta: {
      variants: Object.keys(perVariant),
      model: 'sonnet',
      judgeModel: 'haiku',
      executor: 'claude',
      sampleCount: 5,
      taskCount: 10,
      totalCostUSD: 0.05,
      timestamp: new Date().toISOString(),
      cliVersion: 'test',
      nodeVersion: process.version,
      artifactHashes: {},
    },
    summary,
    results: [],
  };
}

describe('buildVarianceData — three-layer breakdown (PR-2)', () => {
  it('returns null when only one run is supplied (no variance possible)', () => {
    const result = buildVarianceData([makeRun('r1', { v1: { composite: 4.0, fact: 4.0, behavior: 4.0, quality: 4.0 } })]);
    assert.equal(result, null);
  });

  it('populates byLayer on perVariant for each of fact / behavior / quality when layer scores exist', () => {
    const runs: Report[] = [
      makeRun('r1', {
        v1: { composite: 3.8, fact: 3.5, behavior: 4.0, quality: 4.0 },
        v2: { composite: 4.2, fact: 4.0, behavior: 4.0, quality: 4.6 },
      }),
      makeRun('r2', {
        v1: { composite: 3.9, fact: 3.6, behavior: 4.1, quality: 4.0 },
        v2: { composite: 4.3, fact: 4.1, behavior: 4.0, quality: 4.8 },
      }),
    ];
    const data = buildVarianceData(runs);
    assert.ok(data, 'expected variance data for 2 runs');

    const v1 = data!.perVariant.v1;
    assert.ok(v1.byLayer, 'v1.byLayer should be populated');
    assert.deepEqual(v1.byLayer!.fact!.scores, [3.5, 3.6]);
    assert.deepEqual(v1.byLayer!.behavior!.scores, [4.0, 4.1]);
    assert.deepEqual(v1.byLayer!.judge!.scores, [4.0, 4.0]);

    const v2 = data!.perVariant.v2;
    assert.deepEqual(v2.byLayer!.fact!.scores, [4.0, 4.1]);
    assert.deepEqual(v2.byLayer!.judge!.scores, [4.6, 4.8]);
  });

  it('populates byLayer on each comparison with t-test + effect size per layer', () => {
    const runs: Report[] = [
      makeRun('r1', {
        v1: { composite: 3.8, fact: 3.5, behavior: 4.0, quality: 4.0 },
        v2: { composite: 4.2, fact: 4.0, behavior: 4.0, quality: 4.6 },
      }),
      makeRun('r2', {
        v1: { composite: 3.9, fact: 3.6, behavior: 4.1, quality: 4.0 },
        v2: { composite: 4.3, fact: 4.1, behavior: 4.0, quality: 4.8 },
      }),
    ];
    const data = buildVarianceData(runs);
    assert.ok(data);

    const comp = data!.comparisons[0];
    assert.equal(comp.a, 'v1');
    assert.equal(comp.b, 'v2');
    assert.ok(comp.byLayer, 'comparison.byLayer should be populated');

    // Each layer comparison has its own statistical fields
    for (const key of ['fact', 'behavior', 'judge'] as const) {
      const layer = comp.byLayer![key]!;
      assert.ok('tStatistic' in layer, `${key} layer should have tStatistic`);
      assert.ok('df' in layer, `${key} layer should have df`);
      assert.ok('significant' in layer, `${key} layer should have significant`);
      assert.ok('effectSize' in layer, `${key} layer should have effectSize`);
      assert.ok('meanDiff' in layer, `${key} layer should have meanDiff`);
    }

    // Behavior layer should show no difference (both variants have ~4.0 in both runs).
    const behaviorDiff = Math.abs(comp.byLayer!.behavior!.meanDiff);
    assert.ok(behaviorDiff < 0.1, `behavior layer should show negligible diff, got ${behaviorDiff}`);

    // Quality layer should show the largest gap (v1: ~4.0 vs v2: ~4.7).
    const qualityDiff = Math.abs(comp.byLayer!.judge!.meanDiff);
    assert.ok(qualityDiff > 0.5, `quality layer should show large diff, got ${qualityDiff}`);
  });

  it('omits layers when corresponding score field is missing across all runs', () => {
    // Only fact + composite populated; behavior + quality undefined.
    const runs: Report[] = [
      makeRun('r1', { v1: { composite: 3.8, fact: 3.5 }, v2: { composite: 4.2, fact: 4.0 } }),
      makeRun('r2', { v1: { composite: 3.9, fact: 3.6 }, v2: { composite: 4.3, fact: 4.1 } }),
    ];
    const data = buildVarianceData(runs);
    assert.ok(data);

    const v1 = data!.perVariant.v1;
    assert.ok(v1.byLayer?.fact, 'fact layer should be populated');
    assert.equal(v1.byLayer?.behavior, undefined, 'behavior layer should be absent');
    assert.equal(v1.byLayer?.judge, undefined, 'quality layer should be absent');

    // Comparison side: same expectation.
    const comp = data!.comparisons[0];
    assert.ok(comp.byLayer?.fact);
    assert.equal(comp.byLayer?.behavior, undefined);
    assert.equal(comp.byLayer?.judge, undefined);
  });

  it('边界: single variant across multiple runs — perVariant populated, comparisons empty', () => {
    // 单 variant 跑多次:byLayer 应该有数据(衡量自己的稳定性),但没有 comparison
    // (C(1,2) = 0)。这是"测稳定性但不做 variant 对比"的合法场景。
    const runs: Report[] = [
      makeRun('r1', { v1: { composite: 4.0, fact: 4.0, behavior: 4.0, quality: 4.0 } }),
      makeRun('r2', { v1: { composite: 4.1, fact: 4.1, behavior: 4.1, quality: 4.1 } }),
      makeRun('r3', { v1: { composite: 4.2, fact: 4.2, behavior: 4.2, quality: 4.2 } }),
    ];
    const data = buildVarianceData(runs);
    assert.ok(data);
    assert.ok(data!.perVariant.v1, 'single variant should still populate perVariant');
    assert.ok(data!.perVariant.v1.byLayer, 'byLayer should still fill');
    assert.deepEqual(data!.comparisons, [], 'single variant means no pairwise comparisons');
  });

  it('边界: 3 variant 产生 C(3,2) = 3 comparisons 并带 byLayer', () => {
    const runs: Report[] = [
      makeRun('r1', {
        v1: { composite: 3.0, fact: 3.0, behavior: 3.0, quality: 3.0 },
        v2: { composite: 4.0, fact: 4.0, behavior: 4.0, quality: 4.0 },
        v3: { composite: 4.5, fact: 4.5, behavior: 4.5, quality: 4.5 },
      }),
      makeRun('r2', {
        v1: { composite: 3.1, fact: 3.1, behavior: 3.1, quality: 3.1 },
        v2: { composite: 4.1, fact: 4.1, behavior: 4.1, quality: 4.1 },
        v3: { composite: 4.6, fact: 4.6, behavior: 4.6, quality: 4.6 },
      }),
    ];
    const data = buildVarianceData(runs);
    assert.ok(data);
    assert.equal(data!.comparisons.length, 3, 'C(3,2) = 3 pairwise comparisons');
    // 每个 comparison 都应该有 byLayer
    for (const comp of data!.comparisons) {
      assert.ok(comp.byLayer, `comparison ${comp.a} vs ${comp.b} should have byLayer`);
      assert.ok(comp.byLayer!.fact);
      assert.ok(comp.byLayer!.behavior);
      assert.ok(comp.byLayer!.judge);
    }
    // 三对覆盖正确:v1-v2, v1-v3, v2-v3
    const pairs = data!.comparisons.map((c) => `${c.a}-${c.b}`).sort();
    assert.deepEqual(pairs, ['v1-v2', 'v1-v3', 'v2-v3']);
  });

  it('边界: mean = 0 (全 0 分数)不崩,byLayer 输出 stddev=0', () => {
    // 所有样本 judge=0(评委判全部不合格)。mean=0 是合法数据,不是 NaN。
    // 这是 "judgeScore > 0 过滤 bias" fix 之后的关键 case:0 分样本应该进聚合,
    // 最终 byLayer.judge.mean === 0,stddev === 0,不抛异常。
    const runs: Report[] = [
      makeRun('r1', { v1: { composite: 2.0, fact: 4.0, behavior: 2.0, quality: 0 } }),
      makeRun('r2', { v1: { composite: 2.0, fact: 4.0, behavior: 2.0, quality: 0 } }),
    ];
    const data = buildVarianceData(runs);
    assert.ok(data);
    const judgeStats = data!.perVariant.v1.byLayer?.judge;
    assert.ok(judgeStats, 'judge layer should be populated (0 is valid score, not missing)');
    assert.equal(judgeStats!.mean, 0);
    assert.equal(judgeStats!.stddev, 0);
    assert.deepEqual(judgeStats!.scores, [0, 0]);
  });

  it('keeps composite (top-level) variance alongside byLayer — both coexist', () => {
    const runs: Report[] = [
      makeRun('r1', { v1: { composite: 3.8, fact: 3.5, behavior: 4.0, quality: 4.0 }, v2: { composite: 4.2, fact: 4.0, behavior: 4.0, quality: 4.6 } }),
      makeRun('r2', { v1: { composite: 3.9, fact: 3.6, behavior: 4.1, quality: 4.0 }, v2: { composite: 4.3, fact: 4.1, behavior: 4.0, quality: 4.8 } }),
    ];
    const data = buildVarianceData(runs);
    assert.ok(data);

    // Top-level composite scores (legacy flat fields)
    const v1 = data!.perVariant.v1;
    assert.deepEqual(v1.scores, [3.8, 3.9]);

    // Top-level composite comparison
    const comp = data!.comparisons[0];
    assert.ok('tStatistic' in comp, 'composite comparison tStatistic must exist');
    assert.ok(comp.byLayer, 'layer breakdown must exist');
  });
});
