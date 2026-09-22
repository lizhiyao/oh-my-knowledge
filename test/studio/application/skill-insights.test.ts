import { describe, expect, it } from 'vitest';
import { detectInsights } from '../../../src/studio/application/knowledge/skill-insights.js';
import type { Diagnosis } from '../../../src/diagnosis/contracts.js';
import type { SkillIndexEntry } from '../../../src/studio/view-models/knowledge/skill-index.js';

function entry(overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    skillName: 'review',
    doctor: null,
    observe: null,
    doctorHistory: [],
    band: 'gray',
    ...overrides,
  };
}

function diagnosis(lifecycle: Diagnosis['lifecycle']): Diagnosis {
  return {
    id: `diag-${lifecycle}`,
    stableKey: `stable-${lifecycle}`,
    skillName: 'review',
    type: 'definition_gap',
    signal: 'coverage-gap',
    title: `${lifecycle} diagnosis`,
    summary: '缺少一条知识定义。',
    severity: 'high',
    audience: 'skill-author',
    lifecycle,
    scope: { primary: 'skill', refs: { skillName: 'review' } },
    occurrences: [],
    occurrenceCount: 2,
  };
}

describe('Core-independent skill insights', () => {
  it('derives doctor and observe insights without reading evaluation reports', () => {
    const insights = detectInsights(entry({
      doctor: {
        reportId: 'doctor-1',
        timestamp: '2026-09-01T00:00:00.000Z',
        status: 'fail',
        passCount: 0,
        warnCount: 0,
        failCount: 1,
        results: [{
          ruleId: 'dependencies_present',
          severity: 'fatal',
          labelKey: 'doctor.dependencies_present',
          status: 'fail',
          message: '缺少 references/rules.md。',
          detail: { missing_files: ['references/rules.md'] },
          durationMs: 1,
        }],
      },
      observe: {
        analysisId: 'observe-1',
        generatedAt: '2026-09-01T00:00:00.000Z',
        healthBand: 'red', effectiveBand: 'gray',
        failureRate: 0.5,
        segmentCount: 2,
        gapRate: 0.5,
        confidence: 'underpowered',
      },
    }), { lang: 'zh' as const, diagnostics: [] });

    expect(insights.map((insight) => insight.id)).toEqual([
      'skill-doc-gap',
      'coverage-gap',
      'production-instability',
    ]);
    expect(insights.find((insight) => insight.id === 'coverage-gap')?.severity).toBe('low');
    expect(insights.find((insight) => insight.id === 'coverage-gap')?.evidence)
      .toContainEqual(expect.objectContaining({ status: 'silent' }));
  });

  it('projects only active Diagnosis lifecycle states', () => {
    const insights = detectInsights(entry(), {
      lang: 'zh' as const,
      diagnostics: [diagnosis('detected'), diagnosis('resolved')],
    });
    expect(insights.map((insight) => insight.id)).toEqual(['diagnosis:diag-detected']);
  });

  it('Diagnosis 与 observe 是独立证据源，空诊断数组不得吞掉 observe insight', () => {
    const insights = detectInsights(entry({
      observe: {
        analysisId: 'observe-1',
        generatedAt: '2026-09-01T00:00:00.000Z',
        healthBand: 'yellow', effectiveBand: 'yellow',
        failureRate: 0.25,
        segmentCount: 30,
        gapRate: 0.3,
        confidence: 'high',
      },
    }), { lang: 'zh' as const, diagnostics: [] });
    expect(insights.map((insight) => insight.id)).toEqual([
      'coverage-gap',
      'production-instability',
    ]);
  });

  it('preserves Diagnosis recommendation and patch instead of replacing authored guidance', () => {
    const detected = {
      ...diagnosis('detected'),
      recommendation: '补齐缺失的工作流规则。',
      patch: { target: 'definition' as const, location: 'SKILL.md', snippet: '## Rule' },
    };
    const [insight] = detectInsights(entry(), {
      lang: 'zh' as const, diagnostics: [detected] });
    expect(insight.recommendations).toEqual([{
      action: '补齐缺失的工作流规则。',
      priority: 'high',
      patch: { target: 'skill', location: 'SKILL.md', snippet: '## Rule' },
    }]);
  });

});

