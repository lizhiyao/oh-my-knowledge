import {
  EVALUATION_EVENT_SCHEMA_VERSION,
  EvaluationEventSchema,
  digestCanonicalJson,
  parseWireDocument,
  type EvaluationError,
  type EvaluationEvent,
  type JsonValue,
} from '../contracts/index.js';
import { deepFreeze } from '../compiler/immutability.js';
import { BoundedEventStream } from './event-stream.js';

export interface RuntimeEventSequencer {
  next(runId: string): number;
}

export class InMemoryRuntimeEventSequencer implements RuntimeEventSequencer {
  readonly #nextByRun = new Map<string, number>();

  next(runId: string): number {
    const sequence = this.#nextByRun.get(runId) ?? 0;
    this.#nextByRun.set(runId, sequence + 1);
    return sequence;
  }
}

export interface RuntimeEventClock {
  timestamp(): string;
}

export interface RuntimeEventWriter {
  write(event: Readonly<EvaluationEvent>): Promise<void>;
}

export interface RuntimeEventEmitterOptions {
  runId: string;
  writerMode: 'disabled' | 'optional' | 'required';
  writerFailureMode: 'ignore' | 'fail-run';
  writerFailureReason: string;
  writerFailureError: EvaluationError;
}

export class RuntimeEventEmitter<
  EventKind extends string,
  SubjectKind extends string,
> {
  readonly #clock: RuntimeEventClock;
  readonly #sequencer: RuntimeEventSequencer;
  readonly #writer?: RuntimeEventWriter;
  readonly #options: RuntimeEventEmitterOptions;
  readonly #stream: BoundedEventStream;
  readonly #onFatal: (reason: string, error: EvaluationError) => void;
  #writerEnabled: boolean;
  #lastSequence = -1;
  #deliveryTail: Promise<void> = Promise.resolve();

  constructor(
    clock: RuntimeEventClock,
    sequencer: RuntimeEventSequencer,
    writer: RuntimeEventWriter | undefined,
    options: RuntimeEventEmitterOptions,
    stream: BoundedEventStream,
    onFatal: (reason: string, error: EvaluationError) => void,
  ) {
    this.#clock = clock;
    this.#sequencer = sequencer;
    this.#writer = writer;
    this.#options = options;
    this.#stream = stream;
    this.#onFatal = onFatal;
    this.#writerEnabled = options.writerMode !== 'disabled' && writer !== undefined;
  }

  async emit(
    eventKind: EventKind,
    subjectKind: SubjectKind,
    subjectId: string,
    data: JsonValue,
  ): Promise<boolean> {
    const sequence = this.#sequencer.next(this.#options.runId);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence <= this.#lastSequence) {
      throw new TypeError('EventSequencer must return a strictly increasing safe integer.');
    }
    this.#lastSequence = sequence;
    const event = deepFreeze(parseWireDocument(EvaluationEventSchema, {
      schemaVersion: EVALUATION_EVENT_SCHEMA_VERSION,
      eventId: digestCanonicalJson({
        derivation: 'omk.evaluation-event-id/v1',
        runId: this.#options.runId,
        sequence,
      }),
      sequence,
      runId: this.#options.runId,
      eventKind,
      time: this.#clock.timestamp(),
      subject: { subjectKind, subjectId },
      data,
    }));
    let published = true;
    const delivery = this.#deliveryTail.then(async () => {
      if (this.#writerEnabled) {
        try {
          await this.#writer?.write(event);
        } catch {
          this.#writerEnabled = false;
          if (this.#options.writerFailureMode === 'fail-run') {
            published = false;
            this.#onFatal(
              this.#options.writerFailureReason,
              this.#options.writerFailureError,
            );
          }
        }
      }
      if (published) this.#stream.push(event);
    });
    this.#deliveryTail = delivery.catch(() => undefined);
    await delivery;
    return published;
  }

  close(): void {
    this.#stream.close();
  }
}
