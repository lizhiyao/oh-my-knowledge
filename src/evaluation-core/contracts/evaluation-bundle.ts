import {
  EvaluationBundleSchema,
  type EvaluationBundle,
  type EvaluationRecord,
  type ExecutionBundle,
  type ExecutionRecord,
  type MetricObservation,
} from './artifacts.js';
import type { CapturedContent } from './common.js';
import {
  deriveEvaluationAttemptId,
  deriveEvaluationId,
  deriveMetricObservationId,
  derivePlannedEvaluationCoordinates,
  type PlannedEvaluationCoordinate,
} from './evaluation-identities.js';
import {
  parseExecutionBundle,
  type ExecutionBundlePlanContext,
} from './execution-bundle.js';
import { digestArtifactPayload } from './digests.js';
import {
  canonicalizeJson,
  digestCanonicalJson,
  parseWireDocument,
  type Sha256Digest,
} from './json.js';

export type EvaluationBundleValidationErrorCode =
  | 'EVALUATION_BUNDLE_DUPLICATE_COORDINATE'
  | 'EVALUATION_BUNDLE_IDENTITY_MISMATCH'
  | 'EVALUATION_BUNDLE_RECORD_ORDER_INVALID'
  | 'EVALUATION_BUNDLE_ATTEMPT_ORDER_INVALID'
  | 'EVALUATION_BUNDLE_OBSERVATION_INVALID'
  | 'EVALUATION_BUNDLE_COVERAGE_INVALID'
  | 'EVALUATION_BUNDLE_STATUS_INVALID'
  | 'EVALUATION_BUNDLE_REPLAYABILITY_INVALID'
  | 'EVALUATION_BUNDLE_DIGEST_MISMATCH'
  | 'EVALUATION_BUNDLE_PLAN_MISMATCH'
  | 'EVALUATION_BUNDLE_SOURCE_MISMATCH'
  | 'EVALUATION_BUNDLE_RETRY_POLICY_INVALID';

export class EvaluationBundleValidationError extends TypeError {
  readonly code: EvaluationBundleValidationErrorCode;

