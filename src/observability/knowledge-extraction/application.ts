import type { KnowledgeActor, KnowledgeDraft, KnowledgeRevision } from '../../knowledge/contracts.js';
import { EntityMentionSchema, KnowledgeDraftSchema } from '../../knowledge/contracts.js';
import { z } from 'zod';
import { EntityAnalysisDraftSchema, validateEntityAnalysis, type EntityAnalysisStore, type EntityAnalysisWrite } from '../../knowledge/entities.js';
import { validateEvidenceSelection } from '../../knowledge/validation.js';
import type { KnowledgeGrounding, KnowledgeStore } from '../../knowledge/store.js';
import type { KnowledgeTagStore } from '../../knowledge/tags.js';
import type { EvidenceStore, EvidenceWindow, SourceSelection } from './evidence.js';
import type { ExtractionRun, ExtractionRunStore } from './runs.js';
import type { ExtractionProposal } from './proposals.js';
import { EXTRACTION_PROMPT, EXTRACTION_PROMPT_VERSION } from './prompt.js';
import { EntityModelSchema } from './entities.js';
import { checkWindowExtractionResponse } from './window-proposals.js';
import { entityKnowledgeLinks, queryEntityRows, type EntitySearchRow, type EntityQuery } from './entity-catalog.js';
import type { KnowledgeEnvelope } from '../../knowledge/store.js';
import { mapEntityIdentity } from '../../knowledge/entity-identity.js';

export interface ExtractionModel {
  executor: string; model: string;
  generate(system: string, input: string, signal?: AbortSignal): Promise<{
    output: string; durationMs: number; inputTokens?: number; outputTokens?: number; costUSD?: number;
  }>;
}
export interface KnowledgeApplicationPorts {
  evidence: EvidenceStore; knowledge: KnowledgeStore; runs: ExtractionRunStore; tags: KnowledgeTagStore;
  entities: EntityAnalysisStore;
  id(): string; now(): string; hash(value: unknown): string;
  actor: KnowledgeActor;
}

