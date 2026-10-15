import { describe, expect, it, vi } from "vitest";
import { EvaluationEventConsumptionError, evaluate, executeEvaluation, rescore, scoreExecutedEvaluation } from "../../../src/eval-runtime/index.js";
import { comparisonAnalysis, controlSpec, executor, numericCustomEvaluator, pairedInput, treatmentSpec } from '../fixtures/evaluation.js';

describe('canonical eval-runtime events', () => {
it('keeps the executed handle when the best-effort observer fails', async () => {
    const input = pairedInput();
    let error: unknown;
    try {
      await executeEvaluation(input, {
        runId: 'staged-observer-failure',
        onEvent: () => { throw new Error('private observer failure'); },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EvaluationEventConsumptionError);
    const failure = error as EvaluationEventConsumptionError;
    expect(failure.code).toBe('EVAL_RUNTIME_EVENT_OBSERVER_FAILED');
    expect(failure.message).not.toContain('private observer failure');
    expect(failure.executed?.bundle.executionBundleStatus).toBe('completed');

    const result = await scoreExecutedEvaluation(input, failure.executed!, {
      runId: 'staged-observer-scored',
    });
    expect(result.status).toBe('completed');
  });

it('fails closed before any Target call when a writer has no durable delivery policy', async () => {
    const invocations = vi.fn();
    const declaration = executor(async ({ input, config }) => {
      invocations();
      return { output: config.answers[input.prompt] };
    });

    await expect(executeEvaluation(pairedInput(declaration), {
      runId: 'staged-writer-disabled',
      eventWriter: { write: async () => {} },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    expect(invocations).not.toHaveBeenCalled();
  });

it('keeps a completed re-score result when the best-effort observer fails', async () => {
    const input = pairedInput();
    const source = await evaluate(input, { runId: 'reuse-observer-source' });
    let error: unknown;
    try {
      await rescore(input, source, {
        runId: 'reuse-observer-result',
        onEvent: () => { throw new Error('private observer failure'); },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EvaluationEventConsumptionError);
    expect(error).toMatchObject({
      code: 'EVAL_RUNTIME_EVENT_OBSERVER_FAILED',
      runResult: { status: 'completed', runId: 'reuse-observer-result' },
    });
    expect((error as Error).message).not.toContain('private observer failure');
  });

it('keeps suffix measurement independent from a slow ordered observer', async () => {
    const evaluatorInvocations = vi.fn();
    const custom = numericCustomEvaluator('observed-length', ({ bindings }) => {
      evaluatorInvocations();
      return {
        resultKind: 'completed',
        results: [{ metricId: 'observed-length-score', resultKind: 'score', value: bindings.actual.length }],
      };
    });
    const base = pairedInput();
    const input = {
      ...base,
      evaluators: [custom],
      comparisons: [{
        comparisonId: 'baseline-vs-candidate',
        controlVariantId: controlSpec.variantId,
        treatmentVariantIds: [treatmentSpec.variantId],
        metricIds: ['observed-length-score'],
      }],
      analyses: comparisonAnalysis('observed-length-score'),
      decision: {
        decisionKind: 'analysis' as const,
        analysisId: 'observed-length-score-difference',
      },
    };
    const source = await evaluate(input, { runId: 'reuse-slow-observer-source' });
    evaluatorInvocations.mockClear();
    let releaseObserver!: () => void;
    const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
    let firstEvent!: () => void;
    const firstEventSeen = new Promise<void>((resolve) => { firstEvent = resolve; });
    const sequences: number[] = [];
    const run = rescore(input, source, {
      runId: 'reuse-slow-observer-result',
      async onEvent(event) {
        sequences.push(event.sequence);
        if (sequences.length === 1) {
          firstEvent();
          await observerGate;
        }
      },
    });

    await firstEventSeen;
    await vi.waitFor(() => expect(evaluatorInvocations).toHaveBeenCalledTimes(4));
    releaseObserver();
    const result = await run;

    expect(result.status).toBe('completed');
    expect(sequences.length).toBeGreaterThan(0);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  });

it('forwards cancellation and redacts observer failures', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    controller.abort(new Error('cancel before start'));
    const cancelled = await evaluate({
      ...pairedInput()
    }, {
      runId: 'cancelled-evaluate',
      signal: controller.signal
    });
    expect(cancelled.status).toBe('cancelled');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

    const privateValue = 'private-observer-payload';
    let caught: unknown;
    try {
      await evaluate({
        ...pairedInput()
      }, {
        runId: 'observer-failure',
        onEvent() { throw { privateValue }; }
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvaluationEventConsumptionError);
    if (!(caught instanceof EvaluationEventConsumptionError)) return;
    expect(caught.code).toBe('EVAL_RUNTIME_EVENT_OBSERVER_FAILED');
    expect(caught.runResult?.status).toBe('completed');
    expect(JSON.stringify(caught)).not.toContain(privateValue);
  });

it('delivers the complete journal to a declared writer while the bounded observer stays lossy', async () => {
    const written: number[] = [];
    const observed: number[] = [];
    let releaseObserver!: () => void;
    const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
    let firstEvent!: () => void;
    const firstEventSeen = new Promise<void>((resolve) => { firstEvent = resolve; });
    const input = pairedInput();
    const run = evaluate({
      ...input,
      policy: { ...input.policy, eventDelivery: { writerMode: 'optional' as const } },
    }, {
      runId: 'writer-lossless',
      eventBufferCapacity: 1,
      eventWriter: {
        write: async (event) => { written.push(event.sequence); },
      },
      async onEvent(event) {
        observed.push(event.sequence);
        if (observed.length === 1) {
          firstEvent();
          await observerGate;
        }
      },
    });

    await firstEventSeen;
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(observed.length));
    releaseObserver();
    const result = await run;

    expect(result.status).toBe('completed');
    expect(written).toEqual([...written].sort((left, right) => left - right));
    expect(new Set(written).size).toBe(written.length);
    expect(observed.every((sequence) => written.includes(sequence))).toBe(true);
    expect(observed.length).toBeLessThan(written.length);
  });

it('fails closed when a writer is supplied without a durable delivery policy', async () => {
    const invocations = vi.fn();
    const declaration = executor(async ({ input: invocationInput, config }) => {
      invocations();
      return { output: config.answers[invocationInput.prompt] };
    });

    await expect(evaluate(pairedInput(declaration), {
      runId: 'writer-without-delivery-policy',
      eventWriter: { write: async () => {} },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });

    expect(invocations).not.toHaveBeenCalled();
  });

it('delivers suffix events to a required writer and rejects one under a disabled policy', async () => {
    const input = pairedInput();
    const durable = {
      ...input,
      policy: { ...input.policy, eventDelivery: { writerMode: 'required' as const } },
    };
    const written: number[] = [];
    const source = await evaluate(durable, {
      runId: 'writer-reuse-source',
      eventWriter: {
        write: async (event) => { written.push(event.sequence); },
      },
    });
    expect(source.status).toBe('completed');
    const sourceEvents = written.length;
    written.length = 0;

    const rescored = await rescore(durable, source, {
      runId: 'writer-reuse-suffix',
      eventWriter: {
        write: async (event) => { written.push(event.sequence); },
      },
    });

    expect(rescored.status).toBe('completed');
    expect(written.length).toBeGreaterThan(0);
    expect(written).toEqual([...written].sort((left, right) => left - right));
    expect(sourceEvents).toBeGreaterThan(0);

    await expect(rescore(input, source, {
      runId: 'writer-reuse-disabled',
      eventWriter: { write: async () => {} },
    })).rejects.toMatchObject({ code: 'EVAL_RUNTIME_INPUT_INVALID' });
  });

it('silently truncates durable delivery per stage after a writer failure under optional plus ignore', async () => {
    const written: number[] = [];
    const observed: number[] = [];
    const input = pairedInput();

    const result = await evaluate({
      ...input,
      policy: {
        ...input.policy,
        eventDelivery: { writerMode: 'optional' as const, writerFailureMode: 'ignore' as const },
      },
    }, {
      runId: 'writer-optional-ignore',
      eventWriter: {
        write: async (event) => {
          written.push(event.sequence);
          throw new Error('host audit sink unavailable');
        },
      },
      onEvent(event) { observed.push(event.sequence); },
    });

    // 'ignore' keeps the run alive, but every stage latches its own writer off after its first
    // failed write, so the durable journal keeps one event per stage while the full ordering
    // survives only in the bounded observer projection. Nothing reports the truncation, so
    // audit-grade write-back requires 'required'.
    expect(result.status).toBe('completed');
    expect(written.length).toBeGreaterThan(1);
    expect(written.length).toBeLessThan(observed.length);
    expect(JSON.stringify(result)).not.toContain('host audit sink unavailable');
  });

it('fails the run before any Target call when a required delivery policy has no injected writer', async () => {
    const invocations = vi.fn();
    const declaration = executor(async ({ input: invocationInput, config }) => {
      invocations();
      return { output: config.answers[invocationInput.prompt] };
    });
    const input = pairedInput(declaration);

    const result = await evaluate({
      ...input,
      policy: { ...input.policy, eventDelivery: { writerMode: 'required' as const } },
    }, { runId: 'required-writer-missing' });

    expect(result.status).toBe('failed');
    expect(result.status === 'failed' ? result.error : undefined).toMatchObject({
      code: 'EXECUTION_RUNTIME_EVENT_WRITER_REQUIRED',
      stage: 'configuration',
    });
    expect(invocations).not.toHaveBeenCalled();
  });
});
