/**
 * detectInsights 单测 — 覆盖 6 类 detection 触发条件 + 不触发 + 严重度判定 +
 * 证据结构(flagged / blind / silent / na)。
 *
 * Fixture 用最小 EvaluationReport / SkillIndexEntry 拼装,只填触发本轮 detection
 * 必需的字段。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { detectInsights, flattenRecommendations } from '../../src/server/skill-insights.js';
import type { SkillIndexEntry } from '../../src/server/skill-index.js';
import type { EvaluationReport, ResultEntry } from '../../src/types/index.js';

function mkResult(sampleId: string, variant: string, opts: {
  passedAssertions?: boolean;
  rootCause?: string[];
  failureModes?: string[];
  diagnosticSummary?: string;
} = {}): ResultEntry {
  return {
    sample_id: sampleId,
    variants: {
      [variant]: {
        ok: opts.passedAssertions ?? false,
        durationMs: 100, durationApiMs: 100, numTurns: 1,
        inputTokens: 10, outputTokens: 20,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0.001,
        execCostUSD: 0.001, judgeCostUSD: 0.001,
        outputPreview: '',
        assertions: {
          passed: opts.passedAssertions ? 1 : 0,
          total: 1,
          score: opts.passedAssertions ? 5 : 1,
          details: [{ type: 'tool_input_contains', value: 'x', weight: 1, passed: opts.passedAssertions ?? false }],
        },
        ...(opts.rootCause || opts.failureModes
          ? {
            diagnostic: {
              ok: true,
              summary: opts.diagnosticSummary ?? '',
              expected: '', actual: '',
              rootCause: (opts.rootCause ?? []) as Array<'skill_doc_unclear' | 'skill_doc_missing' | 'llm_misread' | 'sample_design' | 'tripwire_intentional'>,
              failureModes: opts.failureModes as Array<'工作流跳步' | '硬编码值' | '幻觉输出' | '工具误用' | '环境拦截' | '误读约束' | '其他'> | undefined,
              suggestion: { skill: '', sample: '', none: '' },
            },
          }
          : {}),
      },
    },
  } as ResultEntry;
}

function mkEvalReport(variant: string, results: ResultEntry[]): EvaluationReport {
  return {
    kind: 'evaluation',
    id: `${variant}-test-id`,
    meta: {
      variants: ['baseline', variant],
      timestamp: '2026-05-09T10:00:00Z',
      cliVersion: '0.30.0', nodeVersion: 'v22',
      sampleCount: results.length, taskCount: results.length * 2, totalCostUSD: 0.01,
      model: 'opus', executor: 'claude',
      sampleHashes: {}, judgePromptHash: 'x', artifactHashes: {},
      judgeModels: [],
    },
    summary: {
      [variant]: {
        totalSamples: results.length, successCount: results.filter((r) => r.variants[variant].ok).length,
        errorCount: 0, errorRate: 0,
        avgDurationMs: 100, avgInputTokens: 10, avgOutputTokens: 20, avgTotalTokens: 30,
        totalCostUSD: 0.001, totalExecCostUSD: 0.001, totalJudgeCostUSD: 0,
        avgCostPerSample: 0.001, avgNumTurns: 1,
      },
    },
    results,
  } as EvaluationReport;
}

function mkEntry(opts: {
  doctor?: SkillIndexEntry['doctor'];
  observe?: SkillIndexEntry['observe'];
  evalSnap?: SkillIndexEntry['eval'];
} = {}): SkillIndexEntry {
  const d = opts.doctor ?? null;
  const e = opts.evalSnap ?? null;
  const o = opts.observe ?? null;
  return {
    skillName: 'test-skill',
    doctor: d, eval: e, observe: o,
    doctorHistory: d ? [d] : [],
    evalHistory: e ? [e] : [],
    observeHistory: o ? [o] : [],
    band: 'gray',
  };
}

describe('detectInsights — dependency-doc-issue', () => {
  it('doctor warn + eval skill_doc_missing 双证 → high severity', () => {
    const entry = mkEntry({
      doctor: {
        reportId: 'd1', timestamp: '2026-05-09T10:00:00Z', status: 'warn',
        passCount: 3, warnCount: 1, failCount: 0,
        results: [{
          ruleId: 'dependencies_present', severity: 'warn', labelKey: 'x', status: 'warn',
          message: '前置依赖警告', durationMs: 10,
        }],
      },
    });
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { rootCause: ['skill_doc_missing'], failureModes: [] }),
      mkResult('s2', 'test-skill', { rootCause: ['skill_doc_unclear'], failureModes: [] }),
    ]);
    const insights = detectInsights(entry, report);
    const dep = insights.find((i) => i.id === 'skill-doc-gap');
    assert.ok(dep, 'should detect dependency-doc-issue');
    assert.equal(dep!.affectedCount, 2);
    assert.equal(dep!.severity, 'high');
    assert.ok(dep!.evidence.find((e) => e.perspective === 'doctor' && e.status === 'flagged'));
    assert.ok(dep!.evidence.find((e) => e.perspective === 'eval-functional' && e.status === 'flagged'));
  });

  it('eval skill_doc_missing 但 doctor 没卡 → blind 标 + 仍出 insight', () => {
    const entry = mkEntry({
      doctor: {
        reportId: 'd1', timestamp: '2026-05-09T10:00:00Z', status: 'pass',
        passCount: 4, warnCount: 0, failCount: 0,
        results: [{
          ruleId: 'dependencies_present', severity: 'warn', labelKey: 'x', status: 'pass',
          message: '前置依赖完整', durationMs: 10,
        }],
      },
    });
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { rootCause: ['skill_doc_missing'] }),
    ]);
    const insights = detectInsights(entry, report);
    const dep = insights.find((i) => i.id === 'skill-doc-gap');
    assert.ok(dep);
    const doctorEv = dep!.evidence.find((e) => e.perspective === 'doctor')!;
    assert.equal(doctorEv.status, 'blind', '应标 doctor 盲区');
  });

  it('doctor pass + eval 全过 → 不触发', () => {
    const entry = mkEntry({
      doctor: {
        reportId: 'd1', timestamp: '2026-05-09T10:00:00Z', status: 'pass',
        passCount: 4, warnCount: 0, failCount: 0,
        results: [{ ruleId: 'dependencies_present', severity: 'warn', labelKey: 'x', status: 'pass', message: 'OK', durationMs: 10 }],
      },
    });
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { passedAssertions: true }),
    ]);
    const insights = detectInsights(entry, report);
    assert.equal(insights.find((i) => i.id === 'skill-doc-gap'), undefined);
  });
});

describe('detectInsights — doctor-blindspot', () => {
  it('多 sample 同 failureMode 硬编码值 + doctor 无对应 rule → blind insight', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { failureModes: ['硬编码值'] }),
      mkResult('s2', 'test-skill', { failureModes: ['硬编码值'] }),
      mkResult('s3', 'test-skill', { failureModes: ['硬编码值'] }),
    ]);
    const insights = detectInsights(mkEntry({ doctor: null }), report);
    const blind = insights.find((i) => i.id === 'omk-doctor-blindspot');
    assert.ok(blind, '应检测到 doctor-blindspot');
    assert.equal(blind!.affectedCount, 3);
    // omk-doctor-blindspot 是 omk 维护者待办,不是 skill 开发者的高优先 — 故意降级 medium
    assert.equal(blind!.severity, 'medium');
    assert.equal(blind!.audience, 'omk-maintainer');
  });

  it('同失败模式但只 1 条 → 不达 cluster 阈值,不触发', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { failureModes: ['硬编码值'] }),
    ]);
    const insights = detectInsights(mkEntry(), report);
    assert.equal(insights.find((i) => i.id === 'omk-doctor-blindspot'), undefined);
  });

  it('skill_doc_missing 类已被 dep-doc-issue 覆盖,不重复算 blindspot', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { rootCause: ['skill_doc_missing'], failureModes: ['硬编码值'] }),
      mkResult('s2', 'test-skill', { rootCause: ['skill_doc_missing'], failureModes: ['硬编码值'] }),
    ]);
    const insights = detectInsights(mkEntry(), report);
    assert.equal(insights.find((i) => i.id === 'omk-doctor-blindspot'), undefined);
  });
});

describe('detectInsights — failure-mode-cluster', () => {
  it('两条 sample 共享 工作流跳步 → medium', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { failureModes: ['工作流跳步'] }),
      mkResult('s2', 'test-skill', { failureModes: ['工作流跳步'] }),
    ]);
    const insights = detectInsights(mkEntry(), report);
    const cluster = insights.find((i) => i.id.startsWith('failure-mode-skill:'));
    assert.ok(cluster);
    assert.equal(cluster!.affectedCount, 2);
    assert.equal(cluster!.severity, 'medium');
  });

  it('全过 sample 不触发', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { passedAssertions: true }),
    ]);
    const insights = detectInsights(mkEntry(), report);
    assert.equal(insights.find((i) => i.id.startsWith('failure-mode-skill:')), undefined);
  });
});

describe('detectInsights — production-instability', () => {
  it('observe failureRate 50% → high insight', () => {
    const entry = mkEntry({
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'red', failureRate: 0.5, segmentCount: 20, gapRate: 0,
      },
    });
    const insights = detectInsights(entry, null);
    const insta = insights.find((i) => i.id === 'production-instability');
    assert.ok(insta);
    assert.equal(insta!.severity, 'high');
  });

  it('failureRate 30% < 40% 阈值 → 不触发', () => {
    const entry = mkEntry({
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'yellow', failureRate: 0.3, segmentCount: 10, gapRate: 0,
      },
    });
    const insights = detectInsights(entry, null);
    assert.equal(insights.find((i) => i.id === 'production-instability'), undefined);
  });
});

describe('detectInsights — skill-too-long', () => {
  it('doctor skill_readable warn + observe 高 gap → medium', () => {
    const entry = mkEntry({
      doctor: {
        reportId: 'd1', timestamp: '2026-05-09T10:00:00Z', status: 'warn',
        passCount: 3, warnCount: 1, failCount: 0,
        results: [{
          ruleId: 'skill_readable', severity: 'warn', labelKey: 'x', status: 'warn',
          message: 'skill 18000 字超长', durationMs: 10,
        }],
      },
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'yellow', failureRate: 0.1, segmentCount: 18, gapRate: 0.35,
      },
    });
    const insights = detectInsights(entry, null);
    const tooLong = insights.find((i) => i.id === 'skill-too-long');
    assert.ok(tooLong);
    assert.equal(tooLong!.severity, 'medium');
  });

  it('doctor skill_readable pass → 不触发', () => {
    const entry = mkEntry({
      doctor: {
        reportId: 'd1', timestamp: '2026-05-09T10:00:00Z', status: 'pass',
        passCount: 4, warnCount: 0, failCount: 0,
        results: [{ ruleId: 'skill_readable', severity: 'warn', labelKey: 'x', status: 'pass', message: 'OK', durationMs: 10 }],
      },
    });
    const insights = detectInsights(entry, null);
    assert.equal(insights.find((i) => i.id === 'skill-too-long'), undefined);
  });
});

describe('detectInsights — coverage-gap', () => {
  it('observe gapRate > 0 + eval uncovered files → flagged + flagged', () => {
    const entry = mkEntry({
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'yellow', failureRate: 0.05, segmentCount: 10, gapRate: 0.25,
      },
    });
    const report = mkEvalReport('test-skill', [mkResult('s1', 'test-skill', { passedAssertions: true })]);
    report.analysis = {
      insights: [],
      coverage: {
        'test-skill': {
          entries: [],
          filesCovered: 1, filesTotal: 3, fileCoverageRate: 0.33,
          uncoveredFiles: ['a.md', 'b.md'],
          grepPatternsUsed: 0, overallRate: 0.33,
        },
      },
    } as EvaluationReport['analysis'];
    const insights = detectInsights(entry, report);
    const gap = insights.find((i) => i.id === 'coverage-gap');
    assert.ok(gap);
    assert.equal(gap!.severity, 'medium');
    assert.equal(gap!.evidence.filter((e) => e.status === 'flagged').length, 2);
  });

  it('observe gapRate=0 不触发', () => {
    const entry = mkEntry({
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'green', failureRate: 0, segmentCount: 10, gapRate: 0,
      },
    });
    const insights = detectInsights(entry, null);
    assert.equal(insights.find((i) => i.id === 'coverage-gap'), undefined);
  });
});

describe('flattenRecommendations', () => {
  it('去重 + 按 priority 排序', () => {
    const insights = [
      { id: 'a', category: 'other' as const, audience: 'skill-author' as const,
        title: 'x', severity: 'low' as const, affectedCount: 0, evidence: [],
        recommendations: [{ action: 'X', priority: 'low' as const }] },
      { id: 'b', category: 'other' as const, audience: 'skill-author' as const,
        title: 'y', severity: 'high' as const, affectedCount: 0, evidence: [],
        recommendations: [
          { action: 'X', priority: 'high' as const },  // 同名,优先级高的取代
          { action: 'Y', priority: 'medium' as const },
        ] },
    ];
    const flat = flattenRecommendations(insights);
    assert.equal(flat.length, 2);
    assert.equal(flat[0].action, 'X');
    assert.equal(flat[0].priority, 'high', '同名 action 取最高 priority');
    assert.equal(flat[1].action, 'Y');
  });
});
