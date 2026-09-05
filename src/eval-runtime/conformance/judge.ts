import { z } from 'zod';
import { IdentifierSchema, type JsonValue } from '../../eval-core/contracts/index.js';
import {
  prepareEvaluation,
  type EvaluationResult,
  type Executor,
  type Judge,
} from '../evaluate.js';
import type {
  OmkLlmJudgeInvocationRequest,
  OmkLlmJudgeInvocationResult,
} from '../judges/invocation.js';

export interface JudgeConformanceProbeCase {
  /** Harmless public text sent to the provider inside the generated rubric prompt. */
  readonly publicProbeText: string;
}

export interface JudgeConformanceProbeInput {
  readonly judge: Judge;
  readonly model: string;
  readonly success: JudgeConformanceProbeCase & { readonly expectedScore: number };
  readonly invalidResponse: JudgeConformanceProbeCase & { readonly expectedReasonCode: string };
  /** Must throw or return a structured provider failure for this generated prompt. */
  readonly failure: JudgeConformanceProbeCase;
  /** Must remain pending until the supplied AbortSignal is cancelled. */
  readonly cancellation: JudgeConformanceProbeCase;
  readonly probeNamespace: string;
  /** Required acknowledgement because this check performs up to four real provider calls. */
  readonly allowExternalCalls: true;
  readonly timeoutMs?: number;
}

export interface JudgeConformanceCheck {
  readonly checkId:
    | 'configuration'
    | 'external-calls-authorized'
    | 'prepare-no-effects'
    | 'request-contract'
    | 'result-contract'
    | 'response-validation'
    | 'failure-contract'
    | 'cancellation-contract'
    | 'concurrency-contract'
    | 'telemetry-contract'
    | 'core-roundtrip';
  readonly checkStatus: 'passed' | 'failed';
  readonly reasonCode?: string;
}

export interface JudgeConformanceResult {
  readonly conformant: boolean;
  readonly checks: readonly JudgeConformanceCheck[];
  readonly externalCalls: Readonly<{
    readonly invocationCount: number;
    readonly maximumInvocations: 4;
    readonly providerCostReporting: 'unsupported' | 'optional' | 'required';
    readonly measuredProviderCosts: readonly Readonly<{
      readonly amount: number;
      readonly currency: string;
    }>[];
  }>;
}

type ProbePhase = 'concurrency' | 'failure' | 'cancellation';

function check(
  checkId: JudgeConformanceCheck['checkId'],
  passed: boolean,
  reasonCode: string,
): JudgeConformanceCheck {
  return Object.freeze({
    checkId,
    checkStatus: passed ? 'passed' : 'failed',
    ...(passed ? {} : { reasonCode }),
  });
}

