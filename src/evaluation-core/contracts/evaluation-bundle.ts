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
  | 'EVALUATION_BUNDLE_RETRY_POLICY_INVALID'
  | 'EVALUATION_BUNDLE_BINDING_CLOSURE_INVALID'
  | 'EVALUATION_BUNDLE_CACHE_POLICY_INVALID'
  | 'EVALUATION_BUNDLE_EVIDENCE_POLICY_INVALID'
  | 'EVALUATION_BUNDLE_PROVENANCE_INVALID';

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

export function evaluationRecordCapturedContents(
  record: EvaluationRecord,
): CapturedContent[] {
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
      observation.metadata === undefined ? [] : [observation.metadata]
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
  const captured = bundle.records.flatMap(evaluationRecordCapturedContents);
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
      inputs: readonly {
        bindingId: string;
        sourceKind: 'output' | 'trace' | 'expected' | 'evaluation-context';
        pointer: string;
      }[];
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
      identity: {
        assuranceLevel: 'verified' | 'declared' | 'unknown';
      };
    }[];
    policy: {
      evaluationCacheMode: 'disabled' | 'reuse';
      evidence: {
        evidence: 'full' | 'reference' | 'digest' | 'none';
        maximumClassification: 'public' | 'sensitive' | 'secret' | 'gold';
      };
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

const CLASSIFICATION_LEVEL = { public: 0, sensitive: 1, secret: 2, gold: 3 } as const;
const TRUST_LEVEL = { untrusted: 0, unknown: 1, declared: 2, verified: 3 } as const;

type EvaluationEvidencePolicy = EvaluationBundlePlanContext['evaluation']['policy']['evidence'];

export function evaluationRecordMatchesEvidencePolicy(
  record: EvaluationRecord,
  policy: EvaluationEvidencePolicy,
): boolean {
  const captured = evaluationRecordCapturedContents(record);
  if (captured.some((content) => (
    CLASSIFICATION_LEVEL[content.classification]
      > CLASSIFICATION_LEVEL[policy.maximumClassification]
  ))) return false;
  if (policy.evidence === 'none') return captured.length === 0;
  const expectedKind = policy.evidence === 'full'
    ? 'inline'
    : policy.evidence === 'reference'
      ? 'descriptor'
      : 'digest-only';
  return captured.every((content) => content.contentKind === expectedKind);
}

function runtimeTrust(
  runtime: EvaluationBundlePlanContext['evaluation']['runtimes'][number]['identity'],
): 'verified' | 'declared' | 'unknown' {
  return runtime.assuranceLevel;
}

function minimumTrust(
  ...values: readonly ('verified' | 'declared' | 'untrusted' | 'unknown')[]
): 'verified' | 'declared' | 'untrusted' | 'unknown' {
  return values.reduce((minimum, value) => (
    TRUST_LEVEL[value] < TRUST_LEVEL[minimum] ? value : minimum
  ), 'verified');
}

function assertTrustAtMost(
  actual: 'verified' | 'declared' | 'untrusted' | 'unknown',
  ceiling: 'verified' | 'declared' | 'untrusted' | 'unknown',
  message: string,
): void {
  if (TRUST_LEVEL[actual] > TRUST_LEVEL[ceiling]) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_PROVENANCE_INVALID',
      message,
    );
  }
}

function pointerResolves(value: unknown, pointer: string): boolean {
  let current = value;
  if (pointer === '') return true;
  for (const encoded of pointer.slice(1).split('/')) {
    const token = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (current === null || typeof current !== 'object') return false;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token) || Number(token) >= current.length) return false;
      current = current[Number(token)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, token)) return false;
      current = (current as Record<string, unknown>)[token];
    }
  }
  return true;
}

type BindingAvailability = 'available' | 'unavailable' | 'indeterminate';

function capturedBindingAvailability(
  content: CapturedContent | undefined,
  pointer: string,
): BindingAvailability {
  if (content === undefined || content.contentKind === 'digest-only') return 'unavailable';
  if (content.contentKind === 'descriptor') return 'indeterminate';
  return pointerResolves(content.value, pointer) ? 'available' : 'unavailable';
}

