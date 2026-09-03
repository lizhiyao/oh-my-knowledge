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
}

/** Builds a complete, serializable Core policy with every default sealed into the result. */
export function createMeasurementPolicy(
  input: Readonly<MeasurementPolicyBuilderInput> = {},
): MeasurementPolicy {
  const maxConcurrency = input.maxConcurrency ?? 4;
  const maxInvocations = input.maxInvocations ?? 10_000;
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
      writerMode: 'disabled',
      backpressureMode: 'block',
      writerFailureMode: 'ignore',
    },
  }));
}
