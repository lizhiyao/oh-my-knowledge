import type { KnowledgeActor, KnowledgeBodyRef, KnowledgeRevision } from '../contracts.js';
import type { KnowledgeStore, KnowledgeWrite } from '../store.js';
import { canonicalJson } from '../store.js';
import type { SourceStore } from '../source-store.js';
import { sourceSetPreimage, type SourceRef, type SourceSnapshot } from '../sources.js';
import { generationImportRunId, generationSourceInput, SOURCE_GENERATION_INPUT_VERSION, WORKFLOW_ID } from '../extraction/source-input.js';
import type { EntityAnalysisStore, EntityAnalysisWrite } from '../entities/contracts.js';
import type { KnowledgeAssociationStore, KnowledgeAssociationWrite } from '../associations.js';
import { KnowledgeAssociationRevisionSchema, validateKnowledgeAssociationReferences } from '../associations.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../adapters/body-digest.js';
import type { KnowledgeGenerationModel, KnowledgeGenerationProfile } from '../adapters/generation-executor.js';
import { MAX_GENERATION_OUTCOME_BYTES } from '../adapters/generation-journal-store.js';
import type { GenerationJournal, GenerationJournalStore, GenerationStage } from '../extraction/generation-journal.js';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE, checkGeneratedAssociations, checkGeneratedBodies,
  generationTextDigest } from '../extraction/body-generation-wire.js';
import { associationMentionKey, compileAssociationCatalog } from '../extraction/association-catalog.js';
import { observeGenerationException, type GenerationOutcome, type GenerationOutcomeRef } from '../extraction/native-outcome.js';

import { SourceReviewApplication } from './source-review.js';
import { readSourceReviewOriginal } from '../adapters/source-review-original.js';
import { sourceReviewRevisionDigest } from '../adapters/source-review-store.js';
import { sourceCoverageUnresolved } from '../source-review-history.js';
import { SourceCoverageWriteSchema, type SourceLedgerStore, type SourceCoverageStore,
  type SourceLedgerRef, type SourceCoverageDecisionRef, type SourceLedgerWrite } from '../source-review.js';
import { SOURCE_REVIEW_INPUT_VERSION } from '../extraction/source-review-input.js';
import { SOURCE_LEDGER_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE, sourceLedgerModelInput, sourceCoverageModelInput,
  checkGeneratedSourceLedger, checkGeneratedSourceCoverage } from '../extraction/source-review-wire.js';

