import type { ExtractionRunSealRequest } from '../extraction/run-sealing.js';
import { createHash } from 'node:crypto';
import type { KnowledgeActor, KnowledgeDraft, KnowledgeRevision } from '../contracts.js';
import { EntityMentionSchema, KnowledgeDraftSchema } from '../contracts.js';
import { z } from 'zod';
import { EntityAnalysisDraftSchema, type EntityAnalysisStore, type EntityAnalysisWrite } from '../entities/contracts.js';
import { validateEntityAnalysis, validateEntityMentionSelection } from '../entities/validation.js';
import { validateEvidenceSelection, validateGroundingReferences } from '../validation.js';
import type { KnowledgeGrounding, KnowledgeStore } from '../store.js';
import type { KnowledgeTagStore } from '../tags.js';
import type { EvidenceStore, EvidenceWindow, SourceSelection } from '../extraction/evidence.js';
import type { ExtractionOutcome, ExtractionOutcomeRef, ExtractionRun, ExtractionRunStore } from '../extraction/runs.js';
import { ExtractionAttemptSchema } from '../extraction/runs.js';
import type { ExtractionProposal } from '../extraction/proposals.js';
import { EntityModelSchema } from '../extraction/entities.js';
import { checkWindowExtractionResponse } from '../extraction/window-proposals.js';
import { entityKnowledgeLinks, queryEntityRows, type EntitySearchRow, type EntityQuery } from './entity-catalog.js';
import { KnowledgeCitationRevisionError, resolveKnowledgeCitationLocators } from './citation-locators.js';
import type { KnowledgeEnvelope } from '../store.js';
import { mapEntityIdentity } from '../entities/identity.js';
import { assertExtractionInputCapacity, extractionModelInput, extractionTaskInput, ExtractionInputCapacityError } from '../extraction/model-input.js';
import { extractionQuality } from '../extraction/quality.js';
import { setTimeout as wait } from 'node:timers/promises';
import { resolveTokenBudgetProfile } from '../../executors/contracts/token-budget.js';
import { ExtractionGenerationPolicySchema, ExtractionBudgetReservationSchema, accountExtractionOutcome, SINGLE_EXTRACTION_POLICY,
  TRANSIENT_EXTRACTION_FAILURES, REASK_EXTRACTION_FAILURES, EXTRACTION_FEEDBACK_PREAMBLE,
  type ExtractionGenerationPolicy, type ExtractionBoundedPolicy, type ExtractionBudgetReservation } from '../extraction/generation-policy.js';
import { extractionExecution, extractionOutcomeResult, extractionPrompt, extractionRequestDigest, extractionResponse, invokeExtractionModel, serializeExtractionObservation } from '../extraction/generation.js';
import type { ExtractionModel, ExtractionPromptProfile } from '../extraction/generation.js';
import { buildExtractionCoverageReviewInput } from '../extraction/coverage-review-input.js';
import { STRICT_EXTRACTION_PROMPT, STRICT_EXTRACTION_PROMPT_VERSION } from '../extraction/strict-prompt.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../extraction/model-wire.js';
import { readSourcePlanEvidence, type SourcePlanArchivePort, type SourcePlanReference } from '../extraction/source-plan-evidence.js';
import { buildSourcePlannedExtractionInput } from '../extraction/source-plan-input.js';
import { readBoundKnowledgeEvidence, type BoundKnowledgeArchivePort,
  type BoundKnowledgeReference } from '../extraction/bound-knowledge-evidence.js';
import { boundKnowledgeIntentIds, readEntityFirstKnowledgeContext } from './entity-first-knowledge.js';
import { readEntityReviewEvidence, type EntityReviewArchivePort, type EntityReviewReference } from '../extraction/entity-review-evidence.js';
import { readReviewedKnowledgeEvidence, type ReviewedKnowledgeArchivePort, type ReviewedKnowledgeReference } from '../extraction/reviewed-knowledge-evidence.js';
import type { BoundKnowledgeCatalog } from '../extraction/bound-catalog.js';
import type { CheckedBoundKnowledge } from '../extraction/bound-knowledge.js';
import { entityOnlyTaskViolation, isEntityOnlyTask } from '../extraction/entity-only-task.js';
import { readDiscoveredEntitiesContext, readDiscoveredEntitiesKnowledgeContext, importDiscoveredEntityAnalysis,
  type DiscoveredEntitiesSource, type DiscoveredEntitiesContextReferences, type DiscoveredEntitiesReferences } from './discovered-entities.js';
import type { EntityDiscoveryArchivePort, EntityDiscoveryModel } from '../extraction/discovered-entities-evidence.js';
import { readRefinedEntitiesContext, readRefinedEntitiesRebindingContext, readRefinedEntitiesKnowledgeContext, importRefinedEntityAnalysis,
  type RefinedEntitiesSource, type RefinedEntitiesContextReferences, type RefinedEntitiesReferences } from './refined-entities.js';
import type { RefinedEntitiesArchivePort, RefinedEntitiesBaseReferences, RefinedEntitiesModel } from '../extraction/refined-entities-evidence.js';

export type { ExtractionModel } from '../extraction/generation.js';

export interface KnowledgeApplicationPorts {
  evidence: EvidenceStore; knowledge: KnowledgeStore; runs: ExtractionRunStore; tags: KnowledgeTagStore;
  entities: EntityAnalysisStore;
  id(): string; now(): string; hash(value: unknown): string;
  actor: KnowledgeActor;
  generationTiming?: { now(): number; random(): number; wait(ms: number, signal?: AbortSignal): Promise<void> };
  /** Optional readonly research evidence; ordinary hosts do not install a source-plan archive. */
  sourcePlanArchive?: SourcePlanArchivePort;
  /** Private E-first research only; ordinary hosts do not install a K-only native archive. */
  boundKnowledgeArchive?: BoundKnowledgeArchivePort;
  /** Explicit E→R→K research only; no ordinary host enables either archive. */
  entityReviewArchive?: EntityReviewArchivePort;
  reviewedKnowledgeArchive?: ReviewedKnowledgeArchivePort;
  /** Private source-only discovery→binding research only; ordinary delivery hosts do not install this archive. */
  discoveredEntitiesArchive?: EntityDiscoveryArchivePort;
  /** Explicit one-round catalog revision only; ordinary hosts do not install either new-stage archive. */
  refinedEntitiesArchive?: RefinedEntitiesArchivePort;
}
export interface EntityReviewSelection {
  reference: EntityReviewReference;
  model: Pick<ExtractionModel, 'executor' | 'model' | 'timeoutMs' | 'maxOutputTokens'>;
}
export interface ExtractionGenerationOptions {
  policy?: ExtractionGenerationPolicy;
  /** Internal controlled studies bind an explicit version and the exact dispatched system bytes. */
  promptProfile?: ExtractionPromptProfile;
  /** Internal research task: a new single call, never a retry or an automatic default. */
  coverageReview?: { previousRunId: string };
  /** Internal two-stage study only. Callers provide an archive identity, never raw plan text. */
  sourceSemanticPlan?: SourcePlanReference;
  beforeDispatch?: (claim: { runId: string; attemptId: string; requestDigest: string; budget?: ExtractionBudgetReservation }) => void;
  /** Durable returned facts, outside the run-store lock and before admission or another invocation. */
  onOutcomeArchived?: (event: { runId: string; attemptId: string; outcome: ExtractionOutcome; ref: ExtractionOutcomeRef }) => void;
}

