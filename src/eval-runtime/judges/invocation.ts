import {
  IdentifierSchema,
  RuntimeIdentitySchema,
  UsageRecordSchema,
  deepFreezeCanonicalJson,
  type RuntimeIdentity,
  type UsageRecord,
} from '../../eval-core/contracts/index.js';
import { EvaluationPortFailure } from '../../eval-core/evaluation/index.js';

export type OmkLlmJudgeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OmkLlmJudgeInvocationRequest {
  readonly executorId: string;
  readonly model: string;
  readonly effort?: OmkLlmJudgeEffort;
  readonly system: string;
  readonly prompt: string;
  readonly promptId: string;
  readonly promptHash: string;
  readonly signal: AbortSignal;
}

export type OmkLlmJudgeInvocationResult =
  | {
      readonly invocationStatus: 'completed';
      readonly output: string;
      readonly usage?: UsageRecord;
    }
  | {
      readonly invocationStatus: 'failed';
      /** Stable, non-sensitive provider failure category. */
      readonly reasonCode: string;
      readonly usage?: UsageRecord;
    };

/**
 * Host-owned provider boundary. It performs exactly one invocation and honors the
 * supplied AbortSignal; retry, timeout, budget, and cache remain Core-owned.
 */
export interface OmkLlmJudgeInvocationPort {
  readonly identity: RuntimeIdentity;
  readonly providerCost: {
    readonly reporting: 'unsupported' | 'optional' | 'required';
    readonly trustedUpperBound?: { readonly amount: number; readonly currency: string };
  };
  invoke(
    request: Readonly<OmkLlmJudgeInvocationRequest>,
  ): Promise<OmkLlmJudgeInvocationResult>;
}

function fail(code: string, message: string, usage?: UsageRecord): never {
  throw new EvaluationPortFailure({ code, stage: 'evaluation', message }, usage);
}

export function parseLlmJudgeUsage(value: UsageRecord | undefined): UsageRecord | undefined {
  if (value === undefined) return undefined;
  const parsed = UsageRecordSchema.safeParse(value);
  if (!parsed.success) {
    return fail(
      'omk-llm-judge-usage-invalid',
      'LLM judge returned invalid usage telemetry.',
    );
  }
  return parsed.data;
}

/** Removes provider-private details while retaining measured accounting facts. */
export function redactLlmJudgeFailureUsage(
  value: UsageRecord | undefined,
): UsageRecord | undefined {
  const measured = parseLlmJudgeUsage(value);
  if (measured === undefined) return undefined;
  return {
    ...(measured.inputTokens === undefined ? {} : { inputTokens: measured.inputTokens }),
    ...(measured.outputTokens === undefined ? {} : { outputTokens: measured.outputTokens }),
    ...(measured.totalTokens === undefined ? {} : { totalTokens: measured.totalTokens }),
    ...(measured.providerCost === undefined ? {} : { providerCost: measured.providerCost }),
  };
}

/** Captures identity, cost declaration, and method receiver to prevent split-brain mutation. */
export function captureLlmJudgeInvocationPort(
  value: OmkLlmJudgeInvocationPort,
): OmkLlmJudgeInvocationPort {
  const identity = RuntimeIdentitySchema.safeParse(value?.identity);
  const providerCost = value?.providerCost;
  const trustedUpperBound = providerCost?.trustedUpperBound;
  if (!identity.success
      || typeof value?.invoke !== 'function'
      || !['unsupported', 'optional', 'required'].includes(String(providerCost?.reporting))
      || (trustedUpperBound !== undefined
        && (providerCost.reporting !== 'required'
          || !Number.isFinite(trustedUpperBound.amount)
          || trustedUpperBound.amount < 0
          || !/^[A-Z]{3}$/.test(trustedUpperBound.currency)))) {
    return fail(
      'omk-llm-judge-provider-port-invalid',
      'LLM judge invocation port is invalid.',
    );
  }
  const invoke = value.invoke;
  const identitySnapshot = deepFreezeCanonicalJson(identity.data);
  const providerCostSnapshot = Object.freeze({
    reporting: providerCost.reporting,
    ...(trustedUpperBound === undefined ? {} : {
      trustedUpperBound: Object.freeze({
        amount: trustedUpperBound.amount,
        currency: trustedUpperBound.currency,
      }),
    }),
  });
  const captured: OmkLlmJudgeInvocationPort = {
    identity: identitySnapshot,
    providerCost: providerCostSnapshot,
    invoke: (request: Readonly<OmkLlmJudgeInvocationRequest>) => Reflect.apply(
      invoke,
      captured,
      [request],
    ) as Promise<OmkLlmJudgeInvocationResult>,
  };
  return Object.freeze(captured);
}

export function assertLlmJudgeInvocationResult(
  value: unknown,
): asserts value is OmkLlmJudgeInvocationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'omk-llm-judge-provider-result-invalid',
      'LLM judge invocation port returned an invalid result.',
    );
  }
  const record = value as Record<string, unknown>;
  if (!['completed', 'failed'].includes(String(record.invocationStatus))
      || (record.invocationStatus === 'completed' && typeof record.output !== 'string')
      || (record.invocationStatus === 'failed'
        && (typeof record.reasonCode !== 'string'
          || !IdentifierSchema.safeParse(record.reasonCode).success))) {
    return fail(
      'omk-llm-judge-provider-result-invalid',
      'LLM judge invocation port returned an invalid result.',
    );
  }
}
