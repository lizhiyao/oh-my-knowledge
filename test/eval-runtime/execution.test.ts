import { describe, expect, it, vi } from 'vitest';
import { createEvaluationExecution, EvaluationRuntimeLifecycleError, type EvaluationRunLease } from '../../src/eval-runtime/execution.js';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createMeasurementPolicy,
  runEvaluation,
} from '../../src/eval-runtime/advanced.js';
import {
  createExecutorFnAdapter,
  type ExecResult,
} from '../../src/eval-runtime/advanced.js';

function executionResult(output: string): ExecResult {
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

function fixture() {
  const identity = createInvokeExecutorIdentity({
    implementationId: 'test.runner/v1',
    version: '1.0.0',
    determinism: 'deterministic',
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    seedControl: 'unsupported',
    telemetry: { trace: 'unsupported', usage: 'required' },
    fingerprintFacets: { revision: 'runner-test' },
  });
  const createExecutor = () => createExecutorFnAdapter({
    identity,
    outputClassification: 'public',
    mapInput: ({ input }) => ({ model: 'fixture', prompt: String(input) }),
    executor: async ({ prompt, abortSignal }) => {
      abortSignal?.throwIfAborted();
      return executionResult(prompt);
    },
  });
  const runtime = () => createEvaluationRuntime({
    executors: [{ implementationId: identity.implementationId, createPort: createExecutor }],
    evaluators: [{ port: createExactMatchEvaluator() }],
    clock: {
      monotonicNow: () => 1,
      timestamp: () => '2026-09-04T00:00:00.000Z',
      sleep: () => Promise.resolve(),
    },
  });
  const definition = createExactMatchDefinition({
    datasetId: 'runner-dataset',
    seed: 'runner-seed',
    samples: [
      { sampleId: 'one', input: 'one', expected: 'one' },
      { sampleId: 'two', input: 'two', expected: 'two' },
    ],
    control: { targetId: 'control', executorId: identity.implementationId },
    treatment: { targetId: 'treatment', executorId: identity.implementationId },
    bootstrap: { resamples: 100 },
  });
  return {
    runtime,
    definition,
    policy: createMeasurementPolicy({
      execution: { maxConcurrency: 1 },
      evaluation: { maxConcurrency: 1 },
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Runtime execution lifecycle', () => {
  it('preserves the Core measurement and releases resources after the completed run', async () => {
    const { runtime, definition, policy } = fixture();
    const baseline = await runEvaluation({ runtime: runtime(), definition, policy, runId: 'same-run' });
    const close = vi.fn();
    const activate = vi.fn();
    const execution = createEvaluationExecution({
      runtime: runtime(),
      async acquireRun(request) {
        expect(request.plan).toBe(prepared.plan);
        expect(request.signal.aborted).toBe(false);
        return { activate, close };
      },
    });
    const prepared = await execution.prepare({ definition, policy });
    const run = await prepared.start({ runId: 'same-run' });
    expect(await run.result).toEqual(baseline);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('retains the complete Core result when cleanup fails', async () => {
    const { runtime, definition, policy } = fixture();
    const baseline = await runEvaluation({ runtime: runtime(), definition, policy, runId: 'cleanup' });
    const cleanupFailure = new Error('cleanup');
    const close = vi.fn(() => { throw cleanupFailure; });
    const prepared = await createEvaluationExecution({
      runtime: runtime(), acquireRun: async () => ({ close }),
    }).prepare({ definition, policy });
    const run = await prepared.start({ runId: 'cleanup' });
    const error = await run.result.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvaluationRuntimeLifecycleError);
    expect(error).toMatchObject({
      code: 'EVAL_RUNTIME_RUN_CLEANUP_FAILED', runResult: baseline, cause: cleanupFailure,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('cancels acquisition promptly, closes a late lease, and reserves its runId until cleanup', async () => {
    const { runtime, definition, policy } = fixture();
    const acquired = deferred<EvaluationRunLease>();
    const entered = deferred<AbortSignal>();
    const controller = new AbortController();
    const close = vi.fn();
    const activate = vi.fn();
    const prepared = await createEvaluationExecution({
      runtime: runtime(),
      async acquireRun(request) { entered.resolve(request.signal); return acquired.promise; },
    }).prepare({ definition, policy });
    const start = prepared.start({ runId: 'late', signal: controller.signal });
    const hostSignal = await entered.promise;
    controller.abort('cancel acquisition');
    const failure: unknown = await start.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EvaluationRuntimeLifecycleError);
    const error = failure as EvaluationRuntimeLifecycleError;
    expect(error.code).toBe('EVAL_RUNTIME_RUN_ABORTED_BEFORE_START');
    expect(hostSignal.aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await expect(prepared.start({ runId: 'late' })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RUN_ACTIVE' });
    acquired.resolve({ activate, close });
    await error.cleanup;
    expect(close).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
  });

  it('exposes late cleanup failure through the cancellation outcome', async () => {
    const { runtime, definition, policy } = fixture();
    const acquired = deferred<EvaluationRunLease>();
    const entered = deferred<void>();
    const controller = new AbortController();
    const prepared = await createEvaluationExecution({
      runtime: runtime(),
      async acquireRun() { entered.resolve(); return acquired.promise; },
    }).prepare({ definition, policy });
    const start = prepared.start({ runId: 'late-cleanup', signal: controller.signal });
    await entered.promise;
    controller.abort();
    const error = await start.catch((cause: unknown) => cause) as EvaluationRuntimeLifecycleError;
    const close = vi.fn(() => { throw new Error('late cleanup'); });
    acquired.resolve({ close });
    await expect(error.cleanup).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RUN_CLEANUP_FAILED' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releases resources on failed activation without starting Core', async () => {
    const { runtime, definition, policy } = fixture();
    const close = vi.fn();
    const failure = new Error('activation');
    const prepared = await createEvaluationExecution({
      runtime: runtime(),
      acquireRun: async () => ({ close, activate() { throw failure; } }),
    }).prepare({ definition, policy });
    await expect(prepared.start({ runId: 'activate' })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed lease ports after capturing their cleanup', async () => {
    const { runtime, definition, policy } = fixture();
    const close = vi.fn();
    const prepared = await createEvaluationExecution({
      runtime: runtime(),
      acquireRun: async () => ({ close, activate: 'invalid' } as unknown as EvaluationRunLease),
    }).prepare({ definition, policy });
    await expect(prepared.start({ runId: 'invalid' })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_RUN_LEASE_INVALID' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not acquire resources for an already cancelled run', async () => {
    const { runtime, definition, policy } = fixture();
    const acquireRun = vi.fn(async () => ({ close() {} }));
    const controller = new AbortController();
    controller.abort();
    const prepared = await createEvaluationExecution({ runtime: runtime(), acquireRun }).prepare({ definition, policy });
    const error = await prepared.start({ runId: 'cancelled', signal: controller.signal })
      .catch((cause: unknown) => cause) as EvaluationRuntimeLifecycleError;
    expect(error.code).toBe('EVAL_RUNTIME_RUN_ABORTED_BEFORE_START');
    await error.cleanup;
    expect(acquireRun).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'failed'] as const)('releases resources after Core returns %s', async (expectedStatus) => {
    const { runtime, definition } = fixture();
    const controller = new AbortController();
    const close = vi.fn();
    const prepared = await createEvaluationExecution({
      runtime: runtime(),
      acquireRun: async () => ({
        close,
        eventWriter: {
          async write() {
            if (expectedStatus === 'cancelled') controller.abort();
            else throw new Error('required writer failed');
          },
        },
      }),
    }).prepare({ definition, policy: createMeasurementPolicy({ eventDelivery: { writerMode: 'required' } }) });
    const run = await prepared.start({ runId: `core-${expectedStatus}`, signal: controller.signal });
    expect((await run.result).status).toBe(expectedStatus);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps a late host acquisition or partial-cleanup failure observable', async () => {
    const { runtime, definition, policy } = fixture();
    const release = deferred<void>();
    const entered = deferred<void>();
    const controller = new AbortController();
    const hostFailure = new Error('host partial cleanup failed');
    const prepared = await createEvaluationExecution({
      runtime: runtime(),
      async acquireRun() {
        entered.resolve();
        await release.promise;
        throw hostFailure;
      },
    }).prepare({ definition, policy });
    const start = prepared.start({ runId: 'host-failure', signal: controller.signal });
    await entered.promise;
    controller.abort();
    const error = await start.catch((cause: unknown) => cause) as EvaluationRuntimeLifecycleError;
    release.resolve();
    const cleanupFailure = await error.cleanup!.catch((cause: unknown) => cause) as EvaluationRuntimeLifecycleError;
    expect(cleanupFailure.code).toBe('EVAL_RUNTIME_RUN_CLEANUP_FAILED');
    expect((cleanupFailure.cause as AggregateError).errors).toContain(hostFailure);
  });

});