function result(
  checks: readonly JudgeConformanceCheck[],
  invocationCount: number,
  reporting: Judge['providerCost']['reporting'],
  measuredProviderCosts: readonly Readonly<{ amount: number; currency: string }>[],
): JudgeConformanceResult {
  const captured = Object.freeze([...checks]);
  return Object.freeze({
    conformant: captured.every((candidate) => candidate.checkStatus === 'passed'),
    checks: captured,
    externalCalls: Object.freeze({
      invocationCount,
      maximumInvocations: 4 as const,
      providerCostReporting: reporting,
      measuredProviderCosts: Object.freeze([...measuredProviderCosts]),
    }),
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

function target(actualBySampleId: Readonly<Record<string, string>>): Executor<string, undefined, JsonValue> {
  return {
    executorId: 'omk.runtime-check.judge-executor/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: z.string() },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'serialized' },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { probe: 'omk.runtime-check.judge/v1' },
    async execute({ sampleId, signal }) {
      signal.throwIfAborted();
      return { output: actualBySampleId[sampleId] ?? '' };
    },
  };
}

function evaluationInput(
  namespace: string,
  phase: ProbePhase,
  cases: readonly Readonly<{ sampleId: string; publicProbeText: string }>[],
  model: string,
  judge: Judge,
) {
  return {
    dataset: {
      datasetId: `runtime-check-${namespace}-${phase}`,
      samples: cases.map(({ sampleId }) => ({ sampleId, input: sampleId })),
    },
    variants: [{
      variantId: 'candidate',
      artifact: {
        name: `runtime-check-${namespace}`,
        kind: 'baseline' as const,
        source: 'baseline' as const,
        content: null,
      },
      execution: {
        executor: target(Object.fromEntries(cases.map((candidate) => (
          [candidate.sampleId, candidate.publicProbeText]
        )))),
      },
    }],
    evaluators: [{
      evaluatorKind: 'rubric-judge' as const,
      evaluatorId: 'runtime-check-judge',
      metricId: 'runtime-check-judge-score',
      rubric: {
        criterionId: `runtime-check-${phase}`,
        prompt: `OMK Runtime Judge behavioral probe: ${phase}.`,
        rubric: 'Return a numeric score from 1 through 5 using the required JSON shape.',
      },
      judges: [{ memberId: 'primary', model, judge }],
      aggregation: { method: 'mean' as const, missing: 'require-complete' as const },
    }],
    comparisons: [],
    analyses: [],
    experiment: {
      seed: `runtime-check-${namespace}`,
      sampling: { samplingKind: 'solo' as const },
    },
    policy: { evaluation: { maxConcurrency: cases.length } },
  };
}

function phaseRecord(run: EvaluationResult | undefined, sampleId: string) {
  if (run?.status !== 'completed') return undefined;
  return run.artifacts.evaluation.records.find((candidate) => (
    candidate.evaluatorId === 'runtime-check-judge/primary/replicate-0'
      && candidate.sampleId === sampleId
  ));
}

function measuredCosts(runs: readonly EvaluationResult[]) {
  const totals = new Map<string, number>();
  for (const run of runs) {
    if (run.status !== 'completed') continue;
    for (const record of run.artifacts.evaluation.records) {
      if (!('usage' in record)) continue;
      const cost = record.usage?.providerCost;
      if (cost !== undefined) totals.set(cost.currency, (totals.get(cost.currency) ?? 0) + cost.amount);
    }
  }
  return Object.freeze([...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => Object.freeze({ amount, currency })));
}

/** Exercises one Judge adapter through the canonical Rubric evaluator and Core records. */
export async function runJudgeConformance(
  input: Readonly<JudgeConformanceProbeInput>,
): Promise<JudgeConformanceResult> {
  const reporting = input.judge?.providerCost?.reporting ?? 'unsupported';
  if (input.allowExternalCalls !== true) {
    return result([
      check('external-calls-authorized', false, 'runtime-judge-external-calls-not-authorized'),
    ], 0, reporting, []);
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
      || typeof input.judge?.invoke !== 'function'
      || typeof input.model !== 'string' || input.model.length === 0
      || !IdentifierSchema.safeParse(input.probeNamespace).success
      || typeof input.success?.publicProbeText !== 'string'
      || input.success.publicProbeText.length === 0
      || !Number.isFinite(input.success?.expectedScore)
      || input.success.expectedScore < 1 || input.success.expectedScore > 5
      || typeof input.invalidResponse?.publicProbeText !== 'string'
      || input.invalidResponse.publicProbeText.length === 0
      || !IdentifierSchema.safeParse(input.invalidResponse.expectedReasonCode).success
      || typeof input.failure?.publicProbeText !== 'string'
      || input.failure.publicProbeText.length === 0
      || typeof input.cancellation?.publicProbeText !== 'string'
      || input.cancellation.publicProbeText.length === 0) {
    return result([
      check('configuration', false, 'runtime-judge-configuration-invalid'),
    ], 0, reporting, []);
  }

  const invoke = input.judge.invoke;
  const receiver: Judge = Object.freeze({ ...input.judge, invoke });
  const requests: Array<Readonly<{
    phase: ProbePhase;
    request: Readonly<OmkLlmJudgeInvocationRequest>;
  }>> = [];
  let phase: ProbePhase = 'concurrency';
  let judgeInvocationsInFlight = 0;
  let maximumJudgeInvocationsInFlight = 0;
  let cancellationRejected = false;
  let concurrentInvocationsStarted = 0;
  let releaseConcurrentInvocations: (() => void) | undefined;
  const concurrentInvocationsReady = new Promise<void>((resolve) => {
    releaseConcurrentInvocations = resolve;
  });
  let markCancellationStart: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => { markCancellationStart = resolve; });
  const observedJudge: Judge = {
    ...input.judge,
    async invoke(request) {
      requests.push({ phase, request });
      if (phase === 'cancellation') markCancellationStart?.();
      judgeInvocationsInFlight += 1;
      maximumJudgeInvocationsInFlight = Math.max(
        maximumJudgeInvocationsInFlight,
        judgeInvocationsInFlight,
      );
      try {
        if (phase === 'concurrency') {
          concurrentInvocationsStarted += 1;
          if (concurrentInvocationsStarted === 2) releaseConcurrentInvocations?.();
          await waitForBarrier(concurrentInvocationsReady, timeoutMs);
        }
        return await Reflect.apply(invoke, receiver, [request]) as OmkLlmJudgeInvocationResult;
      } catch (error) {
        if (phase === 'cancellation' && request.signal.aborted) cancellationRejected = true;
        throw error;
      } finally {
        judgeInvocationsInFlight -= 1;
      }
    },
  };
  const probes = [
    ['concurrency', [
      { sampleId: 'success', publicProbeText: input.success.publicProbeText },
      { sampleId: 'invalid-response', publicProbeText: input.invalidResponse.publicProbeText },
    ]],
    ['failure', [{ sampleId: 'failure', publicProbeText: input.failure.publicProbeText }]],
    ['cancellation', [{
      sampleId: 'cancellation',
      publicProbeText: input.cancellation.publicProbeText,
    }]],
  ] as const;
  const runs: EvaluationResult[] = [];
  let prepareHadEffects = false;
  for (const [candidatePhase, probe] of probes) {
    phase = candidatePhase;
    let prepared: Awaited<ReturnType<typeof prepareEvaluation>>;
    try {
      const callsBeforePrepare = requests.length;
      prepared = await prepareEvaluation(evaluationInput(
        input.probeNamespace,
        candidatePhase,
        probe,
        input.model,
        observedJudge,
      ));
      prepareHadEffects ||= requests.length !== callsBeforePrepare;
    } catch {
      return result([
        check('configuration', false, 'runtime-judge-configuration-invalid'),
      ], requests.length, reporting, measuredCosts(runs));
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
        controller.abort('runtime judge cancellation probe');
      } else {
        timer = setTimeout(() => controller.abort('runtime judge probe timeout'), timeoutMs);
      }
      runs.push(await pending);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  const successRecord = phaseRecord(runs[0], 'success');
  const invalidResponseRecord = phaseRecord(runs[0], 'invalid-response');
  const failureRecord = phaseRecord(runs[1], 'failure');
  const cancellationRequest = requests.find((candidate) => candidate.phase === 'cancellation')?.request;
  const allRequestsValid = requests.every(({ request }) => (
    request.model === input.model
      && request.signal instanceof AbortSignal
      && request.promptId.length > 0
      && /^[0-9a-f]{12}$/.test(request.promptHash)
      && request.system.length > 0
      && request.prompt.length > 0
  ));
  const allUsageValid = runs.flatMap((run) => run.status === 'completed'
    ? run.artifacts.evaluation.records
    : []).every((record) => !('usage' in record) || record.usage === undefined || (
      (record.usage.totalTokens === undefined || record.usage.totalTokens >= 0)
      && (record.usage.providerCost === undefined
        || Number.isFinite(record.usage.providerCost.amount))
    ));
  const checks = [
    check('configuration', true, 'runtime-judge-configuration-invalid'),
    check('external-calls-authorized', true, 'runtime-judge-external-calls-not-authorized'),
    check('prepare-no-effects', !prepareHadEffects, 'runtime-judge-prepare-had-effects'),
    check('request-contract', requests.length === 4 && allRequestsValid, 'runtime-judge-request-invalid'),
    check(
      'result-contract',
      successRecord?.evaluationStatus === 'completed'
        && successRecord.observations.some((observation) => (
          observation.observationStatus === 'observed'
            && observation.value === input.success.expectedScore
        )),
      'runtime-judge-result-contract-invalid',
    ),
    check(
      'response-validation',
      invalidResponseRecord?.evaluationStatus === 'completed'
        && invalidResponseRecord.observations.length === 1
        && invalidResponseRecord.observations[0]?.observationStatus === 'invalid'
        && invalidResponseRecord.observations[0].reasonCode
          === input.invalidResponse.expectedReasonCode,
      'runtime-judge-response-validation-failed',
    ),
    check(
      'failure-contract',
      failureRecord?.evaluationStatus === 'failed'
        && failureRecord.error.code === 'judge-provider-failure',
      'runtime-judge-failure-contract-invalid',
    ),
    check(
      'cancellation-contract',
      runs[2]?.status === 'cancelled'
        && cancellationRequest !== undefined
        && cancellationRequest.signal.aborted
        && cancellationRejected,
      'runtime-judge-cancellation-ignored',
    ),
    check(
      'concurrency-contract',
      maximumJudgeInvocationsInFlight >= 2
        && successRecord?.evaluationStatus === 'completed'
        && invalidResponseRecord?.evaluationStatus === 'completed',
      'runtime-judge-concurrency-invalid',
    ),
    check('telemetry-contract', allUsageValid, 'runtime-judge-telemetry-invalid'),
    check(
      'core-roundtrip',
      runs.length === 3 && runs.slice(0, 2).every((run) => run.status === 'completed'),
      'runtime-judge-core-roundtrip-incomplete',
    ),
  ];
  return result(checks, requests.length, reporting, measuredCosts(runs));
}
