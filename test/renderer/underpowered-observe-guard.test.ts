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
import type { SkillIndex, SkillIndexEntry } from '../../src/studio/view-models/skill-index.js';

function underpoweredEntry(): SkillIndexEntry {
  return {
    skillName: 'thin-skill',
    doctor: null,
    observe: {
      analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
      healthBand: 'red', failureRate: 0.5, segmentCount: 2, gapRate: 0,
      confidence: 'underpowered',
    },
    doctorHistory: [],
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
    summary: { totalSkills: 1, withObserve: 1, withDoctor: 0, red: 0, yellow: 0, green: 0, gray: 1 },
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
    const html = renderSkillDetail(underpoweredEntry(), 'zh');
    assert.match(html, /sd-hero--gray/);
    assert.match(html, /未评估/);
  });

  it('三视角速览 observe 标「样本不足」而非「X% 稳定」', () => {
    const html = renderSkillDetail(underpoweredEntry(), 'zh');
    assert.match(html, /样本不足/);
  });
});
