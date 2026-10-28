import type { KnowledgeActor, KnowledgeBodyRef, KnowledgeRevision } from '../contracts.js';
import type { KnowledgeStore, KnowledgeWrite } from '../store.js';
import { canonicalJson } from '../store.js';
import type { EvidenceStore, EvidenceWindow } from '../extraction/evidence.js';
import type { EntityAnalysisStore, EntityAnalysisWrite } from '../entities/contracts.js';
import { EntityAnalysisDraftSchema } from '../entities/contracts.js';
import { validateEntityAnalysis, validateEntityMentionSelection } from '../entities/validation.js';
import { mapEntityIdentity } from '../entities/identity.js';
import type { KnowledgeAssociationStore, KnowledgeAssociationWrite } from '../associations.js';
import { KnowledgeAssociationRevisionSchema, validateKnowledgeAssociationReferences } from '../associations.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../adapters/body-digest.js';
import type { KnowledgeGenerationModel } from '../adapters/generation-executor.js';
import { MAX_GENERATION_OUTCOME_BYTES } from '../adapters/generation-journal-store.js';
import type { GenerationJournal, GenerationJournalStore, GenerationStage } from '../extraction/generation-journal.js';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE, checkGeneratedAssociations, checkGeneratedBodies,
  generationTextDigest, type GenerationProfile } from '../extraction/body-generation-wire.js';
import { locateQuoteOccurrence } from '../extraction/quote-occurrence.js';
import { observeGenerationException, type GenerationOutcome, type GenerationOutcomeRef } from '../extraction/native-outcome.js';

