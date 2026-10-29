import type { KnowledgeBodyRef } from '../contracts.js';
import type { EntityAnalysisEnvelope, EntityAnalysisStore } from '../entities/contracts.js';
import type { KnowledgeEnvelope, KnowledgeStore } from '../store.js';
import { canonicalJson } from '../store.js';
import type { KnowledgeTagStore } from '../tags.js';
import type { EvidenceStore } from '../extraction/evidence.js';
import { selectKnowledgeAssociation, type KnowledgeAssociationSelection, type KnowledgeAssociationStore } from '../associations.js';
import { knowledgeBodyRef } from '../adapters/body-digest.js';
import { validateEvidenceSelection } from '../validation.js';
import { EntityQuerySchema, queryEntityRows, type EntityKnowledgeLink, type EntityQuery, type EntitySearchRow } from './entity-catalog.js';

interface ReadPorts {
  evidence: EvidenceStore; knowledge: KnowledgeStore; entities: EntityAnalysisStore;
  associations: KnowledgeAssociationStore; tags: KnowledgeTagStore;
}
type Cached<T> = { value: T } | { error: unknown };
function once<T>(cache: Map<string, Cached<T>>, key: string, read: () => T): T {
  let result = cache.get(key);
  if (!result) {
    try { result = { value: read() }; } catch (error) { result = { error }; }
    cache.set(key, result);
  }
  if ('error' in result) throw result.error;
  return result.value;
}

/** One read request owns these snapshots. Write/CAS checks always use the original stores. */
export class KnowledgeReadContext {
  private readonly bodies = new Map<string, Cached<KnowledgeEnvelope>>();
  private readonly catalogs = new Map<string, Cached<EntityAnalysisEnvelope>>();
  private readonly sources = new Map<string, Cached<ReturnType<EvidenceStore['read']>>>();
  private readonly tags = new Map<string, Cached<ReturnType<KnowledgeTagStore['read']>>>();
  private readonly projections = new Map<string, ReturnType<KnowledgeReadContext['readAssociation']>>();
  private histories?: Cached<KnowledgeEnvelope[]>;
  private links?: { status: 'available' | 'unavailable'; byEntity: Map<string, EntityKnowledgeLink[]> };
  constructor(private readonly ports: ReadPorts) {}

