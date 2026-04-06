import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildVarianceData } from '../src/eval-workflows/run-evaluation.js';
import type { Report, VariantSummary } from '../src/types.js';

function makeReport(id: string, variantScores: Record<string, number>): Report {
  return {
    id,
    meta: {
      variants: Object.keys(variantScores),
      model: 'test-model',
      judgeModel: 'test-judge',
      executor: 'test-executor',
      sampleCount: 1,
      taskCount: 1,
      totalCostUSD: 0,
      timestamp: new Date().toISOString(),
      cliVersion: 'test',
      nodeVersion: process.version,
      artifactHashes: {},
    },
    summary: Object.fromEntries(
      Object.entries(variantScores).map(([variant, score]) => [
        variant,
        { avgCompositeScore: score } as VariantSummary,
      ]),
    ),
    results: [],
  };
}

describe('buildVarianceData', () => {
  it('returns null for a single run', () => {
    const runs = [makeReport('r1', { v1: 0.5, v2: 0.6 })];
    assert.equal(buildVarianceData(runs), null);
  });

  it('aggregates per-variant scores across repeated runs', () => {
    const runs = [
      makeReport('r1', { v1: 0.4, v2: 0.8 }),
      makeReport('r2', { v1: 0.6, v2: 0.7 }),
      makeReport('r3', { v1: 0.5, v2: 0.9 }),
    ];

    const variance = buildVarianceData(runs);
    assert.ok(variance);
    assert.equal(variance.runs, 3);
    assert.deepEqual(variance.perVariant.v1.scores, [0.4, 0.6, 0.5]);
    assert.deepEqual(variance.perVariant.v2.scores, [0.8, 0.7, 0.9]);
    assert.equal(variance.comparisons.length, 1);
    assert.equal(variance.comparisons[0].a, 'v1');
    assert.equal(variance.comparisons[0].b, 'v2');
  });
});
