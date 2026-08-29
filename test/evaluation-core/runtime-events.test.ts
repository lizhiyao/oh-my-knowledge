import { describe, expect, it } from 'vitest';
import type { EvaluationEvent } from '../../src/evaluation-core/contracts/index.js';
import { BoundedEventStream } from '../../src/evaluation-core/runtime/event-stream.js';
import {
  InMemoryRuntimeEventSequencer,
  RuntimeEventEmitter,
} from '../../src/evaluation-core/runtime/events.js';

describe('Evaluation Core runtime event delivery', () => {
  it('suppresses queued ordinary events after a fatal writer failure and exposes one recovery terminal', async () => {
    let rejectFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectFirst = () => reject(new Error('writer down'));
    });
    let writes = 0;
    let fatals = 0;
    const stream = new BoundedEventStream(16);
    const emitter = new RuntimeEventEmitter<
      'evaluation.run.started' | 'evaluation.record.started' | 'evaluation.run.failed',
      'run' | 'evaluation',
      'evaluation.run.failed'
    >(
      { timestamp: () => '2026-08-29T00:00:00.000Z' },
      new InMemoryRuntimeEventSequencer(),
      {
        async write() {
          writes += 1;
          if (writes === 1) await firstWrite;
        },
      },
      {
        runId: 'fatal-delivery-run',
        writerMode: 'required',
        writerFailureMode: 'fail-run',
        writerFailureReason: 'writer-failed',
        writerFailureError: {
          code: 'writer-failed',
          stage: 'infrastructure',
          message: 'Writer failed.',
        },
        recoveryEventKinds: ['evaluation.run.failed'],
      },
      stream,
      () => { fatals += 1; },
    );

    const first = emitter.emit('evaluation.run.started', 'run', 'fatal-delivery-run', {});
    const queued = emitter.emit('evaluation.record.started', 'evaluation', 'evaluation-1', {});
    rejectFirst?.();

    await expect(first).resolves.toBe(false);
    await expect(queued).resolves.toBe(false);
    await expect(emitter.emit(
      'evaluation.record.started',
      'evaluation',
      'evaluation-2',
      {},
    )).resolves.toBe(false);
    await expect((emitter as unknown as {
      emitRecovery(
        eventKind: string,
        subjectKind: string,
        subjectId: string,
        data: Record<string, never>,
      ): Promise<void>;
    }).emitRecovery(
      'evaluation.record.started',
      'evaluation',
      'evaluation-3',
      {},
    )).rejects.toThrow(/terminal event kinds only/);
    await emitter.emitRecovery(
      'evaluation.run.failed',
      'run',
      'fatal-delivery-run',
      { bundleDigest: 're-sealed' },
    );
    await expect(emitter.emitRecovery(
      'evaluation.run.failed',
      'run',
      'fatal-delivery-run',
      { bundleDigest: 'duplicate' },
    )).rejects.toThrow(/one recovery terminal only/);
    emitter.close();

    const journal: EvaluationEvent[] = [];
    for await (const event of stream) journal.push(event);
    expect(writes).toBe(1);
    expect(fatals).toBe(1);
    expect(journal).toEqual([
      expect.objectContaining({
        eventKind: 'evaluation.run.failed',
        data: { bundleDigest: 're-sealed' },
      }),
    ]);
  });
});
