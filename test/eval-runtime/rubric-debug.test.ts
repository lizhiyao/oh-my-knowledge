import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  debugEvaluator, evaluate, prepareEvaluation, EvaluationConfigurationError,
  type DebugEvaluatorInput, type DebugJudgeInvocation, type DebugJudgeResponse, type DebugRubricReading,
  type EvaluateInput, type Judge, type Executor, type RubricJudgeEvaluator,
} from '../../src/eval-runtime/index.js';

const clock = { timestamp: () => '2026-09-15T00:00:00.000Z', monotonicNow: () => 0, sleep: async () => {} };
const executor: Executor<string, undefined, string> = {
  executorId: 'test.debug-target', version: '1', schemas: { input: z.string(), output: z.string() },
  outputClassification: 'public', fingerprintFacets: { revision: 1 },
  capabilities: { determinism: 'deterministic', cancellation: 'cooperative', concurrency: { safety: 'parallel-safe' }, seedControl: 'unsupported', telemetry: { trace: 'unsupported', usage: 'optional' } },
  execute: async ({ input }) => ({ output: input }),
};
const sample = { sampleId: 'one', input: 'Paris.' };
const variant: DebugEvaluatorInput['variant'] = { variantId: 'candidate', artifact: { name: 'baseline', kind: 'baseline', source: 'baseline', content: null }, execution: { executor } };
function panel(invoke: Judge['invoke']): RubricJudgeEvaluator {
  return {
    evaluatorKind: 'rubric-judge', evaluatorId: 'quality',
    rubrics: ['accuracy', 'clarity'].map((metricId) => ({ metricId, criterionId: metricId, prompt: 'Say Paris.', rubric: `Score ${metricId}.` })),
    judges: [{ memberId: 'primary', model: 'fixture', judge: { judgeId: 'fixture.judge', version: '1', providerCost: { reporting: 'optional' }, invoke } }],
    aggregation: { method: 'mean', missing: 'require-complete' },
  };
}
function direct(evaluator: RubricJudgeEvaluator): EvaluateInput {
  return { dataset: { datasetId: 'omk-debug-evaluator', samples: [sample] }, variants: [variant], evaluators: [evaluator], comparisons: [], analyses: [], experiment: { seed: 'omk-debug-evaluator', sampling: { samplingKind: 'solo' } }, policy: {} };
}
const output = JSON.stringify({ scores: [
  { metricId: 'clarity', score: 5, reason: 'Clear.', providerPrivate: 'raw-only-secret' },
  { metricId: 'accuracy', score: 4, reason: 'Correct.', reasoning: 'Matches the criterion.' },
] });

