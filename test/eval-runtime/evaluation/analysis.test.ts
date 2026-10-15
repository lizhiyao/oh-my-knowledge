import { describe, expect, it } from "vitest";
import { evaluate, prepareEvaluation, type CustomEvaluator } from "../../../src/eval-runtime/index.js";
import { EvaluationDefinitionSchema } from "../../../src/eval-core/contracts/index.js";
import { controlSpec, executor, fixedClock, numericCustomEvaluator, pairedInput, stableFacadeId, treatmentSpec, variant } from '../fixtures/evaluation.js';

describe('canonical eval-runtime analysis', () => {
it('evaluates an explicit paired comparison without assigning a global experiment role', async () => {
    const seen: Array<{ variantId: string; artifactName: string; model?: string; }> = [];
    const declaration = executor(async (invocation) => {
      seen.push({
        variantId: invocation.variantId,
        artifactName: invocation.artifact.name,
        model: (invocation.runtimeContext?.values as { model?: string; } | undefined)?.model,
      });
      return { output: invocation.config.answers[invocation.input.prompt] };
    });
    const result = await evaluate(pairedInput(declaration));

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    expect(result.definition.targets.map((target) => (
      (target.config as { schemaVersion: string; }).schemaVersion
    ))).toEqual([
      'omk.eval-runtime.variant-config/v3',
      'omk.eval-runtime.variant-config/v3',
    ]);
    expect(result.definition.comparisons).toEqual([{
      comparisonId: 'baseline-vs-candidate',
      controlTargetId: 'prompt-v1',
      treatmentTargetIds: ['prompt-v2'],
      metricIds: ['correct'],
    }]);
    expect(result.definition.decisionPolicy).toMatchObject({
      implementationId: 'progress/v2',
      comparisonFamily: [{
        comparisonId: 'baseline-vs-candidate',
        treatmentTargetId: 'prompt-v2',
        metricId: 'correct',
      }],
    });
    expect(result.analysisResults['baseline-vs-candidate-correct']).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 0.5 },
    });
    // fingerprint 的具体 sha256 值属实现细节(随 facet 算法变化),契约是存在且格式正确。
    expect(result.artifacts.execution.records[0].runtime.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(new Set(seen.map((item) => item.variantId))).toEqual(
      new Set(['prompt-v1', 'prompt-v2']),
    );
    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({
        variantId: 'prompt-v2',
        artifactName: 'candidate',
        model: 'test-model',
      }),
    ]));
  });

it('estimates one Variant quality inside a paired experiment at the paired-block unit', async () => {
    const input = pairedInput();
    const result = await evaluate({
      ...input,
      analyses: [...input.analyses, {
        analysisId: 'candidate-quality',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
      decision: undefined
    }, {
      runId: 'paired-quality',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.analysisResults['candidate-quality']).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 1, unitCount: 2 },
    });
  });

