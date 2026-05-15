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
import type { Diagnosis } from '../../src/diagnosis/types.js';

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

describe('detectInsights — environment-blocked-mocks (sample-author)', () => {
  it('两条 sample 共享 环境拦截 failureMode → medium severity + sample-author audience', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { failureModes: ['环境拦截'] }),
      mkResult('s2', 'test-skill', { failureModes: ['环境拦截'] }),
    ]);
    const insights = detectInsights(mkEntry(), report);
    const blocked = insights.find((i) => i.id === 'environment-blocked-mocks');
    assert.ok(blocked, 'should detect environment-blocked-mocks insight');
    assert.equal(blocked!.affectedCount, 2);
    assert.equal(blocked!.severity, 'medium');
    assert.equal(blocked!.audience, 'sample-author', '应归 sample-author 不是 skill-author');
    assert.deepEqual(blocked!.stageRefs?.evalSampleIds, ['s1', 's2']);
  });

  it('三条以上 → high severity', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { failureModes: ['环境拦截'] }),
      mkResult('s2', 'test-skill', { failureModes: ['环境拦截'] }),
      mkResult('s3', 'test-skill', { failureModes: ['环境拦截'] }),
    ]);
    const insights = detectInsights(mkEntry(), report);
    const blocked = insights.find((i) => i.id === 'environment-blocked-mocks');
    assert.ok(blocked);
    assert.equal(blocked!.severity, 'high');
  });

  it('单条 sample 不触发(cluster 阈值 < 2 return null)', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { failureModes: ['环境拦截'] }),
    ]);
    const insights = detectInsights(mkEntry(), report);
    assert.equal(insights.find((i) => i.id === 'environment-blocked-mocks'), undefined);
  });

  it('环境拦截 + 其它 failureMode 混合,只统计 环境拦截 那部分', () => {
    const report = mkEvalReport('test-skill', [
      mkResult('s1', 'test-skill', { failureModes: ['环境拦截'] }),
      mkResult('s2', 'test-skill', { failureModes: ['环境拦截', '工具误用'] }),
      mkResult('s3', 'test-skill', { failureModes: ['工作流跳步'] }), // 不算
    ]);
    const insights = detectInsights(mkEntry(), report);
    const blocked = insights.find((i) => i.id === 'environment-blocked-mocks');
    assert.ok(blocked);
    assert.equal(blocked!.affectedCount, 2);
    assert.deepEqual(blocked!.stageRefs?.evalSampleIds, ['s1', 's2']);
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

describe('detectInsights — Diagnosis projection', () => {
  function mkDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
    return {
      id: 'diag-1',
      stableKey: 'skill:test-skill|type:runtime_issue|signal:tool_failure_seen|target:x',
      skillName: 'test-skill',
      type: 'runtime_issue',
      signal: 'tool_failure_seen',
      title: 'Tool failure seen',
      summary: '工具失败在真实 session 中重复出现。',
      severity: 'high',
      audience: 'skill-author',
      lifecycle: 'detected',
      scope: { primary: 'skill', refs: { skillName: 'test-skill' } },
      occurrences: [{
        id: 'occ-1',
        diagnosisStableKey: 'skill:test-skill|type:runtime_issue|signal:tool_failure_seen|target:x',
        source: 'observe',
        sourceId: 'rule_finding:test-skill:tool_failure_seen',
        sourceKind: 'tool_failure_seen',
        timestamp: '2026-05-09T10:00:00Z',
        severity: 'high',
        evidenceRefs: [],
        producer: 'deterministic_rule',
      }],
      occurrenceCount: 1,
      recommendation: '补充工具失败时的重试和失败告知流程。',
      ...overrides,
    };
  }

  it('传入 Diagnosis 后,observe 类 Insight 从 Diagnosis 投影', () => {
    const entry = mkEntry({
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'green', failureRate: 0, segmentCount: 10, gapRate: 0,
      },
    });
    const insights = detectInsights(entry, null, { diagnostics: [mkDiagnosis()] });
    const projected = insights.find((i) => i.id === 'diagnosis:diag-1');
    assert.ok(projected);
    assert.equal(projected!.category, 'production-instability');
    assert.equal(projected!.evidence[0].perspective, 'observe');
    assert.equal(projected!.severity, 'high');
  });

  it('diagnostics 为空数组时,legacy observe-side 检测仍然触发（dual-run 兼容）', () => {
    // observe 有 red + failureRate 0.5 但 mapper 没产出对应 Diagnosis 的场景:
    // 该 skill 的 diagnosticsBundle.bySkill[name] 默认是 [] 不是 undefined,
    // 这条 case 防止以前那种「[] 也判 truthy 把 legacy 全关掉」的回归。
    const entry = mkEntry({
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'red', failureRate: 0.5, segmentCount: 20, gapRate: 0,
      },
    });
    const insights = detectInsights(entry, null, { diagnostics: [] });
    assert.ok(
      insights.find((i) => i.id === 'production-instability'),
      'legacy production-instability 应在空 diagnostics 下仍然触发',
    );
  });

  it('dual-run 期间 legacy + Diagnosis 即便概念相近也共存,不基于 category 去重', () => {
    // 这条 Diagnosis 投影后 category 是 production-instability,看起来跟 legacy detector
    // 同名,但二者读不同数据源 —— Diagnosis 来自 inbox 的 runtime/tool_failure_seen
    // 单点告警,legacy 来自 SkillHealthReport 的 failureRate >= 0.4 聚合指标,不等价。
    //
    // dual-run 期间不能用 InsightCategory 去重,否则 `runtime_workflow_review` 这类
    // 投影出 production-instability 的 Diagnosis 会误关掉 SkillHealthReport 高失败率信号。
    // 等 doctor / eval producer 都迁完 Diagnosis,再单独 PR 基于 stable target 精确去重。
    const entry = mkEntry({
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'red', failureRate: 0.5, segmentCount: 20, gapRate: 0,
      },
    });
    const insights = detectInsights(entry, null, { diagnostics: [mkDiagnosis()] });
    assert.ok(
      insights.find((i) => i.id === 'production-instability'),
      'legacy production-instability(SkillHealthReport 聚合)应仍触发',
    );
    assert.ok(
      insights.find((i) => i.id === 'diagnosis:diag-1'),
      'Diagnosis 投影(inbox 单点告警)也应共存',
    );
  });

  it('definition_gap Diagnosis 不会吞掉 legacy detectSkillDocGap 的 eval / doctor 证据', () => {
    // legacy detectSkillDocGap 会基于 eval rootCause 跟 doctor dependency rule 出 insight。
    // 早先按 category 去重的实现会让 `skill_md_not_found` definition_gap Diagnosis 把整个
    // legacy detector 关掉(它们都映射到 skill-doc-gap),导致 doctor + eval 那部分证据消失。
    // 现在 dual-run 共存。
    const docGapDiagnosis = mkDiagnosis({
      id: 'diag-doc',
      type: 'definition_gap',
      signal: 'skill_md_not_found',
      title: 'SKILL.md was not found',
      stableKey: 'skill:test-skill|type:definition_gap|signal:skill_md_not_found|target:definition:skill_md',
    });
    const entry = mkEntry({
      observe: {
        analysisId: 'a1', generatedAt: '2026-05-09T10:00:00Z',
        healthBand: 'red', failureRate: 0.5, segmentCount: 20, gapRate: 0,
      },
    });
    const insights = detectInsights(entry, null, { diagnostics: [docGapDiagnosis] });
    assert.ok(
      insights.find((i) => i.id === 'production-instability'),
      'legacy production-instability 应该仍触发(不同 category 也不去重,跟同 category dual-run 一致)',
    );
    assert.ok(insights.find((i) => i.id === 'diagnosis:diag-doc'));
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