function bindingClosureAvailability(
  plan: EvaluationBundlePlanContext,
  evaluator: EvaluationBundlePlanContext['evaluation']['evaluators'][number],
  executionRecord: ExecutionRecord,
): BindingAvailability {
  const sample = plan.evaluation.samples.find(
    (candidate) => candidate.sampleId === executionRecord.sampleId,
  );
  if (sample === undefined) planMismatch('EvaluationRecord refers to an unknown sample.');
  let availability: BindingAvailability = 'available';
  for (const input of evaluator.inputs) {
    let binding: BindingAvailability;
    if (input.sourceKind === 'output') {
      binding = executionRecord.executionStatus === 'completed'
        ? capturedBindingAvailability(executionRecord.output, input.pointer)
        : 'unavailable';
    } else if (input.sourceKind === 'trace') {
      binding = executionRecord.executionStatus === 'budget-censored'
        ? 'unavailable'
        : capturedBindingAvailability(executionRecord.trace, input.pointer);
    } else {
      const value = input.sourceKind === 'expected'
        ? sample.expected
        : sample.evaluationContext;
      binding = value !== undefined && pointerResolves(value, input.pointer)
        ? 'available'
        : 'unavailable';
    }
    if (binding === 'unavailable') return 'unavailable';
    if (binding === 'indeterminate') availability = 'indeterminate';
  }
  return availability;
}

function assertCachePolicy(
  record: Exclude<EvaluationRecord, { evaluationStatus: 'not-evaluated' }>,
  mode: EvaluationBundlePlanContext['evaluation']['policy']['evaluationCacheMode'],
): boolean {
  const { cache } = record;
  const noDigests = cache.cacheKeyDigest === undefined && cache.sourceRecordDigest === undefined;
  if (mode === 'disabled') {
    if (cache.cacheStatus !== 'not-used'
        || !noDigests
        || record.provenance.provenanceKind === 'replay') {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_CACHE_POLICY_INVALID',
        'EvaluationRecord cache facts contradict the sealed disabled cache policy.',
      );
    }
    return false;
  }
  if (cache.cacheStatus === 'miss'
      && cache.cacheKeyDigest !== undefined
      && cache.sourceRecordDigest === undefined
      && record.provenance.provenanceKind !== 'replay') return false;
  if ((cache.cacheStatus === 'replay' || cache.cacheStatus === 'transparent-hit')
      && cache.cacheKeyDigest !== undefined
      && cache.sourceRecordDigest !== undefined
      && record.provenance.provenanceKind === 'replay'
      && record.provenance.parentDigests.length === 1
      && record.provenance.parentDigests[0] === cache.sourceRecordDigest) return true;
  throw new EvaluationBundleValidationError(
    'EVALUATION_BUNDLE_CACHE_POLICY_INVALID',
    'EvaluationRecord cache facts do not satisfy the sealed reuse policy.',
  );
}

