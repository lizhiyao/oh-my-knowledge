import type { KnowledgeActor, KnowledgeDraft, KnowledgeRevision } from '../../knowledge/contracts.js';
import { KnowledgeDraftSchema } from '../../knowledge/contracts.js';
import type { KnowledgeGrounding, KnowledgeStore } from '../../knowledge/store.js';
import type { EvidenceStore, EvidenceWindow, SourceSelection } from './evidence.js';
import type { ExtractionRun, ExtractionRunStore } from './runs.js';
import { checkExtractionResponse, type ExtractionProposal } from './proposals.js';
import { EXTRACTION_PROMPT, EXTRACTION_PROMPT_VERSION } from './prompt.js';

export interface ExtractionModel {
  executor: string; model: string;
  generate(system: string, input: string, signal?: AbortSignal): Promise<{
    output: string; durationMs: number; inputTokens?: number; outputTokens?: number; costUSD?: number;
  }>;
}
export interface KnowledgeApplicationPorts {
  evidence: EvidenceStore; knowledge: KnowledgeStore; runs: ExtractionRunStore;
  id(): string; now(): string; hash(value: unknown): string;
  actor: KnowledgeActor;
}

/** Both delivery hosts call this workflow; neither owns knowledge state transitions. */
export class KnowledgeApplication {
  constructor(private readonly ports: KnowledgeApplicationPorts) {}
  capture(selection: SourceSelection, signal?: AbortSignal): EvidenceWindow { return this.ports.evidence.capture(selection, signal); }
  list() {
    return this.ports.knowledge.list().map((history) => ({
      knowledgeId: history.knowledgeId, revisionId: history.writeHeadRevisionId,
      generation: history.generation, title: history.revisions.at(-1)!.title,
      reviewStatus: 'pending' as const,
      choice: history.maintenance.filter((entry) => entry.revisionId === history.writeHeadRevisionId).at(-1)?.choice ?? null,
    }));
  }
  runs() { return this.ports.runs.list(); }
  source(snapshotId: string, version?: string) { return this.ports.evidence.read(snapshotId, version); }
  deleteSource(snapshotId: string): void { this.ports.evidence.delete(snapshotId); }
  detail(knowledgeId: string, revisionId?: string) {
    const history = this.ports.knowledge.read(knowledgeId);
    const selected = revisionId ?? history.writeHeadRevisionId;
    const revision = history.revisions.find((item) => item.revisionId === selected);
    const grounding = history.grounding.find((item) => item.revisionId === selected);
    if (!revision || !grounding) throw new Error('Knowledge revision is missing.');
    return {
      history, revision, grounding, reviewStatus: 'pending' as const,
      maintenance: history.maintenance.filter((entry) => entry.revisionId === selected).at(-1) ?? null,
      sources: grounding.sourceBindings.map((binding) => this.source(binding.snapshotId, binding.sourceVersion)),
    };
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
      runId, requestDigest, generation: 1, snapshotId, sourceVersion: window.sourceVersion,
      ...(window.origin ? { origin: window.origin } : {}),
      executor: model.executor, model: model.model, promptVersion: EXTRACTION_PROMPT_VERSION,
      promptHash: this.ports.hash(EXTRACTION_PROMPT), inputDigest: this.ports.hash(input),
      actor: this.ports.actor, startedAt: this.ports.now(), status: 'generating', intents: [], rejections: [], committed: [],
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
      signal?.throwIfAborted();
      if (result.output.length > 2 * 1024 * 1024) throw new Error('Extraction response exceeds capacity.');
      run = this.saveRun(run, { rawOutput: result.output,
        runtime: { durationMs: result.durationMs, ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
          ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
          ...(result.costUSD === undefined ? {} : { costUSD: result.costUSD }) } });
      run = this.prepare(run, window);
    } catch (error) {
      return this.saveRun(run, { status: signal?.aborted ? 'cancelled' : 'failed', finishedAt: this.ports.now(), error: error instanceof Error ? error.message : String(error) });
    }
    return this.resume(run.runId, signal);
  }
  resume(runId: string, signal?: AbortSignal): ExtractionRun {
    let run = this.ports.runs.read(runId);
    if (run.status === 'generating' && run.rawOutput !== undefined) {
      const source = this.source(run.snapshotId, run.sourceVersion);
      if (source.status !== 'available') throw new Error(`Source unavailable: ${source.reason}`);
      try { run = this.prepare(run, source.window); } catch (error) {
        return this.saveRun(run, { status: 'failed', finishedAt: this.ports.now(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (run.status !== 'prepared') return run;
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
    const draft = KnowledgeDraftSchema.parse(input);
    // Reuse exact source positions while allowing labels and evidence interpretations
    // to be corrected. The shared history validator rejects ungrounded identities or links.
    const revision: KnowledgeRevision = { ...previous.revision, ...draft, revisionId: this.ports.id(),
      parentRevision: { knowledgeId, revisionId: expectedRevisionId }, revisedAt: this.ports.now(), revisedBy: this.ports.actor, revisionReason: reason };
    const grounding: KnowledgeGrounding = { ...previous.grounding, revisionId: revision.revisionId,
      mentions: previous.grounding.mentions.filter((mention) => draft.entities.some((entity) => entity.entityId === mention.entityId)),
      citations: previous.grounding.citations.filter((citation) => draft.evidence.some((link) => link.evidenceLinkId === citation.evidenceLinkId)),
    };
    this.ports.knowledge.write({ knowledgeId, requestId: this.ports.id(), expectedGeneration, commandKind: 'append_revision', expectedHeadRevisionId: expectedRevisionId, revision, grounding }, this.ports.actor);
    return this.detail(knowledgeId, revision.revisionId);
  }
  private prepare(run: ExtractionRun, window: EvidenceWindow): ExtractionRun {
    const checked = checkExtractionResponse(JSON.parse(run.rawOutput!), window.excerpts);
    const actor: KnowledgeActor = { actorKind: 'agent', actorId: `extractor:${run.executor}`, executionRef: run.runId };
    return this.saveRun(run, { status: 'prepared', rejections: checked.rejected,
      intents: checked.accepted.map((proposal) => this.intent(proposal, window, actor)) });
  }
  private saveRun(run: ExtractionRun, update: Partial<ExtractionRun>): ExtractionRun {
    const next = { ...run, ...update, generation: run.generation + 1 };
    this.ports.runs.save(next, run.generation);
    return next;
  }
  private intent(proposal: ExtractionProposal, window: EvidenceWindow, actor: KnowledgeActor): ExtractionRun['intents'][number] {
    const entityIds = new Map(proposal.draft.entities.map((entity) => [entity.entityId, this.ports.id()]));
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
      mentions: proposal.mentions.map((mention) => ({ ...mention, entityId: entityIds.get(mention.entityId)! })),
      citations: proposal.citations, reuseRationale: proposal.reuseRationale, identityUncertainties: proposal.identityUncertainties,
      sourceBindings: [{ snapshotId: window.snapshotId, sourceVersion: window.sourceVersion, evidenceRefs: [...new Set([...draft.evidence.map((link) => link.evidenceRef), ...proposal.mentions.map((mention) => mention.selection.evidenceRef)])] }],
    } };
  }
}
