import type { EvaluationEvent } from '../contracts/index.js';

interface WaitingConsumer {
  resolve(result: IteratorResult<EvaluationEvent>): void;
}

export class BoundedEventStream implements AsyncIterable<EvaluationEvent> {
  readonly #capacity: number;
  readonly #queue: EvaluationEvent[] = [];
  readonly #waiting: WaitingConsumer[] = [];
  #closed = false;
  #iteratorCreated = false;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError('eventBufferCapacity must be a positive safe integer');
    }
    this.#capacity = capacity;
  }

  push(event: EvaluationEvent): void {
    if (this.#closed) return;
    const consumer = this.#waiting.shift();
    if (consumer !== undefined) {
      consumer.resolve({ done: false, value: event });
      return;
    }
    if (this.#queue.length === this.#capacity) this.#queue.shift();
    this.#queue.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const consumer of this.#waiting.splice(0)) {
      consumer.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<EvaluationEvent> {
    if (this.#iteratorCreated) {
      throw new TypeError('Execution event stream supports one consumer');
    }
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
