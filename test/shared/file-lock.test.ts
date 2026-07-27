import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from '../../src/shared/file-lock.js';

describe('cross-process file lock', () => {
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
