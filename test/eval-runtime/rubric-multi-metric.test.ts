import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluate, prepareEvaluation,
  type EvaluateInput, type Executor, type Judge, type RubricJudgeEvaluator,
} from '../../src/eval-runtime/index.js';

const ids = ['correctness', 'completeness', 'clarity', 'relevance', 'safety'];
const executor: Executor<string, undefined, string> = {
  executorId: 'test.multi-rubric-target', version: '1.0.0',
  schemas: { input: z.string(), output: z.string() }, outputClassification: 'public',
  capabilities: { determinism: 'deterministic', cancellation: 'cooperative', concurrency: { safety: 'parallel-safe' }, seedControl: 'unsupported', telemetry: { trace: 'unsupported', usage: 'optional' } },
  fingerprintFacets: { revision: 1 }, execute: async ({ input }) => ({ output: input }),
};
function scores(value = 4) {
  return { scores: ids.map((metricId) => ({ metricId, score: value, reason: `${metricId} evidence` })) };
}
function input(invoke: Judge['invoke'], count = 1): EvaluateInput {
  return {
    dataset: { datasetId: 'multi-rubric', samples: Array.from({ length: count }, (_, i) => ({ sampleId: `sample-${i}`, input: 'an answer' })) },
    variants: [{ variantId: 'candidate', artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null }, execution: { executor } }],
    evaluators: [{
      evaluatorKind: 'rubric-judge', evaluatorId: 'quality',
      rubrics: ids.map((metricId) => ({ metricId, criterionId: metricId, prompt: 'Answer the question.', rubric: `Score ${metricId} independently.` })),
      judges: [{ memberId: 'primary', model: 'fixture-model', judge: { judgeId: 'test.multi-rubric-provider', version: '1.0.0', providerCost: { reporting: 'optional' }, invoke } }],
      aggregation: { method: 'mean', missing: 'require-complete' },
    }],
    comparisons: [],
    analyses: ids.map((metricId) => ({ analysisId: metricId, analysisKind: 'summary', statistic: 'mean', variantId: 'candidate', metricId })),
    experiment: { seed: 'joint-seed', sampling: { samplingKind: 'solo' } },
    policy: { evaluation: { maxConcurrency: 8 } },
  };
}

