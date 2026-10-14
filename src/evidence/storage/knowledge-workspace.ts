import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { FileLockTimeoutError, withFileLock } from '../../shared/file-lock.js';

export const WORKSPACE_LOCK_FILE = '.knowledge-write.lock';
const lockOwner = z.strictObject({ owner: z.string().uuid(), pid: z.number().int().positive(),
  hostname: z.string().min(1), acquiredAt: z.iso.datetime({ offset: true }) });

export class KnowledgeStorageStateError extends Error {
  constructor(readonly stateCode: 'knowledge_storage_unsupported' | 'knowledge_workspace_busy') {
    super(stateCode); this.name = 'KnowledgeStorageStateError';
  }
}
export function checkStorageDirectory(root: string): void {
  if (!root.trim()) throw new Error('Explicit knowledge storage directory required.');
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid knowledge storage directory.');
}
/** A stored lock is not proof of a live owner. Only local SIG0/ESRCH permits recovery. */
export function storageLockState(path: string): 'absent' | 'dead' | 'busy' {
  if (!existsSync(path)) return 'absent';
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return 'busy';
    const parsed = lockOwner.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success || parsed.data.hostname !== hostname()) return 'busy';
    try { process.kill(parsed.data.pid, 0); return 'busy'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'busy'; }
  } catch { return 'busy'; }
}
export function recoverStorageLock(path: string): void {
  recoverDeadLock(path, 0);
}
function recoverDeadLock(path: string, depth: number): void {
  if (storageLockState(path) !== 'dead') return;
  if (depth >= 16) throw new KnowledgeStorageStateError('knowledge_workspace_busy');
  try {
    const stat = lstatSync(path); const bytes = readFileSync(path);
    if (storageLockState(path) !== 'dead') return;
    const owner = lockOwner.parse(JSON.parse(bytes.toString('utf8')));
    // Recoverers of the same dead owner serialize. Otherwise two check/unlink
    // sequences could remove a new live lock between the last read and unlink.
    const guard = `${path}.recovery-${owner.owner}.lock`;
    recoverDeadLock(guard, depth + 1);
    withFileLock(guard, () => {
      if (storageLockState(path) !== 'dead') return;
      const current = lstatSync(path);
      if (stat.ino === current.ino && stat.dev === current.dev && readFileSync(path).equals(bytes)) unlinkSync(path);
    }, { recoverStale: false, label: 'knowledge lock recovery' });
  } catch (error) {
    // Another recovering process can remove the same dead lock first.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
/** Every knowledge-derived write holds this boundary through its final validation and publication. */
export function withWorkspaceWrite<T>(root: string, operation: () => T): T {
  checkStorageDirectory(root);
  const path = join(root, WORKSPACE_LOCK_FILE);
  try {
    recoverStorageLock(path);
    return withFileLock(path, () => { checkStorageDirectory(root); return operation(); },
      { recoverStale: false, label: 'knowledge workspace' });
  } catch (error) {
    if (error instanceof FileLockTimeoutError) throw new KnowledgeStorageStateError('knowledge_workspace_busy');
    throw error;
  }
}

/** File histories share the workspace guard and recover only proven exited local owners. */
export function withWorkspaceFileWrite<T>(root: string, file: string, operation: () => T): T {
  return withWorkspaceWrite(root, () => {
    const lock = `${file}.lock`;
    recoverStorageLock(lock);
    return withFileLock(lock, operation, { recoverStale: false, label: 'knowledge record' });
  });
}
