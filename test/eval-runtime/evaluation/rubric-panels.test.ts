import { describe, expect, it, vi } from "vitest";
import { evaluate, prepareEvaluation, type Evaluator, type RubricJudgeEvaluator } from "../../../src/eval-runtime/index.js";
import { comparisonAnalysis, controlSpec, executor, fixedClock, numericCustomEvaluator, pairedInput, treatmentSpec, variant } from '../fixtures/evaluation.js';

describe('canonical eval-runtime rubric-panels', () => {
it('surfaces the Core reference code when no Sample carries a standard answer', async () => {
    let invocations = 0;
    const declaration = executor(async ({ input, config }) => {
      invocations += 1;
      return { output: config.answers[input.prompt] };
    });
    const paired = pairedInput(declaration);
    const input = {
      ...paired,
      dataset: {
        ...paired.dataset,
        samples: paired.dataset.samples.map((sample) => ({
          sampleId: sample.sampleId, input: sample.input,
        })),
      },
    };

    await expect(prepareEvaluation(input as never)).rejects.toMatchObject({
      code: 'EVAL_RUNTIME_INPUT_INVALID',
      message: 'Evaluation 无法封存为可执行 Plan。',
      cause: { failureKind: 'configuration', code: 'EVAL_DEFINITION_MISSING_REFERENCE' },
    });
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
          rubrics: [{ metricId: 'quality-score',
            criterionId: 'quality',
            prompt: 'Judge answer quality.',
            rubric: '5 is correct; 1 is incorrect.',
           }],

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
                  output: '{"scores":[{"metricId":"quality-score","score":5,"reason":"correct"}]}',
                };
              },
            },
          }],
          aggregation: { method: 'mean', missing: 'require-complete' },
        },
        numericCustomEvaluator('length', ({ bindings }) => ({
          resultKind: 'completed',
          results: [{ metricId: 'length-score', resultKind: 'score', value: bindings.actual.length }],
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
            ? '{"scores":[{"metricId":"quality-score","score":1,"reason":"a"}]}'
            : '{"scores":[{"metricId":"quality-score","score":5,"reason":"b"}]}',
        };
      },
    };
    const panel = {
      evaluatorKind: 'rubric-judge',
      evaluatorId: 'quality-panel',
      rubrics: [{ metricId: 'quality-score',
        criterionId: 'quality',
        prompt: 'Judge quality.',
        rubric: '5 is best; 1 is worst.',
       }],

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
        rubrics: [{ metricId: 'quality-score',  criterionId: 'quality', prompt: 'Judge.', rubric: 'Score it.'  }],

        judges: [{
          memberId: 'judge-a',
          model: 'judge-a',
          judge: {
            judgeId: 'test.invalid-panel/v1',
            version: '1.0.0',
            providerCost: { reporting: 'optional' },
            async invoke() {
              return { invocationStatus: 'completed', output: '{"scores":[{"metricId":"quality-score","score":5,"reason":"ok"}]}' };
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
        return { invocationStatus: 'completed' as const, output: '{"scores":[{"metricId":"quality-score","score":5,"reason":"ok"}]}' };
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
      rubrics: [{ metricId: 'quality-score',  criterionId: 'quality', prompt: 'Judge.', rubric: 'Score it.'  }],

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
        rubrics: panel.rubrics,
        model: 'old-model',
        judge,

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
        return { invocationStatus: 'completed' as const, output: '{"scores":[{"metricId":"quality-score","score":3,"reason":"ok"}]}' };
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
      rubrics: [{ metricId: 'quality-score',  criterionId: 'quality', prompt: 'Judge.', rubric: 'Score it.'  }],

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

it('captures Judge identity facets and method receiver before asynchronous execution', async () => {
    const seenRevisions: string[] = [];
    const mutableJudge = {
      judgeId: 'test.mutable-judge/v1',
      version: '1.0.0',
      providerCost: { reporting: 'optional' as const },
      fingerprintFacets: { deploymentRevision: 'judge-one' },
      async invoke(this: { fingerprintFacets?: { deploymentRevision?: string; }; }) {
        seenRevisions.push(this.fingerprintFacets?.deploymentRevision ?? 'missing');
        return { invocationStatus: 'completed' as const, output: '{"scores":[{"metricId":"captured-score","score":5,"reason":"ok"}]}' };
      },
    };
    const pending = evaluate({
      ...pairedInput(),
      evaluators: [{
        evaluatorKind: 'rubric-judge', evaluatorId: 'captured-judge',
        rubrics: [{ metricId: 'captured-score',
          criterionId: 'correctness', prompt: 'Judge correctness.',
          rubric: '5 is correct; 1 is incorrect.',
         }],
        judges: [{ memberId: 'primary', model: 'judge-model', judge: mutableJudge }],
        aggregation: { method: 'mean', missing: 'require-complete' },

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
    expect(result.artifacts?.evaluation?.records.every((record) => (
      record.evaluationStatus === 'completed'
      && record.observations.every((observation) => observation.observationStatus === 'observed')
    ))).toBe(true);
  });
});
