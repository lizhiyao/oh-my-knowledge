import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { FileExtractionRunStore } from '../../src/knowledge/adapters/run-store.js';
import type { EntityAnalysisStore } from '../../src/knowledge/entities/contracts.js';
import type { EvidenceStore, EvidenceWindow } from '../../src/knowledge/extraction/evidence.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { readRefinedEntitiesKnowledgeContext } from '../../src/knowledge/application/refined-entities.js';
import { refinedEntitiesFixture } from './refined-entities-fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(executor: 'codex' | 'openai-api' = 'codex', options: Parameters<typeof refinedEntitiesFixture>[1] = {}) {
  const f = refinedEntitiesFixture(executor, options);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-refined-entities-'))); roots.push(root);
  const window: EvidenceWindow = { ...structuredClone(f.source), sourceKind: 'codex', sourcePath: '/authored/private-source.jsonl',
    projectionVersion: 'knowledge-window-v2', capturedAt: '2020-01-01T00:00:00Z', startRecord: 0, endRecord: 0,
    origin: { threadId: 'authored-thread', title: 'Private metadata excluded from task input', cwd: '/authored/private-cwd' },
    records: [{ recordIndex: 0, raw: 'Authored envelope; never real conversation data.' }] };
  const evidence: EvidenceStore = {
    capture: () => { throw new Error('Import must not capture another source.'); },
    read: vi.fn(() => ({ status: 'available' as const, window: structuredClone(window) })), delete: vi.fn(),
  };
  const entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root);
  const runs = new FileExtractionRunStore(join(root, 'runs'), root);
  const ports = { evidence, entities, knowledge, runs, tags: new FileKnowledgeTags(join(root, 'tags'), 'local', root),
    sourcePlanArchive: f.sourcePlanArchive, discoveredEntitiesArchive: f.discoveredEntitiesArchive, refinedEntitiesArchive: f.refinedEntitiesArchive,
    actor: { actorKind: 'agent' as const, actorId: 'authored-refinement-test', executionRef: 'authored-only' },
    hash: (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`,
    id: vi.fn(() => { throw new Error('Import must reuse stable IDs.'); }),
    now: vi.fn(() => { throw new Error('Import must preserve native completion time.'); }) };
  const selection = { snapshotId: f.source.snapshotId, sourceVersion: f.source.sourceVersion };
  const app = (store: EntityAnalysisStore = entities) => new KnowledgeApplication({ ...ports, entities: store });
  const knowledgeContext = (store: EntityAnalysisStore = entities) => readRefinedEntitiesKnowledgeContext(
    { ...ports, entities: store }, selection, f.model, f.references());
  const noWrites = () => {
    expect(entities.list().histories).toEqual([]);
    expect(runs.listManifests()).toEqual([]); expect(knowledge.list()).toEqual([]);
    expect(ports.id).not.toHaveBeenCalled(); expect(ports.now).not.toHaveBeenCalled();
  };
  return { ...f, root, window, evidence, entities, knowledge, runs, ports, selection, app, knowledgeContext, noWrites };
}

describe('one bounded refinement through real entity storage (authored originals only)', () => {
  it.each(['codex', 'openai-api'] as const)('authenticates five %s originals, preserves source positions and publishes only the final analysis', executor => {
    const f = setup(executor, { collection: true, unresolved: true }), app = f.app();
    expect(f.readBase().binding.checked.admission.status).toBe('blocked');
    const first = app.refinedEntitiesContext(f.selection, f.model, f.references());
    expect(first.source).toEqual(f.source);
    expect(first.execution.request).toEqual(f.refinementReceipt.request);
    expect(first.execution.input.prompt).not.toContain('/authored/private');
    expect(first.execution.input.prompt).not.toContain('Private metadata');
    const second = app.refinedEntitiesRebindingContext(f.selection, f.model, f.references());
    expect(second.status).toBe('ready');
    if (second.status !== 'ready') throw new Error('Authored refinement should be ready.');
    expect(second.execution.request).toEqual(f.rebindingReceipt.request);
    f.noWrites();
    const originalBytes = [f.old.bytesA(), f.old.bytesB(), f.bytesRefinement(), f.bytesRebinding()];
    const result = app.importRefinedEntities(f.selection, f.model, f.references());
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('Expected authored final import.');
    expect(result.semanticStatus).toBe('not_reviewed');
    expect(result).not.toHaveProperty('goldReady'); expect(result).not.toHaveProperty('formalReceipt');
    const history = f.entities.read(result.analysisId), revision = history.revisions[0];
    expect(history.generation).toBe(1); expect(history.revisions).toHaveLength(1); expect(history.receipts).toHaveLength(1);
    expect(revision.revisedAt).toBe(f.rebindingReceipt.finishedAt);
    expect(revision.revisedBy).toMatchObject({ actorKind: 'agent', executionRef: result.chainDigest });
    expect(revision.entities.map(entity => entity.label)).toEqual(f.refinementResponse.entities.map(entity => entity.label));
    expect(revision.mentions).toHaveLength(f.rebindingResponse.mentions.length);
    for (const mention of revision.mentions) {
      const excerpt = f.source.excerpts.find(value => value.evidenceRef === mention.selection.evidenceRef)!;
      expect(excerpt.text.slice(mention.selection.start, mention.selection.end)).toBe(mention.selection.quote);
    }
    const unresolved = revision.entities.find(entity => entity.identityStatus === 'unresolved')!;
    expect(unresolved.possibleEntityIds).toHaveLength(2);
    expect(unresolved.possibleEntityIds.every(id => revision.entities.some(entity => entity.entityId === id && entity.identityStatus === 'proposed'))).toBe(true);
    const group = revision.entities.find(entity => entity.referentKind === 'collection')!;
    expect(group.collection?.memberEntityIds).toHaveLength(2);
    expect(group.collection?.mentionIds.every(id => revision.mentions.some(mention => mention.mentionId === id))).toBe(true);
    expect(revision.limitations).toEqual(f.source.limitations);
    const beforeRead = f.entities.list(), writeSpy = vi.spyOn(f.entities, 'write');
    const context = f.knowledgeContext();
    expect(context.window).toEqual(f.window);
    expect(context).toMatchObject({ analysisId: result.analysisId, revisionId: result.revisionId,
      chainDigest: result.chainDigest, entityFinishedAt: f.rebindingReceipt.finishedAt, semanticStatus: 'not_reviewed' });
    expect(context.write).toEqual(result.write);
    expect([context.base, context.refinement, context.rebinding]).toEqual([result.base, result.refinement, result.rebinding]);
    expect(context.catalog).toEqual({ analysisId: result.analysisId, revisionId: result.revisionId,
      snapshotId: f.source.snapshotId, sourceVersion: f.source.sourceVersion,
      entities: revision.entities, mentions: revision.mentions, limitations: revision.limitations });
    expect(context).not.toHaveProperty('entityRunId'); expect(context).not.toHaveProperty('extractionRun');
    context.window.excerpts[0].text = 'Caller changed its own context.';
    context.catalog.entities[0].description = 'Caller changed its own catalog.';
    expect(f.entities.list()).toEqual(beforeRead); expect(f.window.excerpts).toEqual(f.source.excerpts);
    expect(writeSpy).not.toHaveBeenCalled(); expect(f.evidence.delete).not.toHaveBeenCalled();
    expect([f.old.bytesA(), f.old.bytesB(), f.bytesRefinement(), f.bytesRebinding()]).toEqual(originalBytes);
    expect(f.runs.listManifests()).toEqual([]); expect(f.knowledge.list()).toEqual([]);
    expect(f.entities.list().histories).toHaveLength(1);
    expect(f.ports.id).not.toHaveBeenCalled(); expect(f.ports.now).not.toHaveBeenCalled();
  });

  it('requires a persisted initial revision and keeps it fixed after a legitimate later revision', () => {
    const f = setup();
    expect(() => f.knowledgeContext()).toThrow(); f.noWrites();
    const imported = f.app().importRefinedEntities(f.selection, f.model, f.references());
    if (imported.status !== 'committed') throw new Error('Expected authored final import.');
    f.entities.write({ ...imported.write, requestId: '00000000-0000-4000-8000-000000000098',
      expectedGeneration: 1, expectedHeadRevisionId: imported.revisionId,
      revision: { ...imported.write.revision, revisionId: '00000000-0000-4000-8000-000000000099',
        parentRevisionId: imported.revisionId, revisedBy: f.ports.actor, revisedAt: '2026-10-24T00:00:08Z',
        revisionReason: 'Authored later revision, independent from the immutable initial handoff.',
        entities: imported.write.revision.entities.map(entity => ({ ...entity, description: 'Authored subsequent description.' })) } }, f.ports.actor);
    const beforeRead = f.entities.read(imported.analysisId), writeSpy = vi.spyOn(f.entities, 'write');
    const context = f.knowledgeContext();
    expect(context.catalog.revisionId).toBe(imported.revisionId);
    expect(context.catalog.entities).toEqual(imported.write.revision.entities);
    expect(context.entityFinishedAt).toBe(f.rebindingReceipt.finishedAt);
    expect(f.entities.read(imported.analysisId)).toEqual(beforeRead); expect(beforeRead.revisions).toHaveLength(2);
    expect(writeSpy).not.toHaveBeenCalled(); expect(f.runs.listManifests()).toEqual([]); expect(f.knowledge.list()).toEqual([]);
  });

  it.each(['analysis-id', 'source-snapshot', 'source-version', 'missing-initial', 'revision-content', 'revision-actor', 'write-intent'] as const)(
    'refuses a persisted initial handoff changed at %s without producing effects', mode => {
      const f = setup();
      expect(f.app().importRefinedEntities(f.selection, f.model, f.references()).status).toBe('committed');
      const beforeRead = f.entities.list();
      const write = vi.fn(() => { throw new Error('Read-only context must not write.'); });
      const changed: EntityAnalysisStore = { list: () => f.entities.list(), write, read: id => {
        const history = f.entities.read(id);
        if (mode === 'analysis-id') history.analysisId = '00000000-0000-4000-8000-000000000099';
        if (mode === 'source-snapshot') history.snapshotId = '00000000-0000-4000-8000-000000000099';
        if (mode === 'source-version') history.sourceVersion = `sha256:${'f'.repeat(64)}`;
        if (mode === 'missing-initial') history.revisions = [];
        if (mode === 'revision-content') history.revisions[0].entities[0].description = 'Changed persisted initial content.';
        if (mode === 'revision-actor') history.revisions[0].revisedBy = f.ports.actor;
        if (mode === 'write-intent') history.receipts[0].commandDigest = `sha256:${'f'.repeat(64)}`;
        return history;
      } };
      expect(() => f.knowledgeContext(changed)).toThrow('differs from the persisted initial revision or write intent');
      expect(write).not.toHaveBeenCalled(); expect(f.entities.list()).toEqual(beforeRead);
      expect(f.runs.listManifests()).toEqual([]); expect(f.knowledge.list()).toEqual([]);
    },
  );

  it('replays after a lost durable acknowledgement with the same write intent and without another revision', () => {
    const f = setup(), writes: unknown[] = []; let lose = true;
    const interrupted: EntityAnalysisStore = {
      list: () => f.entities.list(), read: id => f.entities.read(id),
      write(command, actor) {
        writes.push(structuredClone(command)); const receipt = f.entities.write(command, actor);
        if (lose) { lose = false; throw new Error('Authored lost final acknowledgement.'); }
        return receipt;
      },
    };
    expect(() => f.app(interrupted).importRefinedEntities(f.selection, f.model, f.references())).toThrow('lost final acknowledgement');
    expect(f.entities.list().histories).toHaveLength(1);
    const replay = f.app(interrupted).importRefinedEntities(f.selection, f.model, f.references());
    expect(replay.status).toBe('committed'); expect(writes[1]).toEqual(writes[0]);
    expect(f.app().importRefinedEntities(f.selection, f.model, f.references()).status).toBe('committed');
    const history = f.entities.list().histories[0];
    expect(history.generation).toBe(1); expect(history.revisions).toHaveLength(1); expect(history.receipts).toHaveLength(1);
    expect(f.runs.listManifests()).toEqual([]); expect(f.knowledge.list()).toEqual([]);
  });

  it('conflicts under one stable final receipt instead of creating another analysis when posterior evidence changes', () => {
    const f = setup();
    expect(f.app().importRefinedEntities(f.selection, f.model, f.references()).status).toBe('committed');
    f.rebindingReceipt.finishedAt = '2026-10-24T00:00:08Z'; f.resealRebinding();
    expect(() => f.app().importRefinedEntities(f.selection, f.model, f.references())).toThrow();
    expect(f.entities.list().histories).toHaveLength(1);
    expect(f.entities.list().histories[0].revisions).toHaveLength(1);
  });

  it('binds the invoking actor into the immutable command while retaining the same logical analysis ID', () => {
    const f = setup();
    expect(f.app().importRefinedEntities(f.selection, f.model, f.references()).status).toBe('committed');
    const otherActor = new KnowledgeApplication({ ...f.ports, actor: { actorKind: 'agent', actorId: 'different-author', executionRef: 'another-authored-invocation' } });
    expect(() => otherActor.importRefinedEntities(f.selection, f.model, f.references())).toThrow();
    expect(() => readRefinedEntitiesKnowledgeContext({ ...f.ports,
      actor: { actorKind: 'agent', actorId: 'different-author', executionRef: 'another-authored-invocation' } },
    f.selection, f.model, f.references())).toThrow('differs from the persisted initial revision or write intent');
    expect(f.entities.list().histories).toHaveLength(1);
  });

  it('retains an undetermined catalog disposition and blocks B-prime construction and final storage', () => {
    const f = setup();
    Object.assign(f.refinementResponse.entityDispositions[0], { dispositionKind: 'undetermined', entityIds: [] });
    f.result('refinement').output = JSON.stringify(f.refinementResponse); f.resealRefinement();
    f.refinedRead.mockClear();
    const context = f.app().refinedEntitiesRebindingContext(f.selection, f.model, f.references());
    expect(context.status).toBe('blocked'); expect(context).not.toHaveProperty('execution');
    const result = f.app().importRefinedEntities(f.selection, f.model, f.references());
    expect(result.status).toBe('blocked');
    expect(() => f.knowledgeContext()).toThrow('requires a ready final analysis');
    expect(f.refinedRead.mock.calls.every(call => call[0] === 'refinement')).toBe(true);
    f.noWrites();
  });

  it.each(['uncertain-ledger', 'missing-ledger', 'unbound-final', 'missing-support'] as const)('never publishes a valid subset for %s', mode => {
    const f = setup('codex', { collection: true });
    if (mode === 'uncertain-ledger') Object.assign(f.rebindingResponse.mentionDispositions[0], { dispositionKind: 'undetermined', mentionIds: [] });
    if (mode === 'missing-ledger') f.rebindingResponse.mentionDispositions.pop();
    if (mode === 'unbound-final') {
      const original = f.old.bindingResponse.mentions.find(mention => mention.mentionId === 'gap')!;
      const target = f.rebindingResponse.mentions.find(mention => mention.mentionId === 'next-gap')!;
      Object.assign(target, structuredClone(original), { mentionId: target.mentionId });
      f.rebindingResponse.mentionDispositions.find(row => row.previousMentionId === 'gap')!.dispositionKind = 'retained';
    }
    if (mode === 'missing-support') f.rebindingResponse.identitySupports = [];
    f.result('rebinding').output = JSON.stringify(f.rebindingResponse); f.resealRebinding();
    const result = f.app().importRefinedEntities(f.selection, f.model, f.references());
    expect(result.status).toBe('blocked'); expect(result.semanticStatus).toBe('not_reviewed'); f.noWrites();
    expect(() => f.knowledgeContext()).toThrow('requires a ready final analysis'); f.noWrites();
  });

  it('reauthenticates original predecessors even after a successful import', () => {
    const f = setup();
    expect(f.app().importRefinedEntities(f.selection, f.model, f.references()).status).toBe('committed');
    f.old.bindingReceipt.producer.producerRevision = `sha256:${'f'.repeat(64)}`; f.old.resealB();
    expect(() => f.app().importRefinedEntities(f.selection, f.model, f.references())).toThrow();
    const readSpy = vi.spyOn(f.entities, 'read');
    expect(() => f.knowledgeContext()).toThrow(); expect(readSpy).not.toHaveBeenCalled();
    expect(f.entities.list().histories).toHaveLength(1);
  });

  it.each(['sourcePlanArchive', 'discoveredEntitiesArchive', 'refinedEntitiesArchive'] as const)('requires %s before producing any successor context', key => {
    const f = setup(), app = new KnowledgeApplication({ ...f.ports, [key]: undefined });
    expect(() => app.refinedEntitiesContext(f.selection, f.model, f.references())).toThrow('archive unavailable'); f.noWrites();
  });

  it('rejects a changed source or unavailable source and never falls back to stale context', () => {
    const f = setup(); f.window.excerpts[0].text += ' Changed.';
    expect(() => f.app().importRefinedEntities(f.selection, f.model, f.references())).toThrow(); f.noWrites();
    const readSpy = vi.spyOn(f.entities, 'read');
    expect(() => f.knowledgeContext()).toThrow(); expect(readSpy).not.toHaveBeenCalled(); f.noWrites();
    const app = new KnowledgeApplication({ ...f.ports, evidence: { ...f.evidence,
      read: () => ({ status: 'unavailable' as const, reason: 'missing' as const, detail: 'Authored unavailable source.' }) } });
    expect(() => app.refinedEntitiesContext(f.selection, f.model, f.references())).toThrow('source unavailable'); f.noWrites();
  });

  it('honors cancellation before archive access or publication', () => {
    const f = setup(), controller = new AbortController(); controller.abort(new Error('Authored cancellation.'));
    f.refinedRead.mockClear();
    expect(() => f.app().importRefinedEntities(f.selection, f.model, f.references(), controller.signal)).toThrow('Authored cancellation');
    expect(f.refinedRead).not.toHaveBeenCalled(); f.noWrites();
  });
});
