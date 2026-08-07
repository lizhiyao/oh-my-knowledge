export interface PollingSnapshot<T> {
  revision: string;
  terminal: boolean;
  value: T;
}

export type PollingSnapshotLoader<T> = (
  previous: PollingSnapshot<T> | undefined,
) => Promise<PollingSnapshot<T>>;

export type PollingSnapshotListener<T> = (snapshot: PollingSnapshot<T>) => void;

interface SubscriptionEntry<T> {
  active: boolean;
  listeners: Set<PollingSnapshotListener<T>>;
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
    listener: PollingSnapshotListener<T>,
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
        listeners: new Set(),
        loader,
        ready,
        resolveReady,
        rejectReady,
      };
      this.entries.set(key, entry);
      void this.poll(key, entry, true);
    }

    entry.listeners.add(listener);
    if (entry.latest) notify(listener, entry.latest);

    try {
      await entry.ready;
    } catch (cause) {
      entry.listeners.delete(listener);
      throw cause;
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      entry?.listeners.delete(listener);
      if (entry && entry.listeners.size === 0) this.dispose(key, entry);
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
        for (const listener of entry.listeners) notify(listener, snapshot);
      }
      if (initial) entry.resolveReady();
      if (snapshot.terminal) {
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
      this.dispose(key, entry);
    }
  }

  private dispose(key: string, entry: SubscriptionEntry<T>): void {
    if (!entry.active) return;
    entry.active = false;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.listeners.clear();
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
}

function notify<T>(listener: PollingSnapshotListener<T>, snapshot: PollingSnapshot<T>): void {
  try {
    listener(snapshot);
  } catch {
    // One consumer must not stop updates for other subscribers.
  }
}
