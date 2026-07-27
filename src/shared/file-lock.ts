import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  label?: string;
}

interface FileLockOwner {
  owner: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/**
 * Serialize a short synchronous read-modify-write transaction across
 * processes. The owner token prevents an old holder from deleting a lock that
 * was recovered and reacquired by another process.
 */
export function withFileLock<T>(
  lockPath: string,
  operation: () => T,
  options: FileLockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const retryMs = options.retryMs ?? 10;
  const label = options.label ?? lockPath;
  const owner: FileLockOwner = {
    owner: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };

  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx');
      writeFileSync(descriptor, JSON.stringify(owner));
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        descriptor = undefined;
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw unlinkError;
          }
        }
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (isRecoverableStaleLock(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw unlinkError;
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for file lock: ${label}`);
      }
      Atomics.wait(LOCK_SLEEP, 0, 0, retryMs);
    }
  }

  try {
    return operation();
  } finally {
    closeSync(descriptor);
    removeOwnedLock(lockPath, owner.owner);
  }
}

function isRecoverableStaleLock(lockPath: string, staleMs: number): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (ageMs <= staleMs) return false;

  const owner = readLockOwner(lockPath);
  if (!owner) return true;
  // A remote PID cannot be checked safely. On shared filesystems, deleting a
  // stale-looking lock owned by another host could break an active writer.
  if (owner.hostname !== hostname()) return false;
  return !isProcessAlive(owner.pid);
}

function readLockOwner(lockPath: string): FileLockOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (
      !value
      || typeof value !== 'object'
      || typeof (value as FileLockOwner).owner !== 'string'
      || !Number.isSafeInteger((value as FileLockOwner).pid)
      || (value as FileLockOwner).pid <= 0
      || typeof (value as FileLockOwner).hostname !== 'string'
      || typeof (value as FileLockOwner).acquiredAt !== 'string'
    ) return null;
    return value as FileLockOwner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function removeOwnedLock(lockPath: string, owner: string): void {
  const current = readLockOwner(lockPath);
  if (!current || current.owner !== owner) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