  constructor(code: EvaluationBundleValidationErrorCode, message: string) {
    super(message);
    this.name = 'EvaluationBundleValidationError';
    this.code = code;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareRecords(left: EvaluationRecord, right: EvaluationRecord): number {
  return compareStrings(left.targetId, right.targetId)
    || compareStrings(left.sampleId, right.sampleId)
    || left.trialIndex - right.trialIndex
    || compareStrings(left.evaluatorId, right.evaluatorId);
}

function coordinateKey(coordinate: {
  targetId: string;
  sampleId: string;
  trialIndex: number;
  evaluatorId: string;
}): string {
  return canonicalizeJson([
    coordinate.targetId,
    coordinate.sampleId,
    coordinate.trialIndex,
    coordinate.evaluatorId,
  ]);
}

function trialKey(coordinate: {
  targetId: string;
  sampleId: string;
  trialIndex: number;
}): string {
  return canonicalizeJson([
    coordinate.targetId,
    coordinate.sampleId,
    coordinate.trialIndex,
  ]);
}

function assertCanonicalRecordOrder(records: readonly EvaluationRecord[]): void {
  for (let index = 1; index < records.length; index += 1) {
    const order = compareRecords(records[index - 1], records[index]);
    if (order >= 0) {
      throw new EvaluationBundleValidationError(
        order === 0
          ? 'EVALUATION_BUNDLE_DUPLICATE_COORDINATE'
          : 'EVALUATION_BUNDLE_RECORD_ORDER_INVALID',
        order === 0
          ? 'EvaluationBundle contains a duplicate evaluation coordinate.'
          : 'EvaluationBundle records must use canonical target/sample/trial/evaluator order.',
      );
    }
  }
}

function assertRecordIdentities(bundle: EvaluationBundle): void {
  const evaluationIds = new Set<string>();
  const attemptIds = new Set<string>();
  const observationIds = new Set<string>();
  for (const record of bundle.records) {
    const expectedEvaluationId = deriveEvaluationId({
      evaluationPlanDigest: bundle.evaluationPlanDigest as Sha256Digest,
      trialId: record.trialId as Sha256Digest,
      evaluatorId: record.evaluatorId,
    });
    if (record.evaluationId !== expectedEvaluationId
        || evaluationIds.has(record.evaluationId)) {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_IDENTITY_MISMATCH',
        'EvaluationRecord identity does not match its canonical coordinate.',
      );
    }
    evaluationIds.add(record.evaluationId);
    if (record.evaluationStatus === 'not-evaluated') continue;

    for (let index = 0; index < record.attempts.length; index += 1) {
      const attempt = record.attempts[index];
      const expectedNumber = index + 1;
      if (attempt.attemptNumber !== expectedNumber) {
        throw new EvaluationBundleValidationError(
          'EVALUATION_BUNDLE_ATTEMPT_ORDER_INVALID',
          'Evaluation attempts must be ordered consecutively from one.',
        );
      }
      const expectedAttemptId = deriveEvaluationAttemptId({
        evaluationId: record.evaluationId as Sha256Digest,
        attemptNumber: attempt.attemptNumber,
      });
      if (attempt.attemptId !== expectedAttemptId || attemptIds.has(attempt.attemptId)) {
        throw new EvaluationBundleValidationError(
          'EVALUATION_BUNDLE_IDENTITY_MISMATCH',
          'EvaluationAttempt identity does not match its evaluation and attempt number.',
        );
      }
      attemptIds.add(attempt.attemptId);
      if (index < record.attempts.length - 1 && attempt.attemptStatus !== 'failed') {
        throw new EvaluationBundleValidationError(
          'EVALUATION_BUNDLE_ATTEMPT_ORDER_INVALID',
          'Only a failed EvaluationAttempt may be followed by another attempt.',
        );
      }
    }
    const terminalAttempt = record.attempts.at(-1);
    if (terminalAttempt?.attemptStatus !== record.evaluationStatus) {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_ATTEMPT_ORDER_INVALID',
        'The final attempt status must match the EvaluationRecord status.',
      );
    }

    if (record.evaluationStatus !== 'completed') continue;
    const metricIds = new Set<string>();
    for (const observation of record.observations) {
      const expectedObservationId = deriveMetricObservationId({
        evaluationId: record.evaluationId as Sha256Digest,
        metricId: observation.metricId,
      });
      if (observation.observationId !== expectedObservationId
          || observationIds.has(observation.observationId)) {
        throw new EvaluationBundleValidationError(
          'EVALUATION_BUNDLE_IDENTITY_MISMATCH',
          'MetricObservation identity does not match its evaluation and metric.',
        );
      }
      if (metricIds.has(observation.metricId)) {
        throw new EvaluationBundleValidationError(
          'EVALUATION_BUNDLE_OBSERVATION_INVALID',
          'A completed EvaluationRecord cannot contain duplicate metric observations.',
        );
      }
      metricIds.add(observation.metricId);
      observationIds.add(observation.observationId);
    }
  }
}

function assertCoverage(bundle: EvaluationBundle): void {
  const { coverage } = bundle;
  if (coverage.planned !== coverage.eligible + coverage.sourceUnavailable
      || coverage.eligible !== coverage.started + coverage.notStarted
      || coverage.started !== coverage.completed + coverage.failed + coverage.cancelled
      || bundle.records.length !== coverage.started + coverage.sourceUnavailable) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_COVERAGE_INVALID',
      'EvaluationBundle coverage counters are not internally consistent.',
    );
  }
  const actual = { completed: 0, failed: 0, cancelled: 0, sourceUnavailable: 0 };
  for (const record of bundle.records) {
    if (record.evaluationStatus === 'completed') actual.completed += 1;
    else if (record.evaluationStatus === 'failed') actual.failed += 1;
    else if (record.evaluationStatus === 'cancelled') actual.cancelled += 1;
    else actual.sourceUnavailable += 1;
  }
  if (actual.completed !== coverage.completed
      || actual.failed !== coverage.failed
      || actual.cancelled !== coverage.cancelled
      || actual.sourceUnavailable !== coverage.sourceUnavailable) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_COVERAGE_INVALID',
      'EvaluationBundle coverage counters do not match its records.',
    );
  }
}

