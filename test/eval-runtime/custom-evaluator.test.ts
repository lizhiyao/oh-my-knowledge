import { z } from 'zod';
import type { JsonValue } from '../../src/eval-core/contracts/index.js';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluate,
  createCustomEvaluator,
  debugEvaluator,
  type CustomEvaluatorScores,
  type CustomEvaluatorMetric,
  prepareEvaluation,
  type CustomEvaluator,
  type CustomEvaluatorResult,
  type EvaluateInput,
  type Executor,
  type Metric,
} from '../../src/eval-runtime/index.js';

const metricIds = ['HIT', 'PRECISION', 'MISS_RATE', 'MRR', 'AVG_RT'];

function custom(
  callback: CustomEvaluator['implementation']['evaluate'],
  ids = metricIds,
): CustomEvaluator {
  return {
    evaluatorKind: 'custom',
    evaluatorId: 'joint-scorer',
    instrumentId: 'joint-scorer-v1',
    metrics: ids.map((metricId): Metric => ({
      metricId,
      valueType: 'numeric',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    })),
    bindings: [
      { bindingId: 'actual', sourceKind: 'output', pointer: '' },
      { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
      { bindingId: 'facts', sourceKind: 'execution-facts', pointer: '' },
    ],
    implementation: {
      implementationId: 'test.joint-scorer/v1',
      version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.number(), expected: z.number(), facts: z.json() }).strict(),
        values: Object.fromEntries(ids.map((id) => [id, z.number()])),
        fingerprintFacets: { bindings: 'numeric-with-facts/v1', values: 'numeric/v1' },
      },
      providerCost: { reporting: 'optional' },
      fingerprintFacets: { revision: 'joint-one' },
      evaluate: callback,
    },
  };
}

const executor: Executor<number, undefined, number> = {
  executorId: 'test.joint-output/v1',
  version: '1.0.0',
  schemas: { input: z.number(), output: z.number() },
  outputClassification: 'public',
  capabilities: {
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  fingerprintFacets: { revision: 'one' },
  execute: async ({ input }) => ({ output: input }),
};

function input(evaluator: CustomEvaluator, count = 1): EvaluateInput {
  return {
    dataset: {
      datasetId: 'joint-data',
      samples: Array.from({ length: count }, (_, i) => ({
        sampleId: `sample-${i}`, input: i, expected: i,
      })),
    },
    variants: [{
      variantId: 'candidate',
      artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null },
      execution: { executor },
    }],
    evaluators: [evaluator],
    comparisons: [],
    analyses: evaluator.metrics.filter((metric) => metric.valueType === 'numeric').map((metric) => ({
      analysisId: `${metric.metricId}-mean`,
      analysisKind: 'summary', statistic: 'mean', variantId: 'candidate', metricId: metric.metricId,
    })),
    experiment: { seed: 'joint-seed', sampling: { samplingKind: 'solo' } },
    policy: { evaluation: { maxConcurrency: 8 } },
  };
}

function scores(ids = metricIds): CustomEvaluatorResult {
  return {
    resultKind: 'completed',
    results: ids.map((metricId) => ({ metricId, resultKind: 'score', value: 1 })),
    usage: { totalTokens: 7, providerCost: { amount: 0.25, currency: 'USD', reportedByProvider: true } },
  };
}

