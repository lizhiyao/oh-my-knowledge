import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { constants as bufferConstants } from 'node:buffer';
import { checkStorageDirectory, KnowledgeStorageStateError, withWorkspaceFileWrite } from './workspace-guard.js';
import { GENERATION_JOURNAL_SCHEMA_VERSION, GenerationJournalSchema, isBodyPublicationStage, type GenerationArchiveCheck, type GenerationJournal, type GenerationJournalStore, type GenerationStage } from '../extraction/generation-journal.js';
import { checkGenerationOutcome, generationJSONChunks, measureGenerationJSON, observeGenerationJSON, type GenerationOutcome } from '../extraction/native-outcome.js';
import { canonicalJson } from '../store.js';
import { confirmKnowledgePublication, publishKnowledgeBytes, publishKnowledgeChunks } from './durable-publication.js';
import { generationTextDigest } from '../extraction/body-generation-wire.js';
import { SourceDigestSchema, SourceRefSchema, sourceSetPreimage } from '../sources.js';
import { SourceReviewManifestSchema, type SourceReviewManifest } from '../source-review.js';
import { validateSourceReviewManifest } from '../source-review-history.js';
import { SOURCE_GENERATION_INPUT_VERSION, WRITING_DRAFT_INPUT_VERSION, BODY_GENERATION_INPUT_VERSION, assertBodyGenerationSources, generationSourceMetadata } from '../extraction/source-input.js';
import { SOURCE_LEDGER_INPUT_VERSION, restoreSourceLedgerInput } from '../extraction/source-review-input.js';
import { LONG_BODY_WINDOW_INPUT_VERSION, longBodyPlanDigest } from '../extraction/long-body.js';
import { SOURCE_PASSAGE_POLICY, SourcePassagesSchema } from '../extraction/source-passages.js';

const MAX_JOURNAL = 32 * 1024 * 1024;
export const MAX_GENERATION_OUTCOME_BYTES = Math.min(512 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH - 1);
const uuid = z.string().uuid();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const windowInputSchema = z.strictObject({ inputVersion: z.literal(LONG_BODY_WINDOW_INPUT_VERSION), sourceSetId: SourceDigestSchema, planDigest: SourceDigestSchema,
  passagePolicy: z.literal(SOURCE_PASSAGE_POLICY.policyVersion), passageIndexDigest: SourceDigestSchema,
  bodyWindow: z.strictObject({ index: z.number().int().positive(), count: z.number().int().positive(), visiblePassageCount: z.number().int().positive() }),
  sources: z.array(z.object({ sourceKey: z.string(), source: SourceRefSchema.loose(),
    excerpts: z.array(z.object({ passages: SourcePassagesSchema.min(1) })).min(1) })).max(256),
});
const windowTransitions: Record<GenerationStage['state'], readonly GenerationStage['state'][]> = {
  prepared: ['claimed'], claimed: ['archived'], archived: ['completed', 'failed', 'prepared_writes'],
  prepared_writes: ['completed'], completed: [], failed: [],
};

function validateBodyPlan(j: GenerationJournal): void {
  if (!j.bodyPlan) {
    if (j.bodySourceMetadata) throw new Error('Generation source metadata requires a body plan.');
    return;
  }
  if (j.mode !== 'generate' || j.stages[0].stageKind !== 'body_window' || j.writingDraftRef) {
    throw new Error('Generation body plan requires a first window without a writing draft.');
  }
  const refs = ({ snapshotId, sourceVersion }: GenerationJournal['sources'][number]) => ({ snapshotId, sourceVersion });
  if (!j.bodySourceMetadata || !same(j.bodySourceMetadata.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion })), j.sources.map(refs))) {
    throw new Error('Generation body plan requires complete frozen source metadata.');
  }
  const { planDigest, ...preimage } = j.bodyPlan;
  if (longBodyPlanDigest(preimage, j.bodySourceMetadata) !== planDigest) throw new Error('Generation body plan digest mismatch.');
  // The application reconstructs the complete passage index from immutable sources when preparing and claiming windows.
  let next = 0;
  for (const window of preimage.windows) {
    const end = next + window.visiblePassageCount - 1;
    if (!Number.isSafeInteger(end) || window.startPassageId !== `p${next}` || window.endPassageId !== `p${end}`) {
      throw new Error('Generation body plan windows must form a contiguous passage prefix.');
    }
    next = end + 1;
  }
}

