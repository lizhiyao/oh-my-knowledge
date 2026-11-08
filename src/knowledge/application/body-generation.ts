import type { KnowledgeActor, KnowledgeBodyRef, KnowledgeRevision } from '../contracts.js';
import type { KnowledgeStore, KnowledgeWrite } from '../store.js';
import { canonicalJson } from '../store.js';
import type { SourceStore } from '../source-store.js';
import { sourceSetPreimage, type SourceRef, type SourceSnapshot } from '../sources.js';
import { generationImportRunId, generationSourceInput, generationSourceMetadata, bodyGenerationSources, SOURCE_GENERATION_INPUT_VERSION, WRITING_DRAFT_INPUT_VERSION, BODY_GENERATION_INPUT_VERSION, WORKFLOW_ID } from '../extraction/source-input.js';
import type { EntityAnalysisStore, EntityAnalysisWrite } from '../entities/contracts.js';
import type { KnowledgeAssociationStore, KnowledgeAssociationWrite } from '../associations.js';
import { KnowledgeAssociationRevisionSchema, validateKnowledgeAssociationReferences } from '../associations.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../adapters/body-digest.js';
import type { KnowledgeGenerationModel, KnowledgeGenerationProfile } from '../adapters/generation-executor.js';
import { MAX_GENERATION_OUTCOME_BYTES } from '../adapters/generation-journal-store.js';
import { GENERATION_JOURNAL_SCHEMA_VERSION, generationJournalAttempts, isBodyPublicationStage, isInterruptedGenerationOutcome,
  MAX_BODY_WINDOW_IN_FLIGHT, type GenerationJournal, type GenerationJournalStore, type GenerationStage } from '../extraction/generation-journal.js';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE, checkGeneratedAssociations, checkGeneratedBodies,
  generationTextDigest } from '../extraction/body-generation-wire.js';
import { WRITING_DRAFT_PROFILE, checkWritingDraft } from '../extraction/writing-draft.js';
import { BODY_WINDOW_PROFILE, longBodyWindowInputs, bodyWindowInput, checkLongBodyWindowOutput,
  collectLongBodyWindows, createLongBodyPlan } from '../extraction/long-body.js';
import { associationMentionKey, compileAssociationCatalog } from '../extraction/association-catalog.js';
import { observeGenerationException, type GenerationOutcome, type GenerationOutcomeRef } from '../extraction/native-outcome.js';

import { SourceReviewApplication } from './source-review.js';
import { readSourceReviewOriginal } from '../adapters/source-review-original.js';
import { sourceReviewRevisionDigest } from '../adapters/source-review-store.js';
import { sourceCoverageUnresolved } from '../source-review-history.js';
import { SourceCoverageWriteSchema, type SourceLedgerStore, type SourceCoverageStore,
  type SourceLedgerRef, type SourceLedgerWrite } from '../source-review.js';
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
const LONG_CODEX_SOURCE_INPUT_BYTES = 512 * 1024;
const MAX_GENERATION_REQUEST_BYTES = 1024 * 1024;
const cleanNativeOutput = (outcome: GenerationOutcome) => outcome.outcomeKind === 'result' && outcome.result.ok
  && outcome.result.refusal === undefined && outcome.result.failure === undefined
  && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length === 0)
  && typeof outcome.result.output === 'string' ? outcome.result.output : undefined;
