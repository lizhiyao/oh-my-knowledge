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
  kind: 'evaluation',
  id: 'r1',
  meta: {
    variants: overrides.variants,
    model: 'm', judgeModels: [{ executor: 'claude', model: 'j' }], executor: 'claude',
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

  // --- inter-judge dissent gate -------------------------------------------
  // A clean, gate-passing positive diff. Tests below vary only the ensemble
  // agreement on top of this to isolate the dissent gate.
  const cleanProgress = (): Report => buildReport({
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
  const withAgreement = (r: Report, variant: string, agreement: VariantSummary['judgeAgreement']): Report => {
    const s = r.summary[variant];
    assert.ok(s, `variant ${variant} missing from summary`);
    s.judgeAgreement = agreement;
    return r;
  };

  it('PROGRESS downgrades to CAUTIOUS when treatment judges strongly disagree (Pearson < 0.4)', () => {
    const r = withAgreement(cleanProgress(), 'skill', { pearson: 0.3, meanAbsDiff: 1.2, pairCount: 1, sampleCount: 30 });
    const v = computeVerdict(r);
    assert.equal(v.level, 'CAUTIOUS');
    assert.match(v.headline, /judges disagree on skill/);
  });

  it('PROGRESS stays PROGRESS when the ensemble agrees (high Pearson)', () => {
    const r = withAgreement(cleanProgress(), 'skill', { pearson: 0.85, meanAbsDiff: 0.3, pairCount: 1, sampleCount: 30 });
    const v = computeVerdict(r);
    assert.equal(v.level, 'PROGRESS');
  });

  it('no dissent downgrade when Pearson is undefined (single / constant-score judge)', () => {
    const r = withAgreement(cleanProgress(), 'skill', { meanAbsDiff: 2.0, pairCount: 1, sampleCount: 30 });
    const v = computeVerdict(r);
    assert.equal(v.level, 'PROGRESS');
  });

  it('dissent on the control variant also downgrades PROGRESS to CAUTIOUS', () => {
    const r = withAgreement(cleanProgress(), 'baseline', { pearson: 0.2, meanAbsDiff: 1.8, pairCount: 1, sampleCount: 30 });
    const v = computeVerdict(r);
    assert.equal(v.level, 'CAUTIOUS');
    assert.match(v.headline, /judges disagree on baseline/);
  });

  it('dissent gate only touches PROGRESS — a REGRESS with low Pearson stays REGRESS', () => {
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
    withAgreement(r, 'skill', { pearson: 0.1, meanAbsDiff: 2.5, pairCount: 1, sampleCount: 30 });
    const v = computeVerdict(r);
    assert.equal(v.level, 'REGRESS');
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

  it('K≥2 的 per-pair headline 带真实置信水平(alpha 派生),omk eval CLI 不再裸标区间', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.3, behavior: 4.3, judge: 4.5, composite: 4.4 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill', alpha: 0.05 / 2, // Bonferroni K=2
        diffBootstrapCI: { low: 0.2, high: 0.6, estimate: 0.4, samples: 1000, significant: true },
      }],
    });
    const v = computeVerdict(r);
    assert.match(v.headline, /97\.5% CI=\[/, 'headline 应带 α/2 派生的 97.5% 标签');
  });

  it('K=1(无 alpha)headline 不加置信水平标签,与历史口径逐字节一致', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.3, behavior: 4.3, judge: 4.5, composite: 4.33 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: 0.2, high: 0.5, estimate: 0.33, samples: 1000, significant: true },
      }],
    });
    const v = computeVerdict(r);
    assert.match(v.headline, /Δ=\+0\.33 CI=\[/, 'CI 紧跟 Δ,中间无百分号');
    assert.doesNotMatch(v.headline, /% CI=/, 'K=1 不插入置信水平标签');
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

  it('formatVerdictText stays under 7 lines for the headline path (含 stability rationale)', () => {
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
    assert.ok(lines.length <= 7, `expected ≤7 lines, got ${lines.length}: ${text}`);
  });

  it('rationale.stability 在单轮(无 variance)时显式说"未测量"', () => {
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
    assert.match(v.rationale.stability ?? '', /未测量/);
    assert.match(v.rationale.stability ?? '', /--repeat/);
  });

  it('rationale.stability 在多轮 variance 数据齐时报 CV 主指标', () => {
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
      variance: {
        runs: 3,
        perVariant: {
          baseline: { scores: [4.0, 4.0, 4.0], mean: 4.0, lower: 4.0, upper: 4.0, stddev: 0 },
          skill:    { scores: [4.3, 4.3, 4.3], mean: 4.3, lower: 4.3, upper: 4.3, stddev: 0 },
        },
        comparisons: [],
      },
    });
    const v = computeVerdict(r);
    assert.match(v.rationale.stability ?? '', /CV=0\.0%/);
    assert.match(v.rationale.stability ?? '', /稳定/);
    assert.match(v.rationale.stability ?? '', /runs=3/);
  });

  it('rationale.stability 单 variant SOLO 路径同样标"未测量"', () => {
    const r = buildReport({
      variants: ['solo'],
      perVariantAvg: { solo: { fact: 4, behavior: 4, judge: 4, composite: 4 } },
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'SOLO');
    assert.match(v.rationale.stability ?? '', /未测量/);
  });

  // --- 稳定性门控(PR4)----------------------------------------------------
  // 一个干净的显著正向 PROGRESS,只叠加 variance 数据,隔离稳定性门控这一条。
  const cleanProgressWithVariance = (perVariant: Record<string, { scores: number[]; mean: number; lower: number; upper: number; stddev: number }>, runs = 3): Report => buildReport({
    variants: ['baseline', 'skill'],
    perVariantAvg: {
      baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
      skill:    { fact: 4.3, behavior: 4.3, judge: 4.5, composite: 4.33 },
    },
    pairs: [{
      control: 'baseline', treatment: 'skill',
      diffBootstrapCI: { low: 0.2, high: 0.5, estimate: 0.33, samples: 1000, significant: true },
    }],
    variance: { runs, perVariant, comparisons: [] },
  });

  it('稳定性门控:已测(runs≥2)且 median CV > 15% → PROGRESS 降为 CAUTIOUS', () => {
    const r = cleanProgressWithVariance({
      baseline: { scores: [3.2, 4.0, 4.8], mean: 4.0, lower: 3.2, upper: 4.8, stddev: 0.8 },  // CV=0.20
      skill:    { scores: [3.35, 4.3, 5.25], mean: 4.3, lower: 3.35, upper: 5.25, stddev: 0.95 }, // CV≈0.221
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'CAUTIOUS', 'run-to-run 不稳的显著进展应被降级');
    assert.match(v.headline, /run-to-run 不稳/);
    assert.match(v.rationale.stability ?? '', /不稳/);
  });

  it('稳定性门控:A/B(偶数 variant)用真·中位,一高一低不按较大的那个门控', () => {
    // baseline CV=8%、skill CV=18%。真·中位 =(8+18)/2=13% < 15% → 不门控,保持 PROGRESS。
    // 若错用上中位(取较大 18%)会误降为 CAUTIOUS —— 这正是复审 P2 要挡的回归(mean=5.0 让 CV 干净)。
    const r = cleanProgressWithVariance({
      baseline: { scores: [4.6, 5.0, 5.4], mean: 5.0, lower: 4.6, upper: 5.4, stddev: 0.4 },  // CV=0.08
      skill:    { scores: [4.1, 5.0, 5.9], mean: 5.0, lower: 4.1, upper: 5.9, stddev: 0.9 },  // CV=0.18
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'PROGRESS', '真·中位 13% < 15% → 不门控;取较大 18% 才会误降级');
    assert.doesNotMatch(v.headline, /run-to-run 不稳/);
  });

  it('稳定性门控:median CV 在阈值内(≤15%)不降级,PROGRESS 保持', () => {
    const r = cleanProgressWithVariance({
      baseline: { scores: [3.6, 4.0, 4.4], mean: 4.0, lower: 3.6, upper: 4.4, stddev: 0.4 },  // CV=0.10
      skill:    { scores: [3.87, 4.3, 4.73], mean: 4.3, lower: 3.87, upper: 4.73, stddev: 0.43 }, // CV=0.10
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'PROGRESS', 'CV 在中等带内不门控');
    assert.doesNotMatch(v.headline, /run-to-run 不稳/);
  });

  it('稳定性门控:单轮(runs<2)稳定性未测,不降级,PROGRESS 保持(rationale 仍诚实标未测量)', () => {
    const r = buildReport({
      variants: ['baseline', 'skill'],
      perVariantAvg: {
        baseline: { fact: 4, behavior: 4, judge: 4, composite: 4 },
        skill:    { fact: 4.3, behavior: 4.3, judge: 4.5, composite: 4.33 },
      },
      pairs: [{
        control: 'baseline', treatment: 'skill',
        diffBootstrapCI: { low: 0.2, high: 0.5, estimate: 0.33, samples: 1000, significant: true },
      }],
      // 无 variance → runs<2 → 稳定性未测
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'PROGRESS');
    assert.match(v.rationale.stability ?? '', /未测量/);
  });

  it('稳定性门控只压 PROGRESS:高 CV 的 REGRESS 仍是 REGRESS', () => {
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
      variance: {
        runs: 3,
        perVariant: {
          baseline: { scores: [3.2, 4.0, 4.8], mean: 4.0, lower: 3.2, upper: 4.8, stddev: 0.8 },
          skill:    { scores: [2.5, 3.5, 4.5], mean: 3.5, lower: 2.5, upper: 4.5, stddev: 0.9 },
        },
        comparisons: [],
      },
    });
    const v = computeVerdict(r);
    assert.equal(v.level, 'REGRESS', '门控只下调 PROGRESS,不触碰 REGRESS');
    assert.doesNotMatch(v.headline, /run-to-run 不稳/);
  });
});