describe('insight 文案的双语与证据边界', () => {
  const failingDoctor = {
    reportId: 'doctor-1',
    timestamp: '2026-09-01T00:00:00.000Z',
    status: 'fail',
    passCount: 0,
    warnCount: 0,
    failCount: 1,
    results: [{
      ruleId: 'dependencies_present',
      severity: 'fatal',
      labelKey: 'doctor.dependencies_present',
      status: 'fail',
      message: '缺少 references/rules.md。',
      detail: { missing_files: ['references/rules.md'] },
    }],
  } as const;
  const gapObserve = {
    analysisId: 'observe-1',
    generatedAt: '2026-09-01T00:00:00.000Z',
    healthBand: 'yellow', effectiveBand: 'yellow',
    failureRate: 0.45,
    segmentCount: 30,
    gapRate: 0.6,
    confidence: 'underpowered',
  } as const;
  const han = /[\u4e00-\u9fff]/u;

  function rules(lang: 'zh' | 'en') {
    return detectInsights(entry({ doctor: failingDoctor as never, observe: gapObserve as never }), {
      lang, diagnostics: [],
    });
  }

  it('英文模式下 OMK 规则文案整条不含中文，含数字插值句', () => {
    const insights = rules('en');
    expect(insights.length).toBeGreaterThan(0);
    for (const insight of insights) {
      const authored = [
        insight.title,
        insight.description ?? '',
        ...insight.recommendations.map((recommendation) => recommendation.action),
        // observe 侧证据句由 OMK 在读取时用结构化数字组句，属于自写文案。
        ...insight.evidence.filter((evidence) => evidence.perspective === 'observe')
          .map((evidence) => evidence.message),
      ];
      for (const text of authored) {
        expect(han.test(text), `${insight.id}: ${text}`).toBe(false);
      }
      // 落盘的 doctor 规则文字是证据，英文界面原样呈现，渲染层不改写。
      for (const evidence of insight.evidence.filter((item) => item.perspective === 'doctor')) {
        expect(han.test(evidence.message), evidence.message).toBe(true);
      }
    }
    expect(insights.find((insight) => insight.id === 'production-instability')?.evidence[0]?.message)
      .toMatch(/45%/);
  });

  it('换语言只换文字：严重度、计数、证据引用与顺序逐字段不变', () => {
    const zh = rules('zh');
    const en = rules('en');
    expect(en.map((insight) => insight.id)).toEqual(zh.map((insight) => insight.id));
    for (let index = 0; index < zh.length; index += 1) {
      const left = zh[index]!;
      const right = en[index]!;
      expect({ ...right, title: left.title, description: left.description, evidence: left.evidence, recommendations: left.recommendations })
        .toEqual(left);
    }
  });

  it('Diagnosis 承载的已落盘文字在英文界面原样呈现，不在渲染层改写', () => {
    const recorded = {
      ...diagnosis('detected'),
      title: '旧版规则未更新',
      summary: '来源会话里同一缺口重复出现。',
      evidenceSummary: '3 次观测均缺少同一条约束。',
      recommendation: undefined,
    };
    const [insight] = detectInsights(entry(), { lang: 'en', diagnostics: [recorded] });
    expect(insight?.title).toBe('旧版规则未更新');
    expect(insight?.description).toBe('来源会话里同一缺口重复出现。');
    expect(insight?.evidence[0]?.message).toBe('3 次观测均缺少同一条约束。');
    // 只有 OMK 自己补的兜底建议会跟随语言。
    expect(insight?.recommendations[0]?.action).toMatch(/Review the linked evidence/);
  });
});
