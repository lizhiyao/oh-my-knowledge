import { z } from 'zod';
import { EntityModelSchema } from '../extraction/entities.js';
import { mapEntityIdentity } from '../entities/identity.js';
import type { KnowledgeActor } from '../contracts.js';
import { EntityMentionSchema, KnowledgeDraftSchema } from '../contracts.js';
import { EntityAnalysisDraftSchema, type EntityAnalysisStore } from '../entities/contracts.js';
import { validateEntityAnalysis, validateEntityMentionSelection } from '../entities/validation.js';
import { validateKnowledgeDraft } from '../validation.js';
import type { KnowledgeStore } from '../store.js';
import { canonicalJson } from '../store.js';
import type { KnowledgeTagStore } from '../tags.js';
import type { EvidenceStore, EvidenceWindow, SourceSelection } from '../extraction/evidence.js';
import type { GenerationJournalStore } from '../extraction/generation-journal.js';
import { KnowledgeAssociationRevisionSchema, type KnowledgeAssociationStore } from '../associations.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../adapters/body-digest.js';
import type { KnowledgeGenerationModel } from '../adapters/generation-executor.js';
import { BodyGenerationApplication, type KnowledgeGenerationOptions } from './body-generation.js';
import type { EntityQuery } from './entity-catalog.js';
import { KnowledgeReadContext } from './read-context.js';
import type { KnowledgeGraphRequest } from './graph.js';

