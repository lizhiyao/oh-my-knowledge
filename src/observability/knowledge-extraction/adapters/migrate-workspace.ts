import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalJson, KnowledgeEnvelopeSchema } from '../../../knowledge/store.js';
import { validateKnowledgeHistory } from '../../../knowledge/history.js';
import { writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { withFileLock } from '../../../shared/file-lock.js';
import { ExtractionRunSchema } from '../runs.js';
import { checkStorageDirectory, KnowledgeStorageStateError, MIGRATION_STATE_FILE, MigrationStateSchema,
  readMigrationState, recoverStorageLock, storageLockState, WORKSPACE_LOCK_FILE } from './storage-state.js';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const relativeFile = z.string().regex(/^(?:items\/[a-f0-9]{64}|runs\/[a-f0-9-]{36})\.json$/);
const entrySchema = z.strictObject({ relativePath: relativeFile,
  originalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), targetDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  migrate: z.boolean(), mode: z.number().int().min(0).max(0o777) });
const journalSchema = MigrationStateSchema.extend({ workspace: z.string().min(1),
  status: z.enum(['prepared', 'completed']), entries: z.array(entrySchema).max(2048) });
type Entry = z.infer<typeof entrySchema>;
type Journal = z.infer<typeof journalSchema>;
interface PlannedFile extends Entry { original: Buffer; target: string }
export interface KnowledgeMigrationPreview {
  status: 'preview' | 'current' | 'resume_required' | 'completed';
  requiresMigration: boolean; items: number; runs: number; alreadyCurrent: number; bytes: number; previewDigest: string;
}

function readBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid migration input file.');
  return readFileSync(path);
}
function convert(relativePath: string, bytes: Buffer): { target: string; migrate: boolean } {
  const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  let candidate: unknown; let migrate: boolean;
  if (relativePath.startsWith('items/')) {
    migrate = raw.schemaVersion === 1;
    if (migrate && (!Array.isArray(raw.grounding) || raw.grounding.some(value => value && typeof value === 'object' && 'entityAnalysisRef' in value))) {
      throw new Error('Legacy knowledge has unexpected entity fields.');
    }
    candidate = migrate ? { ...raw, schemaVersion: 2 } : raw;
    const parsed = KnowledgeEnvelopeSchema.parse(candidate); validateKnowledgeHistory(parsed);
    if (relativePath !== `items/${digest(canonicalJson([parsed.namespace, parsed.knowledgeId])).slice(7)}.json`) throw new Error('Migration knowledge filename identity mismatch.');
    if (canonicalJson(candidate) !== canonicalJson(parsed)) throw new Error('Migration would change knowledge content.');
  } else {
    migrate = raw.runKind === undefined && raw.schemaVersion === undefined;
    if (migrate && (raw.entityAnalysis !== undefined || raw.entityRejections !== undefined
      || !['knowledge-extraction-v1', 'knowledge-extraction-v2', 'knowledge-local-rules-v1'].includes(String(raw.promptVersion)))) {
      throw new Error('Unsupported legacy extraction run.');
    }
    candidate = migrate ? { ...raw, runKind: 'knowledge-extraction-run', schemaVersion: 2 } : raw;
    const parsed = ExtractionRunSchema.parse(candidate);
    if (relativePath !== `runs/${parsed.runId}.json`) throw new Error('Migration run filename identity mismatch.');
    if (canonicalJson(candidate) !== canonicalJson(parsed)) throw new Error('Migration would change extraction content.');
  }
  return { target: JSON.stringify(candidate, null, 2), migrate };
}
function canonicalRoot(root: string): string {
  if (!root.trim()) throw new Error('Explicit knowledge workspace required.');
  const path = resolve(root); checkStorageDirectory(path);
  return existsSync(path) ? realpathSync(path) : path;
}
function plan(root: string): PlannedFile[] {
  const entries: PlannedFile[] = []; let totalBytes = 0;
  for (const directory of ['items', 'runs']) {
    const folder = join(root, directory); checkStorageDirectory(folder);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).sort()) {
      if (name.endsWith('.lock') && storageLockState(join(folder, name)) === 'busy') throw new KnowledgeStorageStateError('knowledge_workspace_busy');
      if (!name.endsWith('.json')) continue;
      const relativePath = relativeFile.parse(`${directory}/${name}`); const path = join(root, relativePath);
      const original = readBytes(path); totalBytes += original.length;
      if (entries.length >= 2048 || totalBytes > 256 * 1024 * 1024) throw new Error('Migration capacity exceeded.');
      const converted = convert(relativePath, original);
      entries.push({ relativePath, original, target: converted.target, migrate: converted.migrate,
        originalDigest: digest(original), targetDigest: converted.migrate ? digest(converted.target) : digest(original), mode: lstatSync(path).mode & 0o777 });
    }
  }
  return entries;
}
function projection(files: readonly Entry[], status: KnowledgeMigrationPreview['status'], bytes: number): KnowledgeMigrationPreview {
  return { status, requiresMigration: status === 'resume_required' || files.some(file => file.migrate),
    items: files.filter(file => file.migrate && file.relativePath.startsWith('items/')).length,
    runs: files.filter(file => file.migrate && file.relativePath.startsWith('runs/')).length,
    alreadyCurrent: files.filter(file => !file.migrate).length, bytes,
    previewDigest: digest(canonicalJson(files.map(({ relativePath, originalDigest, targetDigest, migrate, mode }) => ({ relativePath, originalDigest, targetDigest, migrate, mode })))) };
}
export function previewKnowledgeMigration(workspace: string): KnowledgeMigrationPreview {
  const root = canonicalRoot(workspace);
  if (readMigrationState(root)) return projection([], 'resume_required', 0);
  if (storageLockState(join(root, WORKSPACE_LOCK_FILE)) === 'busy') throw new KnowledgeStorageStateError('knowledge_workspace_busy');
  const files = plan(root);
  return projection(files, files.some(file => file.migrate) ? 'preview' : 'current', files.reduce((sum, file) => sum + file.original.length, 0));
}
function backupRoot(root: string, requested: string): string {
  if (!isAbsolute(requested)) throw new Error('Use an absolute external backup directory.');
  const path = join(realpathSync(dirname(resolve(requested))), resolve(requested).split(sep).at(-1)!);
  const location = relative(root, path);
  if (!location || (!location.startsWith(`..${sep}`) && location !== '..' && !isAbsolute(location))) throw new Error('Backup must be outside the knowledge workspace.');
  checkStorageDirectory(path); return path;
}
function originalPath(backup: string, entry: Entry): string {
  const parent = join(backup, 'originals', dirname(entry.relativePath));
  checkStorageDirectory(join(backup, 'originals')); checkStorageDirectory(parent);
  return join(backup, 'originals', entry.relativePath);
}
function readJournal(backup: string): Journal {
  const path = join(backup, 'migration.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid migration journal.');
  const journal = journalSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (new Set(journal.entries.map(entry => entry.relativePath)).size !== journal.entries.length) throw new Error('Duplicate migration entry.');
  return journal;
}
function publish(path: string, bytes: string | Buffer, mode: number, exclusive = false) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode }); chmodSync(temporary, mode);
    if (exclusive) linkSync(temporary, path); else renameSync(temporary, path);
  }
  finally { rmSync(temporary, { force: true }); }
}

