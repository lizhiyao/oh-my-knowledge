import { createHash, randomUUID } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { constants, existsSync, lstatSync, readdirSync, openSync, closeSync, readSync, writeSync, fstatSync, fsyncSync, mkdirSync, linkSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../../../knowledge/store.js';
import { ExtractionOutcomeSchema, ExtractionOutcomeRefSchema, ExtractionRunSchema,
  type ExtractionOutcome, type ExtractionOutcomeRef, type ExtractionRun, type ExtractionRunStore } from '../runs.js';
import { checkStorageDirectory, withWorkspaceWrite } from '../../../evidence/storage/knowledge-workspace.js';
import { assertCurrentStorage } from './storage-state.js';
import { accountExtractionOutcome } from '../generation-policy.js';

export const EXTRACTION_RUN_MAX_BYTES = 16 * 1024 * 1024;
// JSON.parse needs one string: even an all-ASCII file must stay below V8's string ceiling.
export const EXTRACTION_OUTCOME_MAX_BYTES = Math.min(512 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH - 1);
const uuid = z.string().uuid();
const inside = (root: string, path: string) => { const value = relative(root, path); return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Escape bounded slices without splitting a paired surrogate across chunks. */
function* stringChunks(value: string): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 16_384, value.length);
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff
      && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1); start = end;
  }
  yield '"';
}
/** Explicit frames: native trace nesting never reaches the JavaScript call stack. */
function* jsonChunks(value: unknown): Generator<string> {
  const frames: { value: unknown; keys?: string[]; index: number }[] = [{ value, index: 0 }];
  while (frames.length) {
    const frame = frames[frames.length - 1], current = frame.value;
    if (typeof current === 'string') { yield* stringChunks(current); frames.pop(); continue; }
    if (current === null || typeof current === 'boolean' || typeof current === 'number') { yield JSON.stringify(current); frames.pop(); continue; }
    const object = current as Record<string, unknown>, array = Array.isArray(current);
    if (!frame.keys) { frame.keys = Object.keys(object); if (!array) frame.keys.sort(); yield array ? '[' : '{'; }
    if (frame.index >= frame.keys.length) { yield array ? ']' : '}'; frames.pop(); continue; }
    const key = frame.keys[frame.index]; if (frame.index++) yield ',';
    if (!array) { yield* stringChunks(key); yield ':'; }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('Extraction outcome changed during serialization.');
    frames.push({ value: descriptor.value, index: 0 });
  }
}
function measured(value: unknown, limit: number): ExtractionOutcomeRef {
  let bytes = 0; const hash = createHash('sha256');
  for (const chunk of jsonChunks(value)) {
    bytes += Buffer.byteLength(chunk); if (bytes > limit) throw new Error('Extraction outcome capacity exceeded.'); hash.update(chunk);
  }
  return { bytes, digest: `sha256:${hash.digest('hex')}` };
}
function readBounded(path: string, maxBytes: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('Invalid extraction file.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Extraction file changed before read.');
    const buffer = Buffer.allocUnsafe(before.size + 1); let offset = 0;
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
    if (offset !== before.size || fstatSync(fd).size !== before.size) throw new Error('Extraction file changed during read.');
    return buffer.subarray(0, offset);
  } finally { closeSync(fd); }
}
function parse(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid extraction JSON file.'); }
}

