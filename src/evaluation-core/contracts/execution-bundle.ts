import {
  ExecutionBundleSchema,
  type ExecutionBundle,
  type ExecutionRecord,
} from './artifacts.js';
import type { CapturedContent } from './common.js';
import {
  deriveAttemptId,
  derivePlannedExecutionCoordinates,
  deriveTrialId,
  type ExecutionIdentityPlanContext,
  type PlannedExecutionCoordinate,
} from './execution-identities.js';
import { digestArtifactPayload } from './digests.js';
import { canonicalizeJson, parseWireDocument, type Sha256Digest } from './json.js';

export type ExecutionBundleValidationErrorCode =
  | 'EXECUTION_BUNDLE_DUPLICATE_COORDINATE'
  | 'EXECUTION_BUNDLE_IDENTITY_MISMATCH'
  | 'EXECUTION_BUNDLE_RECORD_ORDER_INVALID'
  | 'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID'
  | 'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID'
  | 'EXECUTION_BUNDLE_COVERAGE_INVALID'
  | 'EXECUTION_BUNDLE_STATUS_INVALID'
  | 'EXECUTION_BUNDLE_REPLAYABILITY_INVALID'
  | 'EXECUTION_BUNDLE_DIGEST_MISMATCH'
  | 'EXECUTION_BUNDLE_PLAN_MISMATCH'
  | 'EXECUTION_BUNDLE_RETRY_POLICY_INVALID';

export class ExecutionBundleValidationError extends TypeError {
  readonly code: ExecutionBundleValidationErrorCode;

  constructor(code: ExecutionBundleValidationErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionBundleValidationError';
    this.code = code;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRecordCoordinates(left: ExecutionRecord, right: ExecutionRecord): number {
  return compareStrings(left.targetId, right.targetId)
    || compareStrings(left.sampleId, right.sampleId)
    || left.trialIndex - right.trialIndex;
}

function assertCanonicalRecordOrder(records: readonly ExecutionRecord[]): void {
  for (let index = 1; index < records.length; index += 1) {
    const order = compareRecordCoordinates(records[index - 1], records[index]);
    if (order >= 0) {
      throw new ExecutionBundleValidationError(
        order === 0
          ? 'EXECUTION_BUNDLE_DUPLICATE_COORDINATE'
          : 'EXECUTION_BUNDLE_RECORD_ORDER_INVALID',
        order === 0
          ? 'ExecutionBundle contains a duplicate execution coordinate.'
          : 'ExecutionBundle records must use canonical target/sample/trial order.',
      );
    }
  }
}

function assertRecordIdentities(bundle: ExecutionBundle): void {
  const trialIds = new Set<string>();
  const attemptIds = new Set<string>();
  for (const record of bundle.records) {
    const expectedTrialId = deriveTrialId({
      executionPlanDigest: bundle.executionPlanDigest as Sha256Digest,
      targetId: record.targetId,
      sampleId: record.sampleId,
      trialIndex: record.trialIndex,
    });
    if (record.trialId !== expectedTrialId || trialIds.has(record.trialId)) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_IDENTITY_MISMATCH',
        'ExecutionRecord trial identity does not match its canonical coordinate.',
      );
    }
    trialIds.add(record.trialId);
    if (record.executionStatus === 'budget-censored') continue;

    for (let index = 0; index < record.attempts.length; index += 1) {
      const attempt = record.attempts[index];
      const expectedNumber = index + 1;
      if (attempt.attemptNumber !== expectedNumber) {
        throw new ExecutionBundleValidationError(
          'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID',
          'Execution attempts must be ordered consecutively from one.',
        );
      }
      const expectedAttemptId = deriveAttemptId({
        trialId: record.trialId as Sha256Digest,
        attemptNumber: attempt.attemptNumber,
      });
      if (attempt.attemptId !== expectedAttemptId || attemptIds.has(attempt.attemptId)) {
        throw new ExecutionBundleValidationError(
          'EXECUTION_BUNDLE_IDENTITY_MISMATCH',
          'ExecutionAttempt identity does not match its trial and attempt number.',
        );
      }
      attemptIds.add(attempt.attemptId);
      if (index < record.attempts.length - 1 && attempt.attemptStatus === 'completed') {
        throw new ExecutionBundleValidationError(
          'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID',
          'A completed ExecutionAttempt must terminate its trial.',
        );
      }
    }
    const terminalAttempt = record.attempts.at(-1);
    if (terminalAttempt?.attemptStatus !== record.executionStatus) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID',
        'The final attempt status must match the active ExecutionRecord status.',
      );
    }
  }
}

