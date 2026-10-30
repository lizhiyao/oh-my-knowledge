import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { createJsonFileAtomic, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { FileLockTimeoutError } from '../../shared/file-lock.js';
import { checkStorageDirectory, KnowledgeStorageStateError, withWorkspaceFileWrite, type SourceMigrationWriteContext } from '../../evidence/storage/knowledge-workspace.js';
import { canonicalJson } from '../store.js';
import { SOURCE_PROJECTION_VERSION, SourceDeletionMarkerSchema, SourceDigestSchema, SourceProjectionSchema,
  SourceSnapshotSchema, sourceSnapshotProjection, sourceVersionPreimage,
  type SourceDeletionMarker, type SourceProjection, type SourceResolution, type SourceSnapshot } from '../sources.js';
import type { SourceBatchCaptureResult, SourceCaptureOptions, SourceCaptureResult, SourceStore, SourceStoreErrorCode } from '../source-store.js';

export const SOURCE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SOURCE_STORAGE_MAX_BYTES = 64 * 1024 * 1024;
export const SOURCE_STORAGE_MAX_FILES = 4096;
export const SOURCE_SNAPSHOT_SCHEMA_VERSION = 3;
const storeKind = 'knowledge-source-snapshot';
const uuid = z.string().uuid();
const atomicTemporaryName = /^([0-9a-f-]{36})\.json\.([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;
function isAtomicTemporary(name: string): boolean {
  const match = atomicTemporaryName.exec(name);
  return !!match && uuid.safeParse(match[1]).success && Number.isSafeInteger(Number(match[2])) && uuid.safeParse(match[3]).success;
}
const hash = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const digest = (value: unknown): string => hash(canonicalJson(value));
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export class SourceStoreError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: SourceStoreErrorCode, message: string) { super(message); this.name = 'SourceStoreError'; this.retryable = code === 'busy'; }
}
function failure(error: unknown): SourceStoreError {
  if (error instanceof SourceStoreError) return error;
  if (error instanceof KnowledgeStorageStateError && error.stateCode === 'knowledge_storage_unsupported') {
    return new SourceStoreError('unsupported', 'Source migration is incomplete or its storage state is unsupported.');
  }
  if (error instanceof FileLockTimeoutError || error instanceof KnowledgeStorageStateError && error.stateCode === 'knowledge_workspace_busy') {
    return new SourceStoreError('busy', 'Source storage is busy; retry the same operation after the active workspace write finishes.');
  }
  if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return new SourceStoreError('permission_denied', 'Source storage permission denied.');
  if (missing(error)) return new SourceStoreError('missing', 'Source snapshot is missing.');
  return new SourceStoreError('corrupt', 'Source storage is invalid or unreadable.');
}
function capacity(): never { throw new SourceStoreError('capacity_exceeded', 'Source snapshot or storage capacity exceeded.'); }

/** Bound the actual pretty JSON before Schema copies/scalar scans or full serialization. Object undefined follows JSON omission. */
function checkJsonCapacity(input: unknown): void {
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const add = (count: number) => { bytes += count; if (bytes > SOURCE_SNAPSHOT_MAX_BYTES) capacity(); };
  const string = (value: string) => {
    add(2);
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 16_384, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end])) end--;
      add(Buffer.byteLength(JSON.stringify(value.slice(start, end))) - 2); start = end;
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 1_000_000 || depth > 32) capacity();
    if (typeof value === 'string') { string(value); return; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value).length); return; }
    if (!value || typeof value !== 'object' || active.has(value)) throw new SourceStoreError('corrupt', 'Source material must be finite JSON data.');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null
      || Object.getOwnPropertyDescriptor(value, 'toJSON')) throw new SourceStoreError('corrupt', 'Source material must use plain JSON data.');
    if (array && value.length > 100_000) capacity();
    active.add(value); add(2); let count = 0;
    const keys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(value);
    if (keys.length > 1_000_000) capacity();
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property)) throw new SourceStoreError('corrupt', 'Source material contains an accessor or array hole.');
      if (property.value === undefined && !array) continue;
      add((count++ ? 2 : 1) + 2 * (depth + 1));
      if (!array) { string(key); add(2); }
      visit(property.value, depth + 1);
    }
    if (count) add(1 + depth * 2);
    active.delete(value);
  };
  visit(input, 0);
}
function jsonData(input: unknown): unknown {
  checkJsonCapacity(input);
  return JSON.parse(JSON.stringify(input));
}
function validateRawUnits(snapshot: SourceProjection): void {
  for (const unit of snapshot.rawUnits) if (hash(unit.text) !== unit.rawByteDigest) throw new SourceStoreError('corrupt', 'Source raw-unit digest mismatch.');
}
function descriptor(snapshot: SourceProjection): string {
  return canonicalJson({ sourceKind: snapshot.sourceKind, identity: snapshot.identity, selection: snapshot.selection });
}
type Stored = { snapshot: SourceSnapshot; marker?: never } | { marker: SourceDeletionMarker; snapshot?: never };