/** Both delivery hosts call this workflow; neither owns knowledge state transitions. */
export class KnowledgeApplication {
  constructor(private readonly ports: KnowledgeApplicationPorts) {}
  capture(selection: SourceSelection, signal?: AbortSignal): EvidenceWindow { return this.ports.evidence.capture(selection, signal); }
  list() {
    return this.ports.knowledge.list().map((history) => {
      const tags = this.ports.tags.read(history.knowledgeId).tags;
      return {
      knowledgeId: history.knowledgeId, revisionId: history.writeHeadRevisionId,
      generation: history.generation, title: history.revisions.at(-1)!.title,
      reviewStatus: 'pending' as const,
      choice: history.maintenance.filter((entry) => entry.revisionId === history.writeHeadRevisionId).at(-1)?.choice ?? null,
      ...(tags.length ? { tags } : {}),
    }; });
  }
  runs() { return this.ports.runs.list(); }
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
  async generate(snapshotId: string, model: ExtractionModel, runId = this.ports.id(), signal?: AbortSignal): Promise<ExtractionRun> {
    signal?.throwIfAborted();
    const source = this.source(snapshotId);
    if (source.status !== 'available') throw new Error(`Source unavailable: ${source.reason}`);
    const window = source.window;
    // Native paths/raw envelopes stay local. The model receives only registered excerpts and scope notices.
    const input = JSON.stringify({ excerpts: window.excerpts, limitations: window.limitations });
    const requestDigest = this.ports.hash({ snapshotId, sourceVersion: window.sourceVersion, executor: model.executor, model: model.model,
      promptHash: this.ports.hash(EXTRACTION_PROMPT), inputDigest: this.ports.hash(input), actor: this.ports.actor });
    let run: ExtractionRun = {
      runKind: 'knowledge-extraction-run', schemaVersion: 4,
      runId, requestDigest, generation: 1, snapshotId, sourceVersion: window.sourceVersion,
      ...(window.origin ? { origin: window.origin } : {}),
      executor: model.executor, model: model.model, promptVersion: EXTRACTION_PROMPT_VERSION,
      promptHash: this.ports.hash(EXTRACTION_PROMPT), inputDigest: this.ports.hash(input),
      actor: this.ports.actor, startedAt: this.ports.now(), status: 'generating', intents: [], rejections: [], committed: [],
      entityRejections: [],
    };
    // Exclusive reservation precedes any model call. A retry never starts another generation.
    try { this.ports.runs.create(run); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = this.ports.runs.read(runId);
      if (previous.requestDigest !== requestDigest) throw new Error('Extraction request identity conflict.');
      return previous.status === 'prepared' ? this.resume(runId, signal) : previous;
    }
    try {
      const result = await model.generate(EXTRACTION_PROMPT, input, signal);
      if (result.output.length > 2 * 1024 * 1024) throw new Error('Extraction response exceeds capacity.');
      run = this.saveRun(run, { rawOutput: result.output,
        runtime: { durationMs: result.durationMs, ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
          ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
          ...(result.costUSD === undefined ? {} : { costUSD: result.costUSD }) } });
      signal?.throwIfAborted();
      run = this.prepare(run, window);
    } catch (error) {
      return this.saveRun(run, { status: signal?.aborted ? 'cancelled' : 'failed', finishedAt: this.ports.now(), error: error instanceof Error ? error.message : String(error) });
    }
    return this.resume(run.runId, signal);
  }
  resume(runId: string, signal?: AbortSignal): ExtractionRun {
    let run = this.ports.runs.read(runId);
    if (['generating', 'cancelled', 'failed'].includes(run.status) && run.rawOutput !== undefined && !run.intents.length) {
      const source = this.source(run.snapshotId, run.sourceVersion);
      if (source.status !== 'available') throw new Error(`Source unavailable: ${source.reason}`);
      try { run = this.prepare(run, source.window); } catch (error) {
        return this.saveRun(run, { status: 'failed', finishedAt: this.ports.now(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (run.status !== 'prepared') return run;
    signal?.throwIfAborted();
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
  maintain(knowledgeId: string, revisionId: string, choice: 'retain' | 'discard', reason: string, expectedGeneration: number, requestId = this.ports.id()) {
    return this.ports.knowledge.write({ knowledgeId, requestId, expectedGeneration, commandKind: 'record_maintenance',
      maintenance: { revisionId, choice, reason, actor: this.ports.actor, at: this.ports.now() } }, this.ports.actor);
  }
  revise(knowledgeId: string, expectedRevisionId: string, expectedGeneration: number, input: unknown, reason: string) {
    const previous = this.detail(knowledgeId, expectedRevisionId);
    const ref = previous.grounding.entityAnalysisRef;
    if (!ref) throw new Error('Knowledge has no bound entity analysis.');
    return this.reviseUsingEntities(knowledgeId, expectedRevisionId, expectedGeneration, ref.analysisId, ref.revisionId, input, reason);
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
    const problems = [...validateEntityAnalysis(draft), ...draft.mentions.flatMap(mention => validateEvidenceSelection(mention.selection, previous.source.status === 'available' ? previous.source.window.excerpts : []).map(problem => problem.code))];
    if (problems.length) throw new Error(`Invalid entity correction: ${problems.join(',')}`);
    this.ports.entities.write({ analysisId, snapshotId: previous.history.snapshotId, sourceVersion: previous.history.sourceVersion,
      requestId: this.ports.id(), expectedGeneration, expectedHeadRevisionId: expectedRevisionId,
      revision: { ...draft, revisionId: this.ports.id(), parentRevisionId: expectedRevisionId,
        revisedAt: this.ports.now(), revisedBy: this.ports.actor, revisionReason: reason } }, this.ports.actor);
    return this.entities(analysisId);
  }
  reviseUsingEntities(knowledgeId: string, expectedRevisionId: string, expectedGeneration: number, analysisId: string,
    analysisRevisionId: string, input: unknown, reason: string, identityUncertaintiesInput?: unknown) {
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
    const revision: KnowledgeRevision = { ...previous.revision, ...draft, revisionId: this.ports.id(),
      parentRevision: { knowledgeId, revisionId: expectedRevisionId }, revisedAt: this.ports.now(), revisedBy: this.ports.actor, revisionReason: reason };
    const mentions = analysis.revision.mentions.filter(mention => draft.entities.some(entity => entity.entityId === mention.entityId));
    const grounding: KnowledgeGrounding = { ...previous.grounding, revisionId: revision.revisionId, mentions,
      citations: previous.grounding.citations.filter(citation => draft.evidence.some(link => link.evidenceLinkId === citation.evidenceLinkId)),
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
  private prepare(run: ExtractionRun, window: EvidenceWindow): ExtractionRun {
    const actor: KnowledgeActor = { actorKind: 'agent', actorId: `extractor:${run.executor}`, executionRef: run.runId };
    const checked = checkWindowExtractionResponse(JSON.parse(run.rawOutput!), window.excerpts);
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
      intents: checked.accepted.map(proposal => this.intent(proposal, window, actor, { entityIds, mentionIds,
        ref: { analysisId: run.runId, revisionId: entityAnalysis.revision.revisionId } })) });
  }

  private saveRun(run: ExtractionRun, update: Partial<ExtractionRun>): ExtractionRun {
    const next = { ...run, ...update, generation: run.generation + 1 };
    this.ports.runs.save(next, run.generation);
    return next;
  }
  private intent(proposal: ExtractionProposal, window: EvidenceWindow, actor: KnowledgeActor,
    shared: { entityIds: Map<string, string>; mentionIds: Map<string, string>; ref: NonNullable<KnowledgeGrounding['entityAnalysisRef']> }): ExtractionRun['intents'][number] {
    const entityIds = shared.entityIds;
    const draft: KnowledgeDraft = {
      ...proposal.draft,
      entities: proposal.draft.entities.map((entity) => ({ ...entity, entityId: entityIds.get(entity.entityId)! })),
      content: { ...proposal.draft.content, statements: proposal.draft.content.statements.map((statement) => ({
        ...statement, subject: { entityId: entityIds.get(statement.subject.entityId)! },
        ...(statement.object ? { object: { entityId: entityIds.get(statement.object.entityId)! } } : {}),
      })) },
    };
    const now = this.ports.now();
    const revision: KnowledgeRevision = { ...draft, knowledgeId: this.ports.id(), revisionId: this.ports.id(),
      observationRefs: [], derivations: [], createdAt: now, revisedAt: now, createdBy: actor, revisedBy: actor, revisionReason: '从选定工作日志提炼，等待人工复核' };
    return { requestId: this.ports.id(), revision, grounding: {
      revisionId: revision.revisionId,
      mentions: proposal.mentions.map((mention) => ({ ...mention, mentionId: shared.mentionIds.get(mention.mentionId)!, entityId: entityIds.get(mention.entityId)! })),
      citations: proposal.citations, reuseRationale: proposal.reuseRationale, identityUncertainties: proposal.identityUncertainties,
      sourceBindings: [{ snapshotId: window.snapshotId, sourceVersion: window.sourceVersion, evidenceRefs: [...new Set([...draft.evidence.map((link) => link.evidenceRef), ...proposal.mentions.map((mention) => mention.selection.evidenceRef)])] }],
      entityAnalysisRef: shared.ref,
    } };
  }
}