it('materializes one sealed composite Metric for quality and paired comparison analyses', async () => {
    const input = pairedInput();
    const baseLength = numericCustomEvaluator('response-length', ({ bindings }) => ({
      resultKind: 'completed',
      results: [{ metricId: 'response-length-score', resultKind: 'score', value: bindings.actual.length }],
    }));
    const length: CustomEvaluator<{ actual: string }> = {
      ...baseLength,
      metrics: [{
        metricId: 'response-length-score',
        valueType: 'numeric',
        scale: { min: 0, max: 5 },
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      }],
    };
    const components = [
      { metricId: 'correct', weight: 0.5 },
      { metricId: 'response-length-score', weight: 0.5 },
    ] as const;
    const composite = {
      compositeMetricId: 'overall-quality',
      components,
      aggregation: { method: 'weighted-mean' as const, missing: 'require-complete' as const },
      confidence: { method: 'percentile-bootstrap' as const, level: 0.95, resamples: 64 },
    };
    const declaration = {
      ...input,
      evaluators: [...input.evaluators, length],
      analyses: [{
        analysisId: 'candidate-overall-quality',
        analysisKind: 'composite-quality-interval' as const,
        variantId: treatmentSpec.variantId,
        ...composite,
      }, {
        analysisId: 'overall-quality-difference',
        analysisKind: 'composite-comparison-interval' as const,
        comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId,
        ...composite,
      }],
      decision: {
        decisionKind: 'analysis' as const,
        analysisId: 'overall-quality-difference',
        threshold: 0,
      },
    };
    const canonical = await prepareEvaluation(declaration);
    const reversed = await prepareEvaluation({
      ...declaration,
      analyses: declaration.analyses.map((analysis) => ({
        ...analysis,
        components: [...analysis.components].reverse() as [
          typeof components[number],
          typeof components[number],
        ],
      })),
    });
    const base = await prepareEvaluation({
      ...declaration,
      analyses: [],
      decision: undefined,
    });
    const compositeMetric = {
      metricId: 'overall-quality',
      valueType: 'numeric' as const,
      scope: 'sample' as const,
      scale: { min: 0, max: 1 },
      unit: 'utility',
      direction: 'higher-is-better' as const,
      missingPolicyId: 'exclude/v1',
    };
    const compositeParameters = {
      compositeMetricId: 'overall-quality',
      components: [
        { metricId: 'correct', weight: 0.5 },
        { metricId: 'response-length-score', weight: 0.5 },
      ],
      aggregation: { method: 'weighted-mean', missing: 'require-complete' },
      resamples: 64,
      alpha: 0.05,
    };
    const manualCoreDefinition = EvaluationDefinitionSchema.parse({
      ...base.definition,
      metrics: [...base.definition.metrics, compositeMetric],
      comparisons: base.definition.comparisons.map((comparison) => ({
        ...comparison,
        metricIds: [...comparison.metricIds, compositeMetric.metricId],
      })),
      analysisGraph: {
        analysisMode: 'preregistered',
        nodes: [{
          analysisNodeKind: 'estimator',
          nodeId: stableFacadeId('node', { analysisId: 'candidate-overall-quality' }),
          implementationId: 'bootstrap.composite-mean-percentile/v1',
          inputs: compositeParameters.components.map((component) => ({
            inputKind: 'metric-observations',
            referenceId: component.metricId,
          })),
          outputResultId: 'candidate-overall-quality',
          targetFilter: { includeTargetIds: ['prompt-v2'] },
          parameters: compositeParameters,
        }, {
          analysisNodeKind: 'estimator',
          nodeId: stableFacadeId('node', { analysisId: 'overall-quality-difference' }),
          implementationId: 'bootstrap.composite-paired-difference-percentile/v1',
          inputs: [
            ...compositeParameters.components.map((component) => ({
              inputKind: 'metric-observations' as const,
              referenceId: component.metricId,
            })),
            {
              inputKind: 'comparison',
              referenceId: 'baseline-vs-candidate',
              treatmentTargetId: 'prompt-v2',
              metricId: 'overall-quality',
            },
          ],
          outputResultId: 'overall-quality-difference',
          parameters: compositeParameters,
        }],
      },
      decisionPolicy: {
        decisionPolicyId: stableFacadeId('decision', {
          decisionKind: 'analysis',
          resultId: 'overall-quality-difference',
        }),
        implementationId: 'progress/v2',
        analysisResultIds: ['overall-quality-difference'],
        comparisonFamily: [{
          comparisonId: 'baseline-vs-candidate',
          treatmentTargetId: 'prompt-v2',
          metricId: 'overall-quality',
          analysisResultId: 'overall-quality-difference',
        }],
        minimumEvidenceStatus: 'complete',
        parameters: { threshold: 0, equivalence: 0 },
      },
    });

    expect(canonical.definition).toEqual(manualCoreDefinition);
    expect(reversed.definition).toEqual(canonical.definition);
    expect(reversed.planDigest).toBe(canonical.planDigest);
    expect(canonical.definition.metrics).toContainEqual({
      metricId: 'overall-quality',
      valueType: 'numeric',
      scope: 'sample',
      scale: { min: 0, max: 1 },
      unit: 'utility',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    });
    expect(canonical.definition.comparisons[0].metricIds).toEqual([
      'correct',
      'overall-quality',
    ]);
    expect(canonical.definition.decisionPolicy).toMatchObject({
      analysisResultIds: ['overall-quality-difference'],
      comparisonFamily: [{
        comparisonId: 'baseline-vs-candidate',
        treatmentTargetId: 'prompt-v2',
        metricId: 'overall-quality',
        analysisResultId: 'overall-quality-difference',
      }],
    });
    expect(canonical.definition.analysisGraph.nodes.map((node) => ({
      implementationId: node.implementationId,
      outputResultId: node.outputResultId,
    }))).toEqual(expect.arrayContaining([{
      implementationId: 'bootstrap.composite-mean-percentile/v1',
      outputResultId: 'candidate-overall-quality',
    }, {
      implementationId: 'bootstrap.composite-paired-difference-percentile/v1',
      outputResultId: 'overall-quality-difference',
    }]));

    const result = await canonical.run({ runId: 'runtime-composite', clock: fixedClock });
    const reorderedResult = await reversed.run({ runId: 'runtime-composite', clock: fixedClock });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(reorderedResult.artifacts).toEqual(result.artifacts);
    expect(result.analysisResults['candidate-overall-quality']).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 0.9, unitCount: 2 },
      coverage: { included: 4, comparable: 4 },
    });
    expect(result.analysisResults['overall-quality-difference']).toMatchObject({
      analysisStatus: 'completed',
      value: { unitCount: 2 },
      coverage: { included: 8, comparable: 8 },
    });
    const difference = result.analysisResults['overall-quality-difference'];
    if (difference.analysisStatus !== 'completed' || difference.resultType !== 'interval'
        || difference.value === null || Array.isArray(difference.value)
        || typeof difference.value !== 'object') throw new Error('Expected composite interval.');
    expect((difference.value as { estimate: number }).estimate).toBeCloseTo(0.45);
    expect(result.artifacts?.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'NOISE',
    });
  });

