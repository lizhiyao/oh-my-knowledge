import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { RunDetail, RunList } from '../../../src/studio/web/components/measure/measure';
import type { CoreStudioRunCard, CoreStudioRunDetail } from '../../../src/studio/index.js';
import { card, detail } from '../fixtures/core-run-view.js';

/** React 文本节点的转义结果；值被整体丢弃同样算失败。 */
function reactText(payload: string): string {
  return payload
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

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
      assert.ok(html.includes(`href="/measure/${runId}?lang=en"`));
    }
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
