interface Waiter {
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class Semaphore {
  readonly #limit: number;
  readonly #waiters: Waiter[] = [];
  #active = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError('Semaphore limit must be a positive safe integer');
    }
    this.#limit = limit;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal !== undefined ? { signal } : {}) };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#active -= 1;
        return;
      }
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(this.#release());
    };
  }
}

export function abortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}
