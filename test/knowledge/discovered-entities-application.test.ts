import { createHash, randomUUID } from 'node:crypto';
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
import { boundKnowledgeExecution, boundKnowledgeRequestDigest, type BoundKnowledgeReceipt }
  from '../../src/knowledge/extraction/bound-knowledge-evidence.js';
import { discoveredEntitiesFixture, discoveryBytes, discoveryHash, discoveryRef, discoveryUid }
  from './discovered-entities-fixtures.js';
import { wireModelWindow } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(executor: 'codex' | 'openai-api' = 'codex') {
  const f = discoveredEntitiesFixture(executor);
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
    for (const entity of revision.entities) expect(entity).not.toHaveProperty('qualificationEvidence');
    expect(context.discovery.checked.response.entities[0].qualificationEvidence).toEqual(f.discoveryResponse.entities[0].qualificationEvidence);
    expect(revision.mentions).toHaveLength(f.bindingResponse.mentions.length);
    for (const mention of revision.mentions) {
      const excerpt = f.source.excerpts.find(value => value.evidenceRef === mention.selection.evidenceRef)!;
      expect(excerpt.text.slice(mention.selection.start, mention.selection.end)).toBe(mention.selection.quote);
    }
    expect(revision.limitations).toEqual(f.source.limitations);
    expect(f.runs.listManifests()).toEqual([]); expect(f.knowledge.list()).toEqual([]);
    expect(f.ports.id).not.toHaveBeenCalled(); expect(f.ports.now).not.toHaveBeenCalled();
  });

  it('changes private qualification evidence without changing the public E shape or stable logical identities', () => {
    const first = setup(), second = setup();
    second.discoveryResponse.entities[0].qualificationEvidence.rationale += ' Authored alternate source reasoning.';
    second.result('discovery').output = JSON.stringify(second.discoveryResponse); second.resealA();
    const execution = mentionBindingExecution(second.source, second.readA(), second.model);
    second.bindingReceipt.request = execution.request;
    second.bindingReceipt.producer = second.inspect(second.model.executor, execution.input);
    second.bindingResponse.binding = JSON.parse(execution.request.input).binding;
    second.result('binding').output = JSON.stringify(second.bindingResponse); second.resealB();
    const one = first.app().importDiscoveredEntities(first.selection, first.model, first.references());
    const two = second.app().importDiscoveredEntities(second.selection, second.model, second.references());
    if (one.status !== 'committed' || two.status !== 'committed') throw new Error('Expected authored imports.');
    expect(one.chainDigest).not.toBe(two.chainDigest);
    expect([one.analysisId, one.revisionId, one.write.requestId]).toEqual([two.analysisId, two.revisionId, two.write.requestId]);
    expect(one.write.revision.entities).toEqual(two.write.revision.entities);
    expect(one.write.revision.mentions).toEqual(two.write.revision.mentions);
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

const at = (second: number) => `2026-10-24T00:00:${second.toString().padStart(2, '0')}Z`;

/** Reuse the A/B stores and authored originals; SP/refinement must remain unread. */
function handoffSetup(executor: 'codex' | 'openai-api' = 'codex') {
  const f = setup(executor);
  const forbiddenArchive = { read: vi.fn(() => { throw new Error('No source plan or refinement dependency.'); }),
    inspect: vi.fn(() => { throw new Error('No source plan or refinement dependency.'); }) };
  const ports = { ...f.ports, sourcePlanArchive: forbiddenArchive, refinedEntitiesArchive: forbiddenArchive };
  return { ...f, ports, forbiddenArchive, app: new KnowledgeApplication(ports) };
}
function ready(executor: 'codex' | 'openai-api' = 'codex') {
  const f = handoffSetup(executor), imported = f.app.importDiscoveredEntities(f.selection, f.model, f.references());
  if (imported.status !== 'committed') throw new Error('Authored A/B catalog must be ready.');
  return { ...f, imported, context: f.app.discoveredBoundKnowledgeContext(f.selection, f.model, f.references()) };
}
function bound(f: ReturnType<typeof ready>, two = false) {
  const execution = boundKnowledgeExecution(f.context.window, f.context.catalog, f.model);
  const proposal = structuredClone(wireModelWindow().proposals[0]);
  const ids = f.context.catalog.entities.map(entity => entity.entityId);
  proposal.entityIds = ids; proposal.mentionIds = f.context.catalog.mentions.map(mention => mention.mentionId);
  proposal.draft.content.statements[0].subject.entityId = ids[0]; proposal.draft.content.statements[0].object!.entityId = ids[1];
  const response = { responseKind: 'bound-knowledge', schemaVersion: 2, binding: JSON.parse(execution.request.input).binding,
    proposals: [proposal], catalogGaps: [], materialAccounting: [{ materialId: 'use', meaning: 'Authored use claim.',
      anchors: [{ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta', occurrence: null }], dispositionKind: 'expressed',
      statementRefs: [{ proposalId: proposal.proposalId, statementId: 'usage' }], reason: null, catalogGapIds: [] }],
    excerptAccounting: [{ evidenceRef: 'record-1', materialIds: ['use'], noMaterialReason: null }] };
  if (two) {
    const sibling = structuredClone(proposal); sibling.proposalId = 'alpha-only'; sibling.entityIds = [ids[0]];
    sibling.mentionIds = [f.context.catalog.mentions[0].mentionId]; sibling.draft.content.statements[0].object = null;
    response.proposals.push(sibling);
  }
  const native = { archiveKind: 'knowledge-bound-knowledge-native', schemaVersion: 1,
    receiptId: discoveryUid(20), attemptId: discoveryUid(21), outcome: { outcomeKind: 'result',
      result: { ...structuredClone(f.result('binding')), output: JSON.stringify(response) } } };
  const receipt: BoundKnowledgeReceipt = { receiptKind: 'knowledge-bound-knowledge-receipt', schemaVersion: 3,
    receiptId: native.receiptId, attemptId: native.attemptId, binding: structuredClone(response.binding), request: execution.request,
    producer: f.inspect(f.model.executor, execution.input), requestDigest: '', nativeRef: discoveryRef(discoveryBytes(native)),
    startedAt: at(4), finishedAt: at(5) };
  let receiptBytes: Buffer, nativeBytes: Buffer;
  const reseal = () => { nativeBytes = discoveryBytes(native); receipt.nativeRef = discoveryRef(nativeBytes);
    receipt.requestDigest = boundKnowledgeRequestDigest(receipt); receiptBytes = discoveryBytes(receipt); };
  reseal();
  const read = vi.fn(() => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(nativeBytes) }));
  const archive = { read, inspect: f.inspect };
  return { execution, response, receipt, native, reseal, read, archive,
    get reference() { return { receiptId: receipt.receiptId, receiptRef: discoveryRef(receiptBytes) }; },
    bytes: () => [Buffer.from(receiptBytes), Buffer.from(nativeBytes)],
    app: new KnowledgeApplication({ ...f.ports, boundKnowledgeArchive: archive }) };
}
const publish = (f: ReturnType<typeof ready>, k: ReturnType<typeof bound>, signal?: AbortSignal) =>
  k.app.importDiscoveredBoundKnowledge(f.selection, f.model, f.references(), k.reference, signal);

describe('explicit A/B initial catalog to bound knowledge handoff (authored returns)', () => {
  it.each(['codex', 'openai-api'] as const)('reads without writes and publishes/replays %s K without an extraction run or SP', executor => {
    const f = ready(executor), initial = f.ports.entities.read(f.imported.analysisId), originals = f.canonicalSnapshot();
    const entityWrite = vi.spyOn(f.ports.entities, 'write'), knowledgeWrite = vi.spyOn(f.ports.knowledge, 'write');
    const context = f.app.discoveredBoundKnowledgeContext(f.selection, f.model, f.references());
    expect(context.catalog).toEqual({ analysisId: f.imported.analysisId, revisionId: f.imported.revisionId,
      snapshotId: initial.snapshotId, sourceVersion: initial.sourceVersion, entities: initial.revisions[0].entities,
      mentions: initial.revisions[0].mentions, limitations: initial.revisions[0].limitations });
    expect(context.write).toEqual(f.imported.write); expect(context.chainDigest).toBe(f.imported.chainDigest);
    expect(entityWrite).not.toHaveBeenCalled(); expect(knowledgeWrite).not.toHaveBeenCalled();
    context.catalog.entities[0].label = 'Changed caller copy';
    expect(f.app.discoveredBoundKnowledgeContext(f.selection, f.model, f.references()).catalog).toEqual(f.context.catalog);
    const k = bound(f), bytes = k.bytes(), result = publish(f, k);
    expect(result).toMatchObject({ admissionStatus: 'admitted', semanticStatus: 'not_reviewed', entityChainDigest: f.imported.chainDigest,
      entityAnalysisRef: { analysisId: f.imported.analysisId, revisionId: f.imported.revisionId } });
    expect(result).not.toHaveProperty('entityRunId'); expect(result).not.toHaveProperty('formalReceipt');
    expect(result.committed).toHaveLength(1); expect(publish(f, k).committed).toEqual(result.committed);
    const saved = k.app.detail(result.committed[0].knowledgeId);
    expect(saved.history.generation).toBe(1); expect(saved.grounding.entityAnalysisRef).toEqual(result.entityAnalysisRef);
    expect(saved.revision.content.statements[0].subject.entityId).toBe(f.context.catalog.entities[0].entityId);
    expect(f.ports.entities.read(f.imported.analysisId)).toEqual(initial); expect(f.ports.runs.listManifests()).toEqual([]);
    expect(f.canonicalSnapshot()).toBe(originals); expect(k.bytes()).toEqual(bytes);
    expect(f.ports.id).not.toHaveBeenCalled(); expect(f.ports.now).not.toHaveBeenCalled();
    expect(f.forbiddenArchive.read).not.toHaveBeenCalled(); expect(f.forbiddenArchive.inspect).not.toHaveBeenCalled();
    const input = JSON.parse(k.receipt.request.input);
    expect(input.entityAnalysis).toEqual(f.context.catalog); expect(input.excerpts).toEqual(f.source.excerpts);
    expect(k.receipt.request.input).not.toContain('/authored/private'); expect(input).not.toHaveProperty('predecessors');
  });

  it('requires a real persisted initial analysis instead of accepting authenticated A/B alone', () => {
    const f = handoffSetup();
    expect(() => f.app.discoveredBoundKnowledgeContext(f.selection, f.model, f.references())).toThrow();
    expect(f.ports.entities.list().histories).toEqual([]); expect(f.ports.knowledge.list()).toEqual([]);
  });

  it.each(['revision-content', 'revision-actor', 'receipt-command', 'receipt-request', 'source'] as const)(
    'rejects changed initial storage %s before reading K', mode => {
      const f = ready(), k = bound(f), originalRead = f.ports.entities.read.bind(f.ports.entities);
      vi.spyOn(f.ports.entities, 'read').mockImplementation(id => {
        const history = structuredClone(originalRead(id));
        if (mode === 'revision-content') history.revisions[0].entities[0].description += ' changed';
        if (mode === 'revision-actor') history.revisions[0].revisedBy.actorId += '-changed';
        if (mode === 'receipt-command') history.receipts[0].commandDigest = discoveryHash('other write');
        if (mode === 'receipt-request') history.receipts[0].requestId = randomUUID();
        if (mode === 'source') history.sourceVersion = discoveryHash('other source');
        return history;
      });
      expect(() => publish(f, k)).toThrow('persisted initial revision');
      expect(k.read).not.toHaveBeenCalled(); expect(f.ports.knowledge.list()).toEqual([]);
    });

  it('authenticates the immutable initial revision rather than substituting a later head', () => {
    const f = ready(), first = f.ports.entities.read(f.imported.analysisId).revisions[0];
    const revision = { ...structuredClone(first), revisionId: randomUUID(), parentRevisionId: first.revisionId,
      revisedAt: at(4), revisedBy: f.ports.actor, revisionReason: 'Authored later edit.' };
    revision.entities[0].description = 'A later head is not the initial extraction.';
    f.ports.entities.write({ requestId: randomUUID(), analysisId: f.imported.analysisId,
      snapshotId: f.selection.snapshotId, sourceVersion: f.selection.sourceVersion,
      expectedGeneration: 1, expectedHeadRevisionId: first.revisionId, revision }, f.ports.actor);
    const context = f.app.discoveredBoundKnowledgeContext(f.selection, f.model, f.references());
    expect(context.catalog.entities).toEqual(first.entities); expect(context.catalog.revisionId).toBe(first.revisionId);
    expect(f.ports.entities.read(f.imported.analysisId).generation).toBe(2);
  });

  it('reauthenticates B and its write intent after context construction, before reading K', () => {
    const f = ready(), k = bound(f);
    f.bindingReceipt.finishedAt = at(4); f.resealB();
    expect(() => publish(f, k)).toThrow('persisted initial revision');
    expect(k.read).not.toHaveBeenCalled(); expect(f.ports.knowledge.list()).toEqual([]);
    expect(f.ports.entities.read(f.imported.analysisId).generation).toBe(1);
  });

  it.each([
    ['receiptId', 'A-receipt'], ['receiptId', 'A-attempt'], ['receiptId', 'B-receipt'], ['receiptId', 'B-attempt'],
    ['attemptId', 'A-receipt'], ['attemptId', 'A-attempt'], ['attemptId', 'B-receipt'], ['attemptId', 'B-attempt'],
    ['attemptId', 'K-receipt'],
  ] as const)('rejects resealed K %s reusing %s without writing knowledge', (field, target) => {
    const f = ready(), k = bound(f), ids = { 'A-receipt': f.discoveryReceipt.receiptId, 'A-attempt': f.discoveryReceipt.attemptId,
      'B-receipt': f.bindingReceipt.receiptId, 'B-attempt': f.bindingReceipt.attemptId, 'K-receipt': k.receipt.receiptId };
    k.receipt[field] = k.native[field] = ids[target]; k.reseal();
    expect(() => publish(f, k)).toThrow('reuses'); expect(f.ports.knowledge.list()).toEqual([]);
  });

  it.each([
    ['A-receipt', 'A-attempt', false], ['B-receipt', 'A-receipt', true], ['B-attempt', 'A-receipt', false],
    ['B-receipt', 'A-attempt', false], ['B-attempt', 'A-attempt', true], ['B-attempt', 'B-receipt', false],
  ] as const)('rejects predecessor role collision %s=%s before constructing K', (field, target, readerRejects) => {
    const f = handoffSetup(), ids = { 'A-receipt': f.discoveryReceipt.receiptId, 'A-attempt': f.discoveryReceipt.attemptId,
      'B-receipt': f.bindingReceipt.receiptId };
    if (field === 'A-receipt') {
      f.discoveryReceipt.receiptId = f.discoveryNative.receiptId = ids[target]; f.resealA();
      const execution = mentionBindingExecution(f.source, f.readA(), f.model);
      f.bindingReceipt.request = execution.request; f.bindingReceipt.producer = f.inspect(f.model.executor, execution.input);
      f.bindingResponse.binding = JSON.parse(execution.request.input).binding;
      f.result('binding').output = JSON.stringify(f.bindingResponse);
    } else if (field === 'B-receipt') f.bindingReceipt.receiptId = f.bindingNative.receiptId = ids[target];
    else f.bindingReceipt.attemptId = f.bindingNative.attemptId = ids[target];
    f.resealB();
    const importEntities = () => f.app.importDiscoveredEntities(f.selection, f.model, f.references());
    const error = field === 'B-attempt' && target === 'A-attempt' ? 'frozen predecessor' : 'independent';
    if (readerRejects) expect(importEntities).toThrow(error);
    else expect(importEntities().status).toBe('committed');
    expect(() => f.app.discoveredBoundKnowledgeContext(f.selection, f.model, f.references())).toThrow(error);
    expect(f.ports.knowledge.list()).toEqual([]); expect(f.ports.runs.listManifests()).toEqual([]);
  });

  it.each(['before', 'equal'] as const)('requires K start %s the B completion boundary', mode => {
    const f = ready(), k = bound(f); k.receipt.startedAt = mode === 'before' ? at(2) : f.bindingReceipt.finishedAt; k.reseal();
    if (mode === 'before') {
      expect(() => publish(f, k)).toThrow('predates'); expect(f.ports.knowledge.list()).toEqual([]);
    } else expect(publish(f, k).committed).toHaveLength(1);
  });

  it('preserves failed native K and root-rejected output without knowledge writes or repair', () => {
    const f = ready(), k = bound(f); k.native.outcome.result.ok = false; k.reseal();
    const failed = k.bytes(); expect(() => publish(f, k)).toThrow('complete successful native');
    expect(k.bytes()).toEqual(failed); expect(f.ports.knowledge.list()).toEqual([]);
    k.native.outcome.result.ok = true;
    k.response.binding.sourceProjectionDigest = discoveryHash('another projection');
    k.native.outcome.result.output = JSON.stringify(k.response); k.reseal();
    const rejected = k.bytes(), result = publish(f, k);
    expect(result).toMatchObject({ admissionStatus: 'rejected', committed: [], semanticStatus: 'not_reviewed',
      evidence: { rawOutput: k.native.outcome.result.output } });
    expect(k.bytes()).toEqual(rejected); expect(f.ports.knowledge.list()).toEqual([]);
  });

  it.each(['before-archive', 'after-authentication'] as const)('honors cancellation %s without knowledge writes', mode => {
    const f = ready(), k = bound(f), controller = new AbortController(); f.read.mockClear();
    if (mode === 'before-archive') controller.abort(new Error('Authored cancellation.'));
    else k.read.mockImplementationOnce(() => {
      controller.abort(new Error('Authored cancellation.'));
      const [receiptBytes, outcomeBytes] = k.bytes(); return { receiptBytes, outcomeBytes };
    });
    expect(() => publish(f, k, controller.signal)).toThrow('cancellation');
    if (mode === 'before-archive') { expect(f.read).not.toHaveBeenCalled(); expect(k.read).not.toHaveBeenCalled(); }
    expect(f.ports.knowledge.list()).toEqual([]);
  });

  it.each(['cancel-after-write', 'lost-acknowledgement'] as const)('replays the same per-proposal commands after %s', mode => {
    const f = ready(), k = bound(f, true), controller = new AbortController();
    const originalWrite = f.ports.knowledge.write.bind(f.ports.knowledge);
    const write = vi.spyOn(f.ports.knowledge, 'write').mockImplementationOnce((command, actor) => {
      const receipt = originalWrite(command, actor);
      if (mode === 'lost-acknowledgement') throw new Error('Authored lost acknowledgement.');
      controller.abort(new Error('Authored cancellation after commit.')); return receipt;
    });
    expect(() => publish(f, k, controller.signal)).toThrow('Authored');
    expect(f.ports.knowledge.list()).toHaveLength(1);
    const firstCommand = structuredClone(write.mock.calls[0]); write.mockRestore();
    const replay = vi.spyOn(f.ports.knowledge, 'write');
    const app = new KnowledgeApplication({ ...f.ports, boundKnowledgeArchive: k.archive });
    const result = app.importDiscoveredBoundKnowledge(f.selection, f.model, f.references(), k.reference);
    expect(replay.mock.calls[0]).toEqual(firstCommand);
    expect(result.committed).toHaveLength(2); expect(f.ports.knowledge.list().map(h => h.generation)).toEqual([1, 1]);
    expect(f.ports.entities.read(f.imported.analysisId).generation).toBe(1); expect(f.ports.runs.listManifests()).toEqual([]);
  });
});
