import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { JsonValueSchema, type JsonValue } from '../../src/eval-core/contracts/index.js';
import {
  createRetrievalAbstentionEvaluation,
  evaluate,
  prepareEvaluation,
  RetrievalAbstentionInputError,
  type Dataset,
  type EvaluateInput,
  type Executor,
  type RetrievalAbstentionEvaluation,
} from '../../src/eval-runtime/index.js';

function sample(sampleId: string, shouldAbstain: boolean | null, forbidden = ['bad']) {
  return {
    sampleId,
    input: { query: sampleId },
    expected: {
      shouldAbstain,
      acceptableSolutionIds: shouldAbstain === false ? ['good'] : [],
      forbiddenSolutionIds: forbidden,
      reviewStatus: 'reviewed',
    },
  };
}

function evaluation(samples = [sample('positive', false), sample('negative', true)]) {
  return createRetrievalAbstentionEvaluation({
    dataset: { datasetId: 'mixed', samples },
    cutoff: 2,
    ranking: { source: 'output', pointer: '/solutionIds' },
  });
}

function runInput(
  prepared: RetrievalAbstentionEvaluation,
  outputs: Record<string, JsonValue> = { positive: { solutionIds: ['good'] }, negative: { solutionIds: [] } },
  seen: unknown[] = [],
): EvaluateInput {
  const executor: Executor<{ query: string }, undefined, JsonValue, JsonValue> = {
    executorId: 'test.abstention/v1',
    version: '1.0.0',
    schemas: {
      input: z.object({ query: z.string() }).strict(),
      output: JsonValueSchema,
      trace: JsonValueSchema,
    },
    outputClassification: 'public',
    traceClassification: 'public',
    capabilities: { determinism: 'deterministic', seedControl: 'unsupported' },
    fingerprintFacets: { outputs },
    async execute(invocation) {
      seen.push(invocation);
      if (invocation.input.query === 'failed') return { errorCode: 'test-request-failed' };
      if (invocation.input.query === 'throw') throw new Error('private provider details');
      return { output: outputs[invocation.input.query], trace: outputs[invocation.input.query] };
    },
  };
  return {
    dataset: prepared.dataset,
    evaluators: prepared.evaluators,
    variants: [{
      variantId: 'candidate',
      artifact: { name: 'retriever', kind: 'workflow', source: 'inline', content: 'retrieve' },
      execution: { executor },
    }],
    comparisons: [],
    analyses: prepared.evaluators.map(({ metric }) => ({
      analysisId: metric.metricId,
      analysisKind: 'summary',
      statistic: metric.valueType === 'numeric' ? 'mean' : 'rate',
      variantId: 'candidate',
      metricId: metric.metricId,
    })),
    experiment: { seed: 'fixed-abstention', sampling: { samplingKind: 'solo' } },
    policy: { execution: { maxConcurrency: 1 }, evaluation: { maxConcurrency: 1 } },
  };
}

