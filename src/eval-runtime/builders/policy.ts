import { z } from 'zod';
import {
  IdentifierSchema,
  MEASUREMENT_POLICY_SCHEMA_VERSION,
  MeasurementPolicySchema,
  deepFreezeCanonicalJson,
  type MeasurementPolicy,
} from '../../eval-core/contracts/index.js';

export type MeasurementRetryBackoffInput =
  | Readonly<{ backoffKind: 'none' }>
  | Readonly<{ backoffKind: 'fixed'; initialDelayMs: number }>
  | Readonly<{
      backoffKind: 'exponential';
      initialDelayMs: number;
      maxDelayMs?: number;
    }>;

export interface MeasurementRetryPolicyInput {
  /** Includes the first attempt. Omit retry entirely to seal maxAttempts=1. */
  readonly maxAttempts: number;
  readonly retryableErrorCodes: readonly string[];
  readonly backoff: MeasurementRetryBackoffInput;
}

export interface MeasurementStagePolicyInput {
  readonly maxConcurrency?: number;
  readonly timeoutMs?: number;
  readonly retry?: MeasurementRetryPolicyInput;
}

export type MeasurementFailurePolicyInput =
  | Readonly<{ failureMode: 'continue' }>
  | Readonly<{ failureMode: 'fail-fast' }>
  | Readonly<{ failureMode: 'failure-threshold'; maxFailures: number }>;

export interface MeasurementProviderCostLimitInput {
  readonly amount: number;
  readonly currency: string;
}

export interface MeasurementBudgetScopeInput {
  readonly maxInvocations?: number;
  readonly maxActiveDurationMs?: number;
  readonly maxProviderCost?: MeasurementProviderCostLimitInput;
}

export interface MeasurementRunBudgetScopeInput extends MeasurementBudgetScopeInput {
  readonly maxWallClockMs?: number;
}

export interface MeasurementAttemptBudgetScopeInput {
  readonly maxProviderCost?: MeasurementProviderCostLimitInput;
}

export interface MeasurementBudgetPolicyInput {
  readonly run?: MeasurementRunBudgetScopeInput;
  readonly execution?: MeasurementBudgetScopeInput;
  readonly evaluation?: MeasurementBudgetScopeInput;
  readonly coordinate?: MeasurementBudgetScopeInput;
  readonly attempt?: MeasurementAttemptBudgetScopeInput;
  readonly onUnreportedProviderCost?: 'fail-run' | 'mark-unverifiable';
}

export interface MeasurementPolicyBuilderInput {
  readonly execution?: MeasurementStagePolicyInput;
  readonly evaluation?: MeasurementStagePolicyInput;
  readonly budget?: MeasurementBudgetPolicyInput;
  readonly failure?: MeasurementFailurePolicyInput;
  readonly evidence?: Readonly<{
    maximumClassification?: 'public' | 'sensitive' | 'secret' | 'gold';
  }>;
  readonly eventDelivery?: MeasurementEventDeliveryInput;
}

export type MeasurementEventDeliveryInput =
  | Readonly<{ writerMode: 'disabled'; writerFailureMode?: 'ignore' }>
  | Readonly<{
      writerMode: 'optional';
      writerFailureMode?: 'ignore' | 'fail-run';
    }>
  | Readonly<{ writerMode: 'required'; writerFailureMode?: 'fail-run' }>;

const RetryBackoffInputSchema = z.discriminatedUnion('backoffKind', [
  z.object({ backoffKind: z.literal('none') }).strict(),
  z.object({
    backoffKind: z.literal('fixed'),
    initialDelayMs: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    backoffKind: z.literal('exponential'),
    initialDelayMs: z.number().int().nonnegative(),
    maxDelayMs: z.number().int().nonnegative().optional(),
  }).strict(),
]);

const RetryInputSchema = z.object({
  maxAttempts: z.number().int().min(2),
  retryableErrorCodes: z.array(IdentifierSchema).min(1),
  backoff: RetryBackoffInputSchema,
}).strict().superRefine((retry, context) => {
  if (new Set(retry.retryableErrorCodes).size !== retry.retryableErrorCodes.length) {
    context.addIssue({
      code: 'custom',
      path: ['retryableErrorCodes'],
      message: 'retryableErrorCodes must be unique',
    });
  }
  if (retry.backoff.backoffKind === 'exponential'
      && retry.backoff.maxDelayMs !== undefined
      && retry.backoff.maxDelayMs < retry.backoff.initialDelayMs) {
    context.addIssue({
      code: 'custom',
      path: ['backoff', 'maxDelayMs'],
      message: 'maxDelayMs must not be less than initialDelayMs',
    });
  }
});

const StagePolicyInputSchema = z.object({
  maxConcurrency: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retry: RetryInputSchema.optional(),
}).strict();

const FailurePolicyInputSchema = z.discriminatedUnion('failureMode', [
  z.object({ failureMode: z.literal('continue') }).strict(),
  z.object({ failureMode: z.literal('fail-fast') }).strict(),
  z.object({
    failureMode: z.literal('failure-threshold'),
    maxFailures: z.number().int().nonnegative(),
  }).strict(),
]);

