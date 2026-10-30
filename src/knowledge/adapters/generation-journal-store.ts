import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { constants as bufferConstants } from 'node:buffer';
import { checkStorageDirectory, KnowledgeStorageStateError, withWorkspaceFileWrite } from '../../evidence/storage/knowledge-workspace.js';
import { GenerationJournalSchema, type GenerationArchiveCheck, type GenerationJournal, type GenerationJournalStore, type GenerationStage } from '../extraction/generation-journal.js';
import { checkGenerationOutcome, generationJSONChunks, measureGenerationJSON, observeGenerationJSON, type GenerationOutcome } from '../extraction/native-outcome.js';
import { canonicalJson } from '../store.js';
import { confirmKnowledgePublication, publishKnowledgeBytes, publishKnowledgeChunks } from './durable-publication.js';
import { generationTextDigest } from '../extraction/body-generation-wire.js';
import { sourceSetPreimage } from '../sources.js';
import { SourceReviewManifestSchema, type SourceReviewManifest } from '../source-review.js';
import { validateSourceReviewManifest } from '../source-review-history.js';
import { SOURCE_GENERATION_INPUT_VERSION } from '../extraction/source-input.js';

const MAX_JOURNAL = 32 * 1024 * 1024;
export const MAX_GENERATION_OUTCOME_BYTES = Math.min(512 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH - 1);
const uuid = z.string().uuid();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function validateJournal(j: GenerationJournal): void {
  const sourceSet = sourceSetPreimage(j.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion })));
  const refs = j.sources.map(({ snapshotId, sourceVersion }) => ({ snapshotId, sourceVersion }));
  if (sourceSet.sources.length !== j.sources.length || generationTextDigest(canonicalJson(sourceSet)) !== j.sourceSetId
    || !same(sourceSet.sources, refs)) throw new Error('Invalid generation source set identity.');
  const order = j.mode === 'generate' ? ['source_ledger', 'body', 'source_coverage', 'association']
    : j.mode === 'rebuild_associations' ? ['association']
      : j.stages[0].stageKind === 'source_ledger' ? ['source_ledger', 'source_coverage'] : ['source_coverage'];
  if (j.stages.length > order.length || j.stages.some((stage, index) => stage.stageKind !== order[index]
    || index > 0 && j.stages[index - 1].state !== 'completed')
    || j.mode === 'rebuild_associations' && j.bodies.length !== 1) throw new Error('Invalid generation phase order.');
  if (new Set(j.bodies.map(canonicalJson)).size !== j.bodies.length) throw new Error('Duplicate generation body references.');
  for (const s of j.stages) {
    const input = JSON.parse(s.input);
    const review = s.stageKind === 'source_ledger' || s.stageKind === 'source_coverage';
    const manifest = review ? SourceReviewManifestSchema.parse(input.manifest) : undefined;
    const inputRefs = review ? manifest!.sources.map((source: SourceReviewManifest['sources'][number]) => source.sourceRef)
      : Array.isArray(input.sources) ? input.sources.map((item: { sourceKey?: unknown; source?: unknown }, index: number) => {
        if (item.sourceKey !== `s${index}`) throw new Error('Invalid generation input source keys.');
        const source = item.source as { snapshotId?: unknown; sourceVersion?: unknown } | undefined;
        return { snapshotId: source?.snapshotId, sourceVersion: source?.sourceVersion };
      }) : [];
    if ((review ? manifest!.sourceSetId : input.sourceSetId) !== j.sourceSetId || !same(inputRefs, refs)
      || (review ? manifest!.inputVersion : input.inputVersion) !== (s.stageKind === 'association' ? SOURCE_GENERATION_INPUT_VERSION : j.inputVersion)) {
      throw new Error('Generation source input version or set mismatch.');
    }
    if (review) {
      validateSourceReviewManifest(manifest!);
      if (!Array.isArray(input.units) || input.units.length !== manifest!.units.length || input.units.some((unit: { text?: unknown }, index: number) => {
        const { text, ...descriptor } = unit;
        return typeof text !== 'string' || !same(descriptor, manifest!.units[index])
          || text.length !== manifest!.units[index].utf16Length || generationTextDigest(text) !== manifest!.units[index].textDigest;
      })) throw new Error('Generation source unit manifest mismatch.');
    }
    if (s.stageKind === 'body' || s.stageKind === 'source_coverage') {
      if (!j.ledgerRef || !same(input.ledger?.ref, j.ledgerRef)) throw new Error('Generation exact ledger reference missing.');
    }
    if (s.stageKind === 'source_coverage' || s.stageKind === 'association') {
      if (!Array.isArray(input.bodies) || !same(input.bodies.map((body: { bodyRef: unknown }) => body.bodyRef), j.bodies)) {
        throw new Error('Generation exact input bodies mismatch.');
      }
    }
    if (s.stageKind === 'association') {
      const decision = j.sourceCoverageDecisionRef;
      if (!decision || !j.coverageRef || !same(decision.coverageRef, j.coverageRef) || !same(decision.ledgerRef, j.ledgerRef)
        || decision.sourceSetId !== j.sourceSetId || !j.bodies.length
        || j.bodies.some(body => !decision.bodyRefs.some(ref => same(ref, body)))
        || j.mode === 'generate' && !same(decision.bodyRefs, j.bodies)) throw new Error('Generation source coverage decision witness mismatch.');
    }
    const entityIds = (s.entityWrites ?? []).map(write => write.analysisId);
    if (new Set(entityIds).size !== entityIds.length || (s.entityWrites ?? []).some(write => !j.sources.some(source => source.snapshotId === write.snapshotId && source.sourceVersion === write.sourceVersion))) {
      throw new Error('Invalid generation catalog source identities.');
    }
    const writes = s.stageKind === 'body' ? s.bodyWrites : s.stageKind === 'association' ? s.associationWrites
      : s.stageKind === 'source_ledger' ? s.ledgerWrites : s.coverageWrites;
    const total = (writes?.length ?? 0) + (s.entityWrites?.length ?? 0);
    if (s.committed > total || s.state === 'completed' && s.committed !== total
      || ['prepared_writes', 'completed'].includes(s.state) && writes === undefined
      || ['archived', 'prepared_writes', 'completed', 'failed'].includes(s.state) !== !!s.outcomeRef
      || s.stageKind !== 'body' && s.bodyWrites || s.stageKind !== 'association' && (s.associationWrites || s.entityWrites)
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
  const body = j.stages.find(s => s.stageKind === 'body');
  if (body) {
    const expected = (body.bodyWrites ?? []).slice(0, body.committed).map(w => {
      if (w.commandKind !== 'append_revision') throw new Error('Generation must not record maintenance.');
      return { knowledgeId: w.knowledgeId, revisionId: w.revision.revisionId, bodyDigest: w.revision.bodyDigest };
    });
    if (!same(expected, j.bodies)) throw new Error('Generation committed body references mismatch.');
  }
  const last = j.stages.at(-1)!;
  if (j.status === 'completed' && (last.state !== 'completed' || !(last.stageKind === 'association'
    || j.mode === 'review_sources' && last.stageKind === 'source_coverage'
    || j.mode === 'generate' && last.stageKind === 'source_coverage' && !j.bodies.length && j.sourceCoverageDecisionRef))
    || j.status === 'failed' && last.state !== 'failed') throw new Error('Generation terminal state mismatch.');
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
      || (parsed as { schemaVersion?: unknown })?.schemaVersion !== 4) throw new KnowledgeStorageStateError('knowledge_storage_unsupported');
    const journal = GenerationJournalSchema.parse(parsed);
    validateJournal(journal);
    if (journal.runId !== runId || new Set(journal.stages.map(s => s.stageKind)).size !== journal.stages.length
      || new Set(journal.stages.map(s => s.invocationId)).size !== journal.stages.length) throw new Error('Generation journal identity mismatch.');
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
      unsupported.push({ runId: file.slice(0, -5), schemaStatus: 'unsupported', reason: 'Legacy extraction run requires the matching old binary; generation-journal/v4 does not decode legacy dispatch claims.' });
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
      if (old) {
        const immutable = (j: GenerationJournal) => ({ runId: j.runId, mode: j.mode, createdAt: j.createdAt, actor: j.actor,
          sources: j.sources, executor: j.executor, model: j.model, timeoutMs: j.timeoutMs });
        for (const key of ['ledgerRef', 'coverageRef', 'sourceCoverageDecisionRef'] as const) {
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
        }
      }
      const claims = next.stages.filter((stage, index) => stage.state === 'claimed' && old?.stages[index]?.state !== 'claimed');
      for (const stage of claims) {
        if (old?.stages.find(s => s.invocationId === stage.invocationId)?.state !== 'prepared') throw new Error('Generation claim requires a prepared phase.');
        if (stage.stageKind === 'association' && !validateClaim) throw new Error('Association claim requires locked source review validation.');
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
