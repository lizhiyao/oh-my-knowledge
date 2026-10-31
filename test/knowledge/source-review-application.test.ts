import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { testDirectory } from '../helpers/temp-directory.js';
import { bodyActor, bodyAt, bodyWrite } from './body-fixtures.js';
import { sourceReviewModelFixture } from './source-review-model-fixtures.js';
import { SourceReviewApplication, type SourceReviewOriginalRequest } from '../../src/knowledge/application/source-review.js';
import { createLocalKnowledgeSourceReview } from '../../src/knowledge/application/local.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileSourceLedgerStore, FileSourceCoverageStore, sourceReviewRevisionDigest } from '../../src/knowledge/adapters/source-review-store.js';
import { generationTextDigest } from '../../src/knowledge/extraction/body-generation-wire.js';
import { checkGeneratedSourceLedger, checkGeneratedSourceCoverage, sourceLedgerModelInput, sourceCoverageModelInput,
  SOURCE_LEDGER_GENERATION_PROFILE, SOURCE_COVERAGE_GENERATION_PROFILE } from '../../src/knowledge/extraction/source-review-wire.js';
import { sourceCoverageUnresolved } from '../../src/knowledge/source-review-history.js';
import { SourceCoverageWriteSchema, type SourceLedgerWrite, type SourceCoverageWrite } from '../../src/knowledge/source-review.js';
import type { SourceStore } from '../../src/knowledge/source-store.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { actorKind: 'agent' as const, actorId: 'source-review-operator', executionRef: 'test:actual-host-operation' };
function decisionRef(command: SourceCoverageWrite) {
  if (command.commandKind !== 'record_decision') throw new Error('Fixture decision missing.');
  const { coverageRef, sourceSetId, ledgerRef, bodyRefs } = command.decision;
  return { coverageRef, sourceSetId, ledgerRef, bodyRefs, eventId: command.requestId };
}
function fixture(empty = false, legacyCoverage = false) {
  const f = sourceReviewModelFixture(), root = testDirectory('omk-source-review-application-');
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root);
  const bodies = empty ? [] : [f.body()];
  for (const body of bodies) knowledge.write({ ...bodyWrite(), revision: body }, bodyActor);
  const ledgers = new FileSourceLedgerStore(join(root, 'source-ledgers'), 'local', root);
  const coverage = new FileSourceCoverageStore(join(root, 'source-coverage'), 'local', root);
  let currentSource = f.source, originalAvailable = true;
  const sources: SourceStore = { read: () => ({ status: 'available', snapshot: currentSource }),
    capture: vi.fn(), captureBatch: vi.fn(), delete: vi.fn() };
  const originals = new Map<string, { original: SourceLedgerWrite['revision']['modelOriginal']; input: string; profileId: string; raw: string }>();
  function original(n: number, request: SourceReviewOriginalRequest, raw: string, profileId = request.profile.profileId) {
    const value = { runId: id(n), invocationId: id(n + 1), requestDigest: generationTextDigest(request.input),
      archiveRef: `outcomes/${id(n)}/${id(n + 1)}.json`, archiveDigest: generationTextDigest(`native:${raw}`), outputDigest: generationTextDigest(raw) };
    originals.set(value.invocationId, { original: value, input: request.input, profileId, raw }); return value;
  }
  const readOriginal = vi.fn((ref: SourceLedgerWrite['revision']['modelOriginal'], request: SourceReviewOriginalRequest) => {
    if (!originalAvailable) throw new Error('Native original unavailable.');
    const saved = originals.get(ref.invocationId);
    if (!saved || JSON.stringify(saved.original) !== JSON.stringify(ref)) throw new Error('Native custody mismatch.');
    if (saved.input !== request.input || saved.profileId !== request.profile.profileId) throw new Error('Native request scope mismatch.');
    return saved.raw;
  });
  const ports = { sources, knowledge, ledgers, coverage, actor, now: () => bodyAt, readOriginal };
  const app = new SourceReviewApplication(ports), rawLedger = JSON.stringify(f.ledgerOutput());
  const ledgerContent = { revisionId: id(12), parentRevisionId: null, revisedAt: bodyAt, revisedBy: actor,
    modelOriginal: original(100, { profile: SOURCE_LEDGER_GENERATION_PROFILE, input: sourceLedgerModelInput([f.source]) }, rawLedger),
    data: checkGeneratedSourceLedger(rawLedger, [f.source]) };
  const ledgerRevision = { ...ledgerContent, digest: sourceReviewRevisionDigest(ledgerContent) };
  const ledgerRef = { ledgerId: id(11), revisionId: ledgerRevision.revisionId, digest: ledgerRevision.digest };
  const ledgerCommand: SourceLedgerWrite = { commandKind: 'append_analysis', ledgerId: ledgerRef.ledgerId,
    requestId: id(13), expectedGeneration: 0, expectedHeadEventId: null, revision: ledgerRevision };
  const ledger = { ref: ledgerRef, data: ledgerRevision.data }, response = empty ? f.emptyCoverageOutput() : f.coverageOutput();
  const rawCoverage = JSON.stringify(response);
  // Schema1 without a bounded witness is identical after compilation; retain a historical wire2 original, never decode it as wire3.
  const originalCoverage = legacyCoverage ? JSON.stringify({ ...response, schemaVersion: 2 }) : rawCoverage;
  const coverageProfileId = legacyCoverage ? 'sha256:7a8fe731bee5b2490f8caf1d694b126bb9632300253e095087ccfce302d10c09'
    : SOURCE_COVERAGE_GENERATION_PROFILE.profileId;
  const coverageContent = { revisionId: id(22), parentRevisionId: null, revisedAt: bodyAt, revisedBy: actor,
    modelOriginal: original(200, { profile: SOURCE_COVERAGE_GENERATION_PROFILE, input: sourceCoverageModelInput([f.source], ledger, bodies) }, originalCoverage, coverageProfileId),
    data: checkGeneratedSourceCoverage(rawCoverage, [f.source], ledger, bodies) };
  const coverageRevision = { ...coverageContent, digest: sourceReviewRevisionDigest(coverageContent) };
  const coverageRef = { coverageId: id(21), revisionId: coverageRevision.revisionId, digest: coverageRevision.digest };
  const coverageCommand: SourceCoverageWrite = { commandKind: 'append_analysis', coverageId: coverageRef.coverageId,
    requestId: id(23), expectedGeneration: 0, expectedHeadEventId: null, revision: coverageRevision };
  function decision() {
    return SourceCoverageWriteSchema.parse({ commandKind: 'record_decision', coverageId: coverageRef.coverageId,
      requestId: id(24), expectedGeneration: 1, expectedHeadEventId: coverageCommand.requestId,
      decision: { coverageRef, sourceSetId: coverageRevision.data.manifest.sourceSetId, ledgerRef, bodyRefs: coverageRevision.data.bodyRefs,
        decisionKind: 'proceed_with_limits', reason: 'Actual operator reviewed this exact limited analysis.',
        limitations: ['No factual or general quality certification.'], supersedesEventIds: [],
        dispositions: sourceCoverageUnresolved(coverageRevision.data, ledger.data).map(unresolvedId => ({ unresolvedId,
          disposition: empty ? 'blocks' : 'accepted_limit', reason: 'Actual operator disposition.' })) } });
  }
  return { f, root, app, ports, ledgers, coverage, ledgerRef, coverageRef, ledgerCommand, coverageCommand, decision, readOriginal,
    changeSource: () => { currentSource = { ...f.source, capturedAt: '2026-10-31T00:00:00Z' }; },
    hideOriginal: () => { originalAvailable = false; } };
}

