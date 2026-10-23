import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorInput } from '../../src/executors/contracts/ports.js';
import { admitEntities } from '../../src/knowledge/extraction/entities.js';
import { EXTRACTION_OUTCOME_MAX_BYTES } from '../../src/knowledge/extraction/generation.js';
import { ExtractionOutcomeSchema } from '../../src/knowledge/extraction/runs.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import type { BoundKnowledgeCatalog, BoundKnowledgeSource } from '../../src/knowledge/extraction/bound-catalog.js';
import { buildEntityReviewInput } from '../../src/knowledge/extraction/entity-review.js';
import { REVIEWED_KNOWLEDGE_RECEIPT_MAX_BYTES, ReviewedKnowledgeReceiptSchema,
  reviewedKnowledgeExecution, reviewedKnowledgeRequestDigest, readReviewedKnowledgeEvidence,
  type ReviewedKnowledgeArchivePort, type ReviewedKnowledgeReceipt } from '../../src/knowledge/extraction/reviewed-knowledge-evidence.js';
import { REVIEWED_KNOWLEDGE_SYSTEM, REVIEWED_KNOWLEDGE_WIRE_ID, REVIEWED_KNOWLEDGE_WIRE_SCHEMA,
  REVIEWED_KNOWLEDGE_OUTPUT_NAME, buildReviewedKnowledgeInput,
  type EntityReviewProjection } from '../../src/knowledge/extraction/reviewed-knowledge.js';
