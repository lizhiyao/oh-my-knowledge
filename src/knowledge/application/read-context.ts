import type { KnowledgeBodyRef } from '../contracts.js';
import type { EntityAnalysisEnvelope, EntityAnalysisStore } from '../entities/contracts.js';
import type { KnowledgeEnvelope, KnowledgeStore } from '../store.js';
import { canonicalJson } from '../store.js';
import type { KnowledgeTagStore } from '../tags.js';
import type { EvidenceStore } from '../extraction/evidence.js';
import { selectKnowledgeAssociation, knowledgeAssociationCatalogKey, type KnowledgeAssociationSelection, type KnowledgeAssociationStore } from '../associations.js';
import { validateKnowledgeAssociationCatalogReferences } from '../entities/association-references.js';
import { knowledgeBodyRef } from '../adapters/body-digest.js';
import { validateEvidenceSelection } from '../validation.js';
import { EntityQuerySchema, queryEntityRows, type EntityKnowledgeLink, type EntityQuery, type EntitySearchRow } from './entity-catalog.js';
import { buildKnowledgeGraph, type KnowledgeGraphRequest } from './graph.js';

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
  private readonly associationHistories = new Map<string, Cached<ReturnType<KnowledgeAssociationStore['read']>>>();
  private entityInventory?: Cached<ReturnType<EntityAnalysisStore['list']>>;
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
  private allEntities() {
    if (!this.entityInventory) {
      try {
        const value = this.ports.entities.list();
        value.histories.forEach(history => this.catalogs.set(history.analysisId, { value: history }));
        this.entityInventory = { value };
      } catch (error) { this.entityInventory = { error }; }
    }
    if ('error' in this.entityInventory) throw this.entityInventory.error;
    return this.entityInventory.value;
  }
  private associationHistory(knowledgeId: string) {
    return once(this.associationHistories, knowledgeId, () => this.ports.associations.read(knowledgeId));
  }
  private readAssociation(bodyRef: KnowledgeBodyRef): KnowledgeAssociationSelection & { generation: number; headRevisionId: string | null } {
    try {
      const history = this.associationHistory(bodyRef.knowledgeId);
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
  private associationCatalogsFor(association: KnowledgeAssociationSelection, body: KnowledgeEnvelope['revisions'][number]) {
    const projection = association.revision;
    return (projection?.catalogRefs ?? []).map(ref => {
      try {
        const { history, revision } = this.catalog(ref.analysisId, ref.entityRevisionId);
        // A stale projection still describes its original body, not the currently selected revision.
        const associatedBody = projection && once(this.bodies, body.knowledgeId, () => this.ports.knowledge.read(body.knowledgeId))
          .revisions.find(value => value.revisionId === projection.bodyRef.revisionId);
        if (!projection || !associatedBody) throw new Error('Unknown association body revision.');
        validateKnowledgeAssociationCatalogReferences(projection, associatedBody, history, revision.revisionId);
        return { status: 'available' as const, ...ref, currentHeadRevisionId: history.writeHeadRevisionId,
          snapshotId: history.snapshotId, sourceVersion: history.sourceVersion, entities: revision.entities, mentions: revision.mentions };
      } catch { return { status: 'unavailable' as const, ...ref, reason: 'The exact catalog or its saved references are unavailable.' }; }
    });
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
      derivedAssociations, derivedCatalogs: this.associationCatalogsFor(derivedAssociations, revision) };
  }
  detail(knowledgeId: string, revisionId?: string) {
    const body = this.body(knowledgeId, revisionId);
    const refs = [...new Map(body.revision.content.segments.flatMap(s => s.evidence).map(e => [canonicalJson(e.source), e.source])).values()];
    return { ...body, sources: refs.map(ref => {
      try { return this.source(ref.snapshotId, ref.sourceVersion); }
      catch { return { status: 'unavailable' as const, reason: 'invalid_source' as const, detail: 'The exact source snapshot could not be read.' }; }
    }) };
  }
  graph(input: KnowledgeGraphRequest = {}) {
    return buildKnowledgeGraph({
      listKnowledge: ids => {
        if (!ids) return this.allKnowledge();
        const histories = this.ports.knowledge.list(ids);
        histories.forEach(history => this.bodies.set(history.knowledgeId, { value: history }));
        return histories;
      },
      knowledge: id => once(this.bodies, id, () => this.ports.knowledge.read(id)),
      associations: id => this.associationHistory(id), catalog: id => this.catalog(id).history,
      source: (id, version) => this.source(id, version!),
    }, input);
  }
  /** Catalog discovery is exact source membership, never name or path similarity. */
  associationCatalogs(knowledgeId: string, revisionId?: string) {
    const history = once(this.bodies, knowledgeId, () => this.ports.knowledge.read(knowledgeId));
    const revision = history.revisions.find(item => item.revisionId === (revisionId ?? history.writeHeadRevisionId));
    if (!revision) throw new Error('Knowledge revision is missing.');
    const refs = [...new Map(revision.content.segments.flatMap(segment => segment.evidence).map(evidence => [canonicalJson(evidence.source), evidence.source])).values()];
    const identities = new Set(refs.map(ref => canonicalJson(ref))), saved = this.allEntities();
    const sourceSummaries = new Map(refs.map(ref => {
      try {
        const resolution = this.source(ref.snapshotId, ref.sourceVersion);
        const summary = resolution.status === 'available' ? { ...(resolution.window.origin?.title ? { title: resolution.window.origin.title } : {}),
          sourceKind: resolution.window.sourceKind, excerptCount: resolution.window.excerpts.length,
          firstRecordIndex: resolution.window.startRecord, lastRecordIndex: resolution.window.endRecord } : undefined;
        return [canonicalJson(ref), summary] as const;
      } catch { return [canonicalJson(ref), undefined] as const; }
    }));
    return { bodyRef: knowledgeBodyRef(revision), catalogs: saved.histories.filter(item => identities.has(canonicalJson({ snapshotId: item.snapshotId, sourceVersion: item.sourceVersion })))
      .map(item => ({ analysisId: item.analysisId, snapshotId: item.snapshotId, sourceVersion: item.sourceVersion, writeHeadRevisionId: item.writeHeadRevisionId,
        ...(sourceSummaries.get(canonicalJson({ snapshotId: item.snapshotId, sourceVersion: item.sourceVersion }))
          ? { sourceSummary: sourceSummaries.get(canonicalJson({ snapshotId: item.snapshotId, sourceVersion: item.sourceVersion }))! } : {}),
        revisions: item.revisions.map(value => ({ revisionId: value.revisionId, revisionReason: value.revisionReason, revisedAt: value.revisedAt,
          entityCount: value.entities.length, mentionCount: value.mentions.length })) })),
    unavailableAnalyses: saved.unavailable, sources: refs.map(ref => {
      try { return { ...ref, status: this.source(ref.snapshotId, ref.sourceVersion).status }; }
      catch { return { ...ref, status: 'unavailable' as const }; }
    }) };
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
        if (selected.status !== 'available' || selected.reviewStatus === 'rejected' || !revision) continue;
        const available = this.associationCatalogsFor(selected, body);
        for (const catalog of available) {
          if (catalog.status !== 'available') { result.status = 'unavailable'; continue; }
          const grouped = new Map<string, string[]>();
          for (const segment of revision.segmentEntityRefs.filter(ref => knowledgeAssociationCatalogKey(ref) === knowledgeAssociationCatalogKey(catalog))) {
            grouped.set(segment.entityId, [...new Set([...(grouped.get(segment.entityId) ?? []), segment.segmentId])]);
          }
          for (const [entityId, segmentIds] of grouped) {
            const key = `${catalog.analysisId}:${entityId}`;
            byEntity.set(key, [...(byEntity.get(key) ?? []), { knowledgeId: history.knowledgeId, revisionId: body.revisionId, title: body.title,
              projectionReviewStatus: selected.reviewStatus, entityRevisionId: catalog.entityRevisionId,
              currentEntityRevision: catalog.entityRevisionId === catalog.currentHeadRevisionId,
              choice: history.maintenance.filter(m => m.revisionId === body.revisionId).at(-1)?.choice ?? null, segmentIds }]);
          }
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
    const query = EntityQuerySchema.parse(input), saved = this.allEntities();
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
      return { ...row, knowledgeCount: links.status === 'available' ? new Set(related.map(link => canonicalJson([link.knowledgeId, link.revisionId]))).size : null,
        outdatedKnowledgeCount: links.status === 'available' ? new Set(related.filter(link => !link.currentEntityRevision).map(link => canonicalJson([link.knowledgeId, link.revisionId]))).size : null };
    }), analysisCount: saved.histories.length, unavailableAnalyses: saved.unavailable, knowledgeStatus: links.status };
  }
}
