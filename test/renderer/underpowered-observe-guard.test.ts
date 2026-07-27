/**
 * underpowered observe 在 Studio 列表 / 详情两个渲染出口的口径守卫。
 *
 * 段数过少(confidence='underpowered')时,observe 的色带 / 稳定率仅供参考,任何渲染出口都
 * 不能把它当作硬结论:列表卡不报「X% 稳定」,详情 hero 不落红也不落绿「健康」,只走中性灰 +
 * 「样本不足」caveat。assessHealth 本身的单测在 assess-health.test.ts;这里锁全量 render 出口。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderSkillList } from '../../src/renderer/skill-list-renderer.js';
import { renderSkillDetail } from '../../src/renderer/skill-detail-renderer.js';
import type { SkillIndex, SkillIndexEntry } from '../../src/types/skill-index.js';

function underpoweredEntry(): SkillIndexEntry {
  return {
    skillName: 'thin-skill',
    doctor: null,
    eval: null,
    observe: {
      analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
      healthBand: 'red', failureRate: 0.5, segmentCount: 2, gapRate: 0,
      confidence: 'underpowered',
    },
    doctorHistory: [],
    evalHistory: [],
    observeHistory: [{
      analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
      healthBand: 'red', failureRate: 0.5, segmentCount: 2, gapRate: 0,
      confidence: 'underpowered',
    }],
    band: 'gray',
  };
}

function idxOf(entry: SkillIndexEntry): SkillIndex {
  return {
    entries: [entry],
    summary: { totalSkills: 1, withEval: 0, withObserve: 1, withDoctor: 0, red: 0, yellow: 0, green: 0, gray: 1 },
    insightsBySkill: new Map(),
    diagnosticsBySkill: new Map(),
    diagnosisSummary: {},
  } as unknown as SkillIndex;
}

describe('underpowered observe — Studio 列表口径', () => {
  it('列表卡不报「X% 稳定」硬指标,改标「样本不足」', () => {
    const html = renderSkillList(idxOf(underpoweredEntry()), 'zh');
    assert.match(html, /样本不足/);
    // gapRate=0 本会渲染「100% 稳定」—— 低 N 时不能出现 X% 稳定的硬结论(静态图例的「稳定性」不算)。
    assert.doesNotMatch(html, /\d+% 稳定/);
  });
});

describe('underpowered observe — Studio 详情口径', () => {
  it('hero 走中性灰「未评估」,既不落红也不落绿「健康」', () => {
    const html = renderSkillDetail(underpoweredEntry(), null, 'zh');
    // 只在 hero 区块内断言（整页别处的红绿色不算）。
    const heroMatch = /<div class="sd-hero">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.exec(html);
    const hero = heroMatch ? heroMatch[0] : html.slice(0, html.indexOf('sd-hero-grade-hint') + 200);
    // unscored 时 hero 综合分用中性灰 #9ca3af，不落硬红 / 硬绿。
    assert.match(hero, /color:#9ca3af/);
    assert.doesNotMatch(hero, /color:#dc2626/);
    assert.doesNotMatch(hero, /color:#1f9d63/);
  });

  it('三视角速览 observe 标「样本不足」而非「X% 稳定」', () => {
    const html = renderSkillDetail(underpoweredEntry(), null, 'zh');
    assert.match(html, /样本不足/);
  });
});

describe('unknown tool outcomes — Studio 详情口径', () => {
  it('不把不可测失败率渲染成 0% 或生产观测健康', () => {
    const entry = underpoweredEntry();
    entry.skillName = 'unknown-outcomes';
    entry.observe = {
      analysisId: 'a2',
      generatedAt: '2026-05-09T10:00:00Z',
      healthBand: 'yellow',
      failureRate: 0,
      segmentCount: 20,
      gapRate: 0,
      stability: 'unknown',
      confidence: 'high',
    };
    entry.observeHistory = [entry.observe];
    entry.band = 'yellow';

    const html = renderSkillDetail(entry, null, 'zh');
    assert.match(html, /工具结果状态未知/);
    assert.match(html, /工具失败率不可测/);
    assert.doesNotMatch(html, /工具失败率 0\.0%/);
    assert.doesNotMatch(html, /生产观测健康/);
  });
});
