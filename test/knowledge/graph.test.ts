import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedKnowledgeWorkspace } from '../cli/knowledge-fixtures.js';
import { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { FileKnowledgeRelationStore } from '../../src/knowledge/adapters/relation-store.js';
import { captureTraceFixture, sourceRef } from '../helpers/knowledge-source.js';
import { knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import type { KnowledgeGraph } from '../../src/knowledge/application/graph.js';
import { relationOtherActor, relationsFixture } from './relations-fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-graph-')); roots.push(root);
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root), entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  return { root, app: createLocalKnowledgeApplication(root), knowledge, entities,
    associations: new FileKnowledgeAssociationStore(join(root, 'associations'), 'local', knowledge, entities, root) };
}
function diskBytes(root: string) {
  const files: [string, string][] = [];
  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else files.push([relative(root, path), readFileSync(path).toString('base64')]);
    }
  }
  visit(root); return files;
}
const knowledgeNodes = (graph: KnowledgeGraph) => graph.nodes.filter(node => node.nodeKind === 'knowledge');
const entityNodes = (graph: KnowledgeGraph) => graph.nodes.filter(node => node.nodeKind === 'entity');
const sourceNodes = (graph: KnowledgeGraph) => graph.nodes.filter(node => node.nodeKind === 'source');

