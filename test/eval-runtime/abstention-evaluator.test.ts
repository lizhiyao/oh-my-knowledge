import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { JsonValueSchema, digestCanonicalJson, projectExecutionFacts, type JsonValue } from '../../src/eval-core/contracts/index.js';
import {
  evaluate, prepareEvaluation,
  type AbstentionEvaluator, type EvaluateInput, type EvaluationResult, type Executor,
} from '../../src/eval-runtime/index.js';
import { createAbstentionEvaluatorBinding } from '../../src/eval-runtime/evaluators/abstention.js';

const evaluator: AbstentionEvaluator = {
  evaluatorKind: 'abstention', evaluatorId: 'abstention',
  ranking: { source: 'output', pointer: '/ids' },
  shouldAbstainPointer: '/shouldAbstain',
  metricIds: { abstentionCorrect: 'correct-abstention', falseAbstention: 'false-abstention' },
};

function input(cases: Array<{ expected: JsonValue; output: JsonValue }>, seen: unknown[] = []): EvaluateInput {
  const executor: Executor<string, undefined, JsonValue, JsonValue> = {
    executorId: 'test.abstention/v1', version: '1.0.0',
    schemas: { input: z.string(), output: JsonValueSchema, trace: JsonValueSchema },
    outputClassification: 'public', traceClassification: 'public',
    fingerprintFacets: { fixture: 'abstention/v1', outputs: cases.map((item) => item.output) },
    capabilities: { determinism: 'deterministic', seedControl: 'unsupported' },
    async execute(invocation) {
      seen.push(invocation);
      const output = cases[Number(invocation.input)]!.output;
      return { output, trace: output };
    },
  };
  return {
    dataset: { datasetId: 'abstention', samples: cases.map((item, i) => ({
      sampleId: `sample-${i}`, input: String(i), expected: item.expected,
    })) },
    variants: [{
      variantId: 'candidate', artifact: { kind: 'workflow', name: 'candidate', source: 'inline', content: 'Recommend IDs.' },
      execution: { executor },
    }],
    evaluators: [evaluator], comparisons: [],
    analyses: Object.values(evaluator.metricIds).map((metricId) => ({
      analysisId: metricId, analysisKind: 'summary', statistic: 'rate', variantId: 'candidate', metricId,
    })),
    experiment: { seed: 'abstention-tests', sampling: { samplingKind: 'solo' } },
    policy: { execution: { maxConcurrency: 1 }, evaluation: { maxConcurrency: 1 } },
  };
}

function observations(result: EvaluationResult) {
  return result.artifacts?.evaluation?.records.flatMap((record) => (
    record.evaluationStatus === 'completed' ? record.observations : []
  )) ?? [];
}

