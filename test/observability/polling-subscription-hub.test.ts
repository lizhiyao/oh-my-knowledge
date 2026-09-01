import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'vitest';
import { PollingSubscriptionHub } from '../../src/observability/conversation/polling-subscription-hub.js';

describe('PollingSubscriptionHub', () => {
  it('shares a sequential poll loop and releases it after the last unsubscribe', async () => {
    const hub = new PollingSubscriptionHub<number>(5);
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
    const hub = new PollingSubscriptionHub<number>(1);
    let calls = 0;
    const values: number[] = [];
    let completed = false;
    await hub.subscribe('task', async () => {
      calls += 1;
      return { revision: 'complete', terminal: true, value: 1 };
    }, {
      next: ({ value }) => values.push(value),
      complete: () => { completed = true; },
    });

    await delay(15);
    assert.equal(calls, 1);
    assert.deepEqual(values, [1]);
    assert.equal(completed, true);
  });

  it('reports a polling failure that happens after the initial snapshot', async () => {
    const hub = new PollingSubscriptionHub<number>(1);
    let calls = 0;
    let failure: unknown;
    await hub.subscribe('task', async () => {
      calls += 1;
      if (calls > 1) throw new Error('poll failed');
      return { revision: 'initial', terminal: false, value: 1 };
    }, {
      next: () => undefined,
      error: (cause) => { failure = cause; },
    });

    await delay(15);
    assert.match(String(failure), /poll failed/u);
  });

  it('cancels a subscriber while the initial snapshot is still loading', async () => {
    const hub = new PollingSubscriptionHub<number>(1);
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
    const hub = new PollingSubscriptionHub<number>(1);
    const subscription = hub.subscribe('task', async () => new Promise(() => undefined), {
      next: () => undefined,
    });

    hub.close();
    await assert.rejects(subscription, (cause: unknown) => (
      cause instanceof Error && cause.name === 'AbortError'
    ));
  });
});
