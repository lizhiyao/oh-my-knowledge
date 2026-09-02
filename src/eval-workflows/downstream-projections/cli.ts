import {
  canonicalizeJson,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  IdentifierSchema,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import {
  assertSealedRunPlan,
  type SealedRunPlan,
} from '../../eval-core/compiler/index.js';
import type {
  StoredCoreBatch,
  StoredCoreRunArtifacts,
} from '../artifact-store/index.js';
import { parseCoreBatchManifestDocument } from '../artifact-store/index.js';
import {
  CORE_CLI_BATCH_OUTCOME_SCHEMA_VERSION,
  CORE_CLI_DRY_RUN_SCHEMA_VERSION,
  CORE_CLI_RUN_OUTCOME_SCHEMA_VERSION,
  CORE_CLI_SERIES_OUTCOME_SCHEMA_VERSION,
  CoreDownstreamProjectionError,
  type CoreCliBatchOutcome,
  type CoreCliDryRunProjection,
  type CoreCliGateProjection,
  type CoreCliRunOutcome,
  type CoreCliSeriesOutcome,
  type CoreEvolutionEvidence,
} from './contracts.js';
import { projectCompletedCoreCliGate } from './cli-gate.js';
import { projectCoreDecision } from './decision.js';
import { projectCoreDiagnostics } from './diagnostic.js';
import { assertCoreProjectionSource } from './source.js';

export interface ProjectCoreCliDryRunInput {
  readonly plan: SealedRunPlan;
  readonly preflight: {
    readonly records: readonly {
      readonly runtimeKind: string;
      readonly bindingId: string;
      readonly referenceId: string;
      readonly implementationId: string;
      readonly preflightKind: string;
      readonly checkId: string;
      readonly preflightStatus: 'passed' | 'skipped' | 'not-required';
      readonly reasonCode?: string;
    }[];
  };
}

export interface ProjectCoreCliRunOutcomeOptions {
  readonly exitMode: 'gate' | 'report-only';
  readonly diagnosticMode?: 'enabled' | 'disabled';
}

export interface ProjectCoreCliBatchOutcomeInput
  extends ProjectCoreCliRunOutcomeOptions {
  readonly batch: Readonly<StoredCoreBatch>;
  readonly children: readonly Readonly<StoredCoreRunArtifacts>[];
}

function freeze<T>(value: T): T {
  return deepFreezeCanonicalJson(value as unknown as JsonValue) as unknown as T;
}

function isSafeToken(value: unknown): value is string {
  return IdentifierSchema.safeParse(value).success
    && /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/i.test(value as string);
}

function preflightRecords(
  input: Readonly<ProjectCoreCliDryRunInput>['preflight'],
): ProjectCoreCliDryRunInput['preflight']['records'] {
  const records = input?.records;
  if (!Array.isArray(records)) {
    throw new CoreDownstreamProjectionError(
      'CORE_CLI_PLAN_INVALID',
      'CLI dry-run projection requires validated preflight records.',
    );
  }
  const identities = new Set<string>();
  for (const record of records) {
    const identity = `${record?.runtimeKind}\u0000${record?.bindingId}\u0000${record?.preflightKind}\u0000${record?.checkId}`;
    if (record === null
        || typeof record !== 'object'
        || !isSafeToken(record.runtimeKind)
        || !IdentifierSchema.safeParse(record.bindingId).success
        || !IdentifierSchema.safeParse(record.referenceId).success
        || !IdentifierSchema.safeParse(record.implementationId).success
        || !isSafeToken(record.preflightKind)
        || !isSafeToken(record.checkId)
        || !['passed', 'skipped', 'not-required'].includes(record.preflightStatus)
        || (record.reasonCode !== undefined
          && !isSafeToken(record.reasonCode))
        || identities.has(identity)) {
      throw new CoreDownstreamProjectionError(
        'CORE_CLI_PLAN_INVALID',
        'CLI dry-run projection requires validated preflight records.',
      );
    }
    identities.add(identity);
  }
  return records;
}

function assertExitMode(
  exitMode: ProjectCoreCliRunOutcomeOptions['exitMode'],
): void {
  if (exitMode !== 'gate' && exitMode !== 'report-only') {
    throw new CoreDownstreamProjectionError(
      'CORE_CLI_OPTIONS_INVALID',
      'CLI outcome projection requires an explicit gate or report-only exit mode.',
    );
  }
}

function assertDiagnosticMode(mode: ProjectCoreCliRunOutcomeOptions['diagnosticMode']): void {
  if (mode !== undefined && mode !== 'enabled' && mode !== 'disabled') {
    throw new CoreDownstreamProjectionError(
      'CORE_CLI_OPTIONS_INVALID',
      'CLI outcome projection requires an explicit enabled or disabled diagnostic mode.',
    );
  }
}

function projectGate(
  source: Readonly<StoredCoreRunArtifacts>,
  exitMode: ProjectCoreCliRunOutcomeOptions['exitMode'],
): CoreCliGateProjection {
  const status = source.report.status;
  if (status.runStatus !== 'completed') return {
    gateStatus: 'blocked',
    exitCode: 1,
    reasonCodes: [`core-run-${status.runStatus}`],
  };
  if (exitMode === 'report-only') return {
    gateStatus: 'skipped',
    exitCode: 0,
    reasonCodes: ['core-report-only'],
  };
  if (status.evidenceStatus !== 'complete') return {
    gateStatus: 'blocked',
    exitCode: 1,
    reasonCodes: [`core-evidence-${status.evidenceStatus}`],
  };
  if (status.conclusionStatus !== 'conclusive') return {
    gateStatus: 'blocked',
    exitCode: 1,
    reasonCodes: [`core-conclusion-${status.conclusionStatus}`],
  };
  return projectCompletedCoreCliGate(projectCoreDecision(source.report.decision));
}

function runBudgetTotals(source: Readonly<StoredCoreRunArtifacts>) {
  const summary = source.report.budgetSummary;
  return summary.scopes.find((scope) => scope.scopeKind === 'run')?.totals ?? {
    reportedProviderCosts: [],
    unreportedProviderCostInvocations: summary.entries.filter((entry) => (
      entry.providerCostStatus === 'unreported'
    )).length,
  };
}

function stageInvocationCount(
  source: Readonly<StoredCoreRunArtifacts>,
  stage: 'execution' | 'evaluation',
): number {
  return source.report.budgetSummary.scopes.find((scope) => (
    scope.scopeKind === 'stage' && scope.scopeId === stage
  ))?.totals.invocations ?? 0;
}

/** Projects a sealed, side-effect-free dry-run summary without Target or Evaluator access. */
export function projectCoreCliDryRun(
  input: Readonly<ProjectCoreCliDryRunInput>,
): CoreCliDryRunProjection {
  try {
    assertSealedRunPlan(input.plan);
  } catch {
    throw new CoreDownstreamProjectionError(
      'CORE_CLI_PLAN_INVALID',
      'CLI dry-run projection requires the exact in-process sealed RunPlan capability.',
    );
  }
  const plan = input.plan;
  const records = preflightRecords(input.preflight).map((record) => ({ ...record }));
  return freeze({
    projectionKind: 'core-cli-dry-run',
    schemaVersion: CORE_CLI_DRY_RUN_SCHEMA_VERSION,
    runContractDigest: plan.digests.runContractDigest,
    stageDigests: {
      executionPlanDigest: plan.digests.executionPlanDigest,
      evaluationPlanDigest: plan.digests.evaluationPlanDigest,
      analysisPlanDigest: plan.digests.analysisPlanDigest,
      decisionPlanDigest: plan.digests.decisionPlanDigest,
    },
    dataset: {
      datasetId: plan.definition.dataset.datasetId,
      datasetRevisionDigest: plan.digests.datasetRevisionDigest,
      sampleCount: plan.execution.samples.length,
    },
    experiment: {
      trials: plan.execution.experiment.trials,
      experimentalUnit: plan.definition.experiment.sampling.experimentalUnit,
      resamplingUnit: plan.definition.experiment.sampling.resamplingUnit,
      repeatedMeasures: plan.definition.experiment.sampling.repeatedMeasures,
    },
    targets: plan.execution.targets.map((target) => ({
      targetId: target.targetId,
      targetKind: target.targetKind,
      protocolId: target.protocolId,
      executorId: target.executorId,
    })),
    evaluation: {
      evaluatorCount: plan.evaluation.evaluators.length,
      metricIds: plan.evaluation.metrics.map((metric) => metric.metricId),
    },
    analysis: {
      analysisMode: plan.analysis.analysisGraph.analysisMode,
      nodeCount: plan.analysis.analysisGraph.nodes.length,
      outputResultIds: plan.analysis.analysisGraph.nodes.map((node) => node.outputResultId),
    },
    ...(plan.decision.decisionPolicy === undefined ? {} : {
      decision: {
        decisionPolicyId: plan.decision.decisionPolicy.decisionPolicyId,
        implementationId: plan.decision.decisionPolicy.implementationId,
      },
    }),
    preflight: {
      passed: records.filter((record) => record.preflightStatus === 'passed').length,
      skipped: records.filter((record) => record.preflightStatus === 'skipped').length,
      notRequired: records.filter((record) => record.preflightStatus === 'not-required').length,
      records,
    },
  });
}

/** Projects CLI terminal and exit semantics only from an authenticated Core artifact chain. */
export function projectCoreCliRunOutcome(
  source: Readonly<StoredCoreRunArtifacts>,
  options: Readonly<ProjectCoreCliRunOutcomeOptions>,
): CoreCliRunOutcome {
  assertExitMode(options?.exitMode);
  assertDiagnosticMode(options?.diagnosticMode);
  assertCoreProjectionSource(source);
  const totals = runBudgetTotals(source);
  const projectedDecision = projectCoreDecision(source.report.decision);
  return freeze({
    projectionKind: 'core-cli-run-outcome',
    schemaVersion: CORE_CLI_RUN_OUTCOME_SCHEMA_VERSION,
    runId: source.manifest.runId,
    reportId: source.report.reportId,
    runContractDigest: source.plan.digests.runContractDigest,
    reportDigest: source.report.reportDigest,
    artifactSetDigest: digestCanonicalJson(source.manifest.documents),
    createdAt: source.manifest.createdAt,
    status: source.report.status,
    stages: {
      execution: {
        bundleDigest: source.execution.bundleDigest,
        stageStatus: source.execution.executionBundleStatus,
        coverage: source.execution.coverage,
      },
      evaluation: {
        bundleDigest: source.evaluation.bundleDigest,
        stageStatus: source.evaluation.evaluationBundleStatus,
        coverage: source.evaluation.coverage,
      },
      analysis: {
        bundleDigest: source.analysis.bundleDigest,
        stageStatus: source.analysis.analysisBundleStatus,
        coverage: source.analysis.coverage,
      },
    },
    usage: {
      executionInvocations: stageInvocationCount(source, 'execution'),
      evaluationInvocations: stageInvocationCount(source, 'evaluation'),
      reportedProviderCosts: (totals.reportedProviderCosts ?? []).map((cost) => ({
        amount: cost.amount,
        currency: cost.currency,
      })),
      unreportedProviderCostInvocations: totals.unreportedProviderCostInvocations,
    },
    ...(projectedDecision === undefined ? {} : { decision: projectedDecision }),
    ...(options.diagnosticMode === 'enabled'
      ? { diagnostic: projectCoreDiagnostics(source) }
      : {}),
    gate: projectGate(source, options.exitMode),
  });
}

/** Projects an index-only Batch as independent child outcomes; no pooled score is invented. */
export function projectCoreCliBatchOutcome(
  input: Readonly<ProjectCoreCliBatchOutcomeInput>,
): CoreCliBatchOutcome {
  assertExitMode(input?.exitMode);
  assertDiagnosticMode(input?.diagnosticMode);
  let manifest;
  try {
    manifest = parseCoreBatchManifestDocument(input.batch.manifest);
  } catch {
    throw new CoreDownstreamProjectionError(
      'CORE_CLI_BATCH_SOURCE_INVALID',
      'CLI Batch projection requires a valid Core Batch manifest.',
    );
  }
  const references = manifest.children;
  const byRunId = new Map(input.children.map((child) => [child.manifest.runId, child]));
  if (input.children.length !== references.length
      || byRunId.size !== input.children.length
      || references.some((reference) => {
        const source = byRunId.get(reference.locator.runId);
        if (source === undefined) return true;
        try {
          assertCoreProjectionSource(source);
        } catch {
          return true;
        }
        return source.manifest.reportId !== reference.reportId
          || source.manifest.runContractDigest !== reference.runContractDigest
          || source.report.reportDigest !== reference.reportDigest
          || digestCanonicalJson(source.manifest.documents) !== reference.artifactSetDigest
          || canonicalizeJson(source.report.status) !== canonicalizeJson(reference.status);
      })) {
    throw new CoreDownstreamProjectionError(
      'CORE_CLI_BATCH_SOURCE_INVALID',
      'CLI Batch projection requires every exact child artifact set referenced by the manifest.',
    );
  }
  const children = references.map((reference) => ({
    itemId: reference.itemId,
    ordinal: reference.ordinal,
    runId: reference.locator.runId,
    outcome: projectCoreCliRunOutcome(
      byRunId.get(reference.locator.runId)!,
      { exitMode: input.exitMode, diagnosticMode: input.diagnosticMode },
    ),
  }));
  const blocked = children.filter(({ outcome }) => outcome.gate.exitCode !== 0);
  const gate: CoreCliGateProjection = blocked.length > 0
    ? {
      gateStatus: 'blocked',
      exitCode: 1,
      reasonCodes: ['core-batch-child-blocked'],
    }
    : input.exitMode === 'report-only'
      ? { gateStatus: 'skipped', exitCode: 0, reasonCodes: ['core-report-only'] }
      : { gateStatus: 'passed', exitCode: 0, reasonCodes: ['core-batch-children-passed'] };
  return freeze({
    projectionKind: 'core-cli-batch-outcome',
    schemaVersion: CORE_CLI_BATCH_OUTCOME_SCHEMA_VERSION,
    batchId: manifest.batchId,
    batchManifestDigest: manifest.batchManifestDigest,
    createdAt: manifest.createdAt,
    children,
    gate,
  });
}

/** Projects preregistered independent runs without pooling their measurements. */
export function projectCoreCliSeriesOutcome(input: Readonly<{
  evolution: Readonly<CoreEvolutionEvidence>;
  members: readonly Readonly<StoredCoreRunArtifacts>[];
  exitMode: ProjectCoreCliRunOutcomeOptions['exitMode'];
  diagnosticMode?: ProjectCoreCliRunOutcomeOptions['diagnosticMode'];
}>): CoreCliSeriesOutcome {
  assertExitMode(input?.exitMode);
  assertDiagnosticMode(input?.diagnosticMode);
  const evolution = input?.evolution;
  const byReportDigest = new Map(input.members.map((member) => [
    member.report.reportDigest,
    member,
  ]));
  if (evolution?.projectionKind !== 'core-evolution-evidence'
      || evolution.members.length !== input.members.length
      || byReportDigest.size !== input.members.length
      || evolution.members.some((member) => {
        const source = byReportDigest.get(member.reportDigest);
        if (source === undefined) return true;
        try {
          assertCoreProjectionSource(source);
        } catch {
          return true;
        }
        return source.plan.digests.runContractDigest !== member.runContractDigest
          || canonicalizeJson(source.report.status) !== canonicalizeJson(member.status);
      })) {
    throw new CoreDownstreamProjectionError(
      'CORE_CLI_SERIES_SOURCE_INVALID',
      'CLI Series projection requires every exact Core member referenced by evolution evidence.',
    );
  }
  const members = evolution.members.map((member) => {
    const source = byReportDigest.get(member.reportDigest)!;
    return {
      memberId: member.memberId,
      replicateIndex: member.replicateIndex,
      runId: source.manifest.runId,
      outcome: projectCoreCliRunOutcome(source, {
        exitMode: input.exitMode,
        diagnosticMode: input.diagnosticMode,
      }),
    };
  });
  const blocked = members.some(({ outcome }) => outcome.gate.exitCode !== 0);
  const complete = evolution.coverage.planned === members.length
    && evolution.coverage.missing === 0
    && evolution.coverage.failed === 0
    && evolution.coverage.cancelled === 0
    && evolution.coverage.budgetExhausted === 0;
  const seriesDecisionGate = projectCompletedCoreCliGate(evolution.decision);
  const gate: CoreCliGateProjection = input.exitMode === 'report-only'
    ? { gateStatus: 'skipped', exitCode: 0, reasonCodes: ['core-report-only'] }
    : !complete
      ? { gateStatus: 'blocked', exitCode: 1, reasonCodes: ['core-series-coverage-incomplete'] }
      : evolution.evidenceReadiness !== 'decision-ready'
        ? {
            gateStatus: 'blocked',
            exitCode: 1,
            reasonCodes: ['core-series-decision-not-ready'],
          }
        : blocked
          ? {
              gateStatus: 'blocked',
              exitCode: 1,
              reasonCodes: ['core-series-member-blocked'],
            }
          : seriesDecisionGate;
  return freeze({
    projectionKind: 'core-cli-series-outcome',
    schemaVersion: CORE_CLI_SERIES_OUTCOME_SCHEMA_VERSION,
    seriesId: evolution.seriesId,
    seriesPlanDigest: evolution.seriesPlanDigest,
    reportDigest: evolution.reportDigest,
    evidenceReadiness: evolution.evidenceReadiness,
    coverage: evolution.coverage,
    members,
    ...(evolution.decision === undefined ? {} : { decision: evolution.decision }),
    gate,
  });
}
