import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderRunList, renderRunDetail } from '../src/renderer/html-renderer.js';
import type { Lang, Report } from '../src/types.js';

const SAMPLE_REPORT: Report = {
  id: 'test-run-001',
  meta: {
    variants: ['v1', 'v2'],
    model: 'sonnet',
    judgeModel: 'haiku',
    executor: 'claude',
    sampleCount: 2,
    taskCount: 4,
    totalCostUSD: 0.05,
    timestamp: '2026-03-25T10:00:00.000Z',
    cliVersion: 'test',
    nodeVersion: process.version,
    artifactHashes: { v1: 'hash-v1', v2: 'hash-v2' },
    variantConfigs: [
      { variant: 'v1', artifactKind: 'skill', artifactSource: 'variant-name', executionStrategy: 'system-prompt', experimentType: 'artifact-injection', experimentRole: 'treatment', hasArtifactContent: true, cwd: null },
      { variant: 'v2', artifactKind: 'baseline', artifactSource: 'custom', executionStrategy: 'baseline', experimentType: 'runtime-context-only', experimentRole: 'control', hasArtifactContent: false, cwd: '/tmp/project-a' },
    ],
  },
  summary: {
    v1: {
      totalSamples: 2, successCount: 2, errorCount: 0, errorRate: 0,
      avgCompositeScore: 4.0, minCompositeScore: 3.5, maxCompositeScore: 4.5,
      avgFactScore: 4.2, avgBehaviorScore: 4.0, avgJudgeScore: 3.8,
      avgAssertionScore: 4.2, avgLlmScore: 3.8, minLlmScore: 3, maxLlmScore: 4.5,
      avgDurationMs: 2000, avgInputTokens: 100, avgOutputTokens: 500, avgTotalTokens: 600,
      totalCostUSD: 0.025,
      totalExecCostUSD: 0.020,
      totalJudgeCostUSD: 0.005,
      avgCostPerSample: 0.0125,
      avgNumTurns: 1,
    },
    v2: {
      totalSamples: 2, successCount: 2, errorCount: 0, errorRate: 0,
      avgCompositeScore: 4.8, minCompositeScore: 4.5, maxCompositeScore: 5.0,
      avgFactScore: 5.0, avgBehaviorScore: 4.8, avgJudgeScore: 4.6,
      avgAssertionScore: 5.0, avgLlmScore: 4.6, minLlmScore: 4, maxLlmScore: 5,
      avgDurationMs: 3000, avgInputTokens: 120, avgOutputTokens: 600, avgTotalTokens: 720,
      totalCostUSD: 0.025,
      totalExecCostUSD: 0.018,
      totalJudgeCostUSD: 0.007,
      avgCostPerSample: 0.0125,
      avgNumTurns: 1,
    },
  },
  results: [
    {
      sample_id: 's001',
      variants: {
        v1: {
          ok: true, compositeScore: 4.0, durationMs: 2000, durationApiMs: 0, inputTokens: 100, outputTokens: 500, totalTokens: 600, cacheReadTokens: 0, cacheCreationTokens: 0, execCostUSD: 0.01, judgeCostUSD: 0.0025, costUSD: 0.0125, numTurns: 1, outputPreview: 'preview',
          assertions: {
            passed: 2, total: 2, score: 5, details: [
              { type: 'contains', value: 'SQL', weight: 1, passed: true },
              { type: 'min_length', value: 50, weight: 1, passed: true },
            ]
          },
          llmScore: 3, llmReason: 'Decent analysis',
        },
        v2: {
          ok: true, compositeScore: 4.5, durationMs: 2500, durationApiMs: 0, inputTokens: 120, outputTokens: 580, totalTokens: 700, cacheReadTokens: 0, cacheCreationTokens: 0, execCostUSD: 0.01, judgeCostUSD: 0.0025, costUSD: 0.0125, numTurns: 1, outputPreview: 'preview',
          assertions: {
            passed: 2, total: 2, score: 5, details: [
              { type: 'contains', value: 'SQL', weight: 1, passed: true },
              { type: 'min_length', value: 50, weight: 1, passed: true },
            ]
          },
          llmScore: 4, llmReason: 'Thorough review',
        },
      },
    },
  ],
  analysis: {
    insights: [{ type: 'uniform_scores', severity: 'info', message: 'Scores are similar', details: [] }],
    suggestions: ['Add harder tests'],
  },
};