function assertSchedulingBlockAtomicity(records: readonly ExecutionRecord[]): void {
  const blocks = new Map<string, {
    trialIndex: number;
    hasActive: boolean;
    hasCensored: boolean;
  }>();
  for (const record of records) {
    const block = blocks.get(record.schedulingBlockId) ?? {
      trialIndex: record.trialIndex,
      hasActive: false,
      hasCensored: false,
    };
    if (block.trialIndex !== record.trialIndex) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_IDENTITY_MISMATCH',
        'A scheduling block cannot span multiple trial indices.',
      );
    }
    if (record.executionStatus === 'budget-censored') block.hasCensored = true;
    else block.hasActive = true;
    blocks.set(record.schedulingBlockId, block);
  }
  if ([...blocks.values()].some((block) => block.hasActive && block.hasCensored)) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID',
      'A scheduling block cannot mix active and budget-censored coordinates.',
    );
  }
}

function assertCoverage(bundle: ExecutionBundle): void {
  const { coverage } = bundle;
  if (coverage.planned === 0
      || coverage.started !== coverage.succeeded + coverage.failed + coverage.cancelled
      || coverage.planned !== coverage.started + coverage.budgetCensored + coverage.notStarted
      || bundle.records.length !== coverage.started + coverage.budgetCensored) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_COVERAGE_INVALID',
      'ExecutionBundle coverage counters are not internally consistent.',
    );
  }
  const actual = {
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    budgetCensored: 0,
  };
  for (const record of bundle.records) {
    if (record.executionStatus === 'completed') actual.succeeded += 1;
    else if (record.executionStatus === 'failed') actual.failed += 1;
    else if (record.executionStatus === 'cancelled') actual.cancelled += 1;
    else actual.budgetCensored += 1;
  }
  if (actual.succeeded !== coverage.succeeded
      || actual.failed !== coverage.failed
      || actual.cancelled !== coverage.cancelled
      || actual.budgetCensored !== coverage.budgetCensored) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_COVERAGE_INVALID',
      'ExecutionBundle coverage counters do not match its records.',
    );
  }
}

function assertStatus(bundle: ExecutionBundle): void {
  const { executionBundleStatus: status, coverage, terminationReasonCode } = bundle;
  if (status === 'completed') {
    if (terminationReasonCode !== undefined
        || coverage.notStarted !== 0
        || coverage.budgetCensored !== 0) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_STATUS_INVALID',
        'A completed ExecutionBundle must cover every planned coordinate.',
      );
    }
    return;
  }
  if (terminationReasonCode === undefined) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A non-completed ExecutionBundle requires a termination reason code.',
    );
  }
  if (status === 'budget-exhausted'
      && coverage.notStarted !== 0) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A budget-exhausted ExecutionBundle must classify every unstarted coordinate as budget-censored; exhaustion during a started trial may leave no censored coordinate.',
    );
  }
  if (status === 'cancelled'
      && coverage.cancelled + coverage.notStarted === 0
      && coverage.started !== coverage.planned) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A cancelled ExecutionBundle must expose cancelled or unstarted coordinates.',
    );
  }
  // A run-level infrastructure or teardown failure can happen after every
  // coordinate has completed, so terminationReasonCode is the authoritative
  // failed-state fact rather than record coverage alone.
}

function isInline(content: CapturedContent | undefined): boolean {
  return content?.contentKind === 'inline';
}

function isResolvable(content: CapturedContent | undefined): boolean {
  return content?.contentKind === 'inline' || content?.contentKind === 'descriptor';
}

