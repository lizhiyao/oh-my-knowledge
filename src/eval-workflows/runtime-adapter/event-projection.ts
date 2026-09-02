import type { EvaluationEvent } from '../../eval-core/contracts/index.js';
import type { EvaluationRun } from '../../eval-core/engine/index.js';

const DEFAULT_PROGRESS_BUFFER_CAPACITY = 64;
const DEFAULT_EVENT_MIRROR_CAPACITY = 256;

export type OmkEvaluationProgressStage =
  | 'execution' | 'evaluation' | 'analysis' | 'decision' | 'report' | 'runtime';

export type OmkEvaluationProgressStatus =
  | 'started' | 'completed' | 'failed' | 'cancelled' | 'budget-exhausted'
  | 'retry-scheduled' | 'cache-hit' | 'cache-miss' | 'inconclusive'
  | 'not-evaluated' | 'not-decided' | 'activity';

export interface OmkEvaluationProgressUpdate {
  readonly eventId: string;
  readonly sequence: number;
  readonly runId: string;
  readonly eventKind: string;
  readonly time: string;
  readonly subject: Readonly<{ subjectKind: string; subjectId: string }>;
  readonly progressStage: OmkEvaluationProgressStage;
  readonly progressStatus: OmkEvaluationProgressStatus;
}

export interface OmkEvaluationProgressSink {
  readonly render: (
    update: Readonly<OmkEvaluationProgressUpdate>,
  ) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
}

export interface OmkEvaluationProgressProjectionOptions {
  readonly progressBufferCapacity?: number;
}

function stageFor(eventKind: string): OmkEvaluationProgressStage {
  const stage = eventKind.split('.', 1)[0];
  return ['execution', 'evaluation', 'analysis', 'decision', 'report'].includes(stage)
    ? stage as OmkEvaluationProgressStage
    : 'runtime';
}

function statusFor(eventKind: string): OmkEvaluationProgressStatus {
  if (eventKind.endsWith('.retry.scheduled')) return 'retry-scheduled';
  if (eventKind.endsWith('.cache.hit')) return 'cache-hit';
  if (eventKind.endsWith('.cache.miss')) return 'cache-miss';
  const suffix = eventKind.split('.').at(-1);
  if (suffix === 'started' || suffix === 'completed' || suffix === 'failed'
      || suffix === 'cancelled' || suffix === 'inconclusive') return suffix;
  if (suffix === 'budget-exhausted') return 'budget-exhausted';
  if (suffix === 'not-evaluated') return 'not-evaluated';
  if (suffix === 'not-decided') return 'not-decided';
  return 'activity';
}

/** Pure, source-neutral projection. Event data is deliberately not a display channel. */
export function projectOmkEvaluationEvent(
  event: Readonly<EvaluationEvent>,
): Readonly<OmkEvaluationProgressUpdate> {
  return Object.freeze({
    eventId: event.eventId,
    sequence: event.sequence,
    runId: event.runId,
    eventKind: event.eventKind,
    time: event.time,
    subject: Object.freeze({ ...event.subject }),
    progressStage: stageFor(event.eventKind),
    progressStatus: statusFor(event.eventKind),
  });
}

export interface CapturedOmkEvaluationProgressProjection {
  offer(event: Readonly<EvaluationEvent>): void;
  close(): void;
}

function validCapacity(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Captures sink identity and owns a bounded, detached renderer queue. */
export function captureOmkEvaluationProgressProjection(
  sink: Readonly<OmkEvaluationProgressSink>,
  options: Readonly<OmkEvaluationProgressProjectionOptions> = {},
): CapturedOmkEvaluationProgressProjection {
  const capacity = options.progressBufferCapacity ?? DEFAULT_PROGRESS_BUFFER_CAPACITY;
  if (sink === null || typeof sink !== 'object' || !validCapacity(capacity)) {
    throw new TypeError('Evaluation progress projection input is invalid.');
  }
  const render = sink.render;
  const closeSink = sink.close;
  if (typeof render !== 'function'
      || (closeSink !== undefined && typeof closeSink !== 'function')) {
    throw new TypeError('Evaluation progress projection input is invalid.');
  }
  const queue: Array<Readonly<OmkEvaluationProgressUpdate>> = [];
  let rendering = false;
  let accepting = true;
  let sinkEnabled = true;

  const drain = async (): Promise<void> => {
    while (queue.length > 0 && sinkEnabled) {
      const update = queue.shift();
      if (update === undefined) break;
      try {
        await Reflect.apply(render, undefined, [update]);
      } catch {
        sinkEnabled = false;
        queue.splice(0);
      }
    }
    rendering = false;
    if (!accepting && sinkEnabled && closeSink !== undefined) {
      sinkEnabled = false;
      try {
        await Reflect.apply(closeSink, undefined, []);
      } catch {
        // Presentation teardown is intentionally non-authoritative.
      }
    }
  };

  return Object.freeze({
    offer(event: Readonly<EvaluationEvent>): void {
      if (!accepting || !sinkEnabled) return;
      if (queue.length === capacity) queue.shift();
      queue.push(projectOmkEvaluationEvent(event));
      if (rendering) return;
      rendering = true;
      queueMicrotask(() => { void drain(); });
    },
    close(): void {
      if (!accepting) return;
      accepting = false;
      if (!rendering) {
        rendering = true;
        queueMicrotask(() => { void drain(); });
      }
    },
  });
}

interface WaitingConsumer {
  resolve(result: IteratorResult<EvaluationEvent>): void;
}

class DroppingEventMirror implements AsyncIterable<EvaluationEvent> {
  readonly #capacity: number;
  readonly #queue: EvaluationEvent[] = [];
  readonly #waiting: WaitingConsumer[] = [];
  #closed = false;
  #iteratorCreated = false;

  constructor(capacity: number) {
    if (!validCapacity(capacity)) throw new TypeError('Event mirror capacity is invalid.');
    this.#capacity = capacity;
  }

  push(event: EvaluationEvent): void {
    if (this.#closed) return;
    const waiting = this.#waiting.shift();
    if (waiting !== undefined) {
      waiting.resolve({ done: false, value: event });
      return;
    }
    if (this.#queue.length === this.#capacity) this.#queue.shift();
    this.#queue.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiting of this.#waiting.splice(0)) {
      waiting.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<EvaluationEvent> {
    if (this.#iteratorCreated) throw new TypeError('Event mirror supports one consumer.');
    this.#iteratorCreated = true;
    return {
      next: async () => {
        const event = this.#queue.shift();
        if (event !== undefined) return { done: false, value: event };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<EvaluationEvent>>((resolve) => {
          this.#waiting.push({ resolve });
        });
      },
    };
  }
}

/** Drains Core events immediately and retains a bounded raw-event mirror for callers. */
export function attachOmkEvaluationProgressProjection(
  run: EvaluationRun,
  projection: CapturedOmkEvaluationProgressProjection,
  eventMirrorCapacity = DEFAULT_EVENT_MIRROR_CAPACITY,
): EvaluationRun {
  const mirror = new DroppingEventMirror(eventMirrorCapacity);
  void (async () => {
    try {
      for await (const event of run.events) {
        mirror.push(event);
        projection.offer(event);
      }
    } catch {
      // Event observation is presentation-only and cannot alter the authoritative result.
    } finally {
      mirror.close();
      projection.close();
    }
  })();
  return Object.freeze({ events: mirror, result: run.result });
}
