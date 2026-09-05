import { z } from 'zod';
import {
  IdentifierSchema,
  JsonValueSchema,
  canonicalizeJson,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import type {
  CustomEvaluator,
  CustomEvaluatorInvocation,
  CustomEvaluatorResult,
} from '../custom-evaluator.js';
import {
  prepareEvaluation,
  type EvaluateInput,
  type EvaluationResult,
  type Executor,
} from '../evaluate.js';

export interface EvaluatorConformanceProbeSources {
  readonly output: JsonValue;
  readonly trace?: JsonValue;
  readonly expected?: JsonValue;
  readonly evaluationContext?: JsonValue;
}

export interface EvaluatorConformanceProbeInput<
  Bindings extends Record<string, JsonValue> = Record<string, JsonValue>,
  Parameters extends JsonValue | undefined = JsonValue | undefined,
> {
  readonly evaluator: CustomEvaluator<Bindings, Parameters>;
  readonly score: EvaluatorConformanceProbeSources & { readonly expectedValue: JsonValue };
  readonly missing: EvaluatorConformanceProbeSources & { readonly expectedReasonCode: string };
  readonly invalid: EvaluatorConformanceProbeSources & { readonly expectedReasonCode: string };
  readonly failure: EvaluatorConformanceProbeSources & {
    readonly expectedErrorCode: string;
  };
  /** Must remain pending until its supplied AbortSignal is cancelled. */
  readonly cancellation: EvaluatorConformanceProbeSources;
  readonly probeNamespace: string;
  readonly timeoutMs?: number;
}

export interface EvaluatorConformanceCheck {
  readonly checkId:
    | 'configuration'
    | 'prepare-no-effects'
    | 'binding-projection'
    | 'score-contract'
    | 'missing-contract'
    | 'invalid-contract'
    | 'failure-contract'
    | 'cancellation-contract'
    | 'concurrency-contract'
    | 'telemetry-contract'
    | 'core-roundtrip';
  readonly checkStatus: 'passed' | 'failed';
  readonly reasonCode?: string;
}

export interface EvaluatorConformanceResult {
  readonly conformant: boolean;
  readonly checks: readonly EvaluatorConformanceCheck[];
}

type ProbePhase = 'score' | 'missing' | 'invalid' | 'failure' | 'cancellation' | 'concurrency';

function check(
  checkId: EvaluatorConformanceCheck['checkId'],
  passed: boolean,
  reasonCode: string,
): EvaluatorConformanceCheck {
  return Object.freeze({
    checkId,
    checkStatus: passed ? 'passed' : 'failed',
    ...(passed ? {} : { reasonCode }),
  });
}

function result(checks: readonly EvaluatorConformanceCheck[]): EvaluatorConformanceResult {
  const captured = Object.freeze([...checks]);
  return Object.freeze({
    conformant: captured.every((candidate) => candidate.checkStatus === 'passed'),
    checks: captured,
  });
}

function waitForBarrier(barrier: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    barrier,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function target(probe: EvaluatorConformanceProbeSources): Executor<string, undefined, JsonValue> {
  return {
    executorId: 'omk.runtime-check.evaluator-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.json(), trace: z.json() },
    outputClassification: 'public',
    traceClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'serialized' },
      seedControl: 'unsupported',
      telemetry: { trace: 'required', usage: 'optional' },
    },
    fingerprintFacets: { probe: 'omk.runtime-check.evaluator/v1' },
    async execute({ signal }) {
      signal.throwIfAborted();
      return { output: probe.output, trace: probe.trace ?? null };
    },
  };
}

function evaluationInput(
  namespace: string,
  phase: ProbePhase,
  probe: EvaluatorConformanceProbeSources,
  evaluator: CustomEvaluator,
): EvaluateInput {
  return {
    dataset: {
      datasetId: `runtime-check-${namespace}-${phase}`,
      samples: [{
        sampleId: phase,
        input: phase,
        expected: probe.expected ?? null,
        evaluationContext: probe.evaluationContext ?? {},
      }],
    },
    variants: [{
      variantId: 'candidate',
      artifact: {
        name: `runtime-check-${namespace}`,
        kind: 'baseline',
        source: 'baseline',
        content: null,
      },
      execution: { executor: target(probe) },
    }],
    evaluators: [evaluator],
    comparisons: [],
    analyses: [],
    experiment: {
      seed: `runtime-check-${namespace}`,
      sampling: { samplingKind: 'solo' },
    },
    policy: { evaluation: { maxConcurrency: 1 } },
  };
}