describe('renderRunList', () => {
  it('renders empty state', () => {
    const html = renderRunList([]);
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('omk bench run'));
  });

  it('renders run list with data', () => {
    const html = renderRunList([SAMPLE_REPORT]);
    assert.ok(html.includes('test-run-001'));
    assert.ok(html.includes('sonnet'));
    assert.ok(html.includes('test-run-001'));
  });

  it('includes delete button', () => {
    const html = renderRunList([SAMPLE_REPORT]);
    assert.ok(html.includes('deleteRun'));
  });

  it('includes language toggle', () => {
    const html = renderRunList([SAMPLE_REPORT]);
    assert.ok(html.includes('lang-toggle'));
    assert.ok(html.includes('switchLang'));
  });
});

describe('renderRunDetail', () => {
  it('renders not found for null report', () => {
    const html = renderRunDetail(null);
    assert.ok(html.includes('not found'));
  });

  it('renders six dimensions (Fact / Behavior / LLM judge / Cost / Efficiency / Stability)', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    assert.ok(html.includes('dimFact'));
    assert.ok(html.includes('dimBehavior'));
    assert.ok(html.includes('dimJudge'));
    assert.ok(html.includes('dimCost'));
    assert.ok(html.includes('dimEfficiency'));
    assert.ok(html.includes('dimStability'));
  });

  it('renders layer scores (fact / behavior / judge independently)', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    // Fact layer: v1=4.20, v2=5.00
    assert.ok(html.includes('4.20'));
    assert.ok(html.includes('5.00'));
    // Judge layer: v1=3.80, v2=4.60
    assert.ok(html.includes('3.80'));
    assert.ok(html.includes('4.60'));
  });

  it('--layered-stats: <details> is OPEN when report.meta.layeredStats=true (PR-2 穿透测试)', () => {
    // 构造带 byLayer variance data + layeredStats=true 的 report 验证渲染器读取 meta flag
    const report = JSON.parse(JSON.stringify(SAMPLE_REPORT)) as Report;
    const mkLayer = (mean: number) => ({
      scores: [mean - 0.1, mean + 0.1], mean, lower: mean - 0.1, upper: mean + 0.1, stddev: 0.1,
    });
    const mkComp = () => ({
      meanDiff: -0.8, tStatistic: -8, df: 2, significant: true,
      effectSize: { cohensD: -8, hedgesG: -7, primary: 'g' as const, magnitude: 'large' as const, pooledStddev: 0.1, n1: 2, n2: 2 },
    });
    report.variance = {
      runs: 2,
      perVariant: {
        v1: { ...mkLayer(4.0), byLayer: { fact: mkLayer(4.2), behavior: mkLayer(4.0), judge: mkLayer(3.8) } },
        v2: { ...mkLayer(4.8), byLayer: { fact: mkLayer(5.0), behavior: mkLayer(4.8), judge: mkLayer(4.6) } },
      },
      comparisons: [{
        a: 'v1', b: 'v2', ...mkComp(),
        byLayer: { fact: mkComp(), behavior: mkComp(), judge: mkComp() },
      }],
    };
    report.meta.layeredStats = true;

    const html = renderRunDetail(report);
    // layer-breakdown <details> 应当带 open 属性,默认展开
    assert.match(html, /<details class="layer-breakdown" open>/);
  });

  it('--layered-stats: <details> is COLLAPSED by default (meta.layeredStats absent)', () => {
    const report = JSON.parse(JSON.stringify(SAMPLE_REPORT)) as Report;
    const mkLayer = (mean: number) => ({
      scores: [mean - 0.1, mean + 0.1], mean, lower: mean - 0.1, upper: mean + 0.1, stddev: 0.1,
    });
    const mkComp = () => ({
      meanDiff: -0.8, tStatistic: -8, df: 2, significant: true,
      effectSize: { cohensD: -8, hedgesG: -7, primary: 'g' as const, magnitude: 'large' as const, pooledStddev: 0.1, n1: 2, n2: 2 },
    });
    report.variance = {
      runs: 2,
      perVariant: {
        v1: { ...mkLayer(4.0), byLayer: { fact: mkLayer(4.2), behavior: mkLayer(4.0), judge: mkLayer(3.8) } },
        v2: { ...mkLayer(4.8), byLayer: { fact: mkLayer(5.0), behavior: mkLayer(4.8), judge: mkLayer(4.6) } },
      },
      comparisons: [{
        a: 'v1', b: 'v2', ...mkComp(),
        byLayer: { fact: mkComp(), behavior: mkComp(), judge: mkComp() },
      }],
    };
    // meta.layeredStats 不设置(或显式 false)—— details 应不带 open

    const html = renderRunDetail(report);
    // <details> 结构存在,但不带 open 属性
    assert.match(html, /<details class="layer-breakdown">/);
    assert.doesNotMatch(html, /<details class="layer-breakdown" open>/);
  });

  it('renders exec cost (not total cost)', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    // Should show exec cost ($0.0200 for v1), not total cost ($0.0250)
    assert.ok(html.includes('$0.0200'));
  });

  it('renders N/A for zero cost data', () => {
    const zeroCostReport = JSON.parse(JSON.stringify(SAMPLE_REPORT));
    zeroCostReport.summary.v1.totalExecCostUSD = 0;
    zeroCostReport.summary.v1.avgTotalTokens = 0;
    zeroCostReport.summary.v2.totalExecCostUSD = 0;
    zeroCostReport.summary.v2.avgTotalTokens = 0;
    const html = renderRunDetail(zeroCostReport);
    assert.ok(html.includes('N/A'));
  });

  it('renders success rate in stability', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    assert.ok(html.includes('100%'));
    assert.ok(html.includes('successRate'));
  });

  it('renders per-sample details', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    assert.ok(html.includes('s001'));
    assert.ok(html.includes('badge-ok'));
  });

  it('renders analysis section', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    assert.ok(html.includes('Scores are similar'));
    assert.ok(html.includes('Add harder tests'));
  });

  it('renders variant configuration section', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    assert.ok(html.includes('实验配置'));
    assert.ok(html.includes('知识注入'));
    assert.ok(html.includes('/tmp/project-a'));
  });

  it('renders dimension descriptions', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    assert.ok(html.includes('dimQualityDesc'));
    assert.ok(html.includes('dimCostDesc'));
    assert.ok(html.includes('dimEfficiencyDesc'));
    assert.ok(html.includes('dimStabilityDesc'));
  });

  it('renders blind mode correctly', () => {
    const blindReport = JSON.parse(JSON.stringify(SAMPLE_REPORT));
    blindReport.meta.blind = true;
    blindReport.meta.blindMap = { A: 'v1', B: 'v2' };
    const html = renderRunDetail(blindReport);
    assert.ok(html.includes('blindLabel'));
    assert.ok(html.includes('blind-reveal'));
  });

  it('supports English language', () => {
    const html = renderRunDetail(SAMPLE_REPORT, 'en' as Lang);
    assert.ok(html.includes('Evaluation Report'));
    assert.ok(html.includes('Quality'));
  });

  it('supports Chinese language (default)', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    assert.ok(html.includes('评测报告'));
    assert.ok(html.includes('质量'));
  });
});
