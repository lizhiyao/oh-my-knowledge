import type { KnowledgeActor, KnowledgeBodyRef, KnowledgeRevision } from '../contracts.js';
import type { KnowledgeStore, KnowledgeWrite } from '../store.js';
import { canonicalJson } from '../store.js';
import type { EvidenceStore, EvidenceWindow } from '../extraction/evidence.js';
import type { EntityAnalysisStore, EntityAnalysisWrite } from '../entities/contracts.js';
import type { KnowledgeAssociationStore, KnowledgeAssociationWrite } from '../associations.js';
import { KnowledgeAssociationRevisionSchema, validateKnowledgeAssociationReferences } from '../associations.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../adapters/body-digest.js';
import type { KnowledgeGenerationModel } from '../adapters/generation-executor.js';
import { MAX_GENERATION_OUTCOME_BYTES } from '../adapters/generation-journal-store.js';
import type { GenerationJournal, GenerationJournalStore, GenerationStage } from '../extraction/generation-journal.js';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE, checkGeneratedAssociations, checkGeneratedBodies,
  generationTextDigest, type GenerationProfile } from '../extraction/body-generation-wire.js';
import { associationMentionKey, compileAssociationCatalog } from '../extraction/association-catalog.js';
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
const currentProfile = (stage: GenerationStage) => stage.stageKind === 'body' ? BODY_GENERATION_PROFILE : ASSOCIATION_GENERATION_PROFILE;
function currentStage(stage: GenerationStage): boolean {
  const profile = currentProfile(stage);
  return stage.profileId === profile.profileId && stage.wireId === profile.wireId && stage.promptVersion === profile.promptVersion
    && stage.system === profile.system && canonicalJson(stage.wireSchema) === canonicalJson(profile.wireSchema);
}
/** Stored write intents are replayable; old model output is never decoded under a new protocol. */
export function generationNextAction(journal: GenerationJournal) {
  const pending = journal.stages.find(stage => !['completed', 'failed'].includes(stage.state));
  if (journal.status === 'active' && journal.stages.at(-1)?.state !== 'prepared_writes' && journal.stages.some(stage => !currentStage(stage))) return 'unsupported' as const;
  return pending?.state === 'prepared' ? 'continue_stage' as const
    : pending?.state === 'claimed' ? 'outcome_unknown_do_not_redispatch' as const
      : pending ? 'resume_publication' as const : journal.status === 'active' ? 'continue_stage' as const : 'none' as const;
}
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
    return { journal, nextAction: generationNextAction(journal) };
  }
  private window(sourceRef: GenerationJournal['sources'][number]) {
    const source = this.ports.evidence.read(sourceRef.snapshotId, sourceRef.sourceVersion);
    if (source.status !== 'available') throw new Error(`Generation source unavailable: ${source.reason}.`);
    if (generationTextDigest(canonicalJson(source.window)) !== sourceRef.sourceDigest) throw new Error('Generation source snapshot changed.');
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
    const windows = journal.sources.map(source => this.window(source)), bodies = this.bodies(journal);
    const input = canonicalJson({ sources: windows.map((window, index) => ({ sourceKey: `s${index}`, ...sourceInput(window) })), bodies: bodies.map((body, index) => ({ bodyKey: `b${index}`,
      bodyRef: knowledgeBodyRef(body), title: body.title, content: body.content, reuseRationale: body.reuseRationale })) });
    return this.persist({ ...journal, stages: [...journal.stages, this.phase(model, ASSOCIATION_GENERATION_PROFILE, input)] });
  }
  async generate(snapshotId: string, model: KnowledgeGenerationModel, runId = this.ports.id(), signal?: AbortSignal, options: KnowledgeGenerationOptions = {}) {
    const existing = this.ports.journals.read(runId);
    if (existing) {
      if (existing.mode !== 'generate' || existing.sources.length !== 1 || existing.sources[0].snapshotId !== snapshotId || existing.executor !== model.executor
        || existing.model !== model.model || existing.timeoutMs !== model.timeoutMs) throw new Error('Generation request conflicts with existing journal.');
      return this.resume(runId); // Reusing a run identity never implies permission to dispatch another stage.
    }
    if (this.inFlight || this.held) throw new Error('A generation outcome is in flight or awaiting durable archive.');
    signal?.throwIfAborted(); const source = this.ports.evidence.read(snapshotId);
    if (source.status !== 'available') throw new Error('Generation source unavailable.');
    let journal = this.ports.journals.write({ storeKind: 'knowledge-generation-journal', schemaVersion: 2, workflowId: 'knowledge-body-first/v2',
      runId, generation: 1, mode: 'generate', status: 'active', createdAt: this.ports.now(), actor: this.ports.actor,
      sources: [{ snapshotId, sourceVersion: source.window.sourceVersion, sourceDigest: generationTextDigest(canonicalJson(source.window)) }],
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
    if (!refs.length) throw new Error('Association body needs at least one exact source.');
    const windows = refs.map(ref => {
      const source = this.ports.evidence.read(ref.snapshotId, ref.sourceVersion);
      if (source.status !== 'available') throw new Error('Association source unavailable; body remains readable.');
      return source.window;
    });
    const seed = { storeKind: 'knowledge-generation-journal' as const, schemaVersion: 2 as const, workflowId: 'knowledge-body-first/v2' as const,
      runId, generation: 1, mode: 'rebuild_associations' as const, status: 'active' as const, createdAt: this.ports.now(), actor: this.ports.actor,
      sources: windows.map(window => ({ snapshotId: window.snapshotId, sourceVersion: window.sourceVersion, sourceDigest: generationTextDigest(canonicalJson(window)) })),
      executor: model.executor, model: model.model, timeoutMs: model.timeoutMs, bodies: [ref], stages: [] as GenerationStage[] };
    const input = canonicalJson({ sources: windows.map((window, index) => ({ sourceKey: `s${index}`, ...sourceInput(window) })), bodies: [{ bodyKey: 'b0', bodyRef: ref,
      title: body.title, content: body.content, reuseRationale: body.reuseRationale }] });
    const journal = this.ports.journals.write({ ...seed, stages: [this.phase(model, ASSOCIATION_GENERATION_PROFILE, input)] }, 0);
    return this.state(await this.invoke(journal, model, signal));
  }
  /** Explicitly dispatch only a never-claimed phase. A stale generation cannot claim it. */
  async continueStage(runId: string, expectedGeneration: number, model: KnowledgeGenerationModel, signal?: AbortSignal) {
    let j = this.required(runId);
    if (j.generation !== expectedGeneration || j.status !== 'active') throw new Error('Generation continuation conflict.');
    if (generationNextAction(j) === 'unsupported') throw new Error('Generation profile changed; use the preserved matching build to recover this run.');
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
    if (!currentStage(stage) || canonicalJson(model.inspect(profile, stage.input)) !== canonicalJson(stage.producer)) throw new Error('Generation producer/profile changed.');
    signal?.throwIfAborted(); journal.sources.forEach(source => this.window(source)); this.inFlight = journal.runId; let claims = 0;
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
    if (generationNextAction(j) === 'unsupported') return this.state(j);
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
      if (!currentStage(stage)) return j;
      const outcome = this.ports.journals.outcome(j, stage); if (!outcome) throw new Error('Native outcome missing.');
      const output = outcome.outcomeKind === 'result' && outcome.result.ok && outcome.result.refusal === undefined
        && outcome.result.failure === undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length === 0)
        && typeof outcome.result.output === 'string' ? outcome.result.output : undefined;
      if (stage.stageKind === 'body') {
        try {
          if (output === undefined || outcome.cleanupFailure || stage.issues.length) throw new Error('Body native execution did not complete cleanly.');
          const checked = checkGeneratedBodies(output, this.window(j.sources[0])), actor = this.actor(j, stage), at = this.ports.now();
          const writes: KnowledgeWrite[] = checked.accepted.map(({ draft }) => {
            const knowledgeId = this.ports.id(), revisionId = this.ports.id();
            return { commandKind: 'append_revision', requestId: this.ports.id(), knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null,
              revision: { ...draft, knowledgeId, revisionId, bodyDigest: knowledgeBodyDigest(draft), observationRefs: [j.sources[0].snapshotId], derivations: [],
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
    const writes = stage.stageKind === 'body' ? (stage.bodyWrites ?? []) : [...(stage.entityWrites ?? []), ...(stage.associationWrites ?? [])];
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
      status: 'failed', reviewStatus: 'pending', catalogRefs: [], segmentEntityRefs: [], issues: [reason], revisedAt: at, revisedBy: actor,
      revisionReason: 'Derived association failed; canonical body unchanged.' });
    try {
      if (output === undefined || cleanupFailure || stage.issues.length) throw new Error('Association native execution did not complete cleanly.');
      const response = checkGeneratedAssociations(output), windows = j.sources.map(source => this.window(source));
      const sourceKeys = windows.map((_, index) => `s${index}`), expectedKeys = new Set(bodies.map((_, index) => `b${index}`));
      if (response.catalogs.length !== sourceKeys.length || new Set(response.catalogs.map(catalog => catalog.sourceKey)).size !== sourceKeys.length
        || response.catalogs.some(catalog => !sourceKeys.includes(catalog.sourceKey))) throw new Error('Association source keys are not closed.');
      if (response.associations.length !== bodies.length || response.associations.some(association => !expectedKeys.has(association.bodyKey))
        || new Set(response.associations.map(association => association.bodyKey)).size !== bodies.length) throw new Error('Association body keys are not closed.');
      const mapped = (map: Map<string, string>, id: string) => { const value = map.get(id); if (!value) throw new Error('Unknown local catalog identity.'); return value; };
      const catalogs = new Map<string, { window: EvidenceWindow; write: EntityAnalysisWrite; entityIds: Map<string, string>; mentionIds: Map<string, string> }>();
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
