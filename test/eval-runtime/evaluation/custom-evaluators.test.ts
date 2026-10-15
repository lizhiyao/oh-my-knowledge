import { z } from "zod";
import { describe, expect, it } from "vitest";
import { evaluate, type CustomEvaluator, type Executor } from "../../../src/eval-runtime/index.js";
import { type JsonValue } from "../../../src/eval-core/contracts/index.js";
import { type Config, type Input, comparisonAnalysis, executor, fixedClock, numericCustomEvaluator, pairedInput, qualitativeCustomEvaluator } from '../fixtures/evaluation.js';

describe('canonical eval-runtime custom-evaluators', () => {
it('runs a custom Evaluator from only its declared bindings', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const custom = {
      evaluatorKind: 'custom',
      evaluatorId: 'output-length',
      instrumentId: 'output-length-v1',
      metrics: [{
        metricId: 'length',
        valueType: 'numeric',
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      }],
      bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
      parameters: { offset: 1 },
      implementation: {
        implementationId: 'test.output-length/v1',
        version: '1.0.0',
        schemas: {
          bindings: z.object({ actual: z.string() }).strict(),
          values: { 'length': z.number() },
          fingerprintFacets: { bindings: 'actual-string/v1', value: 'finite-number/v1' },
        },
        fingerprintFacets: { revision: 'test-one' },
        async evaluate(invocation) {
          seen.push({
            ...invocation.bindings,
            parameters: invocation.parameters,
            variantId: invocation.variantId,
            attemptNumber: invocation.attemptNumber,
          });
          return {
            resultKind: 'completed',
            results: [{
              metricId: 'length',
              resultKind: 'score',
              value: invocation.bindings.actual.length + 1,
              evidence: { value: { rule: 'length-plus-offset' }, classification: 'public' },
            }],
            usage: { totalTokens: 1 },
          };
        },
      },
    } satisfies CustomEvaluator<{ actual: string; }>;
    const input = pairedInput();
    const result = await evaluate({
      ...input,
      evaluators: [...input.evaluators, custom],
      comparisons: [{ ...input.comparisons[0], metricIds: ['correct', 'length'] }],
      analyses: [
        ...input.analyses,
        ...comparisonAnalysis('length'),
      ],
      decision: undefined
    }, {
      runId: 'custom-evaluator',
      clock: fixedClock
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(seen).toHaveLength(4);
    expect(seen.every((invocation) => !('expected' in invocation))).toBe(true);
    expect(seen.every((invocation) => invocation.attemptNumber === 1)).toBe(true);
    expect(result.definition.evaluators.find((candidate) => (
      candidate.evaluatorId === 'output-length'
    ))).toMatchObject({
      evaluatorKind: 'custom',
      implementationId: 'test.output-length/v1',
      metricIds: ['length'],
      inputs: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
      config: { offset: 1 },
    });
    const observations = result.artifacts.evaluation.records.flatMap((record) => (
      record.evaluatorId === 'output-length' && record.evaluationStatus === 'completed'
        ? record.observations
        : []
    ));
    expect(observations).toHaveLength(4);
    expect(observations.every((observation) => (
      observation.observationStatus === 'observed' && observation.valueType === 'numeric'
    ))).toBe(true);
    expect(result.artifacts.evaluation.records.filter((record) => (
      record.evaluatorId === 'output-length'
    )).every((record) => (
      record.evaluationStatus === 'completed' && record.usage?.totalTokens === 1
    ))).toBe(true);
    expect(result.artifacts.analysis.records).toHaveLength(2);
  });

it('records a schema-rejected custom score as invalid evidence', async () => {
    const input = pairedInput();
    const result = await evaluate({
      ...input,
      evaluators: [{
        evaluatorKind: 'custom',
        evaluatorId: 'strict-number',
        instrumentId: 'strict-number-v1',
        metrics: [{
          metricId: 'strict-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        }],
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: {
          implementationId: 'test.strict-number/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({ actual: z.string() }).strict(),
            values: { 'strict-score': z.number() },
            fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
          },
          fingerprintFacets: { revision: 'test-one' },
          async evaluate() {
            return {
              resultKind: 'completed',
              results: [{ metricId: 'strict-score', resultKind: 'score', value: 'not-a-number' }],
            };
          },
        },
      }],
      comparisons: [{ ...input.comparisons[0], metricIds: ['strict-score'] }],
      analyses: comparisonAnalysis('strict-score'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-invalid',
      clock: fixedClock
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.evaluation.records.flatMap((record) => (
      record.evaluationStatus === 'completed' ? record.observations : []
    )))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          observationStatus: 'invalid',
          reasonCode: 'custom-evaluator-value-invalid',
          invalidValue: expect.objectContaining({ classification: 'gold' }),
        }),
      ]));
    expect(result.artifacts.analysis.records[0]).toMatchObject({
      analysisStatus: 'inconclusive',
    });

    let transformedBindingCalls = 0;
    const transformedBindings = numericCustomEvaluator('transformed-bindings', () => {
      transformedBindingCalls += 1;
      return {
        resultKind: 'completed',
        results: [{ metricId: 'transformed-bindings-score', resultKind: 'score', value: 1 }],
      };
    });
    const transformedResult = await evaluate({
      ...input,
      evaluators: [{
        ...transformedBindings,
        implementation: {
          ...transformedBindings.implementation,
          schemas: {
            ...transformedBindings.implementation.schemas,
            bindings: z.object({ actual: z.string() }).strict()
              .transform(({ actual }) => ({ actual: `${actual}-changed` })),
          },
        },
      }],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['transformed-bindings-score'],
      }],
      analyses: comparisonAnalysis('transformed-bindings-score'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-transformed-bindings',
      clock: fixedClock
    });
    expect(transformedResult.status).toBe('completed');
    expect(transformedBindingCalls).toBe(0);
    expect(transformedResult.artifacts?.evaluation?.records.flatMap((record) => (
      record.evaluationStatus === 'completed' ? record.observations : []
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        observationStatus: 'invalid',
        reasonCode: 'custom-evaluator-bindings-invalid',
      }),
    ]));
  });

