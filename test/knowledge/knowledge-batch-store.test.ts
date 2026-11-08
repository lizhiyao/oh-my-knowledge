import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import type { KnowledgeActor } from '../../src/knowledge/contracts.js';
import type { KnowledgeEnvelope, KnowledgeWrite } from '../../src/knowledge/store.js';
import { bodyActor, bodyAt, bodyWrite } from './body-fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'omk-window-batch-store-'));
  roots.push(workspace);
  const items = join(workspace, 'items'), runId = randomUUID();
  const writer = new FileKnowledgeStore(items, 'local', workspace), reader = new FileKnowledgeStore(items, 'local', workspace);
  const publication = join(items, 'window-batches', `${runId}.json`);
  const batchActor: KnowledgeActor = { actorKind: 'agent', actorId: 'extractor:codex', executionRef: `window-batch/${runId}/${randomUUID()}` };
  return { writer, reader, runId, publication, batchActor };
}

function initial(knowledgeId: string, actor: KnowledgeActor) {
  const command = bodyWrite();
  return { ...command, knowledgeId, requestId: `request-${knowledgeId}`, revision: {
    ...command.revision, knowledgeId, createdBy: actor, revisedBy: actor,
  } };
}

function keep(knowledgeId: string): KnowledgeWrite {
  return { commandKind: 'record_maintenance', requestId: `keep-${knowledgeId}`, knowledgeId, expectedGeneration: 1,
    maintenance: { revisionId: 'revision-1', choice: 'retain', actor: bodyActor, at: bodyAt, reason: 'Fixture retention.' } };
}

describe('window batch publication', () => {
  it('hides a partial batch from list, exact read, and maintenance until all initial refs commit', () => {
    const { writer, reader, runId, publication, batchActor } = fixture();
    const oldActor: KnowledgeActor = { actorKind: 'agent', actorId: batchActor.actorId, executionRef: `${runId}:${randomUUID()}` };
    const a = initial('window-a', batchActor), b = initial('window-b', batchActor);
    writer.write(initial('prior-entry', oldActor), oldActor);
    const firstReceipt = writer.write(a, batchActor);
    expect(writer.write(a, batchActor)).toEqual(firstReceipt);
    expect(reader.list().map(entry => entry.knowledgeId)).toEqual(['prior-entry']);
    expect(reader.list(new Set([a.knowledgeId, b.knowledgeId]))).toEqual([]);
    expect(() => reader.read(a.knowledgeId)).toThrow('Knowledge history is not published.');
    expect(() => writer.write(keep(a.knowledgeId), bodyActor)).toThrow('Knowledge history is not published.');
    const refs = [knowledgeBodyRef(a.revision), knowledgeBodyRef(b.revision)];
    expect(() => writer.commitBodyBatch(runId, refs)).toThrow();
    expect(existsSync(publication)).toBe(false);
    expect(() => reader.read(a.knowledgeId)).toThrow('Knowledge history is not published.');

    writer.write(b, batchActor);
    expect(() => writer.commitBodyBatch(runId, [refs[0], { ...refs[1], revisionId: 'wrong' }])).toThrow('Knowledge batch body identity mismatch.');
    expect(reader.list(new Set([a.knowledgeId, b.knowledgeId]))).toEqual([]);
    writer.commitBodyBatch(runId, refs);
    expect(reader.list().map(entry => entry.knowledgeId).sort()).toEqual(['prior-entry', 'window-a', 'window-b']);
    expect(knowledgeBodyRef(reader.read(b.knowledgeId).revisions[0])).toEqual(refs[1]);

    const marker = readFileSync(publication), inode = lstatSync(publication).ino;
    writer.write(keep(a.knowledgeId), bodyActor);
    expect(reader.read(a.knowledgeId).maintenance[0].choice).toBe('retain');
    const draft = { title: 'Follow-up edit', content: a.revision.content, reuseRationale: a.revision.reuseRationale };
    writer.write({ ...a, requestId: 'later-edit', expectedGeneration: 2, expectedHeadRevisionId: a.revision.revisionId, revision: {
      ...a.revision, ...draft, revisionId: 'revision-2', parentRevision: { knowledgeId: a.knowledgeId, revisionId: a.revision.revisionId },
      bodyDigest: knowledgeBodyDigest(draft), revisedBy: bodyActor,
    } }, bodyActor);
    expect(reader.read(a.knowledgeId).revisions.at(-1)?.title).toBe('Follow-up edit');
    expect(writer.write(a, batchActor)).toEqual(firstReceipt);
    writer.commitBodyBatch(runId, refs);
    expect(readFileSync(publication)).toEqual(marker);
    expect(lstatSync(publication).ino).toBe(inode);
    expect(() => writer.commitBodyBatch(runId, refs.slice(0, 1))).toThrow('Knowledge batch publication conflict.');
    expect(() => writer.write(initial('too-late', batchActor), batchActor)).toThrow('Knowledge batch is already published.');
  });

  it('uses one manifest snapshot when a complete batch commits during a listing', () => {
    const { writer, reader, runId, batchActor } = fixture();
    const a = initial('window-a', batchActor), b = initial('window-b', batchActor);
    writer.write(a, batchActor);
    writer.write(b, batchActor);
    const loadable = reader as unknown as { load(path: string): KnowledgeEnvelope };
    const load = loadable.load.bind(loadable);
    let reads = 0;
    vi.spyOn(loadable, 'load').mockImplementation(path => {
      if (++reads === 2) writer.commitBodyBatch(runId, [knowledgeBodyRef(a.revision), knowledgeBodyRef(b.revision)]);
      return load(path);
    });
    expect(reader.list()).toEqual([]);
    expect(reader.list().map(entry => entry.knowledgeId).sort()).toEqual(['window-a', 'window-b']);
  });
});