describe('exact knowledge graph read projection', () => {
  it('keeps same-name source entities distinct, exposes exact evidence, and performs no writes or generation', () => {
    const f = workspace(), first = seedKnowledgeWorkspace(f.root, 'first'), second = seedKnowledgeWorkspace(f.root, 'second');
    const before = diskBytes(f.root), writes = [vi.spyOn(FileKnowledgeStore.prototype, 'write'), vi.spyOn(FileEntityAnalysisStore.prototype, 'write'), vi.spyOn(FileKnowledgeAssociationStore.prototype, 'write')];
    const generation = vi.spyOn(KnowledgeApplication.prototype, 'generate'), rebuild = vi.spyOn(KnowledgeApplication.prototype, 'rebuildAssociations');
    const graph = f.app.graph({ knowledgeIds: [first.body.knowledgeId, second.body.knowledgeId] });
    expect(graph).toMatchObject({ projectionKind: 'knowledge-graph', schemaVersion: 3 });
    expect(graph.coverage).toEqual({ status: 'available', gaps: [] });
    expect(knowledgeNodes(graph)).toHaveLength(2); expect(sourceNodes(graph)).toHaveLength(2);
    const alphas = entityNodes(graph).filter(node => node.label === 'Alpha');
    expect(alphas).toHaveLength(2); expect(new Set(alphas.map(node => node.nodeId)).size).toBe(2);
    expect(new Set(alphas.map(node => node.analysisId)).size).toBe(2);
    expect(graph.edges.filter(edge => edge.edgeKind === 'segment_entity')).toHaveLength(4);
    expect(graph.edges.some(edge => edge.edgeKind === 'typed_relation')).toBe(false);
    expect(graph.edges.filter(edge => edge.edgeKind === 'source_evidence')).toEqual(expect.arrayContaining([
      expect.objectContaining({ segmentId: 's1', positionStatus: 'matched', evidence: first.body.content.segments[0].evidence[0] }),
    ]));
    expect(JSON.stringify(graph)).not.toContain(f.root);
    JSON.stringify(graph, (key, value) => {
      expect(['sourcePath', 'records', 'raw']).not.toContain(key);
      return value;
    });
    expect(f.app.graph({ knowledgeIds: [first.body.knowledgeId, second.body.knowledgeId] })).toEqual(graph);
    graph.nodes.splice(0); expect(f.app.graph({ knowledgeIds: [first.body.knowledgeId] }).nodes.length).toBeGreaterThan(0);
    expect(diskBytes(f.root)).toEqual(before); for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(generation).not.toHaveBeenCalled(); expect(rebuild).not.toHaveBeenCalled();
  });

  it('retains failed, absent and multi-source stale bodies, with earlier mappings confined to historical revisions', () => {
    const f = workspace(), failed = seedKnowledgeWorkspace(f.root, 'failed'), stale = seedKnowledgeWorkspace(f.root, 'stale'), absent = seedKnowledgeWorkspace(f.root, 'absent');
    const failedHistory = f.associations.read(failed.body.knowledgeId);
    f.associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: failed.body.knowledgeId,
      expectedGeneration: failedHistory.generation, expectedHeadRevisionId: failedHistory.writeHeadRevisionId,
      revision: { revisionId: randomUUID(), parentRevisionId: failedHistory.writeHeadRevisionId, bodyRef: knowledgeBodyRef(failed.body),
        status: 'failed', reviewStatus: 'pending', catalogRefs: [], segmentEntityRefs: [], issues: ['作者夹具：关联失败，正文保留'],
        revisedAt: failed.body.revisedAt, revisedBy: failed.body.revisedBy, revisionReason: '独立失败结果' } }, failed.body.revisedBy);
    const absentFile = readdirSync(join(f.root, 'associations')).find(name => JSON.parse(readFileSync(join(f.root, 'associations', name), 'utf8')).knowledgeId === absent.body.knowledgeId)!;
    rmSync(join(f.root, 'associations', absentFile));
    const additional = captureTraceFixture(f.root, { path: join(f.root, 'additional.jsonl'), records: [{ recordIndex: 2,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '后续补充依据' }] } }) }] });
    const draft = { title: stale.body.title, reuseRationale: stale.body.reuseRationale, content: structuredClone(stale.body.content) };
    draft.content.segments.push({ segmentId: 'addendum', text: '来源后续补充依据；不自动升级旧实体关联。', evidence: [{
      source: { snapshotId: additional.snapshotId, sourceVersion: additional.sourceVersion }, basis: 'source_assertion',
      selection: { evidenceRef: additional.excerpts[0].evidenceRef, start: 0, end: 6, quote: '后续补充依据' } }] });
    const revised = f.app.revise(stale.body.knowledgeId, stale.body.revisionId, 1, draft, '增加另一精确来源');
    const ids = [failed.body.knowledgeId, stale.body.knowledgeId, absent.body.knowledgeId], graph = f.app.graph({ knowledgeIds: ids });
    expect(knowledgeNodes(graph)).toHaveLength(3); expect(sourceNodes(graph)).toHaveLength(4);
    expect(knowledgeNodes(graph).map(node => node.association.status).sort()).toEqual(['absent', 'failed', 'stale']);
    expect(graph.edges.some(edge => edge.edgeKind === 'segment_entity')).toBe(false);
    expect(graph.coverage.gaps.map(gap => gap.gapKind)).toEqual(expect.arrayContaining(['association_failed', 'association_stale', 'association_absent']));
    const history = f.app.graph({ knowledgeIds: ids, includeHistory: true });
    const oldBody = knowledgeNodes(history).find(node => node.bodyRef.revisionId === stale.body.revisionId)!;
    expect(oldBody.current).toBe(false);
    expect(history.edges.filter(edge => edge.edgeKind === 'segment_entity' && edge.from === oldBody.nodeId).every(edge => !edge.current)).toBe(true);
    expect(history.edges).toContainEqual(expect.objectContaining({ edgeKind: 'revision_parent', revisionDomain: 'knowledge', to: oldBody.nodeId, current: false }));
    expect(knowledgeNodes(history).find(node => node.bodyRef.revisionId === revised.revision.revisionId)?.current).toBe(true);
    expect(knowledgeNodes(history).find(node => node.bodyRef.knowledgeId === failed.body.knowledgeId)?.associationHistory?.map(item => item.status)).toEqual(['available', 'failed']);
    expect(createLocalKnowledgeApplication(f.root).graph({ knowledgeIds: ids, includeHistory: true })).toEqual(history);
  });

  it('keeps independent projection reviews and entity revisions exact across correction, replacement and reopen', () => {
    const f = workspace(), seeded = seedKnowledgeWorkspace(f.root, 'review'), id = seeded.body.knowledgeId;
    const bodyBefore = f.knowledge.read(id), original = f.associations.read(id);
    f.app.reviewAssociations(id, original.writeHeadRevisionId, original.generation, 'accept', '核对原投影');
    expect(knowledgeNodes(f.app.graph())[0].association.reviewStatus).toBe('accepted');
    const edit = structuredClone(seeded.analysis.revision); edit.entities[0].description = '明确限定为此窗口的 Alpha';
    const corrected = f.app.correctEntities(seeded.analysis.history.analysisId, edit.revisionId, 1, { entities: edit.entities, mentions: edit.mentions }, '纠正含义');
    const stillBound = f.app.graph();
    expect(knowledgeNodes(stillBound)[0].association.status).toBe('available');
    expect(stillBound.edges.filter(edge => edge.edgeKind === 'segment_entity')).toEqual([
      expect.objectContaining({ current: true, catalogCurrent: false }), expect.objectContaining({ current: true, catalogCurrent: false }),
    ]);
    expect(entityNodes(stillBound).every(node => node.entityRevisionId === seeded.analysis.revision.revisionId)).toBe(true);
    const outdated = f.app.graph({ includeHistory: true });
    expect(outdated.coverage.gaps).toContainEqual(expect.objectContaining({ gapKind: 'catalog_outdated' }));
    expect(entityNodes(outdated).filter(node => node.entityId === edit.entities[0].entityId).map(node => node.current).sort()).toEqual([false, true]);
    expect(outdated.edges).toContainEqual(expect.objectContaining({ edgeKind: 'revision_parent', revisionDomain: 'entity' }));
    const applied = f.app.applyAssociations(id, seeded.body.revisionId, seeded.body.bodyDigest, 2,
      { catalogRefs: [{ analysisId: seeded.analysis.history.analysisId, entityRevisionId: corrected.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId: seeded.analysis.history.analysisId, entityRevisionId: corrected.revision.revisionId, entityId: edit.entities[0].entityId, mentionIds: [edit.mentions[0].mentionId] }], issues: [] }, '显式应用纠正');
    const pending = f.app.graph({ includeHistory: true });
    expect(knowledgeNodes(pending)[0].association.reviewStatus).toBe('pending');
    expect(pending.edges.filter(edge => edge.edgeKind === 'segment_entity' && edge.current)).toHaveLength(1);
    expect(pending.edges).toContainEqual(expect.objectContaining({ edgeKind: 'segment_entity', projectionRevisionId: original.writeHeadRevisionId, reviewStatus: 'accepted', current: false }));
    f.app.reviewAssociations(id, applied.derivedAssociations.revision!.revisionId, applied.derivedAssociations.generation, 'reject', '映射仍需纠正');
    const rejected = createLocalKnowledgeApplication(f.root).graph();
    expect(knowledgeNodes(rejected)[0].association.reviewStatus).toBe('rejected'); expect(rejected.edges.some(edge => edge.edgeKind === 'segment_entity')).toBe(false);
    expect(f.knowledge.read(id)).toEqual(bodyBefore);
  });

  it('degrades a missing or failing source locally and reports mismatching quotes without deleting knowledge', () => {
    const f = workspace(), missing = seedKnowledgeWorkspace(f.root, 'missing'), healthy = seedKnowledgeWorkspace(f.root, 'healthy');
    f.app.deleteSource(sourceRef(missing.source));
    const deleted = f.app.graph();
    expect(sourceNodes(deleted)).toContainEqual(expect.objectContaining({ snapshotId: missing.source.snapshotId, status: 'unavailable', reason: 'deleted' }));
    expect(sourceNodes(deleted)).toContainEqual(expect.objectContaining({ snapshotId: healthy.source.snapshotId, status: 'available' }));
    expect(knowledgeNodes(deleted)).toHaveLength(2);
    const originalRead = FileSourceStore.prototype.read;
    vi.spyOn(FileSourceStore.prototype, 'read').mockImplementation(function (this: FileSourceStore, snapshotId, version) {
      if (snapshotId === missing.source.snapshotId) throw new Error(`private exception ${f.root}`);
      const result = originalRead.call(this, snapshotId, version);
      if (result.status === 'available') return { ...result, snapshot: { ...result.snapshot, excerpts: result.snapshot.excerpts.map(excerpt => ({ ...excerpt, text: '改变后的原文' })) } };
      return result;
    });
    const graph = f.app.graph();
    expect(graph.coverage.gaps.map(gap => gap.gapKind)).toEqual(expect.arrayContaining(['source_unavailable', 'evidence_mismatch']));
    expect(graph.edges).toContainEqual(expect.objectContaining({ edgeKind: 'source_evidence', positionStatus: 'unavailable' }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ edgeKind: 'source_evidence', positionStatus: 'mismatch' }));
    expect(JSON.stringify(graph)).not.toContain('private exception'); expect(JSON.stringify(graph)).not.toContain(f.root);
  });

  it('never turns unreadable inventories or projections into healthy empty graphs', () => {
    const f = workspace(), seeded = seedKnowledgeWorkspace(f.root, 'read-errors');
    const list = vi.spyOn(FileKnowledgeStore.prototype, 'list').mockImplementation(() => { throw new Error('private list failure'); });
    expect(f.app.graph()).toMatchObject({ nodes: [], coverage: { status: 'unavailable', gaps: [{ gapKind: 'knowledge_list_unavailable' }] } });
    const explicit = f.app.graph({ knowledgeIds: [seeded.body.knowledgeId, 'missing-item'] });
    expect(knowledgeNodes(explicit)).toHaveLength(1); expect(explicit.coverage.gaps.map(gap => gap.gapKind)).toEqual(expect.arrayContaining(['knowledge_list_unavailable', 'knowledge_unavailable']));
    list.mockRestore();
    vi.spyOn(FileKnowledgeAssociationStore.prototype, 'read').mockImplementation(() => { throw new Error('private association failure'); });
    const derivedFailure = f.app.graph();
    expect(knowledgeNodes(derivedFailure)[0].association.status).toBe('failed'); expect(sourceNodes(derivedFailure)).toHaveLength(1);
    expect(derivedFailure.coverage.gaps).toContainEqual(expect.objectContaining({ gapKind: 'association_unavailable' }));
    expect(JSON.stringify(derivedFailure)).not.toContain('private association failure');
    expect(f.app.graph({ knowledgeIds: [] })).toMatchObject({ nodes: [], edges: [], coverage: { status: 'available', gaps: [] } });
  });

  it('projects only stored typed, component, collection and possible-identity relationships', () => {
    const f = workspace(), component = seedKnowledgeWorkspace(f.root, 'component'), collection = seedKnowledgeWorkspace(f.root, 'collection'), possible = seedKnowledgeWorkspace(f.root, 'possible');
    for (const [seeded, relation] of [[component, 'component'], [collection, 'collection'], [possible, 'possible']] as const) {
      const edit = structuredClone(seeded.analysis.revision);
      if (relation === 'component') {
        edit.entities[0].referentKind = 'component'; edit.entities[1].referentKind = 'instance';
        edit.entities[1].componentRef = { entityId: edit.entities[0].entityId, mentionIds: [edit.mentions[1].mentionId], rationale: '作者关系夹具，不表示独立身份验证' };
      } else if (relation === 'collection') {
        edit.entities[0].referentKind = 'collection'; edit.entities[0].collection = { memberEntityIds: [edit.entities[1].entityId], completeness: 'complete',
          mentionIds: [edit.mentions[0].mentionId], rationale: '作者集合夹具' };
      } else {
        edit.entities[0].identityStatus = 'unresolved'; edit.entities[0].possibleEntityIds = [edit.entities[1].entityId]; edit.entities[0].uncertainties = ['仅为可能对应'];
      }
      const corrected = f.app.correctEntities(seeded.analysis.history.analysisId, edit.revisionId, 1, { entities: edit.entities, mentions: edit.mentions }, '作者关系投影夹具');
      f.app.applyAssociations(seeded.body.knowledgeId, seeded.body.revisionId, seeded.body.bodyDigest, 1,
        { catalogRefs: [{ analysisId: seeded.analysis.history.analysisId, entityRevisionId: corrected.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId: seeded.analysis.history.analysisId, entityRevisionId: corrected.revision.revisionId, entityId: edit.entities[0].entityId, mentionIds: [edit.mentions[0].mentionId] },
          { segmentId: 's1', analysisId: seeded.analysis.history.analysisId, entityRevisionId: corrected.revision.revisionId, entityId: edit.entities[1].entityId, mentionIds: [edit.mentions[1].mentionId] }],
        ...(relation === 'component' ? { typedRelations: [{ relationId: 'authored-relation', segmentIds: ['s1'], subject: { analysisId: seeded.analysis.history.analysisId, entityRevisionId: corrected.revision.revisionId, entityId: edit.entities[0].entityId }, relation: '来源报告使用',
          object: { analysisId: seeded.analysis.history.analysisId, entityRevisionId: corrected.revision.revisionId, entityId: edit.entities[1].entityId }, modality: 'descriptive', polarity: 'positive', evidence: seeded.body.content.segments[0].evidence, issues: ['派生关系待核对'] }] } : {}), issues: [] }, '显式应用关系夹具');
    }
    const graph = f.app.graph();
    for (const edgeKind of ['typed_relation', 'component', 'collection', 'possible_identity']) expect(graph.edges.filter(edge => edge.edgeKind === edgeKind)).toHaveLength(1);
    expect(graph.edges).toContainEqual(expect.objectContaining({ edgeKind: 'typed_relation', relation: '来源报告使用', reviewStatus: 'pending', issues: ['派生关系待核对'] }));
    expect(entityNodes(graph)).toContainEqual(expect.objectContaining({ identityStatus: 'unresolved', uncertainties: ['仅为可能对应'] }));
  });

  it('discovers mapping catalogs by exact body source versions, once per request, while disclosing unreadable analyses', () => {
    const f = workspace(), selected = seedKnowledgeWorkspace(f.root, 'same-title'), other = seedKnowledgeWorkspace(f.root, 'other');
    const wrongVersion = structuredClone(selected.analysis.history); wrongVersion.analysisId = randomUUID(); wrongVersion.sourceVersion = `sha256:${'f'.repeat(64)}`;
    writeFileSync(join(f.root, 'entities', `${wrongVersion.analysisId}.json`), JSON.stringify(wrongVersion));
    writeFileSync(join(f.root, 'entities', `${randomUUID()}.json`), '{bad');
    const list = vi.spyOn(FileEntityAnalysisStore.prototype, 'list'), read = f.app.readContext();
    const options = read.associationCatalogs(selected.body.knowledgeId);
    expect(options.catalogs.map(catalog => catalog.analysisId)).toEqual([selected.analysis.history.analysisId]);
    expect(options.catalogs[0].sourceSummary).toEqual(expect.objectContaining({ title: 'same-title', excerptCount: 1 }));
    expect(options.catalogs.some(catalog => catalog.analysisId === other.analysis.history.analysisId)).toBe(false);
    expect(options.unavailableAnalyses).toBe(1); expect(list).toHaveBeenCalledTimes(1);
    expect(read.associationCatalogs(selected.body.knowledgeId)).toEqual(options); expect(list).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(options)).not.toContain(f.root);
    f.app.deleteSource(sourceRef(selected.source));
    const missing = f.app.associationCatalogs(selected.body.knowledgeId);
    expect(missing.sources[0].status).toBe('unavailable'); expect(missing.catalogs[0].sourceSummary).toBeUndefined();
    list.mockImplementation(() => { throw new Error('catalog capacity'); });
    expect(() => f.app.associationCatalogs(selected.body.knowledgeId)).toThrow('catalog capacity');
  });

  it('shows stored derivations with exact source revisions and revision provenance without expanding an explicit selection', () => {
    const f = workspace(), derived = seedKnowledgeWorkspace(f.root, 'derived'), original = seedKnowledgeWorkspace(f.root, 'original');
    const revision = { ...derived.body, revisionId: randomUUID(), parentRevision: { knowledgeId: derived.body.knowledgeId, revisionId: derived.body.revisionId },
      derivations: (['derived_from', 'split_from', 'merged_from', 'replaces'] as const).map(relation => ({ relation,
        source: { knowledgeId: original.body.knowledgeId, revisionId: original.body.revisionId }, reason: `作者夹具的 ${relation} 来源演变；不表示事实更真。` })) };
    f.knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: derived.body.knowledgeId,
      expectedGeneration: 1, expectedHeadRevisionId: derived.body.revisionId, revision }, revision.revisedBy);
    const before = diskBytes(f.root), ids = [derived.body.knowledgeId, original.body.knowledgeId];
    const graph = f.app.graph({ knowledgeIds: ids });
    const derivations = graph.edges.filter(edge => edge.edgeKind === 'knowledge_derivation');
    expect(derivations.map(edge => edge.relation)).toEqual(['derived_from', 'split_from', 'merged_from', 'replaces']);
    expect(derivations.every(edge => edge.current && edge.targetStatus === 'visible')).toBe(true);
    expect(derivations[0]).toMatchObject({ sourceBodyRef: knowledgeBodyRef(original.body),
      recordedIn: { bodyRef: knowledgeBodyRef(revision), revisedBy: revision.revisedBy, revisedAt: revision.revisedAt } });
    expect(derivations[0]).not.toHaveProperty('opinionStatus');
    const read = vi.spyOn(FileKnowledgeStore.prototype, 'read');
    const scoped = f.app.graph({ knowledgeIds: [derived.body.knowledgeId] });
    expect(knowledgeNodes(scoped).map(node => node.bodyRef.knowledgeId)).toEqual([derived.body.knowledgeId]);
    expect(read.mock.calls.some(([id]) => id === original.body.knowledgeId)).toBe(false);
    const excluded = scoped.edges.find(edge => edge.edgeKind === 'knowledge_derivation')!;
    expect(excluded).toMatchObject({ targetStatus: 'out_of_scope', source: revision.derivations[0].source });
    expect(excluded).not.toHaveProperty('sourceBodyRef');
    expect(scoped.coverage.gaps).toContainEqual(expect.objectContaining({ gapKind: 'derivation_out_of_scope', derivationSource: revision.derivations[0].source }));
    expect(f.app.graph({ knowledgeIds: [] })).toMatchObject({ nodes: [], edges: [] });
    expect(diskBytes(f.root)).toEqual(before);
  });

  it('distinguishes hidden derivation history from an unresolved source and never manufactures a missing digest', () => {
    const f = workspace(), derived = seedKnowledgeWorkspace(f.root, 'derived-history'), original = seedKnowledgeWorkspace(f.root, 'original-history');
    const missing = { knowledgeId: original.body.knowledgeId, revisionId: randomUUID() };
    const revision = { ...derived.body, revisionId: randomUUID(), parentRevision: { knowledgeId: derived.body.knowledgeId, revisionId: derived.body.revisionId },
      derivations: [{ relation: 'derived_from' as const, source: { knowledgeId: original.body.knowledgeId, revisionId: original.body.revisionId }, reason: '作者夹具：来自精确旧修订。' },
        { relation: 'merged_from' as const, source: missing, reason: '作者夹具：来源修订现不可读，保留原ID。' }] };
    f.knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: derived.body.knowledgeId,
      expectedGeneration: 1, expectedHeadRevisionId: derived.body.revisionId, revision }, revision.revisedBy);
    f.app.revise(original.body.knowledgeId, original.body.revisionId, 1,
      { title: original.body.title, content: original.body.content, reuseRationale: original.body.reuseRationale }, '作者夹具：新增修订，不升级旧来源。');
    const graph = f.app.graph();
    const edges = graph.edges.filter(edge => edge.edgeKind === 'knowledge_derivation');
    expect(edges).toEqual([expect.objectContaining({ relation: 'derived_from', targetStatus: 'history_hidden', sourceBodyRef: knowledgeBodyRef(original.body) }),
      expect.objectContaining({ relation: 'merged_from', targetStatus: 'unavailable', source: missing })]);
    expect(edges[1]).not.toHaveProperty('sourceBodyRef');
    expect(graph.coverage.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ gapKind: 'derivation_history_hidden' }), expect.objectContaining({ gapKind: 'derivation_unavailable' })]));
    const history = f.app.graph({ includeHistory: true });
    expect(history.edges).toContainEqual(expect.objectContaining({ edgeKind: 'knowledge_derivation', relation: 'derived_from', targetStatus: 'visible' }));
    expect(history.edges).toContainEqual(expect.objectContaining({ edgeKind: 'revision_parent', revisionDomain: 'knowledge' }));
    expect(history.edges.some(edge => edge.edgeKind === 'knowledge_relation')).toBe(false);
  });

  it('keeps all relation opinion states visible and separate from body truth without rewriting stored knowledge', () => {
    const f = relationsFixture(), app = createLocalKnowledgeApplication(f.root);
    const bodies = f.bodyRefs.map(ref => f.knowledge.read(ref.knowledgeId));
    const read = () => app.graph().edges.filter(edge => edge.edgeKind === 'knowledge_relation');
    f.app.propose(f.propose());
    expect(read()).toEqual([expect.objectContaining({ current: true, endpointVisibility: { from: true, to: true },
      relation: expect.objectContaining({ opinionStatus: 'pending', bodyStatus: 'current', sourceStatus: 'available' }) })]);
    const accepted = f.app.review(f.review());
    expect(read()[0].relation.opinionStatus).toBe('accepted');
    f.appFor(relationOtherActor).review(f.review('reject'));
    expect(read()[0].relation.opinionStatus).toBe('disputed');
    f.app.review(f.review('reject', { supersedesReviewEventIds: [accepted.eventId] }));
    expect(read()[0].relation.opinionStatus).toBe('rejected');
    f.app.withdraw(f.withdraw());
    const before = diskBytes(f.root), withdrawn = read();
    expect(withdrawn[0].relation.opinionStatus).toBe('withdrawn');
    expect(withdrawn[0].relation.revision.reason).toContain('bounded report');
    expect(withdrawn[0].relation.revision.actor.actorKind).toBe('agent');
    expect(withdrawn[0].relation).not.toHaveProperty('history');
    expect(withdrawn[0].relation).not.toHaveProperty('receipts');
    expect(withdrawn[0].relation.hiddenEvidenceCount).toBe(0);
    expect(f.bodyRefs.map(ref => f.knowledge.read(ref.knowledgeId))).toEqual(bodies);
    expect(diskBytes(f.root)).toEqual(before);
  });

  it('projects exact stale and rebound relation versions while leaving excluded knowledge and sources unread', () => {
    const f = relationsFixture(), app = createLocalKnowledgeApplication(f.root), historicalReason = 'Only the old proposal: authored historical marker.';
    const proposed = f.app.propose(f.propose({ reason: historicalReason }));
    f.app.review(f.review('accept', { reason: 'Only the old review: authored historical marker.' }));
    const next = f.appendBody(0), newRef = knowledgeBodyRef(next);
    const stale = app.graph();
    expect(stale.edges).toContainEqual(expect.objectContaining({ edgeKind: 'knowledge_relation', current: false,
      endpointVisibility: { from: false, to: true }, relation: expect.objectContaining({ opinionStatus: 'accepted', bodyStatus: 'stale',
        hiddenEvidenceCount: 2, revision: expect.objectContaining({ evidence: [] }) }) }));
    expect(stale.coverage.gaps).toContainEqual(expect.objectContaining({ gapKind: 'relation_stale', relationId: f.relationId }));
    const rebound = f.propose({ from: { bodyRef: newRef } }); f.app.propose(rebound);
    const currentGraph = app.graph(), current = currentGraph.edges.filter(edge => edge.edgeKind === 'knowledge_relation');
    expect(current).toHaveLength(1); expect(current[0].relation).toMatchObject({ opinionStatus: 'pending', bodyStatus: 'current', revision: { from: { bodyRef: newRef } } });
    expect(current[0].relation.revision.evidence).toEqual(rebound.evidence);
    expect(current[0].relation.hiddenEvidenceCount).toBe(0);
    expect(JSON.stringify(currentGraph)).not.toContain(historicalReason);
    expect(JSON.stringify(currentGraph)).not.toContain('Only the old review: authored historical marker.');
    expect(JSON.stringify(currentGraph)).not.toContain('"receipts"');
    const history = app.graph({ includeHistory: true }).edges.filter(edge => edge.edgeKind === 'knowledge_relation');
    expect(history).toHaveLength(2);
    expect(history).toContainEqual(expect.objectContaining({ current: false, endpointVisibility: { from: true, to: true },
      relation: expect.objectContaining({ revision: expect.objectContaining({ eventId: proposed.eventId }), opinionStatus: 'accepted', bodyStatus: 'stale' }) }));
    expect(JSON.stringify(history)).toContain(historicalReason);
    expect(history.every(edge => !('history' in edge.relation) && edge.relation.hiddenEvidenceCount === 0)).toBe(true);
    const knowledgeReads = vi.spyOn(FileKnowledgeStore.prototype, 'read'), sourceReads = vi.spyOn(FileSourceStore.prototype, 'read');
    const scoped = app.graph({ knowledgeIds: [newRef.knowledgeId] });
    expect(knowledgeNodes(scoped).map(node => node.bodyRef.knowledgeId)).toEqual([newRef.knowledgeId]);
    expect(knowledgeReads.mock.calls.some(([id]) => id === f.bodyRefs[1].knowledgeId)).toBe(false);
    expect(sourceReads.mock.calls.some(([id]) => id === f.snapshots[1].snapshotId)).toBe(false);
    expect(scoped.edges).toContainEqual(expect.objectContaining({ edgeKind: 'knowledge_relation', endpointVisibility: { from: true, to: false },
      relation: expect.objectContaining({ hiddenEvidenceCount: rebound.evidence.length, revision: expect.objectContaining({ evidence: [] }),
        endpoints: expect.objectContaining({ to: expect.objectContaining({ status: 'out_of_scope', bodyRef: f.bodyRefs[1] }) }) }) }));
    expect(JSON.stringify(scoped)).not.toContain(f.commands[1].revision.content.segments[0].text);
    expect(scoped.coverage.gaps).toContainEqual(expect.objectContaining({ gapKind: 'relation_out_of_scope', relationSide: 'to' }));
    const inventories = vi.spyOn(FileKnowledgeRelationStore.prototype, 'inventory');
    expect(app.graph({ knowledgeIds: [] })).toMatchObject({ nodes: [], edges: [], coverage: { status: 'available', gaps: [] } });
    expect(inventories).not.toHaveBeenCalled();
  });

  it('retains healthy graph content and relation opinions through a missing supporting source or corrupt local ledger', () => {
    const f = relationsFixture(), app = createLocalKnowledgeApplication(f.root);
    f.app.propose(f.propose());
    f.sources.delete(f.snapshots[0].snapshotId, f.snapshots[0].sourceVersion);
    writeFileSync(join(f.root, 'knowledge-relations', `${randomUUID()}.json`), '{bad');
    const graph = app.graph();
    expect(knowledgeNodes(graph)).toHaveLength(2);
    expect(graph.edges).toContainEqual(expect.objectContaining({ edgeKind: 'knowledge_relation',
      relation: expect.objectContaining({ opinionStatus: 'pending', sourceStatus: 'unavailable' }) }));
    expect(graph.coverage.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ gapKind: 'relation_source_unavailable' }), expect.objectContaining({ gapKind: 'relation_unavailable' })]));
    expect(sourceNodes(graph)).toContainEqual(expect.objectContaining({ snapshotId: f.snapshots[1].snapshotId, status: 'available' }));
    expect(JSON.stringify(graph)).not.toContain(f.root);
  });
});