describe('multi-Metric Custom Evaluator', () => {
  it('runs 63 joint invocations for 315 independently summarized observations at concurrency 8', async () => {
    let active = 0;
    let maximum = 0;
    const callback = vi.fn<CustomEvaluator['implementation']['evaluate']>(async ({ bindings }) => {
      expect(bindings.actual).toBe(bindings.expected);
      expect(bindings.facts).toMatchObject({ attemptCount: 1 });
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      // Result order deliberately differs from the canonical declaration order.
      return scores([...metricIds].reverse());
    });
    const declaration = input(custom(callback), 63);
    const prepared = await prepareEvaluation({
      ...declaration,
      policy: { ...declaration.policy, budget: { run: { maxInvocations: 126 } } },
    });
    expect(prepared.estimatedWork).toMatchObject({
      executionCoordinates: 63, evaluationCoordinates: 63, plannedInvocations: 126,
    });
    expect(callback).not.toHaveBeenCalled();
    const eventKinds: string[] = [];
    const result = await prepared.run({ onEvent: (event) => { eventKinds.push(event.eventKind); } });
    expect(eventKinds.filter((kind) => kind === 'evaluation.attempt.started')).toHaveLength(63);
    expect(result.status).toBe('completed');
    expect(callback).toHaveBeenCalledTimes(63);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    const records = result.artifacts?.evaluation?.records ?? [];
    expect(records).toHaveLength(63);
    expect(records.flatMap((record) => record.evaluationStatus === 'completed' ? record.observations : []))
      .toHaveLength(315);
    expect(records.every((record) => record.evaluationStatus === 'completed' && record.usage?.totalTokens === 7)).toBe(true);
    expect(result.report?.budgetSummary.entries.filter((entry) => entry.stage === 'evaluation'))
      .toHaveLength(63);
    expect(records.every((record) => record.evaluationStatus === 'completed'
      && record.usage?.providerCost?.amount === 0.25)).toBe(true);
    for (const metricId of metricIds) {
      expect(result.analysisResults[`${metricId}-mean`]).toMatchObject({
        analysisStatus: 'completed', value: 1, coverage: { included: 63 },
      });
    }
  });

  it('preserves per-Metric evidence, missing reasons, invalid values, and coverage', async () => {
    const evaluator = custom(() => ({
      resultKind: 'completed',
      results: [
        { metricId: 'HIT', resultKind: 'score', value: 1, evidence: { value: 'hit', classification: 'public' } },
        { metricId: 'PRECISION', resultKind: 'missing', reasonCode: 'no-predictions', evidence: { value: [], classification: 'sensitive' } },
        { metricId: 'MISS_RATE', resultKind: 'invalid', reasonCode: 'negative-count', invalidValue: { value: -1, classification: 'gold' } },
        { metricId: 'MRR', resultKind: 'score', value: 'private-invalid-value' },
        { metricId: 'AVG_RT', resultKind: 'score', value: 2 },
      ],
      usage: { totalTokens: 3 },
    }));
    const result = await evaluate(input(evaluator));
    expect(result.status).toBe('completed');
    const record = result.artifacts?.evaluation?.records[0];
    expect(record?.evaluationStatus).toBe('completed');
    if (record?.evaluationStatus !== 'completed') throw new Error('missing joint record');
    expect(record.usage?.totalTokens).toBe(3);
    expect(record.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricId: 'HIT', observationStatus: 'observed', value: 1, evidence: expect.any(Object) }),
      expect.objectContaining({ metricId: 'PRECISION', observationStatus: 'missing', reasonCode: 'no-predictions', evidence: expect.any(Object) }),
      expect.objectContaining({ metricId: 'MISS_RATE', observationStatus: 'invalid', reasonCode: 'negative-count', invalidValue: expect.any(Object) }),
      expect.objectContaining({ metricId: 'MRR', observationStatus: 'invalid', reasonCode: 'custom-evaluator-value-invalid', invalidValue: expect.objectContaining({ classification: 'gold' }) }),
      expect.objectContaining({ metricId: 'AVG_RT', observationStatus: 'observed', value: 2 }),
    ]));
    expect(result.analysisResults['HIT-mean'].coverage).toMatchObject({ included: 1 });
    expect(result.analysisResults['PRECISION-mean'].coverage).toMatchObject({ included: 0, missing: 1 });
    expect(result.analysisResults['MISS_RATE-mean'].coverage).toMatchObject({ included: 0, invalid: 1 });
    expect(result.analysisResults['MRR-mean'].coverage).toMatchObject({ included: 0, invalid: 1 });
    expect(result.analysisResults['AVG_RT-mean']).toMatchObject({ value: 2 });
  });

  it('validates heterogeneous values independently and freezes declarations before execution', async () => {
    const values: Record<string, JsonValue> = {
      number: 2, boolean: true, category: 'safe', text: 'short', ranking: ['first', 'second'],
    };
    const callback = vi.fn((): CustomEvaluatorResult => ({
      resultKind: 'completed',
      results: Object.entries(values).map(([metricId, value]) => ({ metricId, resultKind: 'score', value })),
    }));
    const base = custom(callback, Object.keys(values));
    const metrics: Metric[] = [
      { metricId: 'number', valueType: 'numeric', direction: 'higher-is-better', missingPolicyId: 'exclude/v1' },
      { metricId: 'boolean', valueType: 'boolean', direction: 'higher-is-better', missingPolicyId: 'exclude/v1' },
      { metricId: 'category', valueType: 'categorical', missingPolicyId: 'exclude/v1' },
      { metricId: 'text', valueType: 'text', missingPolicyId: 'exclude/v1' },
      { metricId: 'ranking', valueType: 'ranking', missingPolicyId: 'exclude/v1' },
    ];
    const parsers = {
      number: z.number().transform((value) => value + 1),
      boolean: z.boolean(), category: z.enum(['safe']), text: z.enum(['short']),
      ranking: z.array(z.enum(['first', 'second'])),
    };
    const evaluator = { ...base, metrics, implementation: {
      ...base.implementation,
      schemas: { ...base.implementation.schemas, values: parsers },
    } };
    const prepared = await prepareEvaluation(input(evaluator));
    metrics.pop();
    Reflect.set(parsers, 'number', z.number());
    const result = await prepared.run();
    expect(callback).toHaveBeenCalledTimes(1);
    const record = result.artifacts?.evaluation?.records[0];
    expect(record?.evaluationStatus).toBe('completed');
    if (record?.evaluationStatus !== 'completed') throw new Error('missing joint record');
    expect(record.observations).toHaveLength(5);
    expect(record.observations.filter((item) => item.observationStatus === 'observed')).toHaveLength(4);
    expect(record.observations.find((item) => item.metricId === 'number')).toMatchObject({
      observationStatus: 'invalid', reasonCode: 'custom-evaluator-value-invalid',
    });
  });

  it('marks every Metric invalid on rejected shared bindings and admits no callback after budget exhaustion', async () => {
    const callback = vi.fn(() => scores());
    const base = custom(callback);
    const invalidBindings = { ...base, implementation: {
      ...base.implementation,
      schemas: { ...base.implementation.schemas, bindings: z.never() },
    } };
    const invalid = await evaluate(input(invalidBindings));
    const record = invalid.artifacts?.evaluation?.records[0];
    expect(record?.evaluationStatus).toBe('completed');
    if (record?.evaluationStatus !== 'completed') throw new Error('missing invalid record');
    expect(record.observations).toHaveLength(5);
    expect(record.observations.every((item) => item.observationStatus === 'invalid'
      && item.reasonCode === 'custom-evaluator-bindings-invalid')).toBe(true);
    const exhausted = await evaluate({ ...input(base), policy: { budget: { run: { maxInvocations: 1 } } } });
    expect(exhausted.status).toBe('budget-exhausted');
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects empty, duplicate, legacy, and incomplete schema declarations before invoking callbacks', async () => {
    const callback = vi.fn(() => scores());
    const base = custom(callback);
    const schemas = base.implementation.schemas;
    const invalid = [
      { ...base, metrics: [] },
      { ...base, metrics: [base.metrics[0], base.metrics[0]] },
      { ...base, metrics: undefined, metric: base.metrics[0] },
      { ...base, metric: base.metrics[0] },
      { ...base, implementation: { ...base.implementation, schemas: { ...schemas, values: {} } } },
      { ...base, implementation: { ...base.implementation, schemas: { ...schemas, values: { ...schemas.values, unknown: z.number() } } } },
      { ...base, implementation: { ...base.implementation, schemas: { ...schemas, value: z.number() } } },
      { ...base, implementation: { ...base.implementation, schemas: { ...schemas, values: { ...schemas.values, HIT: {} } } } },
    ];
    for (const evaluator of invalid) {
      await expect(prepareEvaluation({ ...input(base), evaluators: [evaluator as CustomEvaluator] }))
        .rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID', issues: expect.arrayContaining([expect.objectContaining({ path: expect.arrayContaining(['evaluators', 0]) })]) });
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it('fails malformed result sets atomically and redacts arbitrary callback errors', async () => {
    const invalidResults: unknown[] = [
      { resultKind: 'completed', results: [] },
      scores(['HIT', 'HIT', 'MISS_RATE', 'MRR', 'AVG_RT']),
      scores(['unknown', 'PRECISION', 'MISS_RATE', 'MRR', 'AVG_RT']),
      scores(metricIds.slice(1)),
      { resultKind: 'score', value: 1 },
      { resultKind: 'completed', results: [{ metricId: 'HIT', resultKind: 'failed', errorCode: 'broken' }] },
    ];
    for (const invalidResult of invalidResults) {
      const result = await evaluate(input(custom(() => invalidResult as CustomEvaluatorResult)));
      expect(result.artifacts?.evaluation?.records).toEqual([
        expect.objectContaining({ evaluationStatus: 'failed', error: expect.objectContaining({ code: 'custom-evaluator-result-invalid' }) }),
      ]);
      if (typeof invalidResult === 'object' && invalidResult !== null && 'usage' in invalidResult) {
        expect(result.artifacts?.evaluation?.records[0]).toMatchObject({ usage: { totalTokens: 7 } });
      }
    }
    const result = await evaluate(input(custom(() => { throw new Error('private-provider-detail'); })));
    expect(JSON.stringify(result)).not.toContain('private-provider-detail');
    expect(result.artifacts?.evaluation?.records[0]).toMatchObject({
      evaluationStatus: 'failed', error: { code: 'evaluator-error' },
    });
  });

  it('retries and accounts for the entire invocation, then cancels all its Metrics on timeout', async () => {
    const callback = vi.fn<CustomEvaluator['implementation']['evaluate']>(({ attemptNumber }) => attemptNumber === 1
      ? { resultKind: 'failed' as const, errorCode: 'temporary', usage: { totalTokens: 2 } }
      : scores());
    const base = input(custom(callback), 2);
    const result = await evaluate({
      ...base,
      policy: { evaluation: { maxConcurrency: 2, retry: {
        maxAttempts: 2, retryableErrorCodes: ['temporary'], backoff: { backoffKind: 'none' },
      } } },
    });
    expect(result.status).toBe('completed');
    expect(callback).toHaveBeenCalledTimes(4);
    expect(result.artifacts?.evaluation?.records.every((record) => (
      record.evaluationStatus === 'completed' && record.observations.length === 5
        && record.attempts.length === 2 && record.usage?.totalTokens === 9
    ))).toBe(true);
    let aborted = false;
    const slow = custom(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { aborted = true; reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
      return scores();
    });
    const timedOut = await evaluate({
      ...input(slow), policy: { evaluation: { timeoutMs: 10 } },
    });
    expect(aborted).toBe(true);
    expect(timedOut.artifacts?.evaluation?.records[0]).toMatchObject({
      evaluationStatus: 'failed', error: { code: 'timeout' },
    });
    for (const metricId of metricIds) {
      expect(timedOut.analysisResults[`${metricId}-mean`].coverage).toMatchObject({ included: 0 });
    }
  });
});


function concise() {
  return createCustomEvaluator({
    evaluatorId: 'concise', instrumentId: 'concise-v1',
    metrics: {
      HIT: { valueType: 'numeric', direction: 'higher-is-better', schema: z.number().min(0) },
      PRESENT: { valueType: 'boolean', direction: 'higher-is-better', schema: z.boolean() },
    },
    bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
    parameters: { offset: 1 },
    implementation: {
      implementationId: 'test.concise/v1', version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.number() }).strict(),
        fingerprintFacets: { bindings: 'actual-number/v1', values: 'number-boolean/v1' },
      },
      fingerprintFacets: { revision: 'one' },
      evaluate: ({ bindings, parameters, signal }) => {
        signal.throwIfAborted();
        // Inference includes both the parser output and parameters; no generic annotations.
        const actual: number = bindings.actual;
        const offset: number | undefined = parameters?.offset;
        return {
          resultKind: 'completed',
          results: {
            HIT: { resultKind: 'score', value: actual + (offset ?? 0) },
            PRESENT: { resultKind: 'score', value: actual >= 0 },
          },
          usage: { totalTokens: 3 },
        };
      },
    },
  });
}