function concurrentEvaluationInput(
  namespace: string,
  probe: EvaluatorConformanceProbeSources,
  evaluator: CustomEvaluator,
): EvaluateInput {
  const base = evaluationInput(namespace, 'score', probe, evaluator);
  return {
    ...base,
    dataset: {
      ...base.dataset,
      samples: ['concurrent-a', 'concurrent-b'].map((sampleId) => ({
        sampleId,
        input: sampleId,
        expected: probe.expected ?? null,
        evaluationContext: probe.evaluationContext ?? {},
      })),
    },
    policy: { evaluation: { maxConcurrency: 2 } },
  };
}

function phaseRecord(
  run: EvaluationResult | undefined,
  evaluator: CustomEvaluator,
) {
  if (run?.status !== 'completed') return undefined;
  return run.artifacts.evaluation.records.find((candidate) => (
    candidate.evaluatorId === evaluator.evaluatorId
  ));
}

function validSources(value: unknown): value is EvaluatorConformanceProbeSources {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const probe = value as Partial<EvaluatorConformanceProbeSources>;
  return JsonValueSchema.safeParse(probe.output).success
    && (probe.trace === undefined || JsonValueSchema.safeParse(probe.trace).success)
    && (probe.expected === undefined || JsonValueSchema.safeParse(probe.expected).success)
    && (probe.evaluationContext === undefined
      || JsonValueSchema.safeParse(probe.evaluationContext).success);
}

/** Exercises one Custom Evaluator callback through canonical Runtime and Core records. */
export async function runEvaluatorConformance<
  Bindings extends Record<string, JsonValue>,
  Parameters extends JsonValue | undefined,