/** Both delivery hosts call this workflow; neither owns knowledge state transitions. */
export class KnowledgeApplication {
  private heldOutcome?: { runId: string; attemptId: string; outcome: ExtractionOutcome; maxBytes: number };
  private invocationInFlight?: string;
  constructor(private readonly ports: KnowledgeApplicationPorts) {}
  capture(selection: SourceSelection, signal?: AbortSignal): EvidenceWindow { return this.ports.evidence.capture(selection, signal); }
  list(knowledgeIds?: ReadonlySet<string>) {
    const histories = knowledgeIds ? this.ports.knowledge.list(knowledgeIds) : this.ports.knowledge.list();
    return histories.filter(history => !knowledgeIds || knowledgeIds.has(history.knowledgeId)).map((history) => {
      const tags = this.ports.tags.read(history.knowledgeId).tags;
      return {
      knowledgeId: history.knowledgeId, revisionId: history.writeHeadRevisionId,
      generation: history.generation, title: history.revisions.at(-1)!.title,
      knowledgeKind: history.revisions.at(-1)!.content.organization.knowledgeKind,
      reviewStatus: 'pending' as const,
      choice: history.maintenance.filter((entry) => entry.revisionId === history.writeHeadRevisionId).at(-1)?.choice ?? null,
      ...(tags.length ? { tags } : {}),
    }; });
  }
  // Listing and quality consume saved manifest facts; execution paths use the archive-validating read port.
  runs() { return this.ports.runs.listManifests(); }
  quality(): ReturnType<typeof extractionQuality> { return extractionQuality(this.ports.runs.listManifests(), this.ports.runs.listSeals?.() ?? []); }
  sealedRuns(runId?: string, namespace: 'current' | 'legacy' = 'current') {
    if (runId) {
      if (!this.ports.runs.inspectSeal) throw new Error('Extraction run sealing unavailable.');
      return this.ports.runs.inspectSeal(runId, namespace);
    }
    if (!this.ports.runs.listSeals) throw new Error('Extraction run sealing unavailable.');
    return this.ports.runs.listSeals();
  }
  sealRun(request: ExtractionRunSealRequest) {
    if (!this.ports.runs.seal) throw new Error('Extraction run sealing unavailable.');
    return this.ports.runs.seal(request);
  }
  source(snapshotId: string, version?: string) { return this.ports.evidence.read(snapshotId, version); }
  deleteSource(snapshotId: string): void { this.ports.evidence.delete(snapshotId); }
  entities(analysisId: string, revisionId?: string) {
    const history = this.ports.entities.read(analysisId);
    const revision = history.revisions.find(value => value.revisionId === (revisionId ?? history.writeHeadRevisionId));
    if (!revision) throw new Error('Entity analysis revision is missing.');
    return { history, revision, source: this.source(history.snapshotId, history.sourceVersion) };
  }
  private entityOrigin(history: ReturnType<EntityAnalysisStore['read']>, source: ReturnType<KnowledgeApplication['source']>) {
    if (source.status === 'available') return source.window.origin;
    try {
      const run = this.ports.runs.read(history.analysisId);
      return run.snapshotId === history.snapshotId && run.sourceVersion === history.sourceVersion ? run.origin : undefined;
    } catch { return undefined; }
  }
  private entityKnowledge() {
    try { return { status: 'available' as const, histories: this.ports.knowledge.list() }; }
    catch { return { status: 'unavailable' as const, histories: [] }; }
  }
  queryEntities(input: EntityQuery = {}) {
    const saved = this.ports.entities.list(); const knowledge = this.entityKnowledge();
    const byAnalysis = new Map<string, KnowledgeEnvelope[]>();
    for (const history of knowledge.histories) {
      const ref = history.grounding.find(value => value.revisionId === history.writeHeadRevisionId)?.entityAnalysisRef;
      if (ref) { const group = byAnalysis.get(ref.analysisId) ?? []; group.push(history); byAnalysis.set(ref.analysisId, group); }
    }
    const rows: EntitySearchRow[] = saved.histories.flatMap(history => {
      const revision = history.revisions.at(-1)!;
      const source = this.source(history.snapshotId, history.sourceVersion); const origin = this.entityOrigin(history, source);
      return revision.entities.map(entity => {
        const mentions = revision.mentions.filter(mention => mention.entityId === entity.entityId);
        const links = entityKnowledgeLinks(byAnalysis.get(history.analysisId) ?? [], history, entity.entityId);
        return { ...entity, analysisId: history.analysisId, revisionId: revision.revisionId, generation: history.generation,
          revisedAt: revision.revisedAt, mentionCount: mentions.length, surfaces: [...new Set(mentions.map(mention => mention.selection.quote))],
          sourceStatus: source.status, ...(origin ? { origin } : {}),
          knowledgeCount: knowledge.status === 'available' ? links.length : null,
          outdatedKnowledgeCount: knowledge.status === 'available' ? links.filter(link => !link.currentEntityRevision).length : null };
      });
    });
    return { ...queryEntityRows(rows, input), analysisCount: saved.histories.length, unavailableAnalyses: saved.unavailable, knowledgeStatus: knowledge.status };
  }
  entityDetail(analysisId: string, entityId: string, revisionId?: string) {
    const detail = this.entities(analysisId, revisionId);
    const entity = detail.revision.entities.find(value => value.entityId === entityId);
    if (!entity) throw new Error('Entity is absent from the selected revision.');
    const knowledge = this.entityKnowledge(); const origin = this.entityOrigin(detail.history, detail.source);
    const mentionChecks = detail.revision.mentions.filter(mention => mention.entityId === entityId).map(mention => ({ mentionId: mention.mentionId,
      positionStatus: detail.source.status === 'unavailable' ? 'unavailable' as const
        : validateEvidenceSelection(mention.selection, detail.source.window.excerpts).length ? 'mismatch' as const : 'matched' as const }));
    return { ...detail, entity, knowledge: entityKnowledgeLinks(knowledge.histories, detail.history, entityId),
      mentionChecks, knowledgeStatus: knowledge.status, ...(origin ? { origin } : {}) };
  }
  detail(knowledgeId: string, revisionId?: string) {
    const history = this.ports.knowledge.read(knowledgeId);
    const selected = revisionId ?? history.writeHeadRevisionId;
    const revision = history.revisions.find((item) => item.revisionId === selected);
    const grounding = history.grounding.find((item) => item.revisionId === selected);
    if (!revision || !grounding) throw new Error('Knowledge revision is missing.');
    const entityAnalysis = grounding.entityAnalysisRef ? (() => {
      try { return { status: 'available' as const, ...this.entities(grounding.entityAnalysisRef!.analysisId, grounding.entityAnalysisRef!.revisionId) }; }
      catch { return { status: 'unavailable' as const, reason: 'analysis_unavailable' as const }; }
    })() : undefined;
    return {
      history, revision, grounding, reviewStatus: 'pending' as const,
      tagging: this.ports.tags.read(knowledgeId),
      maintenance: history.maintenance.filter((entry) => entry.revisionId === selected).at(-1) ?? null,
      sources: grounding.sourceBindings.map((binding) => this.source(binding.snapshotId, binding.sourceVersion)),
      ...(entityAnalysis ? { entityAnalysis } : {}),
    };
  }
  tag(knowledgeId: string, generation: number, tags: unknown) {
    this.ports.knowledge.read(knowledgeId);
    return this.ports.tags.write(knowledgeId, generation, tags, this.ports.actor);
  }
  /** Authenticate source-only A before the private driver constructs and reserves B. */
  discoveredEntitiesContext(source: DiscoveredEntitiesSource, model: EntityDiscoveryModel, references: DiscoveredEntitiesContextReferences) {
    return readDiscoveredEntitiesContext(this.ports, source, model, references);
  }
  /** Two originals produce one initial analysis; neither stage is an ordinary extraction run. */
  importDiscoveredEntities(source: DiscoveredEntitiesSource, model: EntityDiscoveryModel,
    references: DiscoveredEntitiesReferences, signal?: AbortSignal) {
    return importDiscoveredEntityAnalysis(this.ports, source, model, references, signal);
  }
  /** Read the authentic current plan/A/B chain and prepare one private A′ task, without invoking it. */
  refinedEntitiesContext(source: RefinedEntitiesSource, model: RefinedEntitiesModel, references: RefinedEntitiesBaseReferences) {
    return readRefinedEntitiesContext(this.ports, source, model, references);
  }
  /** Re-authenticate the base and A′ before the private driver reserves B′. */
  refinedEntitiesRebindingContext(source: RefinedEntitiesSource, model: RefinedEntitiesModel, references: RefinedEntitiesContextReferences) {
    return readRefinedEntitiesRebindingContext(this.ports, source, model, references);
  }
  /** Five originals produce one independent initial analysis, never a revision of the original B result. */
  importRefinedEntities(source: RefinedEntitiesSource, model: RefinedEntitiesModel,
    references: RefinedEntitiesReferences, signal?: AbortSignal) {
    return importRefinedEntityAnalysis(this.ports, source, model, references, signal);
  }
  /** Reads the authentic immutable E revision for a separate K invocation; this method never invokes a model. */
  boundKnowledgeContext(entityRunId: string, model: ExtractionModel, profile: ExtractionPromptProfile) {
    return readEntityFirstKnowledgeContext(this.ports, entityRunId, model, profile);
  }
  /** Two originals authenticate the persisted initial revision; no extraction run, SP or native call is created. */
  discoveredBoundKnowledgeContext(source: DiscoveredEntitiesSource, model: EntityDiscoveryModel, references: DiscoveredEntitiesReferences) {
    return readDiscoveredEntitiesKnowledgeContext(this.ports, source, model, references);
  }
  /** Explicit A→B→actual E→K handoff with the unchanged per-proposal publisher. */
  importDiscoveredBoundKnowledge(source: DiscoveredEntitiesSource, model: EntityDiscoveryModel,
    references: DiscoveredEntitiesReferences, reference: BoundKnowledgeReference, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.ports.boundKnowledgeArchive) throw new Error('Bound knowledge archive unavailable.');
    const context = this.discoveredBoundKnowledgeContext(source, model, references);
    const evidence = readBoundKnowledgeEvidence(context.window, context.catalog, model, reference, this.ports.boundKnowledgeArchive);
    const ids = [context.discovery.receipt, context.binding.receipt, evidence.receipt]
      .flatMap(receipt => [receipt.receiptId, receipt.attemptId]);
    if (new Set(ids).size !== ids.length) throw new Error('Discovered knowledge successor reuses a predecessor receipt or attempt identity.');
    if (Date.parse(evidence.receipt.startedAt) < Date.parse(context.entityFinishedAt)) {
      throw new Error('Discovered knowledge successor predates predecessor completion.');
    }
    return this.publishBoundKnowledge({ entityChainDigest: context.chainDigest }, context.window, context.catalog, evidence, signal);
  }
  /** Five originals authenticate the persisted initial revision; no extraction run or native call is created. */
  refinedBoundKnowledgeContext(source: RefinedEntitiesSource, model: RefinedEntitiesModel, references: RefinedEntitiesReferences) {
    return readRefinedEntitiesKnowledgeContext(this.ports, source, model, references);
  }
  /** Explicit private K handoff from a complete catalog revision, with the existing per-proposal writer. */
  importRefinedBoundKnowledge(source: RefinedEntitiesSource, model: RefinedEntitiesModel,
    references: RefinedEntitiesReferences, reference: BoundKnowledgeReference, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.ports.boundKnowledgeArchive) throw new Error('Bound knowledge archive unavailable.');
    const context = this.refinedBoundKnowledgeContext(source, model, references);
    const evidence = readBoundKnowledgeEvidence(context.window, context.catalog, model, reference, this.ports.boundKnowledgeArchive);
    this.assertRefinedSuccessor(context, evidence.receipt);
    return this.publishBoundKnowledge({ entityChainDigest: context.chainDigest }, context.window, context.catalog, evidence, signal);
  }
  /** Import an archived K-only return. Replaying after interruption reuses store request IDs, without another native call. */
  importBoundKnowledge(entityRunId: string, model: ExtractionModel, profile: ExtractionPromptProfile,
    reference: BoundKnowledgeReference, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.ports.boundKnowledgeArchive) throw new Error('Bound knowledge archive unavailable.');
    const { window, catalog, entityFinishedAt } = this.boundKnowledgeContext(entityRunId, model, profile);
    const evidence = readBoundKnowledgeEvidence(window, catalog, model, reference, this.ports.boundKnowledgeArchive);
    if (Date.parse(evidence.receipt.startedAt) < Date.parse(entityFinishedAt)) {
      throw new Error('Bound knowledge native task predates entity-task completion.');
    }
    return this.publishBoundKnowledge({ entityRunId }, window, catalog, evidence, signal);
  }
  /** Authenticate R against the complete immutable E revision; uncertain remains an AI claim, never human confirmation. */
  reviewedKnowledgeContext(entityRunId: string, model: ExtractionModel, profile: ExtractionPromptProfile, review: EntityReviewSelection) {
    const context = this.boundKnowledgeContext(entityRunId, model, profile);
    return this.readEntityReview(context, review);
  }
  /** The review consumes the final persisted catalog; all five original task identities remain authenticated. */
  refinedReviewedKnowledgeContext(source: RefinedEntitiesSource, model: RefinedEntitiesModel,
    references: RefinedEntitiesReferences, review: EntityReviewSelection) {
    const context = this.refinedBoundKnowledgeContext(source, model, references);
    const reviewed = this.readEntityReview(context, review);
    this.assertRefinedSuccessor(context, reviewed.entityReviewEvidence.receipt);
    return reviewed;
  }
  private readEntityReview<T extends { window: EvidenceWindow; catalog: BoundKnowledgeCatalog; entityFinishedAt: string }>(
    context: T, review: EntityReviewSelection) {
    if (!this.ports.entityReviewArchive) throw new Error('Entity review archive unavailable.');
    const evidence = readEntityReviewEvidence(context.window, context.catalog, review.model,
      review.reference, this.ports.entityReviewArchive);
    if (Date.parse(evidence.receipt.startedAt) < Date.parse(context.entityFinishedAt)) {
      throw new Error('Entity review native task predates entity-task completion.');
    }
    if (evidence.checked.status !== 'checked') throw new Error('Entity review failed structure or binding; no knowledge context is available.');
    return { ...context, entityReviewEvidence: evidence, entityReview: { receiptId: evidence.receipt.receiptId,
      receiptRef: evidence.receiptRef, nativeRef: evidence.receipt.nativeRef, rawOutput: evidence.rawOutput } };
  }
  /** The actual import authenticates both stages and applies the ID policy before the existing knowledge writer. */
  importReviewedKnowledge(entityRunId: string, model: ExtractionModel, profile: ExtractionPromptProfile,
    review: EntityReviewSelection, reference: ReviewedKnowledgeReference, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.ports.reviewedKnowledgeArchive) throw new Error('Reviewed knowledge archive unavailable.');
    const context = this.reviewedKnowledgeContext(entityRunId, model, profile, review);
    const evidence = readReviewedKnowledgeEvidence(context.window, context.catalog, context.entityReview, model,
      reference, this.ports.reviewedKnowledgeArchive);
    if (Date.parse(evidence.receipt.startedAt) < Date.parse(context.entityReviewEvidence.receipt.finishedAt)) {
      throw new Error('Reviewed knowledge native task predates entity-review completion.');
    }
    return { ...this.publishBoundKnowledge({ entityRunId }, context.window, context.catalog, evidence, signal),
      entityReviewEvidence: context.entityReviewEvidence };
  }
  /** Re-authenticate the complete chain, review and K before publishing; replay never invokes a model. */
  importRefinedReviewedKnowledge(source: RefinedEntitiesSource, model: RefinedEntitiesModel, references: RefinedEntitiesReferences,
    review: EntityReviewSelection, reference: ReviewedKnowledgeReference, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.ports.reviewedKnowledgeArchive) throw new Error('Reviewed knowledge archive unavailable.');
    const context = this.refinedReviewedKnowledgeContext(source, model, references, review);
    const evidence = readReviewedKnowledgeEvidence(context.window, context.catalog, context.entityReview, model,
      reference, this.ports.reviewedKnowledgeArchive);
    this.assertRefinedSuccessor(context, evidence.receipt, context.entityReviewEvidence.receipt);
    return { ...this.publishBoundKnowledge({ entityChainDigest: context.chainDigest }, context.window, context.catalog, evidence, signal),
      entityReviewEvidence: context.entityReviewEvidence };
  }
  private assertRefinedSuccessor(context: ReturnType<typeof readRefinedEntitiesKnowledgeContext>,
    receipt: { receiptId: string; attemptId: string; startedAt: string },
    review?: { receiptId: string; attemptId: string; finishedAt: string }) {
    const predecessors = [context.base.sourcePlan.receipt, context.base.discovery.receipt, context.base.binding.receipt,
      context.refinement.receipt, context.rebinding.receipt, ...(review ? [review] : [])];
    const ids = [...predecessors, receipt].flatMap(value => [value.receiptId, value.attemptId]);
    if (new Set(ids).size !== ids.length) {
      throw new Error('Refined knowledge successor reuses a predecessor receipt or attempt identity.');
    }
    if (Date.parse(receipt.startedAt) < Date.parse(review?.finishedAt ?? context.entityFinishedAt)) {
      throw new Error('Refined knowledge successor predates predecessor completion.');
    }
  }
  private publishBoundKnowledge<T extends { checked: CheckedBoundKnowledge;
    receipt: { receiptId: string; request: { executor: string }; finishedAt: string } },
    P extends { entityRunId: string } | { entityChainDigest: string }>(predecessor: P,
    window: EvidenceWindow, catalog: BoundKnowledgeCatalog, evidence: T, signal?: AbortSignal) {
    const shared = { entityIds: new Map(catalog.entities.map(entity => [entity.entityId, entity.entityId])),
      mentionIds: new Map(catalog.mentions.map(mention => [mention.mentionId, mention.mentionId])),
      ref: { analysisId: catalog.analysisId, revisionId: catalog.revisionId } };
    const common = { evidence, ...predecessor, entityAnalysisRef: shared.ref, semanticStatus: 'not_reviewed' as const };
    const checked = evidence.checked;
    if (checked.status === 'rejected') return { ...common, admissionStatus: 'rejected' as const,
      proposalAdmissionStatus: 'rejected' as const, coverageStatus: 'unavailable' as const, committed: [] };
    const actor: KnowledgeActor = { actorKind: 'agent', actorId: `extractor:${evidence.receipt.request.executor}`,
      executionRef: evidence.receipt.receiptId };
    const intents = checked.accepted.map(proposal => {
      const ids = boundKnowledgeIntentIds(evidence.receipt.receiptId, proposal.proposalId);
      let next = 0;
      return this.intent(proposal, window, actor, shared, { id: () => {
        if (next >= ids.length) throw new Error('Bound knowledge import identity contract changed.');
        return ids[next++];
      }, now: () => evidence.receipt.finishedAt });
    });
    for (const intent of intents) {
      signal?.throwIfAborted();
      this.ports.knowledge.write({ requestId: intent.requestId, knowledgeId: intent.revision.knowledgeId,
        expectedGeneration: 0, commandKind: 'append_revision', expectedHeadRevisionId: null,
        revision: intent.revision, grounding: intent.grounding }, actor);
    }
    // Closed model declarations are not source coverage or semantic acceptance.
    const coverageStatus = checked.accounting.status === 'has_issues' || checked.accounting.unresolvedMaterialIds.length
      || checked.accounting.unresolvedCatalogGapIds.length ? 'unresolved' as const : 'declared_only' as const;
    const proposalAdmissionStatus = checked.rejected.length
      ? checked.accepted.length ? 'partial' as const : 'rejected' as const : 'admitted' as const;
    return { ...common, proposalAdmissionStatus, coverageStatus,
      admissionStatus: checked.rejected.length || coverageStatus === 'unresolved' ? 'partial' as const : 'admitted' as const,
      committed: intents.map((intent, index) => ({ proposalId: checked.accepted[index].proposalId,
        knowledgeId: intent.revision.knowledgeId, revisionId: intent.revision.revisionId })) };
  }
  async generate(snapshotId: string, model: ExtractionModel, runId = this.ports.id(), signal?: AbortSignal,
    options?: ExtractionGenerationOptions): Promise<ExtractionRun> {
    const policy = ExtractionGenerationPolicySchema.parse(options?.policy ?? SINGLE_EXTRACTION_POLICY);
    if (options?.coverageReview && options.sourceSemanticPlan) throw new Error('Extraction research input tasks are mutually exclusive.');
    if ((options?.coverageReview || options?.sourceSemanticPlan) && policy.policyId !== SINGLE_EXTRACTION_POLICY.policyId) {
      throw new Error('Extraction research inputs require a separate single-invocation research run.');
    }
    if (options?.promptProfile && isEntityOnlyTask(options.promptProfile.promptVersion)) {
      extractionPrompt(model, options.promptProfile);
      if (policy.policyId !== SINGLE_EXTRACTION_POLICY.policyId || options.coverageReview || options.sourceSemanticPlan
        || model.outputMode !== 'json-schema' || model.wireId !== WINDOW_EXTRACTION_WIRE_ID) {
        throw new Error('Entity-only extraction requires its fixed structured source-only single-invocation task.');
      }
    }
    if (policy.policyId === 'knowledge-generation-bounded/v1') return this.generateBounded(snapshotId, model, runId, policy, signal, options);
    signal?.throwIfAborted();
    const source = this.source(snapshotId);
    if (source.status !== 'available') throw new Error(`Source unavailable: ${source.reason}`);
    const window = source.window;
    const { system, promptVersion } = extractionPrompt(model, options?.promptProfile);
    // Review is an explicit, versioned input task. Previous output never becomes source evidence.
    const input = options?.coverageReview
      ? this.coverageReviewInput(window, model, system, promptVersion, options.coverageReview.previousRunId, runId)
      : options?.sourceSemanticPlan ? this.sourcePlannedInput(window, model, system, promptVersion, options.sourceSemanticPlan)
        : extractionTaskInput(window, promptVersion);
    const requestDigest = this.ports.hash({ snapshotId, sourceVersion: window.sourceVersion, executor: model.executor, model: model.model,
      promptHash: this.ports.hash(system), inputDigest: this.ports.hash(input), actor: this.ports.actor,
      policy: SINGLE_EXTRACTION_POLICY, outputMode: model.outputMode ?? 'prompt-json', wireId: model.wireId ?? null,
      timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
    const reuse = (previous: ExtractionRun) => {
      if (previous.requestDigest !== requestDigest || previous.promptVersion !== promptVersion) throw new Error('Extraction request identity conflict.');
      return this.settleRun(runId, signal, false, options?.onOutcomeArchived);
    };
    // Current-format receipts may predate this capacity policy. Reuse them without a fresh call.
    let previous: ExtractionRun | undefined;
    try { previous = this.ports.runs.read(runId); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous) return reuse(previous);
    assertExtractionInputCapacity(input, system);
    if (this.heldOutcome || this.invocationInFlight) throw new Error('An extraction invocation or outcome archive is pending. Resume that run before starting another invocation.');
    const { producer, ...request } = extractionExecution(model, system, input);
    const startedAt = this.ports.now(), attemptId = this.ports.id();
    const run: ExtractionRun = {
      runKind: 'knowledge-extraction-run', schemaVersion: 5,
      runId, requestDigest, generation: 1, snapshotId, sourceVersion: window.sourceVersion,
      ...(window.origin ? { origin: window.origin } : {}), executor: model.executor, model: model.model,
      promptVersion, promptHash: this.ports.hash(system), inputDigest: this.ports.hash(input),
      actor: this.ports.actor, startedAt, status: 'generating', policy: SINGLE_EXTRACTION_POLICY,
      attempts: [ExtractionAttemptSchema.parse({ attemptId, startedAt, request, producer,
        requestDigest: extractionRequestDigest({ requestDigest, request, producer, policy: SINGLE_EXTRACTION_POLICY }) })],
      intents: [], rejections: [], committed: [], entityRejections: [],
    };
    // Only the exclusive creation winner may invoke. Reopening a started run never grants a new effect.
    try { this.ports.runs.create(run); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return reuse(this.ports.runs.read(runId));
    }
    this.invocationInFlight = runId;
    try {
      let called = false;
      const outcome = await invokeExtractionModel(model, system, input, signal, () => {
        signal?.throwIfAborted();
        if (called) throw new Error('Extraction dispatch gate was already consumed.');
        called = true; options?.beforeDispatch?.({ runId, attemptId, requestDigest: run.attempts[0].requestDigest });
      });
      this.heldOutcome = { runId, attemptId, outcome, maxBytes: producer.maxOutcomeJsonBytes };
      return this.settleRun(runId, signal, false, options?.onOutcomeArchived);
    } finally { this.invocationInFlight = undefined; }
  }
  private sourcePlannedInput(window: EvidenceWindow, model: ExtractionModel, system: string, promptVersion: string,
    reference: SourcePlanReference): string {
    if (model.outputMode !== 'json-schema' || model.wireId !== WINDOW_EXTRACTION_WIRE_ID
      || system !== STRICT_EXTRACTION_PROMPT || promptVersion !== 'knowledge-extraction-v30'
      || promptVersion !== STRICT_EXTRACTION_PROMPT_VERSION) {
      throw new Error('Source-planned extraction requires the unchanged strict30 structured task.');
    }
    if (!this.ports.sourcePlanArchive) throw new Error('Source semantic plan archive is unavailable.');
    return buildSourcePlannedExtractionInput(window, readSourcePlanEvidence(window, model, reference, this.ports.sourcePlanArchive));
  }
  private coverageReviewInput(window: EvidenceWindow, model: ExtractionModel, system: string, promptVersion: string,
    previousRunId: string, runId: string): string {
    if (previousRunId === runId || model.outputMode !== 'json-schema' || model.wireId !== WINDOW_EXTRACTION_WIRE_ID
      || system !== STRICT_EXTRACTION_PROMPT || promptVersion !== 'knowledge-extraction-v30'
      || promptVersion !== STRICT_EXTRACTION_PROMPT_VERSION) {
      throw new Error('Coverage review requires the unchanged strict30 structured task and a distinct predecessor.');
    }
    // Read through the archive-validating store, rather than accepting caller-supplied raw or a manifest projection.
    const previous = this.ports.runs.read(previousRunId);
    const attempt = previous.attempts[0];
    if (!['completed', 'failed'].includes(previous.status) || previous.policy.policyId !== SINGLE_EXTRACTION_POLICY.policyId
      || previous.snapshotId !== window.snapshotId || previous.sourceVersion !== window.sourceVersion
      || previous.inputDigest !== this.ports.hash(extractionModelInput(window))
      || attempt.request.inputDigest !== `sha256:${createHash('sha256').update(extractionModelInput(window), 'utf8').digest('hex')}`
      || previous.promptHash !== this.ports.hash(system) || previous.promptVersion !== promptVersion
      || attempt.request.systemDigest !== `sha256:${createHash('sha256').update(system, 'utf8').digest('hex')}`
      || previous.executor !== model.executor || previous.model !== model.model
      || attempt.request.outputMode !== model.outputMode || attempt.request.wireId !== model.wireId
      || attempt.request.timeoutMs !== (model.timeoutMs ?? 300_000)
      || attempt.request.maxOutputTokens !== model.maxOutputTokens
      || previous.selectedAttemptId !== attempt.attemptId || !attempt.outcome) {
      throw new Error('Coverage review predecessor differs from the frozen source-only first task or execution configuration.');
    }
    const archived = this.ports.runs.readOutcome(previous.runId, attempt.attemptId, attempt.outcome);
    const outcome = archived.outcome;
    if (outcome.outcomeKind !== 'result' || outcome.cleanupFailure || outcome.result.ok !== true || typeof outcome.result.output !== 'string'
      || outcome.result.output !== previous.rawOutput || outcome.result.refusal !== undefined
      || Array.isArray(outcome.result.toolCalls) && outcome.result.toolCalls.length > 0) {
      throw new Error('Coverage review requires the complete archived native assistant output.');
    }
    return buildExtractionCoverageReviewInput(window, { runId: previous.runId, attemptId: attempt.attemptId,
      outcomeRef: archived.ref, snapshotId: previous.snapshotId, sourceVersion: previous.sourceVersion,
      rawOutput: outcome.result.output });
  }
  resume(runId: string, signal?: AbortSignal): ExtractionRun {
    return this.settleRun(runId, signal);
  }
  private settleRun(runId: string, signal?: AbortSignal, retryOwner = false,
    onOutcomeArchived?: ExtractionGenerationOptions['onOutcomeArchived']): ExtractionRun {
    let run = this.ports.runs.read(runId);
    let heldRecorded: ReturnType<ExtractionRunStore['readOutcome']> | undefined;
    if (this.heldOutcome?.runId === runId) {
      const held = this.heldOutcome;
      // Representation/archive failures retain the held return value; they are not executor exceptions.
      const outcome = serializeExtractionObservation(held.outcome) as unknown as ExtractionOutcome;
      const ref = this.ports.runs.writeOutcome(runId, held.attemptId, outcome, held.maxBytes);
      heldRecorded = { outcome, ref };
      if (!run.attempts.find(attempt => attempt.attemptId === held.attemptId)!.outcome) run = this.saveRun(run, {
        attempts: run.attempts.map(attempt => attempt.attemptId === held.attemptId ? { ...attempt, outcome: ref } : attempt) });
      else this.ports.runs.save(run, run.generation - 1);
      this.heldOutcome = undefined;
      onOutcomeArchived?.({ runId, attemptId: held.attemptId, outcome, ref });
    }
    if (run.policy.policyId === 'knowledge-generation-bounded/v1') return this.settleBounded(run, signal, retryOwner);
    if (run.status === 'completed' || run.attempts[0].failure) return run;
    if (run.status !== 'prepared') {
      const attempt = run.attempts[0];
      let recorded: ReturnType<ExtractionRunStore['readOutcome']>;
      if (heldRecorded) recorded = heldRecorded;
      else {
        try { recorded = this.ports.runs.readOutcome(runId, attempt.attemptId, attempt.outcome); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !attempt.outcome) return run; throw error; }
      }
      if (!attempt.outcome) run = this.saveRun(run, { attempts: [{ ...attempt, outcome: recorded.ref }] });
      const result = extractionOutcomeResult(recorded.outcome);
      const fields = result as unknown as Record<string, unknown> | undefined;
      const metric = (key: string) => { const value = fields?.[key]; return typeof value === 'number' && Number.isFinite(value) ? value : undefined; };
      const flag = (key: string) => { const value = fields?.[key]; return typeof value === 'boolean' ? value : undefined; };
      const runtime = result && metric('durationMs') !== undefined ? { durationMs: metric('durationMs')!,
        ...(metric('durationApiMs') === undefined ? {} : { durationApiMs: metric('durationApiMs') }),
        ...(flag('tokenUsageReportedByExecutor') === undefined ? {} : { tokenUsageReportedByExecutor: flag('tokenUsageReportedByExecutor') }),
        ...(flag('costReportedByExecutor') === undefined ? {} : { costReportedByExecutor: flag('costReportedByExecutor') }),
        ...Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']
          .filter(key => flag('tokenUsageReportedByExecutor') !== false && metric(key) !== undefined).map(key => [key, metric(key)])),
        ...(flag('costReportedByExecutor') === false || metric('costUSD') === undefined ? {} : { costUSD: metric('costUSD') }),
      } : undefined;
      const rawOutput = result && typeof result.output === 'string' && result.output.length <= 2 * 1024 * 1024 ? result.output : undefined;
      if (run.selectedAttemptId === undefined && (runtime || rawOutput !== undefined)) {
        run = this.saveRun(run, { ...(runtime ? { runtime } : {}), ...(rawOutput === undefined ? {} : { rawOutput, selectedAttemptId: attempt.attemptId }) });
      }
      const decoded = extractionResponse(recorded.outcome, attempt.request.outputMode, attempt.request.wireId);
      if (decoded.status === 'failed') {
        const failure = { ...decoded.failure, diagnostic: decoded.failure.diagnostic.slice(0, 4096) };
        return this.saveRun(run, { status: signal?.aborted ? 'cancelled' : 'failed', finishedAt: this.ports.now(), error: failure.diagnostic,
          attempts: [{ ...run.attempts[0], failure }] });
      }
      if (signal?.aborted) return run.status === 'cancelled' ? run : this.saveRun(run, { status: 'cancelled', finishedAt: this.ports.now(), error: 'Extraction cancelled after outcome archive.' });
      const source = this.source(run.snapshotId, run.sourceVersion);
      if (source.status !== 'available') throw new Error(`Source unavailable: ${source.reason}`);
      const taskViolation = entityOnlyTaskViolation(run, source.window, decoded.response, value => this.ports.hash(value));
      if (taskViolation) return this.failEntityOnlyTask(run, taskViolation);
      try { run = this.prepare(run, source.window, decoded.response,
        decoded.wireDiagnostic ? { wireId: decoded.wireDiagnostic.wireId, wireStatus: decoded.wireDiagnostic.wireStatus,
          itemFailureCount: decoded.wireDiagnostic.itemFailures.length } : undefined); } catch (error) {
        // Store failures preserve the acknowledged native artifact and do not become another model invocation.
        const invalidEnvelope = error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError');
        const capacity = error instanceof Error && /capacity|exceeds/i.test(error.message);
        if (invalidEnvelope || capacity) {
          const diagnostic = capacity ? 'Extraction application intent exceeds storage capacity; original outcome remains archived.' : 'Extraction response envelope was rejected.';
          return this.saveRun(run, { status: 'failed', finishedAt: this.ports.now(), error: diagnostic,
            attempts: [{ ...run.attempts[0], failure: { failureKind: capacity ? 'capacity' : 'envelope_error', diagnostic } }] });
        }
        throw error;
      }
    }
    if (run.status !== 'prepared') return run;
    signal?.throwIfAborted();
    const taskViolation = this.entityOnlyCommitViolation(run);
    if (taskViolation) return this.failEntityOnlyTask(run, taskViolation);
    this.ports.entities.write(run.entityAnalysis!, run.entityAnalysis!.revision.revisedBy);
    for (const intent of run.intents) {
      signal?.throwIfAborted();
      this.ports.knowledge.write({
        requestId: intent.requestId, knowledgeId: intent.revision.knowledgeId, expectedGeneration: 0,
        commandKind: 'append_revision', expectedHeadRevisionId: null, revision: intent.revision, grounding: intent.grounding,
      }, intent.revision.revisedBy);
    }
    run = this.saveRun(run, { status: 'completed', finishedAt: this.ports.now(),
      committed: run.intents.map((intent) => ({ knowledgeId: intent.revision.knowledgeId, revisionId: intent.revision.revisionId })) });
    return run;
  }
  private failEntityOnlyTask(run: ExtractionRun, diagnostic: string): ExtractionRun {
    return this.saveRun(run, { status: 'failed', finishedAt: this.ports.now(), error: diagnostic,
      attempts: run.attempts.map((attempt, index) => index === 0
        ? { ...attempt, failure: { failureKind: 'entity_only_task_violation', diagnostic } } : attempt) });
  }
  private entityOnlyCommitViolation(run: ExtractionRun): string | undefined {
    if (!isEntityOnlyTask(run.promptVersion)) return;
    const source = this.source(run.snapshotId, run.sourceVersion);
    if (source.status !== 'available') throw new Error(`Source unavailable: ${source.reason}`);
    const attempt = run.attempts[0];
    const { outcome } = this.ports.runs.readOutcome(run.runId, attempt.attemptId, attempt.outcome);
    const decoded = extractionResponse(outcome, attempt.request.outputMode, attempt.request.wireId);
    if (decoded.status === 'failed') return 'Entity-only extraction prepared state has no valid archived task response; no entity or knowledge admission is allowed.';
    if (run.rawOutput !== decoded.rawOutput) return 'Entity-only extraction prepared state differs from its original archived output; no entity or knowledge admission is allowed.';
    return entityOnlyTaskViolation(run, source.window, decoded.response, value => this.ports.hash(value));
  }
  private async generateBounded(snapshotId: string, model: ExtractionModel, runId: string, policy: ExtractionBoundedPolicy,
    signal?: AbortSignal, options?: ExtractionGenerationOptions): Promise<ExtractionRun> {
    signal?.throwIfAborted();
    const source = this.source(snapshotId);
    if (source.status !== 'available') throw new Error(`Source unavailable: ${source.reason}`);
    const window = source.window, initialInput = extractionModelInput(window);
    const { system, promptVersion } = extractionPrompt(model, options?.promptProfile);
    const requestDigest = this.ports.hash({ snapshotId, sourceVersion: window.sourceVersion, executor: model.executor, model: model.model,
      promptHash: this.ports.hash(system), inputDigest: this.ports.hash(initialInput), actor: this.ports.actor,
      policy, outputMode: model.outputMode ?? 'prompt-json', wireId: model.wireId ?? null,
      timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
    const reuse = (previous: ExtractionRun) => {
      if (previous.requestDigest !== requestDigest || previous.promptVersion !== promptVersion) throw new Error('Extraction request identity conflict.');
      return this.resume(runId, signal);
    };
    let previous: ExtractionRun | undefined;
    try { previous = this.ports.runs.read(runId); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) return reuse(previous);
    if (this.heldOutcome || this.invocationInFlight) throw new Error('An extraction invocation or outcome archive is pending. Resume that run before starting another invocation.');
    const makeAttempt = (input: string, trigger?: ExtractionRun['attempts'][number]['trigger']) => {
      assertExtractionInputCapacity(input, system);
      const { producer, ...request } = extractionExecution(model, system, input);
      const proof = producer.proof as Record<string, unknown> | null;
      if (model.executor !== 'openai-api' || model.dispatchGate !== 'producer-before-dispatch/v1'
        || request.outputMode !== 'json-schema' || request.maxOutputTokens !== policy.maxOutputTokens
        || producer.producerId !== 'openai-chat-archive/v1' || proof?.proofKind !== 'openai-chat-return-bound/v1'
        || proof.dispatchGate !== 'producer-before-dispatch/v1' || proof.singleCompletion !== true || proof.stream !== false
        || proof.redirect !== 'error' || typeof proof.endpoint !== 'string') {
        throw new Error('Bounded generation requires a verified single-completion API producer and a hard output-token cap.');
      }
      const profile = resolveTokenBudgetProfile(policy.profileId, model.model, proof.endpoint);
      if (policy.maxOutputTokens > profile.outputUpperBound) throw new Error('Output-token limit exceeds the verified budget profile.');
      const budget = ExtractionBudgetReservationSchema.parse({ ...profile, outputUpperBound: policy.maxOutputTokens,
        tokensReserved: profile.inputUpperBound + policy.maxOutputTokens });
      if (budget.tokensReserved > policy.maxTotalTokens) throw new Error('Token budget cannot reserve one invocation; no request allowed.');
      return ExtractionAttemptSchema.parse({ attemptId: this.ports.id(), startedAt: this.ports.now(), request, producer, budget,
        ...(trigger ? { trigger } : {}), requestDigest: extractionRequestDigest({ requestDigest, request, producer, policy, budget, trigger: trigger ?? null }) });
    };
    const first = makeAttempt(initialInput);
    let run: ExtractionRun = { runKind: 'knowledge-extraction-run', schemaVersion: 5, runId, requestDigest, generation: 1,
      snapshotId, sourceVersion: window.sourceVersion, ...(window.origin ? { origin: window.origin } : {}), executor: model.executor, model: model.model,
      promptVersion, promptHash: this.ports.hash(system), inputDigest: this.ports.hash(initialInput), actor: this.ports.actor,
      startedAt: this.ports.now(), status: 'generating', policy, attempts: [first], intents: [], rejections: [], committed: [], entityRejections: [] };
    try { this.ports.runs.create(run); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return reuse(this.ports.runs.read(runId));
    }
    // Only this creation winner owns this sequence. Recovery never creates another paid effect.
    this.invocationInFlight = runId;
    let input = initialInput;
    try {
      for (;;) {
        const attempt = run.attempts.at(-1)!;
        if (attempt.trigger) {
          const delay = Math.max(0, Date.parse(attempt.trigger.notBefore) - this.generationNow());
          try {
            if (this.ports.generationTiming) await this.ports.generationTiming.wait(delay, signal);
            else await wait(delay, undefined, { signal });
            signal?.throwIfAborted();
          } catch (error) {
            if (!signal?.aborted) throw error;
            return this.saveRun(this.ports.runs.read(runId), { status: 'cancelled', finishedAt: this.ports.now(), error: 'Extraction cancelled during retry backoff.' });
          }
        }
        let called = false, hostDenied = false;
        const outcome = await invokeExtractionModel(model, system, input, signal, () => {
          try {
            signal?.throwIfAborted();
            if (called) throw new Error('Extraction dispatch gate was already consumed.');
            called = true;
            options?.beforeDispatch?.({ runId, attemptId: attempt.attemptId, requestDigest: attempt.requestDigest, budget: attempt.budget });
          } catch (error) { hostDenied = true; throw error; }
        });
        this.heldOutcome = { runId, attemptId: attempt.attemptId, outcome, maxBytes: attempt.producer.maxOutcomeJsonBytes };
        run = this.settleRun(runId, signal, !hostDenied && called, options?.onOutcomeArchived);
        if (run.status !== 'generating' || run.selectedAttemptId) return run;
        const retry = this.retryTrigger(run);
        if (!retry) return this.settleRun(runId, signal);
        if (retry.triggerKind === 'validation') {
          const last = run.attempts.at(-1)!;
          const diagnostics = [...(last.admission?.entityRejections ?? []).map(value => ({ component: value.component, index: value.index, reasons: value.reasons })),
            ...(last.admission?.rejections ?? []).map(value => ({ component: 'proposal', index: value.index, reasons: value.reasons }))];
          const body = JSON.stringify({ instruction: EXTRACTION_FEEDBACK_PREAMBLE,
            failureCode: last.failure?.failureKind ?? 'empty_validation', diagnostics: diagnostics.slice(0, 12).map(value => ({
              component: value.component, index: value.index,
              codes: value.reasons.slice(0, 6).map(reason => reason.split(':')[0].replace(/[^a-z_]/g, '').slice(0, 48)) })) });
          retry.feedback = { feedbackVersion: policy.feedbackVersion, body, digest: extractionRequestDigest({ body }) };
          input = JSON.stringify({ ...JSON.parse(initialInput), feedback: { feedbackVersion: policy.feedbackVersion, ...JSON.parse(body) } });
        }
        let next: ExtractionRun['attempts'][number];
        try { next = makeAttempt(input, retry); }
        catch (error) {
          if (!(error instanceof ExtractionInputCapacityError)) throw error;
          return this.saveRun(run, { status: 'failed', finishedAt: this.ports.now(), error: error.message });
        }
        // A resume in another host may already have selected/committed. CAS never grants that host a second effect.
        run = this.saveRun(run, { attempts: [...run.attempts, next], status: 'generating', finishedAt: undefined, error: undefined });
      }
    } finally { this.invocationInFlight = undefined; }
  }
  private generationNow(): number { return this.ports.generationTiming?.now() ?? Date.now(); }
  private retryTrigger(run: ExtractionRun, eligibilityOnly = false): ExtractionRun['attempts'][number]['trigger'] | undefined {
    const policy = run.policy;
    if (policy.policyId !== 'knowledge-generation-bounded/v1' || run.status !== 'generating' || run.selectedAttemptId
      || run.attempts.length >= policy.maxInvocations) return;
    const last = run.attempts.at(-1)!;
    if (!last.outcome || !last.accounting || last.accounting.status === 'policy_violation' || !last.budget
      || run.attempts.reduce((sum, attempt) => sum + attempt.budget!.tokensReserved, 0) + last.budget.tokensReserved > policy.maxTotalTokens) return;
    const transient = !!last.failure && TRANSIENT_EXTRACTION_FAILURES.has(last.failure.failureKind);
    const validation = !!last.failure && REASK_EXTRACTION_FAILURES.has(last.failure.failureKind)
      || !!last.admission && last.admission.entityCount === 0 && last.admission.proposalCount === 0
        && (last.admission.entityRejections.length + last.admission.rejections.length > 0 || last.wireDiagnostic?.wireStatus === 'item_failures');
    if (!transient && (!validation || run.attempts.filter(attempt => attempt.trigger?.triggerKind === 'validation').length >= policy.maxReasks)) return;
    const archived = this.ports.runs.readOutcome(run.runId, last.attemptId, last.outcome).outcome;
    const nativeFailure = archived.outcomeKind === 'result' ? archived.result.failure : undefined;
    const retryAfter = nativeFailure && typeof nativeFailure === 'object' && !Array.isArray(nativeFailure) ? nativeFailure.retryAfterMs : undefined;
    if (retryAfter !== undefined && (typeof retryAfter !== 'number' || !Number.isSafeInteger(retryAfter) || retryAfter < 0 || retryAfter > policy.backoff.retryAfterCapMs)) return;
    const sample = eligibilityOnly ? 0 : this.ports.generationTiming?.random() ?? Math.random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('Invalid retry jitter source.');
    const jitter = Math.floor(sample * Math.min(policy.backoff.capMs, policy.backoff.baseMs * 2 ** (run.attempts.length - 1)));
    const delayMs = Math.max(jitter, typeof retryAfter === 'number' ? retryAfter : 0);
    return { triggerKind: transient ? 'transient' : 'validation', previousAttemptId: last.attemptId,
      delayMs, notBefore: new Date(this.generationNow() + delayMs).toISOString() };
  }
  private settleBounded(run: ExtractionRun, signal?: AbortSignal, retryOwner = false): ExtractionRun {
    if (run.status === 'completed') return run;
    if (run.status === 'prepared') return this.commitPrepared(run, signal);
    if (run.status === 'failed' || run.status === 'cancelled' && (!run.attempts.at(-1)!.outcome || run.attempts.at(-1)!.failure)) return run;
    let attempt = run.attempts.at(-1)!;
    let recorded: ReturnType<ExtractionRunStore['readOutcome']>;
    try { recorded = this.ports.runs.readOutcome(run.runId, attempt.attemptId, attempt.outcome); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !attempt.outcome) return run; throw error; }
    const updateAttempt = (value: typeof attempt) => this.saveRun(run, { attempts: run.attempts.map(item => item.attemptId === value.attemptId ? value : item) });
    if (!attempt.outcome || !attempt.accounting) {
      run = updateAttempt({ ...attempt, outcome: recorded.ref, accounting: accountExtractionOutcome(recorded.outcome, attempt.budget!) });
      attempt = run.attempts.at(-1)!;
    }
    let decoded = extractionResponse(recorded.outcome, attempt.request.outputMode, attempt.request.wireId);
    if (attempt.accounting?.status === 'policy_violation') decoded = { status: 'failed', failure: { failureKind: 'budget_policy_violation', diagnostic: 'Executor usage exceeds the frozen token policy; original outcome remains archived.' } };
    let source: ReturnType<KnowledgeApplication['source']> | undefined;
    let checked: ReturnType<typeof checkWindowExtractionResponse> | undefined;
    if (decoded.status === 'decoded' && !signal?.aborted) {
      source = this.source(run.snapshotId, run.sourceVersion);
      if (source.status !== 'available') decoded = { status: 'failed', failure: {
        failureKind: 'source_unavailable', diagnostic: 'Extraction source is unavailable; no further invocation or admission is allowed.' } };
      else try { checked = checkWindowExtractionResponse(decoded.response, source.window.excerpts); }
      catch (error) {
        if (!(error instanceof SyntaxError || error instanceof Error && error.name === 'ZodError')) throw error;
        decoded = { status: 'failed', failure: { failureKind: 'envelope_error', diagnostic: 'Extraction response envelope was rejected.' } };
      }
    }
    const settled = { ...attempt,
      ...(decoded.status === 'failed' ? { failure: { ...decoded.failure, diagnostic: decoded.failure.diagnostic.slice(0, 4096) } } : {}),
      ...(decoded.status === 'decoded' && decoded.wireDiagnostic ? { wireDiagnostic: { wireId: decoded.wireDiagnostic.wireId,
        wireStatus: decoded.wireDiagnostic.wireStatus, itemFailureCount: decoded.wireDiagnostic.itemFailures.length } } : {}),
      ...(checked ? { admission: { assessmentVersion: 'knowledge-generation-admission/v1' as const,
        entityCount: checked.analysis.entities.length, mentionCount: checked.analysis.mentions.length, proposalCount: checked.accepted.length,
        entityRejections: checked.analysis.rejected, rejections: checked.rejected } } : {}) };
    if (this.ports.hash(settled) !== this.ports.hash(attempt)) { run = updateAttempt(settled); attempt = run.attempts.at(-1)!; }
    if (!signal?.aborted && retryOwner && this.source(run.snapshotId, run.sourceVersion).status === 'available' && this.retryTrigger(run, true)) return run;
    const result = extractionOutcomeResult(recorded.outcome), fields = result as Record<string, unknown> | undefined;
    const metric = (key: string) => typeof fields?.[key] === 'number' && Number.isFinite(fields[key]) ? fields[key] as number : undefined;
    const flag = (key: string) => typeof fields?.[key] === 'boolean' ? fields[key] as boolean : undefined;
    const runtime = result && metric('durationMs') !== undefined ? { durationMs: metric('durationMs')!,
      ...Object.fromEntries(['durationApiMs', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUSD']
        .filter(key => metric(key) !== undefined && (key === 'durationApiMs' || (key === 'costUSD' ? flag('costReportedByExecutor') !== false : flag('tokenUsageReportedByExecutor') !== false)))
        .map(key => [key, metric(key)])),
      ...(flag('tokenUsageReportedByExecutor') === undefined ? {} : { tokenUsageReportedByExecutor: flag('tokenUsageReportedByExecutor') }),
      ...(flag('costReportedByExecutor') === undefined ? {} : { costReportedByExecutor: flag('costReportedByExecutor') }) } : undefined;
    const rawOutput = typeof result?.output === 'string' && result.output.length <= 2 * 1024 * 1024 ? result.output : undefined;
    const projection = { ...(runtime ? { runtime } : {}), ...(rawOutput === undefined ? {} : { rawOutput, selectedAttemptId: attempt.attemptId }) };
    if (signal?.aborted || decoded.status === 'failed') return this.saveRun(run, { ...projection, status: signal?.aborted ? 'cancelled' : 'failed',
      finishedAt: this.ports.now(), error: signal?.aborted ? 'Extraction cancelled after outcome archive.' : decoded.status === 'failed' ? decoded.failure.diagnostic : undefined });
    run = this.saveRun(run, projection);
    // Recompute no new source fact: admission above and this birth use the same checker invocation.
    if (source?.status !== 'available' || !checked) throw new Error('Extraction admission source is missing.');
    try { run = this.prepare(run, source.window, decoded.response, undefined, checked); }
    catch (error) {
      if (!(error instanceof Error && /capacity|exceeds/i.test(error.message))) throw error;
      const diagnostic = 'Extraction application intent exceeds storage capacity; original outcome remains archived.';
      return this.saveRun(run, { status: 'failed', finishedAt: this.ports.now(), error: diagnostic,
        attempts: run.attempts.map(item => item.attemptId === attempt.attemptId ? { ...item, failure: { failureKind: 'capacity', diagnostic } } : item) });
    }
    return this.commitPrepared(run, signal);
  }
  private commitPrepared(run: ExtractionRun, signal?: AbortSignal): ExtractionRun {
    signal?.throwIfAborted();
    const taskViolation = this.entityOnlyCommitViolation(run);
    if (taskViolation) return this.failEntityOnlyTask(run, taskViolation);
    this.ports.entities.write(run.entityAnalysis!, run.entityAnalysis!.revision.revisedBy);
    for (const intent of run.intents) {
      signal?.throwIfAborted();
      this.ports.knowledge.write({ requestId: intent.requestId, knowledgeId: intent.revision.knowledgeId, expectedGeneration: 0,
        commandKind: 'append_revision', expectedHeadRevisionId: null, revision: intent.revision, grounding: intent.grounding }, intent.revision.revisedBy);
    }
    return this.saveRun(run, { status: 'completed', finishedAt: this.ports.now(),
      committed: run.intents.map(intent => ({ knowledgeId: intent.revision.knowledgeId, revisionId: intent.revision.revisionId })) });
  }
  maintain(knowledgeId: string, revisionId: string, choice: 'retain' | 'discard', reason: string, expectedGeneration: number, requestId = this.ports.id()) {
    return this.ports.knowledge.write({ knowledgeId, requestId, expectedGeneration, commandKind: 'record_maintenance',
      maintenance: { revisionId, choice, reason, actor: this.ports.actor, at: this.ports.now() } }, this.ports.actor);
  }
  revise(knowledgeId: string, expectedRevisionId: string, expectedGeneration: number, input: unknown, reason: string, citationLocatorsInput?: unknown) {
    const previous = this.detail(knowledgeId, expectedRevisionId);
    const ref = previous.grounding.entityAnalysisRef;
    if (!ref) throw new Error('Knowledge has no bound entity analysis.');
    return this.reviseUsingEntities(knowledgeId, expectedRevisionId, expectedGeneration, ref.analysisId, ref.revisionId, input, reason, undefined, citationLocatorsInput);
  }

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
  reviseUsingEntities(knowledgeId: string, expectedRevisionId: string, expectedGeneration: number, analysisId: string,
    analysisRevisionId: string, input: unknown, reason: string, identityUncertaintiesInput?: unknown, citationLocatorsInput?: unknown) {
    const previous = this.detail(knowledgeId, expectedRevisionId);
    const analysis = this.entities(analysisId, analysisRevisionId);
    if (analysis.source.status !== 'available') throw new Error('Entity source unavailable.');
    const excerpts = analysis.source.window.excerpts;
    if (previous.grounding.entityAnalysisRef?.analysisId !== analysisId
      || previous.grounding.sourceBindings.some(binding => binding.snapshotId !== analysis.history.snapshotId || binding.sourceVersion !== analysis.history.sourceVersion)) {
      throw new Error('Entity analysis belongs to a different evidence window.');
    }
    const draft = KnowledgeDraftSchema.parse(input);
    const identityUncertainties = identityUncertaintiesInput === undefined ? previous.grounding.identityUncertainties
      : z.array(z.string().trim().min(1).max(4096)).max(64).parse(identityUncertaintiesInput);
    if (draft.evidence.some(link => !excerpts.some(excerpt => excerpt.evidenceRef === link.evidenceRef))) {
      throw new Error('Knowledge evidence is outside the entity window.');
    }
    for (const entity of draft.entities) {
      const catalog = analysis.revision.entities.find(candidate => candidate.entityId === entity.entityId);
      if (!catalog || catalog.label !== entity.label || catalog.description !== entity.description) throw new Error('Knowledge entity differs from the bound analysis.');
    }
    const mentions = analysis.revision.mentions.filter(mention => draft.entities.some(entity => entity.entityId === mention.entityId));
    const citations = citationLocatorsInput === undefined
      ? previous.grounding.citations.filter(citation => draft.evidence.some(link => link.evidenceLinkId === citation.evidenceLinkId))
      : resolveKnowledgeCitationLocators(citationLocatorsInput, excerpts);
    if (validateGroundingReferences(draft, { mentions, citations }, new Set(excerpts.map(excerpt => excerpt.evidenceRef))).length
      || citations.some(citation => validateEvidenceSelection(citation.selection, excerpts).length)) {
      throw new KnowledgeCitationRevisionError();
    }
    const revision: KnowledgeRevision = { ...previous.revision, ...draft, revisionId: this.ports.id(),
      parentRevision: { knowledgeId, revisionId: expectedRevisionId }, revisedAt: this.ports.now(), revisedBy: this.ports.actor, revisionReason: reason };
    const grounding: KnowledgeGrounding = { ...previous.grounding, revisionId: revision.revisionId, mentions, citations,
      entityAnalysisRef: { analysisId, revisionId: analysisRevisionId },
      sourceBindings: [{ snapshotId: analysis.history.snapshotId, sourceVersion: analysis.history.sourceVersion,
        evidenceRefs: [...new Set([...draft.evidence.map(link => link.evidenceRef), ...mentions.map(mention => mention.selection.evidenceRef)])] }],
      identityUncertainties: [...new Set([...identityUncertainties,
        ...analysis.revision.entities.filter(entity => draft.entities.some(selected => selected.entityId === entity.entityId)).flatMap(entity => entity.uncertainties)])],
    };
    this.ports.knowledge.write({ knowledgeId, requestId: this.ports.id(), expectedGeneration, commandKind: 'append_revision',
      expectedHeadRevisionId: expectedRevisionId, revision, grounding }, this.ports.actor);
    return this.detail(knowledgeId, revision.revisionId);
  }
  private prepare(run: ExtractionRun, window: EvidenceWindow, response: unknown,
    wireDiagnostic?: { wireId: string; wireStatus: 'valid' | 'item_failures'; itemFailureCount: number },
    assessment?: ReturnType<typeof checkWindowExtractionResponse>): ExtractionRun {
    const actor: KnowledgeActor = { actorKind: 'agent', actorId: `extractor:${run.executor}`, executionRef: run.runId };
    const checked = assessment ?? checkWindowExtractionResponse(response, window.excerpts);
    const entityIds = new Map(checked.analysis.entities.map(entity => [entity.entityId, this.ports.id()]));
    const mentionIds = new Map(checked.analysis.mentions.map(mention => [mention.mentionId, this.ports.id()]));
    const entityAnalysis: EntityAnalysisWrite = { requestId: this.ports.id(), analysisId: run.runId,
      snapshotId: window.snapshotId, sourceVersion: window.sourceVersion, expectedGeneration: 0, expectedHeadRevisionId: null,
      revision: { revisionId: this.ports.id(), revisedAt: this.ports.now(), revisedBy: actor, revisionReason: '从选定工作日志分析对象，等待核对',
        entities: checked.analysis.entities.map(entity => mapEntityIdentity(entity, entityIds, mentionIds)),
        mentions: checked.analysis.mentions.map(mention => ({ ...mention, mentionId: mentionIds.get(mention.mentionId)!, entityId: entityIds.get(mention.entityId)! })),
        limitations: window.limitations,
      } };
    return this.saveRun(run, { status: 'prepared', error: undefined, finishedAt: undefined, entityAnalysis, entityRejections: checked.analysis.rejected, rejections: checked.rejected,
      ...(wireDiagnostic ? { attempts: run.attempts.map(attempt => attempt.attemptId === run.selectedAttemptId ? { ...attempt, wireDiagnostic } : attempt) } : {}),
      intents: checked.accepted.map(proposal => this.intent(proposal, window, actor, { entityIds, mentionIds,
        ref: { analysisId: run.runId, revisionId: entityAnalysis.revision.revisionId } })) });
  }

  private saveRun(run: ExtractionRun, update: Partial<ExtractionRun>): ExtractionRun {
    // Match manifest JSON omission (not native outcome serialization) before comparing lost acknowledgements.
    const next = JSON.parse(JSON.stringify({ ...run, ...update, generation: run.generation + 1 })) as ExtractionRun;
    try { this.ports.runs.save(next, run.generation); }
    catch (error) {
      // A failed acknowledgement can follow a successful atomic publication. Never replay the invocation.
      try {
        const saved = this.ports.runs.read(run.runId);
        if (this.ports.hash(saved) === this.ports.hash(next)) { this.ports.runs.save(next, run.generation); return saved; }
        if ((update.status === 'prepared' && ['prepared', 'completed'].includes(saved.status)
          || update.status === 'completed' && saved.status === 'completed')
          && saved.requestDigest === next.requestDigest && saved.selectedAttemptId === next.selectedAttemptId
          && saved.rawOutput === next.rawOutput && this.ports.hash(saved.attempts) === this.ports.hash(next.attempts)) {
          this.ports.runs.save(saved, saved.generation - 1); return saved;
        }
      }
      catch { /* Preserve the original persistence failure. */ }
      throw error;
    }
    return next;
  }
  private intent(proposal: ExtractionProposal, window: EvidenceWindow, actor: KnowledgeActor,
    shared: { entityIds: Map<string, string>; mentionIds: Map<string, string>; ref: NonNullable<KnowledgeGrounding['entityAnalysisRef']> },
    identity?: { id(): string; now(): string }): ExtractionRun['intents'][number] {
    const entityIds = shared.entityIds;
    const draft: KnowledgeDraft = {
      ...proposal.draft,
      entities: proposal.draft.entities.map((entity) => ({ ...entity, entityId: entityIds.get(entity.entityId)! })),
      content: { ...proposal.draft.content, statements: proposal.draft.content.statements.map((statement) => ({
        ...statement, subject: { entityId: entityIds.get(statement.subject.entityId)! },
        ...(statement.object ? { object: { entityId: entityIds.get(statement.object.entityId)! } } : {}),
      })) },
    };
    const now = identity ? identity.now() : this.ports.now();
    const id = identity ? () => identity.id() : () => this.ports.id();
    const revision: KnowledgeRevision = { ...draft, knowledgeId: id(), revisionId: id(),
      observationRefs: [], derivations: [], createdAt: now, revisedAt: now, createdBy: actor, revisedBy: actor, revisionReason: '从选定工作日志提炼，等待人工复核' };
    return { requestId: id(), revision, grounding: {
      revisionId: revision.revisionId,
      mentions: proposal.mentions.map((mention) => ({ ...mention, mentionId: shared.mentionIds.get(mention.mentionId)!, entityId: entityIds.get(mention.entityId)! })),
      citations: proposal.citations, reuseRationale: proposal.reuseRationale, identityUncertainties: proposal.identityUncertainties,
      sourceBindings: [{ snapshotId: window.snapshotId, sourceVersion: window.sourceVersion, evidenceRefs: [...new Set([...draft.evidence.map((link) => link.evidenceRef), ...proposal.mentions.map((mention) => mention.selection.evidenceRef)])] }],
      entityAnalysisRef: shared.ref,
    } };
  }
}