export type { KnowledgeGenerationModel } from '../adapters/generation-executor.js';
export type { KnowledgeGenerationOptions } from './body-generation.js';
export interface KnowledgeApplicationPorts {
  evidence: EvidenceStore; knowledge: KnowledgeStore; journals: GenerationJournalStore; tags: KnowledgeTagStore;
  entities: EntityAnalysisStore; associations: KnowledgeAssociationStore;
  id(): string; now(): string; hash(value: unknown): string; actor: KnowledgeActor;
}
/** Canonical body reads never depend on a successful entity or typed projection. */
export class KnowledgeApplication {
  private readonly generation: BodyGenerationApplication;
  constructor(private readonly ports: KnowledgeApplicationPorts) { this.generation = new BodyGenerationApplication(ports); }
  capture(selection: SourceSelection, signal?: AbortSignal): EvidenceWindow { return this.ports.evidence.capture(selection, signal); }
  source(snapshotId: string, version?: string) { return this.ports.evidence.read(snapshotId, version); }
  deleteSource(snapshotId: string): void { this.ports.evidence.delete(snapshotId); }
  runs() { return this.ports.journals.list(); }
  inspect(runId: string) { return this.generation.inspect(runId); }
  quality() {
    const inventory = this.runs();
    return { projectionKind: 'knowledge-body-admission' as const, schemaVersion: 1 as const,
      current: inventory.current.map(j => ({ runId: j.runId, status: j.status, savedBodies: j.bodies.length,
        phases: j.stages.map(s => ({ stageKind: s.stageKind, state: s.state, rejected: s.rejected?.length ?? null, issues: s.issues })) })),
      unsupported: inventory.unsupported, unavailable: inventory.unavailable, archiveChecks: inventory.archiveChecks, semanticQuality: 'not_assessed' as const };
  }
  generate(snapshot: string, model: KnowledgeGenerationModel, runId?: string, signal?: AbortSignal, options?: KnowledgeGenerationOptions) { return this.generation.generate(snapshot, model, runId, signal, options); }
  resume(runId: string, signal?: AbortSignal) { signal?.throwIfAborted(); return this.generation.resume(runId); }
  continueStage(runId: string, generation: number, model: KnowledgeGenerationModel, signal?: AbortSignal) { return this.generation.continueStage(runId, generation, model, signal); }
  rebuildAssociations(ref: Parameters<BodyGenerationApplication['rebuild']>[0], model: KnowledgeGenerationModel, runId?: string, signal?: AbortSignal) {
    return this.generation.rebuild(ref, model, runId, signal);
  }
  readContext() { return new KnowledgeReadContext(this.ports); }
  list(knowledgeIds?: ReadonlySet<string>) { return this.readContext().list(knowledgeIds); }
  detail(knowledgeId: string, revisionId?: string) { return this.readContext().detail(knowledgeId, revisionId); }
  graph(input: KnowledgeGraphRequest = {}) { return this.readContext().graph(input); }
  associationCatalogs(knowledgeId: string, revisionId?: string) { return this.readContext().associationCatalogs(knowledgeId, revisionId); }
  tag(knowledgeId: string, generation: number, tags: unknown) {
    this.ports.knowledge.read(knowledgeId); return this.ports.tags.write(knowledgeId, generation, tags, this.ports.actor);
  }
  maintain(knowledgeId: string, revisionId: string, choice: 'retain' | 'discard', reason: string, expectedGeneration: number, requestId = this.ports.id()) {
    return this.ports.knowledge.write({ knowledgeId, requestId, expectedGeneration, commandKind: 'record_maintenance',
      maintenance: { revisionId, choice, reason, actor: this.ports.actor, at: this.ports.now() } }, this.ports.actor);
  }
  reviewAssociations(knowledgeId: string, projectionRevisionId: string, expectedGeneration: number, choice: 'accept' | 'reject', reason: string) {
    this.ports.associations.write({ commandKind: 'record_review', requestId: this.ports.id(), knowledgeId, expectedGeneration,
      review: { projectionRevisionId, choice, actor: this.ports.actor, at: this.ports.now(), reason } }, this.ports.actor);
    return this.detail(knowledgeId);
  }
  applyAssociations(knowledgeId: string, revisionId: string, bodyDigest: string, analysisId: string, entityRevisionId: string,
    expectedGeneration: number, input: unknown, reason: string) {
    const body = this.detail(knowledgeId, revisionId).revision;
    if (body.bodyDigest !== bodyDigest) throw new Error('Association body digest conflict.');
    const catalog = this.entities(analysisId, entityRevisionId);
    if (catalog.source.status !== 'available') throw new Error('Association entity source unavailable.');
    const draft = KnowledgeAssociationRevisionSchema.pick({ segmentEntityRefs: true, typedRelations: true, issues: true }).parse(input);
    for (const ref of draft.segmentEntityRefs) for (const id of ref.mentionIds) {
      const mention = catalog.revision.mentions.find(m => m.mentionId === id && m.entityId === ref.entityId);
      if (!mention || validateEntityMentionSelection(mention.selection, catalog.source.window.excerpts).length) throw new Error('Association mention evidence is invalid.');
    }
    const previous = (() => { try { return this.ports.associations.read(knowledgeId); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return undefined; } })();
    this.ports.associations.write({ commandKind: 'append_revision', requestId: this.ports.id(), knowledgeId, expectedGeneration,
      expectedHeadRevisionId: previous?.writeHeadRevisionId ?? null, revision: { ...draft, revisionId: this.ports.id(),
        ...(previous ? { parentRevisionId: previous.writeHeadRevisionId } : {}), bodyRef: knowledgeBodyRef(body), status: 'available', reviewStatus: 'pending',
        entityAnalysisRef: { analysisId, revisionId: entityRevisionId }, revisedAt: this.ports.now(), revisedBy: this.ports.actor, revisionReason: reason } }, this.ports.actor);
    return this.detail(knowledgeId, revisionId);
  }
  revise(knowledgeId: string, expectedRevisionId: string, expectedGeneration: number, input: unknown, reason: string) {
    const previous = this.detail(knowledgeId, expectedRevisionId), draft = KnowledgeDraftSchema.parse(input);
    const refs = [...new Map(draft.content.segments.flatMap(s => s.evidence).map(e => [canonicalJson(e.source), e.source])).values()];
    const sources = refs.map(ref => { const source = this.source(ref.snapshotId, ref.sourceVersion);
      if (source.status !== 'available') throw new Error(`Revision source unavailable: ${source.reason}.`);
      return { ...ref, excerpts: source.window.excerpts };
    });
    if (!validateKnowledgeDraft(draft, sources).accepted) throw new Error('Revision evidence is invalid.');
    const revisionId = this.ports.id(), at = this.ports.now();
    this.ports.knowledge.write({ commandKind: 'append_revision', requestId: this.ports.id(), knowledgeId,
      expectedGeneration, expectedHeadRevisionId: expectedRevisionId,
      revision: { ...draft, knowledgeId, revisionId, bodyDigest: knowledgeBodyDigest(draft), parentRevision: { knowledgeId, revisionId: expectedRevisionId },
        observationRefs: previous.revision.observationRefs, derivations: previous.revision.derivations,
        createdAt: previous.revision.createdAt, createdBy: previous.revision.createdBy, revisedAt: at, revisedBy: this.ports.actor, revisionReason: reason } }, this.ports.actor);
    return this.detail(knowledgeId, revisionId);
  }
  entities(analysisId: string, revisionId?: string) {
    const history = this.ports.entities.read(analysisId), revision = history.revisions.find(r => r.revisionId === (revisionId ?? history.writeHeadRevisionId));
    if (!revision) throw new Error('Entity analysis revision is missing.');
    return { history, revision, source: this.source(history.snapshotId, history.sourceVersion) };
  }
  entityBasis(analysisId: string, entityId: string, revisionId?: string) { return this.readContext().entityBasis(analysisId, entityId, revisionId); }
  queryEntities(input: EntityQuery = {}) { return this.readContext().queryEntities(input); }
  entityDetail(analysisId: string, entityId: string, revisionId?: string) { return this.readContext().entityDetail(analysisId, entityId, revisionId); }
  correctEntities(analysisId: string, expectedRevisionId: string, expectedGeneration: number, input: unknown, reason: string) {
    const previous = this.entities(analysisId, expectedRevisionId);
    if (previous.source.status !== 'available') throw new Error('Entity source unavailable.');
    const edit = z.strictObject({ entities: z.array(EntityModelSchema).max(256), mentions: z.array(EntityMentionSchema).max(512) }).parse(input);
    const knownEntities = new Set(previous.history.revisions.flatMap(revision => revision.entities.map(entity => entity.entityId)));
    const knownMentions = new Set(previous.history.revisions.flatMap(revision => revision.mentions.map(mention => mention.mentionId)));
    const mapIds = (ids: readonly string[], known: Set<string>) => new Map(ids.map(id => {
      if (known.has(id)) return [id, id];
      if (!/^new:[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Unknown correction identity.');
      return [id, this.ports.id()];
    }));
    if (new Set(edit.entities.map(entity => entity.entityId)).size !== edit.entities.length
      || new Set(edit.mentions.map(mention => mention.mentionId)).size !== edit.mentions.length) throw new Error('Duplicate correction identity.');
    const entityIds = mapIds(edit.entities.map(entity => entity.entityId), knownEntities);
    const mentionIds = mapIds(edit.mentions.map(mention => mention.mentionId), knownMentions);
    const draft = EntityAnalysisDraftSchema.parse({
      entities: edit.entities.map(entity => mapEntityIdentity(entity, entityIds, mentionIds)),
      mentions: edit.mentions.map(mention => ({ ...mention, mentionId: mentionIds.get(mention.mentionId), entityId: entityIds.get(mention.entityId) })),
      limitations: previous.revision.limitations,
    });
    const problems = [...validateEntityAnalysis(draft), ...draft.mentions.flatMap(mention => validateEntityMentionSelection(mention.selection, previous.source.status === 'available' ? previous.source.window.excerpts : []))];
    if (problems.length) throw new Error(`Invalid entity correction: ${problems.join(',')}`);
    this.ports.entities.write({ analysisId, snapshotId: previous.history.snapshotId, sourceVersion: previous.history.sourceVersion,
      requestId: this.ports.id(), expectedGeneration, expectedHeadRevisionId: expectedRevisionId,
      revision: { ...draft, revisionId: this.ports.id(), parentRevisionId: expectedRevisionId,
        revisedAt: this.ports.now(), revisedBy: this.ports.actor, revisionReason: reason } }, this.ports.actor);
    return this.entities(analysisId);
  }
}