describe('Custom Evaluator onboarding', () => {
  it('infers keyed score types and preserves the canonical v2 identity and results', async () => {
    type Scores = CustomEvaluatorScores<{
      number: { valueType: 'numeric'; direction: 'higher-is-better'; schema: ReturnType<typeof z.number> };
      flag: { valueType: 'boolean'; direction: 'higher-is-better'; schema: ReturnType<typeof z.boolean> };
    }>;
    // @ts-expect-error Every declared metric must be returned.
    const missing: Scores = { resultKind: 'completed', results: { number: { resultKind: 'score', value: 1 } } };
    // @ts-expect-error Value type comes from the metric's parser.
    const wrong: Scores = { resultKind: 'completed', results: { number: { resultKind: 'score', value: '1' }, flag: { resultKind: 'score', value: true } } };
    // @ts-expect-error The parser must match the metric's valueType.
    const mismatched: CustomEvaluatorMetric = { valueType: 'numeric', direction: 'higher-is-better', schema: z.boolean() };
    void missing; void wrong; void mismatched;
    const evaluator = concise();
    const base = input(evaluator);
    const canonical: CustomEvaluator = {
      ...evaluator,
      metrics: [
        { metricId: 'HIT', valueType: 'numeric', direction: 'higher-is-better', missingPolicyId: 'exclude/v1' },
        { metricId: 'PRESENT', valueType: 'boolean', direction: 'higher-is-better', missingPolicyId: 'exclude/v1' },
      ],
      implementation: {
        ...evaluator.implementation,
        schemas: { ...evaluator.implementation.schemas, values: { HIT: z.number().min(0), PRESENT: z.boolean() } },
        evaluate: () => ({ resultKind: 'completed', results: [
          { metricId: 'HIT', resultKind: 'score', value: 1 },
          { metricId: 'PRESENT', resultKind: 'score', value: true },
        ], usage: { totalTokens: 3 } }),
      },
    };
    const [left, right] = await Promise.all([
      prepareEvaluation(base), prepareEvaluation({ ...base, evaluators: [canonical] }),
    ]);
    expect(left.planDigest).toBe(right.planDigest);
    const debug = await debugEvaluator({ evaluator, sample: base.dataset.samples[0], variant: base.variants[0] });
    expect(debug.bindingInputs).toEqual([{ actual: 0 }]);
    expect(Object.isFrozen(debug.bindingInputs[0])).toBe(true);
    expect(debug.run.artifacts?.evaluation?.records[0]).toMatchObject({
      evaluationStatus: 'completed', usage: { totalTokens: 3 }, observations: [
        { metricId: 'HIT', observationStatus: 'observed', value: 1 },
        { metricId: 'PRESENT', observationStatus: 'observed', value: true },
      ],
    });
    expect(debug.run.analysisResults).toEqual({});
  });

  it('reports keyed builder fields and preserves usage for malformed keyed results', async () => {
    const base = concise();
    const declaration = {
      ...base,
      metrics: { HIT: { valueType: 'numeric' as const, direction: 'higher-is-better' as const, schema: z.number() } },
      implementation: {
        ...base.implementation,
        evaluate: () => ({ resultKind: 'completed' as const, results: { HIT: { resultKind: 'score' as const, value: 1 } } }),
      },
    };
    expect(() => createCustomEvaluator({
      ...declaration, metrics: { HIT: { ...declaration.metrics.HIT, scale: { min: 2, max: 1 } } },
    })).toThrow(expect.objectContaining({ issues: [{ path: ['metrics', 'HIT', 'scale'], reasonCode: 'invalid-value' }] }));
    const malformed = [
      {},
      { HIT: { resultKind: 'score', value: 1 }, UNKNOWN: { resultKind: 'score', value: 2 } },
      [{ metricId: 'HIT', resultKind: 'score', value: 1 }],
      { HIT: { metricId: 'HIT', resultKind: 'score', value: 1 } },
    ];
    for (const results of malformed) {
      const evaluator = createCustomEvaluator({
        ...declaration,
        implementation: { ...declaration.implementation, evaluate: () => ({
          resultKind: 'completed', results, usage: { totalTokens: 4 },
        } as unknown as ReturnType<typeof declaration.implementation.evaluate>) },
      });
      const run = await evaluate(input(evaluator));
      expect(run.artifacts?.evaluation?.records[0]).toMatchObject({
        evaluationStatus: 'failed', error: { code: 'custom-evaluator-result-invalid' }, usage: { totalTokens: 4 },
      });
    }
  });

  it('locates invalid pointers, scales, duplicates and parsers without rejected values', async () => {
    const base = custom(() => scores());
    const cases: Array<[unknown, (string | number)[]]> = [
      [{ ...base, bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: 'private-token' }] }, ['bindings', 0, 'pointer']],
      [{ ...base, metrics: [{ ...base.metrics[0], scale: { min: 2, max: 1 } }] }, ['metrics', 0, 'scale']],
      [{ ...base, bindings: [base.bindings[0], base.bindings[0]] }, ['bindings', 1, 'bindingId']],
      [{ ...base, implementation: { ...base.implementation, schemas: { ...base.implementation.schemas, bindings: null } } }, ['implementation', 'schemas', 'bindings']],
    ];
    for (const [evaluator, path] of cases) {
      let failure: unknown;
      try { await prepareEvaluation(input(evaluator as CustomEvaluator)); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID', issues: [{ path: ['evaluators', 0, ...path] }] });
      expect(JSON.stringify(failure)).not.toContain('private-token');
    }
  });

  it('shows raw binding input on schema rejection and preserves partial metric failure', async () => {
    const original = concise();
    const base = input(original);
    const evaluator: CustomEvaluator = {
      ...original,
      implementation: { ...original.implementation, schemas: {
        ...original.implementation.schemas,
        bindings: { parse() { throw new Error('private-validation-detail'); } },
      } },
    };
    const rejected = await debugEvaluator({ evaluator, sample: base.dataset.samples[0], variant: base.variants[0] });
    expect(rejected.bindingInputs).toEqual([{ actual: 0 }]);
    expect(JSON.stringify(rejected.run)).not.toContain('private-validation-detail');
    expect(rejected.run.artifacts?.evaluation?.records[0]).toMatchObject({
      observations: [
        { metricId: 'HIT', observationStatus: 'invalid', reasonCode: 'custom-evaluator-bindings-invalid' },
        { metricId: 'PRESENT', observationStatus: 'invalid', reasonCode: 'custom-evaluator-bindings-invalid' },
      ],
    });
    const hostile = { ...original, implementation: { ...original.implementation, schemas: {
      ...original.implementation.schemas,
      get bindings(): never { throw new Error('private-getter-detail'); },
    } } };
    await expect(debugEvaluator({ evaluator: hostile, sample: base.dataset.samples[0], variant: base.variants[0] }))
      .rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID', message: 'Custom Evaluator 调试声明不可读取。' });
    const partial = await debugEvaluator({ evaluator: original, sample: { sampleId: 'negative', input: -2 }, variant: base.variants[0] });
    expect(partial.run.artifacts?.evaluation?.records[0]).toMatchObject({ observations: [
      { metricId: 'HIT', observationStatus: 'invalid', reasonCode: 'custom-evaluator-value-invalid' },
      { metricId: 'PRESENT', observationStatus: 'observed', value: false },
    ] });
    const unavailable = await debugEvaluator({
      evaluator: { ...original, bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '/absent' }] },
      sample: base.dataset.samples[0], variant: base.variants[0],
    });
    expect(unavailable.bindingInputs).toEqual([]);
    expect(unavailable.run.artifacts?.evaluation?.records[0]?.evaluationStatus).toBe('not-evaluated');
  });

  it('retains retry accounting and honors cancellation through the single-sample entry', async () => {
    const base = input(custom(({ attemptNumber }) => attemptNumber === 1
      ? { resultKind: 'failed', errorCode: 'temporary', usage: { totalTokens: 2 } } : scores()));
    const debug = await debugEvaluator({
      evaluator: base.evaluators[0] as CustomEvaluator,
      sample: base.dataset.samples[0], variant: base.variants[0],
      policy: { evaluation: { retry: { maxAttempts: 2, retryableErrorCodes: ['temporary'], backoff: { backoffKind: 'none' } } } },
    });
    expect(debug.bindingInputs).toHaveLength(2);
    expect(debug.run.artifacts?.evaluation?.records[0]).toMatchObject({ evaluationStatus: 'completed', usage: { totalTokens: 9 } });
    let aborted = false;
    const slow = custom(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { aborted = true; reject(signal.reason); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      return scores();
    });
    const cancelled = await debugEvaluator({ evaluator: slow, sample: base.dataset.samples[0], variant: base.variants[0], policy: { evaluation: { timeoutMs: 10 } } });
    expect(aborted).toBe(true);
    expect(cancelled.run.artifacts?.evaluation?.records[0]).toMatchObject({ evaluationStatus: 'failed', error: { code: 'timeout' } });
  });
});
