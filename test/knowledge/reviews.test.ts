import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication, createLocalKnowledgeReview } from '../../src/knowledge/application/local.js';
import { KnowledgeReviewApplication } from '../../src/knowledge/application/review.js';
import { executeKnowledgeReviewOperation, KnowledgeReviewOperationSchema } from '../../src/knowledge/application/review-operations.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeReviewStore } from '../../src/knowledge/adapters/review-store.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { captureTraceFixture, sourceRef } from '../helpers/knowledge-source.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import { knowledgeReviewSources, type KnowledgeContentReviewInput } from '../../src/knowledge/reviews.js';
import { validateKnowledgeReviewHistory } from '../../src/knowledge/review-history.js';
import { bodyActor, bodyAt, bodyWrite } from './body-fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const agent = { actorKind: 'agent' as const, actorId: 'codex:review-fixture', executionRef: 'fixture-execution' };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-review-')); roots.push(root);
  const app = createLocalKnowledgeApplication(root), sourceStore = new FileSourceStore(join(root, 'sources'), root);
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root), entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const associations = new FileKnowledgeAssociationStore(join(root, 'associations'), 'local', knowledge, entities, root);
  const store = new FileKnowledgeReviewStore(join(root, 'reviews'), 'local', root);
  const sources = ['Alpha', 'Beta'].map((text, index) => captureTraceFixture(root, { path: join(root, `source-${index}.jsonl`), records: [{ recordIndex: index,
    raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) }] }));
  const command = bodyWrite(); command.revision.content.segments = sources.map((source, index) => ({ segmentId: `s${index + 1}`, text: `${index ? 'Beta' : 'Alpha'} is a scoped source assertion, not verified truth.`,
    evidence: [{ source: { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion }, selection: { evidenceRef: source.excerpts[0].evidenceRef, start: 0, end: source.excerpts[0].text.length, quote: source.excerpts[0].text }, basis: 'source_assertion' }] }));
  command.revision.bodyDigest = knowledgeBodyDigest(command.revision); knowledge.write(command, bodyActor);
  const bodyRef = knowledgeBodyRef(command.revision), review = new KnowledgeReviewApplication({ knowledge, entities, associations, sources: sourceStore, reviews: store, actor: agent, now: () => bodyAt });
  const identity = () => { const status = review.status(bodyRef); return { requestId: randomUUID(), bodyRef, sources: knowledgeReviewSources(command.revision), expectedGeneration: status.generation!, expectedHeadEventId: status.headEventId }; };
  const content = (overrides: Partial<KnowledgeContentReviewInput> = {}): KnowledgeContentReviewInput => ({ ...identity(), status: 'needs_revision', reason: 'The source scope needs another review.', limitations: [],
    findings: [{ problemKind: 'omission', description: 'The entire project decision section is absent.', segmentIds: [] }], ...overrides });
  function projection(status: 'available' | 'failed' = 'available') {
    let previous; try { previous = associations.read(bodyRef.knowledgeId); } catch { /* authored first projection */ }
    const revisionId = randomUUID();
    associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: bodyRef.knowledgeId, expectedGeneration: previous?.generation ?? 0,
      expectedHeadRevisionId: previous?.writeHeadRevisionId ?? null, revision: { revisionId, ...(previous ? { parentRevisionId: previous.writeHeadRevisionId } : {}), bodyRef, status, reviewStatus: 'pending',
        catalogRefs: [], segmentEntityRefs: [], typedRelations: [], issues: status === 'failed' ? ['Fixture projection failed.'] : [], revisedAt: bodyAt, revisedBy: bodyActor, revisionReason: 'Authored projection for exact review' } }, bodyActor);
    return revisionId;
  }
  function linkedProjection() {
    const analysisId = randomUUID(), revisionId = randomUUID(), entityId = randomUUID(), mentionId = randomUUID(), source = sources[0];
    entities.write({ requestId: randomUUID(), analysisId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion, expectedGeneration: 0, expectedHeadRevisionId: null,
      revision: { revisionId, entities: [{ entityId, label: 'Alpha', description: 'Source-local Alpha', qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null }],
        mentions: [{ mentionId, entityId, selection: { evidenceRef: source.excerpts[0].evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'explicit', rationale: 'Exact source mention' }], limitations: [], revisedAt: bodyAt, revisedBy: bodyActor, revisionReason: 'Authored exact catalog' } }, bodyActor);
    const projectionRevisionId = randomUUID();
    associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: bodyRef.knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null,
      revision: { revisionId: projectionRevisionId, bodyRef, status: 'available', reviewStatus: 'pending', catalogRefs: [{ analysisId, entityRevisionId: revisionId }],
        segmentEntityRefs: [{ segmentId: 's1', analysisId, entityRevisionId: revisionId, entityId, mentionIds: [mentionId] }], typedRelations: [], issues: [], revisedAt: bodyAt, revisedBy: bodyActor, revisionReason: 'Exact mapping fixture' } }, bodyActor);
    return { projectionRevisionId, ref: { analysisId, entityRevisionId: revisionId, entityId, mentionIds: [mentionId] } };
  }
  const file = () => join(root, 'reviews', readdirSync(join(root, 'reviews')).find(name => name.endsWith('.json'))!);
  return { root, app, sourceStore, knowledge, entities, associations, store, sources, command, bodyRef, review, identity, content, projection, linkedProjection, file };
}
describe('exact knowledge review and task-use ledger', () => {
  it('keeps no record distinct from failed reads and accepts only a trusted host actor', () => {
    const f = fixture(), readonly = createLocalKnowledgeReview(f.root);
    expect(readonly.status(f.bodyRef)).toMatchObject({ storageStatus: 'absent', generation: 0, headEventId: null, content: { status: 'not_reviewed' }, coverage: { status: 'not_reviewed', projectionRevisionId: null, decisions: [{ status: 'unknown' }, { status: 'unknown' }] } });
    expect(() => readonly.reviewContent(f.content())).toThrow('trusted review actor');
    expect(() => createLocalKnowledgeReview(f.root, { actorKind: 'agent', actorId: ' ', executionRef: ' ' })).toThrow();
    expect(() => KnowledgeReviewOperationSchema.parse({ operation: 'review-content', ...f.content(), actor: bodyActor })).toThrow();
    const receipt = executeKnowledgeReviewOperation(f.review, { operation: 'review-content', ...f.content() });
    expect(receipt).toMatchObject({ committedGeneration: 1 });
    expect(f.review.status(f.bodyRef).content.events[0]).toMatchObject({ actor: agent, bodyRef: f.bodyRef, sources: knowledgeReviewSources(f.command.revision) });
    expect(existsSync(join(f.root, '.knowledge-write.lock'))).toBe(false);
  });
  it('retains concurrent opinions, gives active revision findings precedence, and supersedes only explicitly', () => {
    const f = fixture(), original = readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]));
    const negative = f.review.reviewContent(f.content());
    f.review.reviewContent(f.content({ status: 'reviewed_with_limits', reason: 'Reviewed independently within the saved source scope.', limitations: ['Execution and the complete project remain unverified.'], findings: [] }));
    let state = f.review.status(f.bodyRef);
    expect(state.content.status).toBe('needs_revision'); expect(state.content.events).toHaveLength(2);
    f.review.reviewContent(f.content({ status: 'reviewed_with_limits', reason: 'The original omission report was independently reconciled.', limitations: ['Still limited to the selected messages.'], findings: [], supersedesEventIds: [negative.eventId] }));
    state = f.review.status(f.bodyRef); expect(state.content.status).toBe('reviewed_with_limits'); expect(state.content.events).toHaveLength(2);
    expect(state.history?.events).toHaveLength(3); expect(state.history?.events[0].eventId).toBe(negative.eventId);
    expect(readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]))).toEqual(original);
    expect(() => f.review.reviewContent(f.content({ supersedesEventIds: [negative.eventId] }))).toThrow('supersession');
    const tampered = structuredClone(state.history!); tampered.events[1].parentEventId = null;
    expect(() => validateKnowledgeReviewHistory(tampered)).toThrow();
  });
  it('uses CAS and actor-bound receipts, retries only an identical request, and validates inside the shared lock', () => {
    const f = fixture(), command = f.content(), observed: boolean[] = [];
    const read = f.sourceStore.read.bind(f.sourceStore); vi.spyOn(f.sourceStore, 'read').mockImplementation((id, version) => { observed.push(existsSync(join(f.root, '.knowledge-write.lock'))); return read(id, version); });
    const receipt = f.review.reviewContent(command), bytes = readFileSync(f.file());
    expect(observed.length).toBeGreaterThan(0); expect(observed.every(Boolean)).toBe(true);
    expect(createLocalKnowledgeReview(f.root, agent).reviewContent(command)).toEqual(receipt); expect(readFileSync(f.file())).toEqual(bytes);
    expect(() => createLocalKnowledgeReview(f.root, bodyActor).reviewContent(command)).toThrow('idempotency conflict');
    expect(() => f.review.reviewContent({ ...command, reason: 'Changed request payload' })).toThrow('idempotency conflict');
    expect(() => f.review.reviewContent({ ...command, requestId: randomUUID() })).toThrow('revision conflict');
    expect(() => f.review.reviewContent(f.content({ sources: knowledgeReviewSources(f.command.revision).slice(0, 1) }))).toThrow('source identity conflict');
    expect(readFileSync(f.file())).toEqual(bytes); expect(existsSync(join(f.root, '.knowledge-write.lock'))).toBe(false);
  });
  it('records all segment decisions with null or failed projection identities and resets when a real projection appears', () => {
    const f = fixture(), decisions = [{ segmentId: 's1', status: 'gap' as const, reason: 'The project object is missing.' }, { segmentId: 's2', status: 'unknown' as const, reason: 'No reliable basis to classify.' }];
    f.review.reviewCoverage({ ...f.identity(), projectionRevisionId: null, decisions, reason: 'No derived projection exists yet.' });
    expect(f.review.status(f.bodyRef).coverage).toMatchObject({ status: 'recorded', projectionRevisionId: null, decisions: [{ status: 'gap' }, { status: 'unknown' }] });
    const projectionRevisionId = f.projection('failed');
    expect(f.review.status(f.bodyRef).coverage).toMatchObject({ status: 'not_reviewed', projectionRevisionId, decisions: [{ status: 'unknown' }, { status: 'unknown' }] });
    expect(() => f.review.reviewCoverage({ ...f.identity(), projectionRevisionId: null, decisions, reason: 'Stale absence assumption.' })).toThrow('projection identity conflict');
    f.review.reviewCoverage({ ...f.identity(), projectionRevisionId, decisions, reason: 'Failed projection has a known gap.' });
    expect(f.review.status(f.bodyRef).coverage.status).toBe('recorded');
    const next = f.projection(); expect(f.review.status(f.bodyRef).coverage).toMatchObject({ status: 'not_reviewed', projectionRevisionId: next });
    expect(f.review.status(f.bodyRef, projectionRevisionId).coverage.status).toBe('recorded');
    expect(() => f.review.reviewCoverage({ ...f.identity(), projectionRevisionId: next, decisions: decisions.slice(0, 1), reason: 'Incomplete vector.' })).toThrow('every exact body segment');
  });
  it('accepts only projection-qualified entity/mention references and preserves contradictory per-segment opinions', () => {
    const f = fixture(), linked = f.linkedProjection();
    const decisions = [{ segmentId: 's1', status: 'linked' as const, entityRefs: [linked.ref], reason: 'The saved exact mapping was inspected.' }, { segmentId: 's2', status: 'no_reliable_object' as const, reason: 'The source only provides a report, without a reliable object.' }];
    f.review.reviewCoverage({ ...f.identity(), projectionRevisionId: linked.projectionRevisionId, decisions, reason: 'Review the two exact source scopes separately.' });
    expect(f.review.status(f.bodyRef).coverage.decisions.map(decision => decision.status)).toEqual(['linked', 'no_reliable_object']);
    expect(() => f.review.reviewCoverage({ ...f.identity(), projectionRevisionId: linked.projectionRevisionId,
      decisions: [{ ...decisions[0], entityRefs: [{ ...linked.ref, mentionIds: [randomUUID()] }] }, decisions[1]], reason: 'Wrong mention must fail.' })).toThrow('outside the exact projection');
    f.review.reviewCoverage({ ...f.identity(), projectionRevisionId: linked.projectionRevisionId, decisions: [{ segmentId: 's1', status: 'no_reliable_object', reason: 'Another reviewer disputes this identity.' }, decisions[1]], reason: 'Keep the independent opinion.' });
    expect(f.review.status(f.bodyRef).coverage.decisions[0]).toMatchObject({ status: 'unknown', opinions: [{ status: 'linked' }, { status: 'no_reliable_object' }] });
  });
  it('keeps all five use signals separate, binds historical consumption exactly and permits missing original sources', () => {
    const f = fixture(); f.review.reviewContent(f.content());
    const updated = f.app.revise(f.bodyRef.knowledgeId, f.bodyRef.revisionId, 1, { title: 'New body revision', content: f.command.revision.content, reuseRationale: f.command.revision.reuseRationale }, 'Explicit new body fixture');
    for (const source of f.sources) f.app.deleteSource(sourceRef(source));
    for (const signal of ['provided', 'read', 'reported_use', 'observed_help', 'controlled_effect'] as const) f.review.recordUse({ ...f.identity(), taskRef: 'task:exact-consumer', query: 'What scope applies to Alpha?', segmentIds: ['s1'], signal,
      reason: `Explicit ${signal} fixture; signals do not imply causation.`, issueKind: 'source_unavailable', evidenceRefs: signal === 'observed_help' || signal === 'controlled_effect' ? ['comparison:fixture-current-versus-baseline'] : [] });
    const historical = f.review.status(f.bodyRef), current = f.review.status(knowledgeBodyRef(updated.revision));
    expect(historical.usage.map(event => event.signal)).toEqual(['provided', 'read', 'reported_use', 'observed_help', 'controlled_effect']);
    expect(historical.usage.every(event => event.bodyRef.revisionId === f.bodyRef.revisionId)).toBe(true);
    expect(historical.usage.every(event => event.issueKind === 'source_unavailable')).toBe(true);
    expect(historical.sources.every(source => source.status === 'unavailable')).toBe(true);
    expect(historical.content.status).toBe('needs_revision'); expect(current.content.status).toBe('not_reviewed'); expect(current.usage).toEqual([]);
    expect(() => f.review.recordUse({ ...f.identity(), taskRef: 'task:missing-evidence', query: 'Alpha?', segmentIds: ['s1'], signal: 'controlled_effect', reason: 'No comparison reference.' })).toThrow();
    expect(() => f.review.recordUse({ ...f.identity(), taskRef: 'task:wrong-segment', query: 'Alpha?', segmentIds: ['missing'], signal: 'reported_use', reason: 'No such segment.' })).toThrow('Unknown consumed');
  });
  it('checks optional new evidence against exact snapshots, while preserving valid opinions after source loss', () => {
    const f = fixture(), evidence = f.command.revision.content.segments[0].evidence[0];
    const input = f.content({ findings: [{ problemKind: 'scope_error', description: 'Inspect this exact quote.', segmentIds: ['s1'], evidence: [evidence] }] });
    f.review.reviewContent(input); const bytes = readFileSync(f.file());
    expect(() => f.review.reviewContent(f.content({ findings: [{ problemKind: 'scope_error', description: 'A changed quote must fail.', segmentIds: ['s1'], evidence: [{ ...evidence, selection: { ...evidence.selection, quote: 'Beta' } }] }] }))).toThrow('evidence');
    expect(readFileSync(f.file())).toEqual(bytes);
    const later = captureTraceFixture(f.root, { path: join(f.root, 'later-task.jsonl'), records: [{ recordIndex: 2,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Gamma' }] } }) }] });
    const laterEvidence = { ...evidence, source: { snapshotId: later.snapshotId, sourceVersion: later.sourceVersion },
      selection: { evidenceRef: later.excerpts[0].evidenceRef, start: 0, end: 5, quote: 'Gamma' } };
    expect(() => f.review.reviewContent(f.content({ findings: [{ problemKind: 'scope_error', description: 'A registered source outside the pinned body cannot support its content review.', segmentIds: [], evidence: [laterEvidence] }] }))).toThrow('body sources');
    expect(readFileSync(f.file())).toEqual(bytes);
    f.review.recordUse({ ...f.identity(), taskRef: 'task:later-result', query: 'What happened with Gamma?', segmentIds: ['s1'], signal: 'read',
      reason: 'Task evidence may reference its separately registered outcome.', evidence: [laterEvidence] });
    expect(f.review.status(f.bodyRef).usage[0].evidence).toEqual([laterEvidence]);
    f.app.deleteSource(sourceRef(f.sources[0])); expect(f.review.status(f.bodyRef).content.events[0]).toMatchObject({ findings: [{ evidence: [evidence] }] });
    f.review.reviewContent(f.content({ status: 'reviewed_with_limits', reason: 'Read the saved body with explicit source limits.', limitations: ['Original Alpha source is no longer available.'], findings: [] }));
    expect(f.review.status(f.bodyRef).content.status).toBe('needs_revision');
  });
  it('does not reinterpret damaged, unsupported or redirected ledgers as an empty review history', () => {
    const f = fixture(); f.review.reviewContent(f.content()); const file = f.file(), bytes = readFileSync(file);
    const altered = JSON.parse(bytes.toString()); altered.events[0].reason = 'Changed outside the recorded command.';
    for (const raw of ['{bad', JSON.stringify({ ...JSON.parse(bytes.toString()), schemaVersion: 0 }), JSON.stringify(altered)]) {
      writeFileSync(file, raw); expect(f.review.status(f.bodyRef)).toMatchObject({ storageStatus: 'unavailable', generation: null, headEventId: null, content: { status: 'unavailable' }, coverage: { status: 'unavailable' } });
      expect(() => f.review.reviewContent({ ...f.content(), expectedGeneration: 0 })).toThrow(); expect(readFileSync(file, 'utf8')).toBe(raw);
    }
    writeFileSync(file, bytes); const target = join(f.root, 'original-review.json'); writeFileSync(target, bytes); rmSync(file); symlinkSync(target, file);
    expect(f.review.status(f.bodyRef).storageStatus).toBe('unavailable');
    expect(() => f.review.reviewContent({ ...f.content(), expectedGeneration: 1 })).toThrow(); expect(readFileSync(target)).toEqual(bytes);
    rmSync(join(f.root, 'reviews'), { recursive: true });
    const missingDirectory = join(f.root, 'missing-review-directory'); symlinkSync(missingDirectory, join(f.root, 'reviews'), 'dir');
    expect(f.review.status(f.bodyRef)).toMatchObject({ storageStatus: 'unavailable', generation: null, content: { status: 'unavailable' } });
    expect(() => f.review.reviewContent({ ...f.content(), expectedGeneration: 1 })).toThrow('Invalid knowledge review directory');
    expect(existsSync(missingDirectory)).toBe(false); expect(readFileSync(target)).toEqual(bytes);
    const redirected = new FileKnowledgeReviewStore(join(f.root, 'reviews'), 'local', join(f.root, 'reviews'));
    expect(() => redirected.read(f.bodyRef.knowledgeId)).toThrow('Invalid knowledge review directory');
  });
});
