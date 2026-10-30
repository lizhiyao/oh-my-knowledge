import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assertSourceWorkspaceWritable } from '../../src/knowledge/adapters/source-workspace.js';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import type { KnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import { knowledgeBodyDigest } from '../../src/knowledge/adapters/body-digest.js';
import { bodyActor, bodyWrite } from './body-fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'omk-source-workspace-')); roots.push(root); return root; };
it('checks an empty explicit workspace without creating it, and refuses old generation journals before new writes', () => {
  const parent = temp(), root = join(parent, 'not-created');
  assertSourceWorkspaceWritable(root); expect(existsSync(root)).toBe(false);
  mkdirSync(join(root, 'generation-journals'), { recursive: true });
  const path = join(root, 'generation-journals', `${randomUUID()}.json`), original = JSON.stringify({ storeKind: 'knowledge-generation-journal', schemaVersion: 2 });
  writeFileSync(path, original);
  expect(() => assertSourceWorkspaceWritable(root)).toThrow('knowledge_storage_unsupported'); expect(readFileSync(path, 'utf8')).toBe(original);
  expect(existsSync(join(root, 'sources'))).toBe(false);
});
it('keeps historical bodies readable but blocks current writes and model preparation in a Source2 workspace', () => {
  const root = temp(), sourcePath = join(root, 'authored-old.jsonl');
  writeFileSync(sourcePath, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha' }] } }));
  // Explicit historical fixture; the current application never uses this reader.
  const old = new TraceEvidenceStore(join(root, 'sources'), root).capture({ path: sourcePath });
  const store = new FileKnowledgeStore(join(root, 'items'), 'local', root), command = bodyWrite();
  command.revision.content.segments[0].evidence = [{ source: { snapshotId: old.snapshotId, sourceVersion: old.sourceVersion },
    selection: { evidenceRef: old.excerpts[0].evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'source_assertion' }];
  command.revision.bodyDigest = knowledgeBodyDigest(command.revision); store.write(command, bodyActor);
  const app = createLocalKnowledgeApplication(root), detail = app.detail(command.knowledgeId);
  expect(detail.revision).toEqual(command.revision); expect(detail.sources).toMatchObject([{ status: 'unavailable', reason: 'unsupported' }]);
  const native = vi.fn(), inspect = vi.fn(), model = { executor: 'authored', model: 'fixture', timeoutMs: 300000, inspect, invoke: native } as KnowledgeGenerationModel;
  expect(() => app.prepareGeneration([{ snapshotId: old.snapshotId, sourceVersion: old.sourceVersion }], model)).toThrow(/unsupported|migration/i);
  expect(() => app.maintain(command.knowledgeId, command.revision.revisionId, 'retain', 'must migrate first', 1)).toThrow(/unsupported|migration/i);
  expect(inspect).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(existsSync(join(root, 'generation-journals'))).toBe(false);
  expect(store.read(command.knowledgeId).revisions).toEqual([command.revision]); expect(store.read(command.knowledgeId).maintenance).toEqual([]);
});