function validateWindowInput(j: GenerationJournal, stageIndex: number, value: unknown): void {
  const plan = j.bodyPlan, input = windowInputSchema.parse(value);
  if (!plan || input.sourceSetId !== j.sourceSetId
    || input.planDigest !== plan.planDigest || input.passageIndexDigest !== plan.passageIndexDigest) {
    throw new Error('Generation long body plan or source set mismatch.');
  }
  let previousSource = -1, previousPassage = -1, count = 0, firstPassage = -1;
  const lastPlanPassage = Number(plan.windows.at(-1)!.endPassageId.slice(1));
  for (const source of input.sources) {
    const index = j.sources.findIndex(ref => ref.snapshotId === source.source.snapshotId && ref.sourceVersion === source.source.sourceVersion);
    if (index <= previousSource || source.sourceKey !== `s${index}`
      || !same(generationSourceMetadata(source.source), j.bodySourceMetadata![index])) throw new Error('Generation long body source projection mismatch.');
    previousSource = index;
    for (const excerpt of source.excerpts) for (const passage of excerpt.passages) {
      const ordinal = Number(passage.passageId.slice(1));
      if (!Number.isSafeInteger(ordinal) || ordinal <= previousPassage || ordinal > lastPlanPassage || passage.passageId !== `p${ordinal}`) {
        throw new Error('Generation long body passage projection mismatch.');
      }
      if (count === 0) firstPassage = ordinal;
      previousPassage = ordinal;
      count++;
    }
  }
  const expected = plan.windows[stageIndex];
  if (!expected || !same(input.bodyWindow, { index: stageIndex + 1, count: plan.windows.length, visiblePassageCount: expected.visiblePassageCount })
    || `p${firstPassage}` !== expected.startPassageId || `p${previousPassage}` !== expected.endPassageId || count !== expected.visiblePassageCount) {
    throw new Error('Generation long body window input does not match its planned position.');
  }
}

