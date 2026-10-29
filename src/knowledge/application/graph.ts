import { z } from 'zod';
import type { EntityMention, EvidenceSelection, KnowledgeBodyEvidence, KnowledgeBodyRef, KnowledgeRevision } from '../contracts.js';
import type { AnalyzedEntity, EntityAnalysisEnvelope, EntityAnalysisRevisionSchema } from '../entities/contracts.js';
import type { EvidenceStore, EvidenceWindow, SourceResolution } from '../extraction/evidence.js';
import { selectKnowledgeAssociation, type KnowledgeAssociationEnvelope, type KnowledgeAssociationRevision, type KnowledgeAssociationSelection } from '../associations.js';
import { canonicalJson, type KnowledgeEnvelope } from '../store.js';
import { validateEvidenceSelection } from '../validation.js';

export const KnowledgeGraphRequestSchema = z.strictObject({
  knowledgeIds: z.array(z.string().min(1).max(256)).max(1000).optional(),
  includeHistory: z.boolean().default(false),
});
export type KnowledgeGraphRequest = z.input<typeof KnowledgeGraphRequestSchema>;
type EntityRevision = z.infer<typeof EntityAnalysisRevisionSchema>;
type PositionStatus = 'matched' | 'mismatch' | 'unavailable';
type ReviewStatus = KnowledgeAssociationSelection['reviewStatus'];
interface GraphAssociation {
  status: KnowledgeAssociationSelection['status']; reviewStatus: ReviewStatus;
  revisionId?: string; bodyRef?: KnowledgeBodyRef; issues: string[];
}
export interface KnowledgeGraphKnowledgeNode {
  nodeKind: 'knowledge'; nodeId: string; bodyRef: KnowledgeBodyRef; current: boolean;
  title: string; choice: 'retain' | 'discard' | null; reviewStatus: 'pending';
  revisedAt: string; revisionReason: string;
  segments: { segmentId: string; text: string }[]; association: GraphAssociation;
  associationHistory?: { revisionId: string; parentRevisionId?: string; bodyRef: KnowledgeBodyRef; status: 'available' | 'failed';
    reviewStatus: ReviewStatus; issues: string[]; revisedAt: string; revisionReason: string }[];
}
export interface KnowledgeGraphEntityNode extends AnalyzedEntity {
  nodeKind: 'entity'; nodeId: string; analysisId: string; entityRevisionId: string; current: boolean;
}
export interface KnowledgeGraphSourceNode {
  nodeKind: 'source'; nodeId: string; snapshotId: string; sourceVersion: string;
  status: 'available' | 'unavailable'; reason?: string;
  origin?: Pick<NonNullable<EvidenceWindow['origin']>, 'threadId' | 'turnId' | 'title'>;
  limitations: string[];
}
export type KnowledgeGraphNode = KnowledgeGraphKnowledgeNode | KnowledgeGraphEntityNode | KnowledgeGraphSourceNode;
interface GraphEdge { edgeId: string; from: string; to: string; current: boolean }
export type KnowledgeGraphEdge = GraphEdge & (
  | { edgeKind: 'source_evidence'; segmentId: string; evidence: KnowledgeBodyEvidence; positionStatus: PositionStatus }
  | { edgeKind: 'entity_mention'; mentionId: string; selection: EvidenceSelection; basis: EntityMention['basis']; rationale: string; positionStatus: PositionStatus }
  | { edgeKind: 'segment_entity'; projectionRevisionId: string; segmentId: string; mentionIds: string[]; reviewStatus: ReviewStatus; catalogCurrent: boolean; mentions: EntityMention[] }
  | { edgeKind: 'typed_relation'; knowledgeNodeId: string; projectionRevisionId: string; reviewStatus: ReviewStatus; catalogCurrent: boolean;
    relationId: string; relation: string; segmentIds: string[]; modality: NonNullable<KnowledgeAssociationRevision['typedRelations']>[number]['modality'];
    polarity: 'positive' | 'negative'; objectNodeId?: string; evidence: KnowledgeBodyEvidence[]; issues: string[] }
  | { edgeKind: 'component' | 'collection'; mentionIds: string[]; rationale: string; completeness?: 'complete' | 'partial' | 'unknown' }
  | { edgeKind: 'possible_identity' }
  | { edgeKind: 'revision_parent'; revisionDomain: 'knowledge' | 'entity' }
);
type GraphEdgeInput = KnowledgeGraphEdge extends infer Edge ? Edge extends unknown ? Omit<Edge, 'edgeId'> : never : never;
export interface KnowledgeGraphGap {
  gapKind: 'knowledge_list_unavailable' | 'knowledge_unavailable' | 'association_unavailable' | 'association_failed'
    | 'association_stale' | 'association_absent' | 'association_rejected' | 'catalog_unavailable' | 'catalog_outdated'
    | 'entity_unavailable' | 'source_unavailable' | 'evidence_mismatch';
  knowledgeId?: string; analysisId?: string; snapshotId?: string; sourceVersion?: string; revisionId?: string; detail: string;
}
export interface KnowledgeGraph {
  projectionKind: 'knowledge-graph'; schemaVersion: 1;
  scope: { knowledgeIds: string[] | null; includeHistory: boolean };
  coverage: { status: 'available' | 'unavailable'; gaps: KnowledgeGraphGap[] };
  nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[];
}
/** Read capabilities only; graph construction cannot dispatch a model or publish a write. */
export interface KnowledgeGraphReader {
  listKnowledge(ids?: ReadonlySet<string>): KnowledgeEnvelope[];
  knowledge(id: string): KnowledgeEnvelope;
  associations(id: string): KnowledgeAssociationEnvelope;
  catalog(analysisId: string): EntityAnalysisEnvelope;
  source: EvidenceStore['read'];
}
const bodyRef = ({ knowledgeId, revisionId, bodyDigest }: KnowledgeRevision): KnowledgeBodyRef => ({ knowledgeId, revisionId, bodyDigest });
const nodeId = (domain: string, parts: string[]) => `${domain}:${canonicalJson(parts)}`;
const knowledgeNodeId = (ref: KnowledgeBodyRef) => nodeId('knowledge', [ref.knowledgeId, ref.revisionId, ref.bodyDigest]);
const entityNodeId = (analysisId: string, revisionId: string, entityId: string) => nodeId('entity', [analysisId, revisionId, entityId]);
const sourceNodeId = (ref: { snapshotId: string; sourceVersion: string }) => nodeId('source', [ref.snapshotId, ref.sourceVersion]);
const sameBody = (a: KnowledgeBodyRef, b: KnowledgeBodyRef) => canonicalJson(a) === canonicalJson(b);
const reviewFor = (history: KnowledgeAssociationEnvelope, revisionId: string): ReviewStatus => {
  const review = history.reviews.filter(item => item.projectionRevisionId === revisionId).at(-1);
  return review ? review.choice === 'accept' ? 'accepted' : 'rejected' : 'pending';
};

