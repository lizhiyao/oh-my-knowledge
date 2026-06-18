import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderVerdictPill } from '../../src/renderer/summary.js';
import type { Report, VariantSummary, AnalysisResult } from '../../src/types/index.js';

const s = (composite: number): VariantSummary => ({
  totalSamples: 30, successCount: 30, errorCount: 0, errorRate: 0,
  avgDurationMs: 1000, avgInputTokens: 100, avgOutputTokens: 200, avgTotalTokens: 300,
  totalCostUSD: 0.1, totalExecCostUSD: 0.05, totalJudgeCostUSD: 0.05,
  avgCostPerSample: 0.003, avgNumTurns: 1,
  avgFactScore: composite, avgBehaviorScore: composite, avgJudgeScore: composite,
  avgCompositeScore: composite,
});

const buildReport = (opts: {
  variants: string[];
  summary: Record<string, VariantSummary>;
  pairs: Report['meta']['pairComparisons'];
  analysis?: AnalysisResult;
}): Report => ({
  kind: 'evaluation', id: 'r1',
  meta: {
    variants: opts.variants,
    model: 'm', judgeModels: [{ executor: 'claude', model: 'j' }], executor: 'claude',
    sampleCount: 30, taskCount: 30, totalCostUSD: 0,
    timestamp: '2026-01-01T00:00:00Z', cliVersion: 't', nodeVersion: 't',
    artifactHashes: Object.fromEntries(opts.variants.map((v) => [v, 'h'])),
    pairComparisons: opts.pairs,
  },
  summary: opts.summary,
  results: [],
  ...(opts.analysis ? { analysis: opts.analysis } : {}),
} as unknown as Report);

describe('renderVerdictPill', () => {
  it('多 treatment：用 representative（worst）pair 命名，而非 perPair[0]', () => {
    // t1 显著进步(PROGRESS),t2 显著退步(REGRESS) → 顶层 REGRESS，representative = t2 那一对。
    // 旧实现取 perPair[0]=t1,会把结论写成「t1 ... 更差」(错的 treatment 名)。
    const report = buildReport({
      variants: ['baseline', 't1', 't2'],
      summary: { baseline: s(4), t1: s(4.33), t2: s(3.0) },
      pairs: [
        { control: 'baseline', treatment: 't1', diffBootstrapCI: { low: 0.2, high: 0.5, estimate: 0.33, samples: 1000, significant: true } },
        { control: 'baseline', treatment: 't2', diffBootstrapCI: { low: -0.6, high: -0.2, estimate: -0.4, samples: 1000, significant: true } },
      ],
    });
    const html = renderVerdictPill(report, 'zh');
    assert.match(html, /data-verdict-level="REGRESS"/);
    assert.match(html, /t2 比/);
    assert.doesNotMatch(html, /t1 比/);
  });

  it('过拟合 + 知识缺口 caveat 渲染进 pill（HTML 与 CLI 说同一件事）', () => {
    const analysis: AnalysisResult = {
      insights: [],
      holdout: {
        ratio: 0.3,
        perVariant: {
          skill: { trainScore: 4.6, holdoutScore: 3.5, trainCount: 7, holdoutCount: 3, trainScorable: 7, holdoutScorable: 3 },
        },
        testSetPath: 'eval-samples.json', testSetHash: 'abcd1234ef',
      },
      gapReports: {
        skill: {
          variant: 'skill', sampleCount: 30, samplesWithGap: 9, gapRate: 0.3, weightedGapRate: 0.3,
          testSetPath: 'eval-samples.json', testSetHash: 'abcd1234ef',
          signals: [], byType: { failed_search: 0, explicit_marker: 0, hedging: 0, repeated_failure: 0 },
        },
      },
    };
    const report = buildReport({
      variants: ['baseline', 'skill'],
      summary: { baseline: s(4), skill: s(4.33) },
      pairs: [{ control: 'baseline', treatment: 'skill', diffBootstrapCI: { low: 0.2, high: 0.5, estimate: 0.33, samples: 1000, significant: true } }],
      analysis,
    });
    const html = renderVerdictPill(report, 'zh');
    assert.match(html, /过拟合敞口/);
    assert.match(html, /知识缺口率 30%/);
    // 过拟合把 PROGRESS 降为 CAUTIOUS。
    assert.match(html, /data-verdict-level="CAUTIOUS"/);
    const en = renderVerdictPill(report, 'en');
    assert.match(en, /Overfitting/);
    assert.match(en, /Knowledge gap 30%/);
  });
});