function validateJournal(j: GenerationJournal): void {
  const sourceSet = sourceSetPreimage(j.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion })));
  const refs = j.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion }));
  if (sourceSet.sources.length !== j.sources.length || generationTextDigest(canonicalJson(sourceSet)) !== j.sourceSetId
    || !same(sourceSet.sources, refs)) throw new Error('Invalid generation source set identity.');
  validateBodyPlan(j);
  const order = j.mode === 'generate' ? (j.bodyPlan ? j.bodyPlan.windows.map(() => 'body_window') : ['body_draft', 'body'])
    : j.mode === 'rebuild_associations' ? ['association']
      : j.stages[0].stageKind === 'source_ledger' ? ['source_ledger', 'source_coverage'] : ['source_coverage'];
  if (new Set(j.stages.map(s => s.invocationId)).size !== j.stages.length || j.stages.length > order.length
    || j.stages.some((stage, index) => stage.stageKind !== order[index]
    || index > 0 && j.stages[index - 1].state !== 'completed')
    || j.mode === 'rebuild_associations' && (!j.bodies.length
      || new Set(j.bodies.map(body => body.knowledgeId)).size !== j.bodies.length)) throw new Error('Invalid generation phase order.');
  if (j.mode !== 'review_sources' && (j.ledgerRef || j.coverageRef)) throw new Error('Generation cannot inherit source-review analyses.');
  if (new Set(j.bodies.map(canonicalJson)).size !== j.bodies.length) throw new Error('Duplicate generation body references.');
  for (const [stageIndex, s] of j.stages.entries()) {
    const input = JSON.parse(s.input);
    const window = s.stageKind === 'body_window';
    if (window) validateWindowInput(j, stageIndex, input);
    const publishesBody = isBodyPublicationStage(j, stageIndex);
    const review = s.stageKind === 'source_ledger' || s.stageKind === 'source_coverage';
    const manifest = review ? SourceReviewManifestSchema.parse(input.manifest) : undefined;
    const inputRefs = review ? manifest!.sources.map((source: SourceReviewManifest['sources'][number]) => source.sourceRef)
      : !window && Array.isArray(input.sources) ? input.sources.map((item: { sourceKey?: unknown; source?: unknown }, index: number) => {
        if (item.sourceKey !== `s${index}`) throw new Error('Invalid generation input source keys.');
        const source = item.source as { snapshotId?: unknown; sourceVersion?: unknown } | undefined;
        return { snapshotId: source?.snapshotId, sourceVersion: source?.sourceVersion };
      }) : [];
    if (!window && ((review ? manifest!.sourceSetId : input.sourceSetId) !== j.sourceSetId || !same(inputRefs, refs)
      || (s.stageKind === 'source_coverage' ? manifest!.inputVersion : input.inputVersion) !== (s.stageKind === 'source_ledger' ? SOURCE_LEDGER_INPUT_VERSION
        : s.stageKind === 'association' ? SOURCE_GENERATION_INPUT_VERSION : s.stageKind === 'body_draft' ? WRITING_DRAFT_INPUT_VERSION : s.stageKind === 'body' ? BODY_GENERATION_INPUT_VERSION : j.inputVersion))) {
      throw new Error('Generation source input version or set mismatch.');
    }
    if (review) {
      validateSourceReviewManifest(manifest!);
      const units = s.stageKind === 'source_ledger' ? restoreSourceLedgerInput(input).units : input.units;
      if (!Array.isArray(units) || units.length !== manifest!.units.length || units.some((unit: { text?: unknown }, index: number) => {
        const { text, ...descriptor } = unit;
        return typeof text !== 'string' || !same(descriptor, manifest!.units[index])
          || text.length !== manifest!.units[index].utf16Length || generationTextDigest(text) !== manifest!.units[index].textDigest;
      })) throw new Error('Generation source unit manifest mismatch.');
    }
    if (s.stageKind === 'body') assertBodyGenerationSources(input);
    if (s.stageKind === 'source_coverage') {
      if (!j.ledgerRef || !same(input.ledger?.ref, j.ledgerRef)) throw new Error('Generation exact ledger reference missing.');
    }
    if (s.stageKind === 'body' && (!j.writingDraftRef || !same(input.writingDraft?.ref, j.writingDraftRef) || typeof input.writingDraft?.text !== 'string')) throw new Error('Generation exact writing draft reference missing.');
    if (s.stageKind === 'source_coverage' || s.stageKind === 'association') {
      if (!Array.isArray(input.bodies) || !same(input.bodies.map((body: { bodyRef: unknown }) => body.bodyRef), j.bodies)) {
        throw new Error('Generation exact input bodies mismatch.');
      }
    }
    const entityIds = (s.entityWrites ?? []).map(write => write.analysisId);
    if (new Set(entityIds).size !== entityIds.length || (s.entityWrites ?? []).some(write => !j.sources.some(source => source.snapshotId === write.snapshotId && source.sourceVersion === write.sourceVersion))) {
      throw new Error('Invalid generation catalog source identities.');
    }
    const writes = publishesBody ? s.bodyWrites : s.stageKind === 'association' ? s.associationWrites
      : s.stageKind === 'source_ledger' ? s.ledgerWrites : s.coverageWrites;
    const total = (writes?.length ?? 0) + (s.entityWrites?.length ?? 0);
    const archiveOnly = s.stageKind === 'body_draft' || window && !publishesBody;
    if (s.committed > total || s.state === 'completed' && s.committed !== total
      || ['prepared_writes', 'completed'].includes(s.state) && !archiveOnly && writes === undefined
      || archiveOnly && s.state === 'prepared_writes'
      || window && (archiveOnly && s.rejected !== undefined || s.state === 'completed' && s.issues.length !== 0
        || s.bodyWrites !== undefined && !['prepared_writes', 'completed'].includes(s.state))
      || ['archived', 'prepared_writes', 'completed', 'failed'].includes(s.state) !== !!s.outcomeRef
      || !publishesBody && s.bodyWrites || s.stageKind !== 'association' && (s.associationWrites || s.entityWrites)
      || s.stageKind !== 'source_ledger' && s.ledgerWrites || s.stageKind !== 'source_coverage' && s.coverageWrites) throw new Error('Invalid generation publication state.');
    for (const write of [...(s.ledgerWrites ?? []), ...(s.coverageWrites ?? [])]) {
      const original = write.revision.modelOriginal;
      if (original.runId !== j.runId || original.invocationId !== s.invocationId || original.requestDigest !== s.requestDigest
        || !s.outcomeRef || original.archiveDigest !== s.outcomeRef.digest) throw new Error('Generation source analysis native identity mismatch.');
    }
    if (s.stageKind === 'source_ledger' && s.committed) {
      const write = s.ledgerWrites![0];
      if (!same(j.ledgerRef, { ledgerId: write.ledgerId, revisionId: write.revision.revisionId, digest: write.revision.digest })) throw new Error('Generation committed ledger reference mismatch.');
    }
    if (s.stageKind === 'source_coverage' && s.committed) {
      const write = s.coverageWrites![0];
      if (!same(j.coverageRef, { coverageId: write.coverageId, revisionId: write.revision.revisionId, digest: write.revision.digest })) throw new Error('Generation committed coverage reference mismatch.');
    }
  }
  const writer = j.stages.find(s => s.stageKind === 'body_draft');
  if (writer?.state === 'completed') {
    const ref = j.writingDraftRef;
    if (!ref || ref.runId !== j.runId || ref.invocationId !== writer.invocationId || ref.requestDigest !== writer.requestDigest
      || ref.archiveDigest !== writer.outcomeRef?.digest) throw new Error('Generation completed writing draft identity mismatch.');
  } else if (j.writingDraftRef) throw new Error('Generation writing draft reference precedes completion.');
  if (j.mode === 'generate') {
    const body = j.stages.find((_, index) => isBodyPublicationStage(j, index));
    if (body?.stageKind === 'body_window' && body.bodyWrites) {
      const authors = new Set(j.stages.map(stage => `${j.runId}:${stage.invocationId}`));
      if (body.bodyWrites.some(write => {
        if (write.commandKind !== 'append_revision') return true;
        const { createdBy, revisedBy } = write.revision;
        return revisedBy.actorKind !== 'agent' || revisedBy.actorId !== `extractor:${j.executor}`
          || !authors.has(revisedBy.executionRef) || !same(createdBy, revisedBy);
      })) throw new Error('Generation window body write requires an original window actor.');
    }
    const expected = (body?.bodyWrites ?? []).slice(0, body?.committed ?? 0).map(w => {
      if (w.commandKind !== 'append_revision') throw new Error('Generation must not record maintenance.');
      return { knowledgeId: w.knowledgeId, revisionId: w.revision.revisionId, bodyDigest: w.revision.bodyDigest };
    });
    if (!same(expected, j.bodies)) throw new Error('Generation committed body references mismatch.');
  }
  const last = j.stages.at(-1)!;
  const finalPhase = last.stageKind === 'association' || j.mode === 'review_sources' && last.stageKind === 'source_coverage'
    || j.mode === 'generate' && isBodyPublicationStage(j, j.stages.length - 1);
  if ((j.status === 'completed') !== (finalPhase && last.state === 'completed')
    || (j.status === 'failed') !== (last.state === 'failed')) throw new Error('Generation terminal state mismatch.');
}
/** Current-only journal. Legacy filenames remain visible, never decoded as this workflow. */
export class FileGenerationJournalStore implements GenerationJournalStore {
  private readonly root: string;
  constructor(root: string, private readonly workspaceRoot: string) { this.root = resolve(root); }
  private path(id: string) { return join(this.root, `${uuid.parse(id)}.json`); }
  private archivePath(runId: string, invocationId: string) { return join(this.root, 'outcomes', uuid.parse(runId), `${uuid.parse(invocationId)}.json`); }
  private check() { checkStorageDirectory(this.workspaceRoot); checkStorageDirectory(this.root); }
  private readBytes(path: string, maximum: number): string {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum)) throw new Error('Invalid generation storage file.');
    const bytes = readFileSync(path); const after = lstatSync(path, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || bytes.length !== Number(before.size)) throw new Error('Generation storage changed during read.');
    const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error('Invalid generation storage UTF-8.'); return text;
  }
  /** Verify the journal's identity and publication state without decoding native originals. */
  private journal(runId: string): GenerationJournal | undefined {
    this.check(); const path = this.path(runId);
    if (!existsSync(path)) {
      if (existsSync(join(this.workspaceRoot, 'extraction-runs', `${uuid.parse(runId)}.json`))) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
      return undefined;
    }
    let parsed: unknown; try { parsed = JSON.parse(this.readBytes(path, MAX_JOURNAL)); } catch (error) { throw new Error('Generation journal unreadable.', { cause: error }); }
    if ((parsed as { storeKind?: unknown; schemaVersion?: unknown })?.storeKind !== 'knowledge-generation-journal'
      || (parsed as { schemaVersion?: unknown })?.schemaVersion !== GENERATION_JOURNAL_SCHEMA_VERSION) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
    const journal = GenerationJournalSchema.parse(parsed);
    validateJournal(journal);
    if (journal.runId !== runId) throw new Error('Generation journal identity mismatch.');
    for (const stage of journal.stages) {
      if (generationTextDigest(stage.input) !== stage.inputDigest) throw new Error('Generation input digest mismatch.');
      const requestDigest = generationTextDigest(canonicalJson({ executor: journal.executor, model: journal.model, timeoutMs: journal.timeoutMs,
        profileId: stage.profileId, system: stage.system, wireId: stage.wireId, input: stage.input, producer: stage.producer }));
      if (requestDigest !== stage.requestDigest) throw new Error('Generation request digest mismatch.');
    }
    return journal;
  }
  /** Execution, recovery and publication continue to require the complete archive checks. */
  read(runId: string): GenerationJournal | undefined {
    const journal = this.journal(runId);
    if (journal) for (const stage of journal.stages) {
      if (stage.outcomeRef && !this.outcome(journal, stage)) throw new Error('Generation native archive is missing.');
    }
    return journal;
  }
  private archiveCheck(journal: GenerationJournal, stage: GenerationStage): GenerationArchiveCheck {
    const base = { runId: journal.runId, invocationId: stage.invocationId, verificationStatus: 'not_verified' as const };
    if (!stage.outcomeRef) return { ...base, archiveStatus: stage.state === 'claimed' ? 'unknown' : 'not_recorded',
      ...(stage.state === 'claimed' ? { reason: 'Native dispatch is claimed without an archived result reference.' } : {}) };
    try {
      checkStorageDirectory(join(this.root, 'outcomes'));
      checkStorageDirectory(join(this.root, 'outcomes', uuid.parse(journal.runId)));
      const stat = lstatSync(this.archivePath(journal.runId, stage.invocationId));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GENERATION_OUTCOME_BYTES || stat.size !== stage.outcomeRef.bytes) {
        return { ...base, archiveStatus: 'invalid', reason: 'Native archive file metadata does not match its recorded reference.' };
      }
      return { ...base, archiveStatus: 'present', reason: 'File metadata observed; content, digest and native binding have not been verified.' };
    } catch (error) {
      return { ...base, archiveStatus: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown',
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Recorded native archive is missing.' : 'Native archive file metadata is unavailable.' };
    }
  }
  list(): ReturnType<GenerationJournalStore['list']> {
    this.check(); const current: GenerationJournal[] = [], unsupported: ReturnType<GenerationJournalStore['list']>['unsupported'] = [];
    const unavailable: ReturnType<GenerationJournalStore['list']>['unavailable'] = [], archiveChecks: GenerationArchiveCheck[] = [];
    const files = existsSync(this.root) ? readdirSync(this.root).filter(f => f.endsWith('.json')).sort() : [];
    if (files.length > 4096) throw new Error('Generation inventory capacity exceeded.');
    let totalBytes = 0;
    for (const file of files) {
      const runId = file.slice(0, -5);
      if (!uuid.safeParse(runId).success) {
        unavailable.push({ runId, reason: 'invalid_identity', detail: 'Generation journal filename is not a run identity.' }); continue;
      }
      try {
        totalBytes += lstatSync(join(this.root, file)).size;
        if (totalBytes > 64 * 1024 * 1024) throw new Error('Generation inventory capacity exceeded.');
        const journal = this.journal(runId);
        if (journal) { current.push(journal); archiveChecks.push(...journal.stages.map(stage => this.archiveCheck(journal, stage))); }
        else unavailable.push({ runId, reason: 'unreadable', detail: 'Generation journal disappeared during inventory.' });
      } catch (error) {
        if (totalBytes > 64 * 1024 * 1024) throw error;
        if (error instanceof KnowledgeStorageStateError && error.stateCode === 'knowledge_storage_unsupported') {
          unsupported.push({ runId, schemaStatus: 'unsupported', reason: 'Generation journal requires a matching workflow version.' });
        } else unavailable.push({ runId, reason: 'unreadable', detail: 'Generation journal is invalid or unreadable.' });
      }
    }
    const old = join(this.workspaceRoot, 'extraction-runs'); checkStorageDirectory(old);
    for (const file of existsSync(old) ? readdirSync(old).filter(f => f.endsWith('.json')).sort() : []) {
      unsupported.push({ runId: file.slice(0, -5), schemaStatus: 'unsupported', reason: 'Legacy extraction run requires the matching old binary; the current journal does not decode legacy dispatch claims.' });
    }
    return { current, unsupported, unavailable, archiveChecks };
  }
  write(input: GenerationJournal, expectedGeneration: number, validateClaim?: (journal: GenerationJournal, stage: GenerationStage) => void): GenerationJournal {
    const next = GenerationJournalSchema.parse(input), path = this.path(next.runId); this.check();
    validateJournal(next);
    const bytes = JSON.stringify(next); if (Buffer.byteLength(bytes) > MAX_JOURNAL) throw new Error('Generation journal capacity exceeded.');
    return withWorkspaceFileWrite(this.workspaceRoot, path, () => {
      const old = this.read(next.runId);
      if ((old?.generation ?? 0) !== expectedGeneration || next.generation !== expectedGeneration + 1) throw new Error('Generation journal conflict.');
      if (next.bodyPlan) {
        const previousStageCount = old?.stages.length ?? 0;
        const previousStage = old?.stages.at(-1);
        if (next.stages.length > previousStageCount + 1 || next.stages.length > previousStageCount
          && (next.stages.at(-1)!.state !== 'prepared' || previousStage && previousStage.state !== 'completed')) {
          throw new Error('Generation body plan prefix cannot skip a durable phase.');
        }
      }
      if (old) {
        if (old.bodyPlan === undefined ? next.bodyPlan !== undefined : !next.bodyPlan || !same(old.bodyPlan, next.bodyPlan)
          || !same(old.bodySourceMetadata, next.bodySourceMetadata)) {
          throw new Error('Generation pinned body plan or source metadata changed.');
        }
        const immutable = (j: GenerationJournal) => ({ runId: j.runId, mode: j.mode, createdAt: j.createdAt, actor: j.actor,
          sources: j.sources, executor: j.executor, model: j.model, timeoutMs: j.timeoutMs });
        for (const key of ['writingDraftRef', 'ledgerRef', 'coverageRef'] as const) {
          if (old[key] && !same(old[key], next[key])) throw new Error('Generation pinned review identity changed.');
        }
        if (old.mode !== 'generate' && !same(old.bodies, next.bodies)) throw new Error('Generation review/rebuild bodies changed.');
        if (canonicalJson(immutable(old)) !== canonicalJson(immutable(next))) throw new Error('Generation journal identity changed.');
        for (const [i, stage] of old.stages.entries()) {
          const updated = next.stages[i]; if (!updated) throw new Error('Generation phase removed.');
          const identity = (s: GenerationStage) => ({ stageKind: s.stageKind, invocationId: s.invocationId, profileId: s.profileId,
            promptVersion: s.promptVersion, system: s.system, wireId: s.wireId, wireSchema: s.wireSchema, input: s.input,
            inputDigest: s.inputDigest, requestDigest: s.requestDigest, producer: s.producer });
          if (canonicalJson(identity(stage)) !== canonicalJson(identity(updated)) || updated.committed < stage.committed
            || stage.outcomeRef && canonicalJson(stage.outcomeRef) !== canonicalJson(updated.outcomeRef)) throw new Error('Generation phase identity changed.');
          if (stage.bodyWrites && canonicalJson(stage.bodyWrites) !== canonicalJson(updated.bodyWrites)
            || stage.entityWrites && canonicalJson(stage.entityWrites) !== canonicalJson(updated.entityWrites)
            || stage.associationWrites && canonicalJson(stage.associationWrites) !== canonicalJson(updated.associationWrites)
            || stage.ledgerWrites && !same(stage.ledgerWrites, updated.ledgerWrites)
            || stage.coverageWrites && !same(stage.coverageWrites, updated.coverageWrites)) throw new Error('Generation prepared writes changed.');
          const states = ['prepared', 'claimed', 'archived', 'prepared_writes', 'completed', 'failed'];
          if (states.indexOf(updated.state) < states.indexOf(stage.state) || ['completed', 'failed'].includes(stage.state) && updated.state !== stage.state) throw new Error('Generation phase moved backwards.');
          if (stage.stageKind === 'body_window' && updated.state !== stage.state
            && (!windowTransitions[stage.state].includes(updated.state)
              || stage.state === 'archived' && updated.state !== 'failed'
                && updated.state !== (isBodyPublicationStage(next, i) ? 'prepared_writes' : 'completed')
              || updated.state === 'archived' && !this.outcome(next, updated))) {
            throw new Error('Long body phase requires its durable claim and native archive in order.');
          }
        }
      }
      const claims = next.stages.filter((stage, index) => stage.state === 'claimed' && old?.stages[index]?.state !== 'claimed');
      for (const stage of claims) {
        if (old?.stages.find(s => s.invocationId === stage.invocationId)?.state !== 'prepared') throw new Error('Generation claim requires a prepared phase.');
        if (stage.stageKind === 'association' && !validateClaim) throw new Error('Association claim requires locked source review validation.');
        if (stage.stageKind === 'body_window' && !validateClaim) {
          throw new Error('Long body claim requires locked source validation.');
        }
        validateClaim?.(next, stage);
      }
      publishKnowledgeBytes(path, bytes, this.workspaceRoot, !old); return next;
    });
  }
  archive(journal: GenerationJournal, stage: GenerationStage, input: GenerationOutcome) {
    this.check(); const outcome = observeGenerationJSON(input); checkGenerationOutcome(outcome);
    if (input.outcomeKind === 'result') measureGenerationJSON((outcome as { result: ReturnType<typeof observeGenerationJSON> }).result, stage.producer.maxOutcomeJsonBytes);
    const record = observeGenerationJSON({ archiveKind: 'knowledge-generation-native', schemaVersion: 1,
      runId: journal.runId, invocationId: stage.invocationId, requestDigest: stage.requestDigest, outcome });
    const maximum = Math.min(MAX_GENERATION_OUTCOME_BYTES, stage.producer.maxOutcomeJsonBytes + 64 * 1024);
    const ref = measureGenerationJSON(record, maximum), path = this.archivePath(journal.runId, stage.invocationId);
    return withWorkspaceFileWrite(this.workspaceRoot, path, () => {
      const saved = this.read(journal.runId), claimed = saved?.stages.find(s => s.invocationId === stage.invocationId);
      if (!claimed || claimed.requestDigest !== stage.requestDigest || !['claimed', 'archived', 'prepared_writes', 'completed', 'failed'].includes(claimed.state)) throw new Error('Native archive requires its durable phase claim.');
      if (existsSync(path)) {
        const previous = this.readBytes(path, maximum);
        if (Buffer.byteLength(previous) !== ref.bytes || generationTextDigest(previous) !== ref.digest) throw new Error('Native archive identity conflict.');
        confirmKnowledgePublication(path, this.workspaceRoot);
      } else publishKnowledgeChunks(path, generationJSONChunks(record), this.workspaceRoot, true);
      return ref;
    });
  }
  outcome(journal: GenerationJournal, stage: GenerationStage): GenerationOutcome | undefined {
    this.check(); const parent = join(this.root, 'outcomes', uuid.parse(journal.runId));
    checkStorageDirectory(join(this.root, 'outcomes')); checkStorageDirectory(parent);
    const path = this.archivePath(journal.runId, stage.invocationId); if (!existsSync(path)) return undefined;
    const bytes = this.readBytes(path, MAX_GENERATION_OUTCOME_BYTES);
    if (stage.outcomeRef && (Buffer.byteLength(bytes) !== stage.outcomeRef.bytes || generationTextDigest(bytes) !== stage.outcomeRef.digest)) throw new Error('Native archive digest mismatch.');
    const record = JSON.parse(bytes) as Record<string, unknown>;
    if (record.archiveKind !== 'knowledge-generation-native' || record.schemaVersion !== 1 || record.runId !== journal.runId
      || record.invocationId !== stage.invocationId || record.requestDigest !== stage.requestDigest) throw new Error('Native archive binding mismatch.');
    return checkGenerationOutcome(record.outcome);
  }
}
