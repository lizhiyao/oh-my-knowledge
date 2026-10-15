/** Deterministic Bundle construction and final verification. */
import { compareStrings } from '../primitives/ordering.js';
import { minimumTrust } from '../primitives/provenance.js';
import {
  EVALUATION_BUNDLE_SCHEMA_VERSION,
  digestArtifactPayload,
  type CapturedContent,
  type EvaluationBundle,
  type EvaluationBundleSource,
  type EvaluationRecord,
  type ExecutionBundleSource,
  type JsonValue,
  type Sha256Digest,
} from '../contracts/index.js';
import { verifyEvaluationBundle } from '../verify/index.js';
import { effectiveExecutionBundleTrust } from '../verify/index.js';
import { snapshotJson } from '../compiler/immutability.js';
import type { SealedRunPlan } from '../compiler/index.js';
import { resolveRunBudgetSource } from '../budget/index.js';
import type { ResolvedEvaluationRunOptions, StopState } from './runtime-state.js';


function compareRecords(left: EvaluationRecord, right: EvaluationRecord): number {
  return compareStrings(left.targetId, right.targetId)
    || compareStrings(left.sampleId, right.sampleId)
    || left.trialIndex - right.trialIndex
    || compareStrings(left.evaluatorId, right.evaluatorId);
}

function replayability(records: readonly EvaluationRecord[]): EvaluationBundle['replayability'] {
  const captured = records.flatMap((record) => {
    if (record.evaluationStatus === 'not-evaluated') return [];
    return [
      record.evidence,
      ...(record.evaluationStatus === 'completed'
        ? record.observations.flatMap((observation) => [
          observation.evidence,
          observation.metadata,
          observation.observationStatus === 'invalid' ? observation.invalidValue : undefined,
        ])
        : []),
    ].filter((content): content is CapturedContent => content !== undefined);
  });
  if (captured.every((content) => content.contentKind === 'inline')) return 'self-contained';
  if (captured.every((content) => content.contentKind !== 'digest-only')
      && captured.some((content) => content.contentKind === 'descriptor')) return 'resolvable';
  return 'summary-only';
}

export function makeBundle(
  plan: SealedRunPlan,
  source: ExecutionBundleSource,
  options: ResolvedEvaluationRunOptions,
  records: EvaluationRecord[],
  planned: number,
  stop: StopState,
  verifiedCacheRecordDigests: ReadonlySet<Sha256Digest>,
): EvaluationBundleSource {
  const execution = source.bundle;
  records.sort(compareRecords);
  const sourceUnavailable = records.filter(
    (record) => record.evaluationStatus === 'not-evaluated',
  ).length;
  const completed = records.filter((record) => record.evaluationStatus === 'completed').length;
  const failed = records.filter((record) => record.evaluationStatus === 'failed').length;
  const cancelled = records.filter((record) => record.evaluationStatus === 'cancelled').length;
  const started = completed + failed + cancelled;
  const eligible = planned - sourceUnavailable;
  const bundle: EvaluationBundle = {
    schemaVersion: EVALUATION_BUNDLE_SCHEMA_VERSION,
    bundleId: options.bundleId,
    runContractDigest: plan.digests.runContractDigest,
    executionBundleDigest: execution.bundleDigest,
    evaluationPlanDigest: plan.digests.evaluationPlanDigest,
    evaluationInputDigest: plan.digests.evaluationInputDigest,
    evaluationBundleStatus: stop.stopKind ?? 'completed',
    ...(stop.reason === undefined ? {} : { terminationReasonCode: stop.reason }),
    coverage: {
      planned,
      eligible,
      sourceUnavailable,
      started,
      completed,
      failed,
      cancelled,
      notStarted: eligible - started,
    },
    replayability: replayability(records),
    budgetSummary: resolveRunBudgetSource(
      options.budgetSource,
      plan,
      options.runId,
    ).snapshot(),
    records,
    provenance: {
      provenanceKind: 'native',
      trust: minimumTrust([
        effectiveExecutionBundleTrust(source),
        ...records.map((record) => record.provenance.trust),
      ], 'verified'),
      parentDigests: [execution.bundleDigest, plan.evaluation.evaluationPlanDigest],
      ...(stop.error === undefined
        ? {}
        : { facets: snapshotJson({ terminalError: stop.error }) as unknown as JsonValue }),
    },
    bundleDigest: `sha256:${'0'.repeat(64)}`,
  };
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  const verified = verifyEvaluationBundle(
    bundle,
    plan,
    source,
    {
      verifiedCacheRecordDigests,
      verifiedProvenanceBundleDigests: new Set([bundle.bundleDigest as Sha256Digest]),
      executionSourceTrust: effectiveExecutionBundleTrust(source),
    },
  );
  if (verified.planVerification.provenanceTrustStatus !== 'verified'
      || verified.planVerification.cacheReceiptStatus !== 'verified'
      || verified.planVerification.invocationBudgetStatus !== 'verified'
      || (bundle.evaluationBundleStatus === 'completed'
        && verified.planVerification.providerCostBudgetStatus !== 'verified'
        && bundle.budgetSummary.summaryStatus !== 'unverifiable')) {
    throw new TypeError('Evaluation Runtime produced an unverifiable Bundle.');
  }
  return verified;
}
