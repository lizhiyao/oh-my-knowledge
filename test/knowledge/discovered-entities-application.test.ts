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
import type { EvidenceStore, EvidenceWindow } from '../../src/knowledge/extraction/evidence.js';
import { EntityDiscoveryValidationError, mentionBindingExecution } from '../../src/knowledge/extraction/discovered-entities-evidence.js';
import type { EntityAnalysisStore } from '../../src/knowledge/entities/contracts.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { discoveredEntitiesFixture } from './discovered-entities-fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const f = discoveredEntitiesFixture();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-discovered-entities-'))); roots.push(root);
  const window: EvidenceWindow = { ...f.source, sourceKind: 'codex', sourcePath: '/authored/private-source.jsonl',
    projectionVersion: 'knowledge-window-v2', capturedAt: '2020-01-01T00:00:00Z', startRecord: 0, endRecord: 0,
    origin: { threadId: 'authored-thread', title: 'Must not be sent to either task', cwd: '/authored/private-cwd' },
    records: [{ recordIndex: 0, raw: 'Authored source envelope; never real conversation data.' }] };
  const evidence: EvidenceStore = {
    capture: () => { throw new Error('No capture in import.'); },
    read: vi.fn(() => ({ status: 'available' as const, window: structuredClone(window) })), delete: vi.fn(),
  };
  const entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root);
  const runs = new FileExtractionRunStore(join(root, 'runs'), root);
  const ports = { evidence, entities, knowledge, runs, tags: new FileKnowledgeTags(join(root, 'tags'), 'local', root),
    actor: { actorKind: 'agent' as const, actorId: 'authored-import-test', executionRef: 'authored-test-only' },
    hash: (value: unknown) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`,
    id: vi.fn(() => { throw new Error('Import must not allocate random IDs.'); }),
    now: vi.fn(() => { throw new Error('Import must not replace the native completion time.'); }),
    discoveredEntitiesArchive: f.archive };
  const selection = { snapshotId: f.source.snapshotId, sourceVersion: f.source.sourceVersion };
  const references = () => ({ discovery: f.discoveryRef, binding: f.bindingRef });
  const app = (store: EntityAnalysisStore = entities) => new KnowledgeApplication({ ...ports, entities: store });
  return { ...f, root, window, entities, knowledge, runs, ports, selection, references, app };
}

describe('separate discovery/binding import through the real entity store (authored evidence only)', () => {
  it('authenticates A independently and creates exactly one initial analysis without an extraction run or knowledge', () => {
    const f = setup(), app = f.app();
    const context = app.discoveredEntitiesContext(f.selection, f.model, { discovery: f.discoveryRef });
    expect(context.source).toEqual(f.source); expect(context).not.toHaveProperty('sourcePlan');
    expect(context.source).not.toHaveProperty('sourcePath'); expect(context.source).not.toHaveProperty('origin');
    expect(f.entities.list().histories).toEqual([]);
    const result = app.importDiscoveredEntities(f.selection, f.model, f.references());
    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('Expected authored import.');
    expect(result.semanticStatus).toBe('not_reviewed'); expect(result).not.toHaveProperty('sourcePlan');
    expect(result.chainDigest).toBe(f.ports.hash({ importVersion: 'knowledge-discovered-entities-import/v3', actor: f.ports.actor,
      discovery: { receiptId: f.discoveryReceipt.receiptId, receiptRef: f.discoveryRef.receiptRef },
      binding: { receiptId: f.bindingReceipt.receiptId, receiptRef: f.bindingRef.receiptRef } }));
    const history = f.entities.read(result.analysisId), revision = history.revisions[0];
    expect(history.generation).toBe(1); expect(history.revisions).toHaveLength(1);
    expect(revision.revisedAt).toBe(f.bindingReceipt.finishedAt);
    expect(revision.entities.map(entity => entity.label)).toEqual(f.discoveryResponse.entities.map(entity => entity.label));
    expect(revision.entities).toHaveLength(f.discoveryResponse.entities.length);
    expect(revision.mentions).toHaveLength(f.bindingResponse.mentions.length);
    for (const mention of revision.mentions) {
      const excerpt = f.source.excerpts.find(value => value.evidenceRef === mention.selection.evidenceRef)!;
      expect(excerpt.text.slice(mention.selection.start, mention.selection.end)).toBe(mention.selection.quote);
    }
    expect(revision.limitations).toEqual(f.source.limitations);
    expect(f.runs.listManifests()).toEqual([]); expect(f.knowledge.list()).toEqual([]);
    expect(f.ports.id).not.toHaveBeenCalled(); expect(f.ports.now).not.toHaveBeenCalled();
  });

  it('replays the same originals after acknowledgement loss without a second revision or another model call', () => {
    const f = setup(), writes: unknown[] = []; let loseAcknowledgement = true;
    const interrupted: EntityAnalysisStore = {
      list: () => f.entities.list(), read: id => f.entities.read(id),
      write(command, actor) {
        writes.push(structuredClone(command)); const receipt = f.entities.write(command, actor);
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Authored lost acknowledgement after durable write.'); }
        return receipt;
      },
    };
    expect(() => f.app(interrupted).importDiscoveredEntities(f.selection, f.model, f.references())).toThrow('lost acknowledgement');
    expect(f.entities.list().histories).toHaveLength(1);
    const resumed = f.app(interrupted).importDiscoveredEntities(f.selection, f.model, f.references());
    expect(resumed.status).toBe('committed'); expect(writes[1]).toEqual(writes[0]);
    const again = f.app().importDiscoveredEntities(f.selection, f.model, f.references());
    expect(again.status).toBe('committed');
    const histories = f.entities.list().histories;
    expect(histories).toHaveLength(1); expect(histories[0].generation).toBe(1);
    expect(histories[0].revisions).toHaveLength(1); expect(histories[0].receipts).toHaveLength(1);
    expect(f.runs.listManifests()).toEqual([]);
  });

  it('rejects changed native receipt bytes under the same logical B receipt instead of forking a second analysis', () => {
    const f = setup();
    const first = f.app().importDiscoveredEntities(f.selection, f.model, f.references());
    expect(first.status).toBe('committed');
    f.bindingReceipt.finishedAt = new Date(Date.parse(f.bindingReceipt.finishedAt) + 1000).toISOString(); f.resealB();
    expect(() => f.app().importDiscoveredEntities(f.selection, f.model, f.references())).toThrow();
    const histories = f.entities.list().histories;
    expect(histories).toHaveLength(1); expect(histories[0].revisions).toHaveLength(1);
  });

  it.each(['ambiguous', 'missing-entity-support'] as const)('keeps %s as a whole-analysis blocker rather than admitting a subset', mode => {
    const f = setup();
    if (mode === 'ambiguous') Object.assign(f.bindingResponse.mentions[0], { bindingStatus: 'ambiguous', entityId: null,
      candidateEntityIds: f.discoveryResponse.entities.slice(0, 2).map(entity => entity.entityId), reason: 'Authored unresolved target alternatives.' });
    else {
      const lastEntity = f.discoveryResponse.entities.at(-1)!.entityId;
      f.bindingResponse.mentions = f.bindingResponse.mentions.filter(mention => mention.entityId !== lastEntity);
    }
    f.result('binding').output = JSON.stringify(f.bindingResponse); f.resealB();
    const result = f.app().importDiscoveredEntities(f.selection, f.model, f.references());
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('Expected blocked authored analysis.');
    expect(result.issues.length).toBeGreaterThan(0); expect(result.semanticStatus).toBe('not_reviewed');
    expect(f.entities.list().histories).toEqual([]); expect(f.runs.listManifests()).toEqual([]);
    expect(result.binding.rawOutput).toContain('mention-binding');
  });

  it('preserves a valid unresolved A identity and its mapped candidate instead of silently dropping or resolving it', () => {
    const f = setup();
    Object.assign(f.discoveryResponse.entities[0], { identityStatus: 'unresolved', possibleEntityIds: ['e1'], uncertainties: ['Authored unresolved identity.'] });
    f.result('discovery').output = JSON.stringify(f.discoveryResponse); f.resealA();
    const execution = mentionBindingExecution(f.source, f.readA(), f.model);
    f.bindingReceipt.request = execution.request; f.bindingReceipt.producer = f.inspect(f.model.executor, execution.input);
    f.bindingResponse.binding = JSON.parse(execution.request.input).binding;
    f.result('binding').output = JSON.stringify(f.bindingResponse); f.resealB();
    const result = f.app().importDiscoveredEntities(f.selection, f.model, f.references());
    if (result.status !== 'committed') throw new Error('Expected structurally valid authored unknown identity.');
    const revision = f.entities.read(result.analysisId).revisions[0];
    expect(revision.entities[0]).toMatchObject({ identityStatus: 'unresolved',
      possibleEntityIds: [revision.entities[1].entityId], uncertainties: ['Authored unresolved identity.'] });
    expect(result.semanticStatus).toBe('not_reviewed');
  });

  it.each(['missing-uncertainty', 'unknown-candidate'] as const)('rejects A %s before reading B or writing entities', mode => {
    const f = setup();
    Object.assign(f.discoveryResponse.entities[0], { identityStatus: 'unresolved', possibleEntityIds: ['e1'], uncertainties: ['Authored unresolved identity.'] });
    if (mode === 'missing-uncertainty') f.discoveryResponse.entities[0].uncertainties = [];
    else f.discoveryResponse.entities[0].possibleEntityIds = ['missing'];
    f.result('discovery').output = JSON.stringify(f.discoveryResponse); f.resealA(); f.read.mockClear();
    expect(() => f.app().importDiscoveredEntities(f.selection, f.model, f.references())).toThrow(EntityDiscoveryValidationError);
    expect(f.read.mock.calls.map(call => call[0])).toEqual(['discovery']);
    expect(f.entities.list().histories).toEqual([]); expect(f.runs.listManifests()).toEqual([]); expect(f.knowledge.list()).toEqual([]);
  });

  it.each(['unavailable', 'changed-unreadable'] as const)('keeps an %s independent source plan outside A/B context and import', mode => {
    const f = setup();
    const unreadableArchive = { read: vi.fn(() => { throw new Error('A/B import read SP.'); }),
      inspect: vi.fn(() => { throw new Error('A/B import inspected SP.'); }) };
    if (mode === 'changed-unreadable') {
      f.plan.sourcePlanReceipt.request.input += ' changed unrelated SP';
      const outcome = f.plan.sourcePlanNative.outcome;
      if (outcome.outcomeKind !== 'result') throw new Error('Expected authored plan result.');
      outcome.result.output = 'not a valid plan'; outcome.result.numTurns = 2; f.plan.resealSourcePlan();
    }
    const app = new KnowledgeApplication({ ...f.ports, sourcePlanArchive: mode === 'unavailable' ? undefined : unreadableArchive });
    const otherTask = new Proxy({}, { get() { throw new Error('A/B import read SP reference.'); } });
    const references = { ...f.references(), sourcePlan: otherTask };
    const context = app.discoveredEntitiesContext(f.selection, f.model, references);
    expect(context.discovery.rawOutput).toBe(f.result('discovery').output); expect(context).not.toHaveProperty('sourcePlan');
    const result = app.importDiscoveredEntities(f.selection, f.model, references);
    expect(result.status).toBe('committed'); expect(result).not.toHaveProperty('sourcePlan');
    expect(unreadableArchive.read).not.toHaveBeenCalled(); expect(unreadableArchive.inspect).not.toHaveBeenCalled();
    expect(f.entities.list().histories).toHaveLength(1); expect(f.runs.listManifests()).toEqual([]); expect(f.knowledge.list()).toEqual([]);
  });

  it('requires the explicit research archive and exact available source, and respects cancellation before publication', () => {
    const f = setup();
    const ordinary = new KnowledgeApplication({ ...f.ports, discoveredEntitiesArchive: undefined });
    expect(() => ordinary.importDiscoveredEntities(f.selection, f.model, f.references())).toThrow('archive unavailable');
    expect(() => f.app().importDiscoveredEntities({ ...f.selection, sourceVersion: `sha256:${'0'.repeat(64)}` }, f.model, f.references())).toThrow('source binding mismatch');
    const controller = new AbortController(); controller.abort(new Error('Authored cancellation.'));
    expect(() => f.app().importDiscoveredEntities(f.selection, f.model, f.references(), controller.signal)).toThrow('Authored cancellation');
    const late = new AbortController();
    const abortingArchive = { ...f.archive, inspect: (...args: Parameters<typeof f.archive.inspect>) => {
      const result = f.archive.inspect(...args); late.abort(new Error('Authored late cancellation.')); return result;
    } };
    const app = new KnowledgeApplication({ ...f.ports, discoveredEntitiesArchive: abortingArchive });
    expect(() => app.importDiscoveredEntities(f.selection, f.model, f.references(), late.signal)).toThrow('late cancellation');
    expect(f.entities.list().histories).toEqual([]);
  });
});
