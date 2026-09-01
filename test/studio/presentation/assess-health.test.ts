/**
 * assessHealth — Diagnosis-only skill 的健康等级判定。
 *
 * 重点覆盖:doctor / observe 都没跑过时,如果 insights 含
 * high/medium 信号(来自 Diagnosis 投影),卡片不应该落到灰色「未评估」,
 * 否则只跑了 observe ingest 拿到 `skill_md_not_found` 的 skill 会被红色筛选
 * 漏掉。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { assessHealth } from '../../../src/studio/presentation/skill-detail-renderer.js';
import type { Insight, SkillIndexEntry } from '../../../src/studio/view-models/index.js';

function mkEntry(overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    skillName: 'test-skill',
    doctor: null,
    observe: null,
    doctorHistory: [],
    observeHistory: [],
    band: 'gray',
    ...overrides,
  };
}

function mkInsight(severity: Insight['severity'], id = 'i1'): Insight {
  return {
    id,
    category: 'skill-doc-gap',
    audience: 'skill-author',
    title: 't',
    severity,
    affectedCount: 1,
    evidence: [],
    recommendations: [],
  };
}

describe('assessHealth — Diagnosis-only skill', () => {
  it('三大维度都没跑 + 有 high insight → red,不再落灰色', () => {
    const h = assessHealth(mkEntry(), [mkInsight('high')], 'zh');
    assert.equal(h.grade, 'unhealthy');
    assert.equal(h.color, 'red');
    assert.equal(h.score, null);
  });

  it('三大维度都没跑 + 只有 medium insight → yellow', () => {
    const h = assessHealth(mkEntry(), [mkInsight('medium')], 'zh');
    assert.equal(h.grade, 'fair');
    assert.equal(h.color, 'yellow');
    assert.equal(h.score, null);
  });

  it('三大维度都没跑 + 只有 low insight → 仍然 unscored', () => {
    const h = assessHealth(mkEntry(), [mkInsight('low')], 'zh');
    assert.equal(h.grade, 'unscored');
    assert.equal(h.color, 'gray');
  });

  it('三大维度都没跑 + insights 完全为空 → unscored', () => {
    const h = assessHealth(mkEntry(), [], 'zh');
    assert.equal(h.grade, 'unscored');
    assert.equal(h.color, 'gray');
  });

  it('EN 文案也走对应分支', () => {
    const h = assessHealth(mkEntry(), [mkInsight('high')], 'en');
    assert.equal(h.grade, 'unhealthy');
    assert.equal(h.label, 'Unhealthy');
  });
});

describe('assessHealth — observe confidence guard', () => {
  const observe = (
    confidence: 'high' | 'low' | 'underpowered',
    healthBand: 'green' | 'yellow' | 'red',
  ): NonNullable<SkillIndexEntry['observe']> => ({
    analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
    healthBand, failureRate: 0.5, gapRate: 0.5,
    segmentCount: confidence === 'underpowered' ? 2 : 30, confidence,
  });

  it('underpowered red observe 单独存在 → 中性灰「未评估」,既不红也不绿', () => {
    const h = assessHealth(mkEntry({ observe: observe('underpowered', 'red') }), [], 'zh');
    // 低 N observe 不算可信维度:不能硬标红,更不能从 excellent 兜底翻成硬绿「健康」。
    assert.equal(h.grade, 'unscored');
    assert.equal(h.color, 'gray');
    assert.equal(h.score, null);
  });

  it('underpowered observe + high insight → 仍按可信信号(Diagnosis)标红', () => {
    const h = assessHealth(mkEntry({ observe: observe('underpowered', 'red') }), [mkInsight('high')], 'zh');
    assert.equal(h.grade, 'unhealthy');
    assert.equal(h.color, 'red');
  });

  it('doctor 全绿 + underpowered observe → excellent,observe 不进分也不拉低', () => {
    const h = assessHealth(mkEntry({
      doctor: { reportId: 'd1', timestamp: '2026-05-09T10:00:00Z', status: 'pass', passCount: 8, warnCount: 0, failCount: 0, results: [] },
      observe: observe('underpowered', 'red'),
    }), [], 'zh');
    assert.equal(h.grade, 'excellent');
    assert.equal(h.color, 'green');
    assert.equal(h.score, 100);
  });

  it('high-confidence red observe still drives unhealthy/red', () => {
    const h = assessHealth(mkEntry({ observe: observe('high', 'red') }), [], 'zh');
    assert.equal(h.grade, 'unhealthy');
    assert.equal(h.color, 'red');
  });

  it('green observe 但可比工具结果少于 5 条 → 不把稳定性当成硬绿结论', () => {
    const sparse = {
      ...observe('high', 'green'),
      gapRate: 0,
      failureRate: 0,
      toolCallCount: 2,
      toolResolvedCount: 2,
      toolCancelledCount: 0,
    };
    const h = assessHealth(mkEntry({ observe: sparse }), [], 'zh');
    assert.equal(h.grade, 'unscored');
    assert.equal(h.color, 'gray');
    assert.equal(h.score, null);
  });
});
