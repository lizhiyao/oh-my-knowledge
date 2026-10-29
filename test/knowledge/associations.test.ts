import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import { selectKnowledgeAssociation, type KnowledgeAssociationWrite } from '../../src/knowledge/associations.js';
import { bodyActor as actor, bodyAt as at, bodyWrite } from './body-fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-association-')); roots.push(root);
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root), entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const store = new FileKnowledgeAssociationStore(join(root, 'associations'), 'local', knowledge, entities, root);
  const body = bodyWrite(); knowledge.write(body, actor);
  const evidence = body.revision.content.segments[0].evidence[0];
  const analysisId = randomUUID(), revisionId = randomUUID(), entityId = randomUUID(), mentionId = randomUUID();
  const catalog = { entities: [{ entityId, label: 'Alpha', description: '来源中的对象', qualifiers: [], identityStatus: 'proposed' as const,
    possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null }],
  mentions: [{ mentionId, entityId, selection: evidence.selection, basis: 'explicit' as const, rationale: '来源原文' }], limitations: [] };
  entities.write({ requestId: randomUUID(), analysisId, ...evidence.source, expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { ...catalog, revisionId, revisedAt: at, revisedBy: actor, revisionReason: '独立派生目录' } }, actor);
  const command: Extract<KnowledgeAssociationWrite, { commandKind: 'append_revision' }> = { commandKind: 'append_revision', requestId: 'association-1', knowledgeId: body.knowledgeId,
    expectedGeneration: 0, expectedHeadRevisionId: null, revision: { revisionId: 'association-revision-1', bodyRef: knowledgeBodyRef(body.revision),
      status: 'available', reviewStatus: 'pending', catalogRefs: [{ analysisId, entityRevisionId: revisionId }],
      segmentEntityRefs: [{ segmentId: 's1', analysisId, entityRevisionId: revisionId, entityId, mentionIds: [mentionId] }],
      typedRelations: [{ relationId: 'r1', segmentIds: ['s1'], subject: { analysisId, entityRevisionId: revisionId, entityId }, relation: '被来源报告采用', modality: 'descriptive', polarity: 'positive', evidence: [evidence], issues: ['派生标签尚待复核'] }],
      issues: [], revisedAt: at, revisedBy: actor, revisionReason: '正文之后的派生关联' } };
  return { root, knowledge, entities, store, body, command, analysisId, revisionId, catalog };
}
describe('independent body-derived association histories', () => {
  it('binds exact body/catalog revisions, persists optional typed rows pending and never rewrites body', () => {
    const f = fixture(), path = join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]), original = readFileSync(path);
    const receipt = f.store.write(f.command, actor); expect(f.store.write(f.command, actor)).toEqual(receipt);
    // A later catalog revision does not reinterpret an old association through latest.
    f.entities.write({ requestId: randomUUID(), analysisId: f.analysisId, ...f.body.revision.content.segments[0].evidence[0].source,
      expectedGeneration: 1, expectedHeadRevisionId: f.revisionId, revision: { ...f.catalog, entities: [], mentions: [],
        revisionId: randomUUID(), parentRevisionId: f.revisionId, revisedAt: at, revisedBy: actor, revisionReason: '独立目录更新' } }, actor);
    const selection = selectKnowledgeAssociation(f.store.read(f.body.knowledgeId), knowledgeBodyRef(f.body.revision));
    expect(selection.status).toBe('available'); expect(selection.revision?.reviewStatus).toBe('pending');
    expect(selection.revision?.typedRelations?.[0].issues).toEqual(['派生标签尚待复核']);
    expect(readFileSync(path)).toEqual(original);
    expect(() => f.store.write({ ...f.command, revision: { ...f.command.revision, issues: ['changed'] } }, actor)).toThrow('idempotency_conflict');
  });
  it('makes body revisions stale without inheriting links or retain, and allows explicit failed results', () => {
    const f = fixture(); f.store.write(f.command, actor);
    const edit = structuredClone(f.body); edit.requestId = 'edit'; edit.expectedGeneration = 1; edit.expectedHeadRevisionId = f.body.revision.revisionId;
    edit.revision.revisionId = 'body-r2'; edit.revision.parentRevision = { knowledgeId: f.body.knowledgeId, revisionId: f.body.revision.revisionId };
    edit.revision.content.segments[0].text += ' 新增必要限制。'; edit.revision.bodyDigest = knowledgeBodyDigest(edit.revision); f.knowledge.write(edit, actor);
    expect(selectKnowledgeAssociation(f.store.read(f.body.knowledgeId), knowledgeBodyRef(edit.revision)).status).toBe('stale');
    const failure = structuredClone(f.command); failure.requestId = 'failed'; failure.expectedGeneration = 1; failure.expectedHeadRevisionId = f.command.revision.revisionId;
    failure.revision = { revisionId: 'association-failed', parentRevisionId: f.command.revision.revisionId, bodyRef: knowledgeBodyRef(edit.revision),
      status: 'failed', reviewStatus: 'pending', catalogRefs: [], segmentEntityRefs: [], issues: ['原生关联失败；正文保留'], revisedAt: at, revisedBy: actor, revisionReason: '显式失败结果' };
    f.store.write(failure, actor);
    expect(selectKnowledgeAssociation(f.store.read(f.body.knowledgeId), knowledgeBodyRef(edit.revision)).status).toBe('failed');
    expect(selectKnowledgeAssociation(undefined, knowledgeBodyRef(edit.revision)).status).toBe('absent');
    expect(f.knowledge.read(f.body.knowledgeId).revisions).toHaveLength(2);
  });
  it('records independent append-only review decisions with CAS and resets effective review for each new projection', () => {
    const f = fixture(); f.store.write(f.command, actor);
    const beforeBody = f.knowledge.read(f.body.knowledgeId), beforeProjection = f.store.read(f.body.knowledgeId).revisions[0];
    const review: Extract<KnowledgeAssociationWrite, { commandKind: 'record_review' }> = { commandKind: 'record_review',
      requestId: 'review-1', knowledgeId: f.body.knowledgeId, expectedGeneration: 1,
      review: { projectionRevisionId: f.command.revision.revisionId, choice: 'accept', actor, at, reason: '显式核对本次派生映射' } };
    const receipt = f.store.write(review, actor); expect(f.store.write(review, actor)).toEqual(receipt);
    let history = f.store.read(f.body.knowledgeId);
    expect(selectKnowledgeAssociation(history, knowledgeBodyRef(f.body.revision)).reviewStatus).toBe('accepted');
    expect(history.revisions[0]).toEqual(beforeProjection); expect(history.revisions[0].reviewStatus).toBe('pending');
    expect(() => f.store.write({ ...review, review: { ...review.review, reason: 'changed' } }, actor)).toThrow('idempotency_conflict');
    expect(() => f.store.write({ ...review, requestId: 'stale' }, actor)).toThrow('conflict');
    expect(() => f.store.write({ ...review, requestId: 'other', expectedGeneration: 2 }, { ...actor, actorId: 'impersonated' })).toThrow('unauthorized');
    const next = structuredClone(f.command); next.requestId = 'projection-2'; next.expectedGeneration = 2;
    next.expectedHeadRevisionId = f.command.revision.revisionId; next.revision.revisionId = 'projection-r2'; next.revision.parentRevisionId = f.command.revision.revisionId;
    f.store.write(next, actor); history = f.store.read(f.body.knowledgeId);
    expect(selectKnowledgeAssociation(history, knowledgeBodyRef(f.body.revision)).reviewStatus).toBe('pending');
    f.store.write({ ...review, requestId: 'reject', expectedGeneration: 3,
      review: { ...review.review, projectionRevisionId: next.revision.revisionId, choice: 'reject', reason: '映射待纠正' } }, actor);
    history = f.store.read(f.body.knowledgeId); expect(history.reviews).toHaveLength(2);
    expect(selectKnowledgeAssociation(history, knowledgeBodyRef(f.body.revision)).reviewStatus).toBe('rejected');
    expect(history.revisions[0]).toEqual(beforeProjection); expect(f.knowledge.read(f.body.knowledgeId)).toEqual(beforeBody);
  });
  it('requires explicit migration of legacy histories and refuses legacy unqualified writes', () => {
    const f = fixture(); f.store.write(f.command, actor);
    const path = join(f.root, 'associations', readdirSync(join(f.root, 'associations'))[0]);
    const history = JSON.parse(readFileSync(path, 'utf8')); history.schemaVersion = 1; writeFileSync(path, JSON.stringify(history));
    expect(() => f.store.read(f.body.knowledgeId)).toThrow('knowledge_storage_unsupported');
    const legacy = structuredClone(f.command) as unknown as { revision: Record<string, unknown> };
    legacy.revision.entityAnalysisRef = { analysisId: f.analysisId, revisionId: f.revisionId }; delete legacy.revision.catalogRefs;
    expect(() => f.store.write(legacy as unknown as KnowledgeAssociationWrite, actor)).toThrow();
    expect(f.knowledge.read(f.body.knowledgeId).revisions[0]).toEqual(f.body.revision);
  });
  it.each(['digest', 'segment', 'catalog', 'mention', 'evidence', 'duplicate_catalog', 'undeclared_endpoint'] as const)('refuses %s drift without blocking saved body', target => {
    const f = fixture(), invalid = structuredClone(f.command);
    if (target === 'digest') invalid.revision.bodyRef.bodyDigest = `sha256:${'b'.repeat(64)}`;
    if (target === 'segment') invalid.revision.segmentEntityRefs[0].segmentId = 'missing';
    if (target === 'catalog') invalid.revision.catalogRefs[0].entityRevisionId = randomUUID();
    if (target === 'mention') invalid.revision.segmentEntityRefs[0].mentionIds = [randomUUID()];
    if (target === 'duplicate_catalog') invalid.revision.catalogRefs.push(invalid.revision.catalogRefs[0]);
    if (target === 'undeclared_endpoint') invalid.revision.typedRelations![0].subject.analysisId = randomUUID();
    if (target === 'evidence') invalid.revision.typedRelations![0].evidence[0].selection.quote = 'Other';
    expect(() => f.store.write(invalid, actor)).toThrow(); expect(f.store.list()).toEqual([]);
    expect(f.knowledge.read(f.body.knowledgeId).revisions[0]).toEqual(f.body.revision);
  });
});
