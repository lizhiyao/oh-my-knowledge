import { describe, expect, it } from 'vitest';
import { linkAbortSignal } from '../../src/eval-core/runtime/abort.js';
import { RunResourceSessions } from '../../src/eval-core/runtime/run-resources.js';

describe('Core shared run resource lifecycle', () => {
  it('opens once per identity and finishes all cleanup even after open or dispose failures', async () => {
    const opened: string[] = [];
    const disposed: string[] = [];
    const sessions = new RunResourceSessions(
      (id: string) => id,
      async (id) => {
        opened.push(id);
        if (id === 'open-failure') throw new Error('open failed');
        return {
          async dispose() {
            disposed.push(id);
            if (id === 'dispose-failure') throw new Error('dispose failed');
          },
        };
      },
    );
    const first = sessions.get('first');
    expect(sessions.get('first')).toBe(first);
    await first;
    await expect(sessions.get('open-failure')).rejects.toThrow('open failed');
    await sessions.get('dispose-failure');
    await sessions.get('last');
    const disposal = sessions.dispose();
    expect(sessions.dispose()).toBe(disposal);
    expect(await disposal).toBe(2);
    expect(opened).toEqual(['first', 'open-failure', 'dispose-failure', 'last']);
    expect(disposed).toEqual(['first', 'dispose-failure', 'last']);
    expect(() => sessions.get('after-cleanup')).toThrow('already disposed');
  });

  it('preserves synchronous opening failures without caching a phantom resource', async () => {
    let attempts = 0;
    let disposals = 0;
    const sessions = new RunResourceSessions(
      (id: string) => id,
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error('synchronous open failure');
        return { dispose: () => { disposals += 1; } };
      },
    );
    expect(() => sessions.get('target')).toThrow('synchronous open failure');
    await sessions.get('target');
    expect(await sessions.dispose()).toBe(0);
    expect(attempts).toBe(2);
    expect(disposals).toBe(1);
  });

  it('forwards current and future abort reasons and stops forwarding after cleanup', () => {
    const parent = new AbortController();
    const child = new AbortController();
    const detached = new AbortController();
    const unlink = linkAbortSignal(parent.signal, child);
    linkAbortSignal(parent.signal, detached)();
    const reason = new Error('run cancelled');
    parent.abort(reason);
    expect(child.signal.reason).toBe(reason);
    expect(detached.signal.aborted).toBe(false);
    unlink();
    const lateChild = new AbortController();
    linkAbortSignal(parent.signal, lateChild)();
    expect(lateChild.signal.reason).toBe(reason);
    const unparented = new AbortController();
    linkAbortSignal(undefined, unparented)();
    expect(unparented.signal.aborted).toBe(false);
  });
});