export interface BodyGenerationPorts {
  sources: SourceStore; knowledge: KnowledgeStore; entities: EntityAnalysisStore;
  associations: KnowledgeAssociationStore; journals: GenerationJournalStore;
  ledgers: SourceLedgerStore; coverage: SourceCoverageStore; reviewActor?: KnowledgeActor;
  actor: KnowledgeActor; id(): string; now(): string; assertWritable?(): void;
}
export interface KnowledgeGenerationOptions {
  confirmedRequestDigest?: string;
  beforeDispatch?: (claim: { runId: string; invocationId: string; stageKind: GenerationStage['stageKind']; requestDigest: string }) => void;
  onOutcomeArchived?: (event: { runId: string; invocationId: string; stageKind: GenerationStage['stageKind']; outcome: GenerationOutcome; ref: GenerationOutcomeRef }) => void;
}
const message = (error: unknown) => observeGenerationException(error).message || 'Host validation failed.';
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
type AssociationAppend = Extract<KnowledgeAssociationWrite, { commandKind: 'append_revision' }>;
const profiles: Record<GenerationStage['stageKind'], KnowledgeGenerationProfile> = {
  source_ledger: SOURCE_LEDGER_GENERATION_PROFILE, body: BODY_GENERATION_PROFILE,
  source_coverage: SOURCE_COVERAGE_GENERATION_PROFILE, association: ASSOCIATION_GENERATION_PROFILE,
};
function currentStage(stage: GenerationStage): boolean {
  const profile = profiles[stage.stageKind];
  return stage.profileId === profile.profileId && stage.wireId === profile.wireId && stage.promptVersion === profile.promptVersion
    && stage.system === profile.system && same(stage.wireSchema, profile.wireSchema);
}
/** Stored write intents replay exactly. Neither recovery nor successful analysis supplies a semantic decision. */
export function generationNextAction(journal: GenerationJournal) {
  const pending = journal.stages.find(stage => !['completed', 'failed'].includes(stage.state));
  if (journal.status === 'active' && journal.stages.at(-1)?.state !== 'prepared_writes' && journal.stages.some(stage => !currentStage(stage))) return 'unsupported' as const;
  return pending?.state === 'prepared' ? 'continue_stage' as const
    : pending?.state === 'claimed' ? 'outcome_unknown_do_not_redispatch' as const
      : pending ? 'resume_publication' as const : journal.status !== 'active' ? 'none' as const
        : journal.stages.at(-1)?.stageKind === 'source_coverage' ? 'review_source_coverage' as const : 'prepare_next_stage' as const;
}
/** Each explicit phase is separately confirmed, claimed once and archived before publication. */
export class BodyGenerationApplication {
  private held?: { runId: string; invocationId: string; outcome: GenerationOutcome };
  private inFlight?: string;
  constructor(private readonly ports: BodyGenerationPorts) {}
  private review(actor = this.ports.reviewActor) {
    return new SourceReviewApplication({ ...this.ports, actor,
      readOriginal: (original, expected) => readSourceReviewOriginal(this.ports.journals, original, expected) });
  }
  sourceLedger(id: string, revision?: string) { return this.review().ledger(id, revision); }
  sourceCoverageStatus(id: string, revision?: string) {
    const result = this.review().coverage(id, revision);
    try {
      const ledger = this.review().ledger(result.revision.data.ledgerRef.ledgerId, result.revision.data.ledgerRef.revisionId);
      if (!same(ledger.ref, result.revision.data.ledgerRef)) throw new Error('Source coverage exact ledger mismatch.');
      return { ...result, ledgerStatus: 'available' as const, unresolvedIds: sourceCoverageUnresolved(result.revision.data, ledger.revision.data) };
    } catch { return { ...result, ledgerStatus: 'unavailable' as const, unresolvedIds: null }; }
  }
  reviewSourceCoverage(input: unknown) {
    const command = SourceCoverageWriteSchema.parse(input);
    if (command.commandKind === 'append_analysis') throw new Error('Source analyses require a confirmed native generation phase.');
    return this.review().writeCoverage(command);
  }
  inspect(runId: string) {
    const journal = this.required(runId);
    return { ...this.state(journal), nativeOutcomes: journal.stages.map(stage => ({ stageKind: stage.stageKind,
      invocationId: stage.invocationId, ...(stage.outcomeRef ? { outcome: this.ports.journals.outcome(journal, stage) } : {}) })) };
  }
  private required(runId: string) { const j = this.ports.journals.read(runId); if (!j) throw new Error('Generation journal is missing.'); return j; }
  private persist(j: GenerationJournal, validateClaim?: (journal: GenerationJournal, stage: GenerationStage) => void) {
    this.ports.assertWritable?.(); return this.ports.journals.write({ ...j, generation: j.generation + 1 }, j.generation, validateClaim);
  }
  private state(journal: GenerationJournal) { return { journal, nextAction: generationNextAction(journal) }; }
  private snapshot(sourceRef: GenerationJournal['sources'][number]) {
    const source = this.ports.sources.read(sourceRef.snapshotId, sourceRef.sourceVersion);
    if (source.status !== 'available') throw new Error(`Generation source unavailable: ${source.reason}.`);
    if (generationTextDigest(canonicalJson(source.snapshot)) !== sourceRef.sourceDigest) throw new Error('Generation source snapshot changed.');
    return source.snapshot;
  }
  private phase(model: KnowledgeGenerationModel, profile: KnowledgeGenerationProfile, input: string): GenerationStage {
    if (Buffer.byteLength(profile.system, 'utf8') + Buffer.byteLength(input, 'utf8') > 1024 * 1024) throw new Error('Knowledge model request capacity_exceeded (1 MiB).');
    const producer = model.inspect(profile, input);
    if (!Number.isSafeInteger(producer.maxOutcomeJsonBytes) || producer.maxOutcomeJsonBytes <= 0
      || producer.maxOutcomeJsonBytes + 64 * 1024 > MAX_GENERATION_OUTCOME_BYTES) throw new Error('Generation producer exceeds native archive capacity.');
    const requestDigest = generationTextDigest(canonicalJson({ executor: model.executor, model: model.model, timeoutMs: model.timeoutMs,
      profileId: profile.profileId, system: profile.system, wireId: profile.wireId, input, producer }));
    return { stageKind: profile.stageKind, invocationId: this.ports.id(), state: 'prepared', profileId: profile.profileId,
      promptVersion: profile.promptVersion, system: profile.system, wireId: profile.wireId, wireSchema: { ...profile.wireSchema }, input,
      inputDigest: generationTextDigest(input), requestDigest, producer, committed: 0, issues: [] };
  }
  private actor(journal: GenerationJournal, stage: GenerationStage): KnowledgeActor {
    return { actorKind: 'agent', actorId: `extractor:${journal.executor}`, executionRef: `${journal.runId}:${stage.invocationId}` };
  }
  private bodies(journal: Pick<GenerationJournal, 'bodies'>): KnowledgeRevision[] {
    return journal.bodies.map(ref => {
      const body = this.ports.knowledge.read(ref.knowledgeId).revisions.find(r => r.revisionId === ref.revisionId);
      if (!body || !same(knowledgeBodyRef(body), ref)) throw new Error('Saved generation body identity mismatch.'); return body;
    });
  }
  private ledger(journal: Pick<GenerationJournal, 'ledgerRef'>) {
    if (!journal.ledgerRef) throw new Error('An exact native source ledger is required.');
    const result = this.review().assertLedger(journal.ledgerRef);
    return { ref: result.ref, data: result.revision.data };
  }
  private bodyInput(journal: GenerationJournal): string {
    return canonicalJson({ inputVersion: SOURCE_REVIEW_INPUT_VERSION, sourceSetId: journal.sourceSetId,
      sources: journal.sources.map(source => this.snapshot(source)).map(generationSourceInput), ledger: this.ledger(journal) });
  }
  private coverageInput(journal: GenerationJournal): string {
    return sourceCoverageModelInput(journal.sources.map(source => this.snapshot(source)), this.ledger(journal), this.bodies(journal));
  }
  private associationInput(journal: GenerationJournal): string {
    return canonicalJson({ inputVersion: SOURCE_GENERATION_INPUT_VERSION, sourceSetId: journal.sourceSetId,
      sources: journal.sources.map(source => this.snapshot(source)).map(generationSourceInput), bodies: this.bodies(journal).map((body, index) => ({ bodyKey: `b${index}`,
        bodyRef: knowledgeBodyRef(body), title: body.title, content: body.content, reuseRationale: body.reuseRationale })) });
  }
  private idle(signal?: AbortSignal) {
    this.ports.assertWritable?.(); signal?.throwIfAborted();
    if (this.inFlight || this.held) throw new Error('A generation outcome is in flight or awaiting durable archive.');
  }
  private seed(sources: readonly SourceRef[], model: KnowledgeGenerationModel, runId: string, mode: GenerationJournal['mode'], bodies: KnowledgeBodyRef[] = []) {
    const sourceSet = sourceSetPreimage(sources);
    const snapshots = sourceSet.sources.map(ref => {
      const source = this.ports.sources.read(ref.snapshotId, ref.sourceVersion);
      if (source.status !== 'available') throw new Error(`Generation source unavailable: ${source.reason}.`); return source.snapshot;
    });
    return { storeKind: 'knowledge-generation-journal' as const, schemaVersion: 4 as const, workflowId: WORKFLOW_ID,
      inputVersion: SOURCE_REVIEW_INPUT_VERSION, sourceSetId: generationTextDigest(canonicalJson(sourceSet)),
      runId, generation: 1, mode, status: 'active' as const, createdAt: this.ports.now(), actor: this.ports.actor,
      sources: snapshots.map(snapshot => ({ snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion, sourceDigest: generationTextDigest(canonicalJson(snapshot)) })),
      executor: model.executor, model: model.model, timeoutMs: model.timeoutMs, bodies, stages: [] as GenerationStage[] };
  }
  private sameModel(j: GenerationJournal, model: KnowledgeGenerationModel) {
    if (j.executor !== model.executor || j.model !== model.model || j.timeoutMs !== model.timeoutMs) throw new Error('Generation continuation model changed.');
  }
  private prepareAssociation(j: GenerationJournal, model: KnowledgeGenerationModel, decision: SourceCoverageDecisionRef): GenerationJournal {
    this.review().assertDecision(decision);
    if (decision.sourceSetId !== j.sourceSetId || !same(decision.ledgerRef, j.ledgerRef) || !same(decision.coverageRef, j.coverageRef)
      || !same(decision.bodyRefs, j.bodies)) throw new Error('Generation source coverage decision does not bind this exact run.');
    const next = { ...j, sourceCoverageDecisionRef: decision };
    if (!j.bodies.length) return this.persist({ ...next, status: 'completed' });
    return this.persist({ ...next, stages: [...j.stages, this.phase(model, ASSOCIATION_GENERATION_PROFILE, this.associationInput(j))] });
  }
  prepareGeneration(sources: readonly SourceRef[], model: KnowledgeGenerationModel, runId?: string, signal?: AbortSignal, decision?: SourceCoverageDecisionRef) {
    const sourceSetId = generationTextDigest(canonicalJson(sourceSetPreimage(sources)));
    runId ??= generationImportRunId(sourceSetId);
    const existing = this.ports.journals.read(runId);
    if (existing) {
      if (existing.mode !== 'generate' || existing.sourceSetId !== sourceSetId) throw new Error('Generation request conflicts with existing journal.');
      this.sameModel(existing, model);
      if (existing.status !== 'active' || generationNextAction(existing) === 'unsupported' || existing.stages.at(-1)!.state !== 'completed') return this.state(existing);
      this.idle(signal); const last = existing.stages.at(-1)!;
      if (last.stageKind === 'source_coverage') return this.state(decision ? this.prepareAssociation(existing, model, decision) : existing);
      const profile = last.stageKind === 'source_ledger' ? BODY_GENERATION_PROFILE : SOURCE_COVERAGE_GENERATION_PROFILE;
      const input = last.stageKind === 'source_ledger' ? this.bodyInput(existing) : this.coverageInput(existing);
      return this.state(this.persist({ ...existing, stages: [...existing.stages, this.phase(model, profile, input)] }));
    }
    this.idle(signal); if (decision) throw new Error('A new generation cannot inherit a source coverage decision.');
    const seed = this.seed(sources, model, runId, 'generate');
    const stage = this.phase(model, SOURCE_LEDGER_GENERATION_PROFILE, sourceLedgerModelInput(seed.sources.map(source => this.snapshot(source))));
    return this.state(this.ports.journals.write({ ...seed, stages: [stage] }, 0));
  }
  prepareSourceReview(sources: readonly SourceRef[], bodyRefs: readonly KnowledgeBodyRef[], model: KnowledgeGenerationModel,
    ledgerRef?: SourceLedgerRef, runId = this.ports.id(), signal?: AbortSignal) {
    const existing = this.ports.journals.read(runId), sourceSetId = generationTextDigest(canonicalJson(sourceSetPreimage(sources)));
    if (existing) {
      if (existing.mode !== 'review_sources' || existing.sourceSetId !== sourceSetId || !same(existing.bodies, bodyRefs)
        || ledgerRef && !same(existing.ledgerRef, ledgerRef)) throw new Error('Source review request conflicts with existing journal.');
      this.sameModel(existing, model);
      if (existing.status !== 'active' || generationNextAction(existing) === 'unsupported' || existing.stages.at(-1)!.state !== 'completed') return this.state(existing);
      this.idle(signal);
      return this.state(this.persist({ ...existing, stages: [...existing.stages,
        this.phase(model, SOURCE_COVERAGE_GENERATION_PROFILE, this.coverageInput(existing))] }));
    }
    this.idle(signal);
    const seed = { ...this.seed(sources, model, runId, 'review_sources', [...bodyRefs]), ...(ledgerRef ? { ledgerRef } : {}) };
    const bodies = this.bodies(seed);
    if (bodies.some(body => body.content.segments.flatMap(segment => segment.evidence).some(evidence =>
      !seed.sources.some(ref => ref.snapshotId === evidence.source.snapshotId && ref.sourceVersion === evidence.source.sourceVersion)))) throw new Error('Review sources omit a body evidence source.');
    const profile = ledgerRef ? SOURCE_COVERAGE_GENERATION_PROFILE : SOURCE_LEDGER_GENERATION_PROFILE;
    const input = ledgerRef ? this.coverageInput(seed) : sourceLedgerModelInput(seed.sources.map(source => this.snapshot(source)));
    return this.state(this.ports.journals.write({ ...seed, stages: [this.phase(model, profile, input)] }, 0));
  }
  async generate(sources: readonly SourceRef[], model: KnowledgeGenerationModel, runId?: string, signal?: AbortSignal, options: KnowledgeGenerationOptions = {}) {
    const j = this.prepareGeneration(sources, model, runId, signal).journal;
    if (j.status !== 'active' || j.stages.length !== 1 || j.stages[0].state !== 'prepared') return this.resume(j.runId);
    return this.state(await this.invoke(j, model, signal, options));
  }
  prepareAssociationRebuild(ref: KnowledgeBodyRef, model: KnowledgeGenerationModel, decision: SourceCoverageDecisionRef,
    runId = this.ports.id(), signal?: AbortSignal) {
    const existing = this.ports.journals.read(runId);
    if (existing) {
      if (existing.mode !== 'rebuild_associations' || !same(existing.bodies, [ref]) || !same(existing.sourceCoverageDecisionRef, decision)) throw new Error('Association rebuild conflicts with existing journal.');
      this.sameModel(existing, model); return this.state(existing);
    }
    this.idle(signal);
    this.review().assertDecision(decision);
    if (!decision.bodyRefs.some(body => same(body, ref))) throw new Error('Association rebuild body is outside its exact coverage decision.');
    const coverage = this.review().coverage(decision.coverageRef.coverageId, decision.coverageRef.revisionId);
    const refs = coverage.revision.data.manifest.sources.map(source => source.sourceRef);
    const seed = { ...this.seed(refs, model, runId, 'rebuild_associations', [ref]), ledgerRef: decision.ledgerRef,
      coverageRef: decision.coverageRef, sourceCoverageDecisionRef: decision };
    return this.state(this.ports.journals.write({ ...seed, stages: [this.phase(model, ASSOCIATION_GENERATION_PROFILE, this.associationInput(seed))] }, 0));
  }
  async rebuild(ref: KnowledgeBodyRef, model: KnowledgeGenerationModel, decision: SourceCoverageDecisionRef,
    runId?: string, signal?: AbortSignal, options: KnowledgeGenerationOptions = {}) {
    const j = this.prepareAssociationRebuild(ref, model, decision, runId, signal).journal;
    if (j.status !== 'active' || j.stages.at(-1)?.state !== 'prepared') return this.resume(j.runId);
    return this.state(await this.invoke(j, model, signal, options));
  }
  async continueStage(runId: string, expectedGeneration: number, model: KnowledgeGenerationModel, signal?: AbortSignal, options: KnowledgeGenerationOptions = {}) {
    this.ports.assertWritable?.(); const j = this.required(runId);
    if (j.generation !== expectedGeneration || j.status !== 'active') throw new Error('Generation continuation conflict.');
    if (generationNextAction(j) === 'unsupported') throw new Error('Generation profile changed; use the preserved matching build to recover this run.');
    this.sameModel(j, model);
    if (j.stages.at(-1)!.state !== 'prepared') throw new Error('Prepare the next request; only a never-claimed phase may be continued.');
    return this.state(await this.invoke(j, model, signal, options));
  }
  private validateClaim(j: GenerationJournal, stage: GenerationStage) {
    if (!currentStage(stage)) throw new Error('Generation profile changed before claim.');
    const sources = j.sources.map(source => this.snapshot(source));
    const input = stage.stageKind === 'source_ledger' ? sourceLedgerModelInput(sources) : stage.stageKind === 'body' ? this.bodyInput(j)
      : stage.stageKind === 'source_coverage' ? this.coverageInput(j) : this.associationInput(j);
    if (input !== stage.input) throw new Error('Generation complete request changed before claim.');
    if (stage.stageKind === 'association') {
      if (!j.sourceCoverageDecisionRef) throw new Error('An exact source coverage decision is required.');
      this.review().assertDecision(j.sourceCoverageDecisionRef);
    }
  }
  private async invoke(journal: GenerationJournal, model: KnowledgeGenerationModel, signal?: AbortSignal, options: KnowledgeGenerationOptions = {}): Promise<GenerationJournal> {
    this.idle(signal); const index = journal.stages.length - 1, stage = journal.stages[index];
    if (stage.state !== 'prepared') throw new Error('Generation phase is not dispatchable.');
    if (options.confirmedRequestDigest !== stage.requestDigest) throw new Error('Confirm the exact prepared generation request before dispatch.');
    const profile = profiles[stage.stageKind];
    if (!currentStage(stage) || !same(model.inspect(profile, stage.input), stage.producer)) throw new Error('Generation producer/profile changed.');
    journal.sources.forEach(source => this.snapshot(source)); this.inFlight = journal.runId; let claims = 0;
    try {
      const outcome = await model.invoke(profile, stage.input, signal, () => {
        if (claims !== 0) throw new Error('Duplicate native dispatch gate.');
        options.beforeDispatch?.({ runId: journal.runId, invocationId: stage.invocationId, stageKind: stage.stageKind, requestDigest: stage.requestDigest });
        journal = this.persist({ ...journal, stages: journal.stages.map((s, i) => i === index ? { ...s, state: 'claimed' } : s) },
          (next, claimed) => this.validateClaim(next, claimed));
        claims = 1;
      });
      this.held = { runId: journal.runId, invocationId: stage.invocationId, outcome };
      const ref = this.ports.journals.archive(journal, stage, outcome);
      const updated = { ...journal.stages[index], state: 'archived' as const, outcomeRef: ref,
        issues: claims === 1 ? [] : ['Native adapter did not prove exactly one dispatch claim.'] };
      journal = this.persist({ ...journal, stages: journal.stages.map((s, i) => i === index ? updated : s) });
      this.held = undefined;
      options.onOutcomeArchived?.({ runId: journal.runId, invocationId: stage.invocationId, stageKind: stage.stageKind, outcome, ref });
      return this.finish(journal);
    } finally { this.inFlight = undefined; }
  }
  /** Zero-model recovery attaches original evidence and replays only fixed publication intents. */
  resume(runId: string) {
    let j = this.required(runId), stage = j.stages.at(-1)!;
    if (this.inFlight === runId || generationNextAction(j) === 'unsupported') return this.state(j);
    if (this.held?.runId === runId || ['claimed', 'archived', 'prepared_writes'].includes(stage.state)) this.ports.assertWritable?.();
    if (this.held?.runId === runId && this.held.invocationId === stage.invocationId) {
      const ref = this.ports.journals.archive(j, stage, this.held.outcome);
      j = this.persist({ ...j, stages: j.stages.map(s => s.invocationId === stage.invocationId ? { ...s, state: 'archived', outcomeRef: ref } : s) }); this.held = undefined;
    } else if (stage.state === 'claimed') {
      const outcome = this.ports.journals.outcome(j, stage);
      if (outcome) {
        const ref = this.ports.journals.archive(j, stage, outcome);
        j = this.persist({ ...j, stages: j.stages.map(s => s.invocationId === stage.invocationId ? { ...s, state: 'archived', outcomeRef: ref } : s) });
      }
    }
    stage = j.stages.at(-1)!;
    if (['archived', 'prepared_writes'].includes(stage.state)) j = this.finish(j);
    return this.state(j);
  }
  private finish(j: GenerationJournal): GenerationJournal {
    const index = j.stages.length - 1; let stage = j.stages[index];
    if (stage.state === 'archived') {
      if (!currentStage(stage)) return j;
      const outcome = this.ports.journals.outcome(j, stage); if (!outcome) throw new Error('Native outcome missing.');
      const output = outcome.outcomeKind === 'result' && outcome.result.ok && outcome.result.refusal === undefined
        && outcome.result.failure === undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length === 0)
        && typeof outcome.result.output === 'string' ? outcome.result.output : undefined;
      if (stage.stageKind === 'body') {
        try {
          if (output === undefined || outcome.cleanupFailure || stage.issues.length) throw new Error('Body native execution did not complete cleanly.');
          const checked = checkGeneratedBodies(output, j.sources.map(source => this.snapshot(source))), actor = this.actor(j, stage), at = this.ports.now();
          const writes: KnowledgeWrite[] = checked.accepted.map(({ draft }) => {
            const knowledgeId = this.ports.id(), revisionId = this.ports.id();
            return { commandKind: 'append_revision', requestId: this.ports.id(), knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null,
              revision: { ...draft, knowledgeId, revisionId, bodyDigest: knowledgeBodyDigest(draft), observationRefs: [...new Set(draft.content.segments.flatMap(segment => segment.evidence.map(evidence => evidence.source.snapshotId)))], derivations: [],
                createdAt: at, createdBy: actor, revisedAt: at, revisedBy: actor, revisionReason: 'Generated canonical knowledge body; pending review.' } };
          });
          stage = { ...stage, state: 'prepared_writes', bodyWrites: writes, rejected: checked.rejected };
        } catch (error) { stage = { ...stage, state: 'failed', issues: [...stage.issues, message(error)] }; }
      } else if (stage.stageKind === 'association') stage = this.associationIntents(j, stage, output, outcome.cleanupFailure !== undefined);
      else {
        try {
          if (output === undefined || outcome.cleanupFailure || stage.issues.length || !stage.outcomeRef) throw new Error('Source analysis native execution did not complete cleanly.');
          const common = { revisionId: this.ports.id(), parentRevisionId: null, revisedAt: this.ports.now(), revisedBy: this.actor(j, stage),
            modelOriginal: { runId: j.runId, invocationId: stage.invocationId, requestDigest: stage.requestDigest,
              archiveRef: `generation-journals/outcomes/${j.runId}/${stage.invocationId}.json`, archiveDigest: stage.outcomeRef.digest, outputDigest: generationTextDigest(output) } };
          const sources = j.sources.map(source => this.snapshot(source));
          if (stage.stageKind === 'source_ledger') {
            const content = { ...common, data: checkGeneratedSourceLedger(output, sources) };
            const write: SourceLedgerWrite = { commandKind: 'append_analysis', ledgerId: this.ports.id(), requestId: this.ports.id(), expectedGeneration: 0, expectedHeadEventId: null,
              revision: { ...content, digest: sourceReviewRevisionDigest(content) } };
            stage = { ...stage, state: 'prepared_writes', ledgerWrites: [write] };
          } else {
            const content = { ...common, data: checkGeneratedSourceCoverage(output, sources, this.ledger(j), this.bodies(j)) };
            const write = { commandKind: 'append_analysis' as const, coverageId: this.ports.id(), requestId: this.ports.id(), expectedGeneration: 0, expectedHeadEventId: null,
              revision: { ...content, digest: sourceReviewRevisionDigest(content) } };
            stage = { ...stage, state: 'prepared_writes', coverageWrites: [write] };
          }
        } catch (error) { stage = { ...stage, state: 'failed', issues: [...stage.issues, message(error)] }; }
      }
      j = this.persist({ ...j, stages: j.stages.map((s, i) => i === index ? stage : s), ...(stage.state === 'failed' ? { status: 'failed' as const } : {}) });
    }
    stage = j.stages[index]; if (stage.state !== 'prepared_writes') return j;
    const actor = this.actor(j, stage);
    const writes = stage.stageKind === 'body' ? (stage.bodyWrites ?? []) : stage.stageKind === 'association'
      ? [...(stage.entityWrites ?? []), ...(stage.associationWrites ?? [])] : stage.stageKind === 'source_ledger' ? (stage.ledgerWrites ?? []) : (stage.coverageWrites ?? []);
    for (let i = stage.committed; i < writes.length; i++) {
      const write = writes[i];
      if (stage.stageKind === 'body') this.ports.knowledge.write(write as KnowledgeWrite, actor);
      else if (stage.stageKind === 'source_ledger') this.review(actor).writeLedger(write);
      else if (stage.stageKind === 'source_coverage') this.review(actor).writeCoverage(write);
      else if ('analysisId' in write) this.ports.entities.write(write as EntityAnalysisWrite, actor);
      else this.ports.associations.write(write as KnowledgeAssociationWrite, actor);
      stage = { ...stage, committed: i + 1 };
      const bindings = stage.stageKind === 'body' ? { bodies: (stage.bodyWrites ?? []).slice(0, i + 1)
        .flatMap(w => w.commandKind === 'append_revision' ? [knowledgeBodyRef(w.revision)] : []) }
        : stage.stageKind === 'source_ledger' ? { ledgerRef: { ledgerId: stage.ledgerWrites![0].ledgerId,
          revisionId: stage.ledgerWrites![0].revision.revisionId, digest: stage.ledgerWrites![0].revision.digest } }
          : stage.stageKind === 'source_coverage' ? { coverageRef: { coverageId: stage.coverageWrites![0].coverageId,
            revisionId: stage.coverageWrites![0].revision.revisionId, digest: stage.coverageWrites![0].revision.digest } } : {};
      j = this.persist({ ...j, ...bindings, stages: j.stages.map((s, n) => n === index ? stage : s) });
    }
    stage = { ...stage, state: 'completed' };
    return this.persist({ ...j, stages: j.stages.map((s, n) => n === index ? stage : s),
      status: stage.stageKind === 'association' || j.mode === 'review_sources' && stage.stageKind === 'source_coverage' ? 'completed' : 'active' });
  }
  private associationIntents(j: GenerationJournal, stage: GenerationStage, output: string | undefined, cleanupFailure: boolean): GenerationStage {
    const bodies = this.bodies(j), actor = this.actor(j, stage), at = this.ports.now();
    const command = (body: KnowledgeRevision, revision: AssociationAppend['revision']): AssociationAppend => {
      const history = (() => { try { return this.ports.associations.read(body.knowledgeId); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; } })();
      return { commandKind: 'append_revision', requestId: this.ports.id(), knowledgeId: body.knowledgeId,
        expectedGeneration: history?.generation ?? 0, expectedHeadRevisionId: history?.writeHeadRevisionId ?? null,
        revision: { ...revision, ...(history ? { parentRevisionId: history.writeHeadRevisionId } : {}) } };
    };
    const failed = (body: KnowledgeRevision, reason: string) => command(body, { revisionId: this.ports.id(), bodyRef: knowledgeBodyRef(body),
      status: 'failed', reviewStatus: 'pending', catalogRefs: [], segmentEntityRefs: [], issues: [reason], revisedAt: at, revisedBy: actor,
      revisionReason: 'Derived association failed; canonical body unchanged.' });
    try {
      if (output === undefined || cleanupFailure || stage.issues.length) throw new Error('Association native execution did not complete cleanly.');
      const response = checkGeneratedAssociations(output), windows = j.sources.map(source => this.snapshot(source));
      const sourceKeys = windows.map((_, index) => `s${index}`), expectedKeys = new Set(bodies.map((_, index) => `b${index}`));
      if (response.catalogs.length !== sourceKeys.length || new Set(response.catalogs.map(catalog => catalog.sourceKey)).size !== sourceKeys.length
        || response.catalogs.some(catalog => !sourceKeys.includes(catalog.sourceKey))) throw new Error('Association source keys are not closed.');
      if (response.associations.length !== bodies.length || response.associations.some(association => !expectedKeys.has(association.bodyKey))
        || new Set(response.associations.map(association => association.bodyKey)).size !== bodies.length) throw new Error('Association body keys are not closed.');
      const mapped = (map: Map<string, string>, id: string) => { const value = map.get(id); if (!value) throw new Error('Unknown local catalog identity.'); return value; };
      const catalogs = new Map<string, { window: SourceSnapshot; write: EntityAnalysisWrite; entityIds: Map<string, string>; mentionIds: Map<string, string> }>();
      const catalogIssues = new Map<string, string>();
      for (const [index, window] of windows.entries()) {
        const sourceKey = sourceKeys[index], catalog = response.catalogs.find(item => item.sourceKey === sourceKey)!;
        try {
          const { draft, entityIds, mentionIds } = compileAssociationCatalog(catalog, window, () => this.ports.id());
          const write: EntityAnalysisWrite = { requestId: this.ports.id(), analysisId: this.ports.id(), snapshotId: window.snapshotId, sourceVersion: window.sourceVersion,
            expectedGeneration: 0, expectedHeadRevisionId: null, revision: { ...draft, revisionId: this.ports.id(), revisedAt: at,
              revisedBy: actor, revisionReason: 'Derived candidate catalog; canonical body unchanged.' } };
          catalogs.set(sourceKey, { window, write, entityIds, mentionIds });
        } catch (error) { catalogIssues.set(sourceKey, `${sourceKey}: ${message(error)}`); }
      }
      const associationWrites = bodies.map((body, index) => {
        try {
          const association = response.associations.find(item => item.bodyKey === `b${index}`)!;
          const segmentIds = new Set(body.content.segments.map(segment => segment.segmentId));
          if (association.segmentDecisions.length !== segmentIds.size || new Set(association.segmentDecisions.map(decision => decision.segmentId)).size !== segmentIds.size
            || association.segmentDecisions.some(decision => !segmentIds.has(decision.segmentId))) throw new Error('Association segment decisions are not closed.');
          const bodySources = new Set(body.content.segments.flatMap(segment => segment.evidence).map(evidence => canonicalJson(evidence.source)));
          const bodyKeys = sourceKeys.filter((_, sourceIndex) => bodySources.has(canonicalJson({ snapshotId: windows[sourceIndex].snapshotId, sourceVersion: windows[sourceIndex].sourceVersion })));
          const failures = bodyKeys.flatMap(key => catalogIssues.has(key) ? [catalogIssues.get(key)!] : []);
          if (failures.length) throw new Error(`Required source catalogs rejected: ${failures.join('; ')}`);
          const qualified = (sourceKey: string, entityId: string) => {
            const catalog = catalogs.get(sourceKey);
            if (!catalog || !bodyKeys.includes(sourceKey)) throw new Error(`Unknown or unrelated source catalog: ${sourceKey}.`);
            return { analysisId: catalog.write.analysisId, entityRevisionId: catalog.write.revision.revisionId, entityId: mapped(catalog.entityIds, entityId) };
          };
          const revision = KnowledgeAssociationRevisionSchema.parse({ revisionId: this.ports.id(), bodyRef: knowledgeBodyRef(body),
            status: 'available', reviewStatus: 'pending', catalogRefs: bodyKeys.map(sourceKey => {
              const write = catalogs.get(sourceKey)!.write; return { analysisId: write.analysisId, entityRevisionId: write.revision.revisionId };
            }),
            segmentEntityRefs: association.segmentDecisions.flatMap(decision => decision.entityRefs.map(ref => {
              const catalog = catalogs.get(ref.sourceKey), endpoint = qualified(ref.sourceKey, ref.entityId);
              const segment = body.content.segments.find(item => item.segmentId === decision.segmentId);
              if (!catalog || !segment?.evidence.some(evidence => evidence.source.snapshotId === catalog.window.snapshotId && evidence.source.sourceVersion === catalog.window.sourceVersion)) {
                throw new Error(`Segment does not bind source catalog: ${ref.sourceKey}.`);
              }
              const mentionIds = ref.mentionKeys.map(key => mapped(catalog.mentionIds, associationMentionKey(ref.entityId, key)));
              if (mentionIds.some(id => !catalog.write.revision.mentions.some(mention => mention.mentionId === id && mention.entityId === endpoint.entityId))) {
                throw new Error(`Mention does not belong to entity in source catalog: ${ref.sourceKey}.`);
              }
              return { segmentId: decision.segmentId, ...endpoint, mentionIds };
            })),
            ...(association.typedRelations === null ? {} : { typedRelations: association.typedRelations.map(relation => {
              const { object, evidence: locators, ...fields } = relation;
              return { ...fields, subject: qualified(relation.subject.sourceKey, relation.subject.entityId),
                ...(object ? { object: qualified(object.sourceKey, object.entityId) } : {}),
                evidence: locators.map(locator => {
                  const segment = body.content.segments.find(item => item.segmentId === locator.segmentId), evidence = segment?.evidence[locator.evidenceIndex];
                  if (!evidence || !relation.segmentIds.includes(locator.segmentId)) throw new Error('Unknown body evidence index.'); return evidence;
                }) };
            }) }), issues: [...association.issues, ...association.segmentDecisions.filter(decision => decision.decisionKind === 'abstained')
              .flatMap(decision => [`AI association abstained for ${decision.segmentId}; reason follows.`, decision.reason])], revisedAt: at, revisedBy: actor, revisionReason: 'Independent derived association; pending review.' });
          validateKnowledgeAssociationReferences(revision, body); return command(body, revision);
        } catch (error) { return failed(body, message(error)); }
      });
      return { ...stage, state: 'prepared_writes', entityWrites: [...catalogs.values()].map(catalog => catalog.write),
        issues: [...stage.issues, ...catalogIssues.values()], associationWrites };
    } catch (error) { return { ...stage, state: 'prepared_writes', issues: [...stage.issues, message(error)], associationWrites: bodies.map(body => failed(body, message(error))) }; }
  }
}