/** An exact, bounded-by-selection view of stored evidence; no name-based identity or inferred relationships. */
export function buildKnowledgeGraph(reader: KnowledgeGraphReader, input: KnowledgeGraphRequest = {}): KnowledgeGraph {
  const request = KnowledgeGraphRequestSchema.parse(input);
  const selectedIds = request.knowledgeIds ? [...new Set(request.knowledgeIds)] : undefined;
  const graph: KnowledgeGraph = { projectionKind: 'knowledge-graph', schemaVersion: 1,
    scope: { knowledgeIds: selectedIds ?? null, includeHistory: request.includeHistory },
    coverage: { status: 'available', gaps: [] }, nodes: [], edges: [] };
  const nodes = new Map<string, KnowledgeGraphNode>(), edges = new Map<string, KnowledgeGraphEdge>(), gaps = new Set<string>();
  const resolutions = new Map<string, SourceResolution>();
  const catalogs = new Map<string, EntityAnalysisEnvelope | null>();
  function gap(value: KnowledgeGraphGap) {
    const key = canonicalJson(value);
    if (gaps.has(key)) return;
    gaps.add(key); graph.coverage.status = 'unavailable'; graph.coverage.gaps.push(value);
  }
  function edge(value: GraphEdgeInput, identity: string[]) {
    const edgeId = nodeId(value.edgeKind, identity);
    if (!edges.has(edgeId)) edges.set(edgeId, { ...value, edgeId } as KnowledgeGraphEdge);
  }
  function source(ref: { snapshotId: string; sourceVersion: string }): SourceResolution {
    const id = sourceNodeId(ref), saved = resolutions.get(id);
    if (saved) return saved;
    let resolution: SourceResolution;
    try {
      resolution = reader.source(ref.snapshotId, ref.sourceVersion);
      if (resolution.status === 'available' && (resolution.window.snapshotId !== ref.snapshotId || resolution.window.sourceVersion !== ref.sourceVersion)) {
        resolution = { status: 'unavailable', reason: 'version_mismatch', detail: 'Source identity does not match.' };
      }
    } catch { resolution = { status: 'unavailable', reason: 'invalid_source', detail: 'Source could not be read.' }; }
    resolutions.set(id, resolution);
    const origin = resolution.status === 'available' ? resolution.window.origin : undefined;
    nodes.set(id, { nodeKind: 'source', nodeId: id, ...ref, status: resolution.status,
      ...(resolution.status === 'unavailable' ? { reason: resolution.reason } : {}),
      ...(origin ? { origin: { threadId: origin.threadId, title: origin.title, ...(origin.turnId ? { turnId: origin.turnId } : {}) } } : {}),
      limitations: resolution.status === 'available' ? resolution.window.limitations : [] });
    if (resolution.status === 'unavailable') gap({ gapKind: 'source_unavailable', ...ref, detail: 'The exact source snapshot is unavailable.' });
    return resolution;
  }
  function position(selection: EvidenceSelection, resolution: SourceResolution, snapshotId: string): PositionStatus {
    if (resolution.status === 'unavailable') return 'unavailable';
    if (!validateEvidenceSelection(selection, resolution.window.excerpts).length) return 'matched';
    gap({ gapKind: 'evidence_mismatch', snapshotId, detail: 'A saved quotation does not match the exact source position.' });
    return 'mismatch';
  }
  function entity(history: EntityAnalysisEnvelope, revision: EntityRevision, id: string): string | undefined {
    const key = entityNodeId(history.analysisId, revision.revisionId, id);
    if (nodes.has(key)) return key;
    const value = revision.entities.find(item => item.entityId === id);
    if (!value) {
      gap({ gapKind: 'entity_unavailable', analysisId: history.analysisId, revisionId: revision.revisionId, detail: 'The referenced entity is absent from its exact catalog revision.' });
      return undefined;
    }
    const current = revision.revisionId === history.writeHeadRevisionId;
    nodes.set(key, { ...value, nodeKind: 'entity', nodeId: key, analysisId: history.analysisId, entityRevisionId: revision.revisionId, current });
    const ref = { snapshotId: history.snapshotId, sourceVersion: history.sourceVersion }, resolution = source(ref);
    for (const mention of revision.mentions.filter(item => item.entityId === id)) {
      edge({ edgeKind: 'entity_mention', from: key, to: sourceNodeId(ref), current, mentionId: mention.mentionId,
        selection: mention.selection, basis: mention.basis, rationale: mention.rationale,
        positionStatus: position(mention.selection, resolution, ref.snapshotId) }, [key, mention.mentionId]);
    }
    function related(target: string, link: { edgeKind: 'component' | 'collection' | 'possible_identity'; mentionIds?: string[]; rationale?: string; completeness?: 'complete' | 'partial' | 'unknown' }) {
      const targetId = entity(history, revision, target);
      if (!targetId) return;
      if (link.edgeKind === 'possible_identity') edge({ edgeKind: 'possible_identity', from: key, to: targetId, current }, [key, targetId]);
      else edge({ edgeKind: link.edgeKind, from: key, to: targetId, current, mentionIds: link.mentionIds!, rationale: link.rationale!,
        ...(link.completeness ? { completeness: link.completeness } : {}) }, [key, targetId]);
    }
    if (value.componentRef) related(value.componentRef.entityId, { edgeKind: 'component', ...value.componentRef });
    if (value.collection) for (const member of value.collection.memberEntityIds) related(member, { edgeKind: 'collection', ...value.collection });
    for (const target of value.possibleEntityIds) related(target, { edgeKind: 'possible_identity' });
    if (request.includeHistory && revision.parentRevisionId) {
      const parent = history.revisions.find(item => item.revisionId === revision.parentRevisionId);
      if (parent?.entities.some(item => item.entityId === id)) {
        const parentId = entity(history, parent, id)!;
        edge({ edgeKind: 'revision_parent', revisionDomain: 'entity', from: key, to: parentId, current: false }, [key, parentId]);
      }
    }
    if (request.includeHistory && !current) {
      const head = history.revisions.find(item => item.revisionId === history.writeHeadRevisionId);
      if (head?.entities.some(item => item.entityId === id)) entity(history, head, id);
    }
    return key;
  }
  function associationEdges(knowledge: KnowledgeGraphKnowledgeNode, history: KnowledgeAssociationEnvelope, projection: KnowledgeAssociationRevision, selected: GraphAssociation) {
    const ref = projection.entityAnalysisRef;
    if (projection.status !== 'available' || !ref) return;
    let catalog = catalogs.get(ref.analysisId);
    if (catalog === undefined) {
      try { catalog = reader.catalog(ref.analysisId); } catch { catalog = null; }
      catalogs.set(ref.analysisId, catalog);
    }
    const revision = catalog?.revisions.find(item => item.revisionId === ref.revisionId);
    if (!catalog || !revision) {
      gap({ gapKind: 'catalog_unavailable', knowledgeId: knowledge.bodyRef.knowledgeId, analysisId: ref.analysisId, revisionId: ref.revisionId, detail: 'The exact catalog revision could not be read.' });
      return;
    }
    const reviewStatus = reviewFor(history, projection.revisionId);
    const current = knowledge.current && projection.revisionId === selected.revisionId && reviewStatus !== 'rejected';
    const catalogCurrent = catalog.writeHeadRevisionId === revision.revisionId;
    if (current && !catalogCurrent) gap({ gapKind: 'catalog_outdated', knowledgeId: knowledge.bodyRef.knowledgeId,
      analysisId: ref.analysisId, revisionId: ref.revisionId, detail: 'The association still binds an earlier catalog revision.' });
    for (const mapping of projection.segmentEntityRefs) {
      const target = entity(catalog, revision, mapping.entityId);
      if (!target) continue;
      edge({ edgeKind: 'segment_entity', from: knowledge.nodeId, to: target, current, projectionRevisionId: projection.revisionId,
        segmentId: mapping.segmentId, mentionIds: mapping.mentionIds, reviewStatus, catalogCurrent,
        mentions: revision.mentions.filter(item => item.entityId === mapping.entityId && mapping.mentionIds.includes(item.mentionId)) },
      [knowledge.nodeId, projection.revisionId, mapping.segmentId, target]);
    }
    for (const relation of projection.typedRelations ?? []) {
      const subject = entity(catalog, revision, relation.subject.entityId);
      const object = relation.object ? entity(catalog, revision, relation.object.entityId) : undefined;
      if (!subject || (relation.object && !object)) continue;
      // A unary relation points to its knowledge provenance, never to a fabricated object endpoint.
      edge({ edgeKind: 'typed_relation', from: subject, to: object ?? knowledge.nodeId, current,
        knowledgeNodeId: knowledge.nodeId, projectionRevisionId: projection.revisionId, reviewStatus, catalogCurrent,
        relationId: relation.relationId, relation: relation.relation, segmentIds: relation.segmentIds, modality: relation.modality,
        polarity: relation.polarity, ...(object ? { objectNodeId: object } : {}), evidence: relation.evidence, issues: relation.issues },
      [knowledge.nodeId, projection.revisionId, relation.relationId]);
    }
  }
  let histories: KnowledgeEnvelope[];
  try { histories = selectedIds?.length === 0 ? [] : reader.listKnowledge(selectedIds ? new Set(selectedIds) : undefined); }
  catch {
    histories = [];
    gap({ gapKind: 'knowledge_list_unavailable', detail: 'The knowledge inventory could not be read; this graph is incomplete.' });
  }
  if (selectedIds) for (const id of selectedIds) {
    if (histories.some(item => item.knowledgeId === id)) continue;
    try { histories.push(reader.knowledge(id)); }
    catch { gap({ gapKind: 'knowledge_unavailable', knowledgeId: id, detail: 'A selected knowledge history could not be read.' }); }
  }
  for (const history of histories) {
    let associations: KnowledgeAssociationEnvelope | undefined;
    let associationUnreadable = false;
    try { associations = reader.associations(history.knowledgeId); }
    catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') {
        associationUnreadable = true;
        gap({ gapKind: 'association_unavailable', knowledgeId: history.knowledgeId, detail: 'The association history could not be read.' });
      }
    }
    const associationEnvelope = associations;
    const revisions = request.includeHistory ? history.revisions : history.revisions.filter(item => item.revisionId === history.writeHeadRevisionId);
    for (const revision of revisions) {
      const ref = bodyRef(revision), selected: KnowledgeAssociationSelection = associationUnreadable
        ? { status: 'failed', reviewStatus: 'pending', bodyRef: ref } : selectKnowledgeAssociation(associations, ref);
      const association: GraphAssociation = { status: selected.status, reviewStatus: selected.reviewStatus,
        ...(selected.revision ? { revisionId: selected.revision.revisionId, bodyRef: selected.revision.bodyRef } : {}), issues: selected.revision?.issues ?? [] };
      const current = revision.revisionId === history.writeHeadRevisionId;
      const knowledge: KnowledgeGraphKnowledgeNode = { nodeKind: 'knowledge', nodeId: knowledgeNodeId(ref), bodyRef: ref, current,
        title: revision.title, choice: history.maintenance.filter(item => item.revisionId === revision.revisionId).at(-1)?.choice ?? null,
        reviewStatus: 'pending', revisedAt: revision.revisedAt, revisionReason: revision.revisionReason,
        segments: revision.content.segments.map(({ segmentId, text }) => ({ segmentId, text })), association,
        ...(request.includeHistory && associationEnvelope ? { associationHistory: associationEnvelope.revisions.filter(item => sameBody(item.bodyRef, ref)).map(item => ({
          revisionId: item.revisionId, ...(item.parentRevisionId ? { parentRevisionId: item.parentRevisionId } : {}), bodyRef: item.bodyRef,
          status: item.status, reviewStatus: reviewFor(associationEnvelope, item.revisionId), issues: item.issues, revisedAt: item.revisedAt, revisionReason: item.revisionReason,
        })) } : {}) };
      nodes.set(knowledge.nodeId, knowledge);
      if (current && (selected.status !== 'available' || selected.reviewStatus === 'rejected')) gap({
        gapKind: selected.status === 'available' ? 'association_rejected' : selected.status === 'stale' ? 'association_stale' : selected.status === 'failed' ? 'association_failed' : 'association_absent',
        knowledgeId: history.knowledgeId, revisionId: revision.revisionId, detail: 'This body has no current usable entity association projection.' });
      for (const segment of revision.content.segments) for (const [index, evidence] of segment.evidence.entries()) {
        const resolution = source(evidence.source);
        edge({ edgeKind: 'source_evidence', from: knowledge.nodeId, to: sourceNodeId(evidence.source), current,
          segmentId: segment.segmentId, evidence, positionStatus: position(evidence.selection, resolution, evidence.source.snapshotId) }, [knowledge.nodeId, segment.segmentId, String(index)]);
      }
      if (associations) {
        const projections = request.includeHistory ? associations.revisions.filter(item => sameBody(item.bodyRef, ref))
          : selected.status === 'available' && selected.reviewStatus !== 'rejected' && selected.revision ? [selected.revision] : [];
        for (const projection of projections) associationEdges(knowledge, associations, projection, association);
      }
    }
    if (request.includeHistory) for (const revision of revisions) {
      const parent = revision.parentRevision && revisions.find(item => item.revisionId === revision.parentRevision!.revisionId);
      if (parent) edge({ edgeKind: 'revision_parent', revisionDomain: 'knowledge', from: knowledgeNodeId(bodyRef(revision)), to: knowledgeNodeId(bodyRef(parent)), current: false },
        [knowledgeNodeId(bodyRef(revision)), knowledgeNodeId(bodyRef(parent))]);
    }
  }
  graph.nodes = [...nodes.values()]; graph.edges = [...edges.values()];
  // Consumers cannot mutate request-local cached histories or source snapshots through this projection.
  return structuredClone(graph);
}
