import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, onTestFinished, vi } from 'vitest';
import { PollingSubscriptionHub } from '../../src/observability/conversation/polling-subscription-hub.js';

function createHub(intervalMs: number) {
  const hub = new PollingSubscriptionHub<number>(intervalMs);
  onTestFinished(() => hub.close());
  return hub;
}

describe('PollingSubscriptionHub', () => {
  it('shares a sequential poll loop and releases it after the last unsubscribe', async () => {
    const hub = createHub(5);
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const loader = async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(8);
      active -= 1;
      return { revision: String(calls), terminal: false, value: calls };
    };
    const firstValues: number[] = [];
    const secondValues: number[] = [];
    const unsubscribeFirst = await hub.subscribe('task', loader, { next: ({ value }) => firstValues.push(value) });
    const unsubscribeSecond = await hub.subscribe('task', loader, { next: ({ value }) => secondValues.push(value) });

    await delay(30);
    assert.equal(maxActive, 1);
    assert.ok(firstValues.length >= 2);
    assert.ok(secondValues.length >= 2);
    unsubscribeFirst();
    unsubscribeSecond();
    const callsAfterUnsubscribe = calls;
    await delay(25);
    assert.equal(calls, callsAfterUnsubscribe);
  });

  it('stops polling when the source reports a terminal snapshot', async () => {
    const hub = createHub(1);
    const controller = new AbortController();
    let calls = 0;
    const values: number[] = [];
    let completed = false;
    await hub.subscribe('task', async () => {
      calls += 1;
      return { revision: 'complete', terminal: true, value: 1 };
    }, {
      next: ({ value }) => values.push(value),
      complete: () => { completed = true; },
    }, { signal: controller.signal });

    await delay(15);
    assert.equal(calls, 1);
    assert.deepEqual(values, [1]);
    assert.equal(completed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('reports a polling failure that happens after the initial snapshot', async () => {
    const hub = createHub(1);
    const controller = new AbortController();
    let calls = 0;
    let failure: unknown;
    await hub.subscribe('task', async () => {
      calls += 1;
      if (calls > 1) throw new Error('poll failed');
      return { revision: 'initial', terminal: false, value: 1 };
    }, {
      next: () => undefined,
      error: (cause) => { failure = cause; },
    }, { signal: controller.signal });

    await delay(15);
    assert.match(String(failure), /poll failed/u);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('releases signal listeners when a ready hub closes and does no work for an aborted subscriber', async () => {
    const hub = createHub(1);
    const controller = new AbortController();
    const loader = vi.fn(async () => ({ revision: 'initial', terminal: false, value: 1 }));
    try {
      await hub.subscribe('ready', loader, { next: () => undefined }, { signal: controller.signal });
      hub.close();
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      controller.abort();
      await assert.rejects(hub.subscribe('cancelled', loader, { next: () => undefined }, { signal: controller.signal }));
      assert.equal(loader.mock.calls.length, 1);
    } finally { hub.close(); }
  });

  it('owns each subscription independently when the same observer is reused', async () => {
    vi.useFakeTimers();
    const hub = createHub(1);
    let calls = 0;
    const values: number[] = [];
    const observer = { next: ({ value }: { value: number }) => values.push(value) };
    const loader = async () => ({ revision: String(++calls), terminal: false, value: calls });
    try {
      const first = await hub.subscribe('task', loader, observer);
      const second = await hub.subscribe('task', loader, observer);
      first();
      await vi.advanceTimersByTimeAsync(1);
      assert.deepEqual(values, [1, 1, 2]);
      second();
      await vi.advanceTimersByTimeAsync(5);
      assert.equal(calls, 2);
    } finally { hub.close(); vi.useRealTimers(); }
  });

  it('does not schedule another read when the last observer unsubscribes from next', async () => {
    vi.useFakeTimers();
    const hub = createHub(1);
    let calls = 0;
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = await hub.subscribe('task', async () => ({ revision: String(++calls), terminal: false, value: calls }), {
        next: ({ value }) => { if (value === 2) unsubscribe(); },
      });
      await vi.advanceTimersByTimeAsync(5);
      assert.equal(calls, 2);
      assert.equal(vi.getTimerCount(), 0);
    } finally { hub.close(); vi.useRealTimers(); }
  });

  it('delivers a cached snapshot once to a subscriber added from next', async () => {
    const hub = createHub(1000);
    const nestedValues: number[] = [];
    let nested: Promise<() => void> | undefined;
    try {
      await hub.subscribe('task', async () => ({ revision: 'initial', terminal: false, value: 1 }), {
        next: () => { nested ??= hub.subscribe('task', async () => assert.fail('must share loader'), {
          next: ({ value }) => nestedValues.push(value),
        }); },
      });
      await nested;
      assert.deepEqual(nestedValues, [1]);
    } finally { hub.close(); }
  });

  it.each(['complete', 'error'] as const)('can start a fresh subscription from %s', async (outcome) => {
    vi.useFakeTimers();
    const hub = createHub(1);
    let calls = 0;
    let nested: Promise<() => void> | undefined;
    const values: number[] = [];
    const restart = () => {
      nested = hub.subscribe('task', async () => ({ revision: 'fresh', terminal: true, value: 2 }), {
        next: ({ value }) => values.push(value),
      });
    };
    try {
      await hub.subscribe('task', async () => {
        if (++calls > 1) throw new Error('source failed');
        return { revision: 'initial', terminal: outcome === 'complete', value: 1 };
      }, {
        next: () => undefined,
        ...(outcome === 'complete' ? { complete: restart } : { error: restart }),
      });
      await vi.advanceTimersByTimeAsync(1);
      assert.ok(nested);
      await nested;
      assert.deepEqual(values, [2]);
    } finally { hub.close(); vi.useRealTimers(); }
  });

  it('starts a fresh read when a subscriber is added from a terminal next callback', async () => {
    const hub = createHub(1);
    const values: number[] = [];
    let nested: Promise<() => void> | undefined;
    await hub.subscribe('task', async () => ({ revision: 'final', terminal: true, value: 1 }), {
      next: () => {
        nested = hub.subscribe('task', async () => ({ revision: 'fresh', terminal: true, value: 2 }), {
          next: ({ value }) => values.push(value),
        });
      },
    });
    await nested;
    assert.deepEqual(values, [2]);
  });

  it('rejects an initial loader failure and removes its signal listener', async () => {
    const hub = createHub(1);
    const controller = new AbortController();
    const failure = new Error('initial read failed');
    await assert.rejects(hub.subscribe('task', async () => { throw failure; }, {
      next: () => assert.fail('no snapshot was loaded'),
    }, { signal: controller.signal }), error => error === failure);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('cancels a subscriber while the initial snapshot is still loading', async () => {
    const hub = createHub(1);
    const controller = new AbortController();
    let releaseLoader!: () => void;
    const loaderReady = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });
    const values: number[] = [];
    const subscription = hub.subscribe('task', async () => {
      await loaderReady;
      return { revision: 'late', terminal: false, value: 1 };
    }, {
      next: ({ value }) => values.push(value),
    }, {
      signal: controller.signal,
    });

    controller.abort();
    await assert.rejects(subscription, (cause: unknown) => (
      cause instanceof Error && cause.name === 'AbortError'
    ));
    releaseLoader();
    await delay(5);
    assert.deepEqual(values, []);
  });

  it('settles an initial subscriber when the hub closes', async () => {
    const hub = createHub(1);
    const subscription = hub.subscribe('task', async () => new Promise(() => undefined), {
      next: () => undefined,
    });

    hub.close();
    await assert.rejects(subscription, (cause: unknown) => (
      cause instanceof Error && cause.name === 'AbortError'
    ));
  });
});
