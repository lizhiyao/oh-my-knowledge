import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildVariantResult, buildVariantSummary } from '../../src/eval-core/schema.js';
import { parseReportDocument } from '../../src/eval-core/report-document.js';
import type { ExecResult, GradeResult } from '../../src/types/index.js';

function validExecutorResult(): ExecResult {
  const toolCall = {
    tool: 'github.fetch_file',
    sourceTool: 'mcp__github__fetch_file',
    toolNamespace: 'mcp__github',
    toolProvider: 'github',
    input: { path: 'README.md' },
    output: '# omk',
    status: 'success' as const,
    statusSource: 'runtime' as const,
    success: true,
    callInstanceId: 'call:1',
    toolUseId: 'call-1',
  };
  return {
    ok: true,
    output: 'done',
    durationMs: 10,
    durationApiMs: 8,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    stopReason: 'end_turn',
    numTurns: 1,
    turns: [{
      role: 'assistant',
      content: 'done',
      toolCalls: [toolCall],
    }],
    toolCalls: [toolCall],
    mockStats: {
      hits: 1,
      misses: 0,
      perMock: { github: 1 },
    },
  };
}

function validReport(): Record<string, unknown> {
  const result = buildVariantResult(validExecutorResult(), null);
  return {
    kind: 'evaluation',
    id: 'trace-contract',
    meta: {
      timestamp: '2026-07-27T00:00:00.000Z',
      variants: ['candidate'],
      artifactHashes: { candidate: 'hash' },
      model: 'test-model',
      executor: 'script',
      sampleCount: 1,
      taskCount: 1,
      totalCostUSD: 0,
      cliVersion: 'test',
      nodeVersion: process.version,
      judgeModels: [{ executor: 'script', model: 'test-judge' }],
    },
    summary: {
      candidate: buildVariantSummary([result]),
    },
    results: [{
      sample_id: 'sample-1',
      variants: { candidate: result },
    }],
  };
}

function candidate(report: Record<string, unknown>): Record<string, unknown> {
  return (
    (report.results as Array<{ variants: { candidate: Record<string, unknown> } }>)[0]
      .variants.candidate
  );
}

function candidateSummary(report: Record<string, unknown>): Record<string, unknown> {
  return (report.summary as { candidate: Record<string, unknown> }).candidate;
}

function runtime(executor: string, model: string): Record<string, unknown> {
  return {
    executor,
    model,
    runtimeKind: 'script',
    fingerprint: `${executor}:${model}`,
    capabilities: {
      systemPrompt: 'none',
      costUSD: 'unknown',
      trace: 'none',
      skillIsolation: 'none',
    },
  };
}

function currentAuditedReport(): Record<string, unknown> {
  const report = validReport();
  const meta = report.meta as Record<string, unknown>;
  const request = {
    samplesPath: 'eval-samples.json',
    skillDir: 'skills',
    artifacts: [{
      name: 'candidate',
      kind: 'skill',
      source: 'file-path',
      content: '# candidate',
    }],
    model: 'test-model',
    executor: 'script',
    noJudge: false,
    concurrency: 1,
    noCache: false,
    dryRun: false,
    judgeModels: [{ executor: 'script', model: 'test-judge' }],
    strictBaseline: true,
  };
  meta.schemaVersion = 4;
  meta.timestamp = '2026-07-27T00:00:03Z';
  meta.executorRuntime = runtime('script', 'test-model');
  meta.executorRuntimes = {
    candidate: runtime('script', 'test-model'),
  };
  meta.judgeModels = [{
    executor: 'script',
    model: 'test-judge',
    runtime: runtime('script', 'test-judge'),
  }];
  meta.request = request;
  meta.run = {
    runId: 'trace-contract',
    startedAt: '2026-07-27T00:00:01Z',
    finishedAt: '2026-07-27T00:00:02Z',
    status: 'succeeded',
  };
  meta.job = {
    jobId: 'job-trace-contract',
    status: 'succeeded',
    createdAt: '2026-07-27T00:00:00Z',
    updatedAt: '2026-07-27T00:00:02Z',
    startedAt: '2026-07-27T00:00:01Z',
    finishedAt: '2026-07-27T00:00:02Z',
    request: structuredClone(request),
    runId: 'trace-contract',
    resultReportId: 'trace-contract',
  };
  return report;
}

