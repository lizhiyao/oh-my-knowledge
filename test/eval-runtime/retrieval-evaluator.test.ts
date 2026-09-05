import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  EvaluationDefinitionSchema,
  type JsonValue,
} from '../../src/eval-core/contracts/index.js';
import {
  evaluate,
  prepareEvaluation,
  type Clock,
  type EvaluateInput,
  type Executor,
  type RetrievalEvaluator,
} from '../../src/eval-runtime/index.js';
import {
  calculateBinaryRetrievalMetrics,
  createRetrievalEvaluatorIdentity,
} from '../../src/eval-runtime/evaluators/retrieval.js';

interface RetrievalConfig {
  readonly [key: string]: JsonValue;
  readonly rankings: Record<string, Array<string | number>>;
}

const fixedClock: Clock = {
  monotonicNow: () => 0,
  timestamp: () => '2026-09-05T00:00:00.000Z',
  sleep: () => Promise.resolve(),
};

const metricIds = {
  recallAtK: 'recall-at-3',
  precisionAtK: 'precision-at-3',
  reciprocalRankAtK: 'reciprocal-rank-at-3',
  ndcgAtK: 'ndcg-at-3',
} as const;

function retrievalEvaluator(
  ranking: RetrievalEvaluator['ranking'] = { source: 'output', pointer: '/documents' },
): RetrievalEvaluator {
  return {
    evaluatorKind: 'retrieval',
    evaluatorId: 'retrieval-quality',
    cutoff: 3,
    ranking,
    relevantDocumentIdsPointer: '/relevantDocumentIds',
    metricIds,
  };
}

function executor(
  seen: unknown[] = [],
  trace = false,
  onExecute?: () => void,
): Executor<
  { query: string },
  RetrievalConfig,
  { documents: Array<string | number> },
  { documents: Array<string | number> }
> {
  return {
    executorId: trace ? 'test.trace-retriever/v1' : 'test.output-retriever/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ query: z.string() }).strict(),
      config: z.object({
        rankings: z.record(z.string(), z.array(z.union([z.string(), z.number()]))),
      }).strict(),
      output: z.object({ documents: z.array(z.union([z.string(), z.number()])) }).strict(),
      trace: z.object({ documents: z.array(z.union([z.string(), z.number()])) }).strict(),
    },
    outputClassification: 'public',
    traceClassification: 'public',
    capabilities: {
      determinism: 'deterministic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe' },
      seedControl: 'unsupported',
      telemetry: { trace: trace ? 'required' : 'optional', usage: 'optional' },
    },
    fingerprintFacets: { revision: 'retrieval-one' },
    async execute(invocation) {
      onExecute?.();
      seen.push(structuredClone(invocation));
      const documents = invocation.config.rankings[invocation.input.query] ?? [];
      return trace
        ? { output: { documents: [] }, trace: { documents } }
        : { output: { documents }, trace: { documents: [] } };
    },
  };
}

function input(
  declaration: Executor<
    { query: string },
    RetrievalConfig,
    { documents: Array<string | number> },
    { documents: Array<string | number> }
  >,
  evaluator: RetrievalEvaluator = retrievalEvaluator(),
): EvaluateInput {
  return {
    dataset: {
      datasetId: 'retrieval-dataset',
      samples: [{
        sampleId: 'query-one',
        input: { query: 'one' },
        expected: { relevantDocumentIds: ['doc-a', 'doc-b'] },
      }, {
        sampleId: 'query-two',
        input: { query: 'two' },
        expected: { relevantDocumentIds: ['doc-c'] },
      }],
    },
    variants: [{
      variantId: 'retriever-v1',
      artifact: {
        name: 'retriever-v1',
        kind: 'workflow',
        source: 'inline',
        content: 'Retrieve ranked document IDs.',
      },
      execution: {
        executor: declaration,
        config: {
          rankings: {
            one: ['doc-x', 'doc-b', 'doc-a', 'doc-after-cutoff'],
            two: ['doc-x'],
          },
        },
      },
    }],
    evaluators: [evaluator],
    comparisons: [],
    analyses: Object.values(metricIds).map((metricId) => ({
      analysisId: `${metricId}-mean`,
      analysisKind: 'summary' as const,
      statistic: 'mean' as const,
      variantId: 'retriever-v1',
      metricId,
    })),
    experiment: { seed: 'retrieval-seed', sampling: { samplingKind: 'solo' } },
    policy: {
      execution: { maxConcurrency: 1 },
      evaluation: { maxConcurrency: 1 },
    },
  };
}

