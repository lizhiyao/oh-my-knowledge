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

interface SubscriptionEntry<T> {
  active: boolean;
  observers: Set<PollingSnapshotObserver<T>>;
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
  ): Promise<() => void> {
    let entry = this.entries.get(key);
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
      void this.poll(key, entry, true);
    }

    entry.observers.add(observer);
    if (entry.latest) notifyNext(observer, entry.latest);

    try {
      await entry.ready;
    } catch (cause) {
      entry.observers.delete(observer);
      throw cause;
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      entry?.observers.delete(observer);
      if (entry && entry.observers.size === 0) this.dispose(key, entry);
    };
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
      if (changed) {
        for (const observer of entry.observers) notifyNext(observer, snapshot);
      }
      if (initial) entry.resolveReady();
      if (snapshot.terminal) {
        for (const observer of entry.observers) notifyComplete(observer);
        this.dispose(key, entry);
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
      else for (const observer of entry.observers) notifyError(observer, cause);
      this.dispose(key, entry);
    }
  }

  private dispose(key: string, entry: SubscriptionEntry<T>): void {
    if (!entry.active) return;
    entry.active = false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.observers.clear();
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
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