it('projects every supported custom binding source through its declared JSON Pointer', async () => {
    const base = executor();
    const traceExecutor: Executor<Input, Config, string, { steps: string[]; }> = {
      ...base,
      schemas: {
        ...base.schemas,
        trace: z.object({ steps: z.array(z.string()) }).strict(),
      },
      capabilities: {
        ...base.capabilities,
        telemetry: { trace: 'required', usage: 'optional' },
      },
      async execute({ input: executionInput, config }) {
        return {
          output: config.answers[executionInput.prompt],
          trace: { steps: ['generated'] },
        };
      },
    };
    const input = pairedInput(traceExecutor);
    const seen: Array<Record<string, unknown>> = [];
    const result = await evaluate({
      ...input,
      dataset: {
        ...input.dataset,
        samples: input.dataset.samples.map((sample) => ({
          ...sample,
          evaluationContext: { domain: 'qa' },
        })),
      },
      evaluators: [{
        evaluatorKind: 'custom',
        evaluatorId: 'all-bindings',
        instrumentId: 'all-bindings-v1',
        metrics: [{
          metricId: 'all-bindings-valid',
          valueType: 'boolean',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        }],
        bindings: [
          { bindingId: 'actual', sourceKind: 'output', pointer: '' },
          { bindingId: 'facts', sourceKind: 'execution-facts', pointer: '' },
          { bindingId: 'domain', sourceKind: 'evaluation-context', pointer: '/domain' },
          { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
          { bindingId: 'step', sourceKind: 'trace', pointer: '/steps/0' },
        ],
        implementation: {
          implementationId: 'test.all-bindings/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({
              actual: z.string(),
              facts: z.record(z.string(), z.json()),
              domain: z.string(),
              expected: z.string(),
              step: z.string(),
            }).strict(),
            values: { 'all-bindings-valid': z.boolean() },
            fingerprintFacets: { bindings: 'all-sources/v1', value: 'boolean/v1' },
          },
          fingerprintFacets: { revision: 'test-one' },
          evaluate({ bindings }) {
            seen.push(bindings);
            return {
              resultKind: 'completed',
              results: [{
                metricId: 'all-bindings-valid',
                resultKind: 'score',
                value: bindings.facts.attemptCount === 1
                    && bindings.domain === 'qa'
                    && bindings.step === 'generated'
                    && typeof bindings.actual === 'string'
                    && typeof bindings.expected === 'string',
              }],
            };
          },
        },
      } satisfies CustomEvaluator<{
        actual: string;
        facts: Record<string, JsonValue>;
        domain: string;
        expected: string;
        step: string;
      }>],
      comparisons: [{ ...input.comparisons[0], metricIds: ['all-bindings-valid'] }],
      analyses: comparisonAnalysis('all-bindings-valid'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-all-bindings',
      clock: fixedClock
    });

    expect(result.status).toBe('completed');
    expect(seen).toHaveLength(4);
    expect(seen.every((bindings) => Object.keys(bindings).sort().join(',')
      === 'actual,domain,expected,facts,step')).toBe(true);
  });

