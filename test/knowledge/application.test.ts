import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import type { EntityAnalysisDraft } from '../../src/knowledge/entities/contracts.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import { executeKnowledgeOperation, KnowledgeOperationSchema } from '../../src/knowledge/application/operations.js';
import { executeKnowledgeCandidateAction } from '../../src/studio/application/knowledge/knowledge-candidates.js';
import { bodyActor as actor, bodyAt as at, bodyWrite } from './body-fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(text = 'Alpha 使用 Beta', options: { prefix?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omk-current-body-app-')); roots.push(root);
  const app = createLocalKnowledgeApplication(root), source = join(root, 'authored.jsonl');
  writeFileSync(source, JSON.stringify({ timestamp: '2026-10-27T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
  const snapshot = app.capture({ path: source, origin: { threadId: 'authored-thread', title: 'Authored source' } });
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root), entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const associations = new FileKnowledgeAssociationStore(join(root, 'associations'), 'local', knowledge, entities, root);
  const analysisId = randomUUID(), entityRevisionId = randomUUID(), entityIds = [randomUUID(), randomUUID()];
  const firstAlpha = options.prefix ? text.indexOf('Alpha', options.prefix.length) : text.indexOf('Alpha'), beta = text.indexOf('Beta');
  const mentions = ['Alpha', 'Beta'].map((quote, index) => ({ mentionId: randomUUID(), entityId: entityIds[index], selection: { evidenceRef: snapshot.excerpts[0].evidenceRef,
    quote, start: index ? beta : firstAlpha, end: (index ? beta : firstAlpha) + quote.length }, basis: 'explicit' as const, rationale: '作者夹具；来源精确提及' }));
  const catalog: EntityAnalysisDraft = { entities: ['Alpha', 'Beta'].map((label, index) => ({ entityId: entityIds[index], label, description: '选定来源内的对象；没有跨窗口合并', qualifiers: [],
    identityStatus: 'proposed' as const, possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null })), mentions, limitations: [] };
  entities.write({ analysisId, requestId: randomUUID(), snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion, expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { ...catalog, revisionId: entityRevisionId, revisedAt: at, revisedBy: actor, revisionReason: '独立公开实体存储夹具；无模型调用' } }, actor);
  const body = bodyWrite(); body.revision.content.segments[0].text = `来源报告：${text}。事实发生时间与未来适用范围未知，来源消息时间不作为事实时间。`;
  body.revision.content.segments[0].evidence = [{ source: { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion },
    selection: { evidenceRef: snapshot.excerpts[0].evidenceRef, start: 0, end: text.length, quote: text }, basis: 'source_assertion' }];
  body.revision.bodyDigest = knowledgeBodyDigest(body.revision); knowledge.write(body, actor);
  const projectionId = randomUUID(); associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: body.knowledgeId, expectedGeneration: 0,
    expectedHeadRevisionId: null, revision: { revisionId: projectionId, bodyRef: knowledgeBodyRef(body.revision), status: 'available', reviewStatus: 'pending', entityAnalysisRef: { analysisId, revisionId: entityRevisionId },
      segmentEntityRefs: entityIds.map((entityId, index) => ({ segmentId: 's1', entityId, mentionIds: [mentions[index].mentionId] })), issues: [],
      revisedAt: at, revisedBy: actor, revisionReason: '独立正文关联夹具' } }, actor);
  return { root, app, source, snapshot, knowledge, entities, associations, analysisId, entityRevisionId, entityIds, catalog, body, projectionId };
}
describe('shared canonical body application', () => {
  it('reads exact body evidence and independent pending projection through source/current public operations', async () => {
    const f = setup(), detail = f.app.detail(f.body.knowledgeId);
    expect(detail.revision).toEqual(f.body.revision); expect(detail.derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending' });
    expect(await executeKnowledgeOperation(f.app, { operation: 'show', id: f.body.knowledgeId })).toEqual(detail);
    expect(await executeKnowledgeOperation(f.app, { operation: 'quality' })).toMatchObject({ projectionKind: 'knowledge-body-admission', semanticQuality: 'not_assessed' });
    expect(f.app.runs()).toEqual({ current: [], unsupported: [], unavailable: [], archiveChecks: [] }); // Store fixtures never invent a generation run.
  });
  it('preserves literal configuration types, scope and unknown time through save/reopen without requiring typed labels', () => {
    const text = "Alpha 在测试环境的 enabled 为布尔值 false，Beta 生产配置为字符串 'false'；没有记录运行效果。";
    const f = setup(text), reopened = createLocalKnowledgeApplication(f.root).detail(f.body.knowledgeId);
    expect(reopened.revision.content.segments[0].text).toContain(text); expect(reopened.revision.content.segments[0].text).toContain('事实发生时间与未来适用范围未知');
    expect(reopened.revision.content.segments[0].evidence[0].basis).toBe('source_assertion');
    expect(reopened.revision.content).not.toHaveProperty('statements'); expect(reopened.revision).not.toHaveProperty('entities');
  });
  it('corrects entity meaning independently without changing historical body, exact projection catalog or source evidence', () => {
    const f = setup(), before = f.app.detail(f.body.knowledgeId), edit = structuredClone(f.catalog);
    edit.entities[0].description = '来源中的测试构建，发布状态未知'; edit.entities[0].uncertainties = ['尚无版本依据'];
    const updated = f.app.correctEntities(f.analysisId, f.entityRevisionId, 1, { entities: edit.entities, mentions: edit.mentions }, '有据修订');
    expect(updated.history.generation).toBe(2); expect(f.app.entities(f.analysisId, f.entityRevisionId).revision.entities[0].description).toBe(f.catalog.entities[0].description);
    const expected = structuredClone(before);
    if (expected.derivedCatalog.status !== 'available') throw new Error('Expected an exact catalog projection.');
    expected.derivedCatalog.currentHeadRevisionId = updated.revision.revisionId;
    expect(f.app.detail(f.body.knowledgeId)).toEqual(expected);
    expect(f.app.queryEntities({ query: 'Alpha' }).rows).toHaveLength(1);
    expect(f.app.entityDetail(f.analysisId, f.entityIds[0]).knowledge[0].currentEntityRevision).toBe(false);
    expect(() => f.app.correctEntities(f.analysisId, f.entityRevisionId, 1, { entities: edit.entities, mentions: edit.mentions }, '过期')).toThrow('conflict');
  });
  it('rejects foreign IDs, moved identifier fragments and fabricated quotes before appending an entity correction', () => {
    const prefix = '_prefixAlphaSuffix；', f = setup(`${prefix}Alpha 使用 Beta`, { prefix }), original = f.entities.read(f.analysisId);
    const foreign = structuredClone(f.catalog); foreign.entities[0].entityId = randomUUID();
    expect(() => f.app.correctEntities(f.analysisId, f.entityRevisionId, 1, { entities: foreign.entities, mentions: foreign.mentions }, '外部身份')).toThrow('Unknown correction identity');
    const fragment = structuredClone(f.catalog); fragment.mentions[0].mentionId = 'new:fragment'; fragment.mentions[0].selection.start = 7; fragment.mentions[0].selection.end = 12;
    expect(() => f.app.correctEntities(f.analysisId, f.entityRevisionId, 1, { entities: fragment.entities, mentions: fragment.mentions }, '标识符子串')).toThrow('mention_identifier_fragment');
    const invented = structuredClone(f.catalog); invented.mentions[0].selection.quote = 'Other';
    expect(() => f.app.correctEntities(f.analysisId, f.entityRevisionId, 1, { entities: invented.entities, mentions: invented.mentions }, '虚构引用')).toThrow('correction');
    expect(f.entities.read(f.analysisId)).toEqual(original); expect(f.app.detail(f.body.knowledgeId).revision).toEqual(f.body.revision);
  });
  it('maps new local correction IDs together and preserves immutable old mention positions', () => {
    const f = setup(), edit = structuredClone(f.catalog), oldSelection = edit.mentions[0].selection;
    edit.entities[0].entityId = 'new:alpha'; edit.mentions[0].entityId = 'new:alpha'; edit.mentions[0].mentionId = 'new:alpha-mention';
    const result = f.app.correctEntities(f.analysisId, f.entityRevisionId, 1, { entities: edit.entities, mentions: edit.mentions }, '显式纠正局部身份');
    expect(result.revision.entities[0].entityId).not.toMatch(/^new:/); expect(result.revision.mentions[0].entityId).toBe(result.revision.entities[0].entityId);
    expect(f.app.entities(f.analysisId, f.entityRevisionId).revision.mentions[0].selection).toEqual(oldSelection);
  });
  it('applies a corrected derived projection without revising body, then requires an independent review action', () => {
    const f = setup(), bodyFile = join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]), before = readFileSync(bodyFile);
    const updated = f.app.applyAssociations(f.body.knowledgeId, f.body.revision.revisionId, f.body.revision.bodyDigest, f.analysisId, f.entityRevisionId, 1,
      { segmentEntityRefs: [{ segmentId: 's1', entityId: f.entityIds[0], mentionIds: [f.catalog.mentions[0].mentionId] }], typedRelations: [], issues: ['人工映射仍需独立核对'] }, '明确修订关联');
    expect(updated.derivedAssociations.reviewStatus).toBe('pending'); const projection = updated.derivedAssociations.revision!;
    const reviewed = f.app.reviewAssociations(f.body.knowledgeId, projection.revisionId, 2, 'accept', '已逐项核对本投影');
    expect(reviewed.derivedAssociations.reviewStatus).toBe('accepted'); expect(reviewed.maintenance).toBeNull(); expect(readFileSync(bodyFile)).toEqual(before);
    expect(() => f.app.applyAssociations(f.body.knowledgeId, f.body.revision.revisionId, f.body.revision.bodyDigest, f.analysisId, f.entityRevisionId, 3,
      { segmentEntityRefs: [{ segmentId: 's1', entityId: f.entityIds[1], mentionIds: [f.catalog.mentions[0].mentionId] }], issues: [] }, '错误提及归属')).toThrow('mention');
  });
  it('retains and revises without transferring maintenance/projection acceptance, and rejects invalid or missing-source edits', () => {
    const f = setup(); f.app.maintain(f.body.knowledgeId, f.body.revision.revisionId, 'retain', '保留正文', 1);
    f.app.reviewAssociations(f.body.knowledgeId, f.projectionId, 1, 'accept', '独立接受关联');
    const draft = { title: '明确限定的新正文', content: f.body.revision.content, reuseRationale: f.body.revision.reuseRationale };
    const invalid = structuredClone(draft); invalid.content.segments[0].evidence[0].selection.quote = 'invented';
    expect(() => f.app.revise(f.body.knowledgeId, f.body.revision.revisionId, 2, invalid, '错误引用')).toThrow('evidence');
    const after = f.app.revise(f.body.knowledgeId, f.body.revision.revisionId, 2, draft, '正文修订');
    expect(after.maintenance).toBeNull(); expect(after.derivedAssociations.status).toBe('stale'); expect(f.app.detail(f.body.knowledgeId, f.body.revision.revisionId).maintenance?.choice).toBe('retain');
    f.app.deleteSource(f.snapshot.snapshotId); expect(f.app.detail(f.body.knowledgeId).sources[0].status).toBe('unavailable');
    expect(() => f.app.revise(f.body.knowledgeId, after.revision.revisionId, after.history.generation, draft, '缺来源')).toThrow('unavailable');
  });
  it('keeps body independent of damaged entity/derived storage and exposes unsupported old run inventory without decoding it', () => {
    const f = setup(), file = join(f.root, 'entities', `${f.analysisId}.json`); writeFileSync(file, '{bad');
    expect(() => f.app.entities(f.analysisId)).toThrow(); expect(f.app.queryEntities()).toMatchObject({ total: 0, unavailableAnalyses: 1 });
    expect(f.app.detail(f.body.knowledgeId)).toMatchObject({ revision: { bodyDigest: f.body.revision.bodyDigest }, derivedAssociations: { status: 'failed' } });
    const legacy = join(f.root, 'extraction-runs');
    // Explicit old manifests are inventoried, never read as a current generation journal.
    const id = randomUUID(); mkdirSync(legacy); writeFileSync(join(legacy, `${id}.json`), '{"runKind":"knowledge-extraction-run","schemaVersion":5}');
    expect(f.app.runs().unsupported).toMatchObject([{ runId: id, schemaStatus: 'unsupported' }]);
  });
  it('isolates healthy entity identity and source from an unrelated corrupt knowledge file', () => {
    const f = setup(); writeFileSync(join(f.root, 'items', 'unrelated-corrupt.json'), '{bad');
    expect(() => f.app.list()).toThrow();
    expect(f.app.queryEntities({ pageSize: 1 })).toMatchObject({ total: 2, knowledgeStatus: 'unavailable',
      rows: [{ knowledgeCount: null, outdatedKnowledgeCount: null }] });
    expect(f.app.entityDetail(f.analysisId, f.entityIds[0])).toMatchObject({ entity: { label: 'Alpha' }, knowledgeStatus: 'unavailable' });
    expect(f.app.entityBasis(f.analysisId, f.entityIds[0]).mentionChecks[0].positionStatus).toBe('matched');
    expect(f.app.detail(f.body.knowledgeId).revision).toEqual(f.body.revision);
  });
  it('shares one knowledge/association projection per page and skips it for a search with no matches', () => {
    const f = setup(), knowledge = vi.spyOn(FileKnowledgeStore.prototype, 'list');
    const associations = vi.spyOn(FileKnowledgeAssociationStore.prototype, 'read'), source = vi.spyOn(TraceEvidenceStore.prototype, 'read');
    expect(f.app.queryEntities({ pageSize: 1 })).toMatchObject({ total: 2, knowledgeStatus: 'available', rows: [{ knowledgeCount: 1 }] });
    expect(knowledge).toHaveBeenCalledTimes(1); expect(associations).toHaveBeenCalledTimes(1); expect(source).toHaveBeenCalledTimes(1);
    knowledge.mockClear(); associations.mockClear(); source.mockClear();
    expect(f.app.queryEntities({ query: 'no matching object', pageSize: 1 }).rows).toEqual([]);
    expect(knowledge).not.toHaveBeenCalled(); expect(associations).not.toHaveBeenCalled(); expect(source).toHaveBeenCalledTimes(1);
  });
  it('marks association counts unknown on corrupt derived storage while preserving entity evidence', () => {
    const f = setup(); writeFileSync(join(f.root, 'associations', readdirSync(join(f.root, 'associations'))[0]), '{bad');
    expect(f.app.queryEntities()).toMatchObject({ knowledgeStatus: 'unavailable', rows: [{ knowledgeCount: null }, { knowledgeCount: null }] });
    expect(f.app.entityDetail(f.analysisId, f.entityIds[0])).toMatchObject({ entity: { label: 'Alpha' }, knowledgeStatus: 'unavailable' });
  });
  it('uses current Studio/operation revision and tag inputs and rejects obsolete generator policy/citation aliases', async () => {
    const f = setup();
    await executeKnowledgeCandidateAction({ operation: 'tag', workspace: f.root, id: f.body.knowledgeId, generation: 0, tags: ['范围'] }, undefined, () => f.app);
    expect(f.app.detail(f.body.knowledgeId).tagging.tags).toEqual(['范围']);
    expect(KnowledgeOperationSchema.safeParse({ operation: 'generate', snapshot: f.snapshot.snapshotId, executor: 'codex', model: 'fixture', policy: {} }).success).toBe(false);
    expect(KnowledgeOperationSchema.safeParse({ operation: 'revise', id: f.body.knowledgeId, revision: f.body.revision.revisionId, generation: 1, draft: {}, reason: '修改', citationLocators: [] }).success).toBe(false);
  });
});
