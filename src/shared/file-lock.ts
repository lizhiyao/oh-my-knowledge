import { createHash, randomUUID } from 'node:crypto';
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
import { basename, dirname, join } from 'node:path';

const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

export interface FileLockOptions {
  /** Disable stale recovery when ownership cannot safely be re-established. */
  recoverStale?: boolean;
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  label?: string;
}

/** Hosts classify contention without matching path-bearing error strings. */
export class FileLockTimeoutError extends Error {
  constructor(label: string) {
    super(`timed out waiting for file lock: ${label}`);
    this.name = 'FileLockTimeoutError';
  }
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
  return withFileLockUntil(lockPath, operation, { ...options, label: options.label ?? lockPath },
    Date.now() + (options.timeoutMs ?? 5_000), 0);
}

function withFileLockUntil<T>(
  lockPath: string,
  operation: () => T,
  options: FileLockOptions,
  deadline: number,
  recoveryDepth: number,
): T {
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
      if (options.recoverStale !== false
        && recoverStaleLock(lockPath, staleMs, options, deadline, recoveryDepth)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(label);
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

function recoverStaleLock(
  lockPath: string,
  staleMs: number,
  options: FileLockOptions,
  deadline: number,
  depth: number,
): boolean {
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= staleMs) return false;
    const bytes = readFileSync(lockPath);
    if (!isRecoverableOwner(parseLockOwner(bytes.toString('utf8')))) return false;
    if (depth >= 16) throw new FileLockTimeoutError(options.label ?? lockPath);

    // All recoverers of the same old file serialize, then recheck its identity.
    // A mere check/unlink sequence could remove a newly acquired live lock.
    // Parent aliases and different hosts must derive the same guard name; device IDs are host-local.
    const key = createHash('sha256').update(basename(lockPath)).update('\0').update(bytes).digest('hex');
    const guard = join(dirname(lockPath), `.omk-recovery-${key}.lock`);
    return withFileLockUntil(guard, () => {
      const current = statSync(lockPath);
      const currentBytes = readFileSync(lockPath);
      if (current.ino !== stat.ino || current.dev !== stat.dev
        || Date.now() - current.mtimeMs <= staleMs || !currentBytes.equals(bytes)
        || !isRecoverableOwner(parseLockOwner(currentBytes.toString('utf8')))) return false;
      unlinkSync(lockPath);
      return true;
    }, options, deadline, depth + 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function isRecoverableOwner(owner: FileLockOwner | null): boolean {
  if (!owner) return true;
  // A remote PID cannot be checked safely. On shared filesystems, deleting a
  // stale-looking lock owned by another host could break an active writer.
  if (owner.hostname !== hostname()) return false;
  return !isProcessAlive(owner.pid);
}

function readLockOwner(lockPath: string): FileLockOwner | null {
  try {
    return parseLockOwner(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function parseLockOwner(raw: string): FileLockOwner | null {
  try {
    const value: unknown = JSON.parse(raw);
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
