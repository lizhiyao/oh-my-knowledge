import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  EvaluationConfigurationError,
  EvaluationEventConsumptionError,
  assessComparability,
  checkExecutor,
  evaluate,
  prepareEvaluation,
  type Clock,
  type CustomEvaluator,
  type Executor,
  type Evaluator,
  type RubricJudgeEvaluator,
  type Variant,
} from '../../src/eval-runtime/index.js';
import {
  EVALUATION_DEFINITION_SCHEMA_VERSION,
  EvaluationDefinitionSchema,
  digestCanonicalJson,
  type JsonValue,
} from '../../src/eval-core/contracts/index.js';

type Input = { prompt: string; };
type Config = { answers: Record<string, string>; };

function executor(
  execute?: Executor<Input, Config, string>['execute'],
  input: Readonly<{ executorId?: string; revision?: string; }> = {},
): Executor<Input, Config, string> {
  return {
    executorId: input.executorId ?? 'test.answer-executor/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ answers: z.record(z.string(), z.string()) }).strict(),
      output: z.string(),
    },
    outputClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'optional' },
    },
    fingerprintFacets: { deploymentRevision: input.revision ?? 'test-one' },
    execute: execute ?? (async ({ input: invocationInput, config, signal }) => {
      signal.throwIfAborted();
      return { output: config.answers[invocationInput.prompt] };
    }),
  };
}

const controlSpec = {
  variantId: 'prompt-v1',
  artifact: {
    name: 'baseline',
    kind: 'baseline',
    source: 'baseline',
    content: null,
  },
  config: { answers: { one: 'A', two: 'wrong' } },
} as const;

const treatmentSpec = {
  variantId: 'prompt-v2',
  artifact: {
    name: 'candidate',
    kind: 'prompt',
    source: 'inline',
    content: 'Answer exactly.',
  },
  runtimeContext: { values: { model: 'test-model' } },
  config: { answers: { one: 'A', two: 'B' } },
} as const;

interface VariantSpec {
  readonly variantId: string;
  readonly artifact: Variant<Input, Config, string>['artifact'];
  readonly runtimeContext?: Variant<Input, Config, string>['execution']['runtimeContext'];
  readonly config: Config;
}

function variant(
  declaration: Executor<Input, Config, string>,
  spec: VariantSpec,
): Variant<Input, Config, string> {
  return {
    variantId: spec.variantId,
    artifact: spec.artifact,
    execution: {
      executor: declaration,
      ...('runtimeContext' in spec ? { runtimeContext: spec.runtimeContext } : {}),
      config: spec.config,
    },
  };
}

const fixedClock: Clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-09-04T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

function pairedInput(
  declaration: Executor<Input, Config, string> = executor(),
) {
  return {
    dataset: {
      datasetId: 'answers',
      samples: [
        { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
        { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
      ],
    },
    variants: [variant(declaration, controlSpec), variant(declaration, treatmentSpec)],
    evaluators: [{ evaluatorKind: 'exact-match' as const }],
    comparisons: [{
      comparisonId: 'baseline-vs-candidate',
      controlVariantId: controlSpec.variantId,
      treatmentVariantIds: [treatmentSpec.variantId],
      metricIds: ['correct'],
    }],
    analyses: [{
      analysisId: 'baseline-vs-candidate-correct',
      analysisKind: 'comparison-interval' as const,
      statistic: 'mean-difference' as const,
      comparisonId: 'baseline-vs-candidate',
      treatmentVariantId: treatmentSpec.variantId,
      metricId: 'correct',
      confidence: {
        method: 'percentile-bootstrap' as const,
        level: 0.95,
        resamples: 100,
      },
    }],
    experiment: {
      seed: 'fixed-seed',
      sampling: { samplingKind: 'paired' as const },
    },
    decision: {
      decisionKind: 'analysis' as const,
      analysisId: 'baseline-vs-candidate-correct',
    },
    policy: {
      execution: { maxConcurrency: 2 },
      evaluation: { maxConcurrency: 2 },
    },
  };
}

function comparisonAnalysis(metricId: string, analysisId = `${metricId}-difference`) {
  return [{
    analysisId,
    analysisKind: 'comparison-interval' as const,
    statistic: 'mean-difference' as const,
    comparisonId: 'baseline-vs-candidate',
    treatmentVariantId: treatmentSpec.variantId,
    metricId,
    confidence: {
      method: 'percentile-bootstrap' as const,
      level: 0.95,
      resamples: 100,
    },
  }];
}

function numericCustomEvaluator(
  evaluatorId: string,
  callback: CustomEvaluator<{ actual: string; }>['implementation']['evaluate'],
  revision = 'test-one',
): CustomEvaluator<{ actual: string; }> {
  return {
    evaluatorKind: 'custom',
    evaluatorId,
    instrumentId: `${evaluatorId}-v1`,
    metric: {
      metricId: `${evaluatorId}-score`,
      valueType: 'numeric',
      direction: 'higher-is-better',
      missingPolicyId: 'exclude/v1',
    },
    bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
    implementation: {
      implementationId: `test.${evaluatorId}/v1`,
      version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.string() }).strict(),
        value: z.number(),
        fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
      },
      fingerprintFacets: { revision },
      evaluate: callback,
    },
  };
}

function qualitativeCustomEvaluator(
  evaluatorId: string,
  valueType: 'categorical' | 'text' | 'ranking',
  valueParser: Readonly<{ parse(value: unknown): JsonValue; }>,
  callback: CustomEvaluator<{ actual: string; }>['implementation']['evaluate'],
): CustomEvaluator<{ actual: string; }> {
  return {
    evaluatorKind: 'custom',
    evaluatorId,
    instrumentId: `${evaluatorId}-v1`,
    metric: { metricId: `${evaluatorId}-value`, valueType, missingPolicyId: 'exclude/v1' },
    bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
    implementation: {
      implementationId: `test.${evaluatorId}/v1`,
      version: '1.0.0',
      schemas: {
        bindings: z.object({ actual: z.string() }).strict(),
        value: valueParser,
        fingerprintFacets: { bindings: 'actual-string/v1', value: `${valueType}/v1` },
      },
      fingerprintFacets: { revision: 'test-one' },
      evaluate: callback,
    },
  };
}

function stableFacadeId(
  identityKind: 'node' | 'decision' | 'slot',
  selector: Readonly<Record<string, string>>,
): string {
  return `${identityKind}:${digestCanonicalJson({
    derivation: 'omk.eval-runtime.definition-binding/v1',
    selector,
  }).slice('sha256:'.length)}`;
}

