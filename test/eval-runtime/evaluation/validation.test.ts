import { z } from "zod";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../../src/eval-runtime/index.js";
import { comparisonAnalysis, controlSpec, executor, numericCustomEvaluator, pairedInput, treatmentSpec, variant } from '../fixtures/evaluation.js';

describe('canonical eval-runtime validation', () => {
it('rejects implicit designs, duplicate identities, transformed config, and the removed API', async () => {
    const declaration = executor();
    await expect(evaluate({
      ...pairedInput(declaration),
      comparisons: [],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [
        { evaluatorKind: 'exact-match', metricId: 'same' },
        { evaluatorKind: 'exact-match', evaluatorId: 'another', metricId: 'same' },
      ],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });

    const custom = numericCustomEvaluator(
      'invalid-custom-config',
      () => ({
        resultKind: 'completed',
        results: [{ metricId: 'invalid-custom-config-score', resultKind: 'score', value: 1 }],
      }),
    );
    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [{
        ...custom,
        metrics: [{ ...custom.metrics[0], scope: 'run' }],
      } as never],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });

    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [{
        ...custom,
        bindings: [{
          bindingId: 'facts',
          sourceKind: 'execution-facts',
          pointer: '/attemptCount',
        }],
      }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });

    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [{
        ...custom,
        implementation: {
          ...custom.implementation,
          providerCost: {
            reporting: 'optional',
            trustedUpperBound: { amount: 1, currency: 'USD' },
          },
        },
      }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });

    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [custom, {
        ...custom,
        evaluatorId: 'invalid-custom-config-two',
        metrics: [{ ...custom.metrics[0], metricId: 'invalid-custom-config-two-score' }],
        implementation: {
          ...custom.implementation,
          version: '2.0.0',
          schemas: {
            ...custom.implementation.schemas,
            values: { 'invalid-custom-config-two-score': z.number() },
          },
        },
      }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });

    const lowerIsBetter = {
      ...custom,
      metrics: [{
        metricId: custom.metrics[0].metricId,
        valueType: 'numeric' as const,
        direction: 'lower-is-better' as const,
        missingPolicyId: 'exclude/v1' as const,
      }],
    };
    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [lowerIsBetter],
      comparisons: [{
        ...pairedInput(declaration).comparisons[0],
        metricIds: [lowerIsBetter.metrics[0].metricId],
      }],
      analyses: comparisonAnalysis(lowerIsBetter.metrics[0].metricId, 'lower-is-better'),
      decision: {
        decisionKind: 'analysis',
        analysisId: 'lower-is-better',
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    let invocations = 0;
    const transformed = {
      ...declaration,
      schemas: {
        ...declaration.schemas,
        config: z.object({ answers: z.record(z.string(), z.string()) })
          .transform((value) => ({ answers: { ...value.answers, injected: 'changed' } })),
      },
      async execute(invocation: Parameters<typeof declaration.execute>[0]) {
        invocations += 1;
        return declaration.execute(invocation);
      },
    };
    await expect(evaluate({
      ...pairedInput(transformed),
      variants: [variant(transformed, controlSpec), variant(transformed, treatmentSpec)],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
    expect(invocations).toBe(0);

    await expect(evaluate({
      executor: declaration,
      dataset: pairedInput().dataset,
      control: controlSpec,
      treatment: treatmentSpec,
      evaluator: { evaluatorKind: 'exact-match' },
      experiment: { seed: 'removed-api' },
      policy: {},
      runId: 'removed-api',
    } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

it('rejects duplicate Variants and artifact boundary violations without leaking payloads', async () => {
    const common = pairedInput();
    await expect(evaluate({
      ...common,
      variants: [common.variants[0], { ...common.variants[1], variantId: 'prompt-v1' }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });

    const privatePayload = 'must-not-appear-in-error';
    let failure: unknown;
    try {
      await evaluate({
        ...common,
        variants: [{
          ...common.variants[0],
          artifact: { ...common.variants[0].artifact, content: privatePayload },
        }, common.variants[1]],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });
    expect(String(failure)).not.toContain(privatePayload);
  });

it('rejects runtime-context boundary confusion and invalid Decision selectors', async () => {
    const common = pairedInput();
    await expect(evaluate({
      ...common,
      variants: [common.variants[0], {
        ...common.variants[1],
        execution: {
          ...common.variants[1].execution,
          runtimeContext: { cwd: '/tmp/unsealed-workspace' },
        },
      }],
    } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_VARIANT_INVALID' });

    await expect(evaluate({
      ...common,
      decision: {
        decisionKind: 'analysis',
        analysisId: 'missing-analysis',
      },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

it('rejects invalid Analysis declarations and obsolete wrappers before Target calls', async () => {
    let invocations = 0;
    const declaration = executor(async () => {
      invocations += 1;
      return { output: 'A' };
    });
    const common = pairedInput(declaration);

    await expect(evaluate({
      ...common,
      analysis: { analyses: common.analyses },
      analyses: undefined,
    } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    await expect(evaluate({
      ...common,
      comparisons: [{ ...common.comparisons[0], comparisonKind: 'paired' }],
    } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    const invalidAnalyses: unknown[] = [
      { bootstrap: { resamples: 100, confidenceLevel: 0.95 } },
      [common.analyses[0], common.analyses[0]],
      [{
        analysisId: 'unknown-metric', analysisKind: 'summary', statistic: 'rate',
        variantId: treatmentSpec.variantId, metricId: 'missing',
      }],
      [{
        analysisId: 'unknown-variant', analysisKind: 'summary', statistic: 'rate',
        variantId: 'missing', metricId: 'correct',
      }],
      [{
        analysisId: 'unknown-cohort', analysisKind: 'summary', statistic: 'rate',
        variantId: treatmentSpec.variantId, metricId: 'correct',
        cohortFilter: { includeCohortIds: ['missing'] },
      }],
      [{
        analysisId: 'empty-cohort-filter', analysisKind: 'summary', statistic: 'rate',
        variantId: treatmentSpec.variantId, metricId: 'correct', cohortFilter: {},
      }],
      [{
        analysisId: 'unknown-comparison', analysisKind: 'comparison-interval',
        statistic: 'mean-difference', comparisonId: 'missing',
        treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
      [{
        analysisId: 'wrong-statistic', analysisKind: 'summary', statistic: 'mean',
        variantId: treatmentSpec.variantId, metricId: 'correct',
      }],
      [{
        analysisId: 'missing-probability', analysisKind: 'summary', statistic: 'quantile',
        variantId: treatmentSpec.variantId, metricId: 'correct',
      }],
      [{
        analysisId: 'empty-family', analysisKind: 'comparison-family',
        statistic: 'mean-difference', members: [],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      [{
        analysisId: 'singleton-family', analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'only-member', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      [{
        analysisId: 'duplicate-family-id', analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'duplicate-family-id', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
        }, {
          analysisId: 'second-member', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      [{
        analysisId: 'duplicate-contrast-family', analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'first-member', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
        }, {
          analysisId: 'second-member', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      [{
        analysisId: 'unrepresentable-family-confidence', analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'unrepresentable-first', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
        }, {
          analysisId: 'unrepresentable-second', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId, metricId: 'other-metric',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap',
          level: 1 - Number.EPSILON / 2,
          resamples: 32,
        },
      }],
    ];
    for (const analysis of invalidAnalyses) {
      await expect(evaluate({
        ...common,
        analyses: analysis,
        decision: undefined,
      } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    }

    const decisionLength = numericCustomEvaluator(
      'decision-family-length',
      ({ bindings }) => ({
        resultKind: 'completed',
        results: [{ metricId: 'decision-family-length-score', resultKind: 'score', value: bindings.actual.length }],
      }),
    );
    await expect(evaluate({
      ...common,
      evaluators: [...common.evaluators, decisionLength],
      comparisons: [{
        ...common.comparisons[0],
        metricIds: ['correct', 'decision-family-length-score'],
      }],
      analyses: [{
        analysisId: 'candidate-rate',
        analysisKind: 'summary',
        statistic: 'rate',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
      }],
      decision: { decisionKind: 'analysis', analysisId: 'candidate-rate' },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    await expect(evaluate({
      ...common,
      analyses: [{
        analysisId: 'decision-family',
        analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'decision-first', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
        }, {
          analysisId: 'decision-second', comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'decision-family-length-score',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      decision: { decisionKind: 'analysis', analysisId: 'decision-family' },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    const decisionFamily = {
      analysisId: 'bounded-family',
      analysisKind: 'comparison-family' as const,
      statistic: 'mean-difference' as const,
      members: [{
        analysisId: 'bounded-correct', comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId, metricId: 'correct',
      }, {
        analysisId: 'bounded-length', comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId,
        metricId: 'decision-family-length-score',
      }],
      confidence: {
        method: 'bonferroni-percentile-bootstrap' as const, level: 0.95, resamples: 32,
      },
    };
    const invalidFamilyDecisions: unknown[] = [{
      decisionKind: 'comparison-family', analysisId: 'missing-family', rule: 'all',
      criteria: [
        { analysisId: 'bounded-correct', minimumEffect: 0 },
        { analysisId: 'bounded-length', maximumEffect: 0 },
      ],
    }, {
      decisionKind: 'comparison-family', analysisId: 'bounded-family', rule: 'all',
      criteria: [
        { analysisId: 'bounded-correct', minimumEffect: 0 },
        { analysisId: 'extra', maximumEffect: 0 },
      ],
    }, {
      decisionKind: 'comparison-family', analysisId: 'bounded-family', rule: 'all',
      criteria: [
        { analysisId: 'bounded-correct', minimumEffect: 0 },
        { analysisId: 'bounded-correct', maximumEffect: 0 },
      ],
    }, {
      decisionKind: 'comparison-family', analysisId: 'bounded-family', rule: 'all',
      criteria: [
        { analysisId: 'bounded-correct' },
        { analysisId: 'bounded-length', maximumEffect: 0 },
      ],
    }, {
      decisionKind: 'comparison-family', analysisId: 'bounded-family', rule: 'all',
      criteria: [
        { analysisId: 'bounded-correct', minimumEffect: 1, maximumEffect: 0 },
        { analysisId: 'bounded-length', maximumEffect: 0 },
      ],
    }];
    for (const decision of invalidFamilyDecisions) {
      await expect(evaluate({
        ...common,
        evaluators: [...common.evaluators, decisionLength],
        comparisons: [{
          ...common.comparisons[0],
          metricIds: ['correct', 'decision-family-length-score'],
        }],
        analyses: [decisionFamily],
        decision,
      } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    }
    expect(invocations).toBe(0);
  });

it('derives a bounded evaluator identity from the longest valid Metric identity', async () => {
    const metricId = 'm'.repeat(256);
    const result = await evaluate({
      dataset: {
        datasetId: 'long-metric-id',
        samples: [{ sampleId: 'one', input: { prompt: 'one' }, expected: 'A' }],
      },
      variants: [variant(executor(), treatmentSpec)],
      evaluators: [{ evaluatorKind: 'exact-match', metricId }],
      comparisons: [],
      analyses: [],
      experiment: { seed: 'long-metric-id', sampling: { samplingKind: 'solo' } },
      policy: {}
    }, {
      runId: 'long-metric-id'
    });

    expect(result.status).toBe('completed');
    expect(result.definition.evaluators[0].evaluatorId).toMatch(/^exact-match:[0-9a-f]{64}$/);
    expect(result.definition.metrics[0].metricId).toBe(metricId);
  });
});
