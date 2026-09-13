import {
  CORE_STUDIO_RUN_CARD_SCHEMA_VERSION,
  CORE_STUDIO_RUN_DETAIL_SCHEMA_VERSION,
  type CoreStudioRunCard,
  type CoreStudioRunDetail,
} from '../../../src/studio/index.js';

/**
 * Evaluation Core 运行记录的 view-model 样板：`/api/reports` 的 JSON 投影与 `/measure` 的 React
 * 页面共用同一份事实，两条链断言的是同一批取值，不各写一份期望。digest 前缀可按需断言，不引入真实哈希。
 */
export const digest = (seed: string): string => `${seed}-${'a'.repeat(64)}`;

export const runtime = {
  implementationId: 'runtime-fixture',
  version: '1.2.3',
  fingerprint: digest('runtime'),
  fingerprintBasis: 'content-derived',
  assuranceLevel: 'verified',
} as const;

export const provenance = {
  provenanceKind: 'native',
  trust: 'verified',
  parentDigests: [] as string[],
} as const;

export function card(overrides: Partial<CoreStudioRunCard> = {}): CoreStudioRunCard {
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

export function detail(run: CoreStudioRunCard = card()): CoreStudioRunDetail {
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
            notApplicable: 0,
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
      ['run-plan', 'omk.run-plan/v5', 'plan'],
      ['execution-bundle', 'omk.execution-bundle/v1', 'execution'],
      ['evaluation-bundle', 'omk.evaluation-bundle/v1', 'evaluation'],
      ['analysis-bundle', 'omk.analysis-bundle/v2', 'analysis'],
      ['evaluation-report', 'omk.evaluation-report/v2', 'report'],
    ].map(([documentKind, schemaVersion, seed]) => ({
      documentKind: documentKind as CoreStudioRunDetail['lineage'][number]['documentKind'],
      schemaVersion,
      identityDigest: digest(`${seed}-identity`),
      documentDigest: digest(`${seed}-document`),
    })),
  };
}
