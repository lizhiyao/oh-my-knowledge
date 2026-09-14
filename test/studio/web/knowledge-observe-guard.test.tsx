/**
 * underpowered observe 与「未测得 vs 实测 0%」在 React 知识页的口径守卫，
 * 迁移自 skill-list-renderer／skill-detail-renderer 被删除时的同名断言。
 *
 * 观测面板文案落在 antd Tabs 的非激活面板里，而 Tabs 的 SSR 只输出激活面板，所以这一层锁在
 * loadKnowledgePage 的投影结果上（health 与 toolFailureRate 就是面板的唯一数据源）；
 * 列表列与详情头部标签是可直接断言的渲染输出。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it } from 'vitest';
import { loadKnowledgePage } from '../../../src/studio/http/knowledge-page';
import type { KnowledgeQuery } from '../../../src/studio/application/knowledge-query';
import { KnowledgeView } from '../../../src/studio/web/components/knowledge/knowledge';
import type { SkillIndex, SkillIndexEntry } from '../../../src/studio/view-models/skill-index';

function entryWith(observe: SkillIndexEntry['observe'], overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return { skillName: 'thin-skill', doctor: null, observe, doctorHistory: [], observeHistory: [], band: observe?.effectiveBand ?? 'gray', ...overrides };
}

const underpowered = {
  analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
  healthBand: 'red', effectiveBand: 'gray', failureRate: 0.5, segmentCount: 2, gapRate: 0,
  confidence: 'underpowered',
} as const;

function queryFor(entries: SkillIndexEntry[]): KnowledgeQuery {
  const index = {
    entries,
    summary: { totalSkills: entries.length, withObserve: entries.length, withDoctor: 0, red: 0, yellow: 0, green: 0, gray: entries.length },
    insightsBySkill: new Map(),
    diagnosticsBySkill: new Map(),
    diagnosisSummary: {},
  } as unknown as SkillIndex;
  return { read: () => index } as unknown as KnowledgeQuery;
}

function renderIndex(entries: SkillIndexEntry[]): string {
  const page = loadKnowledgePage(queryFor(entries), '/knowledge', 'zh');
  assert.ok(page && page.pageKind === 'index');
  return renderToString(createElement(KnowledgeView, { page, lang: 'zh' }));
}

describe('知识列表的 underpowered 口径', () => {
  it('标注样本不足，而不是给出稳定性或缺口率的硬结论', () => {
    const html = renderIndex([entryWith(underpowered)]);
    assert.match(html, /样本不足/);
    // gapRate=0 会渲染成「0.0% 缺口」——低段数时不能以测量结论的形式出现。
    assert.doesNotMatch(html, /\d+(?:\.\d+)?%\s*(?:缺口|稳定)/);
  });

  it('把来自存储的 skill 名当作文本，不作为标记注入', () => {
    const payload = `</script><img src=x onerror=alert(1)>`;
    const html = renderIndex([entryWith(underpowered, { skillName: payload })]);
    assert.ok(!html.includes('<img src=x'), 'payload must not become markup');
    assert.ok(html.includes('&lt;/script&gt;&lt;img src=x'), 'payload must stay visible as data');
  });
});

describe('知识详情的健康口径', () => {
  it('详情页头部把 underpowered 观测渲染成中性标签，而不是健康结论', () => {
    const page = loadKnowledgePage(queryFor([entryWith(underpowered)]), '/knowledge/skills/thin-skill', 'zh');
    assert.ok(page && page.pageKind === 'detail');
    const html = renderToString(createElement(KnowledgeView, { page, lang: 'zh' }));
    assert.match(html, /ant-tag-default[^>]*>未评估</);
    assert.doesNotMatch(html, />(不健康|健康)</, '低段数的 red healthBand 不能伪装成结论');
  });

  it('区分缺失的工具结果与实测得到的 0% 失败率', () => {
    const observeWith = (toolCallCount: number, toolResolvedCount: number, toolCancelledCount: number, stability: 'stable' | 'unknown') => ({
      ...underpowered, confidence: 'high', effectiveBand: 'green', healthBand: 'green',
      segmentCount: 20, failureRate: 0, toolCallCount, toolResolvedCount, toolCancelledCount, stability,
    });
    const detailPage = (observe: SkillIndexEntry['observe']) => {
      const page = loadKnowledgePage(queryFor([entryWith(observe)]), '/knowledge/skills/thin-skill', 'zh');
      assert.ok(page && page.pageKind === 'detail');
      return page.toolFailureRate;
    };
    // 未起效／取消／无调用都算未测得；只有全部调用都有终态结果时 0% 才是测量结论。
    assert.equal(detailPage(observeWith(0, 0, 0, 'stable')), null);
    assert.equal(detailPage(observeWith(5, 0, 0, 'unknown')), null);
    assert.equal(detailPage(observeWith(5, 5, 5, 'unknown')), null);
    assert.equal(detailPage(observeWith(5, 5, 0, 'stable')), 0);
  });
});
