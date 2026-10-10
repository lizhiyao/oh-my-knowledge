import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileKnowledgeStore } from '../../src/observability/knowledge-extraction/adapters/knowledge-store.js';
import { FileExtractionRunStore } from '../../src/observability/knowledge-extraction/adapters/run-store.js';
import { FileEntityAnalysisStore } from '../../src/observability/knowledge-extraction/adapters/entity-store.js';
import { recoverStorageLock, storageLockState, withWorkspaceWrite, WORKSPACE_LOCK_FILE } from '../../src/observability/knowledge-extraction/adapters/storage-state.js';

const faults = vi.hoisted(() => ({ beforeRecovery: undefined as (() => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: (path: string, flags: string) => {
    if (path.includes('.recovery-') && faults.beforeRecovery) {
      const operation = faults.beforeRecovery; faults.beforeRecovery = undefined; operation();
    }
    return fs.openSync(path, flags);
  } };
});
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'omk-current-storage-')); roots.push(path); return path; };
afterEach(() => { faults.beforeRecovery = undefined; for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('current knowledge storage', () => {
  it('reads an empty entity catalog without creating storage and refuses over-capacity catalogs without truncating', () => {
    const workspace = root(); const directory = join(workspace, 'entities');
    const store = new FileEntityAnalysisStore(directory, workspace);
    expect(store.list()).toEqual({ histories: [], unavailable: 0 }); expect(existsSync(directory)).toBe(false);
    mkdirSync(directory); const file = join(directory, `${randomUUID()}.json`); writeFileSync(file, '{}');
    expect(store.list()).toEqual({ histories: [], unavailable: 1 }); expect(readFileSync(file, 'utf8')).toBe('{}');
    truncateSync(file, 65 * 1024 * 1024);
    expect(() => store.list()).toThrow('capacity exceeded');
  });
  it('rejects unsupported storage envelopes without rewriting the original bytes', () => {
    const workspace = root(); const items = join(workspace, 'items'); const runs = join(workspace, 'runs');
    mkdirSync(items); mkdirSync(runs);
    const knowledge = new FileKnowledgeStore(items, 'local', workspace); const runStore = new FileExtractionRunStore(runs, workspace);
    const itemPath = join(items, 'unsupported.json'); const runId = randomUUID(); const runPath = join(runs, `${runId}.json`);
    for (const value of [{ storeKind: 'knowledge-item-history', schemaVersion: 1 }, { storeKind: 'unknown', schemaVersion: 2 }]) {
      const bytes = JSON.stringify(value); writeFileSync(itemPath, bytes);
      expect(() => knowledge.list()).toThrow('knowledge_storage_unsupported'); expect(readFileSync(itemPath, 'utf8')).toBe(bytes);
    }
    for (const value of [{ runId }, { runKind: 'knowledge-extraction-run', schemaVersion: 1 },
      { runKind: 'knowledge-extraction-run', schemaVersion: 2, promptVersion: 'knowledge-extraction-v3' },
      { runKind: 'knowledge-extraction-run', schemaVersion: 3, promptVersion: 'knowledge-extraction-v2' }]) {
      const bytes = JSON.stringify(value); writeFileSync(runPath, bytes);
      expect(() => runStore.read(runId)).toThrow('knowledge_storage_unsupported'); expect(readFileSync(runPath, 'utf8')).toBe(bytes);
    }
  });
  it('does not infer dead writers from lock age, unverifiable hosts, or malformed owners', () => {
    const lock = join(root(), WORKSPACE_LOCK_FILE);
    const owner = { owner: randomUUID(), pid: process.pid, hostname: hostname(), acquiredAt: '2000-01-01T00:00:00Z' };
    for (const value of [owner, { ...owner, hostname: 'unverifiable-remote-host' }, {}]) {
      const bytes = JSON.stringify(value); writeFileSync(lock, bytes);
      expect(storageLockState(lock)).toBe('busy'); recoverStorageLock(lock); expect(readFileSync(lock, 'utf8')).toBe(bytes);
    }
  });
  it('recovers proven exited local owners and interrupted recovery guards without removing a new live owner', () => {
    const workspace = root(); const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']); expect(dead.status).toBe(0);
    const lock = join(workspace, WORKSPACE_LOCK_FILE); const owner = randomUUID();
    const deadOwner = { owner, pid: dead.pid, hostname: hostname(), acquiredAt: '2026-10-08T00:00:00Z' };
    writeFileSync(lock, JSON.stringify(deadOwner));
    const guard = `${lock}.recovery-${owner}.lock`; writeFileSync(guard, JSON.stringify({ ...deadOwner, owner: randomUUID() }));
    expect(storageLockState(lock)).toBe('dead');
    expect(withWorkspaceWrite(workspace, () => 'written')).toBe('written');
    expect(existsSync(lock)).toBe(false); expect(existsSync(guard)).toBe(false);
    const bytes = JSON.stringify({ ...deadOwner, owner: randomUUID(), pid: process.pid });
    writeFileSync(lock, bytes); recoverStorageLock(lock); expect(readFileSync(lock, 'utf8')).toBe(bytes);
    writeFileSync(lock, JSON.stringify(deadOwner)); faults.beforeRecovery = () => writeFileSync(lock, bytes);
    recoverStorageLock(lock); expect(readFileSync(lock, 'utf8')).toBe(bytes);
  });
});