function assertStatus(bundle: EvaluationBundle): void {
  const { evaluationBundleStatus: status, coverage, terminationReasonCode } = bundle;
  if (status === 'completed') {
    if (terminationReasonCode !== undefined
        || coverage.notStarted !== 0
        || coverage.cancelled !== 0) {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_STATUS_INVALID',
        'A completed EvaluationBundle must classify every eligible coordinate.',
      );
    }
    return;
  }
  if (terminationReasonCode === undefined) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_STATUS_INVALID',
      'A non-completed EvaluationBundle requires a termination reason code.',
    );
  }
  if (status === 'cancelled'
      && coverage.eligible > 0
      && coverage.cancelled + coverage.notStarted === 0) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_STATUS_INVALID',
      'A cancelled EvaluationBundle must expose cancelled or unstarted coordinates.',
    );
  }
}

function contents(record: EvaluationRecord): CapturedContent[] {
  if (record.evaluationStatus !== 'completed') {
    return record.evaluationStatus === 'not-evaluated' || record.evidence === undefined
      ? []
      : [record.evidence];
  }
  return [
    ...(record.evidence === undefined ? [] : [record.evidence]),
    ...record.observations.flatMap((observation) => (
      observation.evidence === undefined ? [] : [observation.evidence]
    )),
    ...record.observations.flatMap((observation) => (
      observation.observationStatus === 'invalid' && observation.invalidValue !== undefined
        ? [observation.invalidValue]
        : []
    )),
  ];
}

function assertReplayability(bundle: EvaluationBundle): void {
  if (bundle.replayability === 'summary-only') return;
  const captured = bundle.records.flatMap(contents);
  if (bundle.replayability === 'self-contained') {
    if (captured.some((content) => content.contentKind !== 'inline')) {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_REPLAYABILITY_INVALID',
        'A self-contained EvaluationBundle requires all captured evidence to be inline.',
      );
    }
    return;
  }
  if (captured.some((content) => content.contentKind === 'digest-only')
      || !captured.some((content) => content.contentKind === 'descriptor')) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_REPLAYABILITY_INVALID',
      'A resolvable EvaluationBundle requires inline or descriptor evidence and a descriptor.',
    );
  }
}

export function assertEvaluationBundleSemantics(bundle: EvaluationBundle): void {
  assertCanonicalRecordOrder(bundle.records);
  assertRecordIdentities(bundle);
  assertCoverage(bundle);
  assertStatus(bundle);
  assertReplayability(bundle);
}

export interface EvaluationBundlePlanContext
  extends ExecutionBundlePlanContext {
  evaluation: {
    evaluationPlanDigest: string;
    executionPlanDigest: string;
    evaluationInputDigest: string;
    samples: readonly {
      sampleId: string;
      input: unknown;
      executionContext?: unknown;
      expected?: unknown;
      evaluationContext?: unknown;
    }[];
    evaluators: readonly {
      evaluatorId: string;
      metricIds: readonly string[];
    }[];
    metrics: readonly {
      metricId: string;
      valueType: MetricObservation['valueType'];
      scope: 'sample' | 'target' | 'comparison' | 'run';
      scale?: { min?: number; max?: number; target?: number };
    }[];
    runtimes: readonly {
      runtimeKind: 'executor' | 'evaluator' | 'analysis';
      referenceId: string;
      identity: unknown;
    }[];
    policy: {
      runtime: {
        retry: {
          maxAttempts: number;
          retryableErrorCodes: readonly string[];
        };
        budget: { maxEvaluatorInvocations?: number };
      };
    };
  };
  digests: ExecutionBundlePlanContext['digests'] & {
    evaluationInputDigest: string;
    evaluationPlanDigest: string;
  };
}