it('keeps qualitative custom observations as evidence without fabricating an estimator', async () => {
    const input = pairedInput();
    const result = await evaluate({
      ...input,
      evaluators: [
        qualitativeCustomEvaluator('answer-category', 'categorical', z.string(), ({ sampleId, bindings }) => sampleId === 'two'
          ? {
            resultKind: 'completed',
            results: [{
              metricId: 'answer-category-value',
              resultKind: 'missing',
              reasonCode: 'label-not-available',
            }],
          }
          : {
            resultKind: 'completed',
            results: [{ metricId: 'answer-category-value', resultKind: 'score', value: bindings.actual }],
          }),
        qualitativeCustomEvaluator('answer-text', 'text', z.enum(['empty', 'non-empty']), ({ bindings }) => ({
          resultKind: 'completed',
          results: [{
            metricId: 'answer-text-value',
            resultKind: 'score',
            value: bindings.actual === '' ? 'empty' : 'non-empty',
          }],
        })),
        qualitativeCustomEvaluator('answer-ranking', 'ranking', z.array(z.enum(['empty', 'non-empty', 'fallback'])).min(1), ({ bindings }) => ({
          resultKind: 'completed',
          results: [{
            metricId: 'answer-ranking-value',
            resultKind: 'score',
            value: bindings.actual === '' ? ['empty'] : ['non-empty', 'fallback'],
          }],
        })),
      ],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['answer-category-value', 'answer-text-value', 'answer-ranking-value'],
      }],
      analyses: [],
      decision: undefined
    }, {
      runId: 'custom-evaluator-categorical',
      clock: fixedClock
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.analysisGraph.nodes).toEqual([]);
    expect(result.artifacts.analysis.records).toEqual([]);
    expect(result.artifacts.evaluation.records.flatMap((record) => (
      record.evaluationStatus === 'completed' ? record.observations : []
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ observationStatus: 'observed', valueType: 'categorical' }),
      expect.objectContaining({ observationStatus: 'observed', valueType: 'text' }),
      expect.objectContaining({ observationStatus: 'observed', valueType: 'ranking' }),
      expect.objectContaining({
        observationStatus: 'missing',
        reasonCode: 'label-not-available',
      }),
    ]));
  });

it('routes multiple bindings of one custom implementation without cross-wiring them', async () => {
    const input = pairedInput();
    const implementation = (suffix: string) => ({
      implementationId: 'test.shared-custom/v1',
      version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.string() }).strict(),
        values: { [`shared-${suffix}-score`]: z.number() },
        fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
      },
      fingerprintFacets: { revision: 'test-one', suffix },
      evaluate: ({ bindings }) => ({
        resultKind: 'completed',
        results: [{
          metricId: `shared-${suffix}-score`,
          resultKind: 'score' as const,
          value: suffix === 'length' ? bindings.actual.length : Number(bindings.actual === 'A'),
        }],
      }),
    } satisfies CustomEvaluator<{ actual: string; }>['implementation']);
    const result = await evaluate({
      ...input,
      evaluators: [{
        evaluatorKind: 'custom',
        evaluatorId: 'shared-length',
        instrumentId: 'shared-length-v1',
        metrics: [{
          metricId: 'shared-length-score',
          valueType: 'numeric',
          direction: 'lower-is-better',
          missingPolicyId: 'exclude/v1',
        }],
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: implementation('length'),
      }, {
        evaluatorKind: 'custom',
        evaluatorId: 'shared-is-a',
        instrumentId: 'shared-is-a-v1',
        metrics: [{
          metricId: 'shared-is-a-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        }],
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: implementation('is-a'),
      }],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['shared-length-score', 'shared-is-a-score'],
      }],
      analyses: [
        ...comparisonAnalysis('shared-length-score'),
        ...comparisonAnalysis('shared-is-a-score'),
      ],
      decision: undefined
    }, {
      runId: 'custom-evaluator-shared-implementation',
      clock: fixedClock
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.analysis.records).toHaveLength(2);
    expect(new Set(result.artifacts.evaluation.records.map((record) => record.evaluatorId)))
      .toEqual(new Set(['shared-length', 'shared-is-a']));
  });

