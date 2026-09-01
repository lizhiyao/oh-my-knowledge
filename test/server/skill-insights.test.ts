import { describe, expect, it } from 'vitest';
import { detectInsights, flattenRecommendations } from '../../src/server/skill-insights.js';
import type { Diagnosis, SkillIndexEntry } from '../../src/types/index.js';

function entry(overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    skillName: 'review',
    doctor: null,
    observe: null,
    doctorHistory: [],
    observeHistory: [],
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
        healthBand: 'red',
        failureRate: 0.5,
        segmentCount: 2,
        gapRate: 0.5,
        confidence: 'underpowered',
      },
    }));

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
      diagnostics: [diagnosis('detected'), diagnosis('resolved')],
    });
    expect(insights.map((insight) => insight.id)).toEqual(['diagnosis:diag-detected']);
  });

  it('Diagnosis 与 observe 是独立证据源，空诊断数组不得吞掉 observe insight', () => {
    const insights = detectInsights(entry({
      observe: {
        analysisId: 'observe-1',
        generatedAt: '2026-09-01T00:00:00.000Z',
        healthBand: 'yellow',
        failureRate: 0.25,
        segmentCount: 30,
        gapRate: 0.3,
        confidence: 'high',
      },
    }), { diagnostics: [] });
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
    const [insight] = detectInsights(entry(), { diagnostics: [detected] });
    expect(insight.recommendations).toEqual([{
      action: '补齐缺失的工作流规则。',
      priority: 'high',
      patch: { target: 'skill', location: 'SKILL.md', snippet: '## Rule' },
    }]);
  });

  it('deduplicates recommendations and keeps highest priority first', () => {
    expect(flattenRecommendations([
      {
        id: 'one', category: 'other', audience: 'skill-author', title: 'one', severity: 'low',
        affectedCount: 1, evidence: [], recommendations: [{ action: 'same', priority: 'low' }],
      },
      {
        id: 'two', category: 'other', audience: 'skill-author', title: 'two', severity: 'low',
        affectedCount: 1, evidence: [], recommendations: [
          { action: 'same', priority: 'high' },
          { action: 'later', priority: 'medium' },
        ],
      },
    ])).toEqual([
      { action: 'same', priority: 'high' },
      { action: 'later', priority: 'medium' },
    ]);
  });
});