/** Current v5 policy branches retain immutable native evidence and append-only invocation reservations. */
export class FileExtractionRunStore implements ExtractionRunStore {
  private readonly root: string;
  private readonly workspace: string;
  constructor(root: string, workspaceRoot = root) {
    if (!root.trim() || !workspaceRoot.trim()) throw new Error('Explicit extraction run root required.');
    this.root = resolve(root); this.workspace = resolve(workspaceRoot);
    if (!inside(this.workspace, this.root)) throw new Error('Extraction run root must be inside its workspace.');
  }
  private path(runId: string) { return join(this.root, `${uuid.parse(runId)}.json`); }
  private outcomePath(runId: string, attemptId: string) {
    const parent = join(this.root, 'outcomes'), directory = join(parent, uuid.parse(runId));
    checkStorageDirectory(parent); checkStorageDirectory(directory);
    return join(directory, `${uuid.parse(attemptId)}.json`);
  }
  private checkRoot() { checkStorageDirectory(this.workspace); checkStorageDirectory(this.root); }
  private check(run: unknown): ExtractionRun {
    const parsed = ExtractionRunSchema.parse(run);
    const serialized = JSON.stringify(parsed, null, 2);
    if (Buffer.byteLength(serialized) > EXTRACTION_RUN_MAX_BYTES) throw new Error('Extraction run capacity exceeded.');
    // Optional undefined fields are omitted by the persisted JSON contract, including saveRun clears.
    return JSON.parse(serialized) as ExtractionRun;
  }
  private envelope(runId: string, attemptId: string, outcome: ExtractionOutcome | null) {
    return { storeKind: 'knowledge-extraction-attempt-outcome', schemaVersion: 1, runId, attemptId, outcome };
  }
  private syncDirectories(directory: string) {
    for (let path = directory;; path = dirname(path)) {
      checkStorageDirectory(path); const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      if (path === this.workspace) break;
      if (!inside(this.workspace, dirname(path))) throw new Error('Extraction publication escaped workspace.');
    }
  }
  private confirmPublication(path: string) {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid extraction file.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('Extraction file changed before durability confirmation.');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.syncDirectories(dirname(path));
  }
  /** Acknowledgement follows file and directory fsync, without changing shared publishers. */
  private publish(path: string, chunks: Iterable<string>, exclusive: boolean) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.checkRoot(); checkStorageDirectory(dirname(path));
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      for (const chunk of chunks) {
        const bytes = Buffer.from(chunk); let offset = 0;
        while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (!count) throw new Error('Extraction write did not progress.'); offset += count; }
      }
      fsyncSync(fd); closeSync(fd); fd = undefined;
      if (exclusive) linkSync(temp, path); else renameSync(temp, path);
      this.syncDirectories(dirname(path));
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) rmSync(temp); }
  }
  private checkAllocation(run: ExtractionRun, fromIndex = 0) {
    for (const attempt of run.attempts.slice(fromIndex)) {
      const overhead = measured(this.envelope(run.runId, attempt.attemptId, null), 4096).bytes - 4;
      if (attempt.producer.maxOutcomeJsonBytes + overhead > EXTRACTION_OUTCOME_MAX_BYTES) throw new Error('Extraction outcome capacity exceeded before invocation.');
    }
  }
  private checkArchived(run: ExtractionRun) {
    const selected = run.attempts.find(attempt => attempt.attemptId === run.selectedAttemptId);
    const projected = selected ?? run.attempts[run.attempts.length - 1];
    let outcome: ExtractionOutcome | undefined;
    for (const attempt of run.attempts) {
      if (!attempt.outcome) continue;
      let archived: { outcome: ExtractionOutcome; ref: ExtractionOutcomeRef };
      try { archived = this.readOutcome(run.runId, attempt.attemptId, attempt.outcome); }
      catch (error) { if (missing(error)) throw new Error('Archived extraction outcome is missing.'); throw error; }
      if (attempt.attemptId === projected.attemptId) outcome = archived.outcome;
      if (attempt.accounting && (!attempt.budget
        || canonicalJson(attempt.accounting) !== canonicalJson(accountExtractionOutcome(archived.outcome, attempt.budget)))) {
        throw new Error('Extraction accounting differs from its archive.');
      }
    }
    if (run.runtime) {
      if (!selected && run.policy.policyId === 'knowledge-generation-bounded/v1' && !['failed', 'cancelled'].includes(run.status)) throw new Error('Unselected extraction runtime requires a terminal run.');
      if (!outcome || outcome.outcomeKind === 'exception') throw new Error('Extraction runtime has no returned result archive.');
      const result = outcome.result as Record<string, unknown>;
      for (const [key, value] of Object.entries(run.runtime)) if (value !== result[key]) throw new Error('Extraction runtime differs from its archive.');
    }
    if (!selected) return;
    if (!outcome || outcome.outcomeKind === 'exception' || outcome.result.output !== run.rawOutput) throw new Error('Selected extraction output differs from its archive.');
    if (outcome.outcomeKind === 'result' && !outcome.result.ok && ['prepared', 'completed'].includes(run.status)) throw new Error('Failed native output cannot be prepared.');
    if (selected.accounting?.status === 'policy_violation' && ['prepared', 'completed'].includes(run.status)) throw new Error('Budget policy violation cannot prepare knowledge.');
  }
  create(input: ExtractionRun): void {
    this.checkRoot();
    withWorkspaceWrite(this.workspace, () => {
      const run = this.check(input), path = this.path(run.runId);
      if (run.attempts.length !== 1) throw new Error('Extraction run must start with one invocation reservation.');
      try { lstatSync(path); throw Object.assign(new Error('Extraction run already exists.'), { code: 'EEXIST' }); }
      catch (error) { if (!missing(error)) throw error; }
      // Occupancy is checked by filename only; no v4 reader or migration exists.
      checkStorageDirectory(join(this.workspace, 'runs')); checkStorageDirectory(join(this.workspace, 'entities'));
      for (const occupied of [join(this.workspace, 'runs', `${run.runId}.json`), join(this.workspace, 'entities', `${run.runId}.json`)]) {
        try { lstatSync(occupied); throw new Error('Extraction run identity is already occupied.'); } catch (error) { if (!missing(error)) throw error; }
      }
      this.checkAllocation(run); this.checkArchived(run); this.publish(path, [JSON.stringify(run, null, 2)], true);
    });
  }
  read(runId: string): ExtractionRun {
    this.checkRoot(); const raw = parse(readBounded(this.path(runId), EXTRACTION_RUN_MAX_BYTES)); assertCurrentStorage(raw, 'run');
    const run = this.check(raw); if (run.runId !== runId) throw new Error('Extraction run identity mismatch.');
    this.checkArchived(run); return run;
  }
  list(): ExtractionRun[] {
    this.checkRoot(); return existsSync(this.root) ? readdirSync(this.root).filter(name => name.endsWith('.json')).sort().map(name => this.read(name.slice(0, -5))) : [];
  }
  save(input: ExtractionRun, expectedGeneration: number): void {
    this.checkRoot();
    withWorkspaceWrite(this.workspace, () => {
      const run = this.check(input), current = this.read(run.runId);
      if (canonicalJson(current) === canonicalJson(run)) { this.confirmPublication(this.path(run.runId)); return; }
      if (current.generation !== expectedGeneration || run.generation !== expectedGeneration + 1 || run.requestDigest !== current.requestDigest) throw new Error('Extraction run conflict.');
      for (const field of ['snapshotId', 'sourceVersion', 'origin', 'executor', 'model', 'promptVersion', 'promptHash', 'inputDigest', 'actor', 'startedAt', 'policy'] as const) {
        if (canonicalJson([run[field] ?? null]) !== canonicalJson([current[field] ?? null])) throw new Error('Extraction run identity conflict.');
      }
      if (current.status === 'completed' && run.status !== 'completed') throw new Error('Completed extraction run is terminal.');
      for (const field of ['rawOutput', 'runtime'] as const) {
        if (current[field] !== undefined && canonicalJson(run[field] ?? null) !== canonicalJson(current[field])) throw new Error(`Extraction ${field === 'runtime' ? 'runtime' : 'output'} differs from its persisted projection.`);
      }
      if (current.entityAnalysis || ['prepared', 'completed'].includes(current.status)) {
        for (const field of ['entityAnalysis', 'intents', 'rejections', 'entityRejections'] as const) {
          if (canonicalJson(run[field] ?? null) !== canonicalJson(current[field] ?? null)) throw new Error('Prepared extraction intents are immutable.');
        }
      }
      if (run.committed.length < current.committed.length || canonicalJson(run.committed.slice(0, current.committed.length)) !== canonicalJson(current.committed)) throw new Error('Committed extraction prefix is immutable.');
      if (run.attempts.length < current.attempts.length || run.attempts.length > current.attempts.length + 1) throw new Error('Extraction attempt prefix conflict.');
      const appended = run.attempts.length > current.attempts.length;
      if (appended && (current.policy.policyId === 'knowledge-generation-single/v1' || current.selectedAttemptId
        || current.entityAnalysis || ['prepared', 'completed'].includes(current.status))) throw new Error('Selected extraction run cannot append another attempt.');
      if (appended && (!current.attempts[current.attempts.length - 1].outcome || !current.attempts[current.attempts.length - 1].accounting)) throw new Error('Extraction predecessor is not archived and accounted.');
      for (const [index, previous] of current.attempts.entries()) {
        const next = run.attempts[index];
        const { outcome: oldOutcome, failure: oldFailure, wireDiagnostic: oldWire, accounting: oldAccounting, admission: oldAdmission, ...oldIdentity } = previous;
        const { outcome: nextOutcome, failure: nextFailure, wireDiagnostic: nextWire, accounting: nextAccounting, admission: nextAdmission, ...nextIdentity } = next;
        if (canonicalJson(oldIdentity) !== canonicalJson(nextIdentity)
          || (oldOutcome && canonicalJson(oldOutcome) !== canonicalJson(nextOutcome ?? null))
          || (oldFailure && canonicalJson(oldFailure) !== canonicalJson(nextFailure ?? null))
          || (oldWire && canonicalJson(oldWire) !== canonicalJson(nextWire ?? null))
          || (oldAccounting && canonicalJson(oldAccounting) !== canonicalJson(nextAccounting ?? null))
          || (oldAdmission && canonicalJson(oldAdmission) !== canonicalJson(nextAdmission ?? null))
          || (index < current.attempts.length - 1 && canonicalJson(previous) !== canonicalJson(next))) throw new Error('Extraction attempt conflict.');
      }
      if (current.selectedAttemptId && run.selectedAttemptId !== current.selectedAttemptId) throw new Error('Selected extraction attempt conflict.');
      if (appended) this.checkAllocation(run, current.attempts.length);
      this.checkArchived(run); this.publish(this.path(run.runId), [JSON.stringify(run, null, 2)], false);
    });
  }
  writeOutcome(runId: string, attemptId: string, input: ExtractionOutcome, maxBytes: number): ExtractionOutcomeRef {
    this.checkRoot(); const outcome = ExtractionOutcomeSchema.parse(input);
    return withWorkspaceWrite(this.workspace, () => {
      const run = this.read(runId), attempt = run.attempts.find(value => value.attemptId === attemptId);
      if (!attempt) throw new Error('Unknown extraction attempt.');
      const envelope = this.envelope(runId, attemptId, outcome), ref = measured(envelope, EXTRACTION_OUTCOME_MAX_BYTES);
      try {
        const existing = this.readOutcome(runId, attemptId);
        if (existing.ref.bytes !== ref.bytes || existing.ref.digest !== ref.digest) throw new Error('Extraction outcome identity conflict.');
        return existing.ref;
      } catch (error) { if (!missing(error)) throw error; }
      if (attempt.outcome) throw new Error('Archived extraction outcome is missing.');
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes !== attempt.producer.maxOutcomeJsonBytes) throw new Error('Extraction outcome reservation conflict.');
      measured(outcome, maxBytes);
      this.publish(this.outcomePath(runId, attemptId), jsonChunks(envelope), true); return ref;
    });
  }
  readOutcome(runId: string, attemptId: string, expected?: ExtractionOutcomeRef): { outcome: ExtractionOutcome; ref: ExtractionOutcomeRef } {
    this.checkRoot(); const raw = readBounded(this.outcomePath(runId, attemptId), EXTRACTION_OUTCOME_MAX_BYTES);
    const ref = { bytes: raw.length, digest: digest(raw) };
    if (expected) { const parsed = ExtractionOutcomeRefSchema.parse(expected); if (parsed.bytes !== ref.bytes || parsed.digest !== ref.digest) throw new Error('Extraction outcome integrity mismatch.'); }
    const parsed = parse(raw) as Record<string, unknown>;
    if (!parsed || Array.isArray(parsed) || Object.keys(parsed).length !== 5 || parsed.storeKind !== 'knowledge-extraction-attempt-outcome'
      || parsed.schemaVersion !== 1 || parsed.runId !== runId || parsed.attemptId !== attemptId) throw new Error('Extraction outcome identity mismatch.');
    const outcome = ExtractionOutcomeSchema.parse(parsed.outcome);
    if (!expected) {
      // Finish publication durability after an uncertain acknowledgement, before returning a recoverable ref.
      this.confirmPublication(this.outcomePath(runId, attemptId));
    }
    return { outcome, ref };
  }
}