describe('trusted source review application', () => {
  it('publishes native-bound analyses without approval, then requires an actual exact decision', () => {
    const f = fixture(); f.app.writeLedger(f.ledgerCommand); f.app.writeCoverage(f.coverageCommand);
    expect(f.app.coverage(f.coverageRef.coverageId).decision.status).toBe('not_reviewed');
    const command = f.decision(); if (command.commandKind !== 'record_decision') throw new Error('Fixture decision missing.');
    const ref = { coverageRef: f.coverageRef, sourceSetId: command.decision.sourceSetId, ledgerRef: f.ledgerRef,
      bodyRefs: command.decision.bodyRefs, eventId: command.requestId };
    expect(() => f.app.assertDecision(ref)).toThrow('active nonconflicting');
    f.app.writeCoverage(command); expect(f.app.assertDecision(ref)).toEqual(ref);
    expect(f.app.coverage(f.coverageRef.coverageId).originalVerification).toBe('not_verified');
    expect(f.readOriginal).toHaveBeenCalled();
    f.changeSource(); expect(() => f.app.assertDecision(ref)).toThrow('Native request scope mismatch');
  });
  it('rejects rewritten model data and foreign custody before publishing another analysis', () => {
    const f = fixture(); f.app.writeLedger(f.ledgerCommand);
    const altered = structuredClone(f.ledgerCommand);
    altered.requestId = id(31); altered.expectedGeneration = 1; altered.expectedHeadEventId = f.ledgerCommand.requestId;
    altered.revision.revisionId = id(32); altered.revision.parentRevisionId = f.ledgerCommand.revision.revisionId;
    altered.revision.data.items[0].reason = 'A later edit is not the archived model original.';
    const { digest: _digest, ...content } = altered.revision; void _digest;
    altered.revision.digest = sourceReviewRevisionDigest(content);
    expect(() => f.app.writeLedger(altered)).toThrow('differs from its native original');
    expect(f.ledgers.read(f.ledgerRef.ledgerId)?.generation).toBe(1);
    const foreign = structuredClone(altered); foreign.revision.modelOriginal.requestDigest = generationTextDigest('foreign request');
    const { digest: _foreignDigest, ...foreignContent } = foreign.revision; void _foreignDigest;
    foreign.revision.digest = sourceReviewRevisionDigest(foreignContent);
    expect(() => f.app.writeLedger(foreign)).toThrow('Native custody mismatch');
  });
  it('keeps reads available without an actor, replays exact receipts, and permits safe revocation after original loss', () => {
    const f = fixture(), first = f.app.writeLedger(f.ledgerCommand); f.app.writeCoverage(f.coverageCommand);
    const command = f.decision(); f.app.writeCoverage(command); f.hideOriginal();
    expect(f.app.writeLedger(f.ledgerCommand)).toEqual(first);
    const reader = createLocalKnowledgeSourceReview(f.root);
    expect(reader.coverage(f.coverageRef.coverageId).decision.status).toBe('proceed_with_limits');
    expect(() => reader.writeCoverage(command)).toThrow('actual source review actor');
    if (command.commandKind !== 'record_decision') throw new Error('Fixture decision missing.');
    expect(() => f.app.assertDecision(decisionRef(command))).toThrow('Native original unavailable');
    f.app.writeCoverage({ commandKind: 'revoke_decision', coverageId: f.coverageRef.coverageId, requestId: id(25),
      expectedGeneration: 2, expectedHeadEventId: command.requestId, targetEventId: command.requestId, reason: 'Withdraw while the original is unavailable.' });
    expect(reader.coverage(f.coverageRef.coverageId).decision.status).toBe('not_reviewed');
  });
  it('preserves a zero-body omission analysis and an actual needs-revision decision without a placeholder body', () => {
    const f = fixture(true); f.app.writeLedger(f.ledgerCommand); f.app.writeCoverage(f.coverageCommand);
    const command = f.decision(); if (command.commandKind !== 'record_decision') throw new Error('Fixture decision missing.');
    command.decision.decisionKind = 'needs_revision'; f.app.writeCoverage(command);
    const status = f.app.coverage(f.coverageRef.coverageId);
    expect(status.revision.data.bodyRefs).toEqual([]); expect(status.decision.status).toBe('needs_revision');
    expect(status.revision.data.checks.every(check => check.status === 'omitted')).toBe(true);
    expect(() => f.app.assertDecision(decisionRef(command))).toThrow('active nonconflicting');
  });
  it('passively reads an old compiled Schema1 analysis without inheriting its wire2 decision eligibility', () => {
    const f = fixture(false, true); f.app.writeLedger(f.ledgerCommand);
    // Seed already committed historical domain events; the current application must not republish the old model original.
    f.coverage.write(f.coverageCommand, actor, bodyAt, () => {});
    const command = f.decision(); f.coverage.write(command, actor, bodyAt, () => {});
    const status = f.app.coverage(f.coverageRef.coverageId);
    expect(status).toMatchObject({ originalVerification: 'not_verified', decision: { status: 'proceed_with_limits' },
      revision: { data: f.coverageCommand.revision.data } });
    expect(status.history.generation).toBe(2);
    expect(() => f.app.assertDecision(decisionRef(command))).toThrow('Native request scope mismatch');
    if (command.commandKind !== 'record_decision') throw new Error('Fixture decision missing.');
    const newDecision = structuredClone(command);
    newDecision.requestId = id(26); newDecision.expectedGeneration = 2; newDecision.expectedHeadEventId = command.requestId;
    newDecision.decision.supersedesEventIds = [command.requestId];
    expect(() => f.app.writeCoverage(newDecision)).toThrow('Native request scope mismatch');
    expect(f.coverage.read(f.coverageRef.coverageId)?.generation).toBe(2);
  });
});