const ProviderCostLimitInputSchema = z.object({
  amount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

const BudgetScopeInputSchema = z.object({
  maxInvocations: z.number().int().positive().optional(),
  maxActiveDurationMs: z.number().int().positive().optional(),
  maxProviderCost: ProviderCostLimitInputSchema.optional(),
}).strict();

const RunBudgetScopeInputSchema = BudgetScopeInputSchema.extend({
  maxWallClockMs: z.number().int().positive().optional(),
}).strict();

const BudgetInputSchema = z.object({
  run: RunBudgetScopeInputSchema.optional(),
  execution: BudgetScopeInputSchema.optional(),
  evaluation: BudgetScopeInputSchema.optional(),
  coordinate: BudgetScopeInputSchema.optional(),
  attempt: z.object({
    maxProviderCost: ProviderCostLimitInputSchema.optional(),
  }).strict().optional(),
  onUnreportedProviderCost: z.enum(['fail-run', 'mark-unverifiable']).optional(),
}).strict().superRefine((budget, context) => {
  const currencies = [
    budget.run?.maxProviderCost,
    budget.execution?.maxProviderCost,
    budget.evaluation?.maxProviderCost,
    budget.coordinate?.maxProviderCost,
    budget.attempt?.maxProviderCost,
  ].flatMap((limit) => limit === undefined ? [] : [limit.currency]);
  if (new Set(currencies).size > 1) {
    context.addIssue({
      code: 'custom',
      path: ['run', 'maxProviderCost'],
      message: 'All provider-cost limits in one Run must use the same currency',
    });
  }
});

const EventDeliveryInputSchema = z.discriminatedUnion('writerMode', [
  z.object({
    writerMode: z.literal('disabled'),
    writerFailureMode: z.literal('ignore').optional(),
  }).strict(),
  z.object({
    writerMode: z.literal('optional'),
    writerFailureMode: z.enum(['ignore', 'fail-run']).optional(),
  }).strict(),
  z.object({
    writerMode: z.literal('required'),
    writerFailureMode: z.literal('fail-run').optional(),
  }).strict(),
]);

export const MeasurementPolicyBuilderInputSchema = z.object({
  execution: StagePolicyInputSchema.optional(),
  evaluation: StagePolicyInputSchema.optional(),
  budget: BudgetInputSchema.optional(),
  failure: FailurePolicyInputSchema.optional(),
  evidence: z.object({
    maximumClassification: z.enum(['public', 'sensitive', 'secret', 'gold']).optional(),
  }).strict().optional(),
  eventDelivery: EventDeliveryInputSchema.optional(),
}).strict();

function materializeRetry(
  retry: z.infer<typeof RetryInputSchema> | undefined,
): MeasurementPolicy['retry'] {
  if (retry === undefined) {
    return {
      maxAttempts: 1,
      retryableErrorCodes: [],
      backoff: { backoffKind: 'none', initialDelayMs: 0 },
    };
  }
  return {
    maxAttempts: retry.maxAttempts,
    retryableErrorCodes: [...retry.retryableErrorCodes].sort(),
    backoff: retry.backoff.backoffKind === 'none'
      ? { backoffKind: 'none', initialDelayMs: 0 }
      : retry.backoff.backoffKind === 'fixed'
        ? {
            backoffKind: 'fixed',
            initialDelayMs: retry.backoff.initialDelayMs,
          }
        : {
            backoffKind: 'exponential',
            initialDelayMs: retry.backoff.initialDelayMs,
            ...(retry.backoff.maxDelayMs === undefined
              ? {}
              : { maxDelayMs: retry.backoff.maxDelayMs }),
          },
  };
}

/** Builds a complete, serializable Core policy with every default sealed into the result. */
export function createMeasurementPolicy(
  input: Readonly<MeasurementPolicyBuilderInput> = {},
): MeasurementPolicy {
  const parsed = MeasurementPolicyBuilderInputSchema.parse(structuredClone(input));
  const execution = parsed.execution ?? {};
  const evaluation = parsed.evaluation ?? {};
  const budget = parsed.budget ?? {};
  const eventDelivery = parsed.eventDelivery ?? { writerMode: 'disabled' as const };
  const writerFailureMode = eventDelivery.writerFailureMode
    ?? (eventDelivery.writerMode === 'required' ? 'fail-run' : 'ignore');
  return deepFreezeCanonicalJson(MeasurementPolicySchema.parse({
    schemaVersion: MEASUREMENT_POLICY_SCHEMA_VERSION,
    execution: {
      maxConcurrency: execution.maxConcurrency ?? 4,
      ...(execution.timeoutMs === undefined
        ? {}
        : { timeoutMs: execution.timeoutMs }),
    },
    retry: materializeRetry(execution.retry),
    budget: {
      run: {
        maxInvocations: budget.run?.maxInvocations ?? 10_000,
        ...(budget.run?.maxActiveDurationMs === undefined
          ? {}
          : { maxActiveDurationMs: budget.run.maxActiveDurationMs }),
        ...(budget.run?.maxWallClockMs === undefined
          ? {}
          : { maxWallClockMs: budget.run.maxWallClockMs }),
        ...(budget.run?.maxProviderCost === undefined
          ? {}
          : { maxProviderCost: budget.run.maxProviderCost }),
      },
      stages: {
        execution: budget.execution ?? {},
        evaluation: budget.evaluation ?? {},
      },
      coordinate: budget.coordinate ?? {},
      attempt: budget.attempt ?? {},
      providerCostAdmission: {
        admissionMode: 'bounded-overshoot',
        unknownCostMode: budget.onUnreportedProviderCost ?? 'mark-unverifiable',
      },
    },
    evaluation: {
      maxConcurrency: evaluation.maxConcurrency ?? 4,
      ...(evaluation.timeoutMs === undefined
        ? {}
        : { timeoutMs: evaluation.timeoutMs }),
      retry: materializeRetry(evaluation.retry),
    },
    cache: { executionMode: 'disabled', evaluationMode: 'disabled' },
    evidence: {
      output: 'full',
      trace: 'full',
      evidence: 'full',
      maximumClassification: parsed.evidence?.maximumClassification ?? 'gold',
    },
    failure: parsed.failure ?? { failureMode: 'continue' },
    eventDelivery: {
      writerMode: eventDelivery.writerMode,
      backpressureMode: 'block',
      writerFailureMode,
    },
  }));
}