describe('Rubric single-sample debugging', () => {
  it('preserves the exact canonical run and captured Judge receiver, with raw diagnostics only in memory', async () => {
    const invoke: Judge['invoke'] = async function (this: Judge) {
      expect(this.invoke).toBe(invoke);
      expect(Object.isFrozen(this)).toBe(true);
      expect(this.version).toBe('1');
      return { invocationStatus: 'completed', output, usage: { totalTokens: 7 } };
    };
    const evaluator = panel(invoke);
    Object.defineProperty(evaluator.judges[0].judge, 'private-extra', { enumerable: true, get() { throw new Error('must not inspect provider-private properties'); } });
    const options = { runId: 'same-run', clock };
    const normal = await evaluate(direct(evaluator), options);
    const events: unknown[] = [];
    const pending = debugEvaluator({ evaluator, sample, variant }, { ...options, onEvent: (event) => { events.push(event); } });
    (evaluator.judges[0].judge as { version: string }).version = 'changed';
    const debug = await pending;
    expect(debug.run).toEqual(normal);
    expect(debug.bindingInputs).toEqual([]);
    const invocation: DebugJudgeInvocation = debug.judgeInvocations[0];
    const response: DebugJudgeResponse = invocation.response;
    expect(invocation).toMatchObject({ invocationIndex: 0, memberId: 'primary', request: { promptId: 'rubric-judge-debias-on' }, response: { responseStatus: 'completed', output, usage: { totalTokens: 7 } } });
    expect(invocation.request.prompt).toContain('Paris.');
    expect(invocation.request).not.toHaveProperty('signal');
    if (response.responseStatus !== 'completed') throw new Error('expected completed response');
    const readings: readonly DebugRubricReading[] = response.readings;
    expect(readings).toEqual([
      { metricId: 'accuracy', observationStatus: 'observed', value: 4, reason: 'Correct.', reasoning: 'Matches the criterion.' },
      { metricId: 'clarity', observationStatus: 'observed', value: 5, reason: 'Clear.' },
    ]);
    expect(Object.isFrozen(readings[0])).toBe(true);
    expect(Object.isFrozen(debug.judgeInvocations)).toBe(true);
    expect(JSON.stringify(debug.run)).not.toContain('raw-only-secret');
    expect(JSON.stringify(events)).not.toContain('raw-only-secret');
  });

  it('uses the production decoder for missing, duplicate, unknown and individually invalid scores', async () => {
    const valid = JSON.parse(output).scores;
    const responses = [
      'plain response', '{malformed',
      JSON.stringify({ scores: valid.slice(1) }),
      JSON.stringify({ scores: [...valid, valid[0]] }),
      JSON.stringify({ scores: [{ ...valid[0], metricId: 'unknown' }, valid[1]] }),
      JSON.stringify({ scores: [{ ...valid[0], score: 6 }, valid[1]] }),
    ];
    for (const raw of responses) {
      const debug = await debugEvaluator({ evaluator: panel(async () => ({ invocationStatus: 'completed', output: raw })), sample, variant });
      const response = debug.judgeInvocations[0].response;
      const record = debug.run.artifacts?.evaluation?.records[0];
      if (response.responseStatus !== 'completed' || record?.evaluationStatus !== 'completed') throw new Error('expected completed measurement');
      expect(record.observations.map((observation) => ({ metricId: observation.metricId, observationStatus: observation.observationStatus, ...('reasonCode' in observation ? { reasonCode: observation.reasonCode } : { value: observation.value }) })))
        .toEqual(response.readings.map((reading) => ({ metricId: reading.metricId, observationStatus: reading.observationStatus, ...(reading.observationStatus === 'invalid' ? { reasonCode: reading.reasonCode } : { value: reading.value }) })));
    }
  });

  it('retains per-call retry accounting, distinguishes provider failures and skips uninvoked work', async () => {
    const receivers: Judge[] = [];
    const invoke = vi.fn<Judge['invoke']>(async function (this: Judge) {
      receivers.push(this);
      return receivers.length === 1
        ? { invocationStatus: 'failed', reasonCode: 'private-provider-failure', usage: { totalTokens: 2, details: { secret: 'private-usage' } } }
        : { invocationStatus: 'completed', output, usage: { totalTokens: 7 } };
    });
    const debug = await debugEvaluator({ evaluator: panel(invoke), sample, variant, policy: { evaluation: { retry: { maxAttempts: 2, retryableErrorCodes: ['judge-provider-failure'], backoff: { backoffKind: 'none' } } } } });
    expect(debug.judgeInvocations.map((call) => call.response)).toMatchObject([{ responseStatus: 'provider-failed', usage: { totalTokens: 2 } }, { responseStatus: 'completed', usage: { totalTokens: 7 } }]);
    expect(debug.run.artifacts?.evaluation?.records[0]).toMatchObject({ usage: { totalTokens: 9 } });
    expect(receivers).toHaveLength(2);
    expect(receivers[1]).toBe(receivers[0]);
    expect(JSON.stringify(debug)).not.toContain('private-provider-failure');
    expect(JSON.stringify(debug)).not.toContain('private-usage');
    const thrown = await debugEvaluator({ evaluator: panel(async () => { throw new Error('private-exception'); }), sample, variant });
    expect(thrown.judgeInvocations[0].response.responseStatus).toBe('threw');
    expect(JSON.stringify(thrown)).not.toContain('private-exception');
    const malformed = await debugEvaluator({ evaluator: panel(async () => ({ invocationStatus: 'completed', output: 3 }) as never), sample, variant });
    expect(malformed.judgeInvocations[0].response.responseStatus).toBe('invalid-response');
    const budgeted = await debugEvaluator({ evaluator: panel(invoke), sample, variant, policy: { budget: { run: { maxInvocations: 1 } } } });
    expect(budgeted.judgeInvocations).toEqual([]);
  });

  it('isolates simultaneous debug calls and keeps invocation start order across replicates', async () => {
    const evaluator = panel(async (request) => {
      await new Promise<void>((resolve) => setTimeout(resolve, request.model === 'slow' ? 10 : 1));
      return { invocationStatus: 'completed', output };
    });
    const run = () => debugEvaluator({ evaluator: { ...evaluator, judges: [
      { ...evaluator.judges[0], model: 'slow', replicateCount: 2 },
      { ...evaluator.judges[0], memberId: 'second', model: 'fast' },
    ] }, sample, variant });
    const results = await Promise.all([run(), run()]);
    for (const result of results) {
      expect(result.judgeInvocations.map((call) => call.invocationIndex)).toEqual([0, 1, 2]);
      expect(result.judgeInvocations.filter((call) => call.memberId === 'primary')).toHaveLength(2);
      expect(result.judgeInvocations.every((call) => call.response.responseStatus === 'completed')).toBe(true);
    }
    expect(results[0].judgeInvocations).not.toBe(results[1].judgeInvocations);
  });

  it('records cancellation without retaining a late provider response', async () => {
    const debug = await debugEvaluator({ evaluator: panel(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return { invocationStatus: 'completed', output: 'late-private-response' };
    }), sample, variant, policy: { evaluation: { timeoutMs: 10 } } });
    expect(debug.judgeInvocations[0].response.responseStatus).toBe('cancelled');
    expect(debug.run.artifacts?.evaluation?.records[0]).toMatchObject({ evaluationStatus: 'failed', error: { code: 'timeout' } });
    const snapshot = JSON.stringify(debug);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(JSON.stringify(debug)).toBe(snapshot);
    expect(snapshot).not.toContain('late-private-response');
  });

  it('reports field paths before model calls without revealing rejected data', async () => {
    const invoke = vi.fn<Judge['invoke']>();
    const evaluator = panel(invoke);
    const hostileJudge = { ...evaluator.judges[0].judge };
    Object.defineProperty(hostileJudge, 'version', { get() {
      throw new EvaluationConfigurationError('EVAL_RUNTIME_EVALUATOR_INVALID', 'private-host-exception', undefined, [{ path: ['private-host-path'], reasonCode: 'invalid-value' }]);
    } });
    const cases: Array<[unknown, (string | number)[]]> = [
      [{ ...evaluator, judges: [{ ...evaluator.judges[0], judge: hostileJudge }] }, ['judges', 0, 'judge', 'version']],
      [{ ...evaluator, rubrics: [evaluator.rubrics[0], { ...evaluator.rubrics[1], metricId: 'private secret'.repeat(30) }] }, ['rubrics', 1, 'metricId']],
      [{ ...evaluator, rubrics: [evaluator.rubrics[0], evaluator.rubrics[0]] }, ['rubrics', 1, 'metricId']],
      [{ ...evaluator, rubrics: [{ ...evaluator.rubrics[0], 'private-key': true }] }, ['rubrics', 0]],
      [{ ...evaluator, judges: [{ ...evaluator.judges[0], model: '' }] }, ['judges', 0, 'model']],
      [{ ...evaluator, judges: [evaluator.judges[0], evaluator.judges[0]] }, ['judges', 1, 'memberId']],
      [{ ...evaluator, judges: [{ ...evaluator.judges[0], judge: { ...evaluator.judges[0].judge, invoke: null } }] }, ['judges', 0, 'judge', 'invoke']],
      [{ ...evaluator, aggregation: { method: 'weighted-mean', missing: 'require-complete', weights: { 'private-key': 1 } } }, ['aggregation', 'weights']],
      [{ ...evaluator, actualPointer: 'private-pointer' }, ['actualPointer']],
    ];
    for (const [invalid, path] of cases) {
      for (const action of [
        () => debugEvaluator({ evaluator: invalid as RubricJudgeEvaluator, sample, variant }),
        () => prepareEvaluation(direct(invalid as RubricJudgeEvaluator)),
      ]) {
        let failure: unknown;
        try { await action(); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: 'EVAL_RUNTIME_EVALUATOR_INVALID', issues: [{ path: ['evaluators', 0, ...path] }] });
        expect(String(failure)).not.toContain('private-host');
        expect(JSON.stringify(failure)).not.toMatch(/private secret|private-key|private-pointer|private-host/);
      }
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
