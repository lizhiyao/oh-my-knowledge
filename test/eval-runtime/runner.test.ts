import { describe, expect, it, vi } from 'vitest';
import { createEvaluationEngine } from '../../src/eval-core/index.js';
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
  return { runtime, definition, policy: createMeasurementPolicy({ maxConcurrency: 1 }) };
}

describe('eval-runtime high-level runner', () => {
  it('bounds a slow observer with drop-oldest progress while EventWriter remains lossless', async () => {
    const { runtime, definition } = fixture();
    const policy = createMeasurementPolicy({
      maxConcurrency: 1,
      eventDelivery: { writerMode: 'optional' },
    });
    const sequences: number[] = [];
    const persistedSequences: number[] = [];
    let activeObservers = 0;
    let maximumActiveObservers = 0;
    let releaseFirstObserver: (() => void) | undefined;
    const firstObserverBlocked = new Promise<void>((resolve) => {
      releaseFirstObserver = resolve;
    });
    const result = await runEvaluation({
      runtime: runtime(),
      definition,
      policy,
      runId: 'runner-events',
      eventBufferCapacity: 1,
      eventWriter: {
        async write(event) {
          persistedSequences.push(event.sequence);
          if (event.eventKind === 'report.materialized') releaseFirstObserver?.();
        },
      },
      async onEvent(event) {
        activeObservers += 1;
        maximumActiveObservers = Math.max(maximumActiveObservers, activeObservers);
        try {
          sequences.push(event.sequence);
          if (sequences.length === 1) await firstObserverBlocked;
        } finally {
          activeObservers -= 1;
        }
      },
    });

    expect(result.status).toBe('completed');
    expect(sequences.length).toBeGreaterThan(1);
    expect(sequences.length).toBeLessThan(persistedSequences.length);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(sequences.some((sequence, index) => index > 0
      && sequence > sequences[index - 1] + 1)).toBe(true);
    expect(persistedSequences).toEqual(persistedSequences.map((_, index) => index));
    expect(maximumActiveObservers).toBe(1);
  });

  it('fails the Core run when a required EventWriter rejects', async () => {
    const { runtime, definition } = fixture();
    const result = await runEvaluation({
      runtime: runtime(),
      definition,
      policy: createMeasurementPolicy({
        eventDelivery: { writerMode: 'required' },
      }),
      runId: 'runner-required-writer-failure',
      eventWriter: { async write() { throw new Error('private writer failure'); } },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: expect.stringContaining('event-writer-failed') },
    });
    expect(JSON.stringify(result)).not.toContain('private writer failure');
  });

  it('rejects an EventWriter that a disabled policy would silently ignore', async () => {
    const { runtime, definition, policy } = fixture();
    await expect(runEvaluation({
      runtime: runtime(),
      definition,
      policy,
      runId: 'runner-disabled-writer',
      eventWriter: { async write() {} },
    })).rejects.toThrow(
      'eventWriter requires an explicit optional or required eventDelivery policy.',
    );
  });

  it('completes with a one-event buffer when no observer is registered', async () => {
    const { runtime, definition, policy } = fixture();
    const result = await runEvaluation({
      runtime: runtime(),
      definition,
      policy,
      runId: 'runner-no-observer',
      eventBufferCapacity: 1,
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.artifacts.execution.records).toHaveLength(4);
    expect(result.report.status.runStatus).toBe('completed');
  });

  it('matches the ordinary Core run result for the same sealed inputs', async () => {
    const { runtime, definition, policy } = fixture();
    const directRun = createEvaluationEngine(runtime()).start(definition, {
      policy,
      runId: 'runner-equivalence',
      eventBufferCapacity: 256,
    });
    const directDraining = (async () => {
      for await (const event of directRun.events) void event;
    })();
    const [direct, convenient] = await Promise.all([
      directRun.result,
      runEvaluation({
        runtime: runtime(),
        definition,
        policy,
        runId: 'runner-equivalence',
        eventBufferCapacity: 256,
      }),
    ]);
    await directDraining;

    expect(convenient).toEqual(direct);
  });

  it('drains without changing the Core result when an observer fails', async () => {
    const { runtime, definition, policy } = fixture();
    const cause = new Error('host progress sink failed');

    await expect(runEvaluation({
      runtime: runtime(),
      definition,
      policy,
      runId: 'runner-observer-failure',
      eventBufferCapacity: 1,
      onEvent() { throw cause; },
    })).rejects.toMatchObject({
      name: 'EvaluationEventConsumptionError',
      code: 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED',
      cause,
      runResult: { status: 'completed' },
    });
  });

  it('forwards external cancellation and removes its listener after completion', async () => {
    const { runtime, definition, policy } = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    controller.abort(new Error('cancel before start'));

    const result = await runEvaluation({
      runtime: runtime(),
      definition,
      policy,
      runId: 'runner-cancelled',
      signal: controller.signal,
      eventBufferCapacity: 1,
    });

    expect(result.status).toBe('cancelled');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