export interface BodyGenerationPorts {
  evidence: EvidenceStore; knowledge: KnowledgeStore; entities: EntityAnalysisStore;
  associations: KnowledgeAssociationStore; journals: GenerationJournalStore;
  actor: KnowledgeActor; id(): string; now(): string;
}
export interface KnowledgeGenerationOptions {
  beforeDispatch?: (claim: { runId: string; invocationId: string; stageKind: 'body' | 'association'; requestDigest: string }) => void;
  onOutcomeArchived?: (event: { runId: string; invocationId: string; stageKind: 'body' | 'association'; outcome: GenerationOutcome; ref: GenerationOutcomeRef }) => void;
}
const sourceInput = (window: EvidenceWindow) => ({ source: { snapshotId: window.snapshotId, sourceVersion: window.sourceVersion,
  sourceKind: window.sourceKind, ...(window.origin ? { origin: { threadId: window.origin.threadId, title: window.origin.title,
    ...(window.origin.turnId ? { turnId: window.origin.turnId } : {}) } } : {}) },
excerpts: window.excerpts, limitations: window.limitations });
const message = (error: unknown) => observeGenerationException(error).message || 'Host validation failed.';
type AssociationAppend = Extract<KnowledgeAssociationWrite, { commandKind: 'append_revision' }>;
/** Body and association are separate native stages; saved body is never rolled back by derived failure. */
export class BodyGenerationApplication {
  private held?: { runId: string; invocationId: string; outcome: GenerationOutcome };
  private inFlight?: string;
  constructor(private readonly ports: BodyGenerationPorts) {}
  inspect(runId: string) {
    const journal = this.required(runId);
    return { ...this.state(journal), nativeOutcomes: journal.stages.map(stage => ({ stageKind: stage.stageKind,
      invocationId: stage.invocationId, ...(stage.outcomeRef ? { outcome: this.ports.journals.outcome(journal, stage) } : {}) })) };
  }
  private required(runId: string) { const j = this.ports.journals.read(runId); if (!j) throw new Error('Generation journal is missing.'); return j; }
  private persist(j: GenerationJournal) { return this.ports.journals.write({ ...j, generation: j.generation + 1 }, j.generation); }
  private state(journal: GenerationJournal) {
    const pending = journal.stages.find(s => !['completed', 'failed'].includes(s.state));
    return { journal, nextAction: pending?.state === 'prepared' ? 'continue_stage' as const
      : pending?.state === 'claimed' ? 'outcome_unknown_do_not_redispatch' as const
        : pending ? 'resume_publication' as const : journal.status === 'active' ? 'continue_stage' as const : 'none' as const };
  }
  private window(journal: Pick<GenerationJournal, 'snapshotId' | 'sourceVersion' | 'sourceDigest'>) {
    const source = this.ports.evidence.read(journal.snapshotId, journal.sourceVersion);
    if (source.status !== 'available') throw new Error(`Generation source unavailable: ${source.reason}.`);
    if (generationTextDigest(canonicalJson(source.window)) !== journal.sourceDigest) throw new Error('Generation source snapshot changed.');
    return source.window;
  }
  private phase(model: KnowledgeGenerationModel, profile: GenerationProfile, input: string): GenerationStage {
    if (Buffer.byteLength(profile.system, 'utf8') + Buffer.byteLength(input, 'utf8') > 1024 * 1024) throw new Error('Knowledge model request capacity_exceeded (1 MiB).');
    const producer = model.inspect(profile, input);
    // Refuse unarchivable producers before any journal claim or native invocation.
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
  private bodies(journal: GenerationJournal): KnowledgeRevision[] {
    return journal.bodies.map(ref => {
      const body = this.ports.knowledge.read(ref.knowledgeId).revisions.find(r => r.revisionId === ref.revisionId);
      if (!body || canonicalJson(knowledgeBodyRef(body)) !== canonicalJson(ref)) throw new Error('Saved generation body identity mismatch.'); return body;
    });
  }
  private prepareAssociation(journal: GenerationJournal, model: KnowledgeGenerationModel): GenerationJournal {
    if (journal.stages.some(s => s.stageKind === 'association') || !journal.bodies.length) return journal;
    const window = this.window(journal), bodies = this.bodies(journal);
    const input = canonicalJson({ ...sourceInput(window), bodies: bodies.map((body, index) => ({ bodyKey: `b${index}`,
      bodyRef: knowledgeBodyRef(body), title: body.title, content: body.content, reuseRationale: body.reuseRationale })) });
    return this.persist({ ...journal, stages: [...journal.stages, this.phase(model, ASSOCIATION_GENERATION_PROFILE, input)] });
  }
  async generate(snapshotId: string, model: KnowledgeGenerationModel, runId = this.ports.id(), signal?: AbortSignal, options: KnowledgeGenerationOptions = {}) {
    const existing = this.ports.journals.read(runId);
    if (existing) {
      if (existing.mode !== 'generate' || existing.snapshotId !== snapshotId || existing.executor !== model.executor
        || existing.model !== model.model || existing.timeoutMs !== model.timeoutMs) throw new Error('Generation request conflicts with existing journal.');
      return this.resume(runId); // Reusing a run identity never implies permission to dispatch another stage.
    }
    if (this.inFlight || this.held) throw new Error('A generation outcome is in flight or awaiting durable archive.');
    signal?.throwIfAborted(); const source = this.ports.evidence.read(snapshotId);
    if (source.status !== 'available') throw new Error('Generation source unavailable.');
    let journal = this.ports.journals.write({ storeKind: 'knowledge-generation-journal', schemaVersion: 1, workflowId: 'knowledge-body-first/v1',
      runId, generation: 1, mode: 'generate', status: 'active', createdAt: this.ports.now(), actor: this.ports.actor,
      snapshotId, sourceVersion: source.window.sourceVersion, sourceDigest: generationTextDigest(canonicalJson(source.window)),
      executor: model.executor, model: model.model, timeoutMs: model.timeoutMs, bodies: [],
      stages: [this.phase(model, BODY_GENERATION_PROFILE, canonicalJson(sourceInput(source.window)))] }, 0);
    journal = await this.invoke(journal, model, signal, options);
    if (journal.stages[0].state === 'completed' && journal.bodies.length) {
      journal = this.prepareAssociation(journal, model);
      if (!signal?.aborted) journal = await this.invoke(journal, model, signal, options);
    }
    return this.state(journal);
  }
  async rebuild(ref: KnowledgeBodyRef, model: KnowledgeGenerationModel, runId = this.ports.id(), signal?: AbortSignal) {
    const existing = this.ports.journals.read(runId);
    if (existing) {
      if (existing.mode !== 'rebuild_associations' || canonicalJson(existing.bodies) !== canonicalJson([ref])
        || existing.executor !== model.executor || existing.model !== model.model || existing.timeoutMs !== model.timeoutMs) throw new Error('Association rebuild conflicts with existing journal.');
      return this.resume(runId);
    }
    if (this.inFlight || this.held) throw new Error('A generation outcome is in flight or awaiting durable archive.');
    signal?.throwIfAborted(); const body = this.ports.knowledge.read(ref.knowledgeId).revisions.find(r => r.revisionId === ref.revisionId);
    if (!body || canonicalJson(knowledgeBodyRef(body)) !== canonicalJson(ref)) throw new Error('Association body identity mismatch.');
    const refs = [...new Map(body.content.segments.flatMap(s => s.evidence).map(e => [canonicalJson(e.source), e.source])).values()];
    if (refs.length !== 1) throw new Error('Association generation currently requires one exact source window; body remains readable.');
    const source = this.ports.evidence.read(refs[0].snapshotId, refs[0].sourceVersion);
    if (source.status !== 'available') throw new Error('Association source unavailable; body remains readable.');
    const seed = { storeKind: 'knowledge-generation-journal' as const, schemaVersion: 1 as const, workflowId: 'knowledge-body-first/v1' as const,
      runId, generation: 1, mode: 'rebuild_associations' as const, status: 'active' as const, createdAt: this.ports.now(), actor: this.ports.actor,
      snapshotId: refs[0].snapshotId, sourceVersion: refs[0].sourceVersion, sourceDigest: generationTextDigest(canonicalJson(source.window)),
      executor: model.executor, model: model.model, timeoutMs: model.timeoutMs, bodies: [ref], stages: [] as GenerationStage[] };
    const input = canonicalJson({ ...sourceInput(source.window), bodies: [{ bodyKey: 'b0', bodyRef: ref,
      title: body.title, content: body.content, reuseRationale: body.reuseRationale }] });
    const journal = this.ports.journals.write({ ...seed, stages: [this.phase(model, ASSOCIATION_GENERATION_PROFILE, input)] }, 0);
    return this.state(await this.invoke(journal, model, signal));
  }
  /** Explicitly dispatch only a never-claimed phase. A stale generation cannot claim it. */
  async continueStage(runId: string, expectedGeneration: number, model: KnowledgeGenerationModel, signal?: AbortSignal) {
    let j = this.required(runId);
    if (j.generation !== expectedGeneration || j.status !== 'active') throw new Error('Generation continuation conflict.');
    if (j.executor !== model.executor || j.model !== model.model || j.timeoutMs !== model.timeoutMs) throw new Error('Generation continuation model changed.');
    if (j.stages.every(s => s.state === 'completed')) j = this.prepareAssociation(j, model);
    if (j.stages.at(-1)!.state !== 'prepared') throw new Error('Only a never-claimed phase may be continued; resume never redispatches.');
    return this.state(await this.invoke(j, model, signal));
  }
  private async invoke(journal: GenerationJournal, model: KnowledgeGenerationModel, signal?: AbortSignal, options: KnowledgeGenerationOptions = {}): Promise<GenerationJournal> {
    if (this.inFlight || this.held) throw new Error('A generation outcome is in flight or awaiting durable archive.');
    const index = journal.stages.length - 1, stage = journal.stages[index];
    if (stage.state !== 'prepared') throw new Error('Generation phase is not dispatchable.');
    const profile = stage.stageKind === 'body' ? BODY_GENERATION_PROFILE : ASSOCIATION_GENERATION_PROFILE;
    if (profile.profileId !== stage.profileId || canonicalJson(model.inspect(profile, stage.input)) !== canonicalJson(stage.producer)) throw new Error('Generation producer/profile changed.');
    signal?.throwIfAborted(); this.window(journal); this.inFlight = journal.runId; let claims = 0;
    try {
      const outcome = await model.invoke(profile, stage.input, signal, () => {
        if (claims !== 0) throw new Error('Duplicate native dispatch gate.');
        options.beforeDispatch?.({ runId: journal.runId, invocationId: stage.invocationId, stageKind: stage.stageKind, requestDigest: stage.requestDigest });
        claims = 1;
        journal = this.persist({ ...journal, stages: journal.stages.map((s, i) => i === index ? { ...s, state: 'claimed' } : s) });
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
  /** Zero-model recovery: attach orphan original, prepare fixed write intents, replay exact receipts. */
  resume(runId: string) {
    let j = this.required(runId), stage = j.stages.at(-1)!;
    if (this.inFlight === runId) return this.state(j);
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
    let index = j.stages.length - 1, stage = j.stages[index];
    if (stage.state === 'archived') {
      const outcome = this.ports.journals.outcome(j, stage); if (!outcome) throw new Error('Native outcome missing.');
      const output = outcome.outcomeKind === 'result' && outcome.result.ok && outcome.result.refusal === undefined
        && outcome.result.failure === undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length === 0)
        && typeof outcome.result.output === 'string' ? outcome.result.output : undefined;
      if (stage.stageKind === 'body') {
        try {
          if (output === undefined || outcome.cleanupFailure || stage.issues.length) throw new Error('Body native execution did not complete cleanly.');
          const checked = checkGeneratedBodies(output, this.window(j)), actor = this.actor(j, stage), at = this.ports.now();
          const writes: KnowledgeWrite[] = checked.accepted.map(({ draft }) => {
            const knowledgeId = this.ports.id(), revisionId = this.ports.id();
            return { commandKind: 'append_revision', requestId: this.ports.id(), knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null,
              revision: { ...draft, knowledgeId, revisionId, bodyDigest: knowledgeBodyDigest(draft), observationRefs: [j.snapshotId], derivations: [],
                createdAt: at, createdBy: actor, revisedAt: at, revisedBy: actor, revisionReason: 'Generated canonical knowledge body; pending review.' } };
          });
          stage = { ...stage, state: 'prepared_writes', bodyWrites: writes, rejected: checked.rejected };
        } catch (error) { stage = { ...stage, state: 'failed', issues: [...stage.issues, message(error)] }; }
      } else stage = this.associationIntents(j, stage, output, outcome.cleanupFailure !== undefined);
      j = this.persist({ ...j, stages: j.stages.map((s, i) => i === index ? stage : s), ...(stage.state === 'failed' ? { status: 'failed' as const } : {}) });
    }
    index = j.stages.length - 1; stage = j.stages[index];
    if (stage.state !== 'prepared_writes') return j;
    const actor = this.actor(j, stage);
    const writes = stage.stageKind === 'body' ? (stage.bodyWrites ?? []) : [...(stage.entityWrite ? [stage.entityWrite] : []), ...(stage.associationWrites ?? [])];
    for (let i = stage.committed; i < writes.length; i++) {
      const write = writes[i];
      if (stage.stageKind === 'body') this.ports.knowledge.write(write as KnowledgeWrite, actor);
      else if ('analysisId' in write) this.ports.entities.write(write as EntityAnalysisWrite, actor);
      else this.ports.associations.write(write as KnowledgeAssociationWrite, actor);
      stage = { ...stage, committed: i + 1 };
      const bodies = stage.stageKind === 'body' ? (stage.bodyWrites ?? []).slice(0, i + 1)
        .flatMap(w => w.commandKind === 'append_revision' ? [knowledgeBodyRef(w.revision)] : []) : j.bodies;
      j = this.persist({ ...j, bodies, stages: j.stages.map((s, n) => n === index ? stage : s) });
    }
    stage = { ...stage, state: 'completed' };
    const bodies = stage.stageKind === 'body' ? (stage.bodyWrites ?? []).flatMap(w => w.commandKind === 'append_revision' ? [knowledgeBodyRef(w.revision)] : []) : j.bodies;
    return this.persist({ ...j, bodies, stages: j.stages.map((s, n) => n === index ? stage : s),
      status: stage.stageKind === 'body' && bodies.length ? 'active' : 'completed' });
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
      status: 'failed', reviewStatus: 'pending', segmentEntityRefs: [], issues: [reason], revisedAt: at, revisedBy: actor,
      revisionReason: 'Derived association failed; canonical body unchanged.' });
    try {
      if (output === undefined || cleanupFailure || stage.issues.length) throw new Error('Association native execution did not complete cleanly.');
      const response = checkGeneratedAssociations(output), window = this.window(j);
      const entityIds = new Map(response.entities.map(e => [e.entityId, this.ports.id()])), mentionIds = new Map(response.mentions.map(m => [m.mentionId, this.ports.id()]));
      if (entityIds.size !== response.entities.length || mentionIds.size !== response.mentions.length) throw new Error('Duplicate local catalog identity.');
      const mapped = (map: Map<string, string>, id: string) => { const value = map.get(id); if (!value) throw new Error('Unknown local catalog identity.'); return value; };
      const draft = EntityAnalysisDraftSchema.parse({ entities: response.entities.map(e => mapEntityIdentity(e, entityIds, mentionIds)),
        mentions: response.mentions.map(m => {
          const selection = locateQuoteOccurrence({ evidenceRef: m.selection.evidenceRef, quote: m.selection.quote,
            ...(m.selection.occurrence === null ? {} : { occurrence: m.selection.occurrence }) }, window.excerpts);
          if (typeof selection === 'string' || validateEntityMentionSelection(selection, window.excerpts).length) throw new Error('Entity mention locator rejected.');
          return { ...m, mentionId: mapped(mentionIds, m.mentionId), entityId: mapped(entityIds, m.entityId), selection };
        }), limitations: ['AI-derived pending associations; source quote matching is not semantic identity or truth confirmation.'] });
      if (validateEntityAnalysis(draft).length) throw new Error('Entity catalog reference closure rejected.');
      const entityRevisionId = this.ports.id();
      const entityWrite: EntityAnalysisWrite = { requestId: this.ports.id(), analysisId: j.runId, snapshotId: j.snapshotId, sourceVersion: j.sourceVersion,
        expectedGeneration: 0, expectedHeadRevisionId: null, revision: { ...draft, revisionId: entityRevisionId, revisedAt: at,
          revisedBy: actor, revisionReason: 'Derived candidate catalog; canonical body unchanged.' } };
      const expectedKeys = new Set(bodies.map((_, i) => `b${i}`));
      if (response.associations.length !== bodies.length || response.associations.some(a => !expectedKeys.has(a.bodyKey))
        || new Set(response.associations.map(a => a.bodyKey)).size !== bodies.length) throw new Error('Association body keys are not closed.');
      const associationWrites = bodies.map((body, index) => {
        try {
          const association = response.associations.find(a => a.bodyKey === `b${index}`)!;
          const revision = KnowledgeAssociationRevisionSchema.parse({ revisionId: this.ports.id(), bodyRef: knowledgeBodyRef(body),
            status: 'available', reviewStatus: 'pending', entityAnalysisRef: { analysisId: j.runId, revisionId: entityRevisionId },
            segmentEntityRefs: association.segmentEntityRefs.map(ref => ({ ...ref, entityId: mapped(entityIds, ref.entityId), mentionIds: ref.mentionIds.map(id => mapped(mentionIds, id)) })),
            ...(association.typedRelations === null ? {} : { typedRelations: association.typedRelations.map(r => {
              const { object, evidence: locators, ...fields } = r;
              return { ...fields,
              subject: { entityId: mapped(entityIds, r.subject.entityId) }, ...(object ? { object: { entityId: mapped(entityIds, object.entityId) } } : {}),
              evidence: locators.map(e => {
                const segment = body.content.segments.find(s => s.segmentId === e.segmentId);
                const evidence = segment?.evidence[e.evidenceIndex]; if (!evidence || !r.segmentIds.includes(e.segmentId)) throw new Error('Unknown body evidence index.'); return evidence;
              }) }; }) }), issues: association.issues, revisedAt: at, revisedBy: actor, revisionReason: 'Independent derived association; pending review.' });
          validateKnowledgeAssociationReferences(revision, body); return command(body, revision);
        } catch (error) { return failed(body, message(error)); }
      });
      return { ...stage, state: 'prepared_writes', entityWrite, associationWrites };
    } catch (error) { return { ...stage, state: 'prepared_writes', issues: [...stage.issues, message(error)], associationWrites: bodies.map(body => failed(body, message(error))) }; }
  }
}