function planMismatch(message: string): never {
  throw new EvaluationBundleValidationError('EVALUATION_BUNDLE_PLAN_MISMATCH', message);
}

function assertObservation(
  observation: MetricObservation,
  metric: EvaluationBundlePlanContext['evaluation']['metrics'][number],
): void {
  if (observation.valueType !== metric.valueType || metric.scope !== 'sample') {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_OBSERVATION_INVALID',
      'MetricObservation type and scope must match the sealed sample metric.',
    );
  }
  if (observation.observationStatus !== 'observed'
      || observation.valueType !== 'numeric'
      || metric.scale === undefined) return;
  if ((metric.scale.min !== undefined && observation.value < metric.scale.min)
      || (metric.scale.max !== undefined && observation.value > metric.scale.max)) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_OBSERVATION_INVALID',
      'Observed numeric metric value falls outside its sealed scale.',
    );
  }
}

function assertRecordAgainstPlan(
  record: EvaluationRecord,
  expected: PlannedEvaluationCoordinate,
  plan: EvaluationBundlePlanContext,
  executionRecord: ExecutionRecord,
  runtime: unknown,
): number {
  if (record.trialId !== expected.trialId
      || record.evaluationId !== expected.evaluationId) {
    planMismatch('EvaluationRecord identities do not match their sealed derivation.');
  }
  if (canonicalizeJson(record.runtime) !== canonicalizeJson(runtime)) {
    planMismatch('EvaluationRecord Runtime does not match its sealed Evaluator binding.');
  }
  const sourceRecordDigest = digestCanonicalJson(executionRecord);
  if (record.sourceRecordDigest !== undefined
      && record.sourceRecordDigest !== sourceRecordDigest) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_SOURCE_MISMATCH',
      'EvaluationRecord source digest does not match its ExecutionRecord.',
    );
  }
  if (executionRecord.executionStatus !== 'completed'
      && record.evaluationStatus !== 'not-evaluated') {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_SOURCE_MISMATCH',
      'A non-completed ExecutionRecord cannot produce an active evaluation.',
    );
  }
  if (record.evaluationStatus === 'not-evaluated') return 0;

  const evaluator = plan.evaluation.evaluators.find(
    (candidate) => candidate.evaluatorId === record.evaluatorId,
  );
  if (evaluator === undefined) planMismatch('EvaluationRecord refers to an unknown Evaluator.');
  if (record.attempts.length > plan.evaluation.policy.runtime.retry.maxAttempts) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_RETRY_POLICY_INVALID',
      'EvaluationRecord exceeds the sealed maximum attempt count.',
    );
  }
  for (const attempt of record.attempts.slice(0, -1)) {
    if (attempt.attemptStatus !== 'failed'
        || !plan.evaluation.policy.runtime.retry.retryableErrorCodes
          .includes(attempt.error.code)) {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_RETRY_POLICY_INVALID',
        'A non-terminal evaluation attempt must be retryable under the sealed policy.',
      );
    }
  }
  if (record.evaluationStatus === 'completed') {
    const metricsById = new Map(plan.evaluation.metrics.map((metric) => [metric.metricId, metric]));
    if (record.observations.length !== evaluator.metricIds.length
        || record.observations.some((observation, index) => (
          observation.metricId !== evaluator.metricIds[index]
        ))) {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_OBSERVATION_INVALID',
        'Completed observations must exactly follow the Evaluator metric declaration order.',
      );
    }
    for (const observation of record.observations) {
      const metric = metricsById.get(observation.metricId);
      if (metric === undefined) planMismatch('Evaluator refers to an unknown Metric.');
      assertObservation(observation, metric);
    }
  }
  return record.cache.cacheStatus === 'replay'
    || record.cache.cacheStatus === 'transparent-hit'
    ? 0
    : record.attempts.length;
}