describe('built-in final-list abstention evaluator', () => {
  it('scores all four expected/actual combinations and keeps denominators separate', async () => {
    const seen: unknown[] = [];
    const result = await evaluate(input([
      { expected: { shouldAbstain: true }, output: { ids: [] } },
      { expected: { shouldAbstain: true }, output: { ids: ['unexpected'] } },
      { expected: { shouldAbstain: false }, output: { ids: [] } },
      { expected: { shouldAbstain: false }, output: { ids: ['good'] } },
    ], seen));
    expect(result.status).toBe('completed');
    for (const metricId of Object.values(evaluator.metricIds)) {
      expect(result.analysisResults[metricId]).toMatchObject({
        analysisStatus: 'completed', value: 0.5, coverage: { included: 2, missing: 2 },
      });
    }
    expect(observations(result).filter((item) => item.observationStatus === 'observed')).toHaveLength(4);
    expect(observations(result).filter((item) => item.observationStatus === 'missing')).toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ reasonCode: 'abstention-not-applicable' })),
    );
    expect(JSON.stringify(seen)).not.toContain('shouldAbstain');
    expect(result.definition.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ metricId: 'correct-abstention', direction: 'higher-is-better' }),
      expect.objectContaining({ metricId: 'false-abstention', direction: 'lower-is-better' }),
    ]));
  });

  it.each([null, '', [''], ['  '], [1], ['same', 'same'], {}].map((value) => [value]))('rejects malformed final lists: %j', async (ids) => {
    const result = await evaluate(input([{ expected: { shouldAbstain: true }, output: { ids } }]));
    expect(observations(result)).toEqual([
      expect.objectContaining({ observationStatus: 'invalid', reasonCode: 'abstention-ranking-invalid' }),
      expect.objectContaining({ observationStatus: 'invalid', reasonCode: 'abstention-ranking-invalid' }),
    ]);
    expect(result.analysisResults['correct-abstention'].coverage.included).toBe(0);
  });

  it.each([null, 'true', 1, []].map((value) => [value]))('does not infer an answerability label from %j', async (shouldAbstain) => {
    const result = await evaluate(input([{ expected: { shouldAbstain }, output: { ids: [] } }]));
    expect(observations(result).every((item) => item.observationStatus === 'invalid')).toBe(true);
    expect(result.analysisResults['correct-abstention'].coverage.included).toBe(0);
  });

  it('does not fabricate zero when no samples are applicable, or score missing bindings', async () => {
    const result = await evaluate(input([
      { expected: { shouldAbstain: false }, output: { ids: ['good'] } },
      { expected: { shouldAbstain: true }, output: {} },
    ]));
    expect(result.analysisResults['correct-abstention']).not.toMatchObject({ analysisStatus: 'completed' });
    expect(result.analysisResults['correct-abstention'].coverage.included).toBe(0);
    expect(result.analysisResults['false-abstention']).toMatchObject({ value: 0, coverage: { included: 1 } });
    await expect(prepareEvaluation(input([{ expected: {}, output: { ids: [] } }]))).rejects.toThrow();
  });

  it('supports explicit escaped pointers and trace bindings without inspecting business metadata', async () => {
    const base = input([{ expected: { 'should/abstain': true, reviewStatus: 'not-runtime-policy' }, output: { 'final~ids': [] } }]);
    const result = await evaluate({ ...base, evaluators: [{
      ...evaluator, ranking: { source: 'trace', pointer: '/final~0ids' }, shouldAbstainPointer: '/should~1abstain',
    }] });
    expect(result.analysisResults['correct-abstention']).toMatchObject({ value: 1, coverage: { included: 1 } });
  });

  it('seals config and instrument identity, with no data selection or second factory', async () => {
    const base = input([{ expected: { shouldAbstain: true }, output: { ids: [] } }]);
    const first = await prepareEvaluation(base);
    expect(first.definition.dataset).toMatchObject(base.dataset);
    const binding = createAbstentionEvaluatorBinding(evaluator);
    expect(first.definition.evaluators[0]).toEqual(binding.definition);
    expect(first.definition.evaluators[0]).toMatchObject({
      implementationId: 'omk.eval-runtime.abstention/v1',
      inputs: expect.arrayContaining([{ bindingId: 'execution-facts', sourceKind: 'execution-facts', pointer: '' }]),
    });
    for (const changed of [
      { ...evaluator, ranking: { source: 'trace' as const, pointer: '/ids' } },
      { ...evaluator, ranking: { source: 'output' as const, pointer: '/other' } },
      { ...evaluator, shouldAbstainPointer: '/other' },
      { ...evaluator, metricIds: { ...evaluator.metricIds, abstentionCorrect: 'other' } },
    ]) {
      expect(createAbstentionEvaluatorBinding(changed).port.identity.fingerprint).not.toBe(binding.port.identity.fingerprint);
    }
    expect((await prepareEvaluation(base)).planDigest).toBe(first.planDigest);
    const changed = await prepareEvaluation({ ...base, evaluators: [{ ...evaluator, ranking: { source: 'trace', pointer: '/ids' } }] });
    expect(changed.planDigest).not.toBe(first.planDigest);
  });

  it('rejects ambiguous config and duplicate coordinates before calling a target', async () => {
    const seen: unknown[] = [];
    const base = input([{ expected: true, output: [] }], seen);
    for (const declaration of [
      { ...evaluator, metricIds: { abstentionCorrect: 'same', falseAbstention: 'same' } },
      { ...evaluator, shouldAbstainPointer: 'invalid-pointer' },
      { ...evaluator, pendingPolicy: 'exclude' },
    ]) {
      await expect(prepareEvaluation({ ...base, evaluators: [declaration] })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    }
    await expect(prepareEvaluation({ ...base, evaluators: [evaluator, evaluator] })).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('supports multiple instruments without sharing configuration', async () => {
    const base = input([{ expected: { shouldAbstain: true }, output: { ids: [], other: ['answer'] } }]);
    const second: AbstentionEvaluator = {
      ...evaluator, evaluatorId: 'other', ranking: { source: 'output', pointer: '/other' },
      metricIds: { abstentionCorrect: 'other-correct', falseAbstention: 'other-false' },
    };
    const result = await evaluate({ ...base, evaluators: [evaluator, second], analyses: [...base.analyses, {
      analysisId: 'other-correct', analysisKind: 'summary', statistic: 'rate', variantId: 'candidate', metricId: 'other-correct',
    }] });
    expect(result.analysisResults['correct-abstention']).toMatchObject({ value: 1 });
    expect(result.analysisResults['other-correct']).toMatchObject({ value: 0 });
  });

  it('keeps failed traces out of the valid-response denominator', async () => {
    const base = input([
      { expected: { shouldAbstain: true }, output: { ids: [] } },
      { expected: { shouldAbstain: true }, output: { ids: [] } },
    ]);
    const executor: Executor<string, undefined, JsonValue, JsonValue> = {
      executorId: 'test.partial/v1', version: '1.0.0',
      capabilities: { determinism: 'deterministic', seedControl: 'unsupported' },
      schemas: { input: z.string(), output: JsonValueSchema, trace: JsonValueSchema },
      traceClassification: 'public', outputClassification: 'public',
      async execute({ input }) {
        return input === '0'
          ? { output: { ids: [] }, trace: { ids: [] } }
          : { errorCode: 'provider-failed' };
      },
    };
    const result = await evaluate({ ...base,
      evaluators: [{ ...evaluator, ranking: { source: 'trace', pointer: '/ids' } }],
      variants: [{ ...base.variants[0]!, execution: { executor } }],
    });
    expect(result.analysisResults['correct-abstention']).toMatchObject({
      value: 1, coverage: { included: 1, sourceUnavailable: 1 },
    });
    expect(result.artifacts?.execution?.coverage).toMatchObject({ succeeded: 1, failed: 1 });
    // The facade does not accept failure outputs. Also probe the port with a retained empty trace,
    // as supplied by an advanced host, to exercise the instrument's own terminal guard.
    const failed = result.artifacts!.execution!.records.find((record) => record.executionStatus === 'failed')!;
    const binding = createAbstentionEvaluatorBinding({ ...evaluator, ranking: { source: 'trace', pointer: '/ids' } });
    const digest = digestCanonicalJson({ fixture: 'failed-trace' });
    const run = await binding.port.openRun({ runId: 'failed-trace', evaluationPlanDigest: digest });
    try {
      const record = await run.openRecord({
        targetId: 'candidate', sampleId: 'sample-1', trialIndex: 0, trialId: digest,
        evaluatorId: evaluator.evaluatorId, measurement: binding.definition.measurement,
        evaluationId: digest, metrics: binding.metrics,
        bindings: [
          { bindingId: 'ranking', sourceKind: 'trace', value: [], classification: 'public' },
          { bindingId: 'should-abstain', sourceKind: 'expected', value: true, classification: 'gold' },
          { bindingId: 'execution-facts', sourceKind: 'execution-facts', ...projectExecutionFacts(failed, failed.provenance.trust) },
        ],
      });
      try {
        const scored = await record.evaluate({ attemptId: digest, attemptNumber: 1, signal: new AbortController().signal });
        expect(scored.observations).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
          observationStatus: 'missing', reasonCode: 'abstention-execution-not-completed',
        })));
      } finally { await record.dispose(); }
    } finally { await run.dispose(); }
  });

  it.each(['throw', 'failure', 'timeout'] as const)('does not turn %s into successful abstention', async (mode) => {
    const base = input([{ expected: { shouldAbstain: true }, output: { ids: [] } }]);
    let aborted = false;
    const executor: Executor<string, undefined, JsonValue> = {
      executorId: 'test.failure/v1', version: '1.0.0',
      capabilities: { determinism: 'deterministic', seedControl: 'unsupported' },
      schemas: { input: z.string(), output: JsonValueSchema },
      async execute({ signal }) {
        if (mode === 'throw') throw new Error('private provider details');
        if (mode === 'failure') return { errorCode: 'provider-failed' };
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { aborted = true; reject(signal.reason); };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
        return { output: { ids: [] } };
      },
    };
    const result = await evaluate({
      ...base, variants: [{ ...base.variants[0]!, execution: { executor } }],
      policy: { ...base.policy, execution: { maxConcurrency: 1, timeoutMs: 5 } },
    });
    expect(result.artifacts?.execution?.records[0]).toMatchObject({ executionStatus: 'failed' });
    expect(result.analysisResults['correct-abstention'].coverage.included).toBe(0);
    expect(JSON.stringify(result.artifacts?.evaluation)).not.toContain('private provider details');
    if (mode === 'timeout') expect(aborted).toBe(true);
  });
});
