import { runnerFixture as fixture } from './fixtures/runner.js';
import { describe, expect, it, vi } from 'vitest';
import { createEvaluationEngine } from '../../src/eval-core/index.js';
import { runEvaluation } from '../../src/eval-runtime/index.js';

import { createMeasurementPolicy } from '../../src/eval-runtime/index.js';





describe('eval-runtime high-level runner', () => {
  it('bounds a slow observer with drop-oldest progress while EventWriter remains lossless', async () => {
    const { runtime, definition } = fixture();
    const policy = createMeasurementPolicy({
      execution: { maxConcurrency: 1 },
      evaluation: { maxConcurrency: 1 },
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
      name: 'HostEvaluationEventConsumptionError',
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