describe('canonical eval-runtime API', () => {
  it('prepares one immutable executable Plan without calling a Target or Evaluator', async () => {
    let targetInvocations = 0;
    const declaration = executor(async ({ input, config, signal }) => {
      targetInvocations += 1;
      signal.throwIfAborted();
      return { output: config.answers[input.prompt] };
    });
    const input = pairedInput(declaration);
    const prepared = await prepareEvaluation(input);
    const sealedDefinition = digestCanonicalJson(prepared.definition);

    expect(targetInvocations).toBe(0);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.plan)).toBe(true);
    expect(Object.isFrozen(prepared.definition.dataset.samples)).toBe(true);
    expect(prepared.definition).toBe(prepared.plan.definition);
    expect(prepared.policy).toBe(prepared.plan.measurementPolicy);
    expect(prepared.planDigest).toBe(prepared.plan.digests.runContractDigest);
    expect(prepared.estimatedWork).toEqual({
      sampleCount: 2,
      variantCount: 2,
      trialCount: 1,
      executionCoordinates: 4,
      evaluationCoordinates: 4,
      plannedInvocations: 8,
      uncertain: [
        'early-termination',
        'active-duration',
        'wall-clock',
        'provider-cost',
      ],
    });
    expect(prepared.resolvedRuntimes.map(({ runtimeKind }) => runtimeKind)).toEqual(
      expect.arrayContaining(['executor', 'evaluator', 'analysis-node', 'decision-policy']),
    );

    input.dataset.samples[0].input.prompt = 'two';
    (input.variants[1].execution as { config?: Config; }).config = {
      answers: { ...input.variants[1].execution.config!.answers, one: 'wrong' },
    };
    input.analyses[0].confidence.resamples = 32;
    input.policy.execution.maxConcurrency = 1;

    const result = await prepared.run({ runId: 'prepared-immutable', clock: fixedClock });
    expect(result.status).toBe('completed');
    expect(result.runId).toBe('prepared-immutable');
    expect(targetInvocations).toBe(4);
    expect(digestCanonicalJson(result.definition)).toBe(sealedDefinition);
    expect(result.definition).toBe(prepared.definition);
    expect(result.policy).toBe(prepared.policy);
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.runContractDigest).toBe(prepared.planDigest);
  });

  it('makes direct evaluate canonically equivalent and generates an omitted runId', async () => {
    const input = pairedInput();
    const prepared = await prepareEvaluation(input);
    const direct = await evaluate(input, { clock: fixedClock });
    const staged = await prepared.run({ clock: fixedClock });

    expect(direct.runId).toMatch(/^run-[0-9a-f-]{36}$/u);
    expect(staged.runId).toMatch(/^run-[0-9a-f-]{36}$/u);
    expect(staged.runId).not.toBe(direct.runId);
    expect(staged.definition).toEqual(direct.definition);
    expect(staged.policy).toEqual(direct.policy);
    expect(staged.status).toBe('completed');
    expect(direct.status).toBe('completed');
    if (staged.status !== 'completed' || direct.status !== 'completed') return;
    expect(staged.artifacts.execution.runContractDigest)
      .toBe(direct.artifacts.execution.runContractDigest);
    expect(staged.artifacts.execution.executionPlanDigest)
      .toBe(direct.artifacts.execution.executionPlanDigest);
    expect(staged.artifacts.evaluation.evaluationPlanDigest)
      .toBe(direct.artifacts.evaluation.evaluationPlanDigest);
    expect(staged.artifacts.analysis.analysisPlanDigest)
      .toBe(direct.artifacts.analysis.analysisPlanDigest);
  });

  it('assesses independent Runs through their authenticated Core source chains', async () => {
    const input = pairedInput();
    const left = await evaluate(input, { runId: 'comparability-left', clock: fixedClock });
    const changed = pairedInput();
    const right = await evaluate({
      ...changed,
      variants: changed.variants.map((candidate) => (
        candidate.variantId === treatmentSpec.variantId
          ? {
              ...candidate,
              artifact: { ...candidate.artifact, content: 'Answer exactly and briefly.' },
            }
          : candidate
      )),
    }, { runId: 'comparability-right', clock: fixedClock });

    const assessment = assessComparability({
      comparisonScope: 'decision',
      subjects: [{
        subjectId: 'candidate-under-test',
        leftVariantId: treatmentSpec.variantId,
        rightVariantId: treatmentSpec.variantId,
      }],
      left,
      right,
    });

    expect(assessment.designStatus).toBe('compatible');
    expect(assessment.reasons).toContainEqual(expect.objectContaining({
      reasonCode: 'comparability-identity-declared-subject-change',
      axis: 'identity',
    }));
    expect(assessment.reasons.map((reason) => reason.reasonCode)).not.toContain(
      'comparability-evidence-source-absent',
    );
    expect(assessment.reasons.map((reason) => reason.reasonCode)).not.toContain(
      'comparability-evidence-verification-indeterminate',
    );
    expect(Object.isFrozen(assessment)).toBe(true);

    const evaluationScope = assessComparability({
      comparisonScope: 'evaluation',
      subjects: [{
        subjectId: 'candidate-under-test',
        leftVariantId: treatmentSpec.variantId,
        rightVariantId: treatmentSpec.variantId,
      }],
      left,
      right,
    });
    expect(evaluationScope.designStatus).toBe('compatible');

    const invalidMapping = assessComparability({
      comparisonScope: 'analysis',
      subjects: [{
        subjectId: 'unknown-candidate',
        leftVariantId: 'missing',
        rightVariantId: treatmentSpec.variantId,
      }],
      left,
      right,
    });
    expect(invalidMapping.designStatus).toBe('incompatible');
    expect(invalidMapping.reasons).toContainEqual(expect.objectContaining({
      reasonCode: 'comparability-design-subject-mapping-invalid',
    }));

    expect(() => assessComparability({
      comparisonScope: 'evaluation',
      subjects: [{
        subjectId: 'candidate-under-test',
        leftVariantId: treatmentSpec.variantId,
        rightVariantId: treatmentSpec.variantId,
      }],
      left: structuredClone(left),
      right,
    })).toThrowError(expect.objectContaining({
      code: 'EVAL_RUNTIME_COMPARABILITY_INVALID',
    }));
  });

  it('captures direct run options before asynchronous preparation', async () => {
    const options = { runId: 'captured-run-options', clock: fixedClock };
    const pending = evaluate(pairedInput(), options);
    options.runId = 'mutated-run-options';

    const result = await pending;
    expect(result.runId).toBe('captured-run-options');
  });

  it('strictly separates declaration fields from run options before Target calls', async () => {
    let invocations = 0;
    const input = pairedInput(executor(async () => {
      invocations += 1;
      return { output: 'A' };
    }));

    await expect(prepareEvaluation({ ...input, runId: 'old-shape' } as never))
      .rejects.toBeInstanceOf(EvaluationConfigurationError);
    await expect(evaluate(input, { runId: 'valid', legacy: true } as never))
      .rejects.toBeInstanceOf(EvaluationConfigurationError);
    await expect(evaluate(input, { signal: {} } as never))
      .rejects.toBeInstanceOf(EvaluationConfigurationError);
    expect(invocations).toBe(0);
  });

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
    expect(result.artifacts.execution.records[0].runtime.fingerprint).toBe(
      'sha256:d29c4becb1812eb4951220d5b3cf8825ee9d66c23e3908d0832512e90468ff80',
    );
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
      resultKind: 'score',
      value: bindings.actual.length,
    }));
    const length: CustomEvaluator<{ actual: string }> = {
      ...baseLength,
      metric: {
        metricId: 'response-length-score',
        valueType: 'numeric',
        scale: { min: 0, max: 5 },
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      },
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
      resultKind: 'score',
      value: bindings.actual.length,
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
      metric: {
        metricId: 'unbounded-length-score',
        valueType: 'numeric',
        scale: { min: 0, max: 5 },
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      },
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
      resultKind: 'score',
      value: bindings.actual.length,
    }));
    const length: CustomEvaluator<{ actual: string }> = {
      ...baseLength,
      metric: {
        metricId: 'derived-boundary-length-score',
        valueType: 'numeric',
        scale: { min: 0, max: 5 },
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      },
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

  it('preregisters a Bonferroni simultaneous interval family without inventing p-values', async () => {
    const input = pairedInput();
    const length = numericCustomEvaluator('family-length', ({ bindings }) => ({
      resultKind: 'score',
      value: bindings.actual.length,
    }));
    const family = {
      analysisId: 'release-family',
      analysisKind: 'comparison-family' as const,
      statistic: 'mean-difference' as const,
      members: [{
        analysisId: 'length-difference',
        comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId,
        metricId: 'family-length-score',
      }, {
        analysisId: 'correct-difference',
        comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId,
        metricId: 'correct',
      }] as const,
      confidence: {
        method: 'bonferroni-percentile-bootstrap' as const,
        level: 0.95,
        resamples: 64,
      },
    };
    const result = await evaluate({
      ...input,
      evaluators: [...input.evaluators, length],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'family-length-score'],
      }],
      analyses: [family],
      decision: {
        decisionKind: 'comparison-family',
        analysisId: 'release-family',
        rule: 'all',
        criteria: [{
          analysisId: 'length-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }, {
          analysisId: 'correct-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }],
      }
    }, {
      runId: 'simultaneous-family',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.analysisGraph.nodes).toHaveLength(3);
    expect(result.definition.analysisGraph).toEqual({
      analysisMode: 'preregistered',
      nodes: [{
        analysisNodeKind: 'estimator',
        nodeId: stableFacadeId('node', { analysisId: 'correct-difference' }),
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [{
          inputKind: 'metric-observations',
          referenceId: 'correct',
        }, {
          inputKind: 'comparison',
          referenceId: 'baseline-vs-candidate',
          treatmentTargetId: 'prompt-v2',
          metricId: 'correct',
        }],
        outputResultId: 'correct-difference',
        parameters: { alpha: 0.025, resamples: 64 },
      }, {
        analysisNodeKind: 'estimator',
        nodeId: stableFacadeId('node', { analysisId: 'length-difference' }),
        implementationId: 'bootstrap.paired-difference-percentile/v1',
        inputs: [{
          inputKind: 'metric-observations',
          referenceId: 'family-length-score',
        }, {
          inputKind: 'comparison',
          referenceId: 'baseline-vs-candidate',
          treatmentTargetId: 'prompt-v2',
          metricId: 'family-length-score',
        }],
        outputResultId: 'length-difference',
        parameters: { alpha: 0.025, resamples: 64 },
      }, {
        analysisNodeKind: 'correction',
        nodeId: stableFacadeId('node', { analysisId: 'release-family' }),
        implementationId: 'simultaneous-intervals.bonferroni/v1',
        inputs: [{
          inputKind: 'analysis-result',
          referenceId: 'correct-difference',
        }, {
          inputKind: 'analysis-result',
          referenceId: 'length-difference',
        }],
        outputResultId: 'release-family',
        parameters: { familyConfidenceLevel: 0.95, resamples: 64 },
      }].sort((left, right) => (
        left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0
      )),
    });
    const memberNodes = result.definition.analysisGraph.nodes.filter(
      (node) => node.analysisNodeKind === 'estimator',
    );
    expect(memberNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputResultId: 'correct-difference',
          implementationId: 'bootstrap.paired-difference-percentile/v1',
          parameters: expect.objectContaining({ alpha: 0.025, resamples: 64 }),
        }),
        expect.objectContaining({
          outputResultId: 'length-difference',
          implementationId: 'bootstrap.paired-difference-percentile/v1',
          parameters: expect.objectContaining({ alpha: 0.025, resamples: 64 }),
        }),
      ]),
    );
    expect(result.definition.analysisGraph.nodes.find(
      (node) => node.outputResultId === 'release-family',
    )).toMatchObject({
      analysisNodeKind: 'correction',
      implementationId: 'simultaneous-intervals.bonferroni/v1',
      inputs: [
        { inputKind: 'analysis-result', referenceId: 'correct-difference' },
        { inputKind: 'analysis-result', referenceId: 'length-difference' },
      ],
      outputResultId: 'release-family',
      parameters: { familyConfidenceLevel: 0.95, resamples: 64 },
    });
    expect(result.definition.decisionPolicy).toEqual({
      decisionPolicyId: stableFacadeId('decision', {
        decisionKind: 'comparison-family',
        resultId: 'release-family',
      }),
      implementationId: 'release-family/v1',
      analysisResultIds: ['release-family'],
      comparisonFamily: [{
        comparisonId: 'baseline-vs-candidate',
        treatmentTargetId: 'prompt-v2',
        metricId: 'correct',
        analysisResultId: 'correct-difference',
      }, {
        comparisonId: 'baseline-vs-candidate',
        treatmentTargetId: 'prompt-v2',
        metricId: 'family-length-score',
        analysisResultId: 'length-difference',
      }],
      comparisonFamilyResultId: 'release-family',
      multipleComparisonPolicyId: 'simultaneous-intervals.bonferroni/v1',
      minimumEvidenceStatus: 'complete',
      parameters: {
        rule: 'all',
        criteria: [{
          analysisResultId: 'correct-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }, {
          analysisResultId: 'length-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }],
      },
    });
    expect(result.analysisResults['correct-difference']).toMatchObject({
      analysisStatus: 'completed',
      value: { confidenceLevel: 0.975, resamples: 64, unitCount: 2 },
    });
    expect(result.analysisResults['release-family']).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'table',
      value: {
        adjustmentMethod: 'bonferroni',
        familyConfidenceLevel: 0.95,
        marginalConfidenceLevel: 0.975,
        familySize: 2,
        resamples: 64,
        members: [
          { analysisResultId: 'correct-difference' },
          { analysisResultId: 'length-difference' },
        ],
      },
    });
    const familyRecord = result.analysisResults['release-family'];
    if (familyRecord?.analysisStatus !== 'completed') throw new Error('missing family result');
    const familyMembers = (familyRecord.value as {
      members: Array<{ analysisResultId: string; interval: JsonValue; }>;
    }).members;
    for (const member of familyMembers) {
      const memberRecord = result.analysisResults[member.analysisResultId];
      if (memberRecord?.analysisStatus !== 'completed') throw new Error('missing member result');
      expect(member.interval).toEqual(memberRecord.value);
    }
    expect(result.artifacts.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'RELEASE',
      reasonCodes: ['all-family-criteria-acceptable'],
    });
    expect(result.report.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'RELEASE',
    });

    const reversed = await evaluate({
      ...input,
      evaluators: [...input.evaluators, length],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'family-length-score'],
      }],
      analyses: [{
        ...family,
        members: [family.members[1], family.members[0]],
      }],
      decision: {
        decisionKind: 'comparison-family',
        analysisId: 'release-family',
        rule: 'all',
        criteria: [{
          analysisId: 'correct-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }, {
          analysisId: 'length-difference',
          minimumEffect: -100,
          maximumEffect: 100,
        }],
      }
    }, {
      runId: 'simultaneous-family',
      clock: fixedClock
    });
    expect(reversed.definition).toEqual(result.definition);
  });

  it('uses independent arm resampling for every member of an independent family', async () => {
    const input = pairedInput();
    const length = numericCustomEvaluator('independent-family-length', ({ bindings }) => ({
      resultKind: 'score',
      value: bindings.actual.length,
    }));
    const result = await evaluate({
      ...input,
      dataset: {
        datasetId: 'independent-family',
        samples: Array.from({ length: 8 }, (_, index) => ({
          sampleId: `sample-${index + 1}`,
          input: { prompt: index % 2 === 0 ? 'one' : 'two' },
          expected: index % 2 === 0 ? 'A' : 'B',
        })),
      },
      evaluators: [...input.evaluators, length],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'independent-family-length-score'],
      }],
      analyses: [{
        analysisId: 'independent-release-family',
        analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'independent-correct',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'correct',
        }, {
          analysisId: 'independent-length',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'independent-family-length-score',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      experiment: {
        seed: 'independent-family-seed',
        sampling: {
          samplingKind: 'independent',
          allocations: [
            { variantId: controlSpec.variantId, weight: 1 },
            { variantId: treatmentSpec.variantId, weight: 1 },
          ],
          minimumSamplesPerVariant: 2,
          minimumSamplesPerVariantPerStratum: 1,
        },
      },
      decision: undefined
    }, {
      runId: 'independent-family',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.analysisGraph.nodes.filter(
      (node) => node.analysisNodeKind === 'estimator',
    ).every(
      (node) => node.implementationId === 'bootstrap.unpaired-difference-percentile/v1',
    )).toBe(true);
    expect(result.analysisResults['independent-release-family']).toMatchObject({
      analysisStatus: 'completed',
      value: { familyConfidenceLevel: 0.95, marginalConfidenceLevel: 0.975 },
    });
  });

  it('keeps evaluator panel replicates inside the hierarchical family member', async () => {
    const input = pairedInput();
    const judge = {
      judgeId: 'test.family-panel/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      async invoke() {
        return { invocationStatus: 'completed' as const, output: '{"score":4,"reason":"ok"}' };
      },
    };
    const panel = {
      evaluatorKind: 'rubric-judge',
      evaluatorId: 'family-panel',
      metricId: 'family-quality',
      rubric: { criterionId: 'quality', prompt: 'Judge quality.', rubric: '5 is best.' },
      judges: [
        { memberId: 'judge-a', model: 'judge-a', judge, replicateCount: 2 },
        { memberId: 'judge-b', model: 'judge-b', judge, replicateCount: 1 },
      ],
      aggregation: { method: 'mean', missing: 'require-complete' },
    } satisfies RubricJudgeEvaluator;
    const result = await evaluate({
      ...input,
      evaluators: [...input.evaluators, panel],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'family-quality'],
      }],
      analyses: [{
        analysisId: 'panel-release-family',
        analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'panel-correct',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'correct',
        }, {
          analysisId: 'panel-quality',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'family-quality',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      experiment: { seed: 'panel-family-seed', trials: 2, sampling: { samplingKind: 'paired' } },
      decision: undefined
    }, {
      runId: 'panel-family',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.analysisGraph.nodes.find(
      (node) => node.outputResultId === 'panel-correct',
    )?.implementationId).toBe('bootstrap.paired-difference-percentile/v1');
    expect(result.definition.analysisGraph.nodes.find(
      (node) => node.outputResultId === 'panel-quality',
    )?.implementationId).toBe('bootstrap.hierarchical-paired-difference-percentile/v1');
    expect(result.analysisResults['panel-quality']).toMatchObject({
      analysisStatus: 'completed',
      value: { unitCount: 2, confidenceLevel: 0.975 },
    });
    expect(result.analysisResults['panel-release-family']).toMatchObject({
      analysisStatus: 'completed',
      value: { familySize: 2 },
    });
  });

  it('does not publish a simultaneous family when one member is inconclusive', async () => {
    const input = pairedInput();
    const incomplete = numericCustomEvaluator(
      'incomplete-family',
      ({ sampleId, bindings }) => sampleId === 'two'
        ? { resultKind: 'missing', reasonCode: 'not-available' }
        : { resultKind: 'score', value: bindings.actual.length },
    );
    const result = await evaluate({
      ...input,
      evaluators: [...input.evaluators, incomplete],
      comparisons: [{
        ...input.comparisons[0],
        metricIds: ['correct', 'incomplete-family-score'],
      }],
      analyses: [{
        analysisId: 'incomplete-release-family',
        analysisKind: 'comparison-family',
        statistic: 'mean-difference',
        members: [{
          analysisId: 'complete-member',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'correct',
        }, {
          analysisId: 'incomplete-member',
          comparisonId: 'baseline-vs-candidate',
          treatmentVariantId: treatmentSpec.variantId,
          metricId: 'incomplete-family-score',
        }],
        confidence: {
          method: 'bonferroni-percentile-bootstrap', level: 0.95, resamples: 32,
        },
      }],
      decision: {
        decisionKind: 'comparison-family',
        analysisId: 'incomplete-release-family',
        rule: 'all',
        criteria: [{
          analysisId: 'complete-member',
          minimumEffect: -100,
          maximumEffect: 100,
        }, {
          analysisId: 'incomplete-member',
          minimumEffect: -100,
          maximumEffect: 100,
        }],
      }
    }, {
      runId: 'incomplete-family',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.analysisResults['complete-member']).toMatchObject({
      analysisStatus: 'completed',
    });
    expect(result.analysisResults['incomplete-member']).toMatchObject({
      analysisStatus: 'inconclusive',
    });
    expect(result.analysisResults['incomplete-release-family']).toMatchObject({
      analysisStatus: 'not-evaluated',
      reasonCodes: ['analysis-parent-not-completed'],
    });
    expect(result.artifacts.decision).toMatchObject({
      decisionStatus: 'not-decided',
      reasonCodes: expect.arrayContaining([
        'decision-analysis-result-unavailable',
        'decision-evidence-gate-failed',
      ]),
    });
  });

  it('seals one stable Variant assignment per sample for independent comparisons', async () => {
    const calls: Array<{ sampleId: string; variantId: string; trialIndex: number; }> = [];
    const declaration = executor(async (invocation) => {
      calls.push({
        sampleId: invocation.sampleId,
        variantId: invocation.variantId,
        trialIndex: invocation.trialIndex,
      });
      return { output: invocation.config.answers[invocation.input.prompt] };
    });
    const input = pairedInput(declaration);
    const baseLength = numericCustomEvaluator('independent-length', ({ bindings }) => ({
      resultKind: 'score',
      value: bindings.actual.length,
    }));
    const length: CustomEvaluator<{ actual: string }> = {
      ...baseLength,
      metric: {
        metricId: 'independent-length-score',
        valueType: 'numeric',
        scale: { min: 0, max: 5 },
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      },
    };
    const result = await evaluate({
      ...input,
      dataset: {
        datasetId: 'independent-answers',
        samples: Array.from({ length: 6 }, (_, index) => ({
          sampleId: `sample-${index + 1}`,
          input: { prompt: index % 2 === 0 ? 'one' : 'two' },
          expected: index % 2 === 0 ? 'A' : 'B',
        })),
      },
      comparisons: [{
        ...input.comparisons[0],
      }],
      evaluators: [...input.evaluators, length],
      experiment: {
        seed: 'independent-seed',
        trials: 2,
        sampling: {
          samplingKind: 'independent',
          allocations: [
            { variantId: controlSpec.variantId, weight: 1 },
            { variantId: treatmentSpec.variantId, weight: 1 },
          ],
          minimumSamplesPerVariant: 2,
          minimumSamplesPerVariantPerStratum: 1,
        },
      },
      analyses: [...input.analyses, {
        analysisId: 'candidate-independent-quality',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'correct',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }, {
        analysisId: 'independent-overall-difference',
        analysisKind: 'composite-comparison-interval',
        compositeMetricId: 'independent-overall-quality',
        comparisonId: 'baseline-vs-candidate',
        treatmentVariantId: treatmentSpec.variantId,
        components: [{ metricId: 'correct', weight: 0.5 }, {
          metricId: 'independent-length-score', weight: 0.5,
        }],
        aggregation: { method: 'weighted-mean', missing: 'require-complete' },
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
      decision: undefined
    }, {
      runId: 'independent-assignment',
      clock: fixedClock
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.experiment.assignment).toMatchObject({
      assignmentKind: 'independent-groups',
      algorithmId: 'assignment.stratified-fixed-quota/v1',
      minimumUnitsPerTarget: 2,
      minimumUnitsPerTargetPerStratum: 1,
    });
    expect(result.definition.experiment.sampling).toMatchObject({
      estimatorId: 'bootstrap.unpaired-difference-percentile/v1',
      resamplingUnit: 'sample',
      seedCoupling: 'independent-by-target',
    });
    expect(result.artifacts.execution.records).toHaveLength(12);
    expect(calls).toHaveLength(12);
    const variantsBySample = new Map<string, Set<string>>();
    for (const call of calls) {
      const variants = variantsBySample.get(call.sampleId) ?? new Set<string>();
      variants.add(call.variantId);
      variantsBySample.set(call.sampleId, variants);
    }
    expect([...variantsBySample.values()].every((variants) => variants.size === 1)).toBe(true);
    expect([...new Set(calls.filter((call) => call.trialIndex === 0).map((call) => call.variantId))])
      .toHaveLength(2);
    expect(calls.filter((call) => call.variantId === controlSpec.variantId)).toHaveLength(6);
    expect(calls.filter((call) => call.variantId === treatmentSpec.variantId)).toHaveLength(6);
    expect(result.artifacts.analysis.records[0]).toMatchObject({ analysisStatus: 'completed' });
    expect(result.analysisResults['candidate-independent-quality']).toMatchObject({
      analysisStatus: 'completed',
      value: { unitCount: 3 },
    });
    expect(result.definition.analysisGraph.nodes.find(
      (node) => node.outputResultId === 'independent-overall-difference',
    )?.implementationId).toBe('bootstrap.composite-unpaired-difference-percentile/v1');
    expect(result.analysisResults['independent-overall-difference']).toMatchObject({
      analysisStatus: 'completed',
      value: { unitCount: 6 },
      coverage: { included: 24, comparable: 24 },
    });
  });

  it('runs a custom Evaluator from only its declared bindings', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const custom = {
      evaluatorKind: 'custom',
      evaluatorId: 'output-length',
      instrumentId: 'output-length-v1',
      metric: {
        metricId: 'length',
        valueType: 'numeric',
        direction: 'lower-is-better',
        missingPolicyId: 'exclude/v1',
      },
      bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
      parameters: { offset: 1 },
      implementation: {
        implementationId: 'test.output-length/v1',
        version: '1.0.0',
        schemas: {
          bindings: z.object({ actual: z.string() }).strict(),
          value: z.number(),
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
            resultKind: 'score',
            value: invocation.bindings.actual.length + 1,
            evidence: { value: { rule: 'length-plus-offset' }, classification: 'public' },
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
        metric: {
          metricId: 'strict-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        },
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: {
          implementationId: 'test.strict-number/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({ actual: z.string() }).strict(),
            value: z.number(),
            fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
          },
          fingerprintFacets: { revision: 'test-one' },
          async evaluate() {
            return { resultKind: 'score', value: 'not-a-number' };
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
      return { resultKind: 'score', value: 1 };
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
        metric: {
          metricId: 'all-bindings-valid',
          valueType: 'boolean',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        },
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
            value: z.boolean(),
            fingerprintFacets: { bindings: 'all-sources/v1', value: 'boolean/v1' },
          },
          fingerprintFacets: { revision: 'test-one' },
          evaluate({ bindings }) {
            seen.push(bindings);
            return {
              resultKind: 'score',
              value: bindings.facts.attemptCount === 1
                && bindings.domain === 'qa'
                && bindings.step === 'generated'
                && typeof bindings.actual === 'string'
                && typeof bindings.expected === 'string',
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
          ? { resultKind: 'missing', reasonCode: 'label-not-available' }
          : { resultKind: 'score', value: bindings.actual }),
        qualitativeCustomEvaluator('answer-text', 'text', z.enum(['empty', 'non-empty']), ({ bindings }) => ({
          resultKind: 'score',
          value: bindings.actual === '' ? 'empty' : 'non-empty',
        })),
        qualitativeCustomEvaluator('answer-ranking', 'ranking', z.array(z.enum(['empty', 'non-empty', 'fallback'])).min(1), ({ bindings }) => ({
          resultKind: 'score',
          value: bindings.actual === '' ? ['empty'] : ['non-empty', 'fallback'],
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
        value: z.number(),
        fingerprintFacets: { bindings: 'actual-string/v1', value: 'number/v1' },
      },
      fingerprintFacets: { revision: 'test-one', suffix },
      evaluate: ({ bindings }) => ({
        resultKind: 'score' as const,
        value: suffix === 'length' ? bindings.actual.length : Number(bindings.actual === 'A'),
      }),
    } satisfies CustomEvaluator<{ actual: string; }>['implementation']);
    const result = await evaluate({
      ...input,
      evaluators: [{
        evaluatorKind: 'custom',
        evaluatorId: 'shared-length',
        instrumentId: 'shared-length-v1',
        metric: {
          metricId: 'shared-length-score',
          valueType: 'numeric',
          direction: 'lower-is-better',
          missingPolicyId: 'exclude/v1',
        },
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: implementation('length'),
      }, {
        evaluatorKind: 'custom',
        evaluatorId: 'shared-is-a',
        instrumentId: 'shared-is-a-v1',
        metric: {
          metricId: 'shared-is-a-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        },
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
        metric: {
          metricId: 'throwing-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        },
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: {
          implementationId: 'test.throwing-custom/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({ actual: z.string() }).strict(),
            value: z.number(),
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
        metric: {
          metricId: 'slow-score',
          valueType: 'numeric',
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        },
        bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
        implementation: {
          implementationId: 'test.slow-custom/v1',
          version: '1.0.0',
          schemas: {
            bindings: z.object({ actual: z.string() }).strict(),
            value: z.number(),
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
            return { resultKind: 'score', value: 1 };
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
        return { resultKind: 'score', value: 1 };
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

  it('enforces a stage provider-cost budget and exposes auditable bounded overshoot', async () => {
    let calls = 0;
    const base = executor(async ({ input, config, signal }) => {
      signal.throwIfAborted();
      calls += 1;
      return {
        output: config.answers[input.prompt],
        usage: {
          providerCost: { amount: 0.6, currency: 'USD', reportedByProvider: true },
        },
      };
    });
    const metered: Executor<Input, Config, string> = {
      ...base,
      capabilities: {
        ...base.capabilities!,
        telemetry: {
          ...base.capabilities!.telemetry,
          providerCost: { reporting: 'optional' },
        },
      },
    };
    const result = await evaluate({
      ...pairedInput(metered),
      policy: {
        execution: { maxConcurrency: 2 },
        evaluation: { maxConcurrency: 1 },
        budget: {
          execution: { maxProviderCost: { amount: 1, currency: 'USD' } },
        },
      },
      decision: undefined
    }, {
      runId: 'canonical-provider-cost-budget',
      clock: fixedClock
    });

    expect(result.status).toBe('budget-exhausted');
    if (result.status === 'failed') return;
    expect(calls).toBe(4);
    expect(result.report.budgetSummary.admissionMode).toBe('bounded-overshoot');
    expect(result.report.budgetSummary.summaryStatus).toBe('exhausted');
    expect(result.report.budgetSummary.entries).toHaveLength(4);
    expect(result.report.budgetSummary.entries.every((entry) => (
      entry.stage === 'execution'
      && entry.providerCostStatus === 'reported'
      && entry.admissionKind === 'bounded-overshoot'
    ))).toBe(true);
    expect(result.report.budgetSummary.termination).toEqual({
      terminationKind: 'active-budget-exhausted',
      resourceKind: 'provider-cost',
      scopeKind: 'stage',
      scopeId: 'execution',
      reasonCode: 'stage-provider-cost-budget-exhausted',
    });
    expect(result.report.budgetSummary.scopes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeKind: 'stage',
        scopeId: 'execution',
        limits: { maxProviderCost: { amount: 1, currency: 'USD' } },
        totals: expect.objectContaining({
          reportedProviderCosts: [{ amount: 2.4, currency: 'USD' }],
        }),
        overshoot: expect.objectContaining({
          providerCost: { amount: expect.closeTo(1.4), currency: 'USD' },
        }),
      }),
    ]));
  });

  it('makes unreported provider cost explicitly unverifiable or fail-closed', async () => {
    let calls = 0;
    const base = executor(async ({ input, config }) => {
      calls += 1;
      return { output: config.answers[input.prompt] };
    });
    const unmetered: Executor<Input, Config, string> = {
      ...base,
      capabilities: {
        ...base.capabilities!,
        telemetry: {
          ...base.capabilities!.telemetry,
          providerCost: { reporting: 'optional' },
        },
      },
    };
    const common = pairedInput(unmetered);
    const unverifiable = await evaluate({
      ...common,
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: {
          execution: { maxProviderCost: { amount: 1, currency: 'USD' } },
          onUnreportedProviderCost: 'mark-unverifiable',
        },
      },
      decision: undefined
    }, {
      runId: 'canonical-unreported-cost-unverifiable',
      clock: fixedClock
    });
    expect(unverifiable.status).toBe('completed');
    if (unverifiable.status === 'failed') return;
    expect(unverifiable.report.budgetSummary.summaryStatus).toBe('unverifiable');
    expect(unverifiable.report.budgetSummary.scopes.find(
      (scope) => scope.scopeKind === 'stage' && scope.scopeId === 'execution',
    )?.totals.unreportedProviderCostInvocations).toBe(4);

    calls = 0;
    const failed = await evaluate({
      ...common,
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: {
          execution: { maxProviderCost: { amount: 1, currency: 'USD' } },
          onUnreportedProviderCost: 'fail-run',
        },
      },
      decision: undefined
    }, {
      runId: 'canonical-unreported-cost-failed',
      clock: fixedClock
    });
    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') return;
    expect(failed.error).toMatchObject({ code: 'provider-cost-unreported' });
    expect(calls).toBe(1);
  });

  it('enforces active, wall-clock, coordinate, and attempt budget scopes in Core', async () => {
    let activeNow = 0;
    let activeCalls = 0;
    const activeExecutor = executor(async ({ input, config }) => {
      activeCalls += 1;
      activeNow += 5;
      return { output: config.answers[input.prompt] };
    });
    const active = await evaluate({
      ...pairedInput(activeExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: { execution: { maxActiveDurationMs: 5 } },
      },
      decision: undefined
    }, {
      runId: 'canonical-active-duration-budget',
      clock: {
        monotonicNow: () => activeNow,
        timestamp: fixedClock.timestamp,
        sleep: fixedClock.sleep,
      }
    });
    expect(active.status).toBe('budget-exhausted');
    expect(activeCalls).toBe(2);

    let wallNow = 0;
    let wallCalls = 0;
    const wallExecutor = executor(async ({ input, config }) => {
      wallCalls += 1;
      wallNow += 1_000;
      return { output: config.answers[input.prompt] };
    });
    const wall = await evaluate({
      ...pairedInput(wallExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: { run: { maxWallClockMs: 1000 } },
      },
      decision: undefined
    }, {
      runId: 'canonical-wall-clock-budget',
      clock: {
        monotonicNow: () => wallNow,
        timestamp: fixedClock.timestamp,
        sleep(_delayMs, signal) {
          return new Promise((_resolve, reject) => {
            const abort = () => reject(signal?.reason);
            if (signal?.aborted)
              abort();
            else
              signal?.addEventListener('abort', abort, { once: true });
          });
        },
      }
    });
    expect(wall.status).toBe('budget-exhausted');
    expect(wallCalls).toBe(2);

    let stageCalls = 0;
    const stageExecutor = executor(async ({ input, config }) => {
      stageCalls += 1;
      return { output: config.answers[input.prompt] };
    });
    const stage = await evaluate({
      ...pairedInput(stageExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: { execution: { maxInvocations: 2 } },
      },
      decision: undefined
    }, {
      runId: 'canonical-stage-invocation-budget',
      clock: fixedClock
    });
    expect(stage.status).toBe('budget-exhausted');
    expect(stageCalls).toBe(2);
    expect(stage.artifacts?.execution?.coverage).toMatchObject({
      started: 2,
      budgetCensored: 2,
    });

    let retryCalls = 0;
    const retrying = executor(async () => {
      retryCalls += 1;
      return { errorCode: 'retry-me' };
    });
    const coordinate = await evaluate({
      ...pairedInput(retrying),
      policy: {
        execution: {
          maxConcurrency: 1,
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['retry-me'],
            backoff: { backoffKind: 'none' },
          },
        },
        evaluation: { maxConcurrency: 1 },
        budget: { coordinate: { maxInvocations: 1 } },
      },
      decision: undefined
    }, {
      runId: 'canonical-coordinate-budget',
      clock: fixedClock
    });
    expect(coordinate.status).toBe('budget-exhausted');
    expect(retryCalls).toBe(2);

    let attemptCalls = 0;
    const attemptBase = executor(async ({ input, config }) => {
      attemptCalls += 1;
      return {
        output: config.answers[input.prompt],
        usage: {
          providerCost: { amount: 0.25, currency: 'USD', reportedByProvider: true },
        },
      };
    });
    const attemptExecutor: Executor<Input, Config, string> = {
      ...attemptBase,
      capabilities: {
        ...attemptBase.capabilities!,
        telemetry: {
          ...attemptBase.capabilities!.telemetry,
          providerCost: { reporting: 'optional' },
        },
      },
    };
    const attempt = await evaluate({
      ...pairedInput(attemptExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        budget: { attempt: { maxProviderCost: { amount: 0.2, currency: 'USD' } } },
      },
      decision: undefined
    }, {
      runId: 'canonical-attempt-budget',
      clock: fixedClock
    });
    expect(attempt.status).toBe('budget-exhausted');
    expect(attemptCalls).toBe(2);
  });

  it('canonicalizes equivalent budgets and seals budget changes into run identity', async () => {
    const common = pairedInput();
    const first = await evaluate({
      ...common,
      policy: {
        ...common.policy,
        budget: {
          run: { maxInvocations: 100, maxActiveDurationMs: 5000 },
          execution: { maxInvocations: 80 },
          evaluation: { maxInvocations: 20 },
          coordinate: { maxInvocations: 3 },
        },
      }
    }, {
      runId: 'canonical-budget-identity-first',
      clock: fixedClock
    });
    const reordered = await evaluate({
      ...common,
      policy: {
        ...common.policy,
        budget: {
          coordinate: { maxInvocations: 3 },
          evaluation: { maxInvocations: 20 },
          execution: { maxInvocations: 80 },
          run: { maxActiveDurationMs: 5000, maxInvocations: 100 },
        },
      }
    }, {
      runId: 'canonical-budget-identity-reordered',
      clock: fixedClock
    });
    const changed = await evaluate({
      ...common,
      policy: {
        ...common.policy,
        budget: {
          run: { maxInvocations: 101, maxActiveDurationMs: 5000 },
          execution: { maxInvocations: 80 },
          evaluation: { maxInvocations: 20 },
          coordinate: { maxInvocations: 3 },
        },
      }
    }, {
      runId: 'canonical-budget-identity-changed',
      clock: fixedClock
    });

    expect(first.status).toBe('completed');
    expect(reordered.status).toBe('completed');
    expect(changed.status).toBe('completed');
    if (first.status !== 'completed'
      || reordered.status !== 'completed'
      || changed.status !== 'completed') return;
    expect(reordered.policy).toEqual(first.policy);
    expect(reordered.artifacts.execution.runContractDigest)
      .toBe(first.artifacts.execution.runContractDigest);
    expect(changed.artifacts.execution.runContractDigest)
      .not.toBe(first.artifacts.execution.runContractDigest);
  });

  it('delegates execution and evaluation retries to the sealed Core stage policies', async () => {
    const executionAttempts: number[] = [];
    const executionSleeps: number[] = [];
    const flakyExecutor = executor(async ({ attemptNumber, input, config, signal }) => {
      signal.throwIfAborted();
      executionAttempts.push(attemptNumber);
      return attemptNumber === 1
        ? { errorCode: 'temporary-executor-failure' }
        : { output: config.answers[input.prompt] };
    });
    const executionResult = await evaluate({
      ...pairedInput(flakyExecutor),
      policy: {
        execution: {
          maxConcurrency: 1,
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['temporary-executor-failure'],
            backoff: { backoffKind: 'fixed', initialDelayMs: 7 },
          },
        },
        evaluation: { maxConcurrency: 1 },
      }
    }, {
      runId: 'execution-retry',
      clock: {
        ...fixedClock,
        sleep(delayMs) {
          executionSleeps.push(delayMs);
          return Promise.resolve();
        },
      }
    });
    expect(executionResult.status).toBe('completed');
    expect(executionAttempts.filter((attempt) => attempt === 1)).toHaveLength(4);
    expect(executionAttempts.filter((attempt) => attempt === 2)).toHaveLength(4);
    expect(executionSleeps).toEqual([7, 7, 7, 7]);
    expect(executionResult.artifacts?.execution?.records.every((record) => (
      record.executionStatus === 'completed' && record.attempts.length === 2
    ))).toBe(true);

    const evaluationAttempts: number[] = [];
    const retryingEvaluator = numericCustomEvaluator(
      'retrying-evaluator',
      ({ attemptNumber }) => {
        evaluationAttempts.push(attemptNumber);
        return attemptNumber === 1
          ? { resultKind: 'failed', errorCode: 'temporary-evaluator-failure' }
          : { resultKind: 'score', value: 1 };
      },
    );
    const evaluationResult = await evaluate({
      ...pairedInput(),
      evaluators: [retryingEvaluator],
      comparisons: [{
        ...pairedInput().comparisons[0],
        metricIds: ['retrying-evaluator-score'],
      }],
      analyses: comparisonAnalysis('retrying-evaluator-score'),
      decision: undefined,
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: {
          maxConcurrency: 1,
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['temporary-evaluator-failure'],
            backoff: { backoffKind: 'none' },
          },
        },
      }
    }, {
      runId: 'evaluation-retry',
      clock: fixedClock
    });
    expect(evaluationResult.status).toBe('completed');
    expect(evaluationAttempts.filter((attempt) => attempt === 1)).toHaveLength(4);
    expect(evaluationAttempts.filter((attempt) => attempt === 2)).toHaveLength(4);
    expect(evaluationResult.artifacts?.evaluation?.records.every((record) => (
      record.evaluationStatus === 'completed' && record.attempts.length === 2
    ))).toBe(true);

    let nonRetryableCalls = 0;
    const nonRetryable = await evaluate({
      ...pairedInput(),
      evaluators: [numericCustomEvaluator('non-retryable', () => {
        nonRetryableCalls += 1;
        return { resultKind: 'failed', errorCode: 'permanent-evaluator-failure' };
      })],
      comparisons: [{
        ...pairedInput().comparisons[0],
        metricIds: ['non-retryable-score'],
      }],
      analyses: comparisonAnalysis('non-retryable-score'),
      decision: undefined,
      policy: {
        evaluation: {
          maxConcurrency: 1,
          retry: {
            maxAttempts: 3,
            retryableErrorCodes: ['temporary-evaluator-failure'],
            backoff: { backoffKind: 'none' },
          },
        },
      }
    }, {
      runId: 'non-retryable-evaluation',
      clock: fixedClock
    });
    expect(nonRetryable.status).toBe('completed');
    expect(nonRetryableCalls).toBe(4);
    expect(nonRetryable.artifacts?.evaluation?.records.every((record) => (
      record.evaluationStatus === 'failed' && record.attempts.length === 1
    ))).toBe(true);
  });

  it('applies the canonical failure threshold before admitting a later paired block', async () => {
    let calls = 0;
    const failingExecutor = executor(async () => {
      calls += 1;
      return { errorCode: 'permanent-executor-failure' };
    });
    const result = await evaluate({
      ...pairedInput(failingExecutor),
      policy: {
        execution: { maxConcurrency: 1 },
        evaluation: { maxConcurrency: 1 },
        failure: { failureMode: 'failure-threshold', maxFailures: 0 },
      }
    }, {
      runId: 'failure-threshold',
      clock: fixedClock
    });

    expect(result.status).toBe('failed');
    expect(calls).toBe(2);
    expect(result.artifacts?.execution).toMatchObject({
      executionBundleStatus: 'failed',
      terminationReasonCode: 'failure-policy-threshold',
      coverage: { started: 2, failed: 2, notStarted: 2 },
    });
  });

  it('rejects invalid or legacy policy shapes before the first Target invocation', async () => {
    let calls = 0;
    const countedExecutor = executor(async () => {
      calls += 1;
      return { output: 'A' };
    });
    const invalidPolicies: unknown[] = [
      { maxConcurrency: 2 },
      {
        execution: {
          retry: {
            maxAttempts: 2,
            retryableErrorCodes: ['timeout', 'timeout'],
            backoff: { backoffKind: 'none' },
          },
        },
      },
      { failure: { failureMode: 'continue', maxFailures: 1 } },
      { budget: { maxInvocations: 1 } },
      { budget: { execution: { maxWallClockMs: 1 } } },
      { budget: { attempt: { maxInvocations: 1 } } },
      {
        budget: {
          run: { maxProviderCost: { amount: 1, currency: 'USD' } },
          evaluation: { maxProviderCost: { amount: 1, currency: 'CNY' } },
        },
      },
    ];

    for (const policy of invalidPolicies) {
      await expect(evaluate({
        ...pairedInput(countedExecutor),
        policy,
        runId: 'invalid-policy-before-target',
      } as never)).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
    }
    expect(calls).toBe(0);
  });

  it('captures the active callback and changes Runtime identity when declared facets change', async () => {
    const input = pairedInput();
    const custom = numericCustomEvaluator(
      'captured-callback',
      () => ({ resultKind: 'score', value: 1 }),
      'revision-one',
    );
    const pending = evaluate({
      ...input,
      evaluators: [custom],
      comparisons: [{ ...input.comparisons[0], metricIds: ['captured-callback-score'] }],
      analyses: comparisonAnalysis('captured-callback-score'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-captured-callback',
      clock: fixedClock
    });
    (custom.implementation as {
      evaluate: CustomEvaluator<{ actual: string; }>['implementation']['evaluate'];
    }).evaluate = () => ({ resultKind: 'score', value: 99 });
    const first = await pending;
    const second = await evaluate({
      ...input,
      evaluators: [numericCustomEvaluator('captured-callback', () => ({ resultKind: 'score', value: 1 }), 'revision-two')],
      comparisons: [{ ...input.comparisons[0], metricIds: ['captured-callback-score'] }],
      analyses: comparisonAnalysis('captured-callback-score'),
      decision: undefined
    }, {
      runId: 'custom-evaluator-new-identity',
      clock: fixedClock
    });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    if (first.status !== 'completed' || second.status !== 'completed') return;
    expect(first.artifacts.evaluation.records.flatMap((record) => (
      record.evaluationStatus === 'completed' ? record.observations : []
    )).every((observation) => (
      observation.observationStatus === 'observed' && observation.value === 1
    ))).toBe(true);
    expect(first.artifacts.evaluation.records[0].runtime.fingerprint)
      .not.toBe(second.artifacts.evaluation.records[0].runtime.fingerprint);
    expect(first.artifacts.evaluation.evaluationPlanDigest)
      .not.toBe(second.artifacts.evaluation.evaluationPlanDigest);
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
      resultKind: 'score',
      value: bindings.actual.length,
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

  it('runs heterogeneous Executors and all canonical Evaluator kinds in one Core Run', async () => {
    const firstExecutor = executor();
    const secondExecutor = executor(undefined, {
      executorId: 'test.alternate-executor/v1',
      revision: 'alternate-one',
    });
    const thirdSpec = {
      ...treatmentSpec,
      variantId: 'prompt-v3',
      artifact: { ...treatmentSpec.artifact, name: 'candidate-three' },
    } as const;
    const judgeCalls: string[] = [];
    const result = await evaluate({
      ...pairedInput(firstExecutor),
      dataset: {
        datasetId: 'multi-arm-independent',
        samples: Array.from({ length: 6 }, (_, index) => ({
          sampleId: `sample-${index + 1}`,
          input: { prompt: index % 2 === 0 ? 'one' : 'two' },
          expected: index % 2 === 0 ? 'A' : 'B',
        })),
      },
      variants: [
        variant(firstExecutor, controlSpec),
        variant(firstExecutor, treatmentSpec),
        variant(secondExecutor, thirdSpec),
      ],
      evaluators: [
        { evaluatorKind: 'exact-match' },
        {
          evaluatorKind: 'rubric-judge',
          evaluatorId: 'quality-judge',
          metricId: 'quality-score',
          rubric: {
            criterionId: 'quality',
            prompt: 'Judge answer quality.',
            rubric: '5 is correct; 1 is incorrect.',
          },
          judges: [{
            memberId: 'primary',
            model: 'judge-model',
            judge: {
              judgeId: 'test.judge/v1',
              version: '1.0.0',
              providerCost: { reporting: 'optional' },
              async invoke(request) {
                judgeCalls.push(request.promptId);
                return {
                  invocationStatus: 'completed',
                  output: '{"score":5,"reason":"correct"}',
                };
              },
            },
          }],
          aggregation: { method: 'mean', missing: 'require-complete' },
        },
        numericCustomEvaluator('length', ({ bindings }) => ({
          resultKind: 'score',
          value: bindings.actual.length,
        })),
      ],
      comparisons: [{
        comparisonId: 'baseline-vs-candidates',
        controlVariantId: controlSpec.variantId,
        treatmentVariantIds: [thirdSpec.variantId, treatmentSpec.variantId],
        metricIds: ['quality-score', 'correct', 'length-score'],
      }],
      analyses: ['prompt-v2', 'prompt-v3'].flatMap((treatmentVariantId) => (['quality-score', 'correct', 'length-score'].map((metricId) => ({
        analysisId: `${treatmentVariantId}-${metricId}`,
        analysisKind: 'comparison-interval' as const,
        statistic: 'mean-difference' as const,
        comparisonId: 'baseline-vs-candidates',
        treatmentVariantId,
        metricId,
        confidence: {
          method: 'percentile-bootstrap' as const,
          level: 0.95,
          resamples: 100,
        },
      })))),
      experiment: {
        seed: 'multi-arm-independent-seed',
        sampling: {
          samplingKind: 'independent',
          allocations: [
            { variantId: controlSpec.variantId, weight: 1 },
            { variantId: treatmentSpec.variantId, weight: 1 },
            { variantId: thirdSpec.variantId, weight: 1 },
          ],
          minimumSamplesPerVariant: 2,
          minimumSamplesPerVariantPerStratum: 1,
        },
      },
      decision: undefined
    }, {
      runId: 'multi-arm-multi-metric',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.definition.targets.map((target) => target.executorId)).toEqual([
      'test.answer-executor/v1',
      'test.answer-executor/v1',
      'test.alternate-executor/v1',
    ]);
    expect(result.definition.evaluators.map((evaluator) => evaluator.evaluatorId)).toEqual([
      'exact-match',
      'length',
      'quality-judge/primary/replicate-0',
    ]);
    expect(result.definition.metrics.map((metric) => metric.metricId)).toEqual([
      'correct',
      'length-score',
      'quality-score',
    ]);
    expect(result.definition.comparisons[0].treatmentTargetIds).toEqual([
      'prompt-v2',
      'prompt-v3',
    ]);
    expect(result.definition.analysisGraph.nodes).toHaveLength(6);
    expect(result.definition.decisionPolicy).toBeUndefined();
    expect(result.artifacts.execution.records).toHaveLength(6);
    expect(result.artifacts.evaluation.records).toHaveLength(18);
    expect(result.artifacts.analysis.records).toHaveLength(6);
    expect(judgeCalls).toHaveLength(6);
  });

  it('runs evaluator replicates without repeating Target executions or statistical units', async () => {
    let targetCalls = 0;
    const declaration = executor(async ({ input, config }) => {
      targetCalls += 1;
      return { output: config.answers[input.prompt] };
    });
    const judgeCalls: string[] = [];
    const judge = {
      judgeId: 'test.panel-judge/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      async invoke(request: Parameters<RubricJudgeEvaluator['judges'][number]['judge']['invoke']>[0]) {
        judgeCalls.push(request.model);
        return {
          invocationStatus: 'completed' as const,
          output: request.model === 'judge-a'
            ? '{"score":1,"reason":"a"}'
            : '{"score":5,"reason":"b"}',
        };
      },
    };
    const panel = {
      evaluatorKind: 'rubric-judge',
      evaluatorId: 'quality-panel',
      metricId: 'quality-score',
      rubric: {
        criterionId: 'quality',
        prompt: 'Judge quality.',
        rubric: '5 is best; 1 is worst.',
      },
      judges: [
        { memberId: 'judge-a', model: 'judge-a', judge, replicateCount: 2 },
        { memberId: 'judge-b', model: 'judge-b', judge, replicateCount: 1 },
      ],
      aggregation: {
        method: 'weighted-mean',
        missing: 'require-complete',
        weights: { 'judge-a': 0.25, 'judge-b': 0.75 },
      },
    } satisfies RubricJudgeEvaluator;
    const result = await evaluate({
      dataset: {
        ...pairedInput().dataset,
        samples: pairedInput().dataset.samples.map((sample) => ({
          ...sample,
          executionContext: { cluster: sample.sampleId },
        })),
      },
      variants: [variant(declaration, treatmentSpec)],
      evaluators: [panel],
      comparisons: [],
      analyses: [{
        analysisId: 'panel-quality',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'quality-score',
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }, {
        analysisId: 'panel-mean',
        analysisKind: 'summary',
        statistic: 'mean',
        variantId: treatmentSpec.variantId,
        metricId: 'quality-score',
      }],
      experiment: {
        seed: 'panel-seed',
        trials: 2,
        sampling: { samplingKind: 'solo', clusterKey: '/executionContext/cluster' },
      },
      decision: undefined,
      policy: {
        execution: { maxConcurrency: 2 },
        evaluation: { maxConcurrency: 2 },
      }
    }, {
      runId: 'rubric-panel',
      clock: fixedClock
    });

    expect(result.status, JSON.stringify(result)).toBe('completed');
    if (result.status !== 'completed') return;
    expect(targetCalls).toBe(4);
    expect(judgeCalls).toHaveLength(12);
    expect(judgeCalls.filter((model) => model === 'judge-a')).toHaveLength(8);
    expect(judgeCalls.filter((model) => model === 'judge-b')).toHaveLength(4);
    expect(result.definition.evaluators.map((evaluator) => evaluator.measurement)).toEqual([
      {
        instrumentId: 'rubric-judge-debias-on-trace-none',
        ensembleMemberId: 'judge-a',
        replicateGroupId: 'quality-panel',
        replicateIndex: 0,
      },
      {
        instrumentId: 'rubric-judge-debias-on-trace-none',
        ensembleMemberId: 'judge-a',
        replicateGroupId: 'quality-panel',
        replicateIndex: 1,
      },
      {
        instrumentId: 'rubric-judge-debias-on-trace-none',
        ensembleMemberId: 'judge-b',
        replicateGroupId: 'quality-panel',
        replicateIndex: 0,
      },
    ]);
    expect(result.artifacts.execution.records).toHaveLength(4);
    expect(result.artifacts.evaluation.records).toHaveLength(12);
    expect(result.analysisResults['panel-quality']).toMatchObject({
      analysisStatus: 'completed',
      implementation: { implementationId: 'bootstrap.hierarchical-cluster-percentile/v1' },
      value: { estimate: 4, unitCount: 2 },
    });
    expect(result.analysisResults['panel-mean']).toMatchObject({
      analysisStatus: 'completed',
      implementation: { implementationId: 'descriptive.hierarchical-mean/v1' },
      value: 4,
    });
  });

  it('rejects incomplete panel weights before the first Target call', async () => {
    const executeTarget = vi.fn(async () => ({ output: 'A' }));
    const declaration = executor(executeTarget);
    await expect(evaluate({
      dataset: pairedInput().dataset,
      variants: [variant(declaration, treatmentSpec)],
      evaluators: [{
        evaluatorKind: 'rubric-judge',
        evaluatorId: 'invalid-panel',
        metricId: 'quality-score',
        rubric: { criterionId: 'quality', prompt: 'Judge.', rubric: 'Score it.' },
        judges: [{
          memberId: 'judge-a',
          model: 'judge-a',
          judge: {
            judgeId: 'test.invalid-panel/v1',
            version: '1.0.0',
            providerCost: { reporting: 'optional' },
            async invoke() {
              return { invocationStatus: 'completed', output: '{"score":5,"reason":"ok"}' };
            },
          },
        }],
        aggregation: {
          method: 'weighted-mean',
          missing: 'require-complete',
          weights: { unknown: 1 },
        },
      }],
      comparisons: [],
      analyses: [],
      experiment: { seed: 'invalid-panel-seed', sampling: { samplingKind: 'solo' } },
      policy: {}
    }, {
      runId: 'invalid-panel'
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it('rejects duplicate members, invalid replicate counts, and the singular Rubric shape', async () => {
    const executeTarget = vi.fn(async () => ({ output: 'A' }));
    const declaration = executor(executeTarget);
    const judge = {
      judgeId: 'test.panel-validation/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      async invoke() {
        return { invocationStatus: 'completed' as const, output: '{"score":5,"reason":"ok"}' };
      },
    };
    const base = {
      dataset: pairedInput().dataset,
      variants: [variant(declaration, treatmentSpec)],
      comparisons: [],
      analyses: [],
      experiment: { seed: 'panel-validation-seed', sampling: { samplingKind: 'solo' as const } },
      policy: {},
    };
    const panel = {
      evaluatorKind: 'rubric-judge',
      evaluatorId: 'validation-panel',
      metricId: 'quality-score',
      rubric: { criterionId: 'quality', prompt: 'Judge.', rubric: 'Score it.' },
      aggregation: { method: 'mean', missing: 'require-complete' },
    } as const;

    await expect(evaluate({
      ...base,
      evaluators: [{
        ...panel,
        judges: [
          { memberId: 'same', model: 'a', judge },
          { memberId: 'same', model: 'b', judge },
        ],
      }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    await expect(evaluate({
      ...base,
      evaluators: [{
        ...panel,
        judges: [{ memberId: 'primary', model: 'a', judge, replicateCount: 0 }],
      }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    await expect(evaluate({
      ...base,
      evaluators: [{
        evaluatorKind: 'rubric-judge',
        evaluatorId: 'singular-judge',
        metricId: 'quality-score',
        model: 'old-model',
        judge,
        rubric: panel.rubric,
      } as unknown as Evaluator],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    expect(executeTarget).not.toHaveBeenCalled();
  });

  it('canonicalizes commutative panel member declaration order', async () => {
    const declaration = executor();
    const judge = {
      judgeId: 'test.panel-order/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      async invoke() {
        return { invocationStatus: 'completed' as const, output: '{"score":3,"reason":"ok"}' };
      },
    };
    const members = [
      { memberId: 'judge-a', model: 'model-a', judge },
      { memberId: 'judge-b', model: 'model-b', judge },
    ] as const;
    const common = {
      dataset: pairedInput().dataset,
      variants: [variant(declaration, treatmentSpec)],
      comparisons: [],
      analyses: [{
        analysisId: 'order-panel-quality',
        analysisKind: 'quality-interval' as const,
        statistic: 'mean' as const,
        variantId: treatmentSpec.variantId,
        metricId: 'quality-score',
        confidence: {
          method: 'percentile-bootstrap' as const,
          level: 0.95,
          resamples: 32,
        },
      }],
      experiment: { seed: 'panel-order-seed', sampling: { samplingKind: 'solo' as const } },
      policy: {},
    };
    const evaluator = (judges: RubricJudgeEvaluator['judges']): RubricJudgeEvaluator => ({
      evaluatorKind: 'rubric-judge',
      evaluatorId: 'order-panel',
      metricId: 'quality-score',
      rubric: { criterionId: 'quality', prompt: 'Judge.', rubric: 'Score it.' },
      judges,
      aggregation: { method: 'mean', missing: 'require-complete' },
    });
    const first = await evaluate({
      ...common,
      evaluators: [evaluator(members)]
    }, {
      runId: 'panel-order-first',
      clock: fixedClock
    });
    const second = await evaluate({
      ...common,
      evaluators: [evaluator([...members].reverse())]
    }, {
      runId: 'panel-order-second',
      clock: fixedClock
    });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(second.definition).toEqual(first.definition);
  });

  it('compiles equivalent declarations to one canonical Core Definition', async () => {
    const declaration = executor();
    const common = pairedInput(declaration);
    const first = await evaluate({ ...common }, {
      clock: fixedClock
    });
    const second = await evaluate({
      ...common,
      variants: [...common.variants].reverse(),
      comparisons: [{
        ...common.comparisons[0],
        treatmentVariantIds: [...common.comparisons[0].treatmentVariantIds].reverse(),
        metricIds: [...common.comparisons[0].metricIds].reverse(),
      }]
    }, {
      clock: fixedClock
    });

    const selector = { analysisId: 'baseline-vs-candidate-correct' };
    const resultId = 'baseline-vs-candidate-correct';
    const expected = EvaluationDefinitionSchema.parse({
      schemaVersion: EVALUATION_DEFINITION_SCHEMA_VERSION,
      dataset: common.dataset,
      targets: [controlSpec, treatmentSpec].map((spec) => ({
        targetId: spec.variantId,
        targetKind: spec.artifact.kind,
        protocolId: 'omk.invoke/v1',
        executorId: declaration.executorId,
        executionRequirements: {
          systemInstructions: 'not-required', workspace: 'not-required',
          mcp: 'not-required', mockInterception: 'not-required',
          toolPolicy: 'runtime-default', skillDiscovery: 'runtime-default',
        },
        executionControls: {
          defaults: {
            workspace: { workspaceMode: 'not-required' },
            tools: { toolPolicyKind: 'runtime-default' },
            mcp: { mcpMode: 'not-required' },
            mockInterception: { mockInterceptionMode: 'not-required' },
          },
          sampleOverrides: [],
        },
        config: {
          schemaVersion: 'omk.eval-runtime.variant-config/v3',
          artifact: spec.artifact,
          ...('runtimeContext' in spec ? { runtimeContext: spec.runtimeContext } : {}),
          executorConfig: spec.config,
        },
      })),
      evaluators: [{
        evaluatorId: 'exact-match',
        evaluatorKind: 'assertion',
        implementationId: 'omk.eval-runtime.exact-match/v1',
        measurement: {
          instrumentId: 'canonical-json-exact-match-v1',
          ensembleMemberId: 'deterministic-local',
          replicateGroupId: 'deterministic-primary',
          replicateIndex: 0,
        },
        metricIds: ['correct'],
        inputs: [
          { bindingId: 'actual', sourceKind: 'output', pointer: '' },
          { bindingId: 'expected', sourceKind: 'expected', pointer: '' },
        ],
      }],
      metrics: [{
        metricId: 'correct', valueType: 'boolean', scope: 'sample',
        direction: 'higher-is-better', missingPolicyId: 'exclude/v1',
      }],
      experiment: {
        trials: 1,
        seed: 'fixed-seed',
        assignment: {
          assignmentKind: 'complete-block',
          algorithmId: 'assignment.complete-block/v1',
          randomizationSlotIds: ['prompt-v1', 'prompt-v2'].map((variantId) => (
            stableFacadeId('slot', { variantId })
          )).sort(),
        },
        sampling: {
          experimentalUnit: 'sample', pairingKey: '/sampleId', repeatedMeasures: false,
          resamplingUnit: 'paired-block',
          estimatorId: 'bootstrap.paired-difference-percentile/v1',
          seedCoupling: 'shared-within-block',
        },
        scheduling: { schedulingKind: 'interleaved' },
        randomizationSlots: ['prompt-v1', 'prompt-v2'].map((variantId) => ({
          targetId: variantId,
          randomizationSlotId: stableFacadeId('slot', { variantId }),
        })).sort((left, right) => (
          left.randomizationSlotId < right.randomizationSlotId ? -1
            : left.randomizationSlotId > right.randomizationSlotId ? 1 : 0
        )),
      },
      analysisGraph: {
        analysisMode: 'preregistered',
        nodes: [{
          analysisNodeKind: 'estimator',
          nodeId: stableFacadeId('node', selector),
          implementationId: 'bootstrap.paired-difference-percentile/v1',
          inputs: [
            { inputKind: 'metric-observations', referenceId: 'correct' },
            {
              inputKind: 'comparison', referenceId: 'baseline-vs-candidate',
              treatmentTargetId: 'prompt-v2', metricId: 'correct',
            },
          ],
          outputResultId: resultId,
          parameters: { resamples: 100, alpha: 0.05 },
        }],
      },
      comparisons: [{
        comparisonId: 'baseline-vs-candidate', controlTargetId: 'prompt-v1',
        treatmentTargetIds: ['prompt-v2'], metricIds: ['correct'],
      }],
      decisionPolicy: {
        decisionPolicyId: stableFacadeId('decision', {
          decisionKind: 'analysis', resultId,
        }),
        implementationId: 'progress/v2',
        analysisResultIds: [resultId],
        comparisonFamily: [{
          comparisonId: 'baseline-vs-candidate', treatmentTargetId: 'prompt-v2',
          metricId: 'correct', analysisResultId: resultId,
        }],
        minimumEvidenceStatus: 'complete',
        parameters: { threshold: 0, equivalence: 0 },
      },
    });

    expect(EvaluationDefinitionSchema.parse(first.definition)).toEqual(first.definition);
    expect(first.definition).toEqual(expected);
    expect(second.definition).toEqual(first.definition);
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    if (first.status !== 'completed' || second.status !== 'completed') return;
    expect(second.artifacts.execution.executionPlanDigest)
      .toBe(first.artifacts.execution.executionPlanDigest);
    expect(second.artifacts.evaluation.evaluationPlanDigest)
      .toBe(first.artifacts.evaluation.evaluationPlanDigest);
    expect(second.artifacts.analysis.analysisPlanDigest)
      .toBe(first.artifacts.analysis.analysisPlanDigest);
    expect(first.definition.experiment.randomizationSlots.map((slot) => slot.randomizationSlotId))
      .toEqual([
        stableFacadeId('slot', { variantId: 'prompt-v1' }),
        stableFacadeId('slot', { variantId: 'prompt-v2' }),
      ]);
    expect(first.definition.analysisGraph.nodes[0]).toMatchObject({
      nodeId: stableFacadeId('node', selector),
      outputResultId: resultId,
    });
    expect(first.definition.decisionPolicy?.decisionPolicyId).toBe(stableFacadeId('decision', {
      decisionKind: 'analysis',
      resultId: first.definition.analysisGraph.nodes[0].outputResultId,
    }));
  });

  it('canonicalizes Analysis request and cohort-filter declaration order', async () => {
    const declaration = executor();
    const base = pairedInput(declaration);
    const dataset = {
      ...base.dataset,
      analysisCohorts: [{
        cohortId: 'alpha',
        cohortSetId: 'tags',
        cohortSetKind: 'cohort' as const,
        classification: 'public' as const,
        disclosure: 'identity-only' as const,
      }, {
        cohortId: 'beta',
        cohortSetId: 'tags',
        cohortSetKind: 'cohort' as const,
        classification: 'public' as const,
        disclosure: 'identity-only' as const,
      }],
      samples: base.dataset.samples.map((sample) => ({
        ...sample,
        analysis: { memberships: [{ cohortId: 'alpha' }, { cohortId: 'beta' }] },
      })),
    };
    const analyses = [{
      analysisId: 'candidate-rate',
      analysisKind: 'summary' as const,
      statistic: 'rate' as const,
      variantId: treatmentSpec.variantId,
      metricId: 'correct',
      cohortFilter: { includeCohortIds: ['beta', 'alpha'] },
    }, {
      analysisId: 'comparison-interval',
      analysisKind: 'comparison-interval' as const,
      statistic: 'mean-difference' as const,
      comparisonId: 'baseline-vs-candidate',
      treatmentVariantId: treatmentSpec.variantId,
      metricId: 'correct',
      confidence: { method: 'percentile-bootstrap' as const, level: 0.95, resamples: 32 },
    }];

    const first = await evaluate({
      ...base,
      dataset,
      analyses,
      decision: undefined
    }, {
      runId: 'analysis-order-first',
      clock: fixedClock
    });
    const second = await evaluate({
      ...base,
      dataset,
      analyses: [...analyses].reverse().map((request) => (request.analysisKind === 'summary'
        ? { ...request, cohortFilter: { includeCohortIds: ['alpha', 'beta'] } }
        : request)),
      decision: undefined
    }, {
      runId: 'analysis-order-second',
      clock: fixedClock
    });

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(second.definition).toEqual(first.definition);
  });

  it('preserves Executor trace, usage, and required-telemetry failures end to end', async () => {
    const declaration: Executor<string, undefined, { answer: string; }, { steps: string[]; }> = {
      executorId: 'test.telemetry-executor/v1',
      version: '1.0.0',
      schemas: {
        input: z.string(),
        output: z.object({ answer: z.string() }).strict(),
        trace: z.object({ steps: z.array(z.string()) }).strict(),
      },
      outputClassification: 'public',
      traceClassification: 'sensitive',
      capabilities: {
        determinism: 'deterministic',
        cancellation: 'cooperative',
        concurrency: { safety: 'parallel-safe' },
        seedControl: 'unsupported',
        telemetry: {
          trace: 'required',
          usage: 'required',
          providerCost: { reporting: 'optional' },
        },
      },
      async execute() {
        return {
          output: { answer: 'ok' },
          trace: { steps: ['done'] },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const makeVariant = (
      variantId: string,
      artifact: Variant<string, undefined, { answer: string; }>['artifact'],
      boundExecutor = declaration,
    ): Variant<string, undefined, { answer: string; }, { steps: string[]; }> => ({
      variantId,
      artifact,
      execution: { executor: boundExecutor },
    });
    const input = {
      dataset: {
        datasetId: 'telemetry',
        samples: [{ sampleId: 'one', input: 'question', expected: { answer: 'ok' } }],
      },
      variants: [makeVariant('only', {
        name: 'candidate', kind: 'prompt', source: 'inline', content: 'Answer.',
      })],
      evaluators: [{ evaluatorKind: 'exact-match' as const }],
      comparisons: [],
      analyses: [{
        analysisId: 'only-correct',
        analysisKind: 'quality-interval' as const,
        statistic: 'mean' as const,
        variantId: 'only',
        metricId: 'correct',
        confidence: {
          method: 'percentile-bootstrap' as const,
          level: 0.95,
          resamples: 100,
        },
      }],
      experiment: { seed: 'telemetry-seed', sampling: { samplingKind: 'solo' as const } },
      policy: {},
    };

    const result = await evaluate(input, {
      runId: 'telemetry-evaluate',
      clock: fixedClock,
    });
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'completed',
      output: { classification: 'public', value: { answer: 'ok' } },
      trace: { classification: 'sensitive', value: { steps: ['done'] } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });

    const missingTraceExecutor: typeof declaration = {
      ...declaration,
      async execute() {
        return {
          output: { answer: 'ok' },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const missingTrace = await evaluate({
      ...input,
      variants: [makeVariant('only', input.variants[0].artifact, missingTraceExecutor)]
    }, {
      runId: 'telemetry-missing-trace',
      clock: fixedClock
    });
    expect(missingTrace.status).toBe('completed');
    if (missingTrace.status !== 'completed') return;
    expect(missingTrace.artifacts.execution.records[0]).toMatchObject({
      executionStatus: 'failed',
      error: { code: 'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION' },
    });
  });

  it('captures mutable Variant config and Executor callbacks before asynchronous execution', async () => {
    const declaration = executor();
    const mutable = structuredClone(treatmentSpec) as {
      variantId: string;
      artifact: typeof treatmentSpec.artifact;
      runtimeContext: { values: { model: string; }; };
      config: Config;
    };
    const pending = evaluate({
      ...pairedInput(declaration),
      variants: [variant(declaration, controlSpec), variant(declaration, mutable)]
    }, {
      clock: fixedClock
    });
    mutable.config.answers.one = 'mutated';
    (declaration as { execute: Executor<Input, Config, string>['execute']; }).execute = async () => ({
      output: 'mutated',
    });

    const result = await pending;
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records.filter((record) => (
      record.targetId === treatmentSpec.variantId
      && record.executionStatus === 'completed'
      && record.output?.contentKind === 'inline'
      && record.output.value === 'A'
    ))).toHaveLength(1);
  });

  it('captures Judge identity facets and method receiver before asynchronous execution', async () => {
    const seenRevisions: string[] = [];
    const mutableJudge = {
      judgeId: 'test.mutable-judge/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      fingerprintFacets: { deploymentRevision: 'judge-one' },
      async invoke(this: { fingerprintFacets?: { deploymentRevision?: string; }; }) {
        seenRevisions.push(this.fingerprintFacets?.deploymentRevision ?? 'missing');
        return { invocationStatus: 'completed' as const, output: '{"score":5,"reason":"ok"}' };
      },
    };
    const pending = evaluate({
      ...pairedInput(),
      evaluators: [{
        evaluatorKind: 'rubric-judge', evaluatorId: 'captured-judge',
        metricId: 'captured-score',
        judges: [{ memberId: 'primary', model: 'judge-model', judge: mutableJudge }],
        aggregation: { method: 'mean', missing: 'require-complete' },
        rubric: {
          criterionId: 'correctness', prompt: 'Judge correctness.',
          rubric: '5 is correct; 1 is incorrect.',
        },
      }],
      comparisons: [{
        comparisonId: 'baseline-vs-candidate',
        controlVariantId: 'prompt-v1', treatmentVariantIds: ['prompt-v2'],
        metricIds: ['captured-score'],
      }],
      analyses: comparisonAnalysis('captured-score'),
      decision: undefined
    }, {
      runId: 'captured-judge'
    });
    mutableJudge.fingerprintFacets.deploymentRevision = 'mutated';
    mutableJudge.invoke = async () => { throw new Error('must retain captured method'); };

    const result = await pending;
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(seenRevisions).toEqual(['judge-one', 'judge-one', 'judge-one', 'judge-one']);
  });

  it('keeps structured Executor failures stable and provider-private throws redacted', async () => {
    const privateMessage = 'provider-private-executor-message';
    const declaration = executor(async ({ variantId, input, config }) => {
      if (variantId === treatmentSpec.variantId) return { errorCode: 'host-capacity-exhausted' };
      if (input.prompt === 'two') throw new Error(privateMessage);
      return { output: config.answers[input.prompt] };
    });
    const result = await evaluate({ ...pairedInput(declaration), decision: undefined });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    const failures = result.artifacts.execution.records.filter(
      (record) => record.executionStatus === 'failed',
    );
    expect(failures.map((record) => record.error.code)).toEqual(expect.arrayContaining([
      'EVAL_RUNTIME_EXECUTOR_FAILED', 'host-capacity-exhausted',
    ]));
    expect(JSON.stringify(result)).not.toContain(privateMessage);
  });

  it('maps output schema mismatches to stable redacted execution failures', async () => {
    const privateOutput = { answer: 'must-not-be-persisted' };
    const declaration = executor(async () => ({ output: privateOutput as never }));
    const result = await evaluate({
      ...pairedInput(declaration),
      evaluators: [{ evaluatorKind: 'exact-match', metricId: 'schema-safe-correct' }],
      comparisons: [{
        comparisonId: 'baseline-vs-candidate',
        controlVariantId: 'prompt-v1', treatmentVariantIds: ['prompt-v2'],
        metricIds: ['schema-safe-correct'],
      }],
      analyses: comparisonAnalysis('schema-safe-correct'),
      decision: undefined
    }, {
      runId: 'schema-mismatch'
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed' || result.artifacts === undefined) return;
    expect(result.artifacts.execution.records.every((record) => (
      record.executionStatus === 'failed'
      && record.error.code === 'EVAL_RUNTIME_EXECUTOR_OUTPUT_INVALID'
    ))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateOutput.answer);
  });

  it('checks a Variant-bound Executor through real success, failure, and cancellation', async () => {
    const declaration = executor(async ({ input, config, signal }) => {
      if (input.prompt === 'failure') return { errorCode: 'expected-failure' };
      if (input.prompt === 'cancellation') {
        await new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      return { output: config.answers[input.prompt] };
    });
    const result = await checkExecutor({
      variant: variant(declaration, treatmentSpec),
      success: { input: { prompt: 'one' }, expected: 'A' },
      failure: { input: { prompt: 'failure' }, expectedErrorCode: 'expected-failure' },
      cancellation: { input: { prompt: 'cancellation' } },
    });

    expect(result.conformant, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.every((check) => check.checkStatus === 'passed')).toBe(true);
  });

  it('forwards cancellation and redacts observer failures', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    controller.abort(new Error('cancel before start'));
    const cancelled = await evaluate({
      ...pairedInput()
    }, {
      runId: 'cancelled-evaluate',
      signal: controller.signal
    });
    expect(cancelled.status).toBe('cancelled');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

    const privateValue = 'private-observer-payload';
    let caught: unknown;
    try {
      await evaluate({
        ...pairedInput()
      }, {
        runId: 'observer-failure',
        onEvent() { throw { privateValue }; }
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvaluationEventConsumptionError);
    if (!(caught instanceof EvaluationEventConsumptionError)) return;
    expect(caught.code).toBe('EVAL_RUNTIME_EVENT_OBSERVER_FAILED');
    expect(caught.runResult?.status).toBe('completed');
    expect(JSON.stringify(caught)).not.toContain(privateValue);
  });

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
      () => ({ resultKind: 'score', value: 1 }),
    );
    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [{
        ...custom,
        metric: { ...custom.metric, scope: 'run' },
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
        metric: { ...custom.metric, metricId: 'invalid-custom-config-two-score' },
        implementation: { ...custom.implementation, version: '2.0.0' },
      }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });

    const lowerIsBetter = {
      ...custom,
      metric: {
        metricId: custom.metric.metricId,
        valueType: 'numeric' as const,
        direction: 'lower-is-better' as const,
        missingPolicyId: 'exclude/v1' as const,
      },
    };
    await expect(evaluate({
      ...pairedInput(declaration),
      evaluators: [lowerIsBetter],
      comparisons: [{
        ...pairedInput(declaration).comparisons[0],
        metricIds: [lowerIsBetter.metric.metricId],
      }],
      analyses: comparisonAnalysis(lowerIsBetter.metric.metricId, 'lower-is-better'),
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
      ({ bindings }) => ({ resultKind: 'score', value: bindings.actual.length }),
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