describe('multi-dimension Rubric Judge', () => {
  it('rejects old declarations and ambiguous dimensions before any invocation', async () => {
    const invoke = vi.fn<Judge['invoke']>();
    const declaration = input(invoke);
    const panel = declaration.evaluators[0] as RubricJudgeEvaluator;
    const { rubrics, ...rest } = panel;
    for (const invalid of [
      { ...rest, metricId: ids[0], rubric: rubrics[0] },
      { ...panel, rubrics: [] },
      { ...panel, rubrics: [...rubrics, rubrics[0]] },
      { ...panel, rubrics: rubrics.map((r) => ({ ...r, criterionId: 'duplicate' })) },
      { ...panel, rubrics: [{ ...rubrics[0], schemaVersion: 'omk.rubric-judge-context/v1' }] },
    ]) {
      await expect(prepareEvaluation({ ...declaration, evaluators: [invalid as RubricJudgeEvaluator] }))
        .rejects.toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID' });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('makes 63 joint calls for 315 observations with concurrency and usage owned by each call', async () => {
    let active = 0;
    let maximum = 0;
    const invoke = vi.fn<Judge['invoke']>(async (request) => {
      expect(request.prompt).toContain('v6-multi');
      for (const id of ids) expect(request.prompt).toContain(`"metricId":"${id}"`);
      active += 1; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return { invocationStatus: 'completed', output: JSON.stringify(scores()), usage: { totalTokens: 7 } };
    });
    const declaration = input(invoke, 63);
    const prepared = await prepareEvaluation({ ...declaration, policy: { ...declaration.policy, budget: { run: { maxInvocations: 126 } } } });
    expect(prepared.estimatedWork.plannedInvocations).toBe(126);
    expect(invoke).not.toHaveBeenCalled();
    const run = await prepared.run();
    expect(run.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(63);
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(8);
    const records = run.artifacts?.evaluation?.records ?? [];
    expect(records).toHaveLength(63);
    expect(records.flatMap((r) => r.evaluationStatus === 'completed' ? r.observations : [])).toHaveLength(315);
    expect(records.every((r) => r.evaluationStatus === 'completed' && r.usage?.totalTokens === 7)).toBe(true);
    for (const id of ids) expect(run.analysisResults[id]).toMatchObject({ analysisStatus: 'completed', value: 4, coverage: { included: 63 } });
  });

  it('keeps panel member weights, replicate counts and each metric summary independent', async () => {
    const invoke = vi.fn<Judge['invoke']>(async ({ model }) => ({ invocationStatus: 'completed', output: JSON.stringify(scores(model === 'a' ? 1 : 5)) }));
    const declaration = input(invoke, 2), panel = declaration.evaluators[0] as RubricJudgeEvaluator;
    const run = await evaluate({ ...declaration, evaluators: [{ ...panel, judges: [
      { ...panel.judges[0], memberId: 'a', model: 'a', replicateCount: 2 },
      { ...panel.judges[0], memberId: 'b', model: 'b' },
    ], aggregation: { method: 'weighted-mean', missing: 'require-complete', weights: { a: 0.75, b: 0.25 } } }] });
    expect(invoke).toHaveBeenCalledTimes(6);
    for (const id of ids) expect(run.analysisResults[id]).toMatchObject({ analysisStatus: 'completed', value: 2, coverage: { included: 6 } });
  });

  it('invalidates only a malformed reading, and fails closed for missing, duplicate or unknown metric IDs', async () => {
    const partial = scores(); partial.scores[0].score = 6;
    const run = await evaluate(input(async () => ({ invocationStatus: 'completed', output: JSON.stringify(partial), usage: { totalTokens: 3 } })));
    expect(run.analysisResults.correctness.coverage).toMatchObject({ included: 0, invalid: 1 });
    expect(run.analysisResults.completeness).toMatchObject({ value: 4, coverage: { included: 1 } });
    for (const readings of [scores().scores.slice(1), [...scores().scores, scores().scores[0]], scores().scores.map((r, i) => i === 0 ? { ...r, metricId: 'unknown' } : r)]) {
      const malformed = await evaluate(input(async () => ({ invocationStatus: 'completed', output: JSON.stringify({ scores: readings }), usage: { totalTokens: 3 } })));
      const record = malformed.artifacts?.evaluation?.records[0];
      expect(record).toMatchObject({ evaluationStatus: 'completed', usage: { totalTokens: 3 } });
      if (record?.evaluationStatus !== 'completed') throw new Error('expected invalid measurements');
      expect(record.observations).toHaveLength(5);
      expect(record.observations.every((o) => o.observationStatus === 'invalid' && o.reasonCode === 'judge-response-metric-set-invalid')).toBe(true);
    }
  });

  it('retries the whole group, retains failed usage once, and cancels one shared invocation', async () => {
    let calls = 0;
    const declaration = input(async () => ++calls === 1
      ? { invocationStatus: 'failed', reasonCode: 'private-provider-reason', usage: { totalTokens: 2 } }
      : { invocationStatus: 'completed', output: JSON.stringify(scores()), usage: { totalTokens: 7 } });
    const run = await evaluate({ ...declaration, policy: { evaluation: { retry: { maxAttempts: 2, retryableErrorCodes: ['judge-provider-failure'], backoff: { backoffKind: 'none' } } } } });
    expect(calls).toBe(2);
    expect(run.artifacts?.evaluation?.records[0]).toMatchObject({ evaluationStatus: 'completed', usage: { totalTokens: 9 } });
    expect(JSON.stringify(run)).not.toContain('private-provider-reason');
    let aborted = false;
    const slow = input(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { aborted = true; reject(signal.reason); };
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      return { invocationStatus: 'completed', output: JSON.stringify(scores()) };
    });
    const cancelled = await evaluate({ ...slow, policy: { evaluation: { timeoutMs: 10 } } });
    expect(aborted).toBe(true);
    expect(cancelled.artifacts?.evaluation?.records[0]).toMatchObject({ evaluationStatus: 'failed', error: { code: 'timeout' } });
  });
});
