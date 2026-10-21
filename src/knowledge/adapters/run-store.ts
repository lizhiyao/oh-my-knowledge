import { createHash, randomUUID } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { constants, existsSync, lstatSync, readdirSync, openSync, closeSync, readSync, writeSync, fstatSync, fsyncSync, mkdirSync, linkSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../store.js';
import { ExtractionOutcomeSchema, ExtractionOutcomeRefSchema, ExtractionRunSchema,
  type ExtractionOutcome, type ExtractionOutcomeRef, type ExtractionRun, type ExtractionRunStore } from '../extraction/runs.js';
import { checkStorageDirectory, withWorkspaceWrite } from '../../evidence/storage/knowledge-workspace.js';
import { assertCurrentStorage } from './storage-state.js';
import { accountExtractionOutcome } from '../extraction/generation-policy.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../extraction/model-wire.js';
import { ExtractionRunSealIntentSchema, ExtractionRunSealMarkerSchema, ExtractionRunSealRequestSchema, ExtractionRunSealError,
  type ExtractionRunSealIntent, type ExtractionRunSealRequest, type ExtractionRunSealPreview, type ExtractionRunSealSummary } from '../extraction/run-sealing.js';

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
  private publish(path: string, chunks: Iterable<string | Uint8Array>, exclusive: boolean) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.checkRoot(); checkStorageDirectory(dirname(path));
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600);
      for (const chunk of chunks) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk); let offset = 0;
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
  private sealDirectory(namespace: 'current' | 'legacy', runId: string) {
    const parent = join(this.root, 'seals'), named = join(parent, namespace), directory = join(named, uuid.parse(runId));
    for (const path of [parent, named, directory]) checkStorageDirectory(path);
    return directory;
  }
  private sealEvidencePath(directory: string, name: string) {
    checkStorageDirectory(join(directory, 'evidence'));
    if (name !== 'manifest.json') checkStorageDirectory(join(directory, 'evidence', 'outcomes'));
    return join(directory, 'evidence', name);
  }
  private sealSourceRoot(namespace: 'current' | 'legacy') {
    const root = namespace === 'current' ? this.root : join(this.workspace, 'runs'); checkStorageDirectory(root); return root;
  }
  private sealSourcePath(namespace: 'current' | 'legacy', runId: string) { return join(this.sealSourceRoot(namespace), `${uuid.parse(runId)}.json`); }
  private sealIntent(namespace: 'current' | 'legacy', runId: string) {
    const path = join(this.sealDirectory(namespace, runId), 'intent.json');
    const bytes = readBounded(path, 1024 * 1024), intent = ExtractionRunSealIntentSchema.parse(parse(bytes));
    if (intent.request.runId !== runId || intent.request.storageNamespace !== namespace
      || digest(Buffer.from(canonicalJson(intent.files))) !== intent.request.expectedInventoryDigest) throw new ExtractionRunSealError('run_seal_conflict');
    return { intent, bytes, path };
  }
  private sealInventory(namespace: 'current' | 'legacy', runId: string) {
    const source = this.sealSourceRoot(namespace), manifest = this.sealSourcePath(namespace, runId);
    const names = ['manifest.json'];
    const parent = join(source, 'outcomes'), outcomes = join(parent, runId);
    checkStorageDirectory(parent); checkStorageDirectory(outcomes);
    if (existsSync(outcomes)) {
      const entries = readdirSync(outcomes).sort();
      if (entries.length > 64) throw new Error('Extraction seal inventory capacity exceeded.');
      for (const name of entries) {
        if (!name.endsWith('.json') || !uuid.safeParse(name.slice(0, -5)).success) throw new ExtractionRunSealError('run_seal_ineligible');
        names.push(`outcomes/${name}`);
      }
    }
    const files = names.map(name => {
      const bytes = readBounded(name === 'manifest.json' ? manifest : join(outcomes, name.slice(9)), name === 'manifest.json' ? EXTRACTION_RUN_MAX_BYTES : EXTRACTION_OUTCOME_MAX_BYTES);
      return { name, bytes: bytes.length, digest: digest(bytes) };
    });
    return { files, inventoryDigest: digest(Buffer.from(canonicalJson(files))) };
  }
  /** Does not decode native output or infer facts from an unsupported manifest's fields. */
  private sealCandidate(namespace: 'current' | 'legacy', runId: string): ExtractionRunSealPreview {
    const manifest = readBounded(this.sealSourcePath(namespace, runId), EXTRACTION_RUN_MAX_BYTES), raw = parse(manifest);
    if (ExtractionRunSealMarkerSchema.safeParse(raw).success) throw new ExtractionRunSealError('run_sealed');
    const entity = join(this.workspace, 'entities'); checkStorageDirectory(entity);
    try { lstatSync(join(entity, `${runId}.json`)); throw new ExtractionRunSealError('run_seal_ineligible'); }
    catch (error) { if (!missing(error)) throw error; }
    let scope: ExtractionRunSealIntent['evidenceScope'] = 'opaque-unsupported-schema';
    const header = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (header.runKind === 'knowledge-extraction-run' && header.schemaVersion === 5) {
      const run = this.check(raw);
      if (run.runId !== runId || ['prepared', 'completed'].includes(run.status) || run.entityAnalysis
        || run.intents.length || run.committed.length || run.attempts.some(attempt => !attempt.outcome
          || attempt.request.outputMode !== 'json-schema' || attempt.request.wireId === WINDOW_EXTRACTION_WIRE_ID)) throw new ExtractionRunSealError('run_seal_ineligible');
      this.checkArchived(run);
      scope = 'current-old-wire';
    } else {
      // Envelope recognition is not a legacy reader. Unknown/malformed data is not silently downgraded.
      if (header.runKind !== 'knowledge-extraction-run' || !Number.isInteger(header.schemaVersion)
        || Number(header.schemaVersion) < 1 || Number(header.schemaVersion) >= 5
        || (header.runId !== undefined && header.runId !== runId)) throw new ExtractionRunSealError('run_seal_ineligible');
    }
    const inventory = this.sealInventory(namespace, runId);
    if (inventory.files[0].digest !== digest(manifest)) throw new ExtractionRunSealError('run_seal_conflict');
    if (scope === 'current-old-wire') {
      const run = this.check(raw), expected = run.attempts.map(attempt => `outcomes/${attempt.attemptId}.json`).sort();
      if (canonicalJson(inventory.files.slice(1).map(file => file.name)) !== canonicalJson(expected)) throw new ExtractionRunSealError('run_seal_ineligible');
    }
    return { state: 'unsealed', runId, storageNamespace: namespace, evidenceScope: scope, expectedManifestDigest: digest(manifest),
      expectedInventoryDigest: inventory.inventoryDigest, files: inventory.files, offlineDeclarationRequired: scope === 'opaque-unsupported-schema', executionStatus: 'unknown' };
  }
  /** Explicit query; pending intents never acquire the sealed state without a bound source marker. */
  inspectSeal(runId: string, namespace: 'current' | 'legacy' = 'current'): ExtractionRunSealPreview | ExtractionRunSealSummary {
    this.checkRoot(); uuid.parse(runId);
    let record: ReturnType<FileExtractionRunStore['sealIntent']>;
    try { record = this.sealIntent(namespace, runId); }
    catch (error) { if (!missing(error)) throw error; return this.sealCandidate(namespace, runId); }
    const { intent, bytes } = record;
    {
      const raw = readBounded(this.sealSourcePath(namespace, runId), EXTRACTION_RUN_MAX_BYTES), marker = ExtractionRunSealMarkerSchema.safeParse(parse(raw));
      if (marker.success) {
        if (marker.data.runId !== runId || marker.data.storageNamespace !== namespace || marker.data.operationId !== intent.request.operationId
          || marker.data.intentDigest !== digest(bytes)) throw new ExtractionRunSealError('run_seal_conflict');
      } else if (digest(raw) !== intent.request.expectedManifestDigest) throw new ExtractionRunSealError('run_seal_conflict');
      let originalRun: ExtractionRun | undefined;
      if (intent.evidenceScope === 'current-old-wire') {
        const original = marker.success ? readBounded(this.sealEvidencePath(this.sealDirectory(namespace, runId), 'manifest.json'), EXTRACTION_RUN_MAX_BYTES) : raw;
        if (digest(original) !== intent.request.expectedManifestDigest) throw new ExtractionRunSealError('run_seal_conflict');
        originalRun = this.check(parse(original));
        if (originalRun.runId !== runId) throw new ExtractionRunSealError('run_seal_conflict');
      }
      return { ...intent, state: marker.success ? 'sealed' : 'pending', evidenceIntegrity: 'not_checked', ...(originalRun ? { originalRun } : {}) };
    }
  }
  listSeals(): ExtractionRunSealSummary[] {
    this.checkRoot(); const parent = join(this.root, 'seals'); checkStorageDirectory(parent);
    if (!existsSync(parent)) return [];
    const result: ExtractionRunSealSummary[] = [];
    for (const namespace of readdirSync(parent).sort()) {
      if (namespace !== 'current' && namespace !== 'legacy') throw new ExtractionRunSealError('run_seal_conflict');
      const directory = join(parent, namespace); checkStorageDirectory(directory);
      for (const runId of readdirSync(directory).sort()) {
        const intentPath = join(this.sealDirectory(namespace, uuid.parse(runId)), 'intent.json');
        try { lstatSync(intentPath); } catch (error) { if (missing(error)) continue; throw error; }
        const state = this.inspectSeal(uuid.parse(runId), namespace);
        if (state.state === 'unsealed') throw new ExtractionRunSealError('run_seal_conflict');
        result.push(state);
      }
    }
    return result;
  }
  /** Same request only, under the existing workspace write lock. No migration, decoder, or producer. */
  seal(input: ExtractionRunSealRequest): ExtractionRunSealSummary {
    this.checkRoot(); const request = ExtractionRunSealRequestSchema.parse(input);
    return withWorkspaceWrite(this.workspace, () => {
      const { runId, storageNamespace: namespace } = request, directory = this.sealDirectory(namespace, runId);
      let existing: ReturnType<FileExtractionRunStore['sealIntent']> | undefined;
      try { existing = this.sealIntent(namespace, runId); } catch (error) { if (!missing(error)) throw error; }
      if (existing && canonicalJson(existing.intent.request) !== canonicalJson(request)) throw new ExtractionRunSealError('run_seal_conflict');
      let state: ExtractionRunSealPreview | ExtractionRunSealSummary;
      if (existing) {
        const raw = parse(readBounded(this.sealSourcePath(namespace, runId), EXTRACTION_RUN_MAX_BYTES));
        state = ExtractionRunSealMarkerSchema.safeParse(raw).success ? this.inspectSeal(runId, namespace) : this.sealCandidate(namespace, runId);
      } else state = this.sealCandidate(namespace, runId);
      if (state.state === 'unsealed' && (state.expectedManifestDigest !== request.expectedManifestDigest
        || state.expectedInventoryDigest !== request.expectedInventoryDigest || state.offlineDeclarationRequired && !request.offlineDeclared)) throw new ExtractionRunSealError('run_seal_conflict');
      const intent = existing?.intent ?? ExtractionRunSealIntentSchema.parse({ storeKind: 'knowledge-extraction-seal-intent', schemaVersion: 1, request,
        recordedAt: new Date().toISOString(), evidenceScope: state.evidenceScope, disposition: 'human_sealed', executionStatus: 'unknown', files: state.files });
      const intentPath = join(directory, 'intent.json');
      if (!existing) { this.publish(intentPath, [JSON.stringify(intent, null, 2)], true); existing = this.sealIntent(namespace, runId); }
      else this.confirmPublication(intentPath);
      // Each original byte sequence is copied, durably confirmed, and identity checked before marker publication.
      for (const file of intent.files) {
        const target = this.sealEvidencePath(directory, file.name);
        let copied: Buffer | undefined;
        try { copied = readBounded(target, file.name === 'manifest.json' ? EXTRACTION_RUN_MAX_BYTES : EXTRACTION_OUTCOME_MAX_BYTES); }
        catch (error) { if (!missing(error)) throw error; }
        if (!copied) {
          if (state.state !== 'unsealed') throw new ExtractionRunSealError('run_seal_conflict');
          const source = file.name === 'manifest.json' ? this.sealSourcePath(namespace, runId)
            : join(this.sealSourceRoot(namespace), 'outcomes', runId, file.name.slice(9));
          copied = readBounded(source, file.name === 'manifest.json' ? EXTRACTION_RUN_MAX_BYTES : EXTRACTION_OUTCOME_MAX_BYTES);
          if (copied.length !== file.bytes || digest(copied) !== file.digest) throw new ExtractionRunSealError('run_seal_conflict');
          this.publish(target, [copied], true);
        }
        if (copied.length !== file.bytes || digest(copied) !== file.digest) throw new ExtractionRunSealError('run_seal_conflict');
        this.confirmPublication(target);
      }
      const marker = { storeKind: 'knowledge-extraction-seal-marker', schemaVersion: 1, runId, storageNamespace: namespace,
        operationId: request.operationId, intentDigest: digest(existing.bytes) };
      if (state.state === 'unsealed') {
        // All durable copies/intent precede this last identity CAS and the atomic occupancy marker.
        const final = this.sealCandidate(namespace, runId);
        if (final.expectedManifestDigest !== request.expectedManifestDigest || final.expectedInventoryDigest !== request.expectedInventoryDigest
          || final.evidenceScope !== intent.evidenceScope) throw new ExtractionRunSealError('run_seal_conflict');
        this.publish(this.sealSourcePath(namespace, runId), [JSON.stringify(marker, null, 2)], false);
      } else {
        if (canonicalJson(parse(readBounded(this.sealSourcePath(namespace, runId), EXTRACTION_RUN_MAX_BYTES))) !== canonicalJson(marker)) throw new ExtractionRunSealError('run_seal_conflict');
        this.confirmPublication(this.sealSourcePath(namespace, runId));
      }
      const result = this.inspectSeal(runId, namespace);
      if (result.state !== 'sealed') throw new ExtractionRunSealError('run_seal_conflict');
      return result;
    });
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
  private manifestValue(runId: string, raw: unknown): ExtractionRun {
    assertCurrentStorage(raw, 'run');
    const run = this.check(raw); if (run.runId !== runId) throw new Error('Extraction run identity mismatch.');
    return run;
  }
  readManifest(runId: string): ExtractionRun {
    this.checkRoot(); return this.manifestValue(runId, parse(readBounded(this.path(runId), EXTRACTION_RUN_MAX_BYTES)));
  }
  read(runId: string): ExtractionRun {
    this.checkRoot(); let intent: ReturnType<FileExtractionRunStore['sealIntent']> | undefined;
    try { intent = this.sealIntent('current', runId); } catch (error) { if (!missing(error)) throw error; }
    if (intent) throw new ExtractionRunSealError(this.inspectSeal(runId).state === 'sealed' ? 'run_sealed' : 'run_seal_pending');
    const run = this.readManifest(runId); this.checkArchived(run); return run;
  }
  listManifests(): ExtractionRun[] {
    this.checkRoot(); return existsSync(this.root) ? readdirSync(this.root).filter(name => name.endsWith('.json')).sort().flatMap(name => {
      const runId = name.slice(0, -5), raw = parse(readBounded(this.path(runId), EXTRACTION_RUN_MAX_BYTES));
      const marker = ExtractionRunSealMarkerSchema.safeParse(raw);
      if (marker.success) {
        const { intent, bytes } = this.sealIntent('current', runId);
        if (marker.data.runId !== runId || marker.data.storageNamespace !== 'current' || marker.data.operationId !== intent.request.operationId
          || marker.data.intentDigest !== digest(bytes)) throw new ExtractionRunSealError('run_seal_conflict');
        return [];
      }
      return [this.manifestValue(runId, raw)];
    }) : [];
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
      if (current.status === 'failed' && run.status !== 'failed') throw new Error('Failed extraction run is terminal.');
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
      if (appended && current.status === 'failed') throw new Error('Failed extraction run cannot append another attempt.');
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
