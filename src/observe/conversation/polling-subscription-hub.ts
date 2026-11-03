export interface PollingSnapshot<T> {
  revision: string;
  terminal: boolean;
  value: T;
}

export type PollingSnapshotLoader<T> = (
  previous: PollingSnapshot<T> | undefined,
) => Promise<PollingSnapshot<T>>;

export interface PollingSnapshotObserver<T> {
  next(snapshot: PollingSnapshot<T>): void;
  complete?(): void;
  error?(cause: unknown): void;
}

export interface PollingSubscriptionOptions {
  signal?: AbortSignal;
}

interface SubscriptionEntry<T> {
  active: boolean;
  observers: Set<{ observer: PollingSnapshotObserver<T>; unsubscribe(): void }>;
  loader: PollingSnapshotLoader<T>;
  latest?: PollingSnapshot<T>;
  timer?: ReturnType<typeof setTimeout>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (cause: unknown) => void;
}

/**
 * Shares one sequential poll loop between all subscribers of the same key.
 * The hub owns scheduling and cleanup; source adapters only produce snapshots.
 */
export class PollingSubscriptionHub<T> {
  private readonly entries = new Map<string, SubscriptionEntry<T>>();

  constructor(private readonly intervalMs = 750) {}

  async subscribe(
    key: string,
    loader: PollingSnapshotLoader<T>,
    observer: PollingSnapshotObserver<T>,
    options: PollingSubscriptionOptions = {},
  ): Promise<() => void> {
    if (options.signal?.aborted) throw subscriptionAbortError();
    let entry = this.entries.get(key);
    // A final callback can subscribe again before its old entry has finished disposal.
    if (entry?.latest?.terminal) entry = undefined;
    const initial = entry === undefined;
    if (!entry) {
      let resolveReady!: () => void;
      let rejectReady!: (cause: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      entry = {
        active: true,
        observers: new Set(),
        loader,
        ready,
        resolveReady,
        rejectReady,
      };
      this.entries.set(key, entry);
    }

    let subscribed = true;
    let rejectAborted: ((cause: unknown) => void) | undefined;
    const aborted = options.signal
      ? new Promise<never>((_resolve, reject) => {
        rejectAborted = reject;
      })
      : undefined;
    const unsubscribe = (): void => {
      if (!subscribed) return;
      subscribed = false;
      options.signal?.removeEventListener('abort', abort);
      entry?.observers.delete(subscription);
      if (entry && entry.observers.size === 0) this.dispose(key, entry);
    };
    const abort = (): void => {
      unsubscribe();
      rejectAborted?.(subscriptionAbortError());
    };
    const subscription = { observer, unsubscribe };
    entry.observers.add(subscription);
    if (options.signal) {
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    }

    if (entry.latest) {
      notifyNext(observer, entry.latest);
    }
    if (initial) void this.poll(key, entry, true);

    try {
      await (aborted ? Promise.race([entry.ready, aborted]) : entry.ready);
      if (options.signal?.aborted) throw subscriptionAbortError();
    } catch (cause) {
      unsubscribe();
      throw cause;
    }

    return unsubscribe;
  }

  close(): void {
    for (const [key, entry] of this.entries) this.dispose(key, entry);
  }

  private async poll(
    key: string,
    entry: SubscriptionEntry<T>,
    initial: boolean,
  ): Promise<void> {
    try {
      const snapshot = await entry.loader(entry.latest);
      if (!entry.active) return;
      const changed = snapshot.revision !== entry.latest?.revision;
      entry.latest = snapshot;
      if (initial) entry.resolveReady();
      if (changed) {
        for (const subscription of [...entry.observers]) {
          if (entry.observers.has(subscription)) notifyNext(subscription.observer, snapshot);
        }
      }
      if (!entry.active) return;
      if (snapshot.terminal) {
        const subscriptions = [...entry.observers];
        this.dispose(key, entry);
        for (const { observer } of subscriptions) notifyComplete(observer);
        return;
      }
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        void this.poll(key, entry, false);
      }, this.intervalMs);
      entry.timer.unref?.();
    } catch (cause) {
      if (!entry.active) return;
      if (initial) entry.rejectReady(cause);
      const subscriptions = [...entry.observers];
      this.dispose(key, entry);
      if (!initial) for (const { observer } of subscriptions) notifyError(observer, cause);
    }
  }

  private dispose(key: string, entry: SubscriptionEntry<T>): void {
    if (!entry.active) return;
    entry.active = false;
    entry.rejectReady(subscriptionAbortError());
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    for (const { unsubscribe } of [...entry.observers]) unsubscribe();
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
}

function subscriptionAbortError(): Error {
  const error = new Error('Polling subscription closed before the initial snapshot was ready');
  error.name = 'AbortError';
  return error;
}

function notifyNext<T>(observer: PollingSnapshotObserver<T>, snapshot: PollingSnapshot<T>): void {
  try {
    observer.next(snapshot);
  } catch {
    // One consumer must not stop updates for other subscribers.
  }
}

function notifyComplete<T>(observer: PollingSnapshotObserver<T>): void {
  try {
    observer.complete?.();
  } catch {
    // One consumer must not stop completion for other subscribers.
  }
}

function notifyError<T>(observer: PollingSnapshotObserver<T>, cause: unknown): void {
  try {
    observer.error?.(cause);
  } catch {
    // One consumer must not stop error delivery for other subscribers.
  }
}
