import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { JsonValueSchema, type JsonValue } from '../../src/eval-core/contracts/index.js';
import {
  createFormulaEvaluator,
  evaluate,
  prepareEvaluation,
  type EvaluateInput,
  type EvaluationResult,
  type Executor,
  type FormulaEvaluatorConfig,
} from '../../src/eval-runtime/index.js';
import type { CustomEvaluatorInvocation } from '../../src/eval-runtime/custom-evaluator.js';

function ratioConfig(overrides: Partial<FormulaEvaluatorConfig> = {}): FormulaEvaluatorConfig {
  return {
    evaluatorId: 'ratio',
    calculatorId: 'ratio',
    bindings: {
      numerator: { sourceKind: 'output', pointer: '/num' },
      denominator: { sourceKind: 'output', pointer: '/den' },
    },
    metric: { metricId: 'ratio', direction: 'higher-is-better', missingPolicyId: 'exclude/v1' },
    ...overrides,
  };
}

async function score(config: FormulaEvaluatorConfig, bindings: Record<string, JsonValue>) {
  const evaluator = createFormulaEvaluator(config);
  const invocation: CustomEvaluatorInvocation = {
    bindings,
    parameters: undefined,
    sampleId: 'sample-0',
    variantId: 'candidate',
    trialIndex: 0,
    attemptNumber: 1,
    signal: new AbortController().signal,
  };
  const result = await evaluator.implementation.evaluate(invocation);
  expect(result.resultKind).toBe('completed');
  if (result.resultKind !== 'completed') throw new Error('formula invocation failed');
  expect(result.results).toHaveLength(1);
  const { metricId, ...outcome } = result.results[0];
  expect(metricId).toBe(config.metric.metricId);
  return outcome;
}

