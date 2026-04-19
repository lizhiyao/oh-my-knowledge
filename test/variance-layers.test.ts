import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVarianceData } from '../src/eval-workflows/run-evaluation.js';
import type { Report, VariantSummary } from '../src/types.js';

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
