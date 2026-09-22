import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { RunDetail, RunList, RunSidebar } from '../../../src/studio/web/components/measure/measure';
import type { CoreStudioRunCard, CoreStudioRunDetail } from '../../../src/studio/view-models/measure/core-runs.js';
import { card, detail } from '../fixtures/core-run-view.js';
import { reactText } from '../../helpers/react-ssr.js';

function runDetail(view: CoreStudioRunDetail, lang: 'zh' | 'en'): string {
  return renderToString(createElement(RunDetail, { detail: view, lang }));
}

/**
 * 事实层与语言无关：数字、原因码、指纹、预算字段在两份词表下都必须原样出现，
 * 否则中英两份视图就不是同一次测量。
 */
const LANGUAGE_INDEPENDENT_FACTS = [
  'progress-policy',
  'PROGRESS',
  'threshold-satisfied',
  'strict-reservation',
  'overshoot=0ms',
  'ledger=execution-ledger-',
  'sourceUnavailable=1',
  'executor-error',
  'quality:observed=4.25',
  'mean-quality',
  'total 15',
  'dataset-1',
  'instrument-1 / member-1 / replicate-1 / 0',
  'omk.run-plan/v5',
  'runtime-fixture@1.2.3',
];

describe('measure react detail keeps every projected fact in the served document', () => {
  for (const lang of ['zh', 'en'] as const) {
    it(`renders the same facts for ${lang}`, () => {
      const html = runDetail(detail(), lang);
      for (const fact of LANGUAGE_INDEPENDENT_FACTS) {
        assert.ok(html.includes(fact), `missing fact: ${fact}`);
      }
    });
  }

  it('puts the decision ahead of the evidence panels instead of an overall score', () => {
    const html = runDetail(detail(), 'en');
    assert.ok(html.indexOf('PROGRESS') < html.indexOf('ant-tabs-nav'), 'decision must be readable without opening a panel');
    assert.ok(!html.includes('综合状态') && !html.includes('Overall'));
  });

  /**
   * Tabs／Collapse 默认只渲染展开的一块；关掉 forceRender 时后两个 Tab 的内容会整体消失，
   * 深证据就退化成只有点开后才有——这条断言锁住「证据随文档一次给全」。
   */
  it('serves inactive tab and collapse content in the same response', () => {
    const html = runDetail(detail(), 'en');
    assert.equal(html.match(/class="ant-tabs-content/g)?.length, 3, 'every tab panel is in the document');
    assert.equal(html.match(/class="ant-collapse-item/g)?.length, 4, 'every evidence panel is in the document');
    assert.ok(html.includes('run-plan'), 'lineage sits in the last collapse panel');
    assert.ok(html.includes('quality:observed=4.25'), 'observations sit in the last collapse panel');
  });

  it('keeps timestamps machine-readable and colors only the budget verdict', () => {
    const html = runDetail(detail(), 'en');
    assert.ok(html.includes('<time dateTime="2026-08-31T12:00:00.000Z">'), 'created-at stays a <time> element');
    // 可见文案必须来自 display/format 这个唯一 owner：时间不加引号包第二层、耗时走 formatDuration。
    assert.ok(html.includes('2026-08-31 12:00:00 UTC'), 'created-at text is displayTime output, not a local formatter');
    assert.ok(html.includes('>800ms<') && html.includes('>450ms<'), 'stage durations render formatDuration output');
    assert.ok(/<span class="ant-tag[^"]*ant-tag-success[^"]*">within-budget<\/span>/.test(html), 'budget summary carries its tone');
    assert.ok(html.includes('<code class="measure-code">invocations=2</code>'), 'budget counts stay plain facts');
  });

  it('labels tables with headings and scoped column headers', () => {
    const html = runDetail(detail(), 'en');
    assert.ok(html.includes('scope="col"'), 'column headers stay programmatically associated');
    for (const label of ['Targets', 'Evaluators', 'Metrics']) {
      assert.ok(html.includes(`<h3>${label}</h3>`), `table block needs its own heading: ${label}`);
    }
  });

  it('escapes projected values and keeps fields outside the allow-list out of both languages', () => {
    const sensitive = 'TOP-SECRET-RAW-CONTENT';
    const malicious = card({ runId: '<script>alert(1)</script>' });
    const base = detail(malicious);
    const unsafe = {
      ...base,
      rawInput: sensitive,
      stages: {
        ...base.stages,
        execution: {
          ...base.stages.execution,
          records: base.stages.execution.records.map((record) => ({ ...record, rawOutput: sensitive })),
        },
        analysis: {
          ...base.stages.analysis,
          records: base.stages.analysis.records.map((record) => ({ ...record, arbitraryTable: sensitive })),
        },
      },
    } as unknown as CoreStudioRunDetail;

    for (const lang of ['zh', 'en'] as const) {
      const html = runDetail(unsafe, lang);
      assert.ok(!html.includes('<script>alert(1)</script>'));
      assert.ok(html.includes(reactText('<script>alert(1)</script>')), 'the run id must survive as escaped text');
      assert.ok(!html.includes(sensitive), 'uncaptured evidence must not cross the projection boundary');
    }
  });
});

describe('measure react list keeps the three status axes orthogonal', () => {
  const runs: CoreStudioRunCard[] = [
    card(),
    card({ runId: 'cancelled', status: { runStatus: 'cancelled', evidenceStatus: 'partial', conclusionStatus: 'inconclusive' } }),
    card({ runId: 'exhausted', status: { runStatus: 'budget-exhausted', evidenceStatus: 'unresolvable', conclusionStatus: 'not-evaluated' } }),
    card({ runId: 'failed', status: { runStatus: 'failed', evidenceStatus: 'complete', conclusionStatus: 'conclusive' } }),
  ];

  it('labels each axis separately without synthesizing a quality verdict', () => {
    const html = renderToString(createElement(RunList, { runs, lang: 'zh' }));
    assert.ok(html.includes('运行状态'));
    assert.ok(html.includes('证据状态'));
    assert.ok(html.includes('结论状态'));
    assert.ok(!html.includes('综合状态'));
    for (const value of ['已完成', '已取消', '预算耗尽', '失败', '完整', '部分缺失', '无法解析', '可形成结论', '证据不足', '未评估']) {
      assert.ok(html.includes(value), `missing status label: ${value}`);
    }
    assert.ok(html.includes('href="/measure/core-run-1"'));
    for (const host of ['localhost', '127.0.0.1', ':7799']) {
      assert.ok(!html.includes(host), `navigation must not embed a host or port: ${host}`);
    }
  });

  it('keeps raw status values in English and links every row', () => {
    const html = renderToString(createElement(RunList, { runs, lang: 'en' }));
    for (const value of ['completed', 'cancelled', 'budget-exhausted', 'failed', 'complete', 'partial', 'unresolvable', 'conclusive', 'inconclusive', 'not-evaluated']) {
      assert.ok(html.includes(value), `missing status: ${value}`);
    }
    for (const runId of ['cancelled', 'exhausted', 'failed']) {
      assert.ok(html.includes(`href="/measure/${runId}"`));
    }
  });

  /**
   * 空列表要给出产出数据的那条命令；「搜索无匹配」是另一回事，不得混进同一句。
   * 命令里的尖括号会被 renderToString 转义，所以只钉到参数名为止。
   */
  it('names the command that produces data when there are no runs at all', () => {
    const zh = renderToString(createElement(RunList, { runs: [], lang: 'zh' }));
    assert.ok(zh.includes('尚无评测记录'), 'empty state explains itself');
    assert.ok(zh.includes('omk eval --control'), 'and names the command that produces data');
    assert.ok(!zh.includes('没有匹配的记录'), 'a search miss is a different state');
    const en = renderToString(createElement(RunList, { runs: [], lang: 'en' }));
    assert.ok(en.includes('No evaluations yet'));
    assert.ok(en.includes('omk eval --control'), 'English names the same command');
  });

  /**
   * 只表达事实的取值（数据分级）不参与配色，否则「敏感」会被读成一次失败，
   * 而状态色只用于表达结论的取值。
   */
  it('does not tone classification values that carry no conclusion', () => {
    const html = renderToString(createElement(RunList, { runs: [card()], lang: 'zh' }));
    const [cell] = html.match(/<span class="(ant-tag[^"]*)">sensitive<\/span>/u) ?? [];
    assert.ok(cell, 'classification stays a status tag');
    assert.ok(!/ant-tag-(success|warning|error)/u.test(cell), 'but carries no tone');
  });
});

/**
 * 侧栏运行切换器（#1055）：外壳侧栏里的紧凑列表只承担「切换运行」一件事——
 * 最新在前、状态与时间在列、当前运行高亮；多列对比仍是主区表格的职责。
 */
describe('measure sidebar run switcher', () => {
  it('lists runs newest-first with status and links into reports', () => {
    const older = card({ runId: 'core-run-old', createdAt: '2026-08-30T08:00:00.000Z' });
    const newer = card({ runId: 'core-run-new', createdAt: '2026-08-31T12:00:00.000Z', status: { runStatus: 'completed', evidenceStatus: 'complete', conclusionStatus: 'conclusive' } });
    const html = renderToString(createElement(RunSidebar, { runs: [older, newer], lang: 'zh' }));
    assert.ok(html.indexOf('core-run-new') < html.indexOf('core-run-old'), 'newest first');
    assert.ok(html.includes('href="/measure/core-run-new"'));
    assert.ok(html.includes('已完成'), 'run status label renders');
    assert.ok(html.includes('<time dateTime="2026-08-31T12:00:00.000Z">'), 'created-at stays a <time> element');
  });

  it('marks the open run and encodes ids into single-segment links', () => {
    const run = card({ runId: 'thread/a' });
    const html = renderToString(createElement(RunSidebar, { runs: [run], activeRunId: 'thread/a', lang: 'en' }));
    assert.ok(html.includes('href="/measure/thread%2Fa"'), 'run id stays one encoded segment');
    assert.ok(html.includes('measure-sidebar-link selected'), 'current run is marked');
  });

  it('explains the empty state instead of rendering a blank rail', () => {
    assert.ok(renderToString(createElement(RunSidebar, { runs: [], lang: 'zh' })).includes('尚无评测记录'));
    assert.ok(renderToString(createElement(RunSidebar, { runs: [], lang: 'en' })).includes('No evaluations yet'));
  });
});
