import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  CORE_STUDIO_RUN_CARD_SCHEMA_VERSION,
  CORE_STUDIO_RUN_DETAIL_SCHEMA_VERSION,
  createCoreStudioRouteHandler,
  renderCoreRunDetail,
  renderCoreRunList,
  type CoreStudioCatalog,
  type CoreStudioRunCard,
  type CoreStudioRunDetail,
} from '../../src/index.js';

const digest = (seed: string): string => `${seed}-${'a'.repeat(64)}`;

const runtime = {
  implementationId: 'runtime-fixture',
  version: '1.2.3',
  fingerprint: digest('runtime'),
  fingerprintBasis: 'content-derived',
  assuranceLevel: 'verified',
} as const;

const provenance = {
  provenanceKind: 'native',
  trust: 'verified',
  parentDigests: [] as string[],
} as const;

function card(overrides: Partial<CoreStudioRunCard> = {}): CoreStudioRunCard {
  return {
    cardKind: 'studio-core-run-card',
    schemaVersion: CORE_STUDIO_RUN_CARD_SCHEMA_VERSION,
    runId: 'core-run-1',
    reportId: 'core-report-1',
    runContractDigest: digest('contract'),
    reportDigest: digest('report'),
    artifactSetDigest: digest('set'),
    createdAt: '2026-08-31T12:00:00.000Z',
    status: {
      runStatus: 'completed',
      evidenceStatus: 'complete',
      conclusionStatus: 'conclusive',
    },
    replayability: {
      execution: 'self-contained',
      evaluation: 'resolvable',
    },
    maximumCapturedClassification: 'sensitive',
    ...overrides,
  };
}

