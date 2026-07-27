import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../../src/shared/keyed-mutex.js';

describe('KeyedMutex', () => {
  it('keeps a later waiter queued after the first operation releases', async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });

    const first = mutex.run('same', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = mutex.run('same', async () => {
      events.push('second:start');
      await secondGate;
      events.push('second:end');
    });

    await Promise.resolve();
    releaseFirst();
    await first;
    const third = mutex.run('same', async () => {
      events.push('third:start');
      events.push('third:end');
    });
    await Promise.resolve();

    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    releaseSecond();
    await Promise.all([second, third]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
      'third:start',
      'third:end',
    ]);
  });

  it('does not serialize unrelated keys', async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let otherRan = false;

    const blocked = mutex.run('a', async () => gate);
    await mutex.run('b', async () => {
      otherRan = true;
    });

    expect(otherRan).toBe(true);
    release();
    await blocked;
  });
});