  private allKnowledge() {
    if (!this.histories) {
      try {
        const value = this.ports.knowledge.list();
        value.forEach(history => this.bodies.set(history.knowledgeId, { value: history }));
        this.histories = { value };
      } catch (error) { this.histories = { error }; }
    }
    if ('error' in this.histories) throw this.histories.error;
    return this.histories.value;
  }
  source(snapshotId: string, sourceVersion: string) {
    return once(this.sources, canonicalJson([snapshotId, sourceVersion]), () => this.ports.evidence.read(snapshotId, sourceVersion));
  }
  catalog(analysisId: string, revisionId?: string) {
    const history = once(this.catalogs, analysisId, () => this.ports.entities.read(analysisId));
    const revision = history.revisions.find(item => item.revisionId === (revisionId ?? history.writeHeadRevisionId));
    if (!revision) throw new Error('Entity analysis revision is missing.');
    return { history, revision };
  }
  private readAssociation(bodyRef: KnowledgeBodyRef): KnowledgeAssociationSelection & { generation: number; headRevisionId: string | null } {
    try {
      const history = this.ports.associations.read(bodyRef.knowledgeId);
      return { ...selectKnowledgeAssociation(history, bodyRef), generation: history.generation, headRevisionId: history.writeHeadRevisionId };
    } catch (error) {
      return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'failed',
        reviewStatus: 'pending', bodyRef, generation: 0, headRevisionId: null };
    }
  }
  private association(bodyRef: KnowledgeBodyRef) {
    const key = canonicalJson(bodyRef);
    let projection = this.projections.get(key);
    if (!projection) { projection = this.readAssociation(bodyRef); this.projections.set(key, projection); }
    return projection;
  }
  private associationCatalog(association: KnowledgeAssociationSelection) {
    const ref = association.revision?.entityAnalysisRef;
    if (!ref) return { status: 'absent' as const };
    try {
      const { history, revision } = this.catalog(ref.analysisId, ref.revisionId);
      return { status: 'available' as const, ...ref, currentHeadRevisionId: history.writeHeadRevisionId,
        entities: revision.entities, mentions: revision.mentions };
    } catch { return { status: 'unavailable' as const, ...ref }; }
  }
  list(knowledgeIds?: ReadonlySet<string>) {
    const histories = knowledgeIds ? this.ports.knowledge.list(knowledgeIds) : this.allKnowledge();
    return histories.filter(history => !knowledgeIds || knowledgeIds.has(history.knowledgeId)).map(history => {
      this.bodies.set(history.knowledgeId, { value: history });
      const revision = history.revisions.at(-1)!;
      const tags = once(this.tags, history.knowledgeId, () => this.ports.tags.read(history.knowledgeId)).tags;
      return { knowledgeId: history.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest,
        generation: history.generation, title: revision.title, knowledgeKind: revision.content.organization?.knowledgeKind ?? null,
        reviewStatus: 'pending' as const, choice: history.maintenance.filter(m => m.revisionId === revision.revisionId).at(-1)?.choice ?? null,
        ...(tags.length ? { tags } : {}) };
    });
  }
  /** Body/association metadata, without reading source snapshots or native outcomes. */
  body(knowledgeId: string, revisionId?: string) {
    const history = once(this.bodies, knowledgeId, () => this.ports.knowledge.read(knowledgeId));
    const selected = revisionId ?? history.writeHeadRevisionId;
    const revision = history.revisions.find(item => item.revisionId === selected);
    if (!revision) throw new Error('Knowledge revision is missing.');
    const derivedAssociations = this.association(knowledgeBodyRef(revision));
    return { history, revision, reviewStatus: 'pending' as const,
      tagging: once(this.tags, knowledgeId, () => this.ports.tags.read(knowledgeId)),
      maintenance: history.maintenance.filter(m => m.revisionId === selected).at(-1) ?? null,
      derivedAssociations, derivedCatalog: this.associationCatalog(derivedAssociations) };
  }
  detail(knowledgeId: string, revisionId?: string) {
    const body = this.body(knowledgeId, revisionId);
    const refs = [...new Map(body.revision.content.segments.flatMap(s => s.evidence).map(e => [canonicalJson(e.source), e.source])).values()];
    return { ...body, sources: refs.map(ref => this.source(ref.snapshotId, ref.sourceVersion)) };
  }
  /** Identity and source checks do not depend on unrelated knowledge or derived links. */
  entityBasis(analysisId: string, entityId: string, revisionId?: string) {
    const detail = this.catalog(analysisId, revisionId);
    const entity = detail.revision.entities.find(item => item.entityId === entityId);
    if (!entity) throw new Error('Entity is absent from the selected revision.');
    const source = this.source(detail.history.snapshotId, detail.history.sourceVersion);
    return { ...detail, entity, source,
      ...(source.status === 'available' && source.window.origin ? { origin: source.window.origin } : {}),
      mentionChecks: detail.revision.mentions.filter(m => m.entityId === entityId).map(m => ({ mentionId: m.mentionId,
        positionStatus: source.status === 'unavailable' ? 'unavailable' as const
          : validateEvidenceSelection(m.selection, source.window.excerpts).length ? 'mismatch' as const : 'matched' as const })) };
  }
  private knowledgeLinks() {
    if (this.links) return this.links;
    const byEntity = new Map<string, EntityKnowledgeLink[]>();
    const result = { status: 'available' as 'available' | 'unavailable', byEntity };
    try {
      for (const history of this.allKnowledge()) {
        const body = history.revisions.at(-1)!, selected = this.association(knowledgeBodyRef(body)), revision = selected.revision;
        if (selected.status === 'failed') { result.status = 'unavailable'; continue; }
        if (selected.status !== 'available' || selected.reviewStatus === 'rejected' || !revision?.entityAnalysisRef) continue;
        const ref = revision.entityAnalysisRef;
        const catalog = this.catalog(ref.analysisId);
        const grouped = new Map<string, string[]>();
        for (const segment of revision.segmentEntityRefs) grouped.set(segment.entityId, [...(grouped.get(segment.entityId) ?? []), segment.segmentId]);
        for (const [entityId, segmentIds] of grouped) {
          const key = `${ref.analysisId}:${entityId}`;
          byEntity.set(key, [...(byEntity.get(key) ?? []), { knowledgeId: history.knowledgeId, revisionId: body.revisionId, title: body.title,
            projectionReviewStatus: selected.reviewStatus, entityRevisionId: ref.revisionId, currentEntityRevision: ref.revisionId === catalog.history.writeHeadRevisionId,
            choice: history.maintenance.filter(m => m.revisionId === body.revisionId).at(-1)?.choice ?? null, segmentIds }]);
        }
      }
    } catch { result.status = 'unavailable'; }
    this.links = result;
    return result;
  }
  entityDetail(analysisId: string, entityId: string, revisionId?: string) {
    const basis = this.entityBasis(analysisId, entityId, revisionId), links = this.knowledgeLinks();
    return { ...basis, knowledge: links.byEntity.get(`${analysisId}:${entityId}`) ?? [], knowledgeStatus: links.status };
  }
  queryEntities(input: EntityQuery = {}) {
    const query = EntityQuerySchema.parse(input), saved = this.ports.entities.list();
    saved.histories.forEach(history => this.catalogs.set(history.analysisId, { value: history }));
    const rows: EntitySearchRow[] = saved.histories.flatMap(history => {
      const revision = history.revisions.at(-1)!, source = this.source(history.snapshotId, history.sourceVersion);
      return revision.entities.map(entity => {
        const mentions = revision.mentions.filter(m => m.entityId === entity.entityId);
        return { ...entity, analysisId: history.analysisId, revisionId: revision.revisionId, generation: history.generation,
          revisedAt: revision.revisedAt, mentionCount: mentions.length, surfaces: [...new Set(mentions.map(m => m.selection.quote))],
          sourceStatus: source.status, ...(source.status === 'available' && source.window.origin ? { origin: source.window.origin } : {}),
          knowledgeCount: null, outdatedKnowledgeCount: null };
      });
    });
    const page = queryEntityRows(rows, query);
    const links = page.rows.length ? this.knowledgeLinks() : { status: 'available' as const, byEntity: new Map<string, EntityKnowledgeLink[]>() };
    return { ...page, rows: page.rows.map(row => {
      const related = links.byEntity.get(`${row.analysisId}:${row.entityId}`) ?? [];
      return { ...row, knowledgeCount: links.status === 'available' ? related.length : null,
        outdatedKnowledgeCount: links.status === 'available' ? related.filter(link => !link.currentEntityRevision).length : null };
    }), analysisCount: saved.histories.length, unavailableAnalyses: saved.unavailable, knowledgeStatus: links.status };
  }
}