describe('declarative formula evaluator contract', () => {
  it('refuses bindings the calculator does not read, and names the accepted ones', () => {
    expect(() => createFormulaEvaluator(ratioConfig({
      bindings: { numerator: { sourceKind: 'output', pointer: '/num' } },
    }))).toThrow(/denominator/);
    expect(() => createFormulaEvaluator(ratioConfig({
      bindings: {
        numerator: { sourceKind: 'output', pointer: '/num' },
        denominator: { sourceKind: 'output', pointer: '/den' },
        total: { sourceKind: 'output', pointer: '/den' },
      },
    }))).toThrow(/total/);
    expect(() => createFormulaEvaluator(ratioConfig({
      metric: {
        metricId: 'ratio',
        direction: 'higher-is-better',
        missingPolicyId: 'exclude/v1',
        scale: { min: 1, max: 0 },
      },
    }))).toThrow(/scale/);
    expect(() => createFormulaEvaluator(ratioConfig({
      calculatorId: 'geomean' as FormulaEvaluatorConfig['calculatorId'],
    }))).toThrow(/calculatorId/);
  });

  it('publishes declared bindings in a canonical order regardless of configuration key order', () => {
    const reversed = createFormulaEvaluator(ratioConfig({
      bindings: {
        denominator: { sourceKind: 'output', pointer: '/den' },
        numerator: { sourceKind: 'output', pointer: '/num' },
      },
    }));
    expect(reversed.bindings.map((binding) => binding.bindingId)).toEqual(['denominator', 'numerator']);
    expect(reversed.metrics[0]).toMatchObject({ valueType: 'numeric', metricId: 'ratio' });
  });

  it('reports an unusable binding instead of a fabricated zero score', async () => {
    await expect(score(ratioConfig(), { numerator: 3, denominator: 4 }))
      .resolves.toEqual({ resultKind: 'score', value: 0.75 });
    await expect(score(ratioConfig(), { numerator: 3, denominator: 0 })).resolves.toMatchObject({
      resultKind: 'invalid', reasonCode: 'formula-ratio-denominator-zero',
    });
    await expect(score(ratioConfig(), { numerator: 'three', denominator: 4 })).resolves.toMatchObject({
      resultKind: 'invalid', reasonCode: 'formula-numerator-not-numeric',
    });
    await expect(score(ratioConfig(), { denominator: 4 })).resolves.toMatchObject({
      resultKind: 'missing', reasonCode: 'formula-numerator-missing',
    });
  });

  it('computes each built-in calculator without inventing a value for absent evidence', async () => {
    const config = (calculatorId: FormulaEvaluatorConfig['calculatorId'],
      bindings: FormulaEvaluatorConfig['bindings'],
      metric?: FormulaEvaluatorConfig['metric']) => createFormulaEvaluator(ratioConfig({
      calculatorId, bindings, ...(metric === undefined ? {} : { metric }),
    }));
    expect(config).toBeDefined();

    await expect(score(ratioConfig({
      calculatorId: 'mean',
      bindings: { values: { sourceKind: 'output', pointer: '/list' } },
    }), { values: [2, 4] })).resolves.toEqual({ resultKind: 'score', value: 3 });
    await expect(score(ratioConfig({
      calculatorId: 'mean',
      bindings: { values: { sourceKind: 'output', pointer: '/list' } },
    }), { values: [1, 'two'] })).resolves.toMatchObject({
      resultKind: 'invalid', reasonCode: 'formula-values-not-numeric',
    });
    await expect(score(ratioConfig({
      calculatorId: 'mean',
      bindings: { values: { sourceKind: 'output', pointer: '/list' } },
    }), { values: [] })).resolves.toMatchObject({
      resultKind: 'missing', reasonCode: 'formula-values-empty',
    });
    await expect(score(ratioConfig({
      calculatorId: 'duration',
      bindings: {
        startMs: { sourceKind: 'execution-facts', pointer: '' },
        endMs: { sourceKind: 'output', pointer: '/endMs' },
      },
    }), { startMs: 10, endMs: 40 })).resolves.toEqual({ resultKind: 'score', value: 30 });
    await expect(score(ratioConfig({
      calculatorId: 'duration',
      bindings: {
        startMs: { sourceKind: 'output', pointer: '/startMs' },
        endMs: { sourceKind: 'output', pointer: '/endMs' },
      },
    }), { startMs: 40, endMs: 10 })).resolves.toMatchObject({
      resultKind: 'invalid', reasonCode: 'formula-duration-reversed',
    });
    await expect(score(ratioConfig({
      calculatorId: 'percentage',
      bindings: { value: { sourceKind: 'output', pointer: '/hitRate' } },
    }), { value: 0.25 })).resolves.toEqual({ resultKind: 'score', value: 25 });
    await expect(score(ratioConfig({
      calculatorId: 'ranking',
      bindings: {
        target: { sourceKind: 'expected', pointer: '/answer' },
        candidates: { sourceKind: 'output', pointer: '/ids' },
      },
    }), { target: 'b', candidates: ['a', 'b', 'c'] })).resolves.toEqual({ resultKind: 'score', value: 2 });
    await expect(score(ratioConfig({
      calculatorId: 'ranking',
      bindings: {
        target: { sourceKind: 'expected', pointer: '/answer' },
        candidates: { sourceKind: 'output', pointer: '/ids' },
      },
    }), { target: 'z', candidates: ['a', 'b'] })).resolves.toMatchObject({
      resultKind: 'missing', reasonCode: 'formula-ranking-target-not-ranked',
    });
    await expect(score(ratioConfig({
      calculatorId: 'ranking',
      bindings: {
        target: { sourceKind: 'expected', pointer: '/answer' },
        candidates: { sourceKind: 'output', pointer: '/ids' },
      },
    }), { target: 'a', candidates: 'not-a-list' })).resolves.toMatchObject({
      resultKind: 'invalid', reasonCode: 'formula-candidates-not-a-list',
    });
  });

  it('rejects a computed value outside the declared scale instead of rescaling it', async () => {
    await expect(score(ratioConfig({
      metric: {
        metricId: 'ratio',
        direction: 'higher-is-better',
        missingPolicyId: 'exclude/v1',
        unit: 'ratio',
        scale: { min: 0, max: 1 },
      },
    }), { numerator: 3, denominator: 2 })).resolves.toMatchObject({
      resultKind: 'invalid',
      reasonCode: 'formula-value-above-scale',
      invalidValue: { value: 1.5 },
    });
    await expect(score(ratioConfig({
      metric: {
        metricId: 'ratio',
        direction: 'higher-is-better',
        missingPolicyId: 'exclude/v1',
        scale: { min: 2 },
      },
    }), { numerator: 1, denominator: 4 })).resolves.toMatchObject({
      resultKind: 'invalid', reasonCode: 'formula-value-below-scale',
    });
  });
});