describe('persisted report trace contract', () => {
  it('accepts a source-neutral trace with auditable provider identity', () => {
    const report = validReport();
    assert.ok(parseReportDocument(report, 'trace-contract', 'trace-contract'));
  });

  it('accepts production assertion scores on the 1–5 scale', () => {
    const report = validReport();
    const grade: GradeResult = {
      compositeScore: 5,
      layeredScores: { factScore: 5 },
      assertions: {
        passed: 1,
        total: 1,
        score: 5,
        details: [{ type: 'contains', value: 'done', weight: 1, passed: true }],
      },
    };
    const result = buildVariantResult(validExecutorResult(), grade);
    (report.results as Array<{ variants: { candidate: unknown } }>)[0].variants.candidate = result;
    (report.summary as { candidate: unknown }).candidate = buildVariantSummary([result]);

    assert.ok(parseReportDocument(report, 'trace-contract', 'trace-contract'));
  });

  it('rejects malformed nested trace and mock records', () => {
    const malformedTool = structuredClone(validReport());
    (candidate(malformedTool).toolCalls as Array<Record<string, unknown>>)[0].sourceTool = 42;
    assert.equal(parseReportDocument(malformedTool, 'trace-contract'), null);

    const malformedTurn = structuredClone(validReport());
    (candidate(malformedTurn).turns as Array<Record<string, unknown>>)[0].role = 'runtime';
    assert.equal(parseReportDocument(malformedTurn, 'trace-contract'), null);

    const malformedMocks = structuredClone(validReport());
    (candidate(malformedMocks).mockStats as Record<string, unknown>).hits = 2;
    assert.equal(parseReportDocument(malformedMocks, 'trace-contract'), null);
  });

  it('rejects aggregate tool facts that disagree with the persisted calls', () => {
    for (const mutate of [
      (result: Record<string, unknown>) => { result.numToolCalls = 2; },
      (result: Record<string, unknown>) => { result.numToolFailures = 1; },
      (result: Record<string, unknown>) => { result.toolSuccessRate = 0; },
      (result: Record<string, unknown>) => { result.toolNames = ['Bash']; },
      (result: Record<string, unknown>) => {
        result.toolDistribution = { 'github.fetch_file': 2 };
      },
    ]) {
      const report = structuredClone(validReport());
      mutate(candidate(report));
      assert.equal(parseReportDocument(report, 'trace-contract'), null);
    }
  });

  it('keeps legacy reports readable when newer aggregate fields are absent', () => {
    const report = validReport();
    const result = candidate(report);
    delete result.numToolCancelled;
    delete result.numToolUnknown;
    delete result.toolDistribution;
    assert.ok(parseReportDocument(report, 'trace-contract'));
  });

  it('rejects malformed optional summary statistics', () => {
    for (const mutate of [
      (summary: Record<string, unknown>) => { summary.toolSuccessRate = 2; },
      (summary: Record<string, unknown>) => {
        summary.toolDistribution = {
          Read: Number.MAX_SAFE_INTEGER,
          Bash: Number.MAX_SAFE_INTEGER,
        };
      },
      (summary: Record<string, unknown>) => { summary.avgCompositeScore = '5'; },
      (summary: Record<string, unknown>) => {
        summary.minCompositeScore = 4;
        summary.avgCompositeScore = 3;
        summary.maxCompositeScore = 5;
      },
      (summary: Record<string, unknown>) => {
        summary.bootstrapCI = { low: 4, estimate: 3, high: 5, samples: 100 };
      },
      (summary: Record<string, unknown>) => {
        summary.judgeAgreement = {
          pearson: 2,
          meanAbsDiff: 0.5,
          pairCount: 1,
          sampleCount: 2,
        };
      },
    ]) {
      const report = structuredClone(validReport());
      mutate(candidateSummary(report));
      assert.equal(parseReportDocument(report, 'trace-contract'), null);
    }
  });

  it('rejects malformed optional sample grading fields', () => {
    for (const mutate of [
      (result: Record<string, unknown>) => { result.compositeScore = 6; },
      (result: Record<string, unknown>) => {
        result.layeredScores = { factScore: Number.POSITIVE_INFINITY };
      },
      (result: Record<string, unknown>) => {
        result.assertions = {
          passed: 2,
          total: 1,
          score: 2,
          details: [],
        };
      },
      (result: Record<string, unknown>) => {
        result.llmScoreSamples = [5, Number.NaN];
      },
      (result: Record<string, unknown>) => {
        result.dimensions = {
          correctness: { score: '5', reason: 'ok' },
        };
      },
      (result: Record<string, unknown>) => {
        result.factCheck = {
          verifiedCount: 1,
          totalCount: 1,
          verifiedRate: 0,
          claims: [{ type: 'url', value: 'x', verified: true }],
        };
      },
      (result: Record<string, unknown>) => {
        result.diagnostic = {
          summary: 'x',
          expected: 'x',
          actual: 'x',
          rootCause: ['not-a-root-cause'],
          suggestion: { skill: '', sample: '', none: '' },
          ok: true,
        };
      },
      (result: Record<string, unknown>) => { result.fullOutput = 42; },
    ]) {
      const report = structuredClone(validReport());
      mutate(candidate(report));
      assert.equal(parseReportDocument(report, 'trace-contract'), null);
    }
  });

  it('rejects malformed optional snapshots, analysis and variance', () => {
    const badSnapshots = validReport();
    badSnapshots.sampleSnapshots = {
      wrong: { sample_id: 'wrong', prompt: 'x' },
    };
    assert.equal(parseReportDocument(badSnapshots, 'trace-contract'), null);

    const badSourceRefs = validReport();
    badSourceRefs.sampleSnapshots = {
      'sample-1': {
        sample_id: 'sample-1',
        prompt: 'x',
        sourceRefs: [{ sourceType: 'knowledge_gap', sourceId: '' }],
      },
    };
    assert.equal(parseReportDocument(badSourceRefs, 'trace-contract'), null);

    const badAnalysis = validReport();
    badAnalysis.analysis = {
      insights: [{ type: 'x', severity: 'critical', details: {} }],
    };
    assert.equal(parseReportDocument(badAnalysis, 'trace-contract'), null);

    const badVariance = validReport();
    badVariance.variance = {
      runs: 2,
      perVariant: {
        candidate: {
          scores: [3, 4],
          mean: 5,
          lower: 3,
          upper: 5,
          stddev: 0.7071,
        },
      },
      comparisons: [],
    };
    assert.equal(parseReportDocument(badVariance, 'trace-contract'), null);
  });

  it('accepts a current report with complete construct-validity metadata', () => {
    const report = validReport();
    const meta = report.meta as Record<string, unknown>;
    meta.schemaVersion = 4;
    meta.executorRuntime = runtime('script', 'test-model');
    meta.executorRuntimes = {
      candidate: runtime('script', 'test-model'),
    };
    meta.judgeModels = [{
      executor: 'script',
      model: 'test-judge',
      runtime: runtime('script', 'test-judge'),
    }];
    meta.skillIsolation = { candidate: null };
    assert.ok(parseReportDocument(report, 'trace-contract'));
  });

  it('schema v5 requires one valid complete-contract hash per result sample', () => {
    const report = currentAuditedReport();
    const meta = report.meta as Record<string, unknown>;
    meta.schemaVersion = 5;
    meta.sampleHashes = { 'sample-1': '0123456789ab' };
    assert.ok(parseReportDocument(report, 'trace-contract'));

    for (const sampleHashes of [
      undefined,
      {},
      { 'sample-1': 'not-a-hash' },
      { 'sample-1': '0123456789ab', extra: 'abcdef012345' },
    ]) {
      const invalid = structuredClone(report);
      if (sampleHashes === undefined) {
        delete (invalid.meta as Record<string, unknown>).sampleHashes;
      } else {
        (invalid.meta as Record<string, unknown>).sampleHashes = sampleHashes;
      }
      assert.equal(parseReportDocument(invalid, 'trace-contract'), null);
    }
  });

  it('rejects retry and budget metadata that contradict the persisted request', () => {
    const withRetry = currentAuditedReport();
    const retryMeta = withRetry.meta as Record<string, unknown>;
    const retryRequest = retryMeta.request as Record<string, unknown>;
    retryRequest.retry = 1;
    ((retryMeta.job as Record<string, unknown>).request as Record<string, unknown>).retry = 1;
    candidate(withRetry).attemptCount = 2;
    assert.ok(parseReportDocument(withRetry, 'trace-contract'));
    candidate(withRetry).attemptCount = 3;
    assert.equal(parseReportDocument(withRetry, 'trace-contract'), null);

    const withBudget = currentAuditedReport();
    const budgetMeta = withBudget.meta as Record<string, unknown>;
    const budget = { totalUSD: 1, perSampleUSD: 0.2 };
    budgetMeta.budget = budget;
    (budgetMeta.request as Record<string, unknown>).budget = structuredClone(budget);
    ((budgetMeta.job as Record<string, unknown>).request as Record<string, unknown>).budget = structuredClone(budget);
    assert.ok(parseReportDocument(withBudget, 'trace-contract'));
    (budgetMeta.budget as Record<string, unknown>).totalUSD = 2;
    assert.equal(parseReportDocument(withBudget, 'trace-contract'), null);

    const impossibleExhaustion = currentAuditedReport();
    (impossibleExhaustion.meta as Record<string, unknown>).budgetExhausted = true;
    assert.equal(parseReportDocument(impossibleExhaustion, 'trace-contract'), null);
  });

  it('accepts one coherent persisted request/run/job audit chain', () => {
    const report = currentAuditedReport();
    assert.ok(parseReportDocument(report, 'trace-contract', 'trace-contract'));
  });

  it('rejects a report when any persisted audit identity or timeline diverges', () => {
    for (const mutate of [
      (meta: Record<string, unknown>) => {
        (meta.request as Record<string, unknown>).model = 'other-model';
      },
      (meta: Record<string, unknown>) => {
        (meta.run as Record<string, unknown>).runId = 'other-run';
      },
      (meta: Record<string, unknown>) => {
        (meta.job as Record<string, unknown>).resultReportId = 'other-report';
      },
      (meta: Record<string, unknown>) => {
        const job = meta.job as Record<string, unknown>;
        (job.request as Record<string, unknown>).strictBaseline = false;
      },
      (meta: Record<string, unknown>) => {
        meta.timestamp = '2026-07-27T00:00:01Z';
      },
    ]) {
      const report = currentAuditedReport();
      mutate(report.meta as Record<string, unknown>);
      assert.equal(parseReportDocument(report, 'trace-contract'), null);
    }
  });

  it('rejects contradictory construct-validity metadata', () => {
    for (const mutate of [
      (meta: Record<string, unknown>) => {
        meta.schemaVersion = 4;
        meta.judgeModels = [{ executor: 'script', model: 'test-judge' }];
      },
      (meta: Record<string, unknown>) => {
        meta.executorRuntimes = {};
      },
      (meta: Record<string, unknown>) => {
        meta.executorRuntime = runtime('other-executor', 'test-model');
      },
      (meta: Record<string, unknown>) => {
        meta.schemaVersion = 4;
        meta.judgeModels = [{
          executor: 'script',
          model: 'test-judge',
          runtime: runtime('script', 'other-judge'),
        }];
      },
      (meta: Record<string, unknown>) => {
        meta.pairComparisons = [{
          control: 'candidate',
          treatment: 'missing',
          diffBootstrapCI: {
            low: 1,
            estimate: 2,
            high: 3,
            samples: 100,
            significant: false,
          },
        }];
      },
      (meta: Record<string, unknown>) => {
        meta.debiasMode = ['length', 'length'];
      },
      (meta: Record<string, unknown>) => {
        meta.budget = { totalUSD: Number.POSITIVE_INFINITY };
      },
      (meta: Record<string, unknown>) => {
        meta.skillIsolation = {};
      },
      (meta: Record<string, unknown>) => {
        meta.skillIsolation = { candidate: null };
        meta.variantConfigs = [{
          variant: 'candidate',
          artifactKind: 'skill',
          artifactSource: 'file-path',
          executionStrategy: 'system-prompt',
          experimentType: 'artifact-injection',
          experimentRole: 'treatment',
          hasArtifactContent: true,
          cwd: null,
          allowedSkills: [],
        }];
      },
      (meta: Record<string, unknown>) => {
        meta.humanAgreement = {
          alpha: 0.5,
          alphaCI: { low: 0.4, estimate: 0.6, high: 0.7, samples: 100 },
          weightedKappa: 0.5,
          pearson: 0.5,
          sampleCount: 10,
          variant: 'candidate',
          goldAnnotator: 'team',
          goldVersion: 'v1',
          missingCount: 0,
          unscoredCount: 0,
        };
      },
    ]) {
      const report = structuredClone(validReport());
      mutate(report.meta as Record<string, unknown>);
      assert.equal(parseReportDocument(report, 'trace-contract'), null);
    }
  });
});
