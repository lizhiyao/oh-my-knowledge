import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'vitest';
import { layout } from '../../../src/studio/presentation/layout.js';
import { renderAnalysisList, renderSkillDiffPage } from '../../../src/studio/presentation/knowledge-reports-renderer.js';

describe('knowledge review presentation', () => {
  it('returns both empty and populated health lists to Observe in the selected language', () => {
    for (const items of [[], [{ id: 'one', generatedAt: '2026-09-01', sessionCount: 1, segmentCount: 1, skillCount: 1, healthBand: 'green' as const, confidence: 'underpowered' as const }]]) {
      assert.match(renderAnalysisList(items, 'zh'), /href="\/observe"[^>]*>← 返回观测<\/a>/);
      assert.match(renderAnalysisList(items, 'en'), /href="\/observe\?lang=en"[^>]*>← Back to Observe<\/a>/);
    }
  });

  it('colors metric changes by their meaning and keeps sample changes neutral', () => {
    const html = renderSkillDiffPage({ fromId: 'a', toId: 'b', fromAt: '2026-09-01', toAt: '2026-09-02', rows: [{
      skillName: 'audit', presence: 'both', fromSegments: 10, toSegments: 20, deltaSegments: 10,
      fromGap: 0.5, toGap: 0.25, deltaGap: -0.25, fromFailure: 0.4, toFailure: 0.2, deltaFailure: -0.2,
      fromCoverage: 0.2, toCoverage: 0.8, deltaCoverage: 0.6,
    }] }, 'en');
    assert.match(html, /color:#888">\+10<\/span>/);
    assert.match(html, /color:#16a34a">-25.0%<\/span>/);
    assert.match(html, /color:#16a34a">-20.0%<\/span>/);
    assert.match(html, /color:#16a34a">\+60.0%<\/span>/);
  });

  it('navigates to a complete language render even when storage is blocked', () => {
    const html = layout('test', '<main>test</main>');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((value) => value.includes('function switchLang'))!;
    let destination = '';
    const context = {
      URL, document: { documentElement: { dataset: { lang: 'zh' } } },
      window: { location: { href: 'http://localhost/observe/inbox?skill=a%26b&turnId=t#evidence', assign: (url: string) => { destination = url; } } },
      localStorage: { getItem: () => null, setItem: () => { throw new Error('blocked'); } },
    };
    runInNewContext(`${script}\nswitchLang();`, context);
    const target = new URL(destination);
    assert.equal(target.pathname, '/observe/inbox');
    assert.equal(target.searchParams.get('skill'), 'a&b');
    assert.equal(target.searchParams.get('turnId'), 't');
    assert.equal(target.searchParams.get('lang'), 'en');
    assert.equal(target.hash, '#evidence');
  });
});
