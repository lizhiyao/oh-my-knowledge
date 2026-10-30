import type { KnowledgeActor, KnowledgeBodyRef } from '../contracts.js';
import type { KnowledgeStore } from '../store.js';
import { canonicalJson } from '../store.js';
import type { SourceStore } from '../source-store.js';
import type { SourceLedgerRef, SourceCoverageRef, SourceCoverageDecisionRef, SourceReviewManifest,
  SourceLedgerRevision, SourceCoverageRevision, SourceLedgerStore, SourceCoverageStore } from '../source-review.js';
import { SourceLedgerRefSchema, SourceCoverageRefSchema, SourceCoverageDecisionRefSchema, SourceReviewActorSchema,
  SourceLedgerWriteSchema, SourceCoverageWriteSchema } from '../source-review.js';
import { assertSourceCoverageDecision, selectSourceCoverageDecision, validateSourceCoverageData,
  validateSourceCoverageDecisionDispositions } from '../source-review-history.js';
import { generationTextDigest } from '../extraction/body-generation-wire.js';
import { checkGeneratedSourceLedger, checkGeneratedSourceCoverage, sourceLedgerModelInput, sourceCoverageModelInput,
  SOURCE_LEDGER_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE,
  type SourceReviewGenerationProfile } from '../extraction/source-review-wire.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export interface SourceReviewOriginalRequest { profile: SourceReviewGenerationProfile; input: string }
export interface SourceReviewPorts {
  sources: SourceStore; knowledge: KnowledgeStore; ledgers: SourceLedgerStore; coverage: SourceCoverageStore;
  actor?: KnowledgeActor; now(): string; assertWritable?(): void;
  /** Verify successful native custody and the exact phase/input/request before returning its raw output. */
  readOriginal?(original: SourceLedgerRevision['modelOriginal'], expected: SourceReviewOriginalRequest): string;
}

