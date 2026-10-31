import { z } from 'zod';
import type { EntityMention, EvidenceSelection, KnowledgeActor, KnowledgeBodyEvidence, KnowledgeBodyRef, KnowledgeRevision } from '../contracts.js';
import type { AnalyzedEntity, EntityAnalysisEnvelope, EntityAnalysisRevisionSchema } from '../entities/contracts.js';
import type { SourceStore } from '../source-store.js';
import type { TraceOrigin, SourceResolution } from '../sources.js';
import { sourceOrigin, sourceSummary, type SourceSummary } from './source-summary.js';
import { selectKnowledgeAssociation, knowledgeAssociationCatalogKey, type KnowledgeAssociationEnvelope, type KnowledgeAssociationRevision, type KnowledgeAssociationSelection } from '../associations.js';
import { validateKnowledgeAssociationCatalogReferences } from '../entities/association-references.js';
import { canonicalJson, type KnowledgeEnvelope } from '../store.js';
import { validateEvidenceSelection } from '../validation.js';
import type { KnowledgeRelationProjection, KnowledgeRelationsApplication } from './relations.js';

export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 3;
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
  origin?: Pick<TraceOrigin, 'threadId' | 'turnId' | 'title'>;
  limitations: string[]; source?: SourceSummary;
}
export type KnowledgeGraphNode = KnowledgeGraphKnowledgeNode | KnowledgeGraphEntityNode | KnowledgeGraphSourceNode;
interface GraphEdge { edgeId: string; from: string; to: string; current: boolean }
export interface KnowledgeGraphDerivationEdge extends GraphEdge {
  edgeKind: 'knowledge_derivation'; relation: KnowledgeRevision['derivations'][number]['relation'];
  source: KnowledgeRevision['derivations'][number]['source']; sourceBodyRef?: KnowledgeBodyRef; reason: string;
  targetStatus: 'visible' | 'history_hidden' | 'out_of_scope' | 'unavailable';
  /** Derivations have no separate author/time; these identify the immutable revision recording them. */
  recordedIn: { bodyRef: KnowledgeBodyRef; revisedBy: KnowledgeActor; revisedAt: string };
}
export interface KnowledgeGraphRelationEdge extends GraphEdge {
  edgeKind: 'knowledge_relation';
  /** The relation application owns opinion, body and source status; graph does not reinterpret them. */
  relation: Omit<KnowledgeRelationProjection, 'history'> & { hiddenEvidenceCount: number };
  endpointVisibility: { from: boolean; to: boolean };
}
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
  | Omit<KnowledgeGraphDerivationEdge, keyof GraphEdge>
  | Omit<KnowledgeGraphRelationEdge, keyof GraphEdge>
);
type GraphEdgeInput = KnowledgeGraphEdge extends infer Edge ? Edge extends unknown ? Omit<Edge, 'edgeId'> : never : never;
export interface KnowledgeGraphGap {
  gapKind: 'knowledge_list_unavailable' | 'knowledge_unavailable' | 'association_unavailable' | 'association_failed'
    | 'association_stale' | 'association_absent' | 'association_rejected' | 'catalog_unavailable' | 'catalog_outdated'
    | 'entity_unavailable' | 'source_unavailable' | 'evidence_mismatch'
    | 'derivation_unavailable' | 'derivation_out_of_scope' | 'derivation_history_hidden'
    | 'relation_inventory_unavailable' | 'relation_unavailable' | 'relation_endpoint_unavailable' | 'relation_out_of_scope'
    | 'relation_stale' | 'relation_source_unavailable';
  knowledgeId?: string; analysisId?: string; snapshotId?: string; sourceVersion?: string; revisionId?: string; detail: string;
  derivationSource?: KnowledgeRevision['derivations'][number]['source'];
  relationId?: string; relationRevisionId?: string; relationSide?: 'from' | 'to';
}
export interface KnowledgeGraph {
  projectionKind: 'knowledge-graph'; schemaVersion: typeof KNOWLEDGE_GRAPH_SCHEMA_VERSION;
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
  source: SourceStore['read'];
  relations?: Pick<KnowledgeRelationsApplication, 'inventory' | 'project'>;
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
  const graph: KnowledgeGraph = { projectionKind: 'knowledge-graph', schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
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
      if (resolution.status === 'available' && (resolution.snapshot.snapshotId !== ref.snapshotId || resolution.snapshot.sourceVersion !== ref.sourceVersion)) {
        resolution = { status: 'unavailable', reason: 'version_mismatch', detail: 'Source identity does not match.' };
      }
    } catch { resolution = { status: 'unavailable', reason: 'corrupt', detail: 'Source could not be read.' }; }
    resolutions.set(id, resolution);
    const origin = resolution.status === 'available' ? sourceOrigin(resolution.snapshot) : undefined;
    nodes.set(id, { nodeKind: 'source', nodeId: id, ...ref, status: resolution.status,
      ...(resolution.status === 'unavailable' ? { reason: resolution.reason } : {}),
      ...(origin ? { origin: { threadId: origin.threadId, title: origin.title, ...(origin.turnId ? { turnId: origin.turnId } : {}) } } : {}),
      ...(resolution.status === 'available' ? { source: sourceSummary(resolution.snapshot) } : {}),
      limitations: resolution.status === 'available' ? resolution.snapshot.limitations : [] });
    if (resolution.status === 'unavailable') gap({ gapKind: 'source_unavailable', ...ref, detail: 'The exact source snapshot is unavailable.' });
    return resolution;
  }
  function position(selection: EvidenceSelection, resolution: SourceResolution, snapshotId: string): PositionStatus {
    if (resolution.status === 'unavailable') return 'unavailable';
    if (!validateEvidenceSelection(selection, resolution.snapshot.excerpts).length) return 'matched';
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
  function associationEdges(knowledge: KnowledgeGraphKnowledgeNode, body: KnowledgeRevision, history: KnowledgeAssociationEnvelope, projection: KnowledgeAssociationRevision, selected: GraphAssociation) {
    if (projection.status !== 'available') return;
    const resolved = new Map<string, { catalog: EntityAnalysisEnvelope; revision: EntityRevision; current: boolean }>();
    const reviewStatus = reviewFor(history, projection.revisionId);
    const current = knowledge.current && projection.revisionId === selected.revisionId && reviewStatus !== 'rejected';
    for (const ref of projection.catalogRefs) {
      let catalog = catalogs.get(ref.analysisId);
      if (catalog === undefined) {
        try { catalog = reader.catalog(ref.analysisId); } catch { catalog = null; }
        catalogs.set(ref.analysisId, catalog);
      }
      const revision = catalog?.revisions.find(item => item.revisionId === ref.entityRevisionId);
      let valid = !!catalog && !!revision;
      if (catalog && revision) {
        try { validateKnowledgeAssociationCatalogReferences(projection, body, catalog, revision.revisionId); } catch { valid = false; }
      }
      if (!catalog || !revision || !valid) {
        gap({ gapKind: 'catalog_unavailable', knowledgeId: knowledge.bodyRef.knowledgeId, analysisId: ref.analysisId, revisionId: ref.entityRevisionId, detail: 'The exact catalog revision or its saved references could not be read.' });
        continue;
      }
      const catalogCurrent = catalog.writeHeadRevisionId === revision.revisionId;
      resolved.set(knowledgeAssociationCatalogKey(ref), { catalog, revision, current: catalogCurrent });
      if (current && !catalogCurrent) gap({ gapKind: 'catalog_outdated', knowledgeId: knowledge.bodyRef.knowledgeId,
        analysisId: ref.analysisId, revisionId: ref.entityRevisionId, detail: 'The association still binds an earlier catalog revision.' });
    }
    for (const mapping of projection.segmentEntityRefs) {
      const binding = resolved.get(knowledgeAssociationCatalogKey(mapping));
      if (!binding) continue;
      const { catalog, revision, current: catalogCurrent } = binding;
      const target = entity(catalog, revision, mapping.entityId);
      if (!target) continue;
      edge({ edgeKind: 'segment_entity', from: knowledge.nodeId, to: target, current, projectionRevisionId: projection.revisionId,
        segmentId: mapping.segmentId, mentionIds: mapping.mentionIds, reviewStatus, catalogCurrent,
        mentions: revision.mentions.filter(item => item.entityId === mapping.entityId && mapping.mentionIds.includes(item.mentionId)) },
      [knowledge.nodeId, projection.revisionId, mapping.segmentId, target]);
    }
    for (const relation of projection.typedRelations ?? []) {
      const subjectBinding = resolved.get(knowledgeAssociationCatalogKey(relation.subject));
      const objectBinding = relation.object && resolved.get(knowledgeAssociationCatalogKey(relation.object));
      if (!subjectBinding || (relation.object && !objectBinding)) continue;
      const subject = entity(subjectBinding.catalog, subjectBinding.revision, relation.subject.entityId);
      const object = relation.object && objectBinding ? entity(objectBinding.catalog, objectBinding.revision, relation.object.entityId) : undefined;
      if (!subject || (relation.object && !object)) continue;
      const catalogCurrent = subjectBinding.current && (!objectBinding || objectBinding.current);
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
  // Even an injected reader must not turn an explicit graph selection into a wider inventory.
  if (selectedIds) histories = histories.filter(history => selectedIds.includes(history.knowledgeId));
  const historyById = new Map(histories.map(history => [history.knowledgeId, history]));
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
        for (const projection of projections) associationEdges(knowledge, revision, associations, projection, association);
      }
    }
    if (request.includeHistory) for (const revision of revisions) {
      const parent = revision.parentRevision && revisions.find(item => item.revisionId === revision.parentRevision!.revisionId);
      if (parent) edge({ edgeKind: 'revision_parent', revisionDomain: 'knowledge', from: knowledgeNodeId(bodyRef(revision)), to: knowledgeNodeId(bodyRef(parent)), current: false },
        [knowledgeNodeId(bodyRef(revision)), knowledgeNodeId(bodyRef(parent))]);
    }
  }
  // Explicit relation opinions keep their own lifecycle; rejected, disputed and withdrawn
  // opinions remain visible, and a body/head change never silently rebinds their endpoints.
  if (selectedIds?.length !== 0) {
    if (!reader.relations) gap({ gapKind: 'relation_inventory_unavailable', detail: 'Relation read capability is unavailable; no absence can be inferred.' });
    else {
      try {
        const selection = selectedIds ? new Set(selectedIds) : undefined;
        const inventory = reader.relations.inventory(selection);
        if (inventory.completeness === 'partial' || inventory.unavailable.length) {
          if (!inventory.unavailable.length) gap({ gapKind: 'relation_inventory_unavailable', detail: 'The relation inventory is incomplete.' });
          for (const unavailable of inventory.unavailable) gap({ gapKind: 'relation_unavailable',
            ...(unavailable.relationId ? { relationId: unavailable.relationId } : {}), detail: 'A relation ledger could not be read; healthy graph content remains available.' });
        }
        for (const history of inventory.histories) {
          const proposals = history.events.filter(event => event.eventKind === 'relation_proposed');
          // Defensive scope check before invoking the shared resolver, even for injected inventories.
          if (selection && !proposals.some(event => selection.has(event.from.bodyRef.knowledgeId) || selection.has(event.to.bodyRef.knowledgeId))) continue;
          const revisions = request.includeHistory ? proposals.map(event => event.eventId) : [undefined];
          for (const relationRevisionId of revisions) {
            try {
              const relation = reader.relations.project(history, relationRevisionId, selection);
              const proposal = relation.revision, from = knowledgeNodeId(proposal.from.bodyRef), to = knowledgeNodeId(proposal.to.bodyRef);
              const identity = { relationId: relation.relationId, relationRevisionId: proposal.eventId };
              for (const side of ['from', 'to'] as const) {
                const endpoint = relation.endpoints[side];
                if (endpoint.status === 'unavailable' || endpoint.status === 'out_of_scope') gap({
                  gapKind: endpoint.status === 'out_of_scope' ? 'relation_out_of_scope' : 'relation_endpoint_unavailable', ...identity,
                  relationSide: side, knowledgeId: endpoint.bodyRef.knowledgeId, revisionId: endpoint.bodyRef.revisionId,
                  detail: endpoint.status === 'out_of_scope' ? 'The exact relation endpoint is outside the explicit graph selection; it was not read.'
                    : 'The exact relation endpoint or selected segments could not be read.' });
              }
              if (relation.bodyStatus === 'stale') gap({ gapKind: 'relation_stale', ...identity,
                detail: 'This relation opinion still binds earlier body revisions; it was not rebound to current content.' });
              if (relation.sources.some(value => value.status === 'unavailable')) gap({ gapKind: 'relation_source_unavailable', ...identity,
                detail: 'An exact supporting source is unavailable; the stored relation opinion remains readable.' });
              const endpointVisibility = { from: nodes.has(from) && ['current', 'stale'].includes(relation.endpoints.from.status),
                to: nodes.has(to) && ['current', 'stale'].includes(relation.endpoints.to.status) };
              const evidenceVisible = endpointVisibility.from && endpointVisibility.to;
              // Graph is a selected opinion view, not the complete proposal/history read API.
              // Stored evidence may quote an excluded body even when no filesystem read was needed.
              const { history: ledger, ...opinion } = relation; void ledger;
              edge({ edgeKind: 'knowledge_relation', from, to,
                current: proposal.eventId === proposals.at(-1)?.eventId && relation.bodyStatus === 'current',
                relation: { ...opinion, revision: { ...proposal, evidence: evidenceVisible ? proposal.evidence : [] },
                  hiddenEvidenceCount: evidenceVisible ? 0 : proposal.evidence.length }, endpointVisibility }, [relation.relationId, proposal.eventId]);
            } catch { gap({ gapKind: 'relation_unavailable', relationId: history.relationId,
              ...(relationRevisionId ? { relationRevisionId } : {}), detail: 'A relation revision could not be projected; healthy graph content remains available.' }); }
          }
        }
      } catch { gap({ gapKind: 'relation_inventory_unavailable', detail: 'The relation inventory could not be read; no absence can be inferred.' }); }
    }
  }
  // A derivation is stored provenance, not an independently reviewed relation opinion.
  // Resolve only histories already admitted by the graph selection; never invent a digest.
  for (const history of histories) {
    const revisions = request.includeHistory ? history.revisions : history.revisions.filter(item => item.revisionId === history.writeHeadRevisionId);
    for (const revision of revisions) for (const [index, derivation] of revision.derivations.entries()) {
      const ref = bodyRef(revision), from = knowledgeNodeId(ref);
      const inScope = !selectedIds || selectedIds.includes(derivation.source.knowledgeId);
      const target = inScope ? historyById.get(derivation.source.knowledgeId)?.revisions.find(item => item.revisionId === derivation.source.revisionId) : undefined;
      const sourceRef = target ? bodyRef(target) : undefined;
      const to = sourceRef ? knowledgeNodeId(sourceRef) : nodeId('knowledge_reference', [derivation.source.knowledgeId, derivation.source.revisionId]);
      const targetStatus = !inScope ? 'out_of_scope' : !target ? 'unavailable' : nodes.has(to) ? 'visible' : 'history_hidden';
      if (targetStatus !== 'visible') gap({ gapKind: targetStatus === 'out_of_scope' ? 'derivation_out_of_scope'
        : targetStatus === 'history_hidden' ? 'derivation_history_hidden' : 'derivation_unavailable',
      knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, derivationSource: derivation.source,
      detail: targetStatus === 'out_of_scope' ? 'The derivation source is outside the explicit graph selection; it was not read.'
        : targetStatus === 'history_hidden' ? 'The exact derivation source is historical; enable history to display its node.'
          : 'The exact derivation source revision could not be resolved; its stored IDs are retained.' });
      edge({ edgeKind: 'knowledge_derivation', from, to, current: revision.revisionId === history.writeHeadRevisionId,
        relation: derivation.relation, source: derivation.source, ...(sourceRef ? { sourceBodyRef: sourceRef } : {}), reason: derivation.reason,
        targetStatus, recordedIn: { bodyRef: ref, revisedBy: revision.revisedBy, revisedAt: revision.revisedAt } }, [from, String(index)]);
    }
  }
  graph.nodes = [...nodes.values()]; graph.edges = [...edges.values()];
  // Consumers cannot mutate request-local cached histories or source snapshots through this projection.
  return structuredClone(graph);
}
