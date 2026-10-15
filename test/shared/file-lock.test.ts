import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { FileLockTimeoutError, withFileLock } from '../../src/shared/file-lock.js';

describe('cross-process file lock', () => {
  it.each([
    { ownerKind: 'dead', pauseAt: 'read' },
    { ownerKind: 'malformed', pauseAt: 'read' },
    { ownerKind: 'empty', pauseAt: 'read' },
    { ownerKind: 'dead', pauseAt: 'unlink' },
  ])('serializes $ownerKind lock recovery paused at $pauseAt', async ({ ownerKind, pauseAt }) => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-file-lock-recovery-'));
    const path = join(dir, 'state.lock');
    const shared = new SharedArrayBuffer(8);
    const state = new Int32Array(shared);
    const source = readFileSync(new URL('../../src/shared/file-lock.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
    const start = (role: string) => new Worker(new URL('./fixtures/file-lock-recovery.mjs', import.meta.url), {
      workerData: { role, path: role === 'stale-reader' ? `${dir}/./state.lock` : path, shared, moduleUrl, pauseAt },
    });
    const message = (worker: Worker) => new Promise<unknown>((resolve, reject) => {
      const onMessage = (value: unknown) => { cleanup(); resolve(value); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onExit = (code: number) => { cleanup(); reject(new Error(`Worker exited before its reply: ${code}`)); };
      const cleanup = () => {
        worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
      };
      worker.once('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
    });
    let first: Worker | undefined;
    let second: Worker | undefined;
    try {
      writeFileSync(path, ownerKind === 'dead' ? JSON.stringify({
        owner: 'dead-owner', pid: 2_147_483_647, hostname: hostname(), acquiredAt: '2026-01-01T00:00:00.000Z',
      }) : ownerKind === 'empty' ? '' : '{incomplete owner');
      utimesSync(path, new Date(0), new Date(0));
      first = start('stale-reader');
      assert.equal(await message(first), 'paused-recovery');
      second = start('new-writer');
      if (pauseAt === 'unlink') {
        // The first recoverer is inside its final check/unlink transaction.
        // Another spelling of the same path must wait on that recovery guard.
        assert.equal(await message(second), 'FileLockTimeoutError');
        const acquired = message(first);
        Atomics.store(state, 0, 1); Atomics.notify(state, 0);
        assert.equal(await acquired, 'entered');
        assert.deepEqual(readdirSync(dir), []);
        return;
      }
      assert.equal(await message(second), 'new-writer-holds-lock');
      const currentOwner = readFileSync(path, 'utf8');
      const blocked = message(first);
      Atomics.store(state, 0, 1); Atomics.notify(state, 0);
      assert.equal(await blocked, 'FileLockTimeoutError');
      assert.equal(readFileSync(path, 'utf8'), currentOwner, '活 writer 的锁必须原样保留');
      const released = message(second);
      Atomics.store(state, 1, 1); Atomics.notify(state, 1);
      assert.equal(await released, 'entered');
      assert.deepEqual(readdirSync(dir), [], '恢复辅助锁也必须释放');
    } finally {
      Atomics.store(state, 0, 1); Atomics.notify(state, 0);
      Atomics.store(state, 1, 1); Atomics.notify(state, 1);
      await Promise.all([first?.terminate(), second?.terminate()]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('preserves an abandoned or malformed lock in conservative mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-file-lock-conservative-'));
    const path = join(dir, 'state.lock');
    try {
      writeFileSync(path, '{incomplete owner');
      utimesSync(path, new Date(0), new Date(0));
      assert.throws(() => withFileLock(path, () => assert.fail('must not acquire'), {
        recoverStale: false, timeoutMs: 20, staleMs: 1, retryMs: 1,
      }), FileLockTimeoutError);
      assert.equal(existsSync(path), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('releases its lock when a transaction throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-file-lock-throw-'));
    const path = join(dir, 'state.lock');
    try {
      assert.throws(() => withFileLock(path, () => { throw new Error('transaction failed'); }, { recoverStale: false }), /transaction failed/);
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('releases its own lock after a successful transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-file-lock-'));
    const path = join(dir, 'state.lock');
    try {
      const value = withFileLock(path, () => 'done');
      assert.equal(value, 'done');
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not recover an old lock while its local owner is alive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-file-lock-live-'));
    const path = join(dir, 'state.lock');
    try {
      writeFileSync(path, JSON.stringify({
        owner: 'live-owner',
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: '2026-01-01T00:00:00.000Z',
      }));
      utimesSync(path, new Date(0), new Date(0));

      assert.throws(
        () => withFileLock(path, () => undefined, {
          timeoutMs: 20,
          staleMs: 1,
          retryMs: 1,
          label: 'live test lock',
        }),
        /timed out waiting for file lock: live test lock/,
      );
      assert.equal(existsSync(path), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers an old lock whose local owner no longer exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-file-lock-dead-'));
    const path = join(dir, 'state.lock');
    try {
      writeFileSync(path, JSON.stringify({
        owner: 'dead-owner',
        pid: 2_147_483_647,
        hostname: hostname(),
        acquiredAt: '2026-01-01T00:00:00.000Z',
      }));
      utimesSync(path, new Date(0), new Date(0));

      assert.equal(
        withFileLock(path, () => 'recovered', {
          timeoutMs: 100,
          staleMs: 1,
          retryMs: 1,
        }),
        'recovered',
      );
      assert.equal(existsSync(path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not recover an old lock owned by another host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-file-lock-remote-'));
    const path = join(dir, 'state.lock');
    try {
      writeFileSync(path, JSON.stringify({
        owner: 'remote-owner',
        pid: 1,
        hostname: 'remote-host.example',
        acquiredAt: '2026-01-01T00:00:00.000Z',
      }));
      utimesSync(path, new Date(0), new Date(0));

      assert.throws(
        () => withFileLock(path, () => undefined, {
          timeoutMs: 20,
          staleMs: 1,
          retryMs: 1,
          label: 'remote test lock',
        }),
        /timed out waiting for file lock: remote test lock/,
      );
      assert.equal(existsSync(path), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