export function assertEvaluationBundleMatchesPlan(
  bundle: EvaluationBundle,
  plan: EvaluationBundlePlanContext,
  source: ExecutionBundle,
): void {
  if (bundle.runContractDigest !== plan.digests.runContractDigest
      || bundle.evaluationPlanDigest !== plan.digests.evaluationPlanDigest
      || bundle.evaluationPlanDigest !== plan.evaluation.evaluationPlanDigest
      || bundle.evaluationInputDigest !== plan.digests.evaluationInputDigest
      || bundle.evaluationInputDigest !== plan.evaluation.evaluationInputDigest
      || plan.evaluation.executionPlanDigest !== source.executionPlanDigest
      || bundle.executionBundleDigest !== source.bundleDigest) {
    planMismatch('EvaluationBundle parent digests do not match its sealed inputs.');
  }

  const planned = derivePlannedEvaluationCoordinates(plan);
  if (bundle.coverage.planned !== planned.length) {
    planMismatch('EvaluationBundle planned coverage does not match the sealed universe.');
  }
  const plannedByCoordinate = new Map(
    planned.map((coordinate) => [coordinateKey(coordinate), coordinate]),
  );
  const recordsByCoordinate = new Map(
    bundle.records.map((record) => [coordinateKey(record), record]),
  );
  const executionByTrial = new Map(
    source.records.map((record) => [trialKey(record), record]),
  );
  const runtimesByEvaluator = new Map<string, unknown>();
  for (const runtime of plan.evaluation.runtimes) {
    if (runtime.runtimeKind !== 'evaluator') continue;
    if (runtimesByEvaluator.has(runtime.referenceId)) {
      planMismatch('EvaluationPlan contains duplicate evaluator Runtime bindings.');
    }
    runtimesByEvaluator.set(runtime.referenceId, runtime.identity);
  }

  let invocationCount = 0;
  for (const record of bundle.records) {
    const expected = plannedByCoordinate.get(coordinateKey(record));
    if (expected === undefined) planMismatch('EvaluationBundle contains an unknown coordinate.');
    const executionRecord = executionByTrial.get(trialKey(record));
    if (executionRecord === undefined) {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_SOURCE_MISMATCH',
        'EvaluationRecord has no corresponding ExecutionRecord.',
      );
    }
    const runtime = runtimesByEvaluator.get(record.evaluatorId);
    if (runtime === undefined) planMismatch('EvaluationRecord has no sealed Runtime binding.');
    invocationCount += assertRecordAgainstPlan(
      record,
      expected,
      plan,
      executionRecord,
      runtime,
    );
  }
  const maxInvocations = plan.evaluation.policy.runtime.budget.maxEvaluatorInvocations;
  if (maxInvocations !== undefined && invocationCount > maxInvocations) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_RETRY_POLICY_INVALID',
      'EvaluationBundle exceeds the sealed evaluator invocation budget.',
    );
  }
  for (const coordinate of planned) {
    const executionRecord = executionByTrial.get(trialKey(coordinate));
    if ((executionRecord === undefined || executionRecord.executionStatus !== 'completed')
        && recordsByCoordinate.get(coordinateKey(coordinate))?.evaluationStatus
          !== 'not-evaluated') {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_SOURCE_MISMATCH',
        'Every unavailable execution source must be represented as not-evaluated.',
      );
    }
  }
}

export function parseEvaluationBundleDocument(value: unknown): EvaluationBundle {
  const bundle = parseWireDocument(EvaluationBundleSchema, value);
  assertEvaluationBundleSemantics(bundle);
  if (digestArtifactPayload(bundle, 'bundleDigest') !== bundle.bundleDigest) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_DIGEST_MISMATCH',
      'EvaluationBundle digest does not match its canonical payload.',
    );
  }
  return bundle;
}

export function parseEvaluationBundle(
  value: unknown,
  plan: EvaluationBundlePlanContext,
  sourceValue: unknown,
): EvaluationBundle {
  const source = parseExecutionBundle(sourceValue, plan);
  const bundle = parseEvaluationBundleDocument(value);
  assertEvaluationBundleMatchesPlan(bundle, plan, source);
  return bundle;
}
