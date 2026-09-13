import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import {
  projectDiff,
  projectIndexRows,
  projectReport,
  projectTrend,
  type HealthReportFacts,
} from '../../../src/studio/application/health-format.js';
import type { SkillHealthReport } from '../../../src/observability/skill-health/analyzer.js';
import type { SkillDiffRow } from '../../../src/studio/view-models/knowledge-reports.js';
import type { HealthPage } from '../../../src/studio/http/health-page.js';
import { HealthView } from '../../../src/studio/web/components/observe/health';
import { coverageOf, reportOf, skillOf, trendPointOf } from '../fixtures/health-report.js';

/** React 文本节点的转义结果；值被整体丢弃同样算失败。 */
function reactText(payload: string): string {
  return payload
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

/**
 * 渲染成可比对的字符串：React 会在相邻动态文本之间插 `<!-- -->` 定界，
 * 剥掉注释后按可见顺序断言，既锁住取值也锁住相邻关系。
 */
function render(page: HealthPage, lang: 'zh' | 'en'): string {
  return renderToString(createElement(HealthView, { page, lang })).replaceAll('<!-- -->', '');
}

/** confidence 字段之前的报告形状：顶层与 per-skill 都没有该键。 */
function legacyReport(segments: number): HealthReportFacts {
  const raw = reportOf({ audit: skillOf('audit', { segments, gapRate: 0.5 }) }, { band: 'red', gapRate: 0.5 });
  delete (raw.overall as { confidence?: unknown }).confidence;
  delete (raw.bySkill.audit as { confidence?: unknown }).confidence;
  return projectReport('obs-legacy', raw as SkillHealthReport);
}

describe('健康度事实投影守住口径', () => {
  it('旧报告缺 confidence 时按段数兜底，而不是把 undefined 交给页面', () => {
    const underpowered = legacyReport(3);
    assert.equal(underpowered.confidence, 'underpowered');
    assert.equal(underpowered.bandTone, 'neutral', '样本不足不给硬红');
    assert.equal(underpowered.score, null, '样本不足不给健康分');
    assert.equal(underpowered.skills[0]!.gap.tone, 'neutral');
    assert.equal(underpowered.skills[0]!.confidence, 'underpowered');

    const highN = legacyReport(40);
    assert.equal(highN.confidence, 'high');
    assert.equal(highN.bandTone, 'error');
    assert.equal(highN.score, 50, '健康分 = (1 - 加权盲区) × 100');
  });

  it('色带阈值与 CLI 同档：盲区 30/10，覆盖 80/50', () => {
    const gapTone = (gapRate: number): string => projectReport('a', reportOf({
      s: skillOf('s', { segments: 40, gapRate }),
    })).skills[0]!.gap.tone;
    assert.deepEqual([0.29, 0.3, 0.1, 0.09].map(gapTone), ['warning', 'error', 'warning', 'success']);

    const coverageTone = (accessed: number): string => projectReport('a', reportOf({
      s: skillOf('s', { segments: 40, coverage: coverageOf(Array.from({ length: 10 }, (_, i) => [`f${i}.md`, i < accessed] as const)) }),
    })).skills[0]!.coverage!.tone;
    assert.deepEqual([8, 5, 4].map(coverageTone), ['success', 'warning', 'error']);
  });

  it('统计条的盲区着色只看阈值，与色带的样本守护是两件事', () => {
    const facts = projectReport('a', reportOf(
      { audit: skillOf('audit', { segments: 3, gapRate: 0.5 }) },
      { band: 'red', gapRate: 0.5, weightedGapRate: 0.4 },
    ));
    assert.equal(facts.skills[0]!.gap.tone, 'neutral');
    assert.equal(facts.weightedGapTone, 'error');
  });

  it('取消与状态未知都不进入失败率分母；无可比较结果时不给 0%', () => {
    const cancelled = projectReport('a', reportOf({
      s: skillOf('s', { segments: 40, toolCalls: 8, toolFailures: 0, toolCancelled: 6, toolResolved: 6 }),
    })).skills[0]!.tools;
    assert.deepEqual(
      { comparable: cancelled.comparable, rate: cancelled.failureRatePercent, stability: cancelled.stability },
      { comparable: 0, rate: null, stability: 'unknown' },
      '全部取消必须读成「不可测」，不是 0% 通过',
    );

    const legacy = projectReport('a', reportOf({
      s: skillOf('s', { segments: 40, toolCalls: 10, toolFailures: 4, legacyTools: true, stability: 'very-unstable' }),
    })).skills[0]!.tools;
    assert.deepEqual(
      { comparable: legacy.comparable, rate: legacy.failureRatePercent, stability: legacy.stability },
      { comparable: 10, rate: 40, stability: 'very-unstable' },
      '旧报告按已记录调用都可判成败兜底',
    );
  });

  it('差值只表达方向：段数中性，盲区/失败下降与覆盖上升算改善', () => {
    const row: SkillDiffRow = {
      skillName: 'audit',
      presence: 'both',
      fromSegments: 10, toSegments: 20, deltaSegments: 10,
      fromGap: 0.5, toGap: 0.25, deltaGap: -0.25,
      fromFailure: 0.4, toFailure: 0.2, deltaFailure: -0.2,
      fromCoverage: 0.2, toCoverage: 0.8, deltaCoverage: 0.6,
    };
    assert.deepEqual(projectDiff([row])[0]!.deltas, {
      segments: { text: '+10', tone: 'neutral' },
      gap: { text: '-25.0%', tone: 'success' },
      failure: { text: '-20.0%', tone: 'success' },
      coverage: { text: '+60.0%', tone: 'success' },
    });

    const [noise] = projectDiff([{ ...row, deltaSegments: 0, deltaGap: -0.005, deltaCoverage: 0.004 }]);
    assert.deepEqual(
      { segments: noise!.deltas.segments!.text, gap: noise!.deltas.gap!.tone, coverage: noise!.deltas.coverage!.tone },
      { segments: '0', gap: 'neutral', coverage: 'neutral' },
      '不足 1pp／1 段的变化是噪声，不得读成结论',
    );

    const [singleSided] = projectDiff([{ skillName: 'gone', presence: 'only-from', fromGap: 0.4, fromSegments: 7 }]);
    assert.deepEqual(singleSided!.deltas, { segments: null, gap: null, failure: null, coverage: null }, '只在一侧出现的 skill 不给差值');
  });

  it('趋势折线在取值缺席处断开，单点居中，越界取值不钳制', () => {
    const chart = projectTrend({
      skillName: 'audit',
      points: [
        trendPointOf({ analysisId: 'a1', gapRate: 0.2 }),
        trendPointOf({ analysisId: 'a2', gapRate: null }),
        trendPointOf({ analysisId: 'a3', gapRate: 0.4 }),
      ],
    }).chart;
    const gap = chart.series.find((series) => series.key === 'gap')!;
    assert.equal((gap.line.match(/M/g) ?? []).length, 2, '缺口两侧各起一条折线，不跨缺口连线');
    assert.equal(gap.dots.length, 2);
    assert.deepEqual(chart.grid.map((tick) => tick.label), ['0%', '50%', '100%']);

    const single = projectTrend({ skillName: 'audit', points: [trendPointOf({ analysisId: 'only', gapRate: 1.2 })] }).chart;
    assert.deepEqual(single.series.find((series) => series.key === 'gap')!.dots, [{ x: 380, y: 16 }],
      '单点居中；越界取值画出 100% 网格线之外，图形不掩盖数据问题');
  });

  it('死代码 KB 一栏列全，不做前 N 条截断', () => {
    const facts = projectReport('a', reportOf({
      s: skillOf('s', { segments: 40, coverage: coverageOf(Array.from({ length: 35 }, (_, i) => [`kb/${i}.md`, i === 0] as const)) }),
    }));
    assert.equal(facts.deadKb.total, 35);
    assert.equal(facts.deadKb.entries.length, 34);
    assert.equal(facts.deadKb.entries.at(-1)!.path, 'kb/34.md');
  });

  it('列表圆点与详情页共用同一套样本守护', () => {
    assert.equal(projectIndexRows([{
      id: 'one', generatedAt: '2026-09-02T08:30:00Z', sessionCount: 1, segmentCount: 3, skillCount: 1, healthBand: 'red', confidence: 'underpowered',
    }])[0]!.tone, 'neutral');
  });
});

describe('观测健康 React 页面', () => {
  it('样本不足时顶部标签与色带一起收敛，中英文都不给硬结论', () => {
    const page = { pageKind: 'report', report: legacyReport(3) } as const;
    const zh = render(page, 'zh');
    assert.match(zh, /样本不足/);
    assert.doesNotMatch(zh, /需关注/);
    assert.match(zh, /class="[^"]*tone-neutral[^"]*"[^>]*>50%/);
    assert.match(zh, /可信度不足，色带仅供参考/);
    const en = render(page, 'en');
    assert.match(en, /Low N/);
    assert.doesNotMatch(en, /Attention/);
    assert.match(en, /underpowered; the band is indicative only/);
    for (const html of [zh, en]) {
      assert.doesNotMatch(html, /undefined|NaN/);
    }
  });

  it('高样本 red 报告给出硬结论标签与健康分', () => {
    const html = render({ pageKind: 'report', report: legacyReport(40) }, 'zh');
    assert.match(html, /需关注/);
    assert.match(html, /class="[^"]*health-stat-value tone-error[^"]*"[^>]*>50%/);
    assert.match(html, /健康分 50/);
    assert.doesNotMatch(html, /样本不足|仅供参考/);
  });

  it('每个 skill 都有一个面板，且面板内容随文档一次给全', () => {
    const report = projectReport('a', reportOf(Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`skill-${i}`, skillOf(`skill-${i}`, { segments: 40 - i, gapRate: 0.2 })]),
    )));
    const html = render({ pageKind: 'report', report }, 'zh');
    assert.equal(html.match(/class="ant-collapse-item/g)?.length, 4);
    assert.equal(html.match(/class="health-skill"/g)?.length, 4, '折叠面板未展开时也必须已在文档里');
    assert.equal((html.match(/查看趋势 →/g) ?? []).length, 4);
    assert.ok(html.includes('href="/observe/skill-trend/skill-0"'), '趋势链接指向单 skill 趋势页');
    assert.ok(!html.includes('localhost') && !html.includes('127.0.0.1'), '页面地址不携带宿主');
  });

  it('死代码 KB 的每一条都出现在文档里，已访问的不混进来', () => {
    const report = projectReport('a', reportOf({
      s: skillOf('s', { segments: 40, coverage: coverageOf([['kb/a.md', false], ['kb/b.md', false], ['kb/c.md', true]] as const) }),
    }));
    const html = render({ pageKind: 'report', report }, 'zh');
    assert.equal(html.match(/<li>/g)?.length, 2);
    assert.ok(html.includes('kb/a.md') && html.includes('kb/b.md'));
    assert.ok(!html.includes('kb/c.md'), '已访问的文件不属于死代码');
    assert.match(html, /本期共 3 个 KB 文件，其中 2 个/);
  });

  it('外部文本按文本渲染，不成为标记，也不成为可点击资源', () => {
    const hostile = '<script>alert(1)</script>';
    const report = projectReport(hostile, reportOf(
      { [hostile]: skillOf(hostile, { segments: 40, gapRate: 0.5, coverage: coverageOf([[hostile, false]] as const) }) },
      { tracePath: hostile, kbPath: hostile },
    ));
    const html = render({ pageKind: 'report', report }, 'zh');
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes(reactText(hostile)), '恶意内容以转义文本可见，而不是被静默丢弃');
    assert.ok(!html.includes('href="&lt;script') && !html.includes('href="http'), '来源路径不渲染成链接');
  });

  it('列表页给出报告身份、分档标签与对比入口，分区导航标出当前页', () => {
    const rows = projectIndexRows([
      { id: 'obs-1', generatedAt: '2026-09-02T08:30:00Z', sessionCount: 2, segmentCount: 40, skillCount: 3, healthBand: 'red', confidence: 'high' },
      { id: 'obs-2', generatedAt: '2026-09-01T08:00:00Z', sessionCount: 1, segmentCount: 3, skillCount: 1, healthBand: 'red', confidence: 'underpowered' },
    ]);
    const html = render({ pageKind: 'index', rows }, 'zh');
    assert.match(html, /<a[^>]*aria-current="page" href="\/observe\/health">/);
    assert.ok(html.includes('href="/observe/health/obs-1"') && html.includes('href="/observe/health/obs-2"'));
    assert.match(html, /需关注/);
    assert.match(html, /样本不足/);
    assert.ok(html.includes('2026-09-02 08:30'), '时间戳截到分钟');
    assert.match(html, /对比 →/);
    assert.ok(!html.includes('/observe/health-diff'), '未选 from/to 前不产出 diff 地址');
    assert.equal((html.match(/ disabled/u) ?? []).length, 1, '对比按钮在选满前保持禁用');
    const en = render({ pageKind: 'index', rows }, 'en');
    assert.match(en, /<a[^>]*aria-current="page" href="\/observe\/health\?lang=en">/);
    assert.match(en, /Attention/);
    assert.match(en, /Low N/);
  });

  it('空列表指向产出报告的命令，命令里的尖括号按文本渲染', () => {
    const html = render({ pageKind: 'index', rows: [] }, 'zh');
    assert.ok(html.includes('<code>omk observe &lt;trace-dir&gt;</code>'));
    assert.ok(!html.includes('<code>omk observe <trace-dir>'));
    assert.match(html, /暂无 Skill 健康度日报/);
  });

  it('空列表与详情页都按当前语言给出返回观测入口', () => {
    const report = projectReport('a', reportOf({ s: skillOf('s', { segments: 40 }) }));
    const trend = projectTrend({ skillName: 's', points: [] });
    const diff = { fromId: 'a', toId: 'b', fromAt: '2026-09-01T08:30:00Z', toAt: '2026-09-02T08:30:00Z', rows: projectDiff([]) };
    const row = { id: 'a', generatedAt: '2026-09-02T08:30:00Z', sessionCount: 1, segmentCount: 40, skillCount: 1, healthBand: 'green' as const, confidence: 'high' as const };
    for (const lang of ['zh', 'en'] as const) {
      const href = `href="/observe${lang === 'en' ? '?lang=en' : ''}"`;
      for (const page of [
        { pageKind: 'report' as const, report },
        { pageKind: 'trend' as const, trend },
        { pageKind: 'diff' as const, diff },
        { pageKind: 'index' as const, rows: [] },
        { pageKind: 'index' as const, rows: projectIndexRows([row]) },
      ]) {
        assert.ok(render(page, lang).includes(href), `${page.pageKind} 的 ${lang} 回观测入口不能丢`);
      }
    }
  });

  it('趋势页把每个时间点链回详情，并给出可比较结果的分母', () => {
    const trend = projectTrend({
      skillName: 'audit',
      points: [
        trendPointOf({ analysisId: 'obs/1', generatedAt: '2026-09-01T08:30:00Z', gapRate: 0.2, toolCallCount: 8, toolComparableCount: 6, toolCancelledCount: 2 }),
        trendPointOf({ analysisId: 'obs-2', generatedAt: '2026-09-02T08:30:00Z', gapRate: 0.3, failureRate: null, toolCallCount: 0 }),
      ],
    });
    const html = render({ pageKind: 'trend', trend }, 'zh');
    assert.ok(html.includes('href="/observe/health/obs%2F1"'), '身份编码后进链接，不拼出越段路径');
    assert.match(html, /6\/8 结果可比较 · 2 取消/);
    assert.match(html, /2 个时间点/);
    assert.ok(/<path d="M[^"]*"[^>]*stroke="#f87171"/.test(html), '折线以 gap 序列色绘制，与图例同色');
    const empty = render({ pageKind: 'trend', trend: projectTrend({ skillName: 'audit', points: [] }) }, 'zh');
    assert.match(empty, /暂无趋势数据/);
    assert.ok(!empty.includes('health-trend-chart'), '没有点时空图不画坐标');
  });

  it('差异页标注只出现在一侧的 skill，并给缺值留占位', () => {
    const diff = {
      fromId: 'obs-1', toId: 'obs-2',
      fromAt: '2026-09-01T08:30:00Z', toAt: '2026-09-02T08:30:00Z',
      rows: projectDiff([
        { skillName: 'both', presence: 'both', fromSegments: 10, toSegments: 20, deltaSegments: 10, fromGap: 0.5, toGap: 0.25, deltaGap: -0.25 } satisfies SkillDiffRow,
        { skillName: 'gone', presence: 'only-from', fromGap: 0.4, fromSegments: 7 } satisfies SkillDiffRow,
        { skillName: 'fresh', presence: 'only-to', toGap: 0.1, toSegments: 3 } satisfies SkillDiffRow,
      ]),
    };
    const html = render({ pageKind: 'diff', diff }, 'zh');
    assert.ok(html.includes('href="/observe/skill-trend/both"'));
    assert.match(html, /class="[^"]*health-delta tone-success[^"]*"[^>]*>-25\.0%/);
    assert.match(html, /已消失/);
    assert.match(html, /新增/);
    assert.equal(html.match(/class="health-pair"/g)?.length, 12, '三行四栏都在文档里');
    assert.ok(html.includes('href="/observe/health/obs-1"') && html.includes('href="/observe/health/obs-2"'));
    assert.match(html, /按 gap 变化量排序/);
  });

  it('观测输入与时间覆盖问题在详情页说话，而不是静默丢数据', () => {
    const report = projectReport('a', reportOf(
      { s: skillOf('s', { segments: 40 }) },
      {
        ingestion: { malformedRecordCount: 2, ignoredValueCount: 1, unknownEventCount: 3 } as never,
        timestampCoverage: 0.9,
        excludedUntimestampedSegmentCount: 4,
      },
    ));
    const html = render({ pageKind: 'report', report }, 'zh');
    assert.match(html, /观测输入需要复核/);
    assert.match(html, /2 条格式损坏记录，1 个非对象值，3 个未识别事件/);
    assert.match(html, /时间范围不完整/);
    assert.match(html, /另排除了 4 个无时间戳片段/);
  });

  it('稳定性、软信号与工具读数共用同一口径', () => {
    const report = projectReport('a', reportOf({
      s: skillOf('s', {
        segments: 40, gapRate: 0.5, weightedGapRate: 0.3, byType: { failed_search: 2, hedging: 1 },
        toolCalls: 10, toolFailures: 6, stability: 'very-unstable',
      }),
    }));
    const html = render({ pageKind: 'report', report }, 'zh');
    assert.match(html, /class="[^"]*health-skill-failure tone-error[^"]*"[^>]*>6\/10 失败（60%）/);
    assert.match(html, /失败率 60%，gap 可能是环境问题/);
    assert.match(html, /加权盲区 30% · 20% 为软信号（建议复核）/);
    assert.match(html, /搜索未命中 × 2/);
    assert.match(html, /表达不确定 × 1/);
  });
});
