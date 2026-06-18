import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { analyzeResults, generateAnalysisSummary } from '../../src/analysis/report-diagnostics.js';
import type { Report } from '../../src/types/index.js';

function toReport(value: unknown): Report {
  return value as Report;
}

describe('analyzeResults', () => {
  it('returns empty insights for empty results', () => {
    const report = { meta: { variants: ['v1', 'v2'] }, results: [] };
    const analysis = analyzeResults(toReport(report));
    assert.equal(analysis.insights.length, 0);
    assert.equal(analysis.suggestions, undefined);
  });

  it('detects low-discrimination assertions', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { assertions: { total: 1, passed: 1, score: 5, details: [{ type: 'contains', value: 'SQL', passed: true, weight: 1 }] } },
            v2: { assertions: { total: 1, passed: 1, score: 5, details: [{ type: 'contains', value: 'SQL', passed: true, weight: 1 }] } },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const lowDisc = analysis.insights.find((i) => i.type === 'low_discrimination_all_passed');
    assert.ok(lowDisc);
    assert.equal(lowDisc!.severity, 'info');
    assert.equal('message' in lowDisc!, false);
    assert.equal(analysis.suggestions, undefined);
  });

  it('同厂商评委 → judge_self_preference 警告', () => {
    const report = {
      meta: { variants: ['v1', 'v2'], judgeModels: [{ executor: 'claude', model: 'haiku' }], executor: 'claude' },
      results: [{ sample_id: 's1', variants: { v1: {}, v2: {} } }],
    };
    const sp = analyzeResults(toReport(report)).insights.find((i) => i.type === 'judge_self_preference');
    assert.ok(sp, '同厂商评委应出 judge_self_preference');
    assert.equal(sp!.severity, 'warning');
  });

  it('跨厂商评委 → 无 judge_self_preference', () => {
    const report = {
      meta: { variants: ['v1', 'v2'], judgeModels: [{ executor: 'openai-api', model: 'gpt-4o' }], executor: 'claude' },
      results: [{ sample_id: 's1', variants: { v1: {}, v2: {} } }],
    };
    assert.equal(analyzeResults(toReport(report)).insights.find((i) => i.type === 'judge_self_preference'), undefined);
  });

  it('单变体 SOLO 报告也检测同厂商评委(早退前先跑)', () => {
    const report = {
      meta: { variants: ['v1'], judgeModels: [{ executor: 'claude', model: 'haiku' }], executor: 'claude' },
      results: [{ sample_id: 's1', variants: { v1: {} } }],
    };
    const sp = analyzeResults(toReport(report)).insights.find((i) => i.type === 'judge_self_preference');
    assert.ok(sp, '单变体也应检测自我偏好');
  });

  it('detects uniform scores', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { compositeScore: 4.0 },
            v2: { compositeScore: 4.2 },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const uniform = analysis.insights.find((i) => i.type === 'uniform_scores');
    assert.ok(uniform);
  });

  it('does not flag non-uniform scores', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { compositeScore: 2.0 },
            v2: { compositeScore: 4.5 },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const uniform = analysis.insights.find((i) => i.type === 'uniform_scores');
    assert.equal(uniform, undefined);
  });

  it('detects all-pass assertions', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { assertions: { total: 2, passed: 2, score: 5, details: [] } },
            v2: { assertions: { total: 2, passed: 2, score: 5, details: [] } },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const allPass = analysis.insights.find((i) => i.type === 'all_pass');
    assert.ok(allPass);
    assert.equal(allPass!.severity, 'warning');
  });

  it('detects all-fail assertions', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        {
          sample_id: 's001',
          variants: {
            v1: { assertions: { total: 2, passed: 0, score: 1, details: [] } },
            v2: { assertions: { total: 2, passed: 0, score: 1, details: [] } },
          },
        },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const allFail = analysis.insights.find((i) => i.type === 'all_fail');
    assert.ok(allFail);
    assert.equal(allFail!.severity, 'error');
  });

  it('detects high-cost samples', () => {
    const report = {
      meta: { variants: ['v1'] },
      results: [], // Need 2+ variants for analysis
    };
    // With < 2 variants, should return empty
    const analysis = analyzeResults(toReport(report));
    assert.equal(analysis.insights.length, 0);
  });

  it('detects high-cost samples with 2+ variants', () => {
    const report = {
      meta: { variants: ['v1', 'v2'] },
      results: [
        { sample_id: 's001', variants: { v1: { costUSD: 0.001 }, v2: { costUSD: 0.001 } } },
        { sample_id: 's002', variants: { v1: { costUSD: 0.001 }, v2: { costUSD: 0.001 } } },
        { sample_id: 's003', variants: { v1: { costUSD: 0.05 }, v2: { costUSD: 0.05 } } },
      ],
    };
    const analysis = analyzeResults(toReport(report));
    const highCost = analysis.insights.find((i) => i.type === 'high_cost_sample');
    assert.ok(highCost);
    assert.ok((highCost!.details as Array<{ sample_id: string }>).some((d) => d.sample_id === 's003'));
  });

  it('generates localized summary from report data', () => {
    const report = toReport({
      meta: { variants: ['v1', 'v2'] },
      summary: {
        v1: { avgCompositeScore: 4.0, avgFactScore: 4.0, avgCostPerSample: 0.01, avgDurationMs: 1000, avgNumTurns: 1, successCount: 1, totalSamples: 1 },
        v2: { avgCompositeScore: 4.5, avgFactScore: 4.5, avgCostPerSample: 0.02, avgDurationMs: 1200, avgNumTurns: 1, successCount: 1, totalSamples: 1 },
      },
      results: [{ sample_id: 's001', variants: { v1: { compositeScore: 4.0 }, v2: { compositeScore: 4.5 } } }],
    });

    const en = generateAnalysisSummary(report, 'en');
    const zh = generateAnalysisSummary(report, 'zh');

    assert.ok(en?.includes('【Conclusion】'));
    assert.ok(en?.includes('Key differences'));
    assert.ok(!/[\u3400-\u9fff]/.test(en || ''));
    assert.ok(zh?.includes('【结论】'));
    assert.ok(zh?.includes('关键差异'));
  });

  it('surfaces sample-composition skew when N≥10 and a bucket dominates', () => {
    const base = {
      meta: {
        variants: ['v1', 'v2'], sampleCount: 12,
        variantConfigs: [{ variant: 'v1', experimentRole: 'control' }, { variant: 'v2', experimentRole: 'treatment' }],
      },
      summary: {
        v1: { avgCompositeScore: 4.0, avgFactScore: 4.0, avgCostPerSample: 0.01, avgDurationMs: 1000, avgNumTurns: 1, successCount: 1, totalSamples: 1 },
        v2: { avgCompositeScore: 4.5, avgFactScore: 4.5, avgCostPerSample: 0.02, avgDurationMs: 1200, avgNumTurns: 1, successCount: 1, totalSamples: 1 },
      },
      results: [{ sample_id: 's001', variants: { v1: { compositeScore: 4.0 }, v2: { compositeScore: 4.5 } } }],
      analysis: {
        insights: [],
        sampleQuality: {
          representativeness: { capabilityCount: 1, capabilityConcentration: 0.5, difficultyConcentration: 0.7, dominantDifficulty: 'easy', constructConcentration: 0 },
        },
      },
    };
    const zh = generateAnalysisSummary(toReport(base), 'zh');
    assert.ok(zh?.includes('【用例构成】'));
    assert.ok(zh?.includes('难度 70% 集中在 easy'));
    const en = generateAnalysisSummary(toReport(base), 'en');
    assert.ok(en?.includes('Sample composition'));
    assert.ok(en?.includes('70% of declared difficulty is easy'));
    assert.ok(!/[㐀-鿿]/.test(en || ''));

    // N < 10 → 不出构成提示。
    const small = { ...base, meta: { ...base.meta, sampleCount: 8 } };
    assert.ok(!generateAnalysisSummary(toReport(small), 'zh')?.includes('【用例构成】'));
  });
});
