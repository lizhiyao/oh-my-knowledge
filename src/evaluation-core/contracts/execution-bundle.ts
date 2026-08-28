import {
  ExecutionBundleSchema,
  type ExecutionBundle,
  type ExecutionRecord,
} from './artifacts.js';
import type { CapturedContent } from './common.js';
import { deriveAttemptId, deriveTrialId } from './execution-identities.js';
import { digestArtifactPayload } from './digests.js';
import { parseWireDocument, type Sha256Digest } from './json.js';

export type ExecutionBundleValidationErrorCode =
  | 'EXECUTION_BUNDLE_DUPLICATE_COORDINATE'
  | 'EXECUTION_BUNDLE_IDENTITY_MISMATCH'
  | 'EXECUTION_BUNDLE_RECORD_ORDER_INVALID'
  | 'EXECUTION_BUNDLE_ATTEMPT_ORDER_INVALID'
  | 'EXECUTION_BUNDLE_BLOCK_ATOMICITY_INVALID'
  | 'EXECUTION_BUNDLE_COVERAGE_INVALID'
  | 'EXECUTION_BUNDLE_STATUS_INVALID'
  | 'EXECUTION_BUNDLE_REPLAYABILITY_INVALID'
  | 'EXECUTION_BUNDLE_DIGEST_MISMATCH';

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
      && (coverage.budgetCensored === 0 || coverage.notStarted !== 0)) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A budget-exhausted ExecutionBundle must classify every unstarted coordinate as budget-censored.',
    );
  }
  if (status === 'cancelled'
      && coverage.cancelled + coverage.notStarted === 0) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A cancelled ExecutionBundle must expose cancelled or unstarted coordinates.',
    );
  }
  if (status === 'failed'
      && coverage.failed + coverage.cancelled + coverage.notStarted === 0) {
    throw new ExecutionBundleValidationError(
      'EXECUTION_BUNDLE_STATUS_INVALID',
      'A failed ExecutionBundle must expose failed, cancelled, or unstarted coordinates.',
    );
  }
}

function isInline(content: CapturedContent | undefined): boolean {
  return content?.contentKind === 'inline';
}

function isResolvable(content: CapturedContent | undefined): boolean {
  return content?.contentKind === 'inline' || content?.contentKind === 'descriptor';
}

function assertReplayability(bundle: ExecutionBundle): void {
  if (bundle.replayability === 'summary-only') return;
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
      || (record.trace !== undefined && !isInline(record.trace)))) {
      throw new ExecutionBundleValidationError(
        'EXECUTION_BUNDLE_REPLAYABILITY_INVALID',
        'A self-contained ExecutionBundle requires inline completed outputs and traces.',
      );
    }
    return;
  }
  const contents = completed.flatMap((record) => [record.output, record.trace])
    .filter((content): content is CapturedContent => content !== undefined);
  if (completed.some((record) => !isResolvable(record.output)
      || (record.trace !== undefined && !isResolvable(record.trace)))
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

export function parseExecutionBundle(value: unknown): ExecutionBundle {
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