/** Current Source3 storage only. No upstream reads, compatibility decoder or model calls. */
export class FileSourceStore implements SourceStore {
  private readonly root: string;
  private readonly workspace: string;
  constructor(root: string, workspaceRoot = root, private readonly migrationWriteContext?: SourceMigrationWriteContext) {
    if (!root.trim() || !workspaceRoot.trim() || !isAbsolute(root) || !isAbsolute(workspaceRoot)) throw new Error('Explicit absolute source and workspace roots required.');
    this.root = resolve(root); this.workspace = resolve(workspaceRoot);
    const local = relative(this.workspace, this.root);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Source storage must be inside the explicit workspace.');
  }
  private check(): void {
    checkStorageDirectory(this.workspace);
    let parent = this.workspace;
    for (const part of relative(this.workspace, this.root).split(sep).filter(Boolean)) { parent = join(parent, part); checkStorageDirectory(parent); }
  }
  private path(snapshotId: string): string { return join(this.root, `${uuid.parse(snapshotId)}.json`); }
  private load(snapshotId: string): Stored {
    this.check(); const path = this.path(snapshotId), before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new SourceStoreError('corrupt', 'Source snapshot is not a regular file.');
    if (before.size > SOURCE_SNAPSHOT_MAX_BYTES) capacity();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new SourceStoreError('corrupt', 'Source snapshot changed before read.');
      bytes = Buffer.allocUnsafe(before.size + 1); let offset = 0;
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
      const after = fstatSync(fd);
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new SourceStoreError('corrupt', 'Source snapshot changed during read.');
      bytes = bytes.subarray(0, offset);
    } finally { closeSync(fd); }
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SourceStoreError('corrupt', 'Source snapshot envelope is invalid.');
    const { storeKind: storedKind, schemaVersion: storedVersion, snapshotDigest, markerDigest, ...data } = raw as Record<string, unknown>;
    if (storedKind !== storeKind || storedVersion !== SOURCE_SNAPSHOT_SCHEMA_VERSION || data.projectionVersion !== SOURCE_PROJECTION_VERSION) {
      throw new SourceStoreError('unsupported', 'Source snapshot schema is unsupported; an explicit migration is required.');
    }
    if (data.deleted === true) {
      const marker = SourceDeletionMarkerSchema.parse(data);
      if (snapshotDigest !== undefined || marker.snapshotId !== snapshotId || !SourceDigestSchema.safeParse(markerDigest).success || digest(marker) !== markerDigest) throw new SourceStoreError('corrupt', 'Source deletion marker integrity mismatch.');
      return { marker };
    }
    const snapshot = SourceSnapshotSchema.parse(data);
    if (markerDigest !== undefined || snapshot.snapshotId !== snapshotId || !SourceDigestSchema.safeParse(snapshotDigest).success || digest(snapshot) !== snapshotDigest) throw new SourceStoreError('corrupt', 'Source snapshot integrity mismatch.');
    const projection = sourceSnapshotProjection(snapshot); validateRawUnits(projection);
    if (digest(sourceVersionPreimage(projection)) !== snapshot.sourceVersion) throw new SourceStoreError('corrupt', 'Source version integrity mismatch.');
    return { snapshot };
  }
  private scan(): { entries: Stored[]; bytes: number; files: number } {
    this.check(); let directory;
    try { directory = opendirSync(this.root); } catch (error) { if (missing(error)) return { entries: [], bytes: 0, files: 0 }; throw error; }
    const names: string[] = []; let bytes = 0, files = 0;
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (entry.name === '.write.lock' || this.root === this.workspace && entry.name === '.knowledge-write.lock') continue;
        if (files++ >= SOURCE_STORAGE_MAX_FILES) capacity();
        const snapshot = entry.name.endsWith('.json') && uuid.safeParse(entry.name.slice(0, -5)).success;
        if (!snapshot && !isAtomicTemporary(entry.name)) throw new SourceStoreError('corrupt', 'Unexpected entry in source storage.');
        const stat = lstatSync(join(this.root, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new SourceStoreError('corrupt', 'Source storage contains a nonregular entry.');
        if (stat.size > SOURCE_SNAPSHOT_MAX_BYTES || (bytes += stat.size) > SOURCE_STORAGE_MAX_BYTES) capacity();
        // A process can exit after atomic publication but before finally removes its temporary link.
        // Temporary contents are not snapshots; count them without interpreting or removing a possible live writer's file.
        if (snapshot) names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    return { entries: names.sort().map(name => this.load(name.slice(0, -5))), bytes, files };
  }
  /** Read-only format/integrity gate before another domain writes into this source workspace. */
  assertCurrentFormat(): void { this.scan(); }
  capture(input: SourceProjection, options: SourceCaptureOptions = {}): SourceCaptureResult {
    return this.captureBatch([input], options).sources[0];
  }
  captureBatch(inputs: readonly SourceProjection[], options: SourceCaptureOptions = {}): SourceBatchCaptureResult {
    options.signal?.throwIfAborted();
    try {
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 256) throw new SourceStoreError('unsupported', 'Select between one and 256 source projections per capture batch.');
      // Reject oversized or non-JSON input before locks can create directories; hold no copies of duplicate batch entries.
      for (const input of inputs) {
        options.signal?.throwIfAborted();
        checkJsonCapacity(input);
      }
      this.check();
      return withWorkspaceFileWrite(this.workspace, join(this.root, '.write'), () => {
        this.check(); const inventory = this.scan();
        options.signal?.throwIfAborted();
        const planned = new Map<string, { snapshot: SourceSnapshot; selectedDescriptor: string }>();
        const publications: { snapshotId: string; stored: unknown }[] = [];
        const sources: SourceCaptureResult[] = []; let writtenBytes = 0;
        for (const input of inputs) {
          options.signal?.throwIfAborted();
          const projection = SourceProjectionSchema.parse(jsonData(input)); validateRawUnits(projection);
          const sourceVersion = digest(sourceVersionPreimage(projection)), selectedDescriptor = descriptor(projection);
          const earlier = planned.get(sourceVersion);
          if (earlier) {
            if (earlier.selectedDescriptor !== selectedDescriptor) throw new SourceStoreError('corrupt', 'Source version descriptor conflict.');
            sources.push({ snapshot: earlier.snapshot, reused: true }); continue;
          }
          const matching = inventory.entries.filter(entry => entry.snapshot?.sourceVersion === sourceVersion);
          if (matching.some(entry => descriptor(entry.snapshot!) !== selectedDescriptor)) throw new SourceStoreError('corrupt', 'Source version descriptor conflict.');
          if (matching.length) {
            const snapshot = matching[0].snapshot!; planned.set(sourceVersion, { snapshot, selectedDescriptor });
            sources.push({ snapshot, reused: true }); continue;
          }
          if (inventory.entries.some(entry => entry.marker?.sourceVersion === sourceVersion) && options.afterDeletion !== 'new_snapshot') {
            throw new SourceStoreError('deleted', 'This source version was deleted; a new snapshot requires an explicit after-deletion operation.');
          }
          const snapshotId = randomUUID();
          const candidate = { ...projection, snapshotId, sourceVersion, capturedAt: new Date().toISOString(),
            excerpts: projection.excerpts.map((excerpt, ordinal) => ({ ...excerpt, evidenceRef: `${snapshotId}:${ordinal}` })) };
          checkJsonCapacity(candidate); const snapshot = SourceSnapshotSchema.parse(candidate);
          const stored = { storeKind, schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION, ...snapshot, snapshotDigest: digest(snapshot) }; checkJsonCapacity(stored);
          writtenBytes += Buffer.byteLength(JSON.stringify(stored, null, 2));
          if (inventory.files + publications.length + 1 > SOURCE_STORAGE_MAX_FILES || inventory.bytes + writtenBytes > SOURCE_STORAGE_MAX_BYTES) capacity();
          planned.set(sourceVersion, { snapshot, selectedDescriptor }); publications.push({ snapshotId, stored });
          sources.push({ snapshot, reused: false });
        }
        // All data, deletion and capacity checks finish before the first publication. I/O is intentionally not batch-atomic.
        for (const publication of publications) {
          options.signal?.throwIfAborted(); createJsonFileAtomic(this.path(publication.snapshotId), publication.stored);
        }
        return { sources, writtenBytes };
      }, this.migrationWriteContext);
    } catch (error) { if (options.signal?.aborted) throw error; throw failure(error); }
  }
  read(snapshotId: string, expectedVersion?: string): SourceResolution {
    try {
      if (expectedVersion !== undefined) SourceDigestSchema.parse(expectedVersion);
      const stored = this.load(snapshotId), value = stored.snapshot ?? stored.marker;
      if (expectedVersion !== undefined && value.sourceVersion !== expectedVersion) return { status: 'unavailable', reason: 'version_mismatch', detail: 'Snapshot does not match the bound source version.' };
      return stored.snapshot ? { status: 'available', snapshot: stored.snapshot } : { status: 'unavailable', reason: 'deleted', detail: 'Source snapshot was explicitly deleted.' };
    } catch (error) {
      const problem = failure(error);
      // Immutable reads never acquire a write lock; do not relabel an unexpected write failure as corruption.
      if (problem.code === 'busy') throw problem;
      return { status: 'unavailable', reason: problem.code === 'capacity_exceeded' ? 'corrupt' : problem.code, detail: problem.message };
    }
  }
  delete(snapshotId: string, expectedVersion?: string): void {
    this.path(snapshotId); if (expectedVersion !== undefined) SourceDigestSchema.parse(expectedVersion); this.check();
    try {
      withWorkspaceFileWrite(this.workspace, join(this.root, '.write'), () => {
        const stored = this.load(snapshotId), value = stored.snapshot ?? stored.marker;
        if (expectedVersion !== undefined && value.sourceVersion !== expectedVersion) throw new SourceStoreError('version_mismatch', 'Snapshot does not match the bound source version.');
        if (stored.marker) return;
        const marker = SourceDeletionMarkerSchema.parse({ snapshotId, sourceVersion: value.sourceVersion, projectionVersion: SOURCE_PROJECTION_VERSION, deleted: true });
        writeJsonFileAtomic(this.path(snapshotId), { storeKind, schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION, ...marker, markerDigest: digest(marker) });
      }, this.migrationWriteContext);
    } catch (error) { throw failure(error); }
  }
}
