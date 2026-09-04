import {
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  MeasurementPolicySchema,
  deepFreezeCanonicalJson,
  type MeasurementPolicy,
} from '../../eval-core/contracts/index.js';

export interface MeasurementPolicyBuilderInput {
  readonly maxConcurrency?: number;
  readonly executionTimeoutMs?: number;
  readonly evaluationTimeoutMs?: number;
  readonly maxInvocations?: number;
  readonly failureMode?: 'continue' | 'fail-fast';
  readonly maximumClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  readonly eventDelivery?: MeasurementEventDeliveryInput;
}

export type MeasurementEventDeliveryInput =
  | Readonly<{ writerMode: 'disabled'; writerFailureMode?: 'ignore' }>
  | Readonly<{
      writerMode: 'optional';
      writerFailureMode?: 'ignore' | 'fail-run';
    }>
  | Readonly<{ writerMode: 'required'; writerFailureMode?: 'fail-run' }>;

/** Builds a complete, serializable Core policy with every default sealed into the result. */
export function createMeasurementPolicy(
  input: Readonly<MeasurementPolicyBuilderInput> = {},
): MeasurementPolicy {
  const maxConcurrency = input.maxConcurrency ?? 4;
  const maxInvocations = input.maxInvocations ?? 10_000;
  const eventDelivery = input.eventDelivery ?? { writerMode: 'disabled' as const };
  const writerFailureMode = eventDelivery.writerFailureMode
    ?? (eventDelivery.writerMode === 'required' ? 'fail-run' : 'ignore');
  if ((eventDelivery.writerMode === 'disabled' && writerFailureMode !== 'ignore')
      || (eventDelivery.writerMode === 'required' && writerFailureMode !== 'fail-run')) {
    throw new TypeError('EventWriter mode and failure mode are inconsistent.');
  }
  return deepFreezeCanonicalJson(MeasurementPolicySchema.parse({
    schemaVersion: MEASUREMENT_POLICY_SCHEMA_VERSION,
    execution: {
      maxConcurrency,
      ...(input.executionTimeoutMs === undefined
        ? {}
        : { timeoutMs: input.executionTimeoutMs }),
    },
    retry: {
      maxAttempts: 1,
      retryableErrorCodes: [],
      backoff: { backoffKind: 'none', initialDelayMs: 0 },
    },
    budget: {
      run: { maxInvocations },
      stages: {
        execution: { maxInvocations },
        evaluation: { maxInvocations },
      },
      coordinate: {},
      attempt: {},
      providerCostAdmission: {
        admissionMode: 'bounded-overshoot',
        unknownCostMode: 'mark-unverifiable',
      },
    },
    evaluation: {
      maxConcurrency,
      ...(input.evaluationTimeoutMs === undefined
        ? {}
        : { timeoutMs: input.evaluationTimeoutMs }),
      retry: {
        maxAttempts: 1,
        retryableErrorCodes: [],
        backoff: { backoffKind: 'none', initialDelayMs: 0 },
      },
    },
    cache: { executionMode: 'disabled', evaluationMode: 'disabled' },
    evidence: {
      output: 'full',
      trace: 'full',
      evidence: 'full',
      maximumClassification: input.maximumClassification ?? 'gold',
    },
    failure: { failureMode: input.failureMode ?? 'continue' },
    eventDelivery: {
      writerMode: eventDelivery.writerMode,
      backpressureMode: 'block',
      writerFailureMode,
    },
  }));
}
