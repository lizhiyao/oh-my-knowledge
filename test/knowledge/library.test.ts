import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication, createLocalKnowledgeLibrary } from '../../src/knowledge/application/local.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import type { LibraryMember } from '../../src/knowledge/entity-library/contracts.js';
import { bodyActor as actor, bodyAt as at, bodyWrite } from './body-fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-body-library-')); roots.push(root);
  const app = createLocalKnowledgeApplication(root), library = createLocalKnowledgeLibrary(root);
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root), entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const associations = new FileKnowledgeAssociationStore(join(root, 'associations'), 'local', knowledge, entities, root);
  const source = app.capture({ path: join(root, 'authored.jsonl'), origin: { threadId: 'authored', title: 'Authored source' }, records: [{ recordIndex: 1,
    raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }) }] });
  const analysisId = randomUUID(), entityRevisionId = randomUUID(), entityIds = [randomUUID(), randomUUID()], mentionIds = [randomUUID(), randomUUID()];
  const catalog = { entities: ['Alpha', 'Beta'].map((label, index) => ({ entityId: entityIds[index], label, description: `来源内的${label}对象`, qualifiers: [],
    identityStatus: 'proposed' as const, possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null })),
    mentions: ['Alpha', 'Beta'].map((quote, index) => ({ mentionId: mentionIds[index], entityId: entityIds[index], selection: {
      evidenceRef: source.excerpts[0].evidenceRef, start: index ? 9 : 0, end: index ? 13 : 5, quote }, basis: 'explicit' as const, rationale: '来源明确提及' })), limitations: [] };
  entities.write({ analysisId, requestId: randomUUID(), snapshotId: source.snapshotId, sourceVersion: source.sourceVersion, expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { ...catalog, revisionId: entityRevisionId, revisedAt: at, revisedBy: actor, revisionReason: '独立派生目录' } }, actor);
  const body = bodyWrite(); body.revision.content.segments[0].evidence = [{ source: { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion },
    selection: { evidenceRef: source.excerpts[0].evidenceRef, start: 0, end: 13, quote: 'Alpha 使用 Beta' }, basis: 'source_assertion' }];
  body.revision.bodyDigest = knowledgeBodyDigest(body.revision); knowledge.write(body, actor);
  const projectionId = randomUUID(); associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: body.knowledgeId, expectedGeneration: 0,
    expectedHeadRevisionId: null, revision: { revisionId: projectionId, bodyRef: knowledgeBodyRef(body.revision), status: 'available', reviewStatus: 'pending',
      catalogRefs: [{ analysisId, entityRevisionId }], segmentEntityRefs: entityIds.map((entityId, index) => ({ segmentId: 's1', analysisId, entityRevisionId, entityId, mentionIds: [mentionIds[index]] })),
      typedRelations: [], issues: [], revisedAt: at, revisedBy: actor, revisionReason: '正文后的独立关联' } }, actor);
  const member = (index = 0): LibraryMember => ({ analysisId, entityId: entityIds[index], entityRevisionId, mentionIds: [mentionIds[index]], rationale: '明确核对来源限定和身份' });
  const save = (members = [member()], label = 'Alpha 对象') => library.save({ objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null,
    draft: { label, description: '用户明确确认的同一对象', referentKind: 'object', members }, reason: '人工组织', identityConfirmed: true });
  const review = (choice: 'accept' | 'reject') => app.reviewAssociations(body.knowledgeId, projectionId, associations.read(body.knowledgeId).generation, choice, '独立核对本次派生结果');
  return { root, app, library, knowledge, entities, associations, source, body, analysisId, entityRevisionId, entityIds, mentionIds, catalog, projectionId, member, save, review };
}
describe('body canonical knowledge library projections', () => {
  it('shows unassociated bodies, presents pending projections as needs_review and matches only independent accepted exact references', () => {
    const f = fixture(), object = f.save(), other = f.save([f.member(1)], 'Beta 对象');
    const pending = f.library.detail(object.objectId);
    expect(pending.counts).toEqual({ retained: 0, pending: 0, discarded: 0, needsReview: 1 });
    expect(pending.knowledge[0].segmentAssociations).toEqual([{ segmentId: 's1', entityRefs: [{ analysisId: f.analysisId, entityRevisionId: f.entityRevisionId, entityId: f.entityIds[0], mentionIds: [f.mentionIds[0]] }] }]);
    expect(pending.knowledge[0]).not.toHaveProperty('roles');
    f.app.maintain(f.body.knowledgeId, f.body.revision.revisionId, 'retain', '仅保留正文，不代表接受关联', 1);
    expect(f.library.detail(object.objectId).counts.needsReview).toBe(1);
    f.review('accept');
    const detail = f.library.detail(object.objectId); expect(detail.counts).toEqual({ retained: 1, pending: 0, discarded: 0, needsReview: 0 });
    expect(detail.knowledge[0].content).toEqual(f.body.revision.content); expect(detail.knowledge[0].projectionReviewStatus).toBe('accepted');
    expect(detail.relatedEntities).toEqual([{ analysisId: f.analysisId, entityId: f.entityIds[1], entityRevisionId: f.entityRevisionId, label: 'Beta', object: { objectId: other.objectId, label: 'Beta 对象' } }]);
    f.review('reject'); expect(f.library.detail(object.objectId).knowledge).toEqual([]);
    expect(f.library.knowledgeCatalog().rows[0].objects).toEqual([]); expect(f.library.knowledgeCatalog().rows).toHaveLength(1);
  });
  it('reads the precise catalog revision, flags later identity corrections, and never silently changes body attribution', () => {
    const f = fixture(), object = f.save(); f.review('accept');
    const bodyFile = join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]), before = readFileSync(bodyFile);
    f.entities.write({ analysisId: f.analysisId, requestId: randomUUID(), snapshotId: f.source.snapshotId, sourceVersion: f.source.sourceVersion, expectedGeneration: 1,
      expectedHeadRevisionId: f.entityRevisionId, revision: { ...f.catalog, entities: f.catalog.entities.map(entity => ({ ...entity, label: `修订${entity.label}` })),
        revisionId: randomUUID(), parentRevisionId: f.entityRevisionId, revisedAt: at, revisedBy: actor, revisionReason: '纠正有据含义' } }, actor);
    const detail = f.library.detail(object.objectId);
    expect(detail.knowledge[0].entities[0].label).toBe('Alpha'); expect(detail.knowledge[0].associationStatus).toBe('needs_review');
    expect(detail.counts.needsReview).toBe(1); expect(f.library.knowledgeCatalog().rows[0].objects[0].associationStatus).toBe('needs_review');
    expect(readFileSync(bodyFile)).toEqual(before);
  });
  it('does not transfer an accepted projection or retain to a new body revision, while the complete body stays in the catalog', () => {
    const f = fixture(), object = f.save(); f.review('accept');
    const draft = { title: '新的正文限定', content: f.body.revision.content, reuseRationale: f.body.revision.reuseRationale };
    const edited = f.app.revise(f.body.knowledgeId, f.body.revision.revisionId, 1, draft, '明确修订');
    expect(edited.derivedAssociations.status).toBe('stale'); expect(f.library.detail(object.objectId).knowledge).toEqual([]);
    expect(f.library.knowledgeCatalog().rows).toMatchObject([{ revisionId: edited.revision.revisionId, title: '新的正文限定', choice: null, objects: [] }]);
  });
  it('keeps source-loss knowledge readable and permits removing organization links without deleting body history', () => {
    const f = fixture(), object = f.save(); f.review('accept'); f.app.deleteSource(f.source.snapshotId);
    expect(f.library.detail(object.objectId).knowledge[0].sourceStatus).toBe('unavailable');
    const saved = f.library.save({ objectId: object.objectId, requestId: randomUUID(), generation: object.generation, headRevisionId: object.writeHeadRevisionId,
      draft: { ...object.revisions[0].draft, members: [] }, reason: '解除组织关联', identityConfirmed: true });
    expect(saved.revisions).toHaveLength(2); expect(f.library.detail(object.objectId).knowledge).toEqual([]);
    expect(f.app.detail(f.body.knowledgeId).revision).toEqual(f.body.revision);
  });
  it('preserves library ownership, explicit identity confirmation, CAS and stable request replay', () => {
    const f = fixture(), object = f.save(); expect(() => f.save()).toThrow('owner conflict');
    expect(() => f.save([{ ...f.member(1), mentionIds: [f.mentionIds[0]] }], 'wrong')).toThrow('evidence mismatch');
    const request = { objectId: object.objectId, requestId: randomUUID(), generation: 1, headRevisionId: object.writeHeadRevisionId,
      draft: { ...object.revisions[0].draft, description: '仅组织说明修订' }, reason: '限定组织说明', identityConfirmed: true as const };
    const updated = f.library.save(request); expect(f.library.save(request)).toEqual(updated);
    expect(() => f.library.save({ ...request, requestId: randomUUID() })).toThrow();
    expect(() => f.library.save({ ...request, reason: 'changed' })).toThrow('idempotency');
    expect(existsSync(join(f.root, '.knowledge-write.lock'))).toBe(false);
  });
  it('keeps healthy members readable and permits valid organization when unrelated knowledge is corrupt', () => {
    const f = fixture(), object = f.save(); writeFileSync(join(f.root, 'items', 'unrelated-corrupt.json'), '{bad');
    const detail = f.library.detail(object.objectId);
    expect(detail.members[0]).toMatchObject({ status: 'available', entity: { label: 'Alpha' }, sourceStatus: 'available' });
    expect(detail.knowledgeStatus).toBe('unavailable'); expect(detail.counts).toEqual({ retained: null, pending: null, discarded: null, needsReview: null });
    const added = f.save([f.member(1)], 'Beta 对象');
    expect(f.library.detail(added.objectId).members[0]).toMatchObject({ status: 'available', entity: { label: 'Beta' } });
    expect(createLocalKnowledgeLibrary(f.root).detail(object.objectId).members[0].status).toBe('available');
  });
  it('keeps the knowledge catalog source-free and deduplicates exact source reads within an object request', () => {
    const f = fixture(), object = f.save(); f.review('accept');
    const source = vi.spyOn(TraceEvidenceStore.prototype, 'read');
    expect(f.library.knowledgeCatalog().rows).toHaveLength(1); expect(source).not.toHaveBeenCalled();
    expect(f.library.detail(object.objectId).knowledge[0].sourceStatus).toBe('available'); expect(source).toHaveBeenCalledTimes(1);
    f.app.deleteSource(f.source.snapshotId); source.mockClear();
    expect(f.library.detail(object.objectId).knowledge[0].sourceStatus).toBe('unavailable'); expect(source).toHaveBeenCalledTimes(1);
  });
  it('keeps known object knowledge during unrelated association failures and restores counts after repair', () => {
    const f = fixture(), object = f.save(); f.review('accept');
    const ownProjectionFile = join(f.root, 'associations', readdirSync(join(f.root, 'associations'))[0]);
    f.app.maintain(f.body.knowledgeId, f.body.revision.revisionId, 'retain', '保留健康对象知识', 1);
    const quote = 'Gamma 使用 Delta';
    const source = f.app.capture({ path: join(f.root, 'unrelated.jsonl'), records: [{ recordIndex: 1,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: quote }] } }) }] });
    const unrelated = bodyWrite(); unrelated.knowledgeId = unrelated.revision.knowledgeId = 'unrelated-knowledge';
    unrelated.requestId = randomUUID(); unrelated.revision.revisionId = 'unrelated-revision'; unrelated.revision.title = 'Gamma 的来源报告';
    unrelated.revision.content.segments[0] = { segmentId: 's1', text: '来源称 Gamma 使用 Delta；版本和发生时间未知。', evidence: [{
      source: { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion },
      selection: { evidenceRef: source.excerpts[0].evidenceRef, start: 0, end: quote.length, quote }, basis: 'source_assertion' }] };
    unrelated.revision.bodyDigest = knowledgeBodyDigest(unrelated.revision); f.knowledge.write(unrelated, actor);
    const failedProjectionId = randomUUID();
    f.associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: unrelated.knowledgeId, expectedGeneration: 0,
      expectedHeadRevisionId: null, revision: { revisionId: failedProjectionId, bodyRef: knowledgeBodyRef(unrelated.revision), status: 'failed',
        reviewStatus: 'pending', catalogRefs: [], segmentEntityRefs: [], typedRelations: [], issues: ['无关来源的关联生成失败'],
        revisedAt: at, revisedBy: actor, revisionReason: '保留独立失败记录' } }, actor);
    const partial = f.library.detail(object.objectId);
    expect(partial.members[0]).toMatchObject({ status: 'available', entity: { label: 'Alpha' }, sourceStatus: 'available' });
    expect(partial.knowledge.map(item => item.knowledgeId)).toEqual([f.body.knowledgeId]);
    expect(partial.knowledge[0]).toMatchObject({ associationStatus: 'matched', choice: 'retain' });
    expect(partial.knowledgeStatus).toBe('unavailable');
    expect(partial.counts).toEqual({ retained: null, pending: null, discarded: null, needsReview: null });
    f.app.applyAssociations(unrelated.knowledgeId, unrelated.revision.revisionId, unrelated.revision.bodyDigest, 1,
      { catalogRefs: [], segmentEntityRefs: [], typedRelations: [], issues: ['独立核对后暂未确认实体关联'] }, '修复无关投影，不改变已有对象归属');
    const restored = f.library.detail(object.objectId);
    expect(restored.knowledgeStatus).toBe('available'); expect(restored.knowledge.map(item => item.knowledgeId)).toEqual([f.body.knowledgeId]);
    expect(restored.counts).toEqual({ retained: 1, pending: 0, discarded: 0, needsReview: 0 });
    expect(f.associations.read(unrelated.knowledgeId).revisions.map(revision => revision.status)).toEqual(['failed', 'available']);
    writeFileSync(ownProjectionFile, '{bad');
    const unavailable = f.library.detail(object.objectId);
    expect(unavailable.knowledge).toEqual([]); expect(unavailable.knowledgeStatus).toBe('unavailable');
    expect(unavailable.counts).toEqual({ retained: null, pending: null, discarded: null, needsReview: null });
    expect(f.app.detail(f.body.knowledgeId).revision).toEqual(f.body.revision);
  });
  it('fails closed for damaged organization storage and redirected paths without hiding independent body catalog rows', () => {
    const f = fixture(), object = f.save(); const file = join(f.root, 'library', `${object.objectId}.json`), before = readFileSync(file);
    writeFileSync(file, '{bad'); expect(() => f.library.catalog()).toThrow(); writeFileSync(file, before);
    rmSync(join(f.root, 'library'), { recursive: true }); symlinkSync(join(f.root, 'entities'), join(f.root, 'library'));
    expect(() => f.library.catalog()).toThrow('storage directory'); expect(f.app.list()).toHaveLength(1);
  });
});
