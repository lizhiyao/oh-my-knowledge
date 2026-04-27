import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVarianceData } from '../src/eval-workflows/run-evaluation.js';
import type { Report, VariantResult } from '../src/types/index.js';

const variantResult = (compositeScore: number): VariantResult => ({
  ok: true,
  durationMs: 0, durationApiMs: 0, inputTokens: 0, outputTokens: 0,
  totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  execCostUSD: 0, judgeCostUSD: 0, costUSD: 0, numTurns: 0,
  compositeScore,
  outputPreview: null,
});

const buildRun = (
  runId: string,
  variantScores: Record<string, number[]>,
): Report => {
  const variants = Object.keys(variantScores);
  const sampleCount = variantScores[variants[0]].length;
  return {
    id: runId,
    meta: {
      variants,
      model: 'm', judgeModel: 'j', executor: 'claude',
      sampleCount, taskCount: sampleCount,
      totalCostUSD: 0,
      timestamp: '2026-04-25T00:00:00Z',
      cliVersion: 'test', nodeVersion: 'test',
      artifactHashes: Object.fromEntries(variants.map((v) => [v, 'h'])),
    },
    summary: Object.fromEntries(variants.map((v) => [v, {} as unknown])) as unknown as Report['summary'],
    results: Array.from({ length: sampleCount }, (_, i) => ({
      sample_id: `s${i}`,
      variants: Object.fromEntries(variants.map((v) => [v, variantResult(variantScores[v][i])])),
    })),
  };
};

describe('buildSaturationData via buildVarianceData', () => {
  it('populates saturation field when repeat ≥ 2', () => {
    const r1 = buildRun('r1', { v1: [3, 4, 5] });
    const r2 = buildRun('r2', { v1: [3, 4, 5] });
    const data = buildVarianceData([r1, r2]);
    assert.ok(data?.saturation);
    assert.equal(data!.saturation!.checkpointSampleCounts.length, 2);
    assert.equal(data!.saturation!.perVariant.v1.length, 2);
    // No verdict at repeat=2 (< 5).
    assert.equal(data!.saturation!.verdicts, undefined);
  });

  it('computes verdicts when repeat ≥ 5', () => {
    const stable = (rid: string) => buildRun(rid, { v1: [4, 4, 4, 4, 4] });
    const runs = [stable('r1'), stable('r2'), stable('r3'), stable('r4'), stable('r5')];
    const data = buildVarianceData(runs);
    assert.ok(data?.saturation?.verdicts);
    const verdict = data!.saturation!.verdicts!.v1;
    assert.equal(verdict.method, 'bootstrap-ci-width');
    // Stable scores → CI width = 0 throughout → relative shrink = 0 → saturated.
    assert.equal(verdict.saturated, true);
  });

  it('cumulative sample count is monotonically increasing', () => {
    const runs = Array.from({ length: 6 }, (_, i) => buildRun(`r${i}`, { v1: [4, 4, 4] }));
    const data = buildVarianceData(runs);
    const counts = data!.saturation!.checkpointSampleCounts;
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] >= counts[i - 1], `counts must be non-decreasing, got ${counts}`);
    }
    assert.equal(counts[counts.length - 1], 18); // 6 runs × 3 samples each
  });

  it('handles multi-variant runs', () => {
    const r1 = buildRun('r1', { control: [3, 3, 4], treatment: [4, 5, 5] });
    const r2 = buildRun('r2', { control: [3, 3, 4], treatment: [4, 5, 5] });
    const data = buildVarianceData([r1, r2]);
    assert.ok(data?.saturation);
    assert.ok(data!.saturation!.perVariant.control);
    assert.ok(data!.saturation!.perVariant.treatment);
  });

  it('omits saturation when fewer than 2 runs', () => {
    const data = buildVarianceData([buildRun('r1', { v1: [3, 4, 5] })]);
    assert.equal(data, null);
  });
});