function detail(run: CoreStudioRunCard = card()): CoreStudioRunDetail {
  return {
    detailKind: 'studio-core-run-detail',
    schemaVersion: CORE_STUDIO_RUN_DETAIL_SCHEMA_VERSION,
    run,
    dataset: {
      datasetId: 'dataset-1',
      datasetRevisionDigest: digest('dataset'),
      sampleCount: 2,
    },
    targets: [{
      targetId: 'target-1',
      targetKind: 'prompt',
      protocolId: 'omk.invoke/v1',
      executorId: 'executor-1',
    }],
    evaluators: [{
      evaluatorId: 'evaluator-1',
      evaluatorKind: 'rubric',
      implementationId: 'judge-1',
      metricIds: ['quality'],
      measurement: {
        instrumentId: 'instrument-1',
        ensembleMemberId: 'member-1',
        replicateGroupId: 'replicate-1',
        replicateIndex: 0,
      },
    }],
    metrics: [{
      metricId: 'quality',
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 1, max: 5 },
      unit: 'score',
      direction: 'higher-is-better',
    }],
    stages: {
      execution: {
        bundleId: 'execution-1',
        bundleDigest: digest('execution'),
        stageStatus: 'completed',
        coverage: {
          planned: 2,
          started: 2,
          succeeded: 1,
          failed: 1,
          cancelled: 0,
          budgetCensored: 0,
          notStarted: 0,
        },
        replayability: 'self-contained',
        budget: {
          summaryStatus: 'within-budget',
          admissionMode: 'strict-reservation',
          invocations: 2,
          activeDurationMs: 1200,
          reportedProviderCosts: [{ amount: 0.012, currency: 'USD' }],
          unreportedProviderCostInvocations: 1,
          wallClock: { elapsedMs: 1300, limitMs: 5000, overshootMs: 0 },
          ledgerDigest: digest('execution-ledger'),
        },
        provenance,
        records: [{
          targetId: 'target-1',
          sampleId: 'sample-1',
          trialIndex: 0,
          trialId: 'trial-1',
          executionStatus: 'failed',
          runtime,
          provenance,
          cacheStatus: 'miss',
          durationMs: 800,
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          errorCode: 'executor-error',
        }],
      },
      evaluation: {
        bundleId: 'evaluation-1',
        bundleDigest: digest('evaluation'),
        parentExecutionBundleDigest: digest('execution'),
        stageStatus: 'completed',
        coverage: {
          planned: 2,
          eligible: 1,
          sourceUnavailable: 1,
          started: 1,
          completed: 1,
          failed: 0,
          cancelled: 0,
          notStarted: 0,
        },
        replayability: 'resolvable',
        budget: {
          summaryStatus: 'within-budget',
          admissionMode: 'bounded-overshoot',
          invocations: 1,
          activeDurationMs: 500,
          reportedProviderCosts: [],
          unreportedProviderCostInvocations: 0,
          wallClock: { elapsedMs: 550, overshootMs: 0 },
          ledgerDigest: digest('evaluation-ledger'),
        },
        provenance,
        records: [{
          targetId: 'target-1',
          sampleId: 'sample-1',
          trialIndex: 0,
          trialId: 'trial-1',
          evaluatorId: 'evaluator-1',
          measurement: {
            instrumentId: 'instrument-1',
            ensembleMemberId: 'member-1',
            replicateGroupId: 'replicate-1',
            replicateIndex: 0,
          },
          evaluationId: 'evaluation-record-1',
          evaluationStatus: 'completed',
          runtime,
          provenance,
          durationMs: 450,
          usage: { inputTokens: 7, outputTokens: 8, totalTokens: 15 },
          observations: [{
            observationId: digest('observation'),
            metricId: 'quality',
            observationStatus: 'observed',
            valueType: 'numeric',
            numericValue: 4.25,
          }],
        }],
      },
      analysis: {
        bundleId: 'analysis-1',
        bundleDigest: digest('analysis'),
        parentEvaluationBundleDigest: digest('evaluation'),
        stageStatus: 'completed',
        coverage: {
          planned: 1,
          started: 1,
          completed: 1,
          inconclusive: 0,
          failed: 0,
          notStarted: 0,
        },
        provenance,
        records: [{
          resultId: 'result-1',
          nodeId: 'mean-quality',
          analysisNodeKind: 'estimator',
          analysisStatus: 'completed',
          analysisMode: 'preregistered',
          runtime,
          outputSchema: {
            schemaVersion: 'omk.scalar/v1',
            schemaDigest: digest('schema'),
          },
          coverage: {
            planned: 2,
            observed: 1,
            missing: 0,
            invalid: 0,
            evaluationFailed: 0,
            sourceUnavailable: 1,
            notStarted: 0,
            censored: 0,
            included: 1,
            excluded: 1,
            comparable: 1,
          },
          exclusionCount: 1,
          assumptionChecks: [{ assumptionId: 'minimum-n', checkStatus: 'passed' }],
          recordDigest: digest('analysis-record'),
          resultType: 'scalar',
          numericValue: 4.25,
        }],
      },
    },
    decision: {
      decisionPolicyId: 'progress-policy',
      decisionStatus: 'decided',
      implementation: runtime,
      analysisResultIds: ['result-1'],
      decisionDigest: digest('decision'),
      verdict: 'PROGRESS',
      reasonCodes: ['threshold-satisfied'],
    },
    reportProvenance: provenance,
    lineage: [
      ['run-plan', 'omk.run-plan/v1', 'plan'],
      ['execution-bundle', 'omk.execution-bundle/v1', 'execution'],
      ['evaluation-bundle', 'omk.evaluation-bundle/v1', 'evaluation'],
      ['analysis-bundle', 'omk.analysis-bundle/v1', 'analysis'],
      ['evaluation-report', 'omk.evaluation-report/v1', 'report'],
    ].map(([documentKind, schemaVersion, seed]) => ({
      documentKind: documentKind as CoreStudioRunDetail['lineage'][number]['documentKind'],
      schemaVersion,
      identityDigest: digest(`${seed}-identity`),
      documentDigest: digest(`${seed}-document`),
    })),
  };
}

const routes = {
  listPath: '/measurements',
  detailPath: (runId: string): string => `/measurements/${encodeURIComponent(runId)}`,
};