it('redacts thrown custom Evaluator failures and lets Core enforce timeout cancellation', async () => {
    const privateMessage = 'private custom evaluator provider detail';
    const input = pairedInput();
    const failed = await evaluate({
      ...input,
      evaluators: [{
        evaluatorKind: 'custom',
        evaluatorId: 'throwing-custom',
        instrumentId: 'throwing-custom-v1',
        metrics: [{
          metricId: 'throwing-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        }],
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: {
          implementationId: 'test.throwing-custom/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({ actual: z.string() }).strict(),
            values: { 'throwing-score': z.number() },
            fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
          },
          fingerprintFacets: { revision: 'test-one' },
          evaluate() {
            throw new Error(privateMessage);
          },
        },
      }],
      comparisons: [{ ...input.comparisons[0], metricIds: ['throwing-score'] }],
      analyses: comparisonAnalysis('throwing-score'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-thrown-failure',
      clock: fixedClock
    });
    expect(failed.status).toBe('completed');
    expect(JSON.stringify(failed)).not.toContain(privateMessage);
    expect(failed.artifacts?.evaluation?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evaluationStatus: 'failed',
        error: expect.objectContaining({ code: 'evaluator-error' }),
      }),
    ]));

    let observedAbort = false;
    const timedOut = await evaluate({
      ...input,
      evaluators: [{
        evaluatorKind: 'custom',
        evaluatorId: 'slow-custom',
        instrumentId: 'slow-custom-v1',
        metrics: [{
          metricId: 'slow-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        }],
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: {
          implementationId: 'test.slow-custom/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({ actual: z.string() }).strict(),
            values: { 'slow-score': z.number() },
            fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
          },
          fingerprintFacets: { revision: 'test-one' },
          async evaluate({ signal }) {
            await new Promise((_resolve, reject) => {
              const abort = () => {
                observedAbort = true;
                reject(signal.reason);
              };
              if (signal.aborted)
                abort();
              else
                signal.addEventListener('abort', abort, { once: true });
            });
            return {
              resultKind: 'completed',
              results: [{ metricId: 'slow-score', resultKind: 'score', value: 1 }],
            };
          },
        },
      }],
      comparisons: [{ ...input.comparisons[0], metricIds: ['slow-score'] }],
      analyses: comparisonAnalysis('slow-score'),
      decision: undefined,
      policy: {
        ...input.policy,
        evaluation: { ...input.policy.evaluation, timeoutMs: 5 },
      }
    }, {
      runId: 'custom-evaluator-timeout'
    });
    expect(timedOut.status).toBe('completed');
    expect(observedAbort).toBe(true);
    expect(timedOut.artifacts?.evaluation?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evaluationStatus: 'failed',
        error: expect.objectContaining({ code: 'timeout' }),
      }),
    ]));
  });

it('preserves stable custom failures and prevents callbacks from bypassing Core budget', async () => {
    const input = pairedInput();
    const stableFailure = await evaluate({
      ...input,
      evaluators: [numericCustomEvaluator('stable-failure', () => ({
        resultKind: 'failed',
        errorCode: 'custom-service-unavailable',
        usage: { totalTokens: 3 },
      }))],
      comparisons: [{ ...input.comparisons[0], metricIds: ['stable-failure-score'] }],
      analyses: comparisonAnalysis('stable-failure-score'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-stable-failure',
      clock: fixedClock
    });
    expect(stableFailure.status).toBe('completed');
    expect(stableFailure.artifacts?.evaluation?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evaluationStatus: 'failed',
        error: expect.objectContaining({ code: 'custom-service-unavailable' }),
        usage: expect.objectContaining({ totalTokens: 3 }),
      }),
    ]));

    let calls = 0;
    const budgeted = await evaluate({
      ...input,
      evaluators: [numericCustomEvaluator('budgeted', () => {
        calls += 1;
        return {
          resultKind: 'completed',
          results: [{ metricId: 'budgeted-score', resultKind: 'score', value: 1 }],
        };
      })],
      comparisons: [{ ...input.comparisons[0], metricIds: ['budgeted-score'] }],
      analyses: comparisonAnalysis('budgeted-score'),
      decision: undefined,
      policy: { ...input.policy, budget: { run: { maxInvocations: 4 } } }
    }, {
      runId: 'custom-evaluator-budget',
      clock: fixedClock
    });
    expect(budgeted.status).toBe('budget-exhausted');
    expect(calls).toBe(0);
    expect(budgeted.artifacts?.evaluation?.records.every((record) => (
      record.evaluationStatus === 'not-evaluated'
    ))).toBe(true);
  });
});
