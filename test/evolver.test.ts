import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  mergeEvolveReports,
  singleVariantReport,
  type RoundReport,
} from '../src/authoring/evolver.js';
import { aggregateReport } from '../src/eval-core/evaluation-reporting.js';
import { parseReportDocument } from '../src/eval-core/report-document.js';
import { buildVariantResult, buildVariantSummary } from '../src/eval-core/schema.js';
import type {
  Artifact,
  EvaluationRequest,
  ExecResult,
  GradeResult,
  Report,
  Sample,
  Task,
  VariantResult,
} from '../src/types/index.js';

function makeVariantResult(score: number): VariantResult {
  const execution: ExecResult = {
    ok: true,
    output: 'done',
    durationMs: 1000,
    durationApiMs: 900,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    stopReason: 'end_turn',
    numTurns: 1,
  };
  const grade: GradeResult = {
    compositeScore: score,
    layeredScores: { factScore: score },
    assertions: {
      passed: 1,
      total: 1,
      score: 5,
      details: [{ type: 'contains', value: 'done', weight: 1, passed: true }],
    },
  };
  return buildVariantResult(execution, grade);
}

function makeReport(variantName: string, sampleScores: Record<string, number>, avgScore: number): Report {
  const resultEntries = Object.entries(sampleScores).map(([sampleId, score]) => ({
    sample_id: sampleId,
    variants: { [variantName]: makeVariantResult(score) },
  }));
  const summary = buildVariantSummary(
    resultEntries.map((entry) => entry.variants[variantName]),
  );
  assert.equal(summary.avgCompositeScore, avgScore);
  const report: Report = {
    kind: 'evaluation',
    id: `${variantName}-id`,
    meta: {
      variants: [variantName],
      model: 'sonnet',
      judgeModels: [{ executor: 'claude', model: 'sonnet' }],
      executor: 'claude',
      sampleCount: Object.keys(sampleScores).length,
      taskCount: Object.keys(sampleScores).length,
      totalCostUSD: 0,
      timestamp: '2026-04-08T12:00:00Z',
      cliVersion: '0.12.0',
      nodeVersion: 'v24.14.0',
      artifactHashes: { [variantName]: `hash-${variantName}` },
    },
    summary: { [variantName]: summary },
    results: resultEntries,
  };
  assert.ok(parseReportDocument(report, report.id, report.id));
  return report;
}

function makeCanonicalReport(
  variantName: string,
  artifactContent: string,
  score: number,
  runId: string,
): Report {
  const artifact: Artifact = {
    name: variantName,
    kind: 'skill',
    source: 'inline',
    content: artifactContent,
    contentHash: `hash-${variantName}`,
    experimentRole: 'treatment',
  };
  const samples: Sample[] = [
    { sample_id: 's001', prompt: 'first', assertions: [] },
    { sample_id: 's002', prompt: 'second', assertions: [] },
  ];
  const tasks: Task[] = samples.map((sample) => ({
    sample_id: sample.sample_id,
    variant: variantName,
    artifact,
    prompt: sample.prompt,
    rubric: null,
    assertions: sample.assertions ?? null,
    dimensions: null,
    artifactContent,
    cwd: null,
    _sample: sample,
  }));
  const results = Object.fromEntries(samples.map((sample) => [
    sample.sample_id,
    { [variantName]: makeVariantResult(score) },
  ]));
  const request: EvaluationRequest = {
    samplesPath: 'samples.json',
    skillDir: '.',
    artifacts: [artifact],
    model: 'test-model',
    executor: 'script',
    noJudge: true,
    concurrency: 1,
    noCache: false,
    dryRun: false,
    judgeModels: [{ executor: 'script', model: 'test-judge' }],
    strictBaseline: true,
  };
  const run = {
    runId,
    startedAt: '2026-07-27T00:00:01Z',
    finishedAt: '2026-07-27T00:00:02Z',
    status: 'succeeded' as const,
  };
  const report = aggregateReport({
    runId,
    variants: [variantName],
    model: request.model,
    judgeModel: request.judgeModels[0].model,
    noJudge: true,
    executorName: request.executor,
    samples,
    tasks,
    results,
    totalCostUSD: 0,
    artifacts: [artifact],
    request,
    run,
    job: {
      jobId: `job-${runId}`,
      status: 'succeeded',
      createdAt: '2026-07-27T00:00:00Z',
      updatedAt: '2026-07-27T00:00:02Z',
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      request: structuredClone(request),
      runId,
      resultReportId: runId,
    },
  });
  assert.ok(parseReportDocument(report, runId, runId));
  return report;
}

