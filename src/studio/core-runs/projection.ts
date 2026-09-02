import {
  deepFreezeCanonicalJson,
  type BudgetSummary,
  type EvaluationRecord,
  type ExecutionRecord,
  type JsonValue,
  type MetricObservation,
  type Provenance,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../eval-core/contracts/index.js';
import {
  projectCoreRunArtifactIndexCard,
  type CoreRunArtifactIndexCard,
  type StoredCoreRunArtifacts,
} from '../../eval-workflows/artifact-store/index.js';
import { assertCoreProjectionSource } from '../../eval-workflows/downstream-projections/index.js';
import {
  CORE_STUDIO_RUN_CARD_SCHEMA_VERSION,
  CORE_STUDIO_RUN_DETAIL_SCHEMA_VERSION,
  type CoreStudioAnalysisRecord,
  type CoreStudioBudget,
  type CoreStudioDecision,
  type CoreStudioEvaluationRecord,
  type CoreStudioExecutionRecord,
  type CoreStudioMetricObservation,
  type CoreStudioProvenance,
  type CoreStudioRunCard,
  type CoreStudioRunDetail,
  type CoreStudioRuntimeIdentity,
  type CoreStudioUsage,
} from './contracts.js';

function freezeView<T>(value: T): T {
  return deepFreezeCanonicalJson(value as unknown as JsonValue) as unknown as T;
}

function runtime(identity: RuntimeIdentity): CoreStudioRuntimeIdentity {
  return {
    implementationId: identity.implementationId,
    ...(identity.version === undefined ? {} : { version: identity.version }),
    fingerprint: identity.fingerprint,
    fingerprintBasis: identity.fingerprintBasis,
    assuranceLevel: identity.assuranceLevel,
  };
}

function provenance(value: Provenance): CoreStudioProvenance {
  return {
    provenanceKind: value.provenanceKind,
    trust: value.trust,
    parentDigests: [...value.parentDigests],
  };
}

function usage(value: UsageRecord | undefined): CoreStudioUsage | undefined {
  if (value === undefined) return undefined;
  return {
    ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
    ...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
    ...(value.providerCost === undefined ? {} : {
      providerCost: {
        amount: value.providerCost.amount,
        currency: value.providerCost.currency,
      },
    }),
  };
}

function budget(summary: BudgetSummary): CoreStudioBudget {
  const run = summary.scopes.find((scope) => scope.scopeKind === 'run');
  const totals = run?.totals ?? {
    invocations: summary.entries.length,
    activeDurationMs: summary.entries.reduce((sum, entry) => (
      sum + entry.activeDurationMs
    ), 0),
    reportedProviderCosts: undefined,
    unreportedProviderCostInvocations: summary.entries.filter((entry) => (
      entry.providerCostStatus === 'unreported'
    )).length,
  };
  return {
    summaryStatus: summary.summaryStatus,
    admissionMode: summary.admissionMode,
    invocations: totals.invocations,
    activeDurationMs: totals.activeDurationMs,
    reportedProviderCosts: (totals.reportedProviderCosts ?? []).map((cost) => ({
      amount: cost.amount,
      currency: cost.currency,
    })),
    unreportedProviderCostInvocations: totals.unreportedProviderCostInvocations,
    wallClock: {
      elapsedMs: summary.wallClock.elapsedMs,
      ...(summary.wallClock.limitMs === undefined ? {} : {
        limitMs: summary.wallClock.limitMs,
      }),
      overshootMs: summary.wallClock.overshootMs,
    },
    ...(summary.termination === undefined ? {} : {
      termination: {
        terminationKind: summary.termination.terminationKind,
        ...(summary.termination.resourceKind === undefined ? {} : {
          resourceKind: summary.termination.resourceKind,
        }),
        ...(summary.termination.scopeKind === undefined ? {} : {
          scopeKind: summary.termination.scopeKind,
        }),
        reasonCode: summary.termination.reasonCode,
      },
    }),
    ledgerDigest: summary.ledgerDigest,
  };
}

function executionRecord(record: ExecutionRecord): CoreStudioExecutionRecord {
  const base = {
    targetId: record.targetId,
    sampleId: record.sampleId,
    trialIndex: record.trialIndex,
    trialId: record.trialId,
    executionStatus: record.executionStatus,
    runtime: runtime(record.runtime),
    provenance: provenance(record.provenance),
  };
  if (record.executionStatus === 'budget-censored') {
    return { ...base, censorReasonCode: record.censorReasonCode };
  }
  const projectedUsage = usage(record.usage);
  return {
    ...base,
    cacheStatus: record.cache.cacheStatus,
    ...(record.timing.durationMs === undefined ? {} : {
      durationMs: record.timing.durationMs,
    }),
    ...(projectedUsage === undefined ? {} : { usage: projectedUsage }),
    ...(record.executionStatus === 'failed' ? { errorCode: record.error.code } : {}),
    ...(record.executionStatus === 'cancelled' && record.error !== undefined
      ? { errorCode: record.error.code }
      : {}),
  };
}

function metricObservation(observation: MetricObservation): CoreStudioMetricObservation {
  return {
    observationId: observation.observationId,
    metricId: observation.metricId,
    observationStatus: observation.observationStatus,
    valueType: observation.valueType,
    ...(observation.observationStatus === 'observed'
      && observation.valueType === 'numeric'
      ? { numericValue: observation.value }
      : {}),
    ...(observation.observationStatus !== 'observed'
      ? { reasonCode: observation.reasonCode }
      : {}),
  };
}

function evaluationRecord(record: EvaluationRecord): CoreStudioEvaluationRecord {
  const base = {
    targetId: record.targetId,
    sampleId: record.sampleId,
    trialIndex: record.trialIndex,
    trialId: record.trialId,
    evaluatorId: record.evaluatorId,
    measurement: record.measurement,
    evaluationId: record.evaluationId,
    evaluationStatus: record.evaluationStatus,
    runtime: runtime(record.runtime),
    provenance: provenance(record.provenance),
  };
  if (record.evaluationStatus === 'not-evaluated') {
    return {
      ...base,
      observations: [],
      notEvaluatedReasonCode: record.notEvaluatedReasonCode,
    };
  }
  const projectedUsage = usage(record.usage);
  return {
    ...base,
    cacheStatus: record.cache.cacheStatus,
    ...(record.timing.durationMs === undefined ? {} : {
      durationMs: record.timing.durationMs,
    }),
    ...(projectedUsage === undefined ? {} : { usage: projectedUsage }),
    observations: record.evaluationStatus === 'completed'
      ? record.observations.map(metricObservation)
      : [],
    ...(record.evaluationStatus === 'failed' ? { errorCode: record.error.code } : {}),
    ...(record.evaluationStatus === 'cancelled' && record.error !== undefined
      ? { errorCode: record.error.code }
      : {}),
  };
}

function analysisRecord(
  record: StoredCoreRunArtifacts['analysis']['records'][number],
): CoreStudioAnalysisRecord {
  const base = {
    resultId: record.resultId,
    nodeId: record.nodeId,
    analysisNodeKind: record.analysisNodeKind,
    analysisStatus: record.analysisStatus,
    analysisMode: record.analysisMode,
    runtime: runtime(record.implementation),
    outputSchema: {
      schemaVersion: record.outputSchema.schemaVersion,
      schemaDigest: record.outputSchema.schemaDigest,
    },
    coverage: record.coverage,
    exclusionCount: record.exclusions.length,
    assumptionChecks: record.assumptionChecks.map((check) => ({
      assumptionId: check.assumptionId,
      checkStatus: check.checkStatus,
      ...(check.reasonCode === undefined ? {} : { reasonCode: check.reasonCode }),
    })),
    recordDigest: record.recordDigest,
  };
  if (record.analysisStatus === 'completed') {
    return {
      ...base,
      resultType: record.resultType,
      ...(record.resultType === 'scalar'
        && typeof record.value === 'number'
        && Number.isFinite(record.value)
        ? { numericValue: record.value }
        : {}),
    };
  }
  if (record.analysisStatus === 'failed') {
    return { ...base, errorCode: record.error.code };
  }
  return { ...base, reasonCodes: [...record.reasonCodes] };
}

function decision(
  value: StoredCoreRunArtifacts['report']['decision'],
): CoreStudioDecision | undefined {
  if (value === undefined) return undefined;
  const base = {
    decisionPolicyId: value.decisionPolicyId,
    decisionStatus: value.decisionStatus,
    implementation: runtime(value.implementation),
    analysisResultIds: [...value.analysisResultIds],
    decisionDigest: value.decisionDigest,
  };
  if (value.decisionStatus === 'decided') {
    return {
      ...base,
      verdict: value.verdict,
      reasonCodes: [...value.reasonCodes],
    };
  }
  if (value.decisionStatus === 'not-decided') {
    return { ...base, reasonCodes: [...value.reasonCodes] };
  }
  return { ...base, errorCode: value.error.code };
}

export function projectCoreStudioRunCard(
  card: Readonly<CoreRunArtifactIndexCard>,
): CoreStudioRunCard {
  return freezeView({
    cardKind: 'studio-core-run-card',
    schemaVersion: CORE_STUDIO_RUN_CARD_SCHEMA_VERSION,
    runId: card.runId,
    reportId: card.reportId,
    runContractDigest: card.runContractDigest,
    reportDigest: card.reportDigest,
    artifactSetDigest: card.artifactSetDigest,
    createdAt: card.createdAt,
    status: card.status,
    replayability: card.replayability,
    maximumCapturedClassification: card.maximumCapturedClassification,
  });
}

export function projectCoreStudioRunDetail(
  source: Readonly<StoredCoreRunArtifacts>,
): CoreStudioRunDetail {
  assertCoreProjectionSource(source);
  const card = projectCoreStudioRunCard(projectCoreRunArtifactIndexCard(source.manifest));
  const projectedDecision = decision(source.report.decision);
  return freezeView({
    detailKind: 'studio-core-run-detail',
    schemaVersion: CORE_STUDIO_RUN_DETAIL_SCHEMA_VERSION,
    run: card,
    dataset: {
      datasetId: source.plan.definition.dataset.datasetId,
      datasetRevisionDigest: source.plan.digests.datasetRevisionDigest,
      sampleCount: source.plan.execution.samples.length,
    },
    targets: source.plan.execution.targets.map((target) => ({
      targetId: target.targetId,
      targetKind: target.targetKind,
      protocolId: target.protocolId,
      executorId: target.executorId,
    })),
    evaluators: source.plan.evaluation.evaluators.map((evaluator) => ({
      evaluatorId: evaluator.evaluatorId,
      evaluatorKind: evaluator.evaluatorKind,
      implementationId: evaluator.implementationId,
      metricIds: [...evaluator.metricIds],
      measurement: evaluator.measurement,
    })),
    metrics: source.plan.evaluation.metrics.map((metric) => ({
      metricId: metric.metricId,
      valueType: metric.valueType,
      scope: metric.scope,
      ...(metric.scale === undefined ? {} : { scale: metric.scale }),
      ...(metric.unit === undefined ? {} : { unit: metric.unit }),
      ...(metric.direction === undefined ? {} : { direction: metric.direction }),
    })),
    stages: {
      execution: {
        bundleId: source.execution.bundleId,
        bundleDigest: source.execution.bundleDigest,
        stageStatus: source.execution.executionBundleStatus,
        coverage: source.execution.coverage,
        replayability: source.execution.replayability,
        budget: budget(source.execution.budgetSummary),
        provenance: provenance(source.execution.provenance),
        records: source.execution.records.map(executionRecord),
      },
      evaluation: {
        bundleId: source.evaluation.bundleId,
        bundleDigest: source.evaluation.bundleDigest,
        parentExecutionBundleDigest: source.evaluation.executionBundleDigest,
        stageStatus: source.evaluation.evaluationBundleStatus,
        coverage: source.evaluation.coverage,
        replayability: source.evaluation.replayability,
        budget: budget(source.evaluation.budgetSummary),
        provenance: provenance(source.evaluation.provenance),
        records: source.evaluation.records.map(evaluationRecord),
      },
      analysis: {
        bundleId: source.analysis.bundleId,
        bundleDigest: source.analysis.bundleDigest,
        parentEvaluationBundleDigest: source.analysis.evaluationBundleDigest,
        stageStatus: source.analysis.analysisBundleStatus,
        coverage: source.analysis.coverage,
        provenance: provenance(source.analysis.provenance),
        records: source.analysis.records.map(analysisRecord),
      },
    },
    ...(projectedDecision === undefined ? {} : { decision: projectedDecision }),
    reportProvenance: provenance(source.report.provenance),
    lineage: source.manifest.documents.map((document) => ({
      documentKind: document.documentKind,
      schemaVersion: document.schemaVersion,
      identityDigest: document.identityDigest,
      documentDigest: document.documentDigest,
    })),
  });
}
