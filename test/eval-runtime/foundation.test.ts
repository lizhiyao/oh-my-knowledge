import { describe, expect, it } from 'vitest';
import { createEvaluationEngine } from '../../src/eval-core/index.js';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createExecutorFnAdapter,
  createInvokeExecutorIdentity,
  createMeasurementPolicy,
  type ExecResult,
} from '../../src/eval-runtime/index.js';

function result(output: string): ExecResult {
  return {
    ok: true,
    output,
    durationMs: 1,
    durationApiMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokenUsageReportedByExecutor: true,
    costUSD: 0,
    costReportedByExecutor: false,
    stopReason: 'completed',
    numTurns: 1,
  };
}

function executorIdentity() {
  return createInvokeExecutorIdentity({
    implementationId: 'test.faas-function/v1',
    version: '1.0.0',
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'required' },
    fingerprintFacets: { deployment: 'test-revision-1' },
  });
}

describe('eval-runtime foundation', () => {
  it('runs a deterministic paired comparison through only public host primitives', async () => {
    const seenSignals: AbortSignal[] = [];
    const identity = executorIdentity();
    const createExecutor = () => createExecutorFnAdapter({
      identity,
      outputClassification: 'public',
      mapInput: (trial) => ({
        model: trial.targetId,
        prompt: String((trial.input as { prompt: string }).prompt),
      }),
      executor: async (input) => {
        expect(input.abortSignal).toBeInstanceOf(AbortSignal);
        seenSignals.push(input.abortSignal!);
        const answers: Record<string, Record<string, string>> = {
          control: { one: 'A', two: 'wrong', three: 'wrong' },
          treatment: { one: 'A', two: 'B', three: 'C' },
        };
        return result(answers[input.model][input.prompt]);
      },
    });
    const runtime = createEvaluationRuntime({
      executors: [{ implementationId: identity.implementationId, createPort: createExecutor }],
      evaluators: [{ port: createExactMatchEvaluator() }],
    });
    const definition = createExactMatchDefinition({
      datasetId: 'faas-evaluation',
      seed: 'explicit-seed-1',
      samples: [
        { sampleId: 'one', input: { prompt: 'one' }, expected: 'A' },
        { sampleId: 'two', input: { prompt: 'two' }, expected: 'B' },
        { sampleId: 'three', input: { prompt: 'three' }, expected: 'C' },
      ],
      control: { targetId: 'control', executorId: 'test.faas-function/v1' },
      treatment: { targetId: 'treatment', executorId: 'test.faas-function/v1' },
      bootstrap: { resamples: 100, alpha: 0.1 },
    });
    const policy = createMeasurementPolicy({ maxConcurrency: 2 });
    const engine = createEvaluationEngine(runtime);
    const [first, second] = await Promise.all([
      engine.prepare(definition, policy),
      engine.prepare(structuredClone(definition), structuredClone(policy)),
    ]);
    expect(second.plan.digests.runContractDigest).toBe(first.plan.digests.runContractDigest);

    const run = first.start({ runId: 'faas-run', eventBufferCapacity: 128 });
    const consuming = (async () => {
      for await (const event of run.events) void event;
    })();
    const completed = await run.result;
    await consuming;

    expect(completed.status, JSON.stringify(completed)).toBe('completed');
    if (completed.status !== 'completed') return;
    expect(completed.artifacts.execution.records).toHaveLength(6);
    expect(completed.artifacts.evaluation.records).toHaveLength(6);
    expect(completed.artifacts.analysis.records[0]).toMatchObject({
      analysisStatus: 'completed',
      resultType: 'interval',
      value: { estimate: 2 / 3, resamples: 100, unitCount: 3 },
    });
    expect(completed.artifacts.decision?.decisionStatus).toBe('decided');
    expect(completed.report.bundles).toHaveLength(3);
    expect(seenSignals).toHaveLength(6);
  });

  it('seals builder defaults into immutable serializable contracts', () => {
    const definition = createExactMatchDefinition({
      datasetId: 'dataset',
      seed: 'seed',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'one' },
        { sampleId: 'two', input: 'two', expected: 'two' },
      ],
      control: { targetId: 'control', executorId: 'executor/v1' },
      treatment: { targetId: 'treatment', executorId: 'executor/v1' },
    });
    const policy = createMeasurementPolicy();

    expect(JSON.parse(JSON.stringify(definition))).toEqual(definition);
    expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.experiment.sampling)).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(definition.experiment.seed).toBe('seed');
    expect(definition.experiment.sampling).toMatchObject({
      estimatorId: 'bootstrap.paired-difference-percentile/v1',
      resamplingUnit: 'paired-block',
      seedCoupling: 'shared-within-block',
    });
  });

  it('maps an ExecutorFn failure into a stable Core execution error', async () => {
    const identity = executorIdentity();
    const runtime = createEvaluationRuntime({
      executors: [{
        implementationId: identity.implementationId,
        createPort: () => createExecutorFnAdapter({
          identity,
          outputClassification: 'public',
          mapInput: ({ targetId, input }) => ({ model: targetId, prompt: String(input) }),
          executor: async ({ model }) => model === 'treatment'
            ? { ...result(''), ok: false, output: null, error: 'provider secret' }
            : {
                ...result('expected'),
                tokenUsageReportedByExecutor: false,
                costReportedByExecutor: false,
              },
        }),
      }],
      evaluators: [{ port: createExactMatchEvaluator() }],
    });
    const definition = createExactMatchDefinition({
      datasetId: 'failure-mapping',
      seed: 'failure-seed',
      samples: [
        { sampleId: 'one', input: 'one', expected: 'expected' },
        { sampleId: 'two', input: 'two', expected: 'expected' },
      ],
      control: { targetId: 'control', executorId: identity.implementationId },
      treatment: { targetId: 'treatment', executorId: identity.implementationId },
    });
    const run = createEvaluationEngine(runtime).start(definition, {
      policy: createMeasurementPolicy(),
      runId: 'failure-run',
      eventBufferCapacity: 128,
    });
    const draining = (async () => {
      for await (const event of run.events) void event;
    })();
    const completed = await run.result;
    await draining;

    expect(completed.status).toBe('completed');
    if (completed.status !== 'completed') return;
    const failures = completed.artifacts.execution.records.filter(
      (record) => record.executionStatus === 'failed',
    );
    expect(failures).toHaveLength(4);
    expect(failures.map((record) => record.error.code).sort()).toEqual([
      'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION',
      'EVAL_RUNTIME_EXECUTOR_CONTRACT_VIOLATION',
      'EVAL_RUNTIME_EXECUTOR_FAILED',
      'EVAL_RUNTIME_EXECUTOR_FAILED',
    ].sort());
    expect(JSON.stringify(failures)).not.toContain('provider secret');
  });
});