describe('canonical retrieval evaluator', () => {
  it('implements binary top-k formulas without silently changing the denominator', () => {
    const values = calculateBinaryRetrievalMetrics({
      ranking: ['doc-x', 'doc-b', 'doc-a', 'doc-after-cutoff'],
      relevantDocumentIds: ['doc-a', 'doc-b'],
      cutoff: 3,
    });

    expect(values.recallAtK).toBe(1);
    expect(values.precisionAtK).toBeCloseTo(2 / 3);
    expect(values.reciprocalRankAtK).toBe(0.5);
    expect(values.ndcgAtK).toBeCloseTo(
      (1 / Math.log2(3) + 1 / Math.log2(4))
        / (1 + 1 / Math.log2(3)),
    );
    expect(calculateBinaryRetrievalMetrics({
      ranking: ['doc-a'],
      relevantDocumentIds: ['doc-a', 'doc-b'],
      cutoff: 3,
    })).toMatchObject({
      recallAtK: 0.5,
      precisionAtK: 1 / 3,
      reciprocalRankAtK: 1,
    });
    expect(calculateBinaryRetrievalMetrics({
      ranking: ['doc-x'],
      relevantDocumentIds: ['doc-a'],
      cutoff: 3,
    })).toEqual({
      recallAtK: 0,
      precisionAtK: 0,
      reciprocalRankAtK: 0,
      ndcgAtK: 0,
    });
    expect(calculateBinaryRetrievalMetrics({
      ranking: ['doc-x', 'doc-y', 'doc-z', 'doc-a'],
      relevantDocumentIds: ['doc-a'],
      cutoff: 3,
    })).toEqual({
      recallAtK: 0,
      precisionAtK: 0,
      reciprocalRankAtK: 0,
      ndcgAtK: 0,
    });
    expect(() => calculateBinaryRetrievalMetrics({
      ranking: ['doc-a', 'doc-a'], relevantDocumentIds: ['doc-a'], cutoff: 3,
    })).toThrow(TypeError);
    expect(() => calculateBinaryRetrievalMetrics({
      ranking: [], relevantDocumentIds: [], cutoff: 3,
    })).toThrow(TypeError);
    expect(() => calculateBinaryRetrievalMetrics({
      ranking: [], relevantDocumentIds: ['doc-a'], cutoff: 0,
    })).toThrow(TypeError);
    const identity = createRetrievalEvaluatorIdentity({
      evaluatorId: 'retrieval-quality',
      cutoff: 3,
      metricIds,
      rankingSource: 'output',
      rankingPointer: '/documents',
      relevantDocumentIdsPointer: '/relevantDocumentIds',
    });
    expect(identity.fingerprint).not.toBe(createRetrievalEvaluatorIdentity({
      evaluatorId: 'retrieval-quality-alias',
      cutoff: 3,
      metricIds,
      rankingSource: 'output',
      rankingPointer: '/documents',
      relevantDocumentIdsPointer: '/relevantDocumentIds',
    }).fingerprint);
  });

  it('runs through the package facade and keeps Gold out of Target invocation', async () => {
    const seen: unknown[] = [];
    const result = await evaluate(input(executor(seen)), {
      runId: 'retrieval-output',
      clock: fixedClock,
    });

    expect(result.status).toBe('completed');
    expect(JSON.stringify(seen)).not.toContain('relevantDocumentIds');
    expect(result.definition.evaluators).toContainEqual(expect.objectContaining({
      evaluatorId: 'retrieval-quality',
      implementationId: 'omk.eval-runtime.retrieval-metrics/v1',
      metricIds: Object.values(metricIds),
      inputs: [{ bindingId: 'ranking', sourceKind: 'output', pointer: '/documents' }, {
        bindingId: 'relevant-document-ids',
        sourceKind: 'expected',
        pointer: '/relevantDocumentIds',
      }],
      config: {
        cutoff: 3,
        relevance: 'binary',
        discount: 'log2',
        precisionDenominator: 'cutoff',
      },
    }));
    expect(result.definition.metrics.filter((metric) => (
      Object.values(metricIds).includes(metric.metricId as typeof metricIds[keyof typeof metricIds])
    ))).toHaveLength(4);
    const queryOne = result.artifacts?.evaluation?.records.find((record) => (
      record.sampleId === 'query-one'
    ));
    expect(queryOne).toMatchObject({ evaluationStatus: 'completed' });
    if (queryOne?.evaluationStatus !== 'completed') throw new Error('Expected observations.');
    expect(Object.fromEntries(queryOne.observations.map((observation) => [
      observation.metricId,
      observation.observationStatus === 'observed' ? observation.value : undefined,
    ]))).toMatchObject({
      'recall-at-3': 1,
      'precision-at-3': 2 / 3,
      'reciprocal-rank-at-3': 0.5,
    });
    expect(result.analysisResults['recall-at-3-mean']).toMatchObject({
      analysisStatus: 'completed',
      value: 0.5,
    });
  });

  it('reads ranking evidence from trace when explicitly declared', async () => {
    const declaration = executor([], true);
    const result = await evaluate(input(
      declaration,
      retrievalEvaluator({ source: 'trace', pointer: '/documents' }),
    ), { runId: 'retrieval-trace', clock: fixedClock });

    expect(result.status).toBe('completed');
    expect(result.definition.evaluators[0].inputs[0]).toEqual({
      bindingId: 'ranking', sourceKind: 'trace', pointer: '/documents',
    });
    expect(result.analysisResults['recall-at-3-mean']).toMatchObject({
      analysisStatus: 'completed', value: 0.5,
    });
  });

  it('feeds existing intervals, composite analysis, and Decision without a second estimator', async () => {
    const declaration = executor();
    const base = input(declaration);
    const control = base.variants[0];
    if (control === undefined) throw new Error('Expected base Variant.');
    const result = await evaluate({
      ...base,
      variants: [{
        ...control,
        variantId: 'retriever-v1',
        execution: {
          ...control.execution,
          config: { rankings: { one: ['doc-x'], two: ['doc-x'] } },
        },
      }, {
        ...control,
        variantId: 'retriever-v2',
        artifact: { ...control.artifact, name: 'retriever-v2' },
        execution: {
          ...control.execution,
          config: { rankings: { one: ['doc-a', 'doc-b'], two: ['doc-c'] } },
        },
      }],
      comparisons: [{
        comparisonId: 'retriever-v1-vs-v2',
        controlVariantId: 'retriever-v1',
        treatmentVariantIds: ['retriever-v2'],
        metricIds: Object.values(metricIds),
      }],
      analyses: [{
        analysisId: 'retriever-v2-recall',
        analysisKind: 'quality-interval',
        statistic: 'mean',
        variantId: 'retriever-v2',
        metricId: metricIds.recallAtK,
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }, {
        analysisId: 'retrieval-recall-difference',
        analysisKind: 'comparison-interval',
        statistic: 'mean-difference',
        comparisonId: 'retriever-v1-vs-v2',
        treatmentVariantId: 'retriever-v2',
        metricId: metricIds.recallAtK,
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }, {
        analysisId: 'retrieval-quality-difference',
        analysisKind: 'composite-comparison-interval',
        compositeMetricId: 'retrieval-quality',
        comparisonId: 'retriever-v1-vs-v2',
        treatmentVariantId: 'retriever-v2',
        components: [
          { metricId: metricIds.recallAtK, weight: 0.5 },
          { metricId: metricIds.ndcgAtK, weight: 0.5 },
        ],
        aggregation: { method: 'weighted-mean', missing: 'require-complete' },
        confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 32 },
      }],
      decision: {
        decisionKind: 'analysis',
        analysisId: 'retrieval-quality-difference',
        threshold: 0,
      },
      experiment: { seed: 'retrieval-comparison', sampling: { samplingKind: 'paired' } },
    }, { runId: 'retrieval-analysis', clock: fixedClock });

    expect(result.status).toBe('completed');
    expect(result.analysisResults['retriever-v2-recall']).toMatchObject({
      analysisStatus: 'completed', value: { estimate: 1 },
    });
    expect(result.analysisResults['retrieval-recall-difference']).toMatchObject({
      analysisStatus: 'completed', value: { estimate: 1 },
    });
    expect(result.analysisResults['retrieval-quality-difference']).toMatchObject({
      analysisStatus: 'completed', value: { estimate: 1 },
    });
    expect(result.artifacts?.decision).toMatchObject({
      decisionStatus: 'decided',
      verdict: 'PROGRESS',
    });
  });

  it('canonicalizes declaration key order and matches explicit Core assembly', async () => {
    const declaration = input(executor());
    const canonical = await prepareEvaluation(declaration);
    const reorderedEvaluator: RetrievalEvaluator = {
      metricIds: {
        ndcgAtK: metricIds.ndcgAtK,
        reciprocalRankAtK: metricIds.reciprocalRankAtK,
        precisionAtK: metricIds.precisionAtK,
        recallAtK: metricIds.recallAtK,
      },
      relevantDocumentIdsPointer: '/relevantDocumentIds',
      ranking: { pointer: '/documents', source: 'output' },
      cutoff: 3,
      evaluatorId: 'retrieval-quality',
      evaluatorKind: 'retrieval',
    };
    const reordered = await prepareEvaluation({
      ...declaration,
      evaluators: [reorderedEvaluator],
    });
    const manualEvaluator = EvaluationDefinitionSchema.parse({
      ...canonical.definition,
      evaluators: [{
        evaluatorId: 'retrieval-quality',
        evaluatorKind: 'assertion',
        implementationId: 'omk.eval-runtime.retrieval-metrics/v1',
        measurement: {
          instrumentId: 'binary-top-k-retrieval-v1',
          ensembleMemberId: 'deterministic-local',
          replicateGroupId: 'deterministic-primary',
          replicateIndex: 0,
        },
        metricIds: Object.values(metricIds),
        inputs: [
          { bindingId: 'ranking', sourceKind: 'output', pointer: '/documents' },
          {
            bindingId: 'relevant-document-ids',
            sourceKind: 'expected',
            pointer: '/relevantDocumentIds',
          },
        ],
        config: {
          cutoff: 3,
          relevance: 'binary',
          discount: 'log2',
          precisionDenominator: 'cutoff',
        },
      }],
      metrics: Object.values(metricIds)
        .sort((left, right) => left.localeCompare(right))
        .map((metricId) => ({
          metricId,
          valueType: 'numeric',
          scope: 'sample',
          scale: { min: 0, max: 1 },
          direction: 'higher-is-better',
          missingPolicyId: 'exclude/v1',
        })),
    });

    expect(reordered.definition).toEqual(canonical.definition);
    expect(reordered.planDigest).toBe(canonical.planDigest);
    expect(manualEvaluator).toEqual(canonical.definition);
    const [canonicalResult, reorderedResult] = await Promise.all([
      canonical.run({ runId: 'retrieval-equivalent', clock: fixedClock }),
      reordered.run({ runId: 'retrieval-equivalent', clock: fixedClock }),
    ]);
    expect(reorderedResult.artifacts).toEqual(canonicalResult.artifacts);
  });

  it.each([
    { label: 'duplicate ranking', ranking: ['doc-a', 'doc-a'], gold: ['doc-a'], reason: 'retrieval-ranking-invalid' },
    { label: 'duplicate Gold', ranking: ['doc-a'], gold: ['doc-a', 'doc-a'], reason: 'retrieval-relevance-invalid' },
    { label: 'empty Gold', ranking: ['doc-a'], gold: [], reason: 'retrieval-relevance-empty' },
    { label: 'invalid ranking', ranking: [1], gold: ['doc-a'], reason: 'retrieval-ranking-invalid' },
  ])('fails closed for $label', async ({ ranking, gold, reason }) => {
    const declaration = executor();
    const declarationInput = input(declaration);
    const result = await evaluate({
      ...declarationInput,
      dataset: {
        datasetId: 'invalid-retrieval',
        samples: [{
          sampleId: 'invalid-query',
          input: { query: 'invalid' },
          expected: { relevantDocumentIds: gold },
        }],
      },
      variants: declarationInput.variants.map((variant) => ({
        ...variant,
        execution: {
          ...variant.execution,
          config: { rankings: { invalid: ranking } },
        },
      })),
      analyses: [],
    } as EvaluateInput, { runId: `invalid-${reason}`, clock: fixedClock });

    expect(result.status).toBe('completed');
    const record = result.artifacts?.evaluation?.records[0];
    expect(record).toMatchObject({ evaluationStatus: 'completed' });
    if (record?.evaluationStatus !== 'completed') throw new Error('Expected invalid evidence.');
    expect(record.observations).toHaveLength(4);
    expect(record.observations.every((observation) => (
      observation.observationStatus === 'invalid' && observation.reasonCode === reason
    ))).toBe(true);
  });

  it('rejects invalid preset declarations before calling the Target', async () => {
    let invocations = 0;
    const declaration = executor([], false, () => { invocations += 1; });
    const base = input(declaration);

    await expect(prepareEvaluation({
      ...base,
      evaluators: [{ ...retrievalEvaluator(), cutoff: 0 }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    await expect(prepareEvaluation({
      ...base,
      evaluators: [{ ...retrievalEvaluator(), cutoff: Number.MAX_SAFE_INTEGER + 1 }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    await expect(prepareEvaluation({
      ...base,
      evaluators: [{
        ...retrievalEvaluator(),
        metricIds: { ...metricIds, ndcgAtK: metricIds.recallAtK },
      }],
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    expect(invocations).toBe(0);
  });
});