describe('retrieval and abstention evaluation', () => {
  it('separates positive ranking, abstention, false abstention and forbidden-hit denominators', async () => {
    const prepared = evaluation([
      sample('hit', false), sample('miss', false), sample('abstain', true),
      sample('wrong', true), sample('unknown', true), sample('no-forbidden', true, []),
    ]);
    const seen: unknown[] = [];
    const result = await evaluate(runInput(prepared, {
      hit: { solutionIds: ['good', 'bad'] },
      miss: { solutionIds: [] },
      abstain: { solutionIds: [] },
      wrong: { solutionIds: ['bad'] },
      unknown: { solutionIds: ['not-in-forbidden'] },
      'no-forbidden': { solutionIds: [] },
    }, seen));
    expect(result.status).toBe('completed');
    const expected = { recallAtK: 0.5, precisionAtK: 0.25, reciprocalRankAtK: 0.5,
      ndcgAtK: 0.5, abstentionCorrect: 0.5, falseAbstention: 0.5, forbiddenHitAtK: 0.4 };
    for (const [name, value] of Object.entries(expected)) {
      const metricId = prepared.metricIds[name as keyof typeof expected];
      expect(result.analysisResults[metricId]).toMatchObject({ analysisStatus: 'completed', value });
    }
    expect(result.analysisResults[prepared.metricIds.recallAtK].coverage.included).toBe(2);
    expect(result.analysisResults[prepared.metricIds.abstentionCorrect].coverage.included).toBe(4);
    expect(result.analysisResults[prepared.metricIds.forbiddenHitAtK].coverage.included).toBe(5);
    expect(seen).toHaveLength(6);
    for (const invocation of seen) {
      expect(invocation).not.toHaveProperty('expected');
      expect(invocation).not.toHaveProperty('annotations');
      expect(invocation).not.toHaveProperty('evaluationContext');
    }
  });

  it('rejects all pending IDs by default and preserves exclusion provenance without mutation', () => {
    const pending = sample('pending', null);
    const ai = sample('ai', false);
    ai.expected.reviewStatus = 'pending_human_annotation';
    const dataset = { datasetId: 'review', samples: [sample('ready', false), pending, ai], annotations: { owner: 'host' } };
    const before = structuredClone(dataset);
    const input = { dataset, cutoff: 3, ranking: { source: 'output' as const, pointer: '/solutionIds' } };
    try {
      createRetrievalAbstentionEvaluation(input);
      throw new Error('expected pending rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(RetrievalAbstentionInputError);
      expect(error).toMatchObject({ code: 'RETRIEVAL_ABSTENTION_PENDING', sampleIds: ['pending', 'ai'] });
    }
    const prepared = createRetrievalAbstentionEvaluation({ ...input, pendingPolicy: 'exclude' });
    expect(prepared.dataset.samples.map((s) => s.sampleId)).toEqual(['ready']);
    expect(prepared.dataset.annotations).toMatchObject({ original: { owner: 'host' }, retrievalAbstention: {
      schemaVersion: 'omk.retrieval-abstention/v1', sourceSampleCount: 3,
      positiveCount: 1, abstentionCount: 0, pendingCount: 2,
      excludedSampleIds: ['pending', 'ai'], pendingPolicy: 'exclude',
    } });
    expect(dataset).toEqual(before);
    expect(() => createRetrievalAbstentionEvaluation({
      ...input, dataset: { datasetId: 'all-pending', samples: [pending] }, pendingPolicy: 'exclude',
    })).toThrow(expect.objectContaining({ code: 'RETRIEVAL_ABSTENTION_DATASET_EMPTY' }));
  });

  it.each<{ expected: JsonValue; code: string }>([
    { expected: { shouldAbstain: false, acceptableSolutionIds: [], forbiddenSolutionIds: [] }, code: 'LABEL_CONFLICT' },
    { expected: { shouldAbstain: true, acceptableSolutionIds: ['x'], forbiddenSolutionIds: [] }, code: 'LABEL_CONFLICT' },
    { expected: { shouldAbstain: false, acceptableSolutionIds: ['x'], forbiddenSolutionIds: ['x'] }, code: 'LABEL_OVERLAP' },
    { expected: { acceptableSolutionIds: [], forbiddenSolutionIds: [] }, code: 'LABEL_INVALID' },
    { expected: { shouldAbstain: 'false', acceptableSolutionIds: ['x'], forbiddenSolutionIds: [] }, code: 'LABEL_INVALID' },
    { expected: { shouldAbstain: true, acceptableSolutionIds: [], forbiddenSolutionIds: ['x', 'x'] }, code: 'LABEL_INVALID' },
    { expected: { shouldAbstain: false, acceptableSolutionIds: [' '], forbiddenSolutionIds: [] }, code: 'LABEL_INVALID' },
  ])('fails closed for invalid Gold: $code', ({ expected, code }) => {
    expect(() => createRetrievalAbstentionEvaluation({
      dataset: { datasetId: 'bad-label', samples: [{ sampleId: 'bad', input: 'private prompt', expected }] },
      cutoff: 1, ranking: { source: 'output', pointer: '' },
    })).toThrow(expect.objectContaining({ code: `RETRIEVAL_ABSTENTION_${code}`, sampleIds: ['bad'] }));
  });

  it('validates options and duplicate sample IDs', () => {
    const base = { dataset: evaluation().dataset, cutoff: 1, ranking: { source: 'output' as const, pointer: '' } };
    expect(() => createRetrievalAbstentionEvaluation({ ...base, cutoff: 0 })).toThrow(RetrievalAbstentionInputError);
    expect(() => createRetrievalAbstentionEvaluation({ ...base, expected: { shouldAbstainPointer: 'not-pointer' } })).toThrow(RetrievalAbstentionInputError);
    expect(() => createRetrievalAbstentionEvaluation({ ...base, dataset: { datasetId: 'duplicate', samples: [sample('same', true), sample('same', true)] } })).toThrow(expect.objectContaining({ code: 'RETRIEVAL_ABSTENTION_SAMPLE_DUPLICATE' }));
    const maxPrefixLength = 256 - '.reciprocalRankAtK/v1'.length;
    expect(createRetrievalAbstentionEvaluation({ ...base, metricPrefix: 'a'.repeat(maxPrefixLength) }).evaluators).toHaveLength(7);
    expect(() => createRetrievalAbstentionEvaluation({ ...base, metricPrefix: 'a'.repeat(maxPrefixLength + 1) })).toThrow(expect.objectContaining({ code: 'RETRIEVAL_ABSTENTION_METRIC_ID_INVALID' }));
  });

  it('keeps execution failure, thrown errors and malformed outputs out of successful abstention', async () => {
    const prepared = evaluation([
      sample('ok', true), sample('failed', true), sample('throw', true),
      sample('missing', true), sample('null', true), sample('duplicate', true), sample('numeric', true),
    ]);
    const result = await evaluate(runInput(prepared, {
      ok: { solutionIds: [] }, missing: {}, null: { solutionIds: null },
      duplicate: { solutionIds: ['bad', 'bad'] }, numeric: { solutionIds: [1] },
    }));
    expect(result.status).toBe('completed');
    const observed = result.artifacts?.evaluation?.records.flatMap((record) => (
      record.evaluationStatus === 'completed' ? record.observations.filter((observation) => (
        observation.metricId === prepared.metricIds.abstentionCorrect && observation.observationStatus === 'observed'
      )) : []
    ));
    expect(observed).toHaveLength(1);
    const executionRecords = result.artifacts?.execution?.records ?? [];
    expect(executionRecords.filter((record) => record.executionStatus === 'failed')).toHaveLength(2);
    expect(JSON.stringify(result.artifacts?.evaluation)).not.toContain('private provider details');
  });

  it('supports mapped labels, escaped pointers and final trace rankings with explicit cutoff', async () => {
    const dataset: Dataset = { datasetId: 'mapped', samples: [{
      sampleId: 'positive', input: { query: 'positive' },
      expected: { expectedShouldAbstain: false, 'good/ids': ['good'], 'bad~ids': ['bad'], quality: { reviewStatus: 'reviewed' } },
    }] };
    const prepared = createRetrievalAbstentionEvaluation({
      dataset, cutoff: 1, ranking: { source: 'trace', pointer: '/solutionIds' },
      expected: { shouldAbstainPointer: '/expectedShouldAbstain', relevantDocumentIdsPointer: '/good~1ids', forbiddenDocumentIdsPointer: '/bad~0ids', reviewStatusPointer: '/quality/reviewStatus' },
    });
    const result = await evaluate(runInput(prepared, { positive: { solutionIds: ['good', 'bad'] } }));
    expect(result.analysisResults[prepared.metricIds.forbiddenHitAtK]).toMatchObject({ value: 0 });
    expect(result.analysisResults[prepared.metricIds.recallAtK]).toMatchObject({ value: 1 });
    expect(result.analysisResults[prepared.metricIds.abstentionCorrect]).not.toMatchObject({ analysisStatus: 'completed', value: 0 });
    expect(result.analysisResults[prepared.metricIds.abstentionCorrect]).not.toMatchObject({ analysisStatus: 'completed', value: 1 });
  });

  it('seals distinct fingerprints for changed measurement options and keeps Gold isolated', async () => {
    const source = evaluation();
    const first = await prepareEvaluation(runInput(source));
    const changed = createRetrievalAbstentionEvaluation({
      dataset: { datasetId: 'mixed', samples: [sample('positive', false), sample('negative', true)] },
      cutoff: 3, ranking: { source: 'output', pointer: '/solutionIds' },
    });
    const second = await prepareEvaluation(runInput(changed));
    expect(first.planDigest).not.toBe(second.planDigest);
    expect(first.definition.evaluators.every((item) => item.implementationId.startsWith('omk.retrieval-abstention/v1:'))).toBe(true);
    const again = await prepareEvaluation(runInput(evaluation()));
    expect(first.planDigest).toBe(again.planDigest);
  });

  it('does not turn a real executor timeout into an empty successful response', async () => {
    const prepared = evaluation([sample('slow', true)]);
    const input = runInput(prepared);
    let aborted = false;
    const executor: Executor<{ query: string }, undefined, JsonValue> = {
      executorId: 'test.timeout-retrieval/v1', version: '1.0.0',
      capabilities: { determinism: 'deterministic', seedControl: 'unsupported' },
      schemas: { input: z.object({ query: z.string() }), output: JsonValueSchema },
      async execute({ signal }) {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { aborted = true; reject(signal.reason); };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
        return { output: { solutionIds: [] } };
      },
    };
    const result = await evaluate({
      ...input,
      variants: [{ ...input.variants[0], execution: { executor } }],
      policy: { ...input.policy, execution: { maxConcurrency: 1, timeoutMs: 5 } },
    });
    expect(aborted).toBe(true);
    expect(result.artifacts?.execution?.records[0]).toMatchObject({
      executionStatus: 'failed', error: { code: 'timeout' },
    });
    expect(result.analysisResults[prepared.metricIds.abstentionCorrect].coverage.included).toBe(0);
  });

  it.each(['failed', 'cancelled', 'budget-censored'])('does not score a retained empty trace after %s execution', async (executionStatus) => {
    const prepared = createRetrievalAbstentionEvaluation({
      dataset: { datasetId: 'trace-failure', samples: [sample('trace', true)] },
      cutoff: 2, ranking: { source: 'trace', pointer: '/solutionIds' },
    });
    for (const evaluator of prepared.evaluators) {
      expect(evaluator.bindings).toContainEqual({ bindingId: 'executionFacts', sourceKind: 'execution-facts', pointer: '' });
      const result = await evaluator.implementation.evaluate({
        bindings: {
          ranking: [], expected: sample('trace', true).expected,
          executionFacts: { terminal: { executionStatus } },
        },
        parameters: evaluator.parameters, sampleId: 'trace', variantId: 'candidate',
        trialIndex: 0, attemptNumber: 1, signal: new AbortController().signal,
      });
      expect(result).toEqual({ resultKind: 'missing', reasonCode: 'retrieval-abstention-execution-not-completed' });
    }
  });

  it('composes different cutoffs in one sealed run without duplicate instrument coordinates', async () => {
    const first = evaluation();
    const second = createRetrievalAbstentionEvaluation({
      dataset: { datasetId: 'mixed', samples: [sample('positive', false), sample('negative', true)] },
      cutoff: 3, metricPrefix: 'at-three', ranking: { source: 'output', pointer: '/solutionIds' },
    });
    const input = runInput(first);
    const prepared = await prepareEvaluation({ ...input, evaluators: [...first.evaluators, ...second.evaluators] });
    expect(prepared.definition.evaluators).toHaveLength(14);
    await expect(prepareEvaluation({ ...input, evaluators: [...first.evaluators, ...first.evaluators] })).rejects.toThrow();
  });
});