>(
  input: Readonly<EvaluatorConformanceProbeInput<Bindings, Parameters>>,
): Promise<EvaluatorConformanceResult> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return result([check('configuration', false, 'runtime-evaluator-configuration-invalid')]);
  }
  const callback = input.evaluator?.implementation?.evaluate;
  if (typeof callback !== 'function'
      || !IdentifierSchema.safeParse(input.probeNamespace).success
      || !validSources(input.score)
      || !JsonValueSchema.safeParse(input.score.expectedValue).success
      || !validSources(input.missing)
      || !IdentifierSchema.safeParse(input.missing.expectedReasonCode).success
      || !validSources(input.invalid)
      || !IdentifierSchema.safeParse(input.invalid.expectedReasonCode).success
      || !validSources(input.failure)
      || !IdentifierSchema.safeParse(input.failure.expectedErrorCode).success
      || !validSources(input.cancellation)) {
    return result([check('configuration', false, 'runtime-evaluator-configuration-invalid')]);
  }
  const invocations: Array<Readonly<CustomEvaluatorInvocation>> = [];
  let evaluatorInvocationsInFlight = 0;
  let maximumEvaluatorInvocationsInFlight = 0;
  let cancellationRejected = false;
  let concurrentInvocationsStarted = 0;
  let releaseConcurrentInvocations: (() => void) | undefined;
  const concurrentInvocationsReady = new Promise<void>((resolve) => {
    releaseConcurrentInvocations = resolve;
  });
  let phase: ProbePhase = 'score';
  let markCancellationStart: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    markCancellationStart = resolve;
  });
  const observedEvaluator: CustomEvaluator = {
    ...input.evaluator,
    implementation: {
      ...input.evaluator.implementation,
      async evaluate(invocation) {
        invocations.push(invocation);
        if (phase === 'cancellation') markCancellationStart?.();
        evaluatorInvocationsInFlight += 1;
        maximumEvaluatorInvocationsInFlight = Math.max(
          maximumEvaluatorInvocationsInFlight,
          evaluatorInvocationsInFlight,
        );
        try {
          if (phase === 'concurrency') {
            concurrentInvocationsStarted += 1;
            if (concurrentInvocationsStarted === 2) releaseConcurrentInvocations?.();
            await waitForBarrier(concurrentInvocationsReady, timeoutMs);
          }
          return await Reflect.apply(callback, undefined, [invocation]) as CustomEvaluatorResult;
        } catch (error) {
          if (phase === 'cancellation' && invocation.signal.aborted) {
            cancellationRejected = true;
          }
          throw error;
        } finally {
          evaluatorInvocationsInFlight -= 1;
        }
      },
    },
  };
  const probes = [
    ['score', input.score],
    ['missing', input.missing],
    ['invalid', input.invalid],
    ['failure', input.failure],
    ['cancellation', input.cancellation],
  ] as const;
  const runs: EvaluationResult[] = [];
  let concurrentRun: EvaluationResult | undefined;
  let prepareHadEffects = false;
  for (const [candidatePhase, probe] of probes) {
    phase = candidatePhase;
    let prepared: Awaited<ReturnType<typeof prepareEvaluation>>;
    try {
      const callsBeforePrepare = invocations.length;
      prepared = await prepareEvaluation(evaluationInput(
        input.probeNamespace,
        candidatePhase,
        probe,
        observedEvaluator,
      ));
      prepareHadEffects ||= invocations.length !== callsBeforePrepare;
    } catch {
      return result([check('configuration', false, 'runtime-evaluator-configuration-invalid')]);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = prepared.run({
        runId: `runtime-check-${input.probeNamespace}-${candidatePhase}`,
        signal: controller.signal,
      });
      if (candidatePhase === 'cancellation') {
        await Promise.race([
          cancellationStarted,
          new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
        controller.abort('runtime evaluator cancellation probe');
      } else {
        timer = setTimeout(() => controller.abort('runtime evaluator probe timeout'), timeoutMs);
      }
      runs.push(await pending);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  phase = 'concurrency';
  try {
    const prepared = await prepareEvaluation(concurrentEvaluationInput(
      input.probeNamespace,
      input.score,
      observedEvaluator,
    ));
    concurrentRun = await prepared.run({
      runId: `runtime-check-${input.probeNamespace}-concurrent`,
    });
  } catch {
    // The stable concurrency check below reports the failed probe.
  }

  const scoreInvocation = invocations.find((invocation) => invocation.sampleId === 'score');
  const scoreRecord = phaseRecord(runs[0], input.evaluator);
  const missingRecord = phaseRecord(runs[1], input.evaluator);
  const invalidRecord = phaseRecord(runs[2], input.evaluator);
  const failureRun = runs[3];
  const failureRecord = phaseRecord(failureRun, input.evaluator);
  const cancellationInvocation = invocations.find((invocation) => (
    invocation.sampleId === 'cancellation'
  ));
  const allUsageValid = runs.flatMap((run) => run.status === 'completed'
    ? run.artifacts.evaluation.records
    : []).every((record) => !('usage' in record) || record.usage === undefined || (
      (record.usage.totalTokens === undefined || record.usage.totalTokens >= 0)
      && (record.usage.providerCost === undefined
        || Number.isFinite(record.usage.providerCost.amount))
    ));
  return result([
    check('configuration', true, 'runtime-evaluator-configuration-invalid'),
    check('prepare-no-effects', !prepareHadEffects, 'runtime-evaluator-prepare-had-effects'),
    check(
      'binding-projection',
      scoreInvocation !== undefined
        && Object.keys(scoreInvocation.bindings).sort().join(',')
          === input.evaluator.bindings.map((binding) => binding.bindingId).sort().join(','),
      'runtime-evaluator-binding-mismatch',
    ),
    check(
      'score-contract',
      scoreRecord?.evaluationStatus === 'completed'
        && scoreRecord.observations.length === 1
        && scoreRecord.observations[0]?.observationStatus === 'observed'
        && canonicalizeJson(scoreRecord.observations[0].value)
          === canonicalizeJson(input.score.expectedValue),
      'runtime-evaluator-score-contract-invalid',
    ),
    check(
      'missing-contract',
      missingRecord?.evaluationStatus === 'completed'
        && missingRecord.observations.length === 1
        && missingRecord.observations[0]?.observationStatus === 'missing'
        && missingRecord.observations[0].reasonCode === input.missing.expectedReasonCode,
      'runtime-evaluator-missing-contract-invalid',
    ),
    check(
      'invalid-contract',
      invalidRecord?.evaluationStatus === 'completed'
        && invalidRecord.observations.length === 1
        && invalidRecord.observations[0]?.observationStatus === 'invalid'
        && invalidRecord.observations[0].reasonCode === input.invalid.expectedReasonCode,
      'runtime-evaluator-invalid-contract-invalid',
    ),
    check(
      'failure-contract',
      failureRecord?.evaluationStatus === 'failed'
        && failureRecord.error.code === input.failure.expectedErrorCode,
      'runtime-evaluator-failure-contract-invalid',
    ),
    check(
      'cancellation-contract',
      runs[4]?.status === 'cancelled'
        && cancellationInvocation !== undefined
        && cancellationInvocation.signal.aborted
        && cancellationRejected,
      'runtime-evaluator-cancellation-ignored',
    ),
    check(
      'concurrency-contract',
      concurrentRun?.status === 'completed'
        && concurrentRun.artifacts.evaluation.records.length === 2
        && maximumEvaluatorInvocationsInFlight >= 2
        && concurrentRun.artifacts.evaluation.records.every((record) => (
          record.evaluationStatus === 'completed'
            && record.observations.length === 1
            && record.observations[0]?.observationStatus === 'observed'
            && canonicalizeJson(record.observations[0].value)
              === canonicalizeJson(input.score.expectedValue)
        )),
      'runtime-evaluator-concurrency-invalid',
    ),
    check('telemetry-contract', allUsageValid, 'runtime-evaluator-telemetry-invalid'),
    check(
      'core-roundtrip',
      runs.length === 5
        && runs.slice(0, 4).every((run) => run.status === 'completed')
        && concurrentRun?.status === 'completed',
      'runtime-evaluator-core-roundtrip-incomplete',
    ),
  ]);
}