type AssociationAppend = Extract<KnowledgeAssociationWrite, { commandKind: 'append_revision' }>;
const profiles: Record<GenerationStage['stageKind'], KnowledgeGenerationProfile> = {
  source_ledger: SOURCE_LEDGER_GENERATION_PROFILE, body_draft: WRITING_DRAFT_PROFILE, body: BODY_GENERATION_PROFILE,
  source_coverage: SOURCE_COVERAGE_GENERATION_PROFILE, association: ASSOCIATION_GENERATION_PROFILE,
  body_window: BODY_WINDOW_PROFILE,
};
function currentStage(stage: GenerationStage): boolean {
  const profile = profiles[stage.stageKind];
  return stage.profileId === profile.profileId && stage.wireId === profile.wireId && stage.promptVersion === profile.promptVersion
    && stage.system === profile.system && same(stage.wireSchema, profile.wireSchema);
}
function preparedWindows(journal: GenerationJournal) {
  return journal.stages.flatMap((stage, index) => stage.state === 'prepared' ? [{ stage, index }] : []);
}
function windowBatchRequestDigest(journal: GenerationJournal) {
  return generationTextDigest(canonicalJson({ runId: journal.runId, dispatchVersion: 'knowledge-window-dispatch/v1',
    windows: preparedWindows(journal).map(({ index, stage }) => ({ index, invocationId: stage.invocationId, requestDigest: stage.requestDigest })) }));
}
/** Stored write intents replay exactly. Neither recovery nor successful analysis supplies a semantic decision. */
export function generationNextAction(journal: GenerationJournal) {
  if (journal.status === 'active' && journal.stages.at(-1)?.state !== 'prepared_writes' && journal.stages.some(stage => !currentStage(stage))) return 'unsupported' as const;
  if (journal.bodyPlan) {
    const last = journal.stages.at(-1), preceding = journal.stages.slice(0, -1);
    if (last?.state === 'prepared_writes') return 'resume_publication' as const;
    if (journal.stages.some(stage => stage.state === 'claimed')) return 'outcome_unknown_do_not_redispatch' as const;
    if (preceding.some(stage => stage.state === 'archived') || last?.state === 'archived'
      && (journal.status === 'active' && preceding.every(stage => stage.state === 'completed'))) return 'resume_publication' as const;
    if (journal.status !== 'active') return 'none' as const;
    if (journal.stages.some(stage => stage.state === 'interrupted')) return 'prepare_next_stage' as const;
    return preparedWindows(journal).length ? 'continue_stage' as const : 'none' as const;
  }
  const pending = journal.stages.find(stage => !['completed', 'failed'].includes(stage.state));
  return pending?.state === 'prepared' ? 'continue_stage' as const
    : pending?.state === 'claimed' ? 'outcome_unknown_do_not_redispatch' as const
      : pending ? 'resume_publication' as const : journal.status !== 'active' ? 'none' as const
        : 'prepare_next_stage' as const;
}
/** Each explicit phase is separately confirmed, claimed once and archived before publication. */
export class BodyGenerationApplication {
  private held?: { runId: string; invocationId: string; outcome: GenerationOutcome };
  private readonly heldWindows = new Map<string, { runId: string; outcome: GenerationOutcome }>();
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
    return { ...this.state(journal), nativeOutcomes: generationJournalAttempts(journal).map(stage => ({ stageKind: stage.stageKind,
      invocationId: stage.invocationId, ...(stage.outcomeRef ? { outcome: this.ports.journals.outcome(journal, stage) } : {}) })) };
  }
  private required(runId: string) { const j = this.ports.journals.read(runId); if (!j) throw new Error('Generation journal is missing.'); return j; }
  private persist(j: GenerationJournal, validateClaim?: (journal: GenerationJournal, stage: GenerationStage) => void) {
    this.ports.assertWritable?.(); return this.ports.journals.write({ ...j, generation: j.generation + 1 }, j.generation, validateClaim);
  }
  private state(journal: GenerationJournal) {
    const nextAction = generationNextAction(journal);
    return { journal, nextAction, batchRequestDigest: journal.bodyPlan && nextAction === 'continue_stage' ? windowBatchRequestDigest(journal) : undefined };
  }
  private snapshot(sourceRef: GenerationJournal['sources'][number]) {
    const source = this.ports.sources.read(sourceRef.snapshotId, sourceRef.sourceVersion);
    if (source.status !== 'available') throw new Error(`Generation source unavailable: ${source.reason}.`);
    if (generationTextDigest(canonicalJson(source.snapshot)) !== sourceRef.sourceDigest) throw new Error('Generation source snapshot changed.');
    return source.snapshot;
  }
  private phase(model: KnowledgeGenerationModel, profile: KnowledgeGenerationProfile, input: string): GenerationStage {
    if (Buffer.byteLength(profile.system, 'utf8') + Buffer.byteLength(input, 'utf8') > MAX_GENERATION_REQUEST_BYTES) throw new Error('Knowledge model request capacity_exceeded (1 MiB).');
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
    const executionRef = journal.bodyPlan ? `window-batch/${journal.runId}/${stage.invocationId}` : `${journal.runId}:${stage.invocationId}`;
    return { actorKind: 'agent', actorId: `extractor:${journal.executor}`, executionRef };
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
  private writingInput(journal: GenerationJournal): string {
    return canonicalJson({ inputVersion: WRITING_DRAFT_INPUT_VERSION, sourceSetId: journal.sourceSetId,
      sources: journal.sources.map(source => this.snapshot(source)).map(generationSourceInput) });
  }
  private writingDraft(journal: GenerationJournal) {
    const stage = journal.stages.find(s => s.stageKind === 'body_draft'), ref = journal.writingDraftRef;
    if (!stage || stage.state !== 'completed' || !currentStage(stage) || !ref || !stage.outcomeRef
      || ref.runId !== journal.runId || ref.invocationId !== stage.invocationId || ref.requestDigest !== stage.requestDigest
      || ref.archiveDigest !== stage.outcomeRef.digest || stage.input !== this.writingInput(journal)) throw new Error('Exact archived writing draft is required.');
    const outcome = this.ports.journals.outcome(journal, stage);
    if (!outcome || outcome.outcomeKind !== 'result' || !outcome.result.ok || outcome.result.refusal !== undefined
      || outcome.result.failure !== undefined || outcome.cleanupFailure || stage.issues.length
      || Array.isArray(outcome.result.toolCalls) && outcome.result.toolCalls.length || typeof outcome.result.output !== 'string'
      || generationTextDigest(outcome.result.output) !== ref.outputDigest) throw new Error('Writing draft native identity mismatch.');
    return { ref, text: checkWritingDraft(outcome.result.output) };
  }
  private bodyInput(journal: GenerationJournal): string {
    return canonicalJson({ inputVersion: BODY_GENERATION_INPUT_VERSION, sourceSetId: journal.sourceSetId,
      ...bodyGenerationSources(journal.sources.map(source => this.snapshot(source))),
      writingDraft: this.writingDraft(journal) });
  }
  private longBodyInput(journal: GenerationJournal, ordinal: number): string {
    if (!journal.bodyPlan) throw new Error('An exact long body window plan is required.');
    return bodyWindowInput(journal.sources.map(source => this.snapshot(source)), journal.sourceSetId, journal.bodyPlan, ordinal);
  }
  private windowOutputs(journal: GenerationJournal, finalOutput: string): string[] {
    return journal.stages.map((stage, index, windows) => {
      if (index === windows.length - 1) return finalOutput;
      const outcome = this.ports.journals.outcome(journal, stage);
      const output = outcome && cleanNativeOutput(outcome);
      if (stage.state !== 'completed' || !stage.outcomeRef || stage.issues.length || outcome?.cleanupFailure || output === undefined) {
        throw new Error('Every planned body window needs an exact completed native outcome.');
      }
      return output;
    });
  }
  private coverageInput(journal: GenerationJournal): string {
    return sourceCoverageModelInput(journal.sources.map(source => this.snapshot(source)), this.ledger(journal), this.bodies(journal));
  }
  private associationInput(journal: GenerationJournal): string {
    const bodies = this.bodies(journal);
    if (bodies.some(body => body.content.segments.some(segment => segment.evidence.some(evidence =>
      !journal.sources.some(source => source.snapshotId === evidence.source.snapshotId && source.sourceVersion === evidence.source.sourceVersion))))) {
      throw new Error('Association sources omit a body evidence source.');
    }
    return canonicalJson({ inputVersion: SOURCE_GENERATION_INPUT_VERSION, sourceSetId: journal.sourceSetId,
      sources: journal.sources.map(source => this.snapshot(source)).map(generationSourceInput), bodies: bodies.map((body, index) => ({ bodyKey: `b${index}`,
        bodyRef: knowledgeBodyRef(body), title: body.title, content: body.content, reuseRationale: body.reuseRationale })) });
  }
  private idle(signal?: AbortSignal) {
    this.ports.assertWritable?.(); signal?.throwIfAborted();
    if (this.inFlight || this.held || this.heldWindows.size) throw new Error('A generation outcome is in flight or awaiting durable archive.');
  }
  private seed(sources: readonly SourceRef[], model: KnowledgeGenerationModel, runId: string, mode: GenerationJournal['mode'], bodies: KnowledgeBodyRef[] = []) {
    if (this.ports.journals.list().unsupported.length) throw new Error('Use a new workspace or an explicit independent-copy workflow migration before creating a workflow11 run.');
    const sourceSet = sourceSetPreimage(sources);
    const snapshots = sourceSet.sources.map(ref => {
      const source = this.ports.sources.read(ref.snapshotId, ref.sourceVersion);
      if (source.status !== 'available') throw new Error(`Generation source unavailable: ${source.reason}.`); return source.snapshot;
    });
    return { storeKind: 'knowledge-generation-journal' as const, schemaVersion: GENERATION_JOURNAL_SCHEMA_VERSION, workflowId: WORKFLOW_ID,
      inputVersion: SOURCE_REVIEW_INPUT_VERSION, sourceSetId: generationTextDigest(canonicalJson(sourceSet)),
      runId, generation: 1, mode, status: 'active' as const, createdAt: this.ports.now(), actor: this.ports.actor,
      sources: snapshots.map(snapshot => ({ snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion, sourceDigest: generationTextDigest(canonicalJson(snapshot)) })),
      executor: model.executor, model: model.model, timeoutMs: model.timeoutMs, bodies, stages: [] as GenerationStage[] };
  }
  private sameModel(j: GenerationJournal, model: KnowledgeGenerationModel) {
    if (j.executor !== model.executor || j.model !== model.model || j.timeoutMs !== model.timeoutMs) throw new Error('Generation continuation model changed.');
  }
  prepareGeneration(sources: readonly SourceRef[], model: KnowledgeGenerationModel, runId?: string, signal?: AbortSignal) {
    return this.prepareBody(sources, model, true, runId, signal);
  }
  private prepareBody(sources: readonly SourceRef[], model: KnowledgeGenerationModel, prepareWindowRetry: boolean, runId?: string, signal?: AbortSignal) {
    const sourceSetId = generationTextDigest(canonicalJson(sourceSetPreimage(sources)));
    runId ??= generationImportRunId(sourceSetId);
    const existing = this.ports.journals.read(runId);
    if (existing) {
      if (existing.mode !== 'generate' || existing.sourceSetId !== sourceSetId) throw new Error('Generation request conflicts with existing journal.');
      this.sameModel(existing, model);
      if (existing.bodyPlan) {
        if (!prepareWindowRetry || generationNextAction(existing) !== 'prepare_next_stage') return this.state(existing);
        this.idle(signal);
        const bodyAttempts = [...(existing.bodyAttempts ?? [])];
        const stages = existing.stages.map((stage, index) => {
          if (stage.state !== 'interrupted') return stage;
          const replacement = this.phase(model, BODY_WINDOW_PROFILE, stage.input);
          if (replacement.requestDigest !== stage.requestDigest) throw new Error('Interrupted window request changed.');
          bodyAttempts.push({ windowIndex: index, stage });
          return replacement;
        });
        return this.state(this.persist({ ...existing, stages, bodyAttempts }));
      }
      if (existing.status !== 'active' || generationNextAction(existing) === 'unsupported' || existing.stages.at(-1)!.state !== 'completed') return this.state(existing);
      this.idle(signal);
      const last = existing.stages.at(-1)!;
      if (last.stageKind !== 'body_draft') throw new Error('Generation body-first phase order mismatch.');
      const phase = this.phase(model, BODY_GENERATION_PROFILE, this.bodyInput(existing));
      return this.state(this.persist({ ...existing, stages: [...existing.stages, phase] }));
    }
    this.idle(signal);
    const seed = this.seed(sources, model, runId, 'generate');
    if (model.executor === 'codex') {
      const snapshots = seed.sources.map(source => this.snapshot(source));
      const projection = bodyGenerationSources(snapshots);
      const fullInput = canonicalJson({ inputVersion: BODY_GENERATION_INPUT_VERSION, sourceSetId, ...projection });
      if (Buffer.byteLength(fullInput) > LONG_CODEX_SOURCE_INPUT_BYTES) {
        if (!this.ports.knowledge.commitBodyBatch) throw new Error('The knowledge store does not support durable body batches.');
        const bodyPlan = createLongBodyPlan(snapshots);
        const bodySourceMetadata = projection.sources.map(({ source }) => generationSourceMetadata(source));
        const stages = longBodyWindowInputs(snapshots, sourceSetId, bodyPlan).map(input => this.phase(model, BODY_WINDOW_PROFILE, input));
        return this.state(this.ports.journals.write({ ...seed, bodyPlan, bodySourceMetadata, stages }, 0));
      }
    }
    const stage = this.phase(model, WRITING_DRAFT_PROFILE, this.writingInput(seed));
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
    const j = this.prepareBody(sources, model, false, runId, signal).journal;
    if (j.bodyPlan) {
      if (j.generation !== 1 || generationNextAction(j) !== 'continue_stage') return this.resume(j.runId);
      const first = { stage: j.stages[0], index: 0 };
      if (options.confirmedRequestDigest !== first.stage.requestDigest) throw new Error('Confirm the exact prepared generation request before dispatch.');
      return this.runWindowJobs(j, [first], model, 1, signal, options);
    }
    if (j.status !== 'active' || j.stages.length !== 1 || j.stages[0].state !== 'prepared') return this.resume(j.runId);
    return this.state(await this.invoke(j, model, signal, options));
  }
  prepareAssociationRebuild(sources: readonly SourceRef[], bodyRefs: readonly KnowledgeBodyRef[], model: KnowledgeGenerationModel,
    runId = this.ports.id(), signal?: AbortSignal) {
    const existing = this.ports.journals.read(runId), sourceSetId = generationTextDigest(canonicalJson(sourceSetPreimage(sources)));
    if (existing) {
      if (existing.mode !== 'rebuild_associations' || existing.sourceSetId !== sourceSetId || !same(existing.bodies, bodyRefs)) throw new Error('Association rebuild conflicts with existing journal.');
      this.sameModel(existing, model); return this.state(existing);
    }
    this.idle(signal);
    if (!bodyRefs.length || bodyRefs.length > 256 || new Set(bodyRefs.map(canonicalJson)).size !== bodyRefs.length) throw new Error('Association rebuild requires distinct exact body references.');
    if (new Set(bodyRefs.map(ref => ref.knowledgeId)).size !== bodyRefs.length) throw new Error('Association rebuild selects at most one revision per knowledge identity.');
    const seed = this.seed(sources, model, runId, 'rebuild_associations', [...bodyRefs]);
    return this.state(this.ports.journals.write({ ...seed, stages: [this.phase(model, ASSOCIATION_GENERATION_PROFILE, this.associationInput(seed))] }, 0));
  }
  async rebuild(sources: readonly SourceRef[], bodyRefs: readonly KnowledgeBodyRef[], model: KnowledgeGenerationModel,
    runId?: string, signal?: AbortSignal, options: KnowledgeGenerationOptions = {}) {
    const j = this.prepareAssociationRebuild(sources, bodyRefs, model, runId, signal).journal;
    if (j.status !== 'active' || j.stages.at(-1)?.state !== 'prepared') return this.resume(j.runId);
    return this.state(await this.invoke(j, model, signal, options));
  }
  async continueStage(runId: string, expectedGeneration: number, model: KnowledgeGenerationModel, signal?: AbortSignal, options: KnowledgeGenerationOptions = {}) {
    this.ports.assertWritable?.(); const j = this.required(runId);
    if (j.generation !== expectedGeneration || j.status !== 'active') throw new Error('Generation continuation conflict.');
    if (generationNextAction(j) === 'unsupported') throw new Error('Generation profile changed; use the preserved matching build to recover this run.');
    this.sameModel(j, model);
    if (j.bodyPlan) {
      const job = preparedWindows(j).find(({ stage }) => stage.requestDigest === options.confirmedRequestDigest);
      if (generationNextAction(j) !== 'continue_stage' || !job) {
        throw new Error('Confirm the exact prepared generation request before dispatch.');
      }
      return this.runWindowJobs(j, [job], model, 1, signal, options);
    }
    if (j.stages.at(-1)!.state !== 'prepared') throw new Error('Prepare the next request; only a never-claimed phase may be continued.');
    return this.state(await this.invoke(j, model, signal, options));
  }
  async continueWindows(runId: string, expectedGeneration: number, model: KnowledgeGenerationModel, concurrency: 1 | 2,
    signal?: AbortSignal, options: KnowledgeGenerationOptions = {}) {
    const j = this.required(runId);
    if (j.generation !== expectedGeneration || !j.bodyPlan || generationNextAction(j) !== 'continue_stage') throw new Error('Window batch continuation conflict.');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_BODY_WINDOW_IN_FLIGHT) throw new Error('Invalid window concurrency.');
    this.sameModel(j, model);
    if (options.confirmedRequestDigest !== windowBatchRequestDigest(j)) throw new Error('Confirm the exact prepared window batch before dispatch.');
    return this.runWindowJobs(j, preparedWindows(j), model, concurrency, signal, options);
  }
  private validateClaim(j: GenerationJournal, stage: GenerationStage) {
    if (!currentStage(stage)) throw new Error('Generation profile changed before claim.');
    const sources = j.sources.map(source => this.snapshot(source));
    const input = stage.stageKind === 'source_ledger' ? sourceLedgerModelInput(sources) : stage.stageKind === 'body_draft' ? this.writingInput(j) : stage.stageKind === 'body' ? this.bodyInput(j)
      : stage.stageKind === 'body_window' ? this.longBodyInput(j, j.stages.findIndex(s => s.invocationId === stage.invocationId))
        : stage.stageKind === 'source_coverage' ? this.coverageInput(j) : this.associationInput(j);
    if (input !== stage.input) throw new Error('Generation complete request changed before claim.');
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
  private updateWindow(journal: GenerationJournal, index: number, stage: GenerationStage,
    validateClaim?: (journal: GenerationJournal, stage: GenerationStage) => void) {
    return this.persist({ ...journal, stages: journal.stages.map((s, i) => i === index ? stage : s),
      status: stage.state === 'failed' ? 'failed' : journal.status }, validateClaim);
  }
  private async runWindowJobs(journal: GenerationJournal, jobs: ReturnType<typeof preparedWindows>, model: KnowledgeGenerationModel,
    concurrency: 1 | 2, signal: AbortSignal | undefined, options: KnowledgeGenerationOptions) {
    this.idle();
    const reconciled = this.advanceWindows(journal);
    if (reconciled.generation !== journal.generation) return this.state(reconciled);
    const { runId } = journal, claims = new Set<string>();
    this.inFlight = runId;
    let cursor = 0, halted = false;
    const work = async () => {
      while (!halted && !signal?.aborted && cursor < jobs.length) {
        const { index, stage } = jobs[cursor++];
        try {
          const saved = await this.invokeWindow(runId, index, stage, model, claims, signal, options);
          if (saved.status !== 'active' || saved.stages.some(s => s.state === 'interrupted')) halted = true;
        } catch (error) {
          halted = true;
          if (!signal?.aborted || error !== signal.reason) throw error;
        }
      }
    };
    try {
      const workers = await Promise.allSettled(Array.from({ length: Math.min(jobs.length, concurrency) }, work));
      const failure = workers.find(worker => worker.status === 'rejected');
      if (failure) throw failure.reason;
      return this.state(this.required(runId));
    } finally { this.inFlight = undefined; }
  }
  private async invokeWindow(runId: string, index: number, stage: GenerationStage, model: KnowledgeGenerationModel, claims: Set<string>,
    signal: AbortSignal | undefined, options: KnowledgeGenerationOptions) {
    if (!currentStage(stage) || !same(model.inspect(BODY_WINDOW_PROFILE, stage.input), stage.producer)) throw new Error('Generation producer/profile changed.');
    const outcome = await model.invoke(BODY_WINDOW_PROFILE, stage.input, signal, () => {
      signal?.throwIfAborted();
      const j = this.required(runId), pending = j.stages[index];
      if (j.status !== 'active' || pending.state !== 'prepared' || pending.invocationId !== stage.invocationId
        || j.stages.some(s => s.state === 'interrupted' || s.state === 'claimed' && !claims.has(s.invocationId))) {
        throw new Error('Window dispatch conflicts with a changed or unresolved run.');
      }
      options.beforeDispatch?.({ runId, invocationId: stage.invocationId, stageKind: stage.stageKind, requestDigest: stage.requestDigest });
      this.updateWindow(j, index, { ...pending, state: 'claimed' }, (next, claimed) => this.validateClaim(next, claimed));
      claims.add(stage.invocationId);
    });
    if (!claims.has(stage.invocationId)) throw new Error('Native adapter did not prove exactly one window dispatch claim.');
    this.heldWindows.set(stage.invocationId, { runId, outcome });
    const j = this.archiveWindow(this.required(runId), index, outcome);
    claims.delete(stage.invocationId);
    options.onOutcomeArchived?.({ runId, invocationId: stage.invocationId, stageKind: stage.stageKind, outcome, ref: j.stages[index].outcomeRef! });
    return this.advanceWindows(j);
  }
  private archiveWindow(journal: GenerationJournal, index: number, outcome: GenerationOutcome) {
    const stage = journal.stages[index], outcomeRef = this.ports.journals.archive(journal, stage, outcome);
    // Once the original is durable, recovery can reattach it even if the journal write is interrupted.
    this.heldWindows.delete(stage.invocationId);
    return stage.state === 'claimed' ? this.updateWindow(journal, index, { ...stage, state: 'archived', outcomeRef }) : journal;
  }
  private advanceWindows(journal: GenerationJournal) {
    const plan = journal.bodyPlan!, final = journal.stages.length - 1;
    let j = journal;
    for (const [index, stage] of j.stages.entries()) {
      if (stage.state !== 'archived') continue;
      const outcome = this.ports.journals.outcome(j, stage);
      if (!outcome) throw new Error('Native window outcome missing.');
      const output = cleanNativeOutput(outcome);
      if (isInterruptedGenerationOutcome(outcome) && !stage.issues.length) {
        const exhausted = j.bodyAttempts?.some(attempt => attempt.windowIndex === index);
        j = this.updateWindow(j, index, { ...stage, state: exhausted ? 'failed' : 'interrupted',
          issues: [exhausted ? 'Body window interruption retry exhausted.' : 'Body window cancelled or timed out with a terminal native receipt.'] });
        continue;
      }
      try {
        if (output === undefined || outcome.cleanupFailure || stage.issues.length) throw new Error('Body window native execution did not complete cleanly.');
        checkLongBodyWindowOutput(output, j.sources.map(source => this.snapshot(source)), plan, index);
      } catch (error) {
        j = this.updateWindow(j, index, { ...stage, state: 'failed', issues: [...stage.issues, message(error)] });
        continue;
      }
      if (index !== final) j = this.updateWindow(j, index, { ...stage, state: 'completed' });
    }
    const last = j.stages[final];
    if (last.state === 'prepared_writes' || last.state === 'archived' && j.status === 'active'
      && j.stages.slice(0, final).every(stage => stage.state === 'completed')) return this.finish(j);
    return j;
  }
  private resumeWindows(journal: GenerationJournal) {
    if (generationJournalAttempts(journal).some(stage => this.heldWindows.has(stage.invocationId)
      || ['claimed', 'archived', 'prepared_writes'].includes(stage.state))) this.ports.assertWritable?.();
    for (const { stage } of journal.bodyAttempts ?? []) {
      const held = this.heldWindows.get(stage.invocationId);
      if (held?.runId !== journal.runId) continue;
      this.ports.journals.archive(journal, stage, held.outcome);
      this.heldWindows.delete(stage.invocationId);
    }
    let j = journal;
    for (const [index, stage] of j.stages.entries()) {
      const held = this.heldWindows.get(stage.invocationId);
      const outcome = held?.runId === j.runId ? held.outcome : stage.state === 'claimed' ? this.ports.journals.outcome(j, stage) : undefined;
      if (outcome) j = this.archiveWindow(j, index, outcome);
    }
    return this.advanceWindows(j);
  }
  /** Zero-model recovery attaches original evidence and replays only fixed publication intents. */
  resume(runId: string) {
    let j = this.required(runId), stage = j.stages.at(-1)!;
    if (this.inFlight === runId || generationNextAction(j) === 'unsupported') return this.state(j);
    if (j.bodyPlan) return this.state(this.resumeWindows(j));
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
    const index = j.stages.length - 1, publishesBody = isBodyPublicationStage(j, index);
    let stage = j.stages[index];
    if (stage.state === 'archived') {
      if (!currentStage(stage)) return j;
      const outcome = this.ports.journals.outcome(j, stage); if (!outcome) throw new Error('Native outcome missing.');
      const output = cleanNativeOutput(outcome);
      if (stage.stageKind === 'body_draft') {
        try {
          if (output === undefined || outcome.cleanupFailure || stage.issues.length || !stage.outcomeRef) throw new Error('Writing draft native execution did not complete cleanly.');
          checkWritingDraft(output);
          j = { ...j, writingDraftRef: { runId: j.runId, invocationId: stage.invocationId,
            requestDigest: stage.requestDigest, archiveDigest: stage.outcomeRef.digest, outputDigest: generationTextDigest(output) } };
          stage = { ...stage, state: 'completed' };
        } catch (error) { stage = { ...stage, state: 'failed', issues: [...stage.issues, message(error)] }; }
      } else if (publishesBody) {
        try {
          if (output === undefined || outcome.cleanupFailure || stage.issues.length) throw new Error('Body native execution did not complete cleanly.');
          const sources = j.sources.map(source => this.snapshot(source));
          const checked = j.bodyPlan
            ? collectLongBodyWindows(sources, j.bodyPlan, this.windowOutputs(j, output))
            : checkGeneratedBodies(output, sources);
          const at = this.ports.now();
          const writes: KnowledgeWrite[] = checked.accepted.map(candidate => {
            const actor = this.actor(j, 'windowOrdinal' in candidate && typeof candidate.windowOrdinal === 'number' ? j.stages[candidate.windowOrdinal] : stage);
            const { draft } = candidate;
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
    const writes = publishesBody ? (stage.bodyWrites ?? []) : stage.stageKind === 'association'
      ? [...(stage.entityWrites ?? []), ...(stage.associationWrites ?? [])] : stage.stageKind === 'source_ledger' ? (stage.ledgerWrites ?? []) : (stage.coverageWrites ?? []);
    for (let i = stage.committed; i < writes.length; i++) {
      const write = writes[i];
      if (publishesBody) {
        const body = write as KnowledgeWrite;
        if (body.commandKind !== 'append_revision') throw new Error('Generation body publication requires a revision.');
        this.ports.knowledge.write(body, body.revision.revisedBy);
      } else if (stage.stageKind === 'source_ledger') this.review(actor).writeLedger(write);
      else if (stage.stageKind === 'source_coverage') this.review(actor).writeCoverage(write);
      else if ('analysisId' in write) this.ports.entities.write(write as EntityAnalysisWrite, actor);
      else this.ports.associations.write(write as KnowledgeAssociationWrite, actor);
      stage = { ...stage, committed: i + 1 };
      const bindings = publishesBody && !j.bodyPlan ? { bodies: (stage.bodyWrites ?? []).slice(0, i + 1)
        .flatMap(w => w.commandKind === 'append_revision' ? [knowledgeBodyRef(w.revision)] : []) }
        : stage.stageKind === 'source_ledger' ? { ledgerRef: { ledgerId: stage.ledgerWrites![0].ledgerId,
          revisionId: stage.ledgerWrites![0].revision.revisionId, digest: stage.ledgerWrites![0].revision.digest } }
          : stage.stageKind === 'source_coverage' ? { coverageRef: { coverageId: stage.coverageWrites![0].coverageId,
            revisionId: stage.coverageWrites![0].revision.revisionId, digest: stage.coverageWrites![0].revision.digest } } : {};
      j = this.persist({ ...j, ...bindings, stages: j.stages.map((s, n) => n === index ? stage : s) });
    }
    if (j.bodyPlan) {
      const { knowledge } = this.ports;
      if (!knowledge.commitBodyBatch) throw new Error('The knowledge store does not support durable body batches.');
      const bodies = (stage.bodyWrites ?? []).flatMap(write => write.commandKind === 'append_revision' ? [knowledgeBodyRef(write.revision)] : []);
      knowledge.commitBodyBatch(j.runId, bodies);
      j = { ...j, bodies };
    }
    stage = { ...stage, state: 'completed' };
    return this.persist({ ...j, stages: j.stages.map((s, n) => n === index ? stage : s),
      status: stage.stageKind === 'association' || j.mode === 'generate' && publishesBody
        || j.mode === 'review_sources' && stage.stageKind === 'source_coverage' ? 'completed' : 'active' });
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
          if (association.typedRelations === null) throw new Error('Requested typed relation projection was not returned.');
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
