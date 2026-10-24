import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { FileExtractionRunStore } from '../../src/knowledge/adapters/run-store.js';
import type { EvidenceWindow } from '../../src/knowledge/extraction/evidence.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { boundKnowledgeExecution, boundKnowledgeRequestDigest, type BoundKnowledgeReceipt }
  from '../../src/knowledge/extraction/bound-knowledge-evidence.js';
import { entityReviewExecution, entityReviewRequestDigest, type EntityReviewReceipt }
  from '../../src/knowledge/extraction/entity-review-evidence.js';
import { reviewedKnowledgeExecution, reviewedKnowledgeRequestDigest, type ReviewedKnowledgeReceipt }
  from '../../src/knowledge/extraction/reviewed-knowledge-evidence.js';
import { discoveryBytes, discoveryHash, discoveryRef } from './discovered-entities-fixtures.js';
import { refinedEntitiesFixture } from './refined-entities-fixtures.js';
import { wireModelWindow } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = (second: number) => `2026-10-24T00:00:${second.toString().padStart(2, '0')}Z`;

/** Authored originals and real stores; no provider invocation or semantic acceptance evidence. */
function setup(executor: 'codex' | 'openai-api' = 'codex') {
  const f = refinedEntitiesFixture(executor, { collection: true, unresolved: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-refined-knowledge-'))); roots.push(root);
  const window: EvidenceWindow = { ...structuredClone(f.source), sourceKind: 'codex', sourcePath: '/authored/private-source',
    projectionVersion: 'knowledge-window-v2', capturedAt: at(0), startRecord: 0, endRecord: 0,
    records: [{ recordIndex: 0, raw: 'Authored envelope only.' }] };
  const ports = {
    evidence: { capture: () => { throw new Error('No capture.'); }, read: () => ({ status: 'available' as const, window }), delete: vi.fn() },
    entities: new FileEntityAnalysisStore(join(root, 'entities'), root),
    knowledge: new FileKnowledgeStore(join(root, 'items'), 'local', root),
    runs: new FileExtractionRunStore(join(root, 'runs'), root), tags: new FileKnowledgeTags(join(root, 'tags'), 'local', root),
    actor: { actorKind: 'agent' as const, actorId: 'authored-handoff', executionRef: 'authored-only' },
    hash: (value: unknown) => discoveryHash(canonicalJson(value)), id: vi.fn(() => { throw new Error('No new ID allocation.'); }),
    now: vi.fn(() => { throw new Error('Preserve archived completion time.'); }),
    sourcePlanArchive: f.sourcePlanArchive, discoveredEntitiesArchive: f.discoveredEntitiesArchive,
    refinedEntitiesArchive: f.refinedEntitiesArchive,
  };
  const selection = { snapshotId: f.source.snapshotId, sourceVersion: f.source.sourceVersion }, app = new KnowledgeApplication(ports);
  const imported = app.importRefinedEntities(selection, f.model, f.references());
  if (imported.status !== 'committed') throw new Error('Authored final catalog must be ready.');
  const context = app.refinedBoundKnowledgeContext(selection, f.model, f.references());
  const proposal = structuredClone(wireModelWindow().proposals[0]);
  const ids = context.catalog.entities.slice(0, 2).map(entity => entity.entityId);
  proposal.entityIds = ids; proposal.mentionIds = context.catalog.mentions.slice(0, 2).map(mention => mention.mentionId);
  proposal.draft.content.statements[0].subject.entityId = ids[0]; proposal.draft.content.statements[0].object!.entityId = ids[1];
  const response = { responseKind: 'bound-knowledge' as const, schemaVersion: 2 as const, binding: {}, proposals: [proposal], catalogGaps: [],
    materialAccounting: [{ materialId: 'use', meaning: 'Authored use claim.',
      anchors: [{ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta', occurrence: null }], dispositionKind: 'expressed' as const,
      statementRefs: [{ proposalId: proposal.proposalId, statementId: 'usage' }], reason: null, catalogGapIds: [] }],
    excerptAccounting: [{ evidenceRef: 'record-1', materialIds: ['use'], noMaterialReason: null }] };
  const nativeResult = (output: string) => ({ ok: true, output, durationMs: 5, numTurns: 1, fullNumTurns: 1,
    numSubAgents: 0, attemptCount: 1, stopReason: executor === 'codex' ? 'end_turn' : 'stop' });
  return { ...f, root, ports, app, selection, imported, context, response, nativeResult };
}

function archive<T extends { receiptId: string; attemptId: string; requestDigest: string; nativeRef: ReturnType<typeof discoveryRef> }>(
  receipt: T, native: { receiptId: string; attemptId: string; outcome: { result: { output: string } } },
  requestDigest: (receipt: T) => string, inspect: ReturnType<typeof setup>['old']['inspect']) {
  let receiptBytes: Buffer, outcomeBytes: Buffer;
  const reseal = () => {
    outcomeBytes = discoveryBytes(native); receipt.nativeRef = discoveryRef(outcomeBytes);
    receipt.requestDigest = requestDigest(receipt); receiptBytes = discoveryBytes(receipt);
    return { receiptId: receipt.receiptId, receiptRef: discoveryRef(receiptBytes) };
  };
  reseal();
  const read = vi.fn(() => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(outcomeBytes) }));
  return { receipt, native, reseal, get reference() { return { receiptId: receipt.receiptId, receiptRef: discoveryRef(receiptBytes) }; },
    archive: { read, inspect }, read, bytes: () => [Buffer.from(receiptBytes), Buffer.from(outcomeBytes)] };
}

function bound(f: ReturnType<typeof setup>) {
  const execution = boundKnowledgeExecution(f.context.window, f.context.catalog, f.model);
  f.response.binding = JSON.parse(execution.request.input).binding;
  const native = { archiveKind: 'knowledge-bound-knowledge-native', schemaVersion: 1, receiptId: randomUUID(), attemptId: randomUUID(),
    outcome: { outcomeKind: 'result', result: f.nativeResult(JSON.stringify(f.response)) } };
  const receipt: BoundKnowledgeReceipt = { receiptKind: 'knowledge-bound-knowledge-receipt', schemaVersion: 2,
    receiptId: native.receiptId, attemptId: native.attemptId, binding: JSON.parse(execution.request.input).binding,
    request: execution.request, producer: f.old.inspect(f.model.executor, execution.input), requestDigest: '',
    nativeRef: discoveryRef(discoveryBytes(native)), startedAt: at(8), finishedAt: at(9) };
  const task = archive(receipt, native, boundKnowledgeRequestDigest, f.old.inspect);
  return { ...task, get reference() { return task.reference; }, app: new KnowledgeApplication({ ...f.ports, boundKnowledgeArchive: task.archive }) };
}

function reviewed(f: ReturnType<typeof setup>, status: 'supported' | 'unsupported' | 'undetermined' = 'supported') {
  const execution = entityReviewExecution(f.context.window, f.context.catalog, f.model);
  const response = { responseKind: 'entity-review', schemaVersion: 1, binding: JSON.parse(execution.request.input).binding,
    decisions: f.context.catalog.entities.map((entity, index) => ({ entityId: entity.entityId,
      qualification: { status: index === 1 ? status : 'supported', reason: 'Authored assessment only.' },
      referent: { status: 'supported', reason: 'Authored assessment only.' }, type: { status: 'supported', reason: 'Authored assessment only.' },
      mentionIds: f.context.catalog.mentions.filter(mention => mention.entityId === entity.entityId).map(mention => mention.mentionId), evidenceRefs: ['record-1'] })) };
  const native = { archiveKind: 'knowledge-entity-review-native', schemaVersion: 1, receiptId: randomUUID(), attemptId: randomUUID(),
    outcome: { outcomeKind: 'result', result: f.nativeResult(JSON.stringify(response)) } };
  const receipt: EntityReviewReceipt = { receiptKind: 'knowledge-entity-review-receipt', schemaVersion: 1,
    receiptId: native.receiptId, attemptId: native.attemptId, binding: response.binding, request: execution.request,
    producer: f.old.inspect(f.model.executor, execution.input), requestDigest: '', nativeRef: discoveryRef(discoveryBytes(native)),
    startedAt: at(8), finishedAt: at(10) };
  const task = archive(receipt, native, entityReviewRequestDigest, f.old.inspect);
  const app = new KnowledgeApplication({ ...f.ports, entityReviewArchive: task.archive });
  return { ...task, get reference() { return task.reference; }, response, app,
    get selection() { return { model: f.model, reference: task.reference }; } };
}

function reviewedK(f: ReturnType<typeof setup>, review: ReturnType<typeof reviewed>, two = false) {
  const context = review.app.refinedReviewedKnowledgeContext(f.selection, f.model, f.references(), review.selection);
  const execution = reviewedKnowledgeExecution(context.window, context.catalog, context.entityReview, f.model);
  const response = { ...structuredClone(f.response), responseKind: 'reviewed-knowledge', schemaVersion: 1,
    binding: JSON.parse(execution.request.input).binding };
  if (two) {
    const sibling = structuredClone(response.proposals[0]); sibling.proposalId = 'alpha-only';
    sibling.entityIds = [context.catalog.entities[0].entityId]; sibling.mentionIds = [context.catalog.mentions[0].mentionId];
    sibling.draft.content.statements[0].object = null; response.proposals.push(sibling);
  }
  const native = { archiveKind: 'knowledge-reviewed-knowledge-native', schemaVersion: 1, receiptId: randomUUID(), attemptId: randomUUID(),
    outcome: { outcomeKind: 'result', result: f.nativeResult(JSON.stringify(response)) } };
  const receipt: ReviewedKnowledgeReceipt = { receiptKind: 'knowledge-reviewed-knowledge-receipt', schemaVersion: 1,
    receiptId: native.receiptId, attemptId: native.attemptId, binding: response.binding, request: execution.request,
    producer: f.old.inspect(f.model.executor, execution.input), requestDigest: '', nativeRef: discoveryRef(discoveryBytes(native)),
    startedAt: at(11), finishedAt: at(12) };
  const task = archive(receipt, native, reviewedKnowledgeRequestDigest, f.old.inspect);
  return { ...task, get reference() { return task.reference; }, response, app: new KnowledgeApplication({ ...f.ports, entityReviewArchive: review.archive,
    reviewedKnowledgeArchive: task.archive }) };
}

describe('explicit five-original catalog to knowledge handoff (authored returns)', () => {
  it.each(['codex', 'openai-api'] as const)('publishes and replays K from the authentic %s initial catalog without an extraction run', executor => {
    const f = setup(executor), k = bound(f), initial = f.ports.entities.read(f.imported.analysisId);
    const before = [f.bytesRefinement(), f.bytesRebinding(), k.bytes()];
    const result = k.app.importRefinedBoundKnowledge(f.selection, f.model, f.references(), k.reference);
    expect(result).toMatchObject({ admissionStatus: 'admitted', semanticStatus: 'not_reviewed', entityChainDigest: f.imported.chainDigest,
      entityAnalysisRef: { analysisId: f.imported.analysisId, revisionId: f.imported.revisionId } });
    expect(result).not.toHaveProperty('entityRunId'); expect(result).not.toHaveProperty('goldReady');
    expect(result.committed).toHaveLength(1);
    expect(k.app.importRefinedBoundKnowledge(f.selection, f.model, f.references(), k.reference).committed).toEqual(result.committed);
    const saved = k.app.detail(result.committed[0].knowledgeId);
    expect(saved.history.generation).toBe(1); expect(saved.grounding.entityAnalysisRef).toEqual(result.entityAnalysisRef);
    expect(saved.revision.content.statements[0].subject.entityId).toBe(f.context.catalog.entities[0].entityId);
    expect(f.ports.entities.read(f.imported.analysisId)).toEqual(initial); expect(f.ports.runs.listManifests()).toEqual([]);
    expect([f.bytesRefinement(), f.bytesRebinding(), k.bytes()]).toEqual(before);
    expect(f.ports.id).not.toHaveBeenCalled(); expect(f.ports.now).not.toHaveBeenCalled();
    const input = JSON.parse(k.receipt.request.input);
    expect(input.entityAnalysis).toEqual(f.context.catalog); expect(input.excerpts).toEqual(f.source.excerpts);
    expect(k.receipt.request.input).not.toContain('/authored/private'); expect(input).not.toHaveProperty('base');
  });

  it.each(['supported', 'unsupported', 'undetermined'] as const)('preserves R and applies its %s ID usage policy before actual K writes', status => {
    const f = setup(), review = reviewed(f, status), k = reviewedK(f, review, true), originals = [review.bytes(), k.bytes()];
    const result = k.app.importRefinedReviewedKnowledge(f.selection, f.model, f.references(), review.selection, k.reference);
    expect(result.committed).toHaveLength(status === 'supported' ? 2 : 1);
    expect(result.semanticStatus).toBe('not_reviewed'); expect(result).not.toHaveProperty('formalReceipt');
    expect(result.entityReviewEvidence.rawOutput).toBe(review.native.outcome.result.output);
    expect(result.entityChainDigest).toBe(f.imported.chainDigest);
    expect(result.proposalAdmissionStatus).toBe(status === 'supported' ? 'admitted' : 'partial');
    expect([review.bytes(), k.bytes()]).toEqual(originals); expect(f.ports.runs.listManifests()).toEqual([]);
  });

  it.each(['directK', 'review', 'reviewedK'] as const)('rejects %s before its predecessor finished, with no knowledge writes', stage => {
    const f = setup(), review = reviewed(f), k = reviewedK(f, review), direct = bound(f);
    if (stage === 'directK') { direct.receipt.startedAt = at(6); direct.reseal(); }
    if (stage === 'review') { review.receipt.startedAt = at(6); review.reseal(); }
    if (stage === 'reviewedK') { k.receipt.startedAt = at(9); k.reseal(); }
    expect(() => stage === 'directK' ? direct.app.importRefinedBoundKnowledge(f.selection, f.model, f.references(), direct.reference)
      : k.app.importRefinedReviewedKnowledge(f.selection, f.model, f.references(), review.selection, k.reference)).toThrow('predates');
    expect(f.ports.knowledge.list()).toEqual([]);
  });

  it.each(['directK-receipt', 'review-attempt', 'K-previous-attempt', 'K-review-receipt', 'K-own-attempt'] as const)(
    'rejects identity reuse %s across receipt and attempt roles', mode => {
      const f = setup(), review = reviewed(f), k = reviewedK(f, review), direct = bound(f);
      if (mode === 'directK-receipt') direct.receipt.receiptId = direct.native.receiptId = f.old.plan.sourcePlanReceipt.attemptId;
      if (mode === 'review-attempt') review.receipt.attemptId = review.native.attemptId = f.old.discoveryReceipt.receiptId;
      if (mode === 'K-previous-attempt') k.receipt.receiptId = k.native.receiptId = f.rebindingReceipt.attemptId;
      if (mode === 'K-review-receipt') k.receipt.attemptId = k.native.attemptId = review.receipt.receiptId;
      if (mode === 'K-own-attempt') k.receipt.attemptId = k.native.attemptId = k.receipt.receiptId;
      direct.reseal(); review.reseal(); k.reseal();
      expect(() => mode === 'directK-receipt' ? direct.app.importRefinedBoundKnowledge(f.selection, f.model, f.references(), direct.reference)
        : k.app.importRefinedReviewedKnowledge(f.selection, f.model, f.references(), review.selection, k.reference)).toThrow('reuses');
      expect(f.ports.knowledge.list()).toEqual([]);
    });

  it('re-authenticates the five originals before reading K and rejects evidence changed after context construction', () => {
    const f = setup(), k = bound(f);
    f.rebindingReceipt.finishedAt = at(8); f.resealRebinding(); k.read.mockClear();
    expect(() => k.app.importRefinedBoundKnowledge(f.selection, f.model, f.references(), k.reference)).toThrow();
    expect(k.read).not.toHaveBeenCalled(); expect(f.ports.knowledge.list()).toEqual([]);
  });

  it.each(['R', 'K'] as const)('preserves a failed %s native return and refuses knowledge publication', stage => {
    const f = setup(), review = reviewed(f), k = reviewedK(f, review), failed = stage === 'R' ? review : k;
    Object.assign(failed.native.outcome.result, { ok: false, stopReason: 'error' }); failed.reseal();
    const original = failed.bytes();
    expect(() => k.app.importRefinedReviewedKnowledge(f.selection, f.model, f.references(), review.selection, k.reference))
      .toThrow('complete successful native');
    expect(failed.bytes()).toEqual(original); expect(f.ports.knowledge.list()).toEqual([]);
    expect(f.ports.entities.read(f.imported.analysisId).generation).toBe(1);
  });

  it('returns rejected K evidence without publishing a subset or reclassifying structural checks as semantic acceptance', () => {
    const f = setup(), k = bound(f); k.native.outcome.result.output = '{"unrecognized":true}'; k.reseal();
    const original = k.bytes(), result = k.app.importRefinedBoundKnowledge(f.selection, f.model, f.references(), k.reference);
    expect(result).toMatchObject({ admissionStatus: 'rejected', semanticStatus: 'not_reviewed', committed: [],
      evidence: { rawOutput: '{"unrecognized":true}' } });
    expect(k.bytes()).toEqual(original); expect(f.ports.knowledge.list()).toEqual([]);
  });

  it('resumes existing per-proposal publication after cancellation without duplicating already durable knowledge', () => {
    const f = setup(), review = reviewed(f), k = reviewedK(f, review, true), controller = new AbortController();
    const originalWrite = f.ports.knowledge.write.bind(f.ports.knowledge);
    const write = vi.spyOn(f.ports.knowledge, 'write').mockImplementationOnce((command, actor) => {
      const receipt = originalWrite(command, actor); controller.abort(new Error('Authored interruption after first commit.')); return receipt;
    });
    expect(() => k.app.importRefinedReviewedKnowledge(f.selection, f.model, f.references(), review.selection, k.reference, controller.signal))
      .toThrow('after first commit');
    expect(f.ports.knowledge.list()).toHaveLength(1); write.mockRestore();
    const restarted = new KnowledgeApplication({ ...f.ports, entityReviewArchive: review.archive, reviewedKnowledgeArchive: k.archive });
    const result = restarted.importRefinedReviewedKnowledge(f.selection, f.model, f.references(), review.selection, k.reference);
    expect(result.committed).toHaveLength(2); expect(f.ports.knowledge.list().map(history => history.generation)).toEqual([1, 1]);
    expect(f.ports.entities.read(f.imported.analysisId).generation).toBe(1);
  });

  it('honors cancellation before archive access', () => {
    const f = setup(), k = bound(f), controller = new AbortController(); controller.abort(new Error('Authored cancellation.'));
    f.refinedRead.mockClear(); k.read.mockClear();
    expect(() => k.app.importRefinedBoundKnowledge(f.selection, f.model, f.references(), k.reference, controller.signal)).toThrow('cancellation');
    expect(f.refinedRead).not.toHaveBeenCalled(); expect(k.read).not.toHaveBeenCalled(); expect(f.ports.knowledge.list()).toEqual([]);
  });
});
