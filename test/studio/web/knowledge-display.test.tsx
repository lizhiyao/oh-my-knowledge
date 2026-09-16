/**
 * 知识区的两处展示一致性（#903 的 D5／D6）。
 *
 * 列顺序：09-16 的真实浏览器验收在 1440×900 下读到「问题」与「更新时间」两个表头挤成一处，并把
 * antd 自己的表头分隔线误读成「观测缺口右侧多一条竖线」。成因不是多画了一条线，而是那个 72px 的
 * 右对齐计数列夹在两个左对齐文本列中间：文字贴着自己单元格的右边缘，也就贴上了下一列的左内边距。
 * 所以这里钉的是「右对齐的计数列收在行尾」这条不变量，而不是某个具体列名顺序——列名会随文案改，
 * 贴边的问题只要右对齐列后面还有文本列就会回来。列宽同理不钉像素，只钉每列都能装下最长读数。
 *
 * 跨区边：知识详情读得到观测缺口、片段数、可信度，却没有任何入口通往该 Skill 在观测区的趋势页，
 * 用户要回健康度看板按名字找同一行。趋势页在 antd Tabs 的第二个面板里，SSR 只输出激活面板，所以
 * 直接渲染面板 owner `ObservePanel`（同 `observeGapText` 的导出原因）。
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadKnowledgePage } from '../../../src/studio/http/pages/knowledge-page.js';
import type { KnowledgeQuery } from '../../../src/studio/application/knowledge/knowledge-query.js';
import type { SkillIndex, SkillIndexEntry, SkillObserveSnapshot } from '../../../src/studio/view-models/knowledge/skill-index.js';
import { KnowledgeView, ObservePanel } from '../../../src/studio/web/components/knowledge/knowledge.js';

const observe: SkillObserveSnapshot = {
  analysisId: 'a1',
  generatedAt: '2026-09-16T10:00:00Z',
  healthBand: 'yellow',
  effectiveBand: 'yellow',
  failureRate: 0.1,
  segmentCount: 40,
  gapRate: 0.125,
  confidence: 'high',
};

function indexFor(entries: SkillIndexEntry[]): KnowledgeQuery {
  const index = {
    entries,
    summary: { totalSkills: entries.length, withObserve: entries.length, withDoctor: 0, red: 0, yellow: entries.length, green: 0, gray: 0 },
    insightsBySkill: new Map(),
    diagnosticsBySkill: new Map(),
    diagnosisSummary: {},
  } as unknown as SkillIndex;
  return { read: () => index } as unknown as KnowledgeQuery;
}

function entry(skillName: string): SkillIndexEntry {
  return { skillName, doctor: null, observe, doctorHistory: [], band: 'yellow' };
}

/** 表头单元格按可见顺序给出「文字 + 是否右对齐」。 */
function headerCells(html: string): string[] {
  return [...html.matchAll(/<th([^>]*)>([\s\S]*?)<\/th>/g)]
    .map(([, attrs, body]) => `${body.replace(/<[^>]+>/g, '')}${/text-align:right/.test(attrs.replace(/\s+/g, '')) ? ':right' : ''}`);
}

describe('知识列表的列顺序', () => {
  it('右对齐的计数列收在行尾，不与文本列相邻', () => {
    const page = loadKnowledgePage(indexFor([entry('demo-skill')]), '/knowledge', 'zh');
    assert.ok(page && page.pageKind === 'index');
    const cells = headerCells(renderToString(createElement(KnowledgeView, { page, lang: 'zh' })));
    expect(cells).toEqual(['知识对象', '健康', '健康体检', '观测缺口', '更新时间', '问题:right']);
  });
});

describe('知识详情到观测区的跨区边', () => {
  it('中文给出通往该 Skill 趋势页的链接，地址带上语言', () => {
    const html = renderToString(createElement(ObservePanel, { observe, toolFailureRate: null, skillName: 'demo-skill', zh: true, suffix: '?lang=zh' }));
    expect(html).toMatch(/<a href="\/observe\/skill-trend\/demo-skill\?lang=zh"[^>]*>查看该 Skill 的趋势 →<\/a>/);
  });

  it('英文沿用同一目的地，skill 名按地址片段编码', () => {
    const html = renderToString(createElement(ObservePanel, { observe, toolFailureRate: 0, skillName: 'my skill/x', zh: false, suffix: '?lang=en' }));
    expect(html).toMatch(/<a href="\/observe\/skill-trend\/my%20skill%2Fx\?lang=en"[^>]*>Trend for this skill →<\/a>/);
    expect(html).toMatch(/Knowledge gap/);
    expect(html).toMatch(/12\.5%/);
  });
});
