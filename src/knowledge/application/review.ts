import type { KnowledgeAssociationRevision, KnowledgeAssociationStore } from '../associations.js';
import { KnowledgeBodyRefSchema, type KnowledgeActor, type KnowledgeBodyEvidence, type KnowledgeBodyRef } from '../contracts.js';
import type { KnowledgeStore } from '../store.js';
import type { EntityAnalysisStore } from '../entities/contracts.js';
import { validateKnowledgeAssociationCatalogReferences } from '../entities/association-references.js';
import type { SourceStore } from '../source-store.js';
import { validateEvidenceSelection } from '../validation.js';
import { KnowledgeReviewActorSchema, KnowledgeContentReviewInputSchema, KnowledgeCoverageReviewInputSchema, KnowledgeUseInputSchema, KnowledgeReviewWriteSchema,
  knowledgeReviewSources, sameReviewBody, selectKnowledgeReviews, type KnowledgeContentReviewInput, type KnowledgeCoverageReviewInput, type KnowledgeUseInput, type KnowledgeReviewStore, type KnowledgeReviewWrite } from '../reviews.js';
import { validateKnowledgeReviewBodyReferences, validateKnowledgeReviewReferences } from '../review-history.js';

export interface KnowledgeReviewPorts {
  knowledge: KnowledgeStore; associations: KnowledgeAssociationStore; entities: EntityAnalysisStore; sources: SourceStore;
  reviews: KnowledgeReviewStore; actor?: KnowledgeActor; now(): string;
  assertWritable?(): void;
}
/** Review events describe explicit opinions and use signals, never an automatic semantic pass. */
export class KnowledgeReviewApplication {
  constructor(private readonly ports: KnowledgeReviewPorts) {
    if (ports.actor !== undefined) KnowledgeReviewActorSchema.parse(ports.actor);
  }
  private body(input: KnowledgeBodyRef) {
    const ref = KnowledgeBodyRefSchema.parse(input), history = this.ports.knowledge.read(ref.knowledgeId);
    const body = history.revisions.find(revision => revision.revisionId === ref.revisionId);
    if (!body || !sameReviewBody(ref, body)) throw new Error('Knowledge review body identity conflict.');
    return body;
  }
  private projection(bodyRef: KnowledgeBodyRef, revisionId?: string | null): KnowledgeAssociationRevision | undefined {
    try {
      const history = this.ports.associations.read(bodyRef.knowledgeId);
      const revision = revisionId ? history.revisions.find(revision => revision.revisionId === revisionId)
        : [...history.revisions].reverse().find(revision => sameReviewBody(revision.bodyRef, bodyRef));
      if (revisionId === null && revision) throw new Error('Knowledge coverage projection identity conflict.');
      if (revisionId && (!revision || !sameReviewBody(revision.bodyRef, bodyRef))) throw new Error('Knowledge coverage projection identity conflict.');
      return revision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !revisionId) return undefined;
      throw error;
    }
  }
  private sourceStates(body: ReturnType<KnowledgeReviewApplication['body']>) {
    return knowledgeReviewSources(body).map(ref => {
      try {
        const source = this.ports.sources.read(ref.snapshotId, ref.sourceVersion);
        return source.status === 'available' ? { ...ref, status: 'available' as const }
          : { ...ref, status: 'unavailable' as const, reason: source.reason };
      } catch { return { ...ref, status: 'unavailable' as const, reason: 'corrupt' }; }
    });
  }
  status(input: KnowledgeBodyRef, projectionRevisionId?: string | null) {
    const bodyRef = KnowledgeBodyRefSchema.parse(input), body = this.body(bodyRef), sources = this.sourceStates(body);
    let projection: KnowledgeAssociationRevision | undefined, projectionUnavailable = false;
    try { projection = this.projection(bodyRef, projectionRevisionId); } catch { projectionUnavailable = true; }
    let history: ReturnType<KnowledgeReviewStore['read']>;
    try {
      history = this.ports.reviews.read(bodyRef.knowledgeId);
      for (const event of history?.events ?? []) if (event.bodyRef.revisionId === bodyRef.revisionId) validateKnowledgeReviewBodyReferences(event, body);
    }
    catch {
      return { storageStatus: 'unavailable' as const, bodyRef, generation: null, headEventId: null, sources, history: null,
        content: { status: 'unavailable' as const, events: [] }, coverage: { status: 'unavailable' as const, projectionRevisionId: projection?.revisionId ?? projectionRevisionId ?? null, events: [], decisions: [] }, usage: [],
        reason: 'The exact review ledger is unavailable; absence of review cannot be inferred.' };
    }
    const selected = selectKnowledgeReviews(history, body, projection?.revisionId ?? null);
    return { storageStatus: history ? 'available' as const : 'absent' as const, bodyRef, generation: history?.generation ?? 0,
      headEventId: history?.writeHeadEventId ?? null, sources, history: history ?? null, ...selected,
      coverage: projectionUnavailable ? { status: 'unavailable' as const, projectionRevisionId: projectionRevisionId ?? null, events: [], decisions: [] } : selected.coverage };
  }
  reviewContent(input: KnowledgeContentReviewInput) {
    return this.write({ ...KnowledgeContentReviewInputSchema.parse(input), eventKind: 'content_review' });
  }
  reviewCoverage(input: KnowledgeCoverageReviewInput) {
    return this.write({ ...KnowledgeCoverageReviewInputSchema.parse(input), eventKind: 'association_coverage' });
  }
  recordUse(input: KnowledgeUseInput) {
    return this.write({ ...KnowledgeUseInputSchema.parse(input), eventKind: 'task_use' });
  }
  private validateInline(evidence: KnowledgeBodyEvidence[]) {
    for (const value of evidence) {
      const source = this.ports.sources.read(value.source.snapshotId, value.source.sourceVersion);
      if (source.status !== 'available' || validateEvidenceSelection(value.selection, source.snapshot.excerpts).length) throw new Error('Knowledge review evidence does not match its exact source.');
    }
  }
  private write(input: KnowledgeReviewWrite) {
    if (!this.ports.actor) throw new Error('A trusted review actor is required for writes.');
    this.ports.assertWritable?.();
    const actor = KnowledgeReviewActorSchema.parse(this.ports.actor), command = KnowledgeReviewWriteSchema.parse(input);
    return this.ports.reviews.write(command, actor, this.ports.now(), () => {
      // This callback is invoked after CAS/receipt checks while holding the shared workspace lock.
      const body = this.body(command.bodyRef), projection = command.eventKind === 'association_coverage' ? this.projection(command.bodyRef, command.projectionRevisionId) : undefined;
      validateKnowledgeReviewReferences(command, body, projection);
      // Missing originals do not erase old opinions or prevent feedback about an actually consumed body.
      this.sourceStates(body);
      if (command.eventKind === 'content_review') this.validateInline(command.findings.flatMap(finding => finding.evidence));
      if (command.eventKind === 'task_use') this.validateInline(command.evidence);
      if (command.eventKind === 'association_coverage' && projection) {
        const catalogs = new Map(command.decisions.flatMap(decision => decision.entityRefs).map(ref => [`${ref.analysisId}/${ref.entityRevisionId}`, ref]));
        for (const ref of catalogs.values()) validateKnowledgeAssociationCatalogReferences(projection, body, this.ports.entities.read(ref.analysisId), ref.entityRevisionId);
      }
    });
  }
}
export type KnowledgeReviewStatus = ReturnType<KnowledgeReviewApplication['status']>;