import { modelWindow, wireModelWindow } from './fixtures.js';
import { studyNativeResult } from './extraction-study-fixtures.js';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const bytes = (value: unknown) => Buffer.from(canonicalJson(value));
const ref = (value: Uint8Array) => ({ bytes: value.byteLength, digest: hash(value) });
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** Authored E/R and archive ports exercise binding only; they are neither provider nor human evidence. */
function setup(executor: 'codex' | 'openai-api' = 'codex', betaSupported = true) {
  const ids: Record<string, string> = { project: uid(1), tool: uid(2), m1: uid(3), m2: uid(4) };
  const packet = JSON.parse(JSON.stringify(modelWindow(), (_key, value) => typeof value === 'string' ? ids[value] ?? value : value)) as ReturnType<typeof modelWindow>;
  const source: BoundKnowledgeSource = { snapshotId: uid(5), sourceVersion: hash('authored source bytes'),
    excerpts: [{ evidenceRef: 'record-1', recordIndex: 1, eventKind: 'message', role: 'assistant', text: 'Alpha 使用 Beta' }],
    limitations: ['Only an authored source assertion.'] };
  const analysis = admitEntities(packet.entities, packet.mentions, source.excerpts);
  const catalog: BoundKnowledgeCatalog = { analysisId: uid(6), revisionId: uid(7), snapshotId: source.snapshotId,
    sourceVersion: source.sourceVersion, entities: analysis.entities, mentions: analysis.mentions, limitations: [] };
  const assessment = { status: 'supported', reason: 'Authored source support, not independent semantic verification.' };
  const reviewResponse = { responseKind: 'entity-review', schemaVersion: 1,
    binding: JSON.parse(buildEntityReviewInput(source, catalog)).binding,
    decisions: catalog.entities.map(entity => ({ entityId: entity.entityId,
      qualification: entity.entityId === uid(2) && !betaSupported ? { ...assessment, status: 'unsupported' } : assessment,
      referent: assessment, type: assessment,
      mentionIds: catalog.mentions.filter(mention => mention.entityId === entity.entityId).map(mention => mention.mentionId),
      evidenceRefs: ['record-1'] })) };
  const review: EntityReviewProjection = { receiptId: uid(10), receiptRef: ref(bytes({ scope: 'authored R receipt bytes only' })),
    nativeRef: ref(bytes({ scope: 'authored R native bytes only' })), rawOutput: ` \n${JSON.stringify(reviewResponse)}\r\n` };
  const model = { executor, model: 'authored-model', timeoutMs: 2000, maxOutputTokens: 1024 };
  const execution = reviewedKnowledgeExecution(source, catalog, review, model);
  const response = { responseKind: 'reviewed-knowledge', schemaVersion: 1, binding: JSON.parse(execution.request.input).binding,
    proposals: wireModelWindow(packet).proposals, catalogGaps: [],
    materialAccounting: [{ materialId: 'material-1', meaning: 'Authored use claim, not independent verification.',
      anchors: [{ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta', occurrence: null }],
      dispositionKind: 'expressed', statementRefs: [{ proposalId: packet.proposals[0].proposalId, statementId: 'usage' }],
      reason: null, catalogGapIds: [] }],
    excerptAccounting: [{ evidenceRef: 'record-1', materialIds: ['material-1'], noMaterialReason: null }] };
  const receiptId = uid(8), attemptId = uid(9);
  const native = { archiveKind: 'knowledge-reviewed-knowledge-native', schemaVersion: 1, receiptId, attemptId,
    outcome: ExtractionOutcomeSchema.parse({ outcomeKind: 'result', result: studyNativeResult(` \n${JSON.stringify(response)}\r\n`, {
      stopReason: executor === 'codex' ? 'end_turn' : 'stop', numSubAgents: 0, fullNumTurns: 1,
    }) }) };
  // Schema property order is part of this authored producer witness, independently of canonical receipt JSON.
  const producer = (name: string, input: ExecutorInput) => ({ producerId: 'authored-reviewed-knowledge/v1', producerRevision: hash('authored producer'),
    sourceChannels: [{ channel: 'authored-native-result', maxBytes: 1024 * 1024 }], maxOutcomeJsonBytes: 2 * 1024 * 1024,
    proof: { requestDigest: hash(JSON.stringify({ executor: name, input })), scope: 'authored-test-only' } });
  const receipt: ReviewedKnowledgeReceipt = { receiptKind: 'knowledge-reviewed-knowledge-receipt', schemaVersion: 1,
    receiptId, attemptId, binding: response.binding, request: execution.request,
    producer: producer(executor, execution.input), requestDigest: '', nativeRef: ref(bytes(native)),
    startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:01Z' };
  let nativeBytes: Buffer = bytes(native), receiptBytes: Buffer;
  const sealReceipt = () => { receipt.nativeRef = ref(nativeBytes); receipt.requestDigest = reviewedKnowledgeRequestDigest(receipt);
    receiptBytes = bytes(receipt); return { receiptId, receiptRef: ref(receiptBytes) }; };
  const reseal = () => { nativeBytes = bytes(native); return sealReceipt(); };
  const reference = reseal(), inspect = vi.fn(producer), read = vi.fn(() => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(nativeBytes) }));
  const archive: ReviewedKnowledgeArchivePort = { read, inspect };
  const result = () => { if (native.outcome.outcomeKind !== 'result') throw new Error('Not a native result'); return native.outcome.result; };
  const readEvidence = () => readReviewedKnowledgeEvidence(source, catalog, review, model, reference, archive);
  return { source, catalog, review, model, execution, response, native, receipt, reference, archive, inspect, read, result, reseal, readEvidence,
    receiptBytes: () => receiptBytes, nativeBytes: () => nativeBytes,
    setNativeBytes: (value: Buffer) => { nativeBytes = value; return sealReceipt(); } };
}

describe('reviewed knowledge native archive evidence', () => {
  it.each(['codex', 'openai-api'] as const)('authenticates %s with the independent reviewed-K wire and leaves all E/R/native bytes unchanged', executor => {
    const f = setup(executor), before = { native: f.nativeBytes(), receipt: f.receiptBytes(), source: structuredClone(f.source),
      catalog: structuredClone(f.catalog), review: structuredClone(f.review) };
    const readback = f.readEvidence();
    expect(readback).toMatchObject({ receipt: f.receipt, receiptRef: f.reference.receiptRef,
      rawOutput: f.result().output, rawOutputDigest: hash(f.result().output!), semanticStatus: 'not_reviewed',
      checked: { status: 'checked', semanticStatus: 'not_reviewed', rejected: [] } });
    expect(readback.checked.status === 'checked' && readback.checked.accepted).toHaveLength(1);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(f.reference.receiptId, f.reference.receiptRef);
    const input = f.inspect.mock.calls[0][1];
    expect(input).toEqual(f.execution.input); expect(input.system).toBe(REVIEWED_KNOWLEDGE_SYSTEM);
    expect(input.outputFormat).toMatchObject({ mode: 'json-schema', name: REVIEWED_KNOWLEDGE_OUTPUT_NAME });
    expect(input.outputFormat?.mode === 'json-schema' && input.outputFormat.schema).toBe(REVIEWED_KNOWLEDGE_WIRE_SCHEMA);
    expect(f.receipt.request.wireId).toBe(REVIEWED_KNOWLEDGE_WIRE_ID);
    expect(f.receipt.request.input).toBe(buildReviewedKnowledgeInput(f.source, f.catalog, f.review));
    expect(f.nativeBytes()).toEqual(before.native); expect(f.receiptBytes()).toEqual(before.receipt);
    expect(f.source).toEqual(before.source); expect(f.catalog).toEqual(before.catalog); expect(f.review).toEqual(before.review);
  });

  it.each(['receipt-id', 'native-receipt-id', 'native-attempt-id', 'source', 'analysis', 'revision', 'catalog-digest',
    'input', 'system', 'wire', 'model', 'executor', 'timeout', 'tokens', 'producer', 'request-digest', 'finish-time'] as const)(
    'rejects a resealed but conflicting %s', mode => {
      const f = setup();
      if (mode === 'receipt-id') f.receipt.receiptId = uid(80);
      if (mode === 'native-receipt-id') f.native.receiptId = uid(80);
      if (mode === 'native-attempt-id') f.native.attemptId = uid(80);
      if (mode === 'source') f.receipt.binding.sourceVersion = hash('other source');
      if (mode === 'analysis') f.receipt.binding.analysisId = uid(80);
      if (mode === 'revision') f.receipt.binding.revisionId = uid(80);
      if (mode === 'catalog-digest') f.receipt.binding.entityAnalysisDigest = hash('different catalog');
      if (mode === 'input') f.receipt.request.input += ' ';
      if (mode === 'system') f.receipt.request.system += ' ';
      if (mode === 'wire') f.receipt.request.wireId = hash('different wire');
      if (mode === 'model') f.receipt.request.model = 'other-model';
      if (mode === 'executor') f.receipt.request.executor = 'openai-api';
      if (mode === 'timeout') f.receipt.request.timeoutMs++;
      if (mode === 'tokens') f.receipt.request.maxOutputTokens = 2048;
      if (mode === 'producer') f.receipt.producer.producerRevision = hash('other producer');
      if (mode === 'finish-time') f.receipt.finishedAt = '2025-10-23T00:00:00Z';
      let reference = f.reseal();
      if (mode === 'request-digest') {
        f.receipt.requestDigest = hash('incorrect request identity');
        const receiptBytes = bytes(f.receipt); reference = { ...reference, receiptRef: ref(receiptBytes) };
        const archive = { ...f.archive, read: () => ({ receiptBytes, outcomeBytes: f.nativeBytes() }) };
        expect(() => readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model, reference, archive)).toThrow();
      } else expect(() => readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model, reference, f.archive)).toThrow();
    });

  it.each(['source', 'catalog', 'review-id', 'review-receipt', 'review-native', 'review-raw'] as const)(
    'cannot reuse a K receipt after the complete %s changes', mode => {
      const f = setup();
      if (mode === 'source') f.source.excerpts[0].text += '；新增来源限制';
      if (mode === 'catalog') f.catalog.entities[0].description += '；目录描述不同';
      if (mode === 'review-id') f.review.receiptId = uid(80);
      if (mode === 'review-receipt') f.review.receiptRef = ref(bytes({ scope: 'different authored review receipt' }));
      if (mode === 'review-native') f.review.nativeRef = ref(bytes({ scope: 'different authored review native' }));
      if (mode === 'review-raw') f.review.rawOutput += ' ';
      expect(f.readEvidence).toThrow(); expect(f.inspect).not.toHaveBeenCalled();
    });

  it('binds posterior timestamp changes through receiptRef without pretending they were dispatch facts', () => {
    const f = setup(), dispatch = reviewedKnowledgeRequestDigest(f.receipt), old = f.reference.receiptRef;
    f.receipt.finishedAt = '2026-10-23T00:00:02Z'; const reference = f.reseal();
    expect(reviewedKnowledgeRequestDigest(f.receipt)).toBe(dispatch); expect(reference.receiptRef).not.toEqual(old);
    expect(f.readEvidence).toThrow('byte identity');
    expect(readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model, reference, f.archive).checked.status).toBe('checked');
  });

  it.each(['unsuccessful', 'cancelled', 'refusal', 'tools', 'malformed-tools', 'subagents', 'retry', 'turns', 'missing-turns', 'zero-turns', 'malformed-turns', 'full-turns',
    'cleanup', 'exception', 'projection', 'unencodable-output'] as const)(
    'preserves but does not accept a %s native channel', mode => {
      const f = setup();
      if (mode === 'unsuccessful') f.result().ok = false;
      if (mode === 'cancelled') f.result().stopReason = 'cancelled';
      if (mode === 'refusal') f.result().refusal = 'authored refusal';
      if (mode === 'tools') f.result().toolCalls = [{ tool: 'authored-tool' }];
      if (mode === 'malformed-tools') f.result().toolCalls = 'unknown-shape';
      if (mode === 'subagents') f.result().numSubAgents = 1;
      if (mode === 'retry') f.result().attemptCount = 2;
      if (mode === 'turns') f.result().numTurns = 2;
      if (mode === 'missing-turns') delete f.result().numTurns;
      if (mode === 'zero-turns') f.result().numTurns = 0;
      if (mode === 'malformed-turns') f.result().numTurns = '1';
      if (mode === 'full-turns') f.result().fullNumTurns = 2;
      if (mode === 'cleanup') f.native.outcome = { outcomeKind: 'result', result: f.result(), cleanupFailure: { diagnostic: 'authored cleanup failure' } };
      if (mode === 'exception') f.native.outcome = { outcomeKind: 'exception', error: { representationKind: 'exception-diagnostic/v1',
        sourceType: 'string', name: null, message: 'authored exception', truncated: false, accessorsSkipped: false } };
      if (mode === 'projection') f.native.outcome = { outcomeKind: 'model-port-projection', scope: 'authored-model-port/v1', result: { output: '{}', durationMs: 1 } };
      if (mode === 'unencodable-output') f.result().output = String.fromCharCode(0xd800);
      const reference = f.reseal(), original = f.nativeBytes();
      expect(() => readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model, reference, f.archive)).toThrow();
      expect(f.nativeBytes()).toEqual(original);
    });

  it('rejects corrupt references, strict UTF-8 and archive capacity conflicts', () => {
    const f = setup();
    expect(() => readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model,
      { ...f.reference, receiptRef: { ...f.reference.receiptRef, digest: hash('wrong receipt bytes') } }, f.archive)).toThrow('byte identity');
    for (const receiptBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(REVIEWED_KNOWLEDGE_RECEIPT_MAX_BYTES + 1)]) {
      const archive = { ...f.archive, read: () => ({ receiptBytes, outcomeBytes: f.nativeBytes() }) };
      expect(() => readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model,
        { ...f.reference, receiptRef: ref(receiptBytes) }, archive)).toThrow();
    }
    expect(f.inspect).not.toHaveBeenCalled();
    for (const outcomeBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(f.receipt.producer.maxOutcomeJsonBytes + 513)]) {
      const reference = f.setNativeBytes(outcomeBytes);
      expect(() => readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model, reference, f.archive)).toThrow();
    }
    const oversized = setup(); oversized.receipt.producer.maxOutcomeJsonBytes = EXTRACTION_OUTCOME_MAX_BYTES + 1;
    const reference = oversized.reseal();
    expect(() => readReviewedKnowledgeEvidence(oversized.source, oversized.catalog, oversized.review, oversized.model,
      reference, { ...oversized.archive, inspect: () => oversized.receipt.producer })).toThrow('producer differs');
  });

  it.each(['invalid_json', 'binding', 'unknown_entity', 'bad_quote', 'excluded_entity'] as const)(
    'returns %s quality rejection separately from native authentication and retains the exact raw', mode => {
      const f = setup('codex', mode !== 'excluded_entity');
      if (mode === 'binding') f.response.binding.revisionId = uid(80);
      if (mode === 'unknown_entity') f.response.proposals[0].entityIds[0] = uid(80);
      if (mode === 'bad_quote') f.response.proposals[0].citations[0].selection.quote = 'not in the source';
      f.result().output = mode === 'invalid_json' ? '  {bad json\n' : ` \n${JSON.stringify(f.response)}\r\n`;
      // The authenticated request stays intact; these are untrusted model response defects.
      if (mode === 'binding') f.receipt.binding = JSON.parse(f.execution.request.input).binding;
      const reference = f.reseal(), original = f.nativeBytes();
      const readback = readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model, reference, f.archive);
      expect(readback.rawOutput).toBe(f.result().output); expect(readback.rawOutputDigest).toBe(hash(f.result().output!));
      expect(readback.checked.raw.text).toBe(f.result().output); expect(readback.semanticStatus).toBe('not_reviewed');
      if (mode === 'invalid_json' || mode === 'binding') expect(readback.checked.status).toBe('rejected');
      else {
        expect(readback.checked.status).toBe('checked');
        if (readback.checked.status !== 'checked') throw new Error('Unexpected envelope rejection');
        expect(readback.checked.accepted).toEqual([]); expect(readback.checked.rejected).toHaveLength(1);
        if (mode === 'unknown_entity' || mode === 'bad_quote') expect(readback.checked.rejected[0].reasons)
          .toContain(mode === 'unknown_entity' ? 'unknown_entity_analysis_reference' : 'citation:quote_mismatch');
      }
      expect(f.nativeBytes()).toEqual(original);
    });

  it.each(['old-receipt', 'wrong-version', 'old-native'] as const)('rejects %s evidence instead of aliasing the control task', mode => {
    const f = setup();
    if (mode === 'old-native') {
      const outcomeBytes = bytes({ ...f.native, archiveKind: 'knowledge-bound-knowledge-native' });
      const reference = f.setNativeBytes(outcomeBytes);
      expect(() => readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model, reference, f.archive)).toThrow();
      return;
    }
    const receiptBytes = bytes({ ...f.receipt,
      ...(mode === 'old-receipt' ? { receiptKind: 'knowledge-bound-knowledge-receipt' } : { schemaVersion: 2 }) });
    expect(ReviewedKnowledgeReceiptSchema.safeParse(JSON.parse(receiptBytes.toString('utf8'))).success).toBe(false);
    expect(() => readReviewedKnowledgeEvidence(f.source, f.catalog, f.review, f.model,
      { ...f.reference, receiptRef: ref(receiptBytes) }, { ...f.archive, read: () => ({ receiptBytes, outcomeBytes: f.nativeBytes() }) })).toThrow();
  });
});