describe('Core run renderer', () => {
  it('renders every orthogonal status axis without synthesizing a quality verdict', () => {
    const cards = [
      card(),
      card({ runId: 'cancelled', status: { runStatus: 'cancelled', evidenceStatus: 'partial', conclusionStatus: 'inconclusive' } }),
      card({ runId: 'exhausted', status: { runStatus: 'budget-exhausted', evidenceStatus: 'unresolvable', conclusionStatus: 'not-evaluated' } }),
      card({ runId: 'failed', status: { runStatus: 'failed', evidenceStatus: 'complete', conclusionStatus: 'conclusive' } }),
    ];
    const html = renderCoreRunList(cards, routes, 'zh');

    for (const value of ['completed', 'cancelled', 'budget-exhausted', 'failed', 'complete', 'partial', 'unresolvable', 'conclusive', 'inconclusive', 'not-evaluated']) {
      assert.ok(html.includes(value), `missing status: ${value}`);
    }
    assert.ok(html.includes('运行状态'));
    assert.ok(html.includes('证据状态'));
    assert.ok(html.includes('结论状态'));
    assert.ok(!html.includes('综合状态'));
    assert.ok(html.includes('href="/measurements/core-run-1"'));
    assert.ok(!html.includes('localhost'));
    assert.ok(!html.includes('127.0.0.1'));
    assert.ok(!html.includes(':7799'));
  });

  it('renders plan, lineage, budgets, coverage, records, observations, analysis, and decision accessibly', () => {
    const html = renderCoreRunDetail(detail(), routes, 'en');

    for (const value of [
      'Measurement plan',
      'Artifact lineage',
      'strict-reservation',
      'overshoot=0ms',
      'ledger=execution-ledger-',
      'sourceUnavailable=1',
      'executor-error',
      'quality:observed=4.25',
      'mean-quality',
      'PROGRESS',
      'threshold-satisfied',
      'total 15',
    ]) {
      assert.ok(html.includes(value), `missing detail: ${value}`);
    }
    assert.ok(html.includes('<main>'));
    assert.ok(html.includes('<nav class="nav">'));
    assert.ok(html.includes('<th scope=') || html.includes('<th>'));
    assert.ok(html.includes('href="/measurements?lang=en"'));
  });

  it('escapes projected values and ignores fields outside the privacy allow-list', () => {
    const sensitive = 'TOP-SECRET-RAW-CONTENT';
    const maliciousCard = card({ runId: '<script>alert(1)</script>' });
    const base = detail(maliciousCard);
    const unsafe = {
      ...base,
      rawInput: sensitive,
      stages: {
        ...base.stages,
        execution: {
          ...base.stages.execution,
          records: base.stages.execution.records.map((record) => ({ ...record, rawOutput: sensitive })),
        },
        analysis: {
          ...base.stages.analysis,
          records: base.stages.analysis.records.map((record) => ({ ...record, arbitraryTable: sensitive })),
        },
      },
    } as unknown as CoreStudioRunDetail;
    const html = renderCoreRunDetail(unsafe, routes);
    const listHtml = renderCoreRunList([maliciousCard], routes);

    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes(sensitive));
    assert.ok(!listHtml.includes('<script>alert(1)</script>'));
    assert.ok(listHtml.includes('/measurements/%3Cscript%3Ealert(1)%3C%2Fscript%3E'));
  });
});