/** Model analyses and actual decisions are separate; dispatch must recheck the decision under its claim lock. */
export class SourceReviewApplication {
  constructor(private readonly ports: SourceReviewPorts) {
    if (ports.actor !== undefined) SourceReviewActorSchema.parse(ports.actor);
  }
  ledger(ledgerId: string, revisionId?: string) {
    const history = this.ports.ledgers.read(ledgerId);
    const revision = history?.events.filter(event => event.eventKind === 'analysis')
      .map(event => event.revision).filter(value => !revisionId || value.revisionId === revisionId).at(-1);
    if (!history || !revision) throw new Error('The exact source ledger analysis is unavailable.');
    return { history, revision, ref: { ledgerId, revisionId: revision.revisionId, digest: revision.digest },
      sources: this.sourceStates(revision.data.manifest), originalVerification: 'not_verified' as const };
  }
  coverage(coverageId: string, revisionId?: string) {
    const history = this.ports.coverage.read(coverageId);
    const revision = history?.events.filter(event => event.eventKind === 'analysis')
      .map(event => event.revision).filter(value => !revisionId || value.revisionId === revisionId).at(-1);
    if (!history || !revision) throw new Error('The exact source coverage analysis is unavailable.');
    const ref = { coverageId, revisionId: revision.revisionId, digest: revision.digest };
    return { history, revision, ref, decision: selectSourceCoverageDecision(history, ref),
      sources: this.sourceStates(revision.data.manifest), bodies: revision.data.bodyRefs.map(bodyRef => {
        try { this.body(bodyRef); return { bodyRef, status: 'available' as const }; }
        catch { return { bodyRef, status: 'unavailable' as const }; }
      }), originalVerification: 'not_verified' as const };
  }
  private sourceStates(manifest: SourceReviewManifest) {
    return manifest.sources.map(({ sourceRef }) => {
      try { return { sourceRef, status: this.ports.sources.read(sourceRef.snapshotId, sourceRef.sourceVersion).status }; }
      catch { return { sourceRef, status: 'unavailable' as const }; }
    });
  }
  private sources(manifest: SourceReviewManifest) {
    return manifest.sources.map(({ sourceRef }) => {
      const resolved = this.ports.sources.read(sourceRef.snapshotId, sourceRef.sourceVersion);
      if (resolved.status !== 'available') throw new Error('An exact source review snapshot is unavailable.');
      return resolved.snapshot;
    });
  }
  private body(ref: KnowledgeBodyRef) {
    const body = this.ports.knowledge.read(ref.knowledgeId).revisions.find(value => value.revisionId === ref.revisionId);
    if (!body || !same(ref, { knowledgeId: body.knowledgeId, revisionId: body.revisionId, bodyDigest: body.bodyDigest })) {
      throw new Error('Source review body identity conflict.');
    }
    return body;
  }
  private original(ref: SourceLedgerRevision['modelOriginal'], expected: SourceReviewOriginalRequest) {
    if (!this.ports.readOriginal) throw new Error('A trusted source review original reader is required.');
    const raw = this.ports.readOriginal(ref, expected);
    if (generationTextDigest(raw) !== ref.outputDigest) throw new Error('Source review native output digest conflict.');
    return raw;
  }
  private checkedLedger(ref: SourceLedgerRef) {
    const selected = this.ledger(ref.ledgerId, ref.revisionId);
    if (!same(ref, selected.ref)) throw new Error('Source ledger reference conflict.');
    this.validateLedger(selected.revision); return selected;
  }
  private validateLedger(revision: SourceLedgerRevision) {
    const sources = this.sources(revision.data.manifest);
    const raw = this.original(revision.modelOriginal, { profile: SOURCE_LEDGER_GENERATION_PROFILE, input: sourceLedgerModelInput(sources) });
    if (!same(checkGeneratedSourceLedger(raw, sources), revision.data)) throw new Error('Source ledger differs from its native original.');
  }
  private checkedCoverage(ref: SourceCoverageRef) {
    const selected = this.coverage(ref.coverageId, ref.revisionId);
    if (!same(ref, selected.ref)) throw new Error('Source coverage reference conflict.');
    const ledger = this.checkedLedger(SourceLedgerRefSchema.parse(selected.revision.data.ledgerRef));
    this.validateCoverage(selected.revision, ledger); return { ...selected, ledger };
  }
  private validateCoverage(revision: SourceCoverageRevision, ledger = this.checkedLedger(revision.data.ledgerRef)) {
    const sources = this.sources(revision.data.manifest), bodies = revision.data.bodyRefs.map(ref => this.body(ref));
    validateSourceCoverageData(revision.data, ledger.revision, bodies);
    const raw = this.original(revision.modelOriginal, { profile: SOURCE_COVERAGE_GENERATION_PROFILE,
      input: sourceCoverageModelInput(sources, { ref: ledger.ref, data: ledger.revision.data }, bodies) });
    if (!same(checkGeneratedSourceCoverage(raw, sources, { ref: ledger.ref, data: ledger.revision.data }, bodies), revision.data)) {
      throw new Error('Source coverage differs from its native original.');
    }
  }
  private writableActor() {
    if (!this.ports.actor) throw new Error('A trusted actual source review actor is required for writes.');
    this.ports.assertWritable?.(); return SourceReviewActorSchema.parse(this.ports.actor);
  }
  writeLedger(input: unknown) {
    const actor = this.writableActor(), command = SourceLedgerWriteSchema.parse(input);
    return this.ports.ledgers.write(command, actor, this.ports.now(), () => this.validateLedger(command.revision));
  }
  writeCoverage(input: unknown) {
    const actor = this.writableActor(), command = SourceCoverageWriteSchema.parse(input);
    return this.ports.coverage.write(command, actor, this.ports.now(), () => {
      if (command.commandKind === 'append_analysis') this.validateCoverage(command.revision);
      if (command.commandKind === 'record_decision') {
        const selected = this.checkedCoverage(SourceCoverageRefSchema.parse(command.decision.coverageRef));
        validateSourceCoverageDecisionDispositions(command, selected.revision, selected.ledger.revision);
      }
      // Revocation withdraws a prior opinion even when its sources/originals are now unavailable.
    });
  }
  /** Preparation may call this, but association claims must also call it inside the shared workspace lock. */
  assertDecision(input: SourceCoverageDecisionRef) {
    const ref = SourceCoverageDecisionRefSchema.parse(input), selected = this.checkedCoverage(ref.coverageRef);
    assertSourceCoverageDecision(selected.history, ref);
    return ref;
  }
}
