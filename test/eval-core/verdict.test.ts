import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { computeVerdict, formatVerdictText } from '../../src/eval-core/verdict.js';
import type { Report, VariantSummary } from '../../src/types/index.js';

const summary = (avg: { fact?: number; behavior?: number; judge?: number; composite?: number }): VariantSummary => ({
  totalSamples: 30, successCount: 30, errorCount: 0, errorRate: 0,
  avgDurationMs: 1000, avgInputTokens: 100, avgOutputTokens: 200, avgTotalTokens: 300,
  totalCostUSD: 0.1, totalExecCostUSD: 0.05, totalJudgeCostUSD: 0.05,
  avgCostPerSample: 0.003, avgNumTurns: 1,
  avgFactScore: avg.fact, avgBehaviorScore: avg.behavior, avgJudgeScore: avg.judge,
  avgCompositeScore: avg.composite,
});

const buildReport = (overrides: Partial<Report> & { variants: string[]; perVariantAvg: Record<string, Parameters<typeof summary>[0]>; pairs?: Report['meta']['pairComparisons'] }): Report => ({
  id: 'r1',
  meta: {
    variants: overrides.variants,
    model: 'm', judgeModel: 'j', executor: 'claude',
    sampleCount: 30, taskCount: 30, totalCostUSD: 0,
    timestamp: '2026-04-25T00:00:00Z', cliVersion: 'test', nodeVersion: 'test',
    artifactHashes: Object.fromEntries(overrides.variants.map((v) => [v, 'h'])),
    pairComparisons: overrides.pairs,
    ...(overrides.meta ?? {}),
  },
  summary: Object.fromEntries(Object.entries(overrides.perVariantAvg).map(([v, a]) => [v, summary(a)])),
  results: [],
  variance: overrides.variance,
});

describe('computeVerdict', () => {
  it('PROGRESS for clean significant positive diff with all gates passing', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.3, behavior: 4.2, judge: 4.5, composite: 4.33 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: 0.2, high: 0.5, estimate: 0.33, samples: 1000, significant: true },
      }],
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'PROGRESS');
    assert.match(v.headline, /clean win/);
  });

  it('REGRESS when diff CI is significantly negative', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 3.5, behavior: 3.5, judge: 3.5, composite: 3.5 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: -0.7, high: -0.2, estimate: -0.5, samples: 1000, significant: true },
      }],
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'REGRESS');
  });

  it('NOISE when diff CI spans 0 and N is reasonable', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.05, behavior: 4.0, judge: 4.0, composite: 4.02 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: -0.2, high: 0.25, estimate: 0.02, samples: 1000, significant: false },
      }],
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'NOISE');
  });

  it('UNDERPOWERED when diff is non-significant and N < 20', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.3, behavior: 4.2, judge: 4.5, composite: 4.33 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: -0.05, high: 0.7, estimate: 0.32, samples: 500, significant: false },
      }],
      meta: { sampleCount: 10 } as Partial<Report['meta']> as Report['meta'],
    });
    // Force sampleCount via override.
    r.meta.sampleCount = 10;
    const v = computeVerdict(r);
    assert.equal(v.level, 'UNDERPOWERED');
  });

  it('CAUTIOUS when diff is significant positive but treatment broke a layer gate', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.5, behavior: 3.0, judge: 4.5, composite: 4.0 },  // behavior < 3.5 gate
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: 0.1, high: 0.5, estimate: 0.3, samples: 1000, significant: true },
      }],
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'CAUTIOUS');
    assert.match(v.headline, /broke layer gate/);
  });

  it('CAUTIOUS when diff is significant but trivially small', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.05, behavior: 4.05, judge: 4.05, composite: 4.05 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: 0.01, high: 0.08, estimate: 0.05, samples: 1000, significant: true },
      }],
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'CAUTIOUS');
    assert.match(v.headline, /practically tiny/);
  });

  it('SOLO for single-variant reports', () => {
    const r = buildReport({
      variants: ['only-one'],
      perVariantAvg: {
        'only-one': { fact: 4, behavior: 4, judge: 4 },
      },
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'SOLO');
    assert.match(v.headline, /three-layer gate PASS/);
  });

  it('SOLO with broken gate flags FAIL', () => {
    const r = buildReport({
      variants: ['only-one'],
      perVariantAvg: {
        'only-one': { fact: 2, behavior: 4, judge: 4 },
      },
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'SOLO');
    assert.match(v.headline, /three-layer gate FAIL/);
  });

  it('falls back to point-estimate diff when no bootstrap CI is present', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.3, behavior: 4.3, judge: 4.3, composite: 4.3 },
      },
      // No pairs / no bootstrap.
    });
    const v = computeVerdict(r);
    // No CI → CAUTIOUS for positive delta (not PROGRESS).
    assert.equal(v.level, 'CAUTIOUS');
    assert.match(v.headline, /no CI/);
  });

  it('roll-up returns the worst per-pair verdict', () => {
    const r = buildReport({
      variants: ['baseline', 'skillA', 'skillB'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skillA:   { fact: 4.3, behavior: 4.3, judge: 4.3, composite: 4.3 },
        skillB:   { fact: 3.5, behavior: 3.5, judge: 3.5, composite: 3.5 },
      },
      pairs: [
        { control: 'baseline', treatment: 'skillA', diffBootstrapCI: { low: 0.1, high: 0.5, estimate: 0.3, samples: 1000, significant: true } },
        { control: 'baseline', treatment: 'skillB', diffBootstrapCI: { low: -0.7, high: -0.2, estimate: -0.5, samples: 1000, significant: true } },
      ],
    });
    const v = computeVerdict(r);
    // skillA = PROGRESS, skillB = REGRESS → top-level REGRESS.
    assert.equal(v.level, 'REGRESS');
    assert.equal(v.perPair?.length, 2);
  });

  it('formatVerdictText stays under 6 lines for the headline path', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.3, behavior: 4.3, judge: 4.3, composite: 4.3 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: 0.1, high: 0.5, estimate: 0.3, samples: 1000, significant: true },
      }],
    });
    const v = computeVerdict(r);
    const text = formatVerdictText(v);
    const lines = text.split('\n');
    assert.ok(lines.length <= 6, `expected ≤6 lines, got ${lines.length}: ${text}`);
  });
});