describe('Core Studio route handler', () => {
  function catalog(source: CoreStudioRunDetail = detail()): CoreStudioCatalog {
    return {
      async list() { return [source.run]; },
      async get(runId) { return runId === source.run.runId ? source : undefined; },
      async inspect(runId) { return runId === source.run.runId ? source.run : undefined; },
    };
  }

  it('serves HTML and JSON list/detail routes from the catalog port', async () => {
    const handler = createCoreStudioRouteHandler({
      catalog: catalog(),
      htmlBasePath: '/core-runs',
      apiBasePath: '/api/core-runs',
    });

    const list = await handler({ method: 'GET', url: '/core-runs?lang=en' });
    assert.equal(list?.status, 200);
    assert.ok(Object.isFrozen(list));
    assert.ok(Object.isFrozen(list?.headers));
    assert.equal(list?.headers['Content-Type'], 'text/html; charset=utf-8');
    assert.ok(list?.body.includes('Evaluation Core Runs'));

    const detailResponse = await handler({ method: 'GET', url: '/core-runs/core-run-1' });
    assert.equal(detailResponse?.status, 200);
    assert.ok(detailResponse?.body.includes('progress-policy'));

    const apiList = await handler({ method: 'GET', url: '/api/core-runs' });
    assert.deepEqual(JSON.parse(apiList?.body ?? ''), [card()]);
    const apiDetail = await handler({ method: 'GET', url: '/api/core-runs/core-run-1' });
    assert.deepEqual(JSON.parse(apiDetail?.body ?? ''), detail());
  });

  it('returns stable 404/405 responses and leaves unrelated routes untouched', async () => {
    const handler = createCoreStudioRouteHandler({
      catalog: catalog(),
      htmlBasePath: '/core-runs',
      apiBasePath: '/api/core-runs',
    });

    assert.equal(await handler({ method: 'GET', url: '/unrelated' }), undefined);
    assert.equal((await handler({ method: 'GET', url: '/core-runs/missing' }))?.status, 404);
    assert.equal((await handler({ method: 'GET', url: '/api/core-runs/%ZZ' }))?.status, 404);
    assert.equal((await handler({ method: 'GET', url: '/core-runs/a/b' }))?.status, 404);
    const method = await handler({ method: 'POST', url: '/api/core-runs' });
    assert.equal(method?.status, 405);
    assert.equal(method?.headers.Allow, 'GET');
    const htmlMethod = await handler({ method: 'POST', url: '/core-runs?lang=en' });
    assert.equal(htmlMethod?.status, 405);
    assert.ok(htmlMethod?.body.includes('Only GET requests are supported.'));
  });

  it('round-trips encoded run identifiers as a single route segment', async () => {
    const encoded = detail(card({ runId: 'group/run?1' }));
    const handler = createCoreStudioRouteHandler({
      catalog: catalog(encoded),
      htmlBasePath: '/core-runs',
      apiBasePath: '/api/core-runs',
    });

    const list = await handler({ url: '/core-runs' });
    assert.ok(list?.body.includes('/core-runs/group%2Frun%3F1'));
    assert.equal((await handler({ url: '/core-runs/group%2Frun%3F1' }))?.status, 200);
    assert.equal((await handler({ url: '/api/core-runs/group%2Frun%3F1' }))?.status, 200);
  });

  it('redacts source failures from both HTML and JSON responses', async () => {
    const unavailable: CoreStudioCatalog = {
      async list() { throw new Error('TOP-SECRET-FILESYSTEM-PATH'); },
      async get() { throw new Error('TOP-SECRET-FILESYSTEM-PATH'); },
      async inspect() { throw new Error('TOP-SECRET-FILESYSTEM-PATH'); },
    };
    const handler = createCoreStudioRouteHandler({
      catalog: unavailable,
      htmlBasePath: '/core-runs',
      apiBasePath: '/api/core-runs',
    });

    const htmlResponse = await handler({ url: '/core-runs' });
    assert.equal(htmlResponse?.status, 503);
    assert.ok(htmlResponse?.body.includes('Core 产物当前不可读取'));
    assert.ok(!htmlResponse?.body.includes('TOP-SECRET'));
    const jsonResponse = await handler({ url: '/api/core-runs/core-run-1' });
    assert.deepEqual(JSON.parse(jsonResponse?.body ?? ''), { error: 'core_studio_source_unavailable' });
    assert.ok(!jsonResponse?.body.includes('TOP-SECRET'));
  });

  it('rejects ambiguous base paths at construction time', () => {
    assert.throws(() => createCoreStudioRouteHandler({
      catalog: catalog(),
      htmlBasePath: '/',
      apiBasePath: '/api/core-runs',
    }), /htmlBasePath/u);
    assert.throws(() => createCoreStudioRouteHandler({
      catalog: catalog(),
      htmlBasePath: '/core-runs/',
      apiBasePath: '/api/core-runs',
    }), /htmlBasePath/u);
    assert.throws(() => createCoreStudioRouteHandler({
      catalog: catalog(),
      htmlBasePath: '/core-runs',
      apiBasePath: '/core-runs/api',
    }), /must not overlap/u);
  });
});
