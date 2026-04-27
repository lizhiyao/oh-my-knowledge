import { describe, it, expect } from 'vitest';
import assert from 'node:assert/strict';
import { renderRunList, renderRunDetail } from '../src/renderer/html-renderer.js';
import type { Lang, Report } from '../src/types/index.js';

// Snapshot 稳定化:把所有 YYYY-MM-DD HH:MM:SS 形式的本地时间戳替换成 [TIMESTAMP],
// 防止 fmtLocalTime 基于本地时区产出的字符串在不同机器/CI 上抖动。
function normalizeForSnapshot(html: string): string {
  return html.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, '[TIMESTAMP]');
}

const SAMPLE_REPORT: Report = {
  // 让 id 匹配 renderRunList 里的 YYYYMMDD-HHmm regex (html-renderer.ts:62),
  // 这样列表页 row 的时间从 id 直接提取 (deterministic), 不走 toLocaleString
  // — 后者本地时区敏感, 会让 snapshot 在 CI UTC 和本地 CST 之间不一致.
  id: 'test-run-20260325-1000',
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
    assert.ok(html.includes('test-run-20260325-1000'));
    assert.ok(html.includes('sonnet'));
    assert.ok(html.includes('test-run-20260325-1000'));
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
    // 强断言:thead 里必须出现 6 个 dim* i18n key,不是散落在 tooltip 里
    const thMatches = html.match(/<th data-i18n="dim(Fact|Behavior|Judge|Cost|Efficiency|Stability)"/g);
    assert.ok(thMatches, 'thead should contain dim* th elements');
    assert.equal(thMatches.length, 6, `expected 6 dim* <th>, got ${thMatches.length}`);
  });

  it('renders layer scores (fact / behavior / judge independently)', () => {
    const html = renderRunDetail(SAMPLE_REPORT);
    // 主表里三层独立 cell 带 primary class;每 variant 3 primary × 2 variant = 6 primary cell
    const primaryMatches = html.match(/summary-value summary-value-primary/g);
    assert.ok(primaryMatches, 'primary layer cells should exist');
    assert.ok(primaryMatches.length >= 6, `expected ≥ 6 primary layer cells, got ${primaryMatches.length}`);
    // 关键数字应该出现在 primary cell 附近(而非随便 tooltip 里):用 regex 限定上下文
    assert.match(html, /summary-value-primary[^"]*"[^>]*>4\.20</);  // v1 fact
    assert.match(html, /summary-value-primary[^"]*"[^>]*>5\.00</);  // v2 fact
    assert.match(html, /summary-value-primary[^"]*"[^>]*>3\.80</);  // v1 judge
    assert.match(html, /summary-value-primary[^"]*"[^>]*>4\.60</);  // v2 judge
  });

  it('stability cell: 单 run (无 variance) 显示 "—" + 引导', () => {
    const report = JSON.parse(JSON.stringify(SAMPLE_REPORT)) as Report;
    // SAMPLE_REPORT 默认无 variance 字段,这正是单 run 场景
    assert.equal(report.variance, undefined);
    const html = renderRunDetail(report);
    // 稳定性主值应该是 "—",副区提示需 --repeat
    assert.match(html, /需 --repeat ≥ 2/);
  });

  it('stability cell: 有 variance 数据显示 CV + 白话定性 (稳定/较稳/波动大)', () => {
    const report = JSON.parse(JSON.stringify(SAMPLE_REPORT)) as Report;
    report.variance = {
      runs: 3,
      perVariant: {
        v1: { scores: [4.0, 4.05, 3.95], mean: 4.0, lower: 3.93, upper: 4.07, stddev: 0.04 },
        v2: { scores: [4.8, 4.82, 4.78], mean: 4.8, lower: 4.76, upper: 4.84, stddev: 0.02 },
      },
      comparisons: [],
    };
    const html = renderRunDetail(report);
    // 小抖动 CV < 5% → "稳定" 标签
    assert.match(html, /稳定/);
    assert.match(html, /CV \d/);  // CV 数字出现
    assert.match(html, /95% CI/);
  });

  it('stability cell: errorCount > 0 时副区显示完成率 alert', () => {
    const report = JSON.parse(JSON.stringify(SAMPLE_REPORT)) as Report;
    report.summary.v1.errorCount = 1;
    report.summary.v1.successCount = 1;
    report.summary.v1.totalSamples = 2;
    const html = renderRunDetail(report);
    // alert 文案:"X% 完成率 · 1 失败"
    assert.match(html, /完成率/);
    assert.match(html, /50%/);
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

  it('renders multi-judge ensemble agreement when summary has judgeAgreement', () => {
    const ensembleReport = JSON.parse(JSON.stringify(SAMPLE_REPORT));
    ensembleReport.meta.judgeModels = ['claude:opus', 'openai:gpt-4o'];
    ensembleReport.meta.judgeRepeat = 3;
    ensembleReport.meta.judgePromptHash = 'abc123def456';
    ensembleReport.summary.v1.judgeAgreement = { pearson: 0.85, meanAbsDiff: 0.6, pairCount: 1, sampleCount: 50 };
    ensembleReport.summary.v1.judgeModels = ['claude:opus', 'openai:gpt-4o'];
    const html = renderRunDetail(ensembleReport);
    // Meta tags surface the judge ensemble + reproducibility metadata
    assert.ok(html.includes('claude:opus'), 'should mention claude:opus');
    assert.ok(html.includes('openai:gpt-4o'), 'should mention openai:gpt-4o');
    assert.ok(html.includes('abc123def456'), 'should show prompt hash');
    // Agreement table renders pearson + MAD numbers
    assert.ok(html.includes('0.85'), 'should show pearson value');
    assert.ok(html.includes('0.6'), 'should show MAD value');
  });

  it('renders bootstrap pairwise diff section when meta.pairComparisons present', () => {
    const bsReport = JSON.parse(JSON.stringify(SAMPLE_REPORT));
    bsReport.meta.evaluationFramework = 'both';
    bsReport.meta.pairComparisons = [
      {
        control: 'v1',
        treatment: 'v2',
        diffBootstrapCI: { low: 0.2, high: 0.8, estimate: 0.5, samples: 1000, significant: true },
      },
    ];
    const html = renderRunDetail(bsReport);
    // Section heading visible (zh by default)
    assert.ok(html.includes('配对对比') || html.includes('Pairwise comparison'), 'should render pairwise heading');
    // Diff CI numbers
    assert.ok(html.includes('0.5'), 'should show diff estimate 0.5');
    assert.ok(html.includes('[0.2, 0.8]'), 'should show CI bracket');
    // Significance label
    assert.ok(html.includes('显著差异') || html.includes('significant'), 'should label significance');
    // Framework meta tag
    assert.ok(html.includes('统计框架') || html.includes('CI framework'), 'should show framework meta tag');
  });

  it('renders single-rubric judge stddev / failures / reasoning when ensemble data present on result', () => {
    const stabilityReport = JSON.parse(JSON.stringify(SAMPLE_REPORT));
    stabilityReport.results[0].variants.v1.llmScoreSamples = [3, 4, 5];
    stabilityReport.results[0].variants.v1.llmScoreStddev = 1;
    stabilityReport.results[0].variants.v1.llmScoreFailures = 0;
    stabilityReport.results[0].variants.v1.llmReasoning = 'Stub CoT reasoning here';
    stabilityReport.results[0].variants.v1.llmEnsemble = [
      { judge: 'claude:opus', score: 4 },
      { judge: 'openai:gpt-4o', score: 5 },
    ];
    stabilityReport.results[0].variants.v1.llmAgreement = { pearson: undefined, meanAbsDiff: 1, pairCount: 1 };
    const html = renderRunDetail(stabilityReport);
    // stddev tag visible
    assert.ok(html.includes('±1'), 'should show stddev tag');
    // ensemble rows visible
    assert.ok(html.includes('claude:opus'), 'should show judge identifier in ensemble block');
    // reasoning collapsible
    assert.ok(html.includes('Stub CoT reasoning here'), 'should embed reasoning text');
  });
});

describe('snapshot baselines (zh / en × list / detail)', () => {
  // 这些 snapshot 是 v0.21 攻坚的回归基线。Phase B/C/D 改 UI 时如果意外动到非攻坚区,
  // snapshot 会失败,review diff 后 vitest -u 主动更新。固定 SAMPLE_REPORT + 时间 normalize
  // 让 snapshot 跨机器稳定。
  it('renderRunList zh', () => {
    expect(normalizeForSnapshot(renderRunList([SAMPLE_REPORT], 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderRunList en', () => {
    expect(normalizeForSnapshot(renderRunList([SAMPLE_REPORT], 'en' as Lang))).toMatchSnapshot();
  });
  it('renderRunDetail zh', () => {
    expect(normalizeForSnapshot(renderRunDetail(SAMPLE_REPORT, 'zh' as Lang))).toMatchSnapshot();
  });
  it('renderRunDetail en', () => {
    expect(normalizeForSnapshot(renderRunDetail(SAMPLE_REPORT, 'en' as Lang))).toMatchSnapshot();
  });
});
