import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mergeEvolveReports, type RoundReport } from '../src/authoring/evolver.js';
import type { Report, VariantResult, VariantSummary } from '../src/types.js';

function makeVariantResult(score: number): VariantResult {
  return { ok: true, durationMs: 1000, compositeScore: score } as VariantResult;
}

function makeSummary(avgScore: number): VariantSummary {
  return { totalSamples: 2, successCount: 2, errorCount: 0, errorRate: 0, avgCompositeScore: avgScore } as VariantSummary;
}

function makeReport(variantName: string, sampleScores: Record<string, number>, avgScore: number): Report {
  return {
    id: `${variantName}-id`,
    meta: {
      variants: [variantName],
      model: 'sonnet',
      judgeModel: 'sonnet',
      executor: 'claude',
      sampleCount: Object.keys(sampleScores).length,
      taskCount: Object.keys(sampleScores).length,
      totalCostUSD: 0.5,
      timestamp: '2026-04-08T12:00:00Z',
      cliVersion: '0.12.0',
      nodeVersion: 'v24.14.0',
      artifactHashes: {},
    },
    summary: { [variantName]: makeSummary(avgScore) },
    results: Object.entries(sampleScores).map(([sampleId, score]) => ({
      sample_id: sampleId,
      variants: { [variantName]: makeVariantResult(score) },
    })),
  };
}

describe('mergeEvolveReports', () => {
  it('合并多轮报告为一份，各轮作为 variant', () => {
    const roundReports: RoundReport[] = [
      { round: 0, accepted: true, report: makeReport('skill-r0', { s001: 2.5, s002: 3.0 }, 2.75) },
      { round: 1, accepted: true, report: makeReport('skill-r1', { s001: 4.0, s002: 4.5 }, 4.25) },
      { round: 2, accepted: false, report: makeReport('skill-r2', { s001: 1.5, s002: 2.0 }, 1.75) },
    ];

    const merged = mergeEvolveReports(roundReports, 'test-skill', 1.5);

    // variant labels
    assert.deepEqual(merged.meta.variants, ['round-0', 'round-1', 'round-2']);

    // summary has all 3 variants
    assert.ok(merged.summary['round-0']);
    assert.ok(merged.summary['round-1']);
    assert.ok(merged.summary['round-2']);
    assert.equal(merged.summary['round-0'].avgCompositeScore, 2.75);
    assert.equal(merged.summary['round-1'].avgCompositeScore, 4.25);
    assert.equal(merged.summary['round-2'].avgCompositeScore, 1.75);

    // results: 2 samples, each with 3 variants
    assert.equal(merged.results.length, 2);
    const s001 = merged.results.find((r) => r.sample_id === 's001')!;
    assert.equal(s001.variants['round-0'].compositeScore, 2.5);
    assert.equal(s001.variants['round-1'].compositeScore, 4.0);
    assert.equal(s001.variants['round-2'].compositeScore, 1.5);

    // totalCostUSD
    assert.equal(merged.meta.totalCostUSD, 1.5);

    // id starts with evolve-
    assert.ok(merged.id.startsWith('evolve-test-skill-'));
  });

  it('单轮（仅 baseline）也能正常生成报告', () => {
    const roundReports: RoundReport[] = [
      { round: 0, accepted: true, report: makeReport('skill', { s001: 3.0 }, 3.0) },
    ];

    const merged = mergeEvolveReports(roundReports, 'solo', 0.5);

    assert.deepEqual(merged.meta.variants, ['round-0']);
    assert.equal(merged.results.length, 1);
    assert.equal(merged.results[0].variants['round-0'].compositeScore, 3.0);
  });
});