it('rejects unbounded source Metrics and inexact composite weights before execution', async () => {
    let targetInvocations = 0;
    const input = pairedInput(executor(async ({ input: sample, config }) => {
      targetInvocations += 1;
      return { output: config.answers[sample.prompt] };
    }));
    const unbounded = numericCustomEvaluator('unbounded-length', ({ bindings }) => ({
      resultKind: 'completed',
      results: [{ metricId: 'unbounded-length-score', resultKind: 'score', value: bindings.actual.length }],
    }));
    const analysis = {
      analysisId: 'invalid-composite',
      analysisKind: 'composite-quality-interval' as const,
      compositeMetricId: 'overall-quality',
      variantId: treatmentSpec.variantId,
      components: [
        { metricId: 'correct', weight: 0.5 },
        { metricId: 'unbounded-length-score', weight: 0.5 },
      ] as const,
      aggregation: { method: 'weighted-mean' as const, missing: 'require-complete' as const },
      confidence: { method: 'percentile-bootstrap' as const, level: 0.95, resamples: 64 },
    };
    await expect(prepareEvaluation({
      ...input,
      evaluators: [...input.evaluators, unbounded],
      analyses: [analysis],
      decision: undefined,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    const bounded: CustomEvaluator<{ actual: string }> = {
      ...unbounded,
      metrics: [{
        metricId: 'unbounded-length-score',
        valueType: 'numeric',
        scale: { min: 0, max: 5 },
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      }],
    };
    await expect(prepareEvaluation({
      ...input,
      evaluators: [...input.evaluators, bounded],
      analyses: [{
        ...analysis,
        components: [
          { metricId: 'correct', weight: 0.5 },
          { metricId: 'unbounded-length-score', weight: 0.5000000000005 },
        ],
      }],
      decision: undefined,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    expect(targetInvocations).toBe(0);
  });

it('does not expose a derived composite Metric as direct observation evidence', async () => {
    const input = pairedInput();
    const baseLength = numericCustomEvaluator('derived-boundary-length', ({ bindings }) => ({
      resultKind: 'completed',
      results: [{ metricId: 'derived-boundary-length-score', resultKind: 'score', value: bindings.actual.length }],
    }));
    const length: CustomEvaluator<{ actual: string }> = {
      ...baseLength,
      metrics: [{
        metricId: 'derived-boundary-length-score',
        valueType: 'numeric',
        scale: { min: 0, max: 5 },
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      }],
    };
    const composite = {
      analysisId: 'candidate-derived-quality',
      analysisKind: 'composite-quality-interval' as const,
      compositeMetricId: 'derived-quality',
      variantId: treatmentSpec.variantId,
      components: [
        { metricId: 'correct', weight: 0.5 },
        { metricId: 'derived-boundary-length-score', weight: 0.5 },
      ] as const,
      aggregation: { method: 'weighted-mean' as const, missing: 'require-complete' as const },
      confidence: { method: 'percentile-bootstrap' as const, level: 0.95, resamples: 32 },
    };

    await expect(prepareEvaluation({
      ...input,
      evaluators: [...input.evaluators, length],
      analyses: [composite, {
        analysisId: 'invalid-direct-derived-quality',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'derived-quality',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
      decision: undefined,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    await expect(prepareEvaluation({
      ...input,
      evaluators: [...input.evaluators, length],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: [...input.comparisons[0].metricIds, 'derived-quality'],
      }],
      analyses: [composite],
      decision: undefined,
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

it('produces a solo quality profile without a fabricated Comparison', async () => {
    const declaration = executor();
    const result = await evaluate({
      dataset: pairedInput().dataset,
      variants: [variant(declaration, treatmentSpec)],
      evaluators: [{ evaluatorKind: 'exact-match' }],
      comparisons: [],
      analyses: [{
        analysisId: 'candidate-quality',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 100 },
      }],
      experiment: { seed: 'solo-seed', sampling: { samplingKind: 'solo' } },
      decision: {
        decisionKind: 'analysis',
        analysisId: 'candidate-quality',
        threshold: 0.5,
      },
      policy: {}
    }, {
      runId: 'solo-quality',
      clock: fixedClock
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    expect(result.definition.comparisons).toEqual([]);
    expect(result.definition.experiment.sampling).toMatchObject({
      experimentalUnit: 'sample',
      resamplingUnit: 'sample',
      estimatorId: 'bootstrap.mean-percentile/v1',
      seedCoupling: 'independent-by-target',
    });
    expect(result.definition.analysisGraph.nodes).toHaveLength(1);
    expect(result.definition.analysisGraph.nodes[0]).toMatchObject({
      implementationId: 'bootstrap.mean-percentile/v1',
      inputs: [{ inputKind: 'metric-observations', referenceId: 'correct' }],
    });
    expect(result.artifacts.execution?.records).toHaveLength(2);
  });

it('compiles explicit summaries with target and cohort selection', async () => {
    const declaration = executor();
    const input = pairedInput(declaration);
    const length = numericCustomEvaluator('summary-length', ({ bindings }) => ({
      resultKind: 'completed',
      results: [{ metricId: 'summary-length-score', resultKind: 'score', value: bindings.actual.length }],
    }));
    const result = await evaluate({
      ...input,
      dataset: {
        ...input.dataset,
        analysisCohorts: [{
          cohortId: 'first-sample',
          cohortSetId: 'position',
          cohortSetKind: 'cohort',
          classification: 'public',
          disclosure: 'identity-only',
        }],
        samples: input.dataset.samples.map((sample, index) => ({
          ...sample,
          ...(index === 0 ? {
            analysis: { memberships: [{ cohortId: 'first-sample' }] },
          } : {}),
        })),
      },
      evaluators: [...input.evaluators, length],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'summary-length-score'],
      }],
      analyses: [{
        analysisId: 'control-first-rate',
        analysisKind: 'summary',
        statistic: 'rate',
        variantId: controlSpec.variantId,
        metricId: 'correct',
        cohortFilter: { includeCohortIds: ['first-sample'] },
      }, {
        analysisId: 'treatment-rate',
        analysisKind: 'summary',
        statistic: 'rate',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
      }, {
        analysisId: 'treatment-p50-length',
        analysisKind: 'summary',
        statistic: 'quantile',
        probability: 0.5,
        variantId: treatmentSpec.variantId,
        metricId: 'summary-length-score',
      }],
      decision: undefined
    }, {
      runId: 'explicit-summaries',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.analysisResults['control-first-rate']).toMatchObject({
      analysisStatus: 'completed',
      value: 1,
    });
    expect(result.analysisResults['treatment-rate']).toMatchObject({
      analysisStatus: 'completed',
      value: 1,
    });
    expect(result.analysisResults['treatment-p50-length']).toMatchObject({
      analysisStatus: 'completed',
      value: 1,
    });
    expect(Object.isFrozen(result.analysisResults)).toBe(true);
    expect(result.analysisResults['control-first-rate']).toBe(
      result.artifacts.analysis.records.find((record) => (
        record.resultId === 'control-first-rate'
      )),
    );
    expect(result.definition.analysisGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outputResultId: 'control-first-rate',
        targetFilter: { includeTargetIds: [controlSpec.variantId] },
        cohortFilter: { includeCohortIds: ['first-sample'] },
      }),
      expect.objectContaining({
        outputResultId: 'treatment-rate',
        targetFilter: { includeTargetIds: [treatmentSpec.variantId] },
      }),
    ]));
  });

it('resamples declared clusters as indivisible quality units', async () => {
    const declaration = executor();
    const result = await evaluate({
      dataset: {
        datasetId: 'clustered-quality',
        samples: [
          { sampleId: 'a-1', input: { prompt: 'one' }, expected: 'A', executionContext: { cluster: 'a' } },
          { sampleId: 'a-2', input: { prompt: 'two' }, expected: 'B', executionContext: { cluster: 'a' } },
          { sampleId: 'b-1', input: { prompt: 'one' }, expected: 'A', executionContext: { cluster: 'b' } },
          { sampleId: 'b-2', input: { prompt: 'two' }, expected: 'B', executionContext: { cluster: 'b' } },
        ],
      },
      variants: [variant(declaration, treatmentSpec)],
      evaluators: [{ evaluatorKind: 'exact-match' }],
      comparisons: [],
      analyses: [{
        analysisId: 'clustered-correctness',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 64 },
      }],
      experiment: {
        seed: 'clustered-quality-seed',
        sampling: { samplingKind: 'solo', clusterKey: '/executionContext/cluster' },
      },
      policy: {}
    }, {
      runId: 'clustered-quality',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.experiment.sampling).toMatchObject({
      experimentalUnit: 'cluster',
      clusterKey: '/executionContext/cluster',
      resamplingUnit: 'cluster',
      estimatorId: 'bootstrap.cluster-percentile/v1',
    });
    expect(result.analysisResults['clustered-correctness']).toMatchObject({
      analysisStatus: 'completed',
      value: { estimate: 1, unitCount: 2 },
    });
  });

it('rejects missing cluster membership before the first Target call', async () => {
    let invocations = 0;
    const declaration = executor(async () => {
      invocations += 1;
      return { output: 'A' };
    });
    const input = pairedInput(declaration);

    await expect(evaluate({
      dataset: input.dataset,
      variants: [variant(declaration, treatmentSpec)],
      evaluators: [{ evaluatorKind: 'exact-match' }],
      comparisons: [],
      analyses: [{
        analysisId: 'clustered-correctness',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
      experiment: {
        seed: 'missing-cluster-membership',
        sampling: { samplingKind: 'solo', clusterKey: '/executionContext/cluster' },
      },
      policy: {}
    }, {
      runId: 'missing-cluster-membership'
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    expect(invocations).toBe(0);
  });
});