function assertReplayability(bundle: ExecutionBundle): void {
  if (bundle.replayability === 'summary-only') return;
  const active = bundle.records.filter(
    (record) => record.executionStatus !== 'budget-censored',
  );
  const completed = bundle.records.filter(
    (record) => record.executionStatus === 'completed',
  );
  if (completed.length === 0) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_REPLAYABILITY_INVALID',
      'A replayable ExecutionBundle requires at least one completed execution.',
    );
  }
  if (bundle.replayability === 'self-contained') {
    if (completed.some((record) => !isInline(record.output)
      || (record.trace !== undefined && !isInline(record.trace)))
      || active.some((record) => record.executionStatus !== 'completed'
        && record.trace !== undefined
        && !isInline(record.trace))) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_REPLAYABILITY_INVALID',
        'A self-contained ExecutionBundle requires inline completed outputs and traces.',
      );
    }
    return;
  }
  const contents = active.flatMap((record) => (
    record.executionStatus === 'completed'
      ? [record.output, record.trace]
      : [record.trace]
  ))
    .filter((content): content is CapturedContent => content !== undefined);
  if (completed.some((record) => !isResolvable(record.output)
      || (record.trace !== undefined && !isResolvable(record.trace)))
      || active.some((record) => record.executionStatus !== 'completed'
        && record.trace !== undefined
        && !isResolvable(record.trace))
      || !contents.some((content) => content.contentKind === 'descriptor')) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_REPLAYABILITY_INVALID',
      'A resolvable ExecutionBundle requires inline or descriptor content and a descriptor.',
    );
  }
}

export function assertExecutionBundleSemantics(bundle: ExecutionBundle): void {
  assertCanonicalRecordOrder(bundle.records);
  assertRecordIdentities(bundle);
  assertSchedulingBlockAtomicity(bundle.records);
  assertCoverage(bundle);
  assertStatus(bundle);
  assertReplayability(bundle);
}

export interface ExecutionBundlePlanContext extends ExecutionIdentityPlanContext {
  execution: ExecutionIdentityPlanContext['execution'] & {
    executionInputDigest: string;
    runtimes: readonly {
      runtimeKind: 'executor' | 'evaluator' | 'analysis-node' | 'missing-policy' | 'decision-policy';
      referenceId: string;
      identity: unknown;
    }[];
    policy: {
      retry: {
        maxAttempts: number;
        retryableErrorCodes: readonly string[];
      };
      budget: {
        maxTargetInvocations?: number;
      };
    };
  };
  digests: {
    datasetRevisionDigest: string;
    executionInputDigest: string;
    executionPlanDigest: string;
    runContractDigest: string;
  };
}

function coordinateKey(
  coordinate: Pick<PlannedExecutionCoordinate, 'targetId' | 'sampleId' | 'trialIndex'>,
): string {
  return canonicalizeJson([
    coordinate.targetId,
    coordinate.sampleId,
    coordinate.trialIndex,
  ]);
}

function planMismatch(message: string): never {
  throw new ExecutionBundleValidationError('EXECUTION_BUNDLE_PLAN_MISMATCH', message);
}

