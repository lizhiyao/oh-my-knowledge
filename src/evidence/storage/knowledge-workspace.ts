import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { FileLockTimeoutError, withFileLock } from '../../shared/file-lock.js';

export const WORKSPACE_LOCK_FILE = '.knowledge-write.lock';
export const SOURCE_MIGRATION_STATE_FILE = '.source-migration.json';
export const SOURCE_MIGRATION_LOCK_FILE = '.source-migration.lock';
const lockOwner = z.strictObject({ owner: z.string().uuid(), pid: z.number().int().positive(),
  hostname: z.string().min(1), acquiredAt: z.iso.datetime({ offset: true }) });

export class KnowledgeStorageStateError extends Error {
  constructor(readonly stateCode: 'knowledge_storage_unsupported' | 'knowledge_workspace_busy') {
    super(stateCode); this.name = 'KnowledgeStorageStateError';
  }
}
const migrationHeader = z.object({ migrationKind: z.enum(['knowledge-source2-to3', 'knowledge-workflow3-to4']), schemaVersion: z.literal(1),
  migrationId: z.string().uuid(), planDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), state: z.enum(['in_progress', 'complete']) });
function unsupported(): never { throw new KnowledgeStorageStateError('knowledge_storage_unsupported'); }
/** Stable, bounded metadata read. A dangling symbolic link is an invalid marker, never absence. */
function metadata(path: string, maxBytes: number): { bytes: Buffer; device: bigint; inode: bigint } | undefined {
  let before;
  try { before = lstatSync(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) unsupported();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }), bytes = Buffer.allocUnsafe(Number(before.size) + 1); let offset = 0;
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) unsupported();
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (offset !== Number(before.size) || [after, named].some(value => !value.isFile() || value.isSymbolicLink()
      || value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size
      || value.mtimeNs !== before.mtimeNs || value.ctimeNs !== before.ctimeNs)) unsupported();
    return { bytes: bytes.subarray(0, offset), device: before.dev, inode: before.ino };
  } finally { closeSync(fd); }
}
function sourceMigrationState(root: string) {
  try {
    const stored = metadata(join(root, SOURCE_MIGRATION_STATE_FILE), 16 * 1024 * 1024);
    return stored && migrationHeader.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes)));
  } catch { return unsupported(); }
}
/** Fast admission also used by existing application instances; writes repeat this under their real lock. */
export function assertSourceMigrationComplete(root: string): void {
  const state = sourceMigrationState(root);
  if (state && state.state !== 'complete') unsupported();
}
type MigrationScope = { migrationId: string; planDigest: string };
type LockBinding = NonNullable<ReturnType<typeof metadata>>;
class SourceMigrationWriteLease {
  #active = true;
  #markerBound = false;
  constructor(private readonly root: string, private readonly scope: MigrationScope,
    private readonly migrationLock: LockBinding, private readonly workspaceLock: LockBinding) {}
  revoke(): void { this.#active = false; }
  assert(root: string): void {
    try {
      if (!this.#active || resolve(root) !== this.root || realpathSync(root) !== this.root) unsupported();
      for (const [name, expected] of [[SOURCE_MIGRATION_LOCK_FILE, this.migrationLock], [WORKSPACE_LOCK_FILE, this.workspaceLock]] as const) {
        const actual = metadata(join(this.root, name), 4096);
        if (!actual || actual.device !== expected.device || actual.inode !== expected.inode || !actual.bytes.equals(expected.bytes)) unsupported();
      }
      const state = sourceMigrationState(this.root);
      if (state && (state.migrationId !== this.scope.migrationId || state.planDigest !== this.scope.planDigest)) unsupported();
      if (state) this.#markerBound = true;
      else if (this.#markerBound) unsupported();
    } catch { unsupported(); }
  }
}
/** Internal synchronous capability; it cannot be constructed, copied or reused after its owning callback. */
export type SourceMigrationWriteContext = SourceMigrationWriteLease;
export function assertSourceMigrationWriteContext(root: string, context: SourceMigrationWriteContext): void {
  if (!(context instanceof SourceMigrationWriteLease)) unsupported();
  context.assert(root);
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
function withWorkspaceLock<T>(root: string, operation: () => T): T {
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

/** Every ordinary write checks migration state after acquiring the actual shared lock. */
export function withWorkspaceWrite<T>(root: string, operation: () => T, context?: SourceMigrationWriteContext): T {
  if (context !== undefined) { assertSourceMigrationWriteContext(root, context); return operation(); }
  return withWorkspaceLock(root, () => { assertSourceMigrationComplete(root); return operation(); });
}

/** One explicit migration owns both locks until its synchronous callback exits, including interruptions. */
export function withSourceMigrationWorkspaceWrite<T>(root: string, scopeInput: MigrationScope,
  operation: (context: SourceMigrationWriteContext) => T): T {
  checkStorageDirectory(root);
  const scope = migrationHeader.pick({ migrationId: true, planDigest: true }).parse(scopeInput), workspace = resolve(root);
  const lock = join(workspace, SOURCE_MIGRATION_LOCK_FILE); recoverStorageLock(lock);
  return withFileLock(lock, () => withWorkspaceLock(workspace, () => {
    if (realpathSync(workspace) !== workspace) unsupported();
    const migrationLock = metadata(lock, 4096), workspaceLock = metadata(join(workspace, WORKSPACE_LOCK_FILE), 4096);
    if (!migrationLock || !workspaceLock) unsupported();
    lockOwner.parse(JSON.parse(migrationLock.bytes.toString('utf8'))); lockOwner.parse(JSON.parse(workspaceLock.bytes.toString('utf8')));
    const context = new SourceMigrationWriteLease(workspace, scope, migrationLock, workspaceLock);
    try { context.assert(workspace); return operation(context); } finally { context.revoke(); }
  }), { recoverStale: false, label: 'source migration' });
}

/** File histories share the workspace guard and recover only proven exited local owners. */
export function withWorkspaceFileWrite<T>(root: string, file: string, operation: () => T, context?: SourceMigrationWriteContext): T {
  return withWorkspaceWrite(root, () => {
    const lock = `${file}.lock`;
    recoverStorageLock(lock);
    return withFileLock(lock, operation, { recoverStale: false, label: 'knowledge record' });
  }, context);
}