describe('mergeEvolveReports', () => {
  it('合并多轮报告为一份，各轮作为 variant', () => {
    const roundReports: RoundReport[] = [
      { round: 0, accepted: true, report: makeReport('skill-r0', { s001: 2.5, s002: 3.0 }, 2.75) },
      { round: 1, accepted: true, report: makeReport('skill-r1', { s001: 4.0, s002: 4.5 }, 4.25) },
      { round: 2, accepted: false, report: makeReport('skill-r2', { s001: 1.5, s002: 2.0 }, 1.75) },
    ];

    const merged = mergeEvolveReports(roundReports, 'test-skill', 1.5);

    // variant labels
    assert.deepEqual(merged.meta.variants, ['round-0', 'round-1', 'round-2']);

    // summary has all 3 variants
    assert.ok(merged.summary['round-0']);
    assert.ok(merged.summary['round-1']);
    assert.ok(merged.summary['round-2']);
    assert.equal(merged.summary['round-0'].avgCompositeScore, 2.75);
    assert.equal(merged.summary['round-1'].avgCompositeScore, 4.25);
    assert.equal(merged.summary['round-2'].avgCompositeScore, 1.75);

    // results: 2 samples, each with 3 variants
    assert.equal(merged.results.length, 2);
    const s001 = merged.results.find((r) => r.sample_id === 's001')!;
    assert.equal(s001.variants['round-0'].compositeScore, 2.5);
    assert.equal(s001.variants['round-1'].compositeScore, 4.0);
    assert.equal(s001.variants['round-2'].compositeScore, 1.5);

    // totalCostUSD
    assert.equal(merged.meta.totalCostUSD, 0);
    assert.equal(merged.meta.evolve?.processCostUSD, 1.5);

    // id = evolve-<skill>-YYYYMMDDTHHmmss-rand4(含日期,可追溯 / 可扫读)
    assert.match(merged.id, /^evolve-test-skill-\d{8}T\d{6}-[a-z0-9]{4}$/);
  });

  it('单轮（仅 baseline）也能正常生成报告', () => {
    const roundReports: RoundReport[] = [
      { round: 0, accepted: true, report: makeReport('skill', { s001: 3.0 }, 3.0) },
    ];

    const merged = mergeEvolveReports(roundReports, 'solo', 0.5);

    assert.deepEqual(merged.meta.variants, ['round-0']);
    assert.equal(merged.results.length, 1);
    assert.equal(merged.results[0].variants['round-0'].compositeScore, 3.0);
  });

  it('合并当前 schema 报告时重建 aggregate 元数据，不冒用源运行生命周期', () => {
    const roundReports: RoundReport[] = [
      {
        round: 0,
        accepted: true,
        report: makeCanonicalReport('skill-r0', '# v0', 3, 'source-round-0'),
      },
      {
        round: 1,
        accepted: true,
        report: makeCanonicalReport('skill-r1', '# v1', 4, 'source-round-1'),
      },
    ];

    const merged = mergeEvolveReports(roundReports, 'canonical', 0);
    assert.ok(parseReportDocument(merged, merged.id, merged.id));
    assert.equal(merged.meta.taskCount, 4);
    assert.equal(merged.meta.request, undefined);
    assert.equal(merged.meta.run, undefined);
    assert.equal(merged.meta.job, undefined);
    assert.deepEqual(Object.keys(merged.meta.executorRuntimes ?? {}), ['round-0', 'round-1']);
    assert.deepEqual(merged.meta.skillIsolation, {
      'round-0': null,
      'round-1': null,
    });
    assert.equal(merged.meta.variantConfigs?.[0].artifactKind, 'skill');
    assert.equal(merged.meta.variantConfigs?.[0].experimentRole, 'control');
    assert.notEqual(merged.meta.variantConfigs?.[0].executionStrategy, 'baseline');
    assert.deepEqual(
      merged.meta.evolve?.sourceReports?.map(({ round, reportId, variant }) => ({
        round,
        reportId,
        variant,
      })),
      [
        { round: 0, reportId: 'source-round-0', variant: 'skill-r0' },
        { round: 1, reportId: 'source-round-1', variant: 'skill-r1' },
      ],
    );

    const sliced = singleVariantReport(merged, 'round-1');
    assert.ok(parseReportDocument(sliced, sliced.id, sliced.id));
    assert.deepEqual(sliced.meta.variants, ['round-1']);
    assert.equal(sliced.meta.taskCount, 2);
    assert.deepEqual(Object.keys(sliced.meta.executorRuntimes ?? {}), ['round-1']);
    assert.equal(sliced.meta.evolve, undefined);
  });

  it('拒绝把 executor runtime 或执行策略变化误算成知识改进', () => {
    const baseline = makeCanonicalReport('skill-r0', '# v0', 3, 'runtime-round-0');
    const runtimeChanged = structuredClone(
      makeCanonicalReport('skill-r1', '# v1', 4, 'runtime-round-1'),
    );
    runtimeChanged.meta.executorRuntimes!['skill-r1'].fingerprint = 'different-runtime';
    runtimeChanged.meta.executorRuntime!.fingerprint = 'different-runtime';

    assert.throws(
      () => mergeEvolveReports([
        { round: 0, accepted: true, report: baseline },
        { round: 1, accepted: true, report: runtimeChanged },
      ], 'runtime-changed', 0),
      /测量配置或用例集合不可比/,
    );

    const strategyChanged = structuredClone(
      makeCanonicalReport('skill-r1', '# v1', 4, 'strategy-round-1'),
    );
    strategyChanged.meta.variantConfigs![0].executionStrategy = 'agent-session';
    assert.throws(
      () => mergeEvolveReports([
        { round: 0, accepted: true, report: baseline },
        { round: 1, accepted: true, report: strategyChanged },
      ], 'strategy-changed', 0),
      /测量配置或用例集合不可比/,
    );
  });
});