export function assertExecutionBundleMatchesPlan(
  bundle: ExecutionBundle,
  plan: ExecutionBundlePlanContext,
): void {
  if (bundle.runContractDigest !== plan.digests.runContractDigest
      || bundle.executionPlanDigest !== plan.digests.executionPlanDigest
      || bundle.executionPlanDigest !== plan.execution.executionPlanDigest
      || bundle.datasetRevisionDigest !== plan.digests.datasetRevisionDigest
      || bundle.executionInputDigest !== plan.digests.executionInputDigest
      || bundle.executionInputDigest !== plan.execution.executionInputDigest) {
    planMismatch('ExecutionBundle parent digests do not match the sealed RunPlan.');
  }

  const planned = derivePlannedExecutionCoordinates(plan);
  if (bundle.coverage.planned !== planned.length) {
    planMismatch('ExecutionBundle planned coverage does not match the sealed coordinate universe.');
  }
  const plannedByCoordinate = new Map(
    planned.map((coordinate) => [coordinateKey(coordinate), coordinate]),
  );
  const recordsByCoordinate = new Map(
    bundle.records.map((record) => [coordinateKey(record), record]),
  );
  const runtimesByTarget = new Map<string, unknown>();
  for (const runtime of plan.execution.runtimes) {
    if (runtime.runtimeKind !== 'executor') continue;
    if (runtimesByTarget.has(runtime.referenceId)) {
      planMismatch('ExecutionPlan contains duplicate executor Runtime bindings.');
    }
    runtimesByTarget.set(runtime.referenceId, runtime.identity);
  }

  let invocationCount = 0;
  for (const record of bundle.records) {
    const expected = plannedByCoordinate.get(coordinateKey(record));
    if (expected === undefined) {
      planMismatch('ExecutionBundle contains a coordinate outside the sealed ExecutionPlan.');
    }
    if (record.trialId !== expected.trialId
        || record.trialSeed !== expected.trialSeed
        || record.schedulingBlockId !== expected.schedulingBlockId
        || canonicalizeJson(record.samplingUnitIds)
          !== canonicalizeJson(expected.samplingUnitIds)) {
      planMismatch('ExecutionRecord identities do not match their sealed derivation.');
    }
    const runtime = runtimesByTarget.get(record.targetId);
    if (runtime === undefined
        || canonicalizeJson(record.runtime) !== canonicalizeJson(runtime)) {
      planMismatch('ExecutionRecord Runtime does not match its sealed Target binding.');
    }
    if (record.executionStatus === 'budget-censored') continue;
    if (record.cache.cacheStatus !== 'replay'
        && record.cache.cacheStatus !== 'transparent-hit') {
      invocationCount += record.attempts.length;
    }
    if (record.attempts.length > plan.execution.policy.retry.maxAttempts) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_RETRY_POLICY_INVALID',
        'ExecutionRecord exceeds the sealed maximum attempt count.',
      );
    }
    for (const attempt of record.attempts.slice(0, -1)) {
      if (attempt.attemptStatus !== 'failed'
          || !plan.execution.policy.retry.retryableErrorCodes.includes(attempt.error.code)) {
        throw new ExecutionBundleValidationError(
          'EXECUTION_BUNDLE_RETRY_POLICY_INVALID',
          'A non-terminal attempt must be a retryable failure under the sealed policy.',
        );
      }
    }
  }
  const maxInvocations = plan.execution.policy.budget.maxTargetInvocations;
  if (maxInvocations !== undefined && invocationCount > maxInvocations) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_RETRY_POLICY_INVALID',
      'ExecutionBundle exceeds the sealed target invocation budget.',
    );
  }

  const plannedByBlock = new Map<string, PlannedExecutionCoordinate[]>();
  for (const coordinate of planned) {
    const block = plannedByBlock.get(coordinate.schedulingBlockId) ?? [];
    block.push(coordinate);
    plannedByBlock.set(coordinate.schedulingBlockId, block);
  }
  for (const record of bundle.records) {
    if (record.executionStatus !== 'budget-censored') continue;
    const block = plannedByBlock.get(record.schedulingBlockId);
    if (block === undefined || block.some((coordinate) => (
      recordsByCoordinate.get(coordinateKey(coordinate))?.executionStatus
        !== 'budget-censored'
    ))) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID',
        'Every coordinate in a budget-censored scheduling block must be censored together.',
      );
    }
  }
}

export function parseExecutionBundleDocument(value: unknown): ExecutionBundle {
  const bundle = parseWireDocument(ExecutionBundleSchema, value);
  assertExecutionBundleSemantics(bundle);
  if (digestArtifactPayload(bundle, 'bundleDigest') !== bundle.bundleDigest) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_DIGEST_MISMATCH',
      'ExecutionBundle digest does not match its canonical payload.',
    );
  }
  return bundle;
}

export function parseExecutionBundle(
  value: unknown,
  plan: ExecutionBundlePlanContext,
): ExecutionBundle {
  const bundle = parseExecutionBundleDocument(value);
  assertExecutionBundleMatchesPlan(bundle, plan);
  return bundle;
}
