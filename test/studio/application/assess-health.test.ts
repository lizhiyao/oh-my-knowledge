/**
 * assessHealth — Diagnosis-only skill 的健康等级判定。
 *
 * 重点覆盖:doctor / observe 都没跑过时,如果 insights 含
 * high/medium 信号(来自 Diagnosis 投影),卡片不应该落到灰色「未评估」,
 * 否则只跑了 observe ingest 拿到 `skill_md_not_found` 的 skill 会被红色筛选
 * 漏掉。
 *
 * 断言用 label + band：这两个字段就是页面实际读到的东西（着色由 band 经 healthBandTone 投影，
 * 已在别处锁住）。green 档下「健康」与「良好」同色，只有 label 能分开，所以每条都成对断言。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { assessHealth } from '../../../src/studio/application/knowledge/skill-health.js';
import type { Insight } from '../../../src/studio/view-models/knowledge/insight.js';
import type { SkillIndexEntry } from '../../../src/studio/view-models/knowledge/skill-index.js';

function mkEntry(overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    skillName: 'test-skill',
    doctor: null,
    observe: null,
    doctorHistory: [],
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

function mkDoctor(passCount: number): NonNullable<SkillIndexEntry['doctor']> {
  return {
    reportId: 'd1',
    timestamp: '2026-05-09T10:00:00Z',
    status: 'pass',
    passCount,
    warnCount: 0,
    failCount: 0,
    results: [],
  };
}

describe('assessHealth — Diagnosis-only skill', () => {
  it('三大维度都没跑 + 有 high insight → 不健康/red,不再落灰色', () => {
    const h = assessHealth(mkEntry(), [mkInsight('high')], 'zh');
    assert.equal(h.label, '不健康');
    assert.equal(h.band, 'red');
    assert.equal(h.score, null);
  });

  it('三大维度都没跑 + 只有 medium insight → 待改进/yellow', () => {
    const h = assessHealth(mkEntry(), [mkInsight('medium')], 'zh');
    assert.equal(h.label, '待改进');
    assert.equal(h.band, 'yellow');
    assert.equal(h.score, null);
  });

  it('三大维度都没跑 + 只有 low insight → 仍然未评估', () => {
    const h = assessHealth(mkEntry(), [mkInsight('low')], 'zh');
    assert.equal(h.label, '未评估');
    assert.equal(h.band, 'gray');
  });

  it('三大维度都没跑 + insights 完全为空 → 未评估', () => {
    const h = assessHealth(mkEntry(), [], 'zh');
    assert.equal(h.label, '未评估');
    assert.equal(h.band, 'gray');
  });

  it('EN 文案也走对应分支', () => {
    const h = assessHealth(mkEntry(), [mkInsight('high')], 'en');
    assert.equal(h.label, 'Unhealthy');
    assert.equal(h.band, 'red');
  });
});

describe('assessHealth — observe confidence guard', () => {
  const observe = (
    confidence: 'high' | 'low' | 'underpowered',
    healthBand: 'green' | 'yellow' | 'red',
  ): NonNullable<SkillIndexEntry['observe']> => ({
    analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
    healthBand, effectiveBand: confidence === 'underpowered' ? 'gray' : healthBand, failureRate: 0.5, gapRate: 0.5,
    segmentCount: confidence === 'underpowered' ? 2 : 30, confidence,
  });

  it('underpowered red observe 单独存在 → 中性灰「未评估」,既不红也不绿', () => {
    const h = assessHealth(mkEntry({ observe: observe('underpowered', 'red') }), [], 'zh');
    // 低 N observe 不算可信维度:不能硬标红,更不能从健康兜底翻成硬绿。
    assert.equal(h.label, '未评估');
    assert.equal(h.band, 'gray');
    assert.equal(h.score, null);
  });

  it('underpowered observe + high insight → 仍按可信信号(Diagnosis)标红', () => {
    const h = assessHealth(mkEntry({ observe: observe('underpowered', 'red') }), [mkInsight('high')], 'zh');
    assert.equal(h.label, '不健康');
    assert.equal(h.band, 'red');
  });

  it('doctor 全绿 + underpowered observe → 健康,observe 不进分也不拉低', () => {
    const h = assessHealth(mkEntry({
      doctor: mkDoctor(8),
      observe: observe('underpowered', 'red'),
    }), [], 'zh');
    assert.equal(h.label, '健康');
    assert.equal(h.band, 'green');
    assert.equal(h.score, 100);
  });

  it('有可信维度且只剩 low insight → 同色 green 下用「良好」区分于「健康」', () => {
    const h = assessHealth(mkEntry({ doctor: mkDoctor(8) }), [mkInsight('low')], 'zh');
    assert.equal(h.label, '良好');
    assert.equal(h.band, 'green');
    assert.equal(h.score, 100);
  });

  it('high-confidence red observe still drives 不健康/red', () => {
    const h = assessHealth(mkEntry({ observe: observe('high', 'red') }), [], 'zh');
    assert.equal(h.label, '不健康');
    assert.equal(h.band, 'red');
  });

  it('green observe 但可比工具结果少于 5 条 → 不把稳定性当成硬绿结论', () => {
    const sparse = {
      ...observe('high', 'green'),
      gapRate: 0,
      failureRate: 0,
      effectiveBand: 'gray' as const,
      toolCallCount: 2,
      toolResolvedCount: 2,
      toolCancelledCount: 0,
    };
    const h = assessHealth(mkEntry({ observe: sparse }), [], 'zh');
    assert.equal(h.label, '未评估');
    assert.equal(h.band, 'gray');
    assert.equal(h.score, null);
  });
});
