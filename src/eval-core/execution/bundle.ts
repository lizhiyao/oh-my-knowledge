/** Deterministic Bundle construction and final verification. */
import { compareStrings } from '../primitives/ordering.js';
import { minimumTrust } from '../primitives/provenance.js';
import {
  EXECUTION_BUNDLE_SCHEMA_VERSION,
  digestArtifactPayload,
  type CapturedContent,
  type ExecutionBundle,
  type ExecutionBundleSource,
  type ExecutionRecord,
  type JsonValue,
  type Sha256Digest,
} from '../contracts/index.js';
import { verifyExecutionBundle } from '../verify/index.js';
import { type SealedRunPlan } from '../compiler/index.js';
import { snapshotJson } from '../compiler/immutability.js';
import { resolveRunBudgetSource } from '../budget/index.js';
import type { CompletedExecutionRecord, ResolvedExecutionRunOptions, StopState } from './runtime-state.js';


function compareRecords(left: ExecutionRecord, right: ExecutionRecord): number {
  return compareStrings(left.targetId, right.targetId)
    || compareStrings(left.sampleId, right.sampleId)
    || left.trialIndex - right.trialIndex;
}

function replayability(records: readonly ExecutionRecord[]): ExecutionBundle['replayability'] {
  const completed = records.filter(
    (record): record is CompletedExecutionRecord => record.executionStatus === 'completed',
  );
  if (completed.length === 0) return 'summary-only';
  const active = records.filter((record) => record.executionStatus !== 'budget-censored');
  const captured = active.flatMap((record) => record.executionStatus === 'completed'
    ? [record.output, record.trace]
    : [record.trace]).filter(
    (content): content is CapturedContent => content !== undefined,
  );
  if (completed.every((record) => record.output?.contentKind === 'inline')
      && captured.every((content) => content.contentKind === 'inline')) return 'self-contained';
  if (completed.every((record) => record.output?.contentKind === 'inline'
        || record.output?.contentKind === 'descriptor')
      && captured.every((content) => content.contentKind === 'inline'
        || content.contentKind === 'descriptor')
      && captured.some((content) => content.contentKind === 'descriptor')) return 'resolvable';
  return 'summary-only';
}

function coverage(
  planned: number,
  records: readonly ExecutionRecord[],
): ExecutionBundle['coverage'] {
  const succeeded = records.filter((record) => record.executionStatus === 'completed').length;
  const failed = records.filter((record) => record.executionStatus === 'failed').length;
  const cancelled = records.filter((record) => record.executionStatus === 'cancelled').length;
  const budgetCensored = records.filter(
    (record) => record.executionStatus === 'budget-censored',
  ).length;
  return {
    planned,
    started: succeeded + failed + cancelled,
    succeeded,
    failed,
    cancelled,
    budgetCensored,
    notStarted: planned - records.length,
  };
}

export function makeBundle(
  plan: SealedRunPlan,
  options: ResolvedExecutionRunOptions,
  records: ExecutionRecord[],
  plannedCount: number,
  stop: StopState,
  verifiedCacheRecordDigests: ReadonlySet<Sha256Digest>,
): ExecutionBundleSource {
  const sortedRecords = records.sort(compareRecords);
  const executionBundleStatus = stop.stopKind ?? 'completed';
  const bundle: ExecutionBundle = {
    schemaVersion: EXECUTION_BUNDLE_SCHEMA_VERSION,
    bundleId: options.bundleId,
    runContractDigest: plan.digests.runContractDigest,
    executionPlanDigest: plan.digests.executionPlanDigest,
    datasetRevisionDigest: plan.digests.datasetRevisionDigest,
    executionInputDigest: plan.digests.executionInputDigest,
    executionBundleStatus,
    ...(stop.reason !== undefined ? { terminationReasonCode: stop.reason } : {}),
    coverage: coverage(plannedCount, sortedRecords),
    replayability: replayability(sortedRecords),
    budgetSummary: resolveRunBudgetSource(
      options.budgetSource,
      plan,
      options.runId,
    ).snapshot(),
    records: sortedRecords,
    provenance: {
      provenanceKind: 'native',
      trust: minimumTrust(sortedRecords.map((record) => record.provenance.trust), 'verified'),
      parentDigests: [
        plan.digests.runContractDigest,
        plan.digests.executionPlanDigest,
      ],
      ...(stop.error !== undefined
        ? { facets: snapshotJson({ terminalError: stop.error }) as unknown as JsonValue }
        : {}),
    },
    bundleDigest: `sha256:${'0'.repeat(64)}`,
  };
  bundle.bundleDigest = digestArtifactPayload(bundle, 'bundleDigest');
  const verified = verifyExecutionBundle(bundle, plan, {
    verifiedCacheRecordDigests,
    verifiedProvenanceBundleDigests: new Set([bundle.bundleDigest as Sha256Digest]),
  });
  if (verified.planVerification.provenanceTrustStatus !== 'verified'
      || verified.planVerification.cacheReceiptStatus !== 'verified'
      || verified.planVerification.invocationBudgetStatus !== 'verified'
      || (bundle.executionBundleStatus === 'completed'
        && verified.planVerification.providerCostBudgetStatus !== 'verified'
        && bundle.budgetSummary.summaryStatus !== 'unverifiable')) {
    throw new TypeError('Execution Runtime produced an unverifiable Bundle.');
  }
  return verified;
}