function assertRecordAgainstPlan(
  record: EvaluationRecord,
  expected: PlannedEvaluationCoordinate,
  plan: EvaluationBundlePlanContext,
  executionRecord: ExecutionRecord,
  runtime: EvaluationBundlePlanContext['evaluation']['runtimes'][number]['identity'],
  sourceTrust: ExecutionBundle['provenance']['trust'],
): number {
  if (record.trialId !== expected.trialId
      || record.evaluationId !== expected.evaluationId) {
    planMismatch('EvaluationRecord identities do not match their sealed derivation.');
  }
  if (canonicalizeJson(record.runtime) !== canonicalizeJson(runtime)) {
    planMismatch('EvaluationRecord Runtime does not match its sealed Evaluator binding.');
  }
  const sourceRecordDigest = digestCanonicalJson(executionRecord);
  if (record.sourceRecordDigest !== sourceRecordDigest) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_SOURCE_MISMATCH',
      'EvaluationRecord source digest does not match its ExecutionRecord.',
    );
  }
  const evaluator = plan.evaluation.evaluators.find(
    (candidate) => candidate.evaluatorId === record.evaluatorId,
  );
  if (evaluator === undefined) planMismatch('EvaluationRecord refers to an unknown Evaluator.');
  assertTrustAtMost(
    record.provenance.trust,
    minimumTrust(
      sourceTrust,
      executionRecord.provenance.trust,
      runtimeTrust(runtime),
    ),
    'EvaluationRecord trust exceeds its source or sealed Runtime assurance.',
  );
  if (executionRecord.executionStatus === 'budget-censored') {
    if (record.evaluationStatus !== 'not-evaluated'
        || record.notEvaluatedReasonCode !== 'execution-budget-censored') {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_SOURCE_MISMATCH',
        'A budget-censored ExecutionRecord requires its canonical not-evaluated fact.',
      );
    }
    return 0;
  }
  const closure = bindingClosureAvailability(plan, evaluator, executionRecord);
  if (record.evaluationStatus === 'not-evaluated') {
    if (record.notEvaluatedReasonCode !== 'evaluator-input-unavailable'
        || closure === 'available') {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_BINDING_CLOSURE_INVALID',
        'A source-backed not-evaluated record requires unavailable evaluator bindings.',
      );
    }
    return 0;
  }
  if (closure === 'unavailable') {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_BINDING_CLOSURE_INVALID',
      'An active EvaluationRecord requires every statically checkable binding.',
    );
  }
  if (!evaluationRecordMatchesEvidencePolicy(record, plan.evaluation.policy.evidence)) {
    throw new EvaluationBundleValidationError(
      'EVALUATION_BUNDLE_EVIDENCE_POLICY_INVALID',
      'EvaluationRecord evidence contradicts the sealed capture or classification policy.',
    );
  }
  const cacheHit = assertCachePolicy(
    record,
    plan.evaluation.policy.evaluationCacheMode,
  );
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
  return cacheHit ? 0 : record.attempts.length;
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
  const runtimesByEvaluator = new Map<
    string,
    EvaluationBundlePlanContext['evaluation']['runtimes'][number]['identity']
  >();
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
      if (record.evaluationStatus !== 'not-evaluated'
          || record.sourceRecordDigest !== undefined
          || record.notEvaluatedReasonCode !== 'execution-record-unavailable') {
        throw new EvaluationBundleValidationError(
          'EVALUATION_BUNDLE_SOURCE_MISMATCH',
          'A missing ExecutionRecord requires its canonical source-less not-evaluated fact.',
        );
      }
      const runtime = runtimesByEvaluator.get(record.evaluatorId);
      if (runtime === undefined) planMismatch('EvaluationRecord has no sealed Runtime binding.');
      if (record.trialId !== expected.trialId
          || record.evaluationId !== expected.evaluationId
          || canonicalizeJson(record.runtime) !== canonicalizeJson(runtime)) {
        planMismatch('Source-less EvaluationRecord does not match its sealed coordinate.');
      }
      assertTrustAtMost(
        record.provenance.trust,
        minimumTrust(source.provenance.trust, runtimeTrust(runtime)),
        'Source-less EvaluationRecord trust exceeds its source or sealed Runtime assurance.',
      );
      continue;
    }
    const runtime = runtimesByEvaluator.get(record.evaluatorId);
    if (runtime === undefined) planMismatch('EvaluationRecord has no sealed Runtime binding.');
    invocationCount += assertRecordAgainstPlan(
      record,
      expected,
      plan,
      executionRecord,
      runtime,
      source.provenance.trust,
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
    if ((executionRecord === undefined || executionRecord.executionStatus === 'budget-censored')
        && recordsByCoordinate.get(coordinateKey(coordinate))?.evaluationStatus
          !== 'not-evaluated') {
      throw new EvaluationBundleValidationError(
        'EVALUATION_BUNDLE_SOURCE_MISMATCH',
        'Every unavailable execution source must be represented as not-evaluated.',
      );
    }
  }
  assertTrustAtMost(
    bundle.provenance.trust,
    minimumTrust(
      source.provenance.trust,
      ...bundle.records.map((record) => record.provenance.trust),
    ),
    'EvaluationBundle trust exceeds its source or record provenance.',
  );
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