function input(
  cases: Array<{ expected: JsonValue; output: JsonValue }>,
  evaluatorConfig: FormulaEvaluatorConfig,
): EvaluateInput {
  const executor: Executor<string, undefined, JsonValue, JsonValue> = {
    executorId: 'test.formula/v1',
    version: '1.0.0',
    schemas: { input: z.string(), output: JsonValueSchema, trace: JsonValueSchema },
    outputClassification: 'public',
    traceClassification: 'public',
    fingerprintFacets: { fixture: 'formula/v1', outputs: cases.map((item) => item.output) },
    capabilities: { determinism: 'deterministic', seedControl: 'unsupported' },
    async execute(invocation) {
      return { output: cases[Number(invocation.input)]!.output, trace: null };
    },
  };
  return {
    dataset: {
      datasetId: 'formula',
      samples: cases.map((item, index) => ({
        sampleId: `sample-${index}`, input: String(index), expected: item.expected,
      })),
    },
    variants: [{
      variantId: 'candidate',
      artifact: {
        kind: 'workflow', name: 'candidate', source: 'inline', content: 'Formula fixture.',
      },
      execution: { executor },
    }],
    evaluators: [createFormulaEvaluator(evaluatorConfig)],
    comparisons: [],
    analyses: [{
      analysisId: 'ratio-mean',
      analysisKind: 'summary',
      statistic: 'mean',
      variantId: 'candidate',
      metricId: evaluatorConfig.metric.metricId,
    }],
    experiment: { seed: 'formula-tests', sampling: { samplingKind: 'solo' } },
    policy: { execution: { maxConcurrency: 1 }, evaluation: { maxConcurrency: 1 } },
  };
}

function observations(result: EvaluationResult) {
  return result.artifacts?.evaluation?.records.flatMap((record) => (
    record.evaluationStatus === 'completed' ? record.observations : []
  )) ?? [];
}

describe('declarative formula evaluator through evaluate()', () => {
  const config = ratioConfig();

  it('scores samples end to end without any hand-written evaluator code', async () => {
    const result = await evaluate(input([
      { expected: null, output: { num: 3, den: 4 } },
      { expected: null, output: { num: 1, den: 4 } },
    ], config));
    expect(result.status).toBe('completed');
    expect(observations(result).filter((item) => item.observationStatus === 'observed').map(
      (item) => item.value,
    )).toEqual([0.75, 0.25]);
    expect(result.analysisResults['ratio-mean']).toMatchObject({
      analysisStatus: 'completed', value: 0.5, coverage: { included: 2 },
    });
  });

  it('keeps a zero denominator as an uncounted observation instead of a zero score', async () => {
    const result = await evaluate(input([
      { expected: null, output: { num: 3, den: 4 } },
      { expected: null, output: { num: 3, den: 0 } },
    ], config));
    expect(observations(result)).toEqual(expect.arrayContaining([
      expect.objectContaining({ observationStatus: 'invalid', reasonCode: 'formula-ratio-denominator-zero' }),
    ]));
    expect(result.analysisResults['ratio-mean'].coverage).toMatchObject({ included: 1, invalid: 1 });
    expect(result.analysisResults['ratio-mean']).toMatchObject({ analysisStatus: 'completed', value: 0.75 });
  });

  it('carries a binding-derived reason code through the public result contract', async () => {
    const result = await evaluate(input(
      [{ expected: null, output: { startMs: 10, endMs: 60 } }, { expected: null, output: { startMs: null, endMs: 90 } }],
      ratioConfig({
        calculatorId: 'duration',
        bindings: {
          startMs: { sourceKind: 'output', pointer: '/startMs' },
          endMs: { sourceKind: 'output', pointer: '/endMs' },
        },
        metric: { metricId: 'latency', direction: 'lower-is-better', missingPolicyId: 'exclude/v1' },
      }),
    ));
    expect(observations(result).filter((item) => item.observationStatus === 'observed').map(
      (item) => item.value,
    )).toEqual([50]);
    expect(observations(result)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        observationStatus: 'invalid', reasonCode: 'formula-startMs-not-numeric',
      }),
    ]));
    expect(result.analysisResults['ratio-mean'].coverage).toMatchObject({ included: 1, invalid: 1 });
  });

  it('fails prepare when an expected-source binding pointer resolves in no sample', async () => {
    const error: unknown = await prepareEvaluation(input(
      [{ expected: { other: 1 }, output: { ids: ['a'] } }],
      ratioConfig({
        calculatorId: 'ranking',
        bindings: {
          target: { sourceKind: 'expected', pointer: '/answer' },
          candidates: { sourceKind: 'output', pointer: '/ids' },
        },
      }),
    )).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const failure = error as { code?: string; cause?: unknown; message: string };
    expect(failure.code).toBe('EVAL_RUNTIME_INPUT_INVALID');
    expect(failure.cause).toEqual({
      failureKind: 'configuration',
      code: 'EVAL_DEFINITION_MISSING_REFERENCE',
    });
    expect(failure.message).not.toContain('answer');
  });
});
