import { derivePlannedExecutionCoordinates } from './execution-identities.js';
import { digestCanonicalJson, type Sha256Digest } from './json.js';

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new TypeError(`${field} must not be empty`);
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

export interface EvaluationIdentityInput {
  evaluationPlanDigest: Sha256Digest;
  trialId: Sha256Digest;
  evaluatorId: string;
  measurement: EvaluatorMeasurementIdentity;
}

export interface EvaluatorMeasurementIdentity {
  instrumentId: string;
  ensembleMemberId: string;
  replicateGroupId: string;
  replicateIndex: number;
}

export function deriveEvaluationId(input: EvaluationIdentityInput): Sha256Digest {
  assertNonEmpty(input.evaluatorId, 'evaluatorId');
  assertNonEmpty(input.measurement.instrumentId, 'measurement.instrumentId');
  assertNonEmpty(input.measurement.ensembleMemberId, 'measurement.ensembleMemberId');
  assertNonEmpty(input.measurement.replicateGroupId, 'measurement.replicateGroupId');
  if (!Number.isSafeInteger(input.measurement.replicateIndex)
      || input.measurement.replicateIndex < 0) {
    throw new TypeError('measurement.replicateIndex must be a non-negative safe integer');
  }
  return digestCanonicalJson({
    derivation: 'omk.evaluation-id/v1',
    evaluationPlanDigest: input.evaluationPlanDigest,
    trialId: input.trialId,
    evaluatorId: input.evaluatorId,
    measurement: input.measurement,
  });
}

export interface EvaluationAttemptIdentityInput {
  evaluationId: Sha256Digest;
  attemptNumber: number;
}

export function deriveEvaluationAttemptId(
  input: EvaluationAttemptIdentityInput,
): Sha256Digest {
  assertPositiveSafeInteger(input.attemptNumber, 'attemptNumber');
  return digestCanonicalJson({
    derivation: 'omk.evaluation-attempt-id/v1',
    evaluationId: input.evaluationId,
    attemptNumber: input.attemptNumber,
  });
}

export interface MetricObservationIdentityInput {
  evaluationId: Sha256Digest;
  metricId: string;
}

export function deriveMetricObservationId(
  input: MetricObservationIdentityInput,
): Sha256Digest {
  assertNonEmpty(input.metricId, 'metricId');
  return digestCanonicalJson({
    derivation: 'omk.metric-observation-id/v1',
    evaluationId: input.evaluationId,
    metricId: input.metricId,
  });
}

export interface EvaluationIdentityPlanContext {
  execution: Parameters<typeof derivePlannedExecutionCoordinates>[0]['execution'];
  evaluation: {
    evaluationPlanDigest: string;
    evaluators: readonly {
      evaluatorId: string;
      applicableSampleIds?: readonly string[];
      measurement: EvaluatorMeasurementIdentity;
    }[];
  };
}

export interface PlannedEvaluationCoordinate {
  targetId: string;
  sampleId: string;
  trialIndex: number;
  trialId: Sha256Digest;
  evaluatorId: string;
  measurement: EvaluatorMeasurementIdentity;
  evaluationId: Sha256Digest;
}

function compareCoordinates(
  left: PlannedEvaluationCoordinate,
  right: PlannedEvaluationCoordinate,
): number {
  if (left.targetId !== right.targetId) return left.targetId < right.targetId ? -1 : 1;
  if (left.sampleId !== right.sampleId) return left.sampleId < right.sampleId ? -1 : 1;
  if (left.trialIndex !== right.trialIndex) return left.trialIndex - right.trialIndex;
  if (left.evaluatorId !== right.evaluatorId) return left.evaluatorId < right.evaluatorId ? -1 : 1;
  return 0;
}

export function derivePlannedEvaluationCoordinates(
  plan: EvaluationIdentityPlanContext,
): PlannedEvaluationCoordinate[] {
  const evaluators = [...plan.evaluation.evaluators]
    .sort((left, right) => left.evaluatorId < right.evaluatorId ? -1 : 1);
  const evaluatorIds = evaluators.map((evaluator) => evaluator.evaluatorId);
  if (new Set(evaluatorIds).size !== evaluatorIds.length) {
    throw new TypeError('evaluation.evaluators must not contain duplicate identifiers');
  }
  return derivePlannedExecutionCoordinates(plan)
    .flatMap((execution) => evaluators
      .filter((evaluator) => evaluator.applicableSampleIds === undefined
        || evaluator.applicableSampleIds.includes(execution.sampleId))
      .map((evaluator) => ({
      targetId: execution.targetId,
      sampleId: execution.sampleId,
      trialIndex: execution.trialIndex,
      trialId: execution.trialId,
      evaluatorId: evaluator.evaluatorId,
      measurement: evaluator.measurement,
      evaluationId: deriveEvaluationId({
        evaluationPlanDigest: plan.evaluation.evaluationPlanDigest as Sha256Digest,
        trialId: execution.trialId,
        evaluatorId: evaluator.evaluatorId,
        measurement: evaluator.measurement,
      }),
      })))
    .sort(compareCoordinates);
}
