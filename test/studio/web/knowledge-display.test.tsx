import { CarrierContentReview } from '../../../src/studio/web/components/knowledge/artifact-authoring.js';
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

describe('知识载体默认入口', () => {
  it('先展示已保存载体，并提供直接生成入口', () => {
    const page = loadKnowledgePage(indexFor([entry('demo-skill')]), '/knowledge', 'zh');
    assert.ok(page && page.pageKind === 'index');
    const html = renderToString(createElement(KnowledgeView, { page, lang: 'zh' }));
    expect(headerCells(html)).toEqual(['载体名称', '形式', '版本', '内容状态']);
    expect(html).toContain('从已保留知识生成');
    expect(html).toContain('体检与观测');
  });
});

describe('知识首页的页级标题', () => {
  /**
   * #1060 的排版收敛顺带发现：知识首页此前没有 h1（只有 skill 详情页有），
   * 读者与辅助技术拿不到「这一页讲什么」的顶层答案，而其它三个区都有。
   * 这里钉的是「首页有一个且只有一个 h1，文案沿用分区导航已有的标签」，
   * 不钉字号——字号由 studio.css 与真实渲染量测负责，不在此重复。
   */
  const indexHtml = (lang: 'zh' | 'en') => {
    const page = loadKnowledgePage(indexFor([entry('demo-skill')]), '/knowledge', lang);
    assert.ok(page && page.pageKind === 'index');
    return renderToString(createElement(KnowledgeView, { page, lang }));
  };

  for (const [lang, label] of [['zh', '知识载体'], ['en', 'Knowledge artifacts']] as const) {
    it(`${lang} 给出唯一的页级标题`, () => {
      const headings = [...indexHtml(lang).matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)]
        .map(([, body]) => body.replace(/<[^>]+>/g, ''));
      expect(headings).toEqual([label]);
    });
  }
});

describe('知识详情到观测区的跨区边', () => {
  it('中文给出通往该 Skill 趋势页的链接，地址不带语言参数', () => {
    const html = renderToString(createElement(ObservePanel, { observe, toolFailureRate: null, skillName: 'demo-skill', zh: true }));
    expect(html).toMatch(/<a href="\/observe\/skill-trend\/demo-skill"[^>]*>查看该 Skill 的趋势 →<\/a>/);
  });

  it('英文沿用同一目的地，skill 名按地址片段编码', () => {
    const html = renderToString(createElement(ObservePanel, { observe, toolFailureRate: 0, skillName: 'my skill/x', zh: false }));
    expect(html).toMatch(/<a href="\/observe\/skill-trend\/my%20skill%2Fx"[^>]*>Trend for this skill →<\/a>/);
    expect(html).toMatch(/Knowledge gap/);
    expect(html).toMatch(/12\.5%/);
  });
});

// The authored content is editable plain text; it is never executed as HTML.
describe('载体内容核对', () => {
  it('shows the review action and escapes generated content in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = renderToString(createElement(CarrierContentReview, { content: '<script>unsafe</script>\n条件：人工核对', original: 'Original instructions', lang, onChange() {} }));
      expect(html).toContain(lang === 'zh' ? '核对并编辑新内容' : 'Review and edit new content');
      expect(html).toContain(lang === 'zh' ? '原内容' : 'Original content');
      expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
      expect(html).not.toContain('<script>unsafe');
      expect(html).toContain('条件：人工核对');
    }
  });
});
