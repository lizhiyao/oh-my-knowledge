import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication } from '../../src/observability/knowledge-extraction/application.js';
import { FileKnowledgeStore } from '../../src/observability/knowledge-extraction/adapters/knowledge-store.js';
import { FileExtractionRunStore } from '../../src/observability/knowledge-extraction/adapters/run-store.js';
import { FileEntityAnalysisStore } from '../../src/observability/knowledge-extraction/adapters/entity-store.js';
import { FileKnowledgeTags } from '../../src/observability/knowledge-extraction/adapters/knowledge-tags.js';
import { TraceEvidenceStore } from '../../src/observability/knowledge-extraction/adapters/trace-evidence.js';
import { migrateKnowledgeWorkspace, previewKnowledgeMigration } from '../../src/observability/knowledge-extraction/adapters/migrate-workspace.js';
import { MIGRATION_STATE_FILE, recoverStorageLock, storageLockState, WORKSPACE_LOCK_FILE } from '../../src/observability/knowledge-extraction/adapters/storage-state.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { modelProposal } from './fixtures.js';

const faults = vi.hoisted(() => ({ renamedPath: '', failAfterRename: false, beforeRecovery: undefined as (() => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: (path: string, flags: string) => {
    if (path.includes('.recovery-') && faults.beforeRecovery) {
      const operation = faults.beforeRecovery; faults.beforeRecovery = undefined; operation();
    }
    return fs.openSync(path, flags);
  }, renameSync: (from: string, to: string) => {
    fs.renameSync(from, to);
    if (faults.failAfterRename && to === faults.renamedPath) {
      faults.failAfterRename = false; throw new Error('simulated lost rename acknowledgement');
    }
  } };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); faults.failAfterRename = false; faults.beforeRecovery = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function setup() {
  const parent = mkdtempSync(join(tmpdir(), 'omk-entity-migration-')); roots.push(parent);
  const root = join(parent, 'workspace'); const backup = join(parent, 'backup');
  const source = join(parent, 'trace.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root);
  const runs = new FileExtractionRunStore(join(root, 'runs'), root);
  const entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const evidence = new TraceEvidenceStore(join(root, 'sources'));
  const actor = { actorKind: 'human' as const, actorId: 'local-user' };
  const app = new KnowledgeApplication({ evidence, knowledge, runs, entities, tags: new FileKnowledgeTags(join(root, 'tags'), 'local'), actor, id: randomUUID,
    now: () => '2026-10-08T00:00:00Z', hash: value => sha(canonicalJson(value)) });
  const snapshot = app.capture({ path: source }); const runId = randomUUID();
  runs.create({ runKind: 'knowledge-extraction-run', schemaVersion: 2, runId, generation: 1,
    requestDigest: 'preserved-request', snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion,
    origin: snapshot.origin, executor: 'fixture', model: 'fixture-model', promptVersion: 'knowledge-extraction-v2',
    promptHash: 'frozen-legacy-prompt', inputDigest: 'frozen-legacy-input', actor,
    startedAt: '2026-10-08T00:00:00Z', status: 'generating', rejections: [], intents: [], committed: [],
    rawOutput: JSON.stringify({ proposals: [modelProposal()] }).replaceAll('record-1', snapshot.excerpts[0].evidenceRef),
    runtime: { durationMs: 5, inputTokens: 123, outputTokens: 456 } });
  const originalWrite = knowledge.write.bind(knowledge);
  const spy = vi.spyOn(knowledge, 'write').mockImplementationOnce((command, author) => {
    originalWrite(command, author); throw new Error('lost write acknowledgement');
  });
  expect(() => app.resume(runId)).toThrow('lost write acknowledgement'); spy.mockRestore();
  const item = join(root, 'items', readdirSync(join(root, 'items')).find(name => name.endsWith('.json'))!);
  const run = join(root, 'runs', `${runId}.json`);
  const itemData = JSON.parse(readFileSync(item, 'utf8')); itemData.schemaVersion = 1;
  writeFileSync(item, JSON.stringify(itemData)); chmodSync(item, 0o600);
  const runData = JSON.parse(readFileSync(run, 'utf8')); delete runData.runKind; delete runData.schemaVersion;
  writeFileSync(run, JSON.stringify(runData)); chmodSync(run, 0o640);
  const originals = new Map([[item, readFileSync(item)], [run, readFileSync(run)]]);
  return { parent, root, backup, app, knowledge, runs, entities, item, run, runId, originals, itemData, runData };
}

describe('explicit entity storage migration', () => {
  it('previews without writes, preserves exact backups and identity/history, and resumes a previously committed legacy intent', () => {
    const f = setup();
    expect(() => f.knowledge.list()).toThrow('knowledge_migration_required');
    expect(() => f.runs.read(f.runId)).toThrow('knowledge_migration_required');
    const preview = previewKnowledgeMigration(f.root);
    expect(preview).toMatchObject({ status: 'preview', items: 1, runs: 1, alreadyCurrent: 0 });
    expect(existsSync(f.backup)).toBe(false);
    for (const [path, bytes] of f.originals) expect(readFileSync(path)).toEqual(bytes);
    expect(migrateKnowledgeWorkspace(f.root, f.backup, preview.previewDigest)).toMatchObject({ status: 'completed', requiresMigration: false });
    const current = f.knowledge.list()[0];
    expect(current).toEqual({ ...f.itemData, schemaVersion: 2 });
    expect(f.runs.read(f.runId)).toEqual({ ...f.runData, runKind: 'knowledge-extraction-run', schemaVersion: 2 });
    for (const [path, bytes] of f.originals) {
      expect(readFileSync(join(f.backup, 'originals', path.slice(f.root.length + 1)))).toEqual(bytes);
    }
    expect(lstatSync(f.item).mode & 0o777).toBe(0o600);
    expect(lstatSync(f.run).mode & 0o777).toBe(0o640);
    expect(existsSync(join(f.root, MIGRATION_STATE_FILE))).toBe(false);
    expect(f.app.resume(f.runId)).toMatchObject({ status: 'completed', committed: [{ knowledgeId: current.knowledgeId, revisionId: current.writeHeadRevisionId }] });
    expect(f.knowledge.read(current.knowledgeId).generation).toBe(1);
    expect(f.app.detail(current.knowledgeId).grounding.entityAnalysisRef).toBeUndefined();
    expect(migrateKnowledgeWorkspace(f.root, f.backup).status).toBe('completed');
    expect(previewKnowledgeMigration(f.root)).toMatchObject({ status: 'current', requiresMigration: false });
  });
  it('refuses invalid content before creating a backup or converting any file', () => {
    const f = setup(); writeFileSync(f.run, '{broken');
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow();
    expect(existsSync(f.backup)).toBe(false);
    expect(readFileSync(f.item)).toEqual(f.originals.get(f.item));
    expect(existsSync(join(f.root, WORKSPACE_LOCK_FILE))).toBe(false);
  });
  it('refuses a stale preview before backup creation', () => {
    const f = setup(); const preview = previewKnowledgeMigration(f.root);
    writeFileSync(f.item, JSON.stringify(f.itemData, null, 2));
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup, preview.previewDigest)).toThrow('preview conflict');
    expect(existsSync(f.backup)).toBe(false);
    expect(JSON.parse(readFileSync(f.item, 'utf8')).schemaVersion).toBe(1);
  });
  it('requires an external, explicit backup and refuses symlinks or unrelated directories', () => {
    const f = setup();
    expect(() => migrateKnowledgeWorkspace(f.root, join(f.root, 'backup'))).toThrow('outside');
    expect(() => migrateKnowledgeWorkspace(f.root, 'relative')).toThrow('absolute');
    const alias = join(f.parent, 'alias'); symlinkSync(f.root, alias);
    expect(() => previewKnowledgeMigration(alias)).toThrow('directory');
    symlinkSync(f.root, f.backup);
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow('directory');
    rmSync(f.backup); symlinkSync(f.parent, join(f.root, 'items', 'alias.json'));
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow();
    expect(readFileSync(f.item)).toEqual(f.originals.get(f.item));
  });
  it('keeps a migration pending after a lost commit acknowledgement, gates all current readers/writers, then resumes exactly', () => {
    const f = setup(); faults.renamedPath = realpathSync(f.item); faults.failAfterRename = true;
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow('lost rename acknowledgement');
    expect(JSON.parse(readFileSync(f.item, 'utf8')).schemaVersion).toBe(2);
    expect(JSON.parse(readFileSync(f.run, 'utf8')).schemaVersion).toBeUndefined();
    expect(previewKnowledgeMigration(f.root).status).toBe('resume_required');
    expect(() => f.knowledge.list()).toThrow('knowledge_migration_incomplete');
    expect(() => f.runs.read(f.runId)).toThrow('knowledge_migration_incomplete');
    expect(() => f.entities.read(f.runId)).toThrow('knowledge_migration_incomplete');
    expect(() => f.knowledge.write({ requestId: 'no-write', knowledgeId: f.itemData.knowledgeId, expectedGeneration: 1,
      commandKind: 'record_maintenance', maintenance: { revisionId: f.itemData.writeHeadRevisionId, actor: f.runData.actor,
        at: '2026-10-08T00:00:00Z', reason: 'blocked', choice: 'retain' } }, f.runData.actor)).toThrow('knowledge_migration_incomplete');
    expect(() => migrateKnowledgeWorkspace(f.root, join(f.parent, 'wrong-backup'))).toThrow('original migration backup');
    expect(migrateKnowledgeWorkspace(f.root, f.backup).status).toBe('completed');
    expect(f.app.resume(f.runId).status).toBe('completed');
    expect(readdirSync(dirname(f.item))).toEqual([f.item.slice(f.item.lastIndexOf('/') + 1)]);
  });
  it('refuses changed source content or damaged backup after interruption without overwriting evidence', () => {
    const f = setup(); faults.renamedPath = realpathSync(f.item); faults.failAfterRename = true;
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow();
    const modified = JSON.stringify({ ...f.runData, error: 'changed by another writer' });
    writeFileSync(f.run, modified);
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow('source content conflict');
    expect(readFileSync(f.run, 'utf8')).toBe(modified);
    writeFileSync(f.run, f.originals.get(f.run)!);
    writeFileSync(join(f.backup, 'originals', 'items', f.item.slice(f.item.lastIndexOf('/') + 1)), 'broken');
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow('backup integrity');
    expect(readFileSync(f.run)).toEqual(f.originals.get(f.run));
    expect(existsSync(join(f.root, MIGRATION_STATE_FILE))).toBe(true);
  });
  it('repairs a missing backup only while the exact original is still available', () => {
    const f = setup(); faults.renamedPath = realpathSync(f.item); faults.failAfterRename = true;
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow();
    const runBackup = join(f.backup, 'originals', 'runs', `${f.runId}.json`); rmSync(runBackup);
    expect(migrateKnowledgeWorkspace(f.root, f.backup).status).toBe('completed');
    expect(readFileSync(runBackup)).toEqual(f.originals.get(f.run));
    rmSync(join(f.backup, 'originals', 'items', f.item.slice(f.item.lastIndexOf('/') + 1)));
    expect(() => migrateKnowledgeWorkspace(f.root, f.backup)).toThrow();
  });
  it('does not infer dead writers from extraction status or lock age', () => {
    const f = setup();
    const lock = `${f.item}.lock`; const owner = { owner: randomUUID(), pid: process.pid, hostname: hostname(), acquiredAt: '2000-01-01T00:00:00Z' };
    writeFileSync(lock, JSON.stringify(owner));
    expect(() => previewKnowledgeMigration(f.root)).toThrow('knowledge_workspace_busy');
    recoverStorageLock(lock); expect(existsSync(lock)).toBe(true);
    writeFileSync(lock, JSON.stringify({ ...owner, hostname: 'unverifiable-remote-host' }));
    expect(storageLockState(lock)).toBe('busy');
    writeFileSync(lock, '{}'); expect(storageLockState(lock)).toBe('busy');
    expect(readFileSync(f.item)).toEqual(f.originals.get(f.item));
  });
  it('recovers a lock from a proven exited local process without removing a new live owner', () => {
    const f = setup(); const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(dead.status).toBe(0);
    const lock = join(f.root, WORKSPACE_LOCK_FILE);
    const owner = randomUUID();
    writeFileSync(lock, JSON.stringify({ owner, pid: dead.pid, hostname: hostname(), acquiredAt: '2026-10-08T00:00:00Z' }));
    // A recovery process may itself exit. Its recovery guard must also recover.
    const guard = `${lock}.recovery-${owner}.lock`;
    writeFileSync(guard, JSON.stringify({ owner: randomUUID(), pid: dead.pid, hostname: hostname(), acquiredAt: '2026-10-08T00:00:00Z' }));
    expect(storageLockState(lock)).toBe('dead');
    expect(migrateKnowledgeWorkspace(f.root, f.backup).status).toBe('completed');
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(guard)).toBe(false);
    const bytes = JSON.stringify({ owner: randomUUID(), pid: process.pid, hostname: hostname(), acquiredAt: '2026-10-08T00:00:00Z' });
    writeFileSync(lock, bytes); recoverStorageLock(lock);
    expect(readFileSync(lock, 'utf8')).toBe(bytes);
    writeFileSync(lock, JSON.stringify({ owner: randomUUID(), pid: dead.pid, hostname: hostname(), acquiredAt: '2026-10-08T00:00:00Z' }));
    faults.beforeRecovery = () => writeFileSync(lock, bytes);
    recoverStorageLock(lock); expect(readFileSync(lock, 'utf8')).toBe(bytes);
  });
});
