import { describe, expect, it } from 'vitest';
import {
  EVALUATION_EVENT_SCHEMA_VERSION,
  EvaluationEventSchema,
  type EvaluationEvent,
} from '../../../src/eval-core/contracts/index.js';
import type {
  EvaluationRun,
  EvaluationRunResult,
} from '../../../src/eval-core/engine/index.js';
import {
  attachOmkEvaluationProgressProjection,
  captureOmkEvaluationProgressProjection,
  projectOmkEvaluationEvent,
} from '../../../src/eval-workflows/runtime-adapter/event-projection.js';

function event(
  sequence: number,
  eventKind: string,
  subjectKind = 'run',
  subjectId = 'run-1',
): EvaluationEvent {
  return EvaluationEventSchema.parse({
    schemaVersion: EVALUATION_EVENT_SCHEMA_VERSION,
    eventId: `event-${sequence}`,
    sequence,
    runId: 'run-1',
    eventKind,
    time: `2026-08-31T00:00:0${sequence}.000Z`,
    subject: { subjectKind, subjectId },
    data: { secret: 'must-not-enter-progress' },
  });
}

function failedResult(): Promise<EvaluationRunResult> {
  return Promise.resolve({
    status: 'failed',
    error: { code: 'test-failure', stage: 'internal', message: 'test only' },
  });
}

function runWith(events: readonly EvaluationEvent[]): EvaluationRun {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
    result: failedResult(),
  };
}

async function collect(run: EvaluationRun): Promise<EvaluationEvent[]> {
  const events: EvaluationEvent[] = [];
  for await (const candidate of run.events) events.push(candidate);
  return events;
}

describe('Evaluation event progress projection', () => {
  it('preserves the event envelope while excluding arbitrary event data', () => {
    const projected = projectOmkEvaluationEvent(event(
      1,
      'execution.retry.scheduled',
      'trial',
      'trial-1',
    ));

    expect(projected).toEqual({
      eventId: 'event-1',
      sequence: 1,
      runId: 'run-1',
      eventKind: 'execution.retry.scheduled',
      time: '2026-08-31T00:00:01.000Z',
      subject: { subjectKind: 'trial', subjectId: 'trial-1' },
      progressStage: 'execution',
      progressStatus: 'retry-scheduled',
    });
    expect(projected).not.toHaveProperty('data');
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.subject)).toBe(true);
  });

  it('keeps a never-settling renderer outside the authoritative result and raw event stream', async () => {
    let renderStarted = false;
    const projection = captureOmkEvaluationProgressProjection({
      render() {
        renderStarted = true;
        return new Promise<void>(() => {});
      },
    }, { progressBufferCapacity: 1 });
    const source = runWith([
      event(0, 'execution.run.started'),
      event(1, 'execution.run.completed'),
      event(2, 'report.materialized', 'report', 'report-1'),
    ]);
    const projected = attachOmkEvaluationProgressProjection(source, projection, 8);

    expect(projected.result).toBe(source.result);
    await expect(projected.result).resolves.toMatchObject({ status: 'failed' });
    await expect.poll(() => renderStarted).toBe(true);
    await expect(collect(projected)).resolves.toEqual([
      event(0, 'execution.run.started'),
      event(1, 'execution.run.completed'),
      event(2, 'report.materialized', 'report', 'report-1'),
    ]);
  });

  it('isolates renderer failure from the run result', async () => {
    let calls = 0;
    let closes = 0;
    const projection = captureOmkEvaluationProgressProjection({
      render() {
        calls += 1;
        throw new Error('renderer failed');
      },
      close() {
        closes += 1;
        throw new Error('renderer close failed');
      },
    });
    const source = runWith([event(0, 'evaluation.run.started')]);
    const projected = attachOmkEvaluationProgressProjection(source, projection);

    await expect(projected.result).resolves.toMatchObject({ status: 'failed' });
    await collect(projected);
    await expect.poll(() => calls).toBe(1);
    expect(closes).toBe(0);
  });

  it('isolates close failure after a successful render queue drain', async () => {
    let closes = 0;
    const projection = captureOmkEvaluationProgressProjection({
      render() {},
      close() {
        closes += 1;
        throw new Error('renderer close failed');
      },
    });
    const source = runWith([event(0, 'evaluation.run.started')]);
    const projected = attachOmkEvaluationProgressProjection(source, projection);

    await collect(projected);
    await expect.poll(() => closes).toBe(1);
    await expect(projected.result).resolves.toMatchObject({ status: 'failed' });
  });

  it('closes the mirror without changing result when event observation fails', async () => {
    const source: EvaluationRun = {
      events: {
        async *[Symbol.asyncIterator]() {
          yield event(0, 'execution.run.started');
          throw new Error('event consumer failed');
        },
      },
      result: failedResult(),
    };
    const projection = captureOmkEvaluationProgressProjection({ render() {} });
    const projected = attachOmkEvaluationProgressProjection(source, projection);

    await expect(collect(projected)).resolves.toEqual([event(0, 'execution.run.started')]);
    await expect(projected.result).resolves.toMatchObject({ status: 'failed' });
  });

  it('bounds an unconsumed raw-event mirror by dropping only presentation history', async () => {
    let projectionClosed = false;
    const projection = captureOmkEvaluationProgressProjection({
      render() {},
      close() { projectionClosed = true; },
    });
    const source = runWith([
      event(0, 'execution.run.started'),
      event(1, 'execution.block.started', 'scheduling-block', 'block-1'),
      event(2, 'execution.block.completed', 'scheduling-block', 'block-1'),
    ]);
    const projected = attachOmkEvaluationProgressProjection(source, projection, 2);
    await expect.poll(() => projectionClosed).toBe(true);

    await expect(collect(projected)).resolves.toEqual([
      event(1, 'execution.block.started', 'scheduling-block', 'block-1'),
      event(2, 'execution.block.completed', 'scheduling-block', 'block-1'),
    ]);
    await expect(projected.result).resolves.toMatchObject({ status: 'failed' });
  });

  it('captures renderer method identity before asynchronous event delivery', async () => {
    let original = 0;
    let replacement = 0;
    const sink = {
      render() { original += 1; },
    };
    const projection = captureOmkEvaluationProgressProjection(sink);
    sink.render = () => { replacement += 1; };
    const projected = attachOmkEvaluationProgressProjection(
      runWith([event(0, 'analysis.run.started')]),
      projection,
    );

    await collect(projected);
    await expect.poll(() => original).toBe(1);
    expect(replacement).toBe(0);
  });
});