/** Offline, resumable conversion. It never infers that an old writer has stopped from a run status. */
export function migrateKnowledgeWorkspace(workspace: string, requestedBackup: string, previewDigest?: string): KnowledgeMigrationPreview {
  const root = canonicalRoot(workspace); const backup = backupRoot(root, requestedBackup);
  const gate = join(root, WORKSPACE_LOCK_FILE); recoverStorageLock(gate);
  return withFileLock(gate, () => {
    const state = readMigrationState(root);
    let journal: Journal;
    if (existsSync(backup)) {
      journal = readJournal(backup);
      if (journal.workspace !== root || journal.backupDirectory !== backup) throw new Error('Migration backup belongs to another workspace.');
      if (state && (state.migrationId !== journal.migrationId || state.backupDirectory !== backup)) throw new Error('Migration backup identity conflict.');
    } else {
      if (state) throw new Error('Resume using the original migration backup directory.');
      const files = plan(root); const preview = projection(files, 'preview', files.reduce((sum, file) => sum + file.original.length, 0));
      if (previewDigest && preview.previewDigest !== previewDigest) throw new Error('Migration preview conflict.');
      if (!files.some(file => file.migrate)) return { ...preview, status: 'current', requiresMigration: false };
      mkdirSync(backup, { mode: 0o700 });
      journal = { migrationKind: 'entity-storage-v2', schemaVersion: 1, migrationId: randomUUID(), backupDirectory: backup,
        workspace: root, status: 'prepared', entries: files.map(({ relativePath, originalDigest, targetDigest, migrate, mode }) => ({ relativePath, originalDigest, targetDigest, migrate, mode })) };
      writeJsonFileAtomic(join(backup, 'migration.json'), journal);
      for (const file of files.filter(file => file.migrate)) {
        const path = originalPath(backup, file); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        publish(path, file.original, 0o600, true);
      }
    }
    const current = plan(root);
    if (journal.status === 'prepared') {
      if (current.length !== journal.entries.length || current.some(file => !journal.entries.some(entry => entry.relativePath === file.relativePath))) throw new Error('Migration workspace file conflict.');
      for (const entry of journal.entries) {
        const path = join(root, entry.relativePath); const actual = digest(readBytes(path));
        if (actual !== entry.originalDigest && actual !== entry.targetDigest) throw new Error('Migration source content conflict.');
        if ((lstatSync(path).mode & 0o777) !== entry.mode) throw new Error('Migration source permission conflict.');
      }
    }
    const targets = new Map<string, string>();
    for (const entry of journal.entries.filter(entry => entry.migrate)) {
      const backupPath = originalPath(backup, entry);
      if (!existsSync(backupPath) && journal.status === 'prepared') {
        const bytes = readBytes(join(root, entry.relativePath));
        if (digest(bytes) !== entry.originalDigest) throw new Error('Missing original migration backup.');
        mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 }); publish(backupPath, bytes, 0o600, true);
      }
      const original = readBytes(backupPath);
      if (digest(original) !== entry.originalDigest) throw new Error('Migration backup integrity mismatch.');
      const converted = convert(entry.relativePath, original);
      if (!converted.migrate || digest(converted.target) !== entry.targetDigest) throw new Error('Migration backup conversion mismatch.');
      targets.set(entry.relativePath, converted.target);
    }
    if (journal.status === 'completed') {
      if (current.some(file => file.migrate)) throw new Error('Use a fresh backup for additional legacy data.');
      if (state) rmSync(join(root, MIGRATION_STATE_FILE));
      return { ...projection(journal.entries, 'completed', 0), requiresMigration: false };
    }
    writeJsonFileAtomic(join(root, MIGRATION_STATE_FILE), {
      migrationKind: journal.migrationKind, schemaVersion: journal.schemaVersion, migrationId: journal.migrationId, backupDirectory: journal.backupDirectory,
    });
    for (const entry of journal.entries.filter(entry => entry.migrate)) {
      const path = join(root, entry.relativePath); const lock = `${path}.lock`; recoverStorageLock(lock);
      withFileLock(lock, () => {
        const actual = digest(readBytes(path));
        if (actual === entry.targetDigest) return;
        if (actual !== entry.originalDigest) throw new Error('Migration source content conflict.');
        if ((lstatSync(path).mode & 0o777) !== entry.mode) throw new Error('Migration source permission conflict.');
        publish(path, targets.get(entry.relativePath)!, entry.mode);
      }, { recoverStale: false, label: 'knowledge migration file' });
    }
    const completed = plan(root);
    if (completed.length !== journal.entries.length || completed.some(file => file.migrate
      || !journal.entries.some(entry => entry.relativePath === file.relativePath && entry.targetDigest === file.originalDigest && entry.mode === file.mode))) throw new Error('Migration completion conflict.');
    writeJsonFileAtomic(join(backup, 'migration.json'), { ...journal, status: 'completed' });
    rmSync(join(root, MIGRATION_STATE_FILE));
    return { ...projection(journal.entries, 'completed', completed.reduce((sum, file) => sum + file.original.length, 0)), requiresMigration: false };
  }, { recoverStale: false, label: 'knowledge workspace migration' });
}
