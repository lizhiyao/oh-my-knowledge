import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorInput } from '../../src/executors/contracts/ports.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { admitEntities } from '../../src/knowledge/extraction/entities.js';
import type { BoundKnowledgeCatalog, BoundKnowledgeSource } from '../../src/knowledge/extraction/bound-catalog.js';
import { EXTRACTION_OUTCOME_MAX_BYTES } from '../../src/knowledge/extraction/generation.js';
import { ExtractionOutcomeSchema } from '../../src/knowledge/extraction/runs.js';
import { ENTITY_REVIEW_RECEIPT_MAX_BYTES, EntityReviewReceiptSchema,
  entityReviewExecution, entityReviewRequestDigest, readEntityReviewEvidence,
  type EntityReviewArchivePort, type EntityReviewReceipt } from '../../src/knowledge/extraction/entity-review-evidence.js';
import { ENTITY_REVIEW_SYSTEM, ENTITY_REVIEW_WIRE_ID, ENTITY_REVIEW_WIRE_SCHEMA,
  ENTITY_REVIEW_OUTPUT_NAME, buildEntityReviewInput } from '../../src/knowledge/extraction/entity-review.js';
import { ENTITY_CODE_REFERENT_POLICY, ENTITY_COLLECTIVE_REFERENCE_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';
import { modelWindow } from './fixtures.js';
import { studyNativeResult } from './extraction-study-fixtures.js';
import { withImmediatePriorCollectivePolicy } from './collective-reference-policy-fixtures.js';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const bytes = (value: unknown) => Buffer.from(canonicalJson(value));
const ref = (value: Uint8Array) => ({ bytes: value.byteLength, digest: hash(value) });
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** Authored evidence tests task authentication, not a model, persisted catalog or semantic correctness. */
function setup(executor: 'codex' | 'openai-api' = 'codex') {
  const ids: Record<string, string> = { project: uid(1), tool: uid(2), m1: uid(3), m2: uid(4) };
  const packet = JSON.parse(JSON.stringify(modelWindow(), (_key, value) => typeof value === 'string' ? ids[value] ?? value : value)) as ReturnType<typeof modelWindow>;
  const source: BoundKnowledgeSource = { snapshotId: uid(5), sourceVersion: hash('authored source bytes'),
    excerpts: [{ evidenceRef: 'record-1', recordIndex: 1, eventKind: 'message', role: 'assistant', text: 'Alpha 使用 Beta' }],
    limitations: ['An authored source assertion, not independently verified.'] };
  const analysis = admitEntities(packet.entities, packet.mentions, source.excerpts);
  const catalog: BoundKnowledgeCatalog = { analysisId: uid(6), revisionId: uid(7), snapshotId: source.snapshotId,
    sourceVersion: source.sourceVersion, entities: analysis.entities, mentions: analysis.mentions, limitations: [] };
  const model = { executor, model: 'authored-model', timeoutMs: 2000, maxOutputTokens: 1024 };
  const execution = entityReviewExecution(source, catalog, model);
  const response = { responseKind: 'entity-review', schemaVersion: 1, binding: JSON.parse(execution.request.input).binding,
    decisions: catalog.entities.map(entity => ({ entityId: entity.entityId,
      qualification: { status: 'supported', reason: 'Authored independent-discussion assessment.' },
      referent: { status: 'supported', reason: 'Authored local-referent assessment.' },
      type: { status: 'supported', reason: 'Authored type assessment, not semantic proof.' },
      mentionIds: catalog.mentions.filter(mention => mention.entityId === entity.entityId).map(mention => mention.mentionId),
      evidenceRefs: ['record-1'] })) };
  const receiptId = uid(8), attemptId = uid(9);
  const native = { archiveKind: 'knowledge-entity-review-native', schemaVersion: 1, receiptId, attemptId,
    outcome: ExtractionOutcomeSchema.parse({ outcomeKind: 'result', result: studyNativeResult(` \n${JSON.stringify(response)}\r\n`, {
      stopReason: executor === 'codex' ? 'end_turn' : 'stop', numSubAgents: 0, fullNumTurns: 1,
    }) }) };
  // Deliberately bind original schema serialization, so a sorted/reconstructed wire cannot pass inspection.
  const producer = (name: string, input: ExecutorInput) => ({ producerId: 'authored-entity-review/v1', producerRevision: hash('authored producer'),
    sourceChannels: [{ channel: 'authored-native-result', maxBytes: 1024 * 1024 }], maxOutcomeJsonBytes: 2 * 1024 * 1024,
    proof: { requestDigest: hash(JSON.stringify({ executor: name, input })), scope: 'authored-test-only' } });
  const receipt: EntityReviewReceipt = { receiptKind: 'knowledge-entity-review-receipt', schemaVersion: 1,
    receiptId, attemptId, binding: response.binding, request: execution.request,
    producer: producer(executor, execution.input), requestDigest: '', nativeRef: ref(bytes(native)),
    startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:01Z' };
  let nativeBytes: Buffer = bytes(native), receiptBytes: Buffer;
  const sealReceipt = () => { receipt.nativeRef = ref(nativeBytes); receipt.requestDigest = entityReviewRequestDigest(receipt);
    receiptBytes = bytes(receipt); return { receiptId, receiptRef: ref(receiptBytes) }; };
  const reseal = () => { nativeBytes = bytes(native); return sealReceipt(); };
  const reference = reseal(), inspect = vi.fn(producer);
  const read = vi.fn(() => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(nativeBytes) }));
  const archive: EntityReviewArchivePort = { read, inspect };
  const result = () => { if (native.outcome.outcomeKind !== 'result') throw new Error('Not a native result'); return native.outcome.result; };
  return { source, catalog, model, execution, response, native, receipt, reference, archive, inspect, read, result, reseal,
    receiptBytes: () => receiptBytes, nativeBytes: () => nativeBytes,
    setNativeBytes: (value: Buffer) => { nativeBytes = value; return sealReceipt(); } };
}

describe('entity review native archive evidence', () => {
  it.each(['codex', 'openai-api'] as const)('rereads the complete %s review and binds the original strict schema without changing E/M or raw bytes', executor => {
    const f = setup(executor), before = { source: structuredClone(f.source), catalog: structuredClone(f.catalog),
      native: f.nativeBytes(), receipt: f.receiptBytes() };
    const readback = readEntityReviewEvidence(f.source, f.catalog, f.model, f.reference, f.archive);
    expect(readback).toMatchObject({ receipt: f.receipt, receiptRef: f.reference.receiptRef,
      rawOutput: f.result().output, rawOutputDigest: hash(f.result().output!), semanticStatus: 'not_reviewed',
      checked: { status: 'checked', semanticStatus: 'not_reviewed' } });
    expect(f.read).toHaveBeenCalledExactlyOnceWith(f.reference.receiptId, f.reference.receiptRef);
    const input = f.inspect.mock.calls[0][1];
    expect(input).toEqual(f.execution.input); expect(input.system).toBe(ENTITY_REVIEW_SYSTEM);
    expect(f.receipt.request).toMatchObject({ systemVersion: 'knowledge-entity-review-system/v4' });
    expect(f.receipt.request.system.split(ENTITY_CODE_REFERENT_POLICY)).toHaveLength(2);
    expect(f.receipt.request.system.split(ENTITY_COLLECTIVE_REFERENCE_POLICY)).toHaveLength(2);
    expect(input.outputFormat).toMatchObject({ mode: 'json-schema', name: ENTITY_REVIEW_OUTPUT_NAME });
    expect(input.outputFormat?.mode === 'json-schema' && input.outputFormat.schema).toBe(ENTITY_REVIEW_WIRE_SCHEMA);
    expect(f.receipt.request.wireId).toBe(ENTITY_REVIEW_WIRE_ID);
    expect(f.receipt.request.input).toBe(buildEntityReviewInput(f.source, f.catalog));
    expect(readback).not.toHaveProperty('formalReceipt'); expect(readback).not.toHaveProperty('goldReady');
    expect(f.source).toEqual(before.source); expect(f.catalog).toEqual(before.catalog);
    expect(f.nativeBytes()).toEqual(before.native); expect(f.receiptBytes()).toEqual(before.receipt);
  });

  it.each(['receipt-id', 'native-receipt-id', 'native-attempt-id', 'source', 'analysis', 'revision', 'catalog-digest',
    'input', 'system', 'previous-system', 'system-version', 'wire', 'model', 'executor', 'timeout', 'tokens', 'producer', 'request-digest', 'finish-time'] as const)(
    'rejects a resealed but conflicting %s rather than trusting a matching ID alone', mode => {
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
      if (mode === 'previous-system') f.receipt.request.system = withImmediatePriorCollectivePolicy(f.receipt.request.system);
      if (mode === 'system-version') Object.assign(f.receipt.request, { systemVersion: 'knowledge-entity-review-system/v3' });
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
        expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model, reference, archive)).toThrow();
      } else expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model, reference, f.archive)).toThrow();
    });

  it('binds full source/catalog content and keeps posterior times outside the dispatch digest but inside receiptRef', () => {
    const f = setup(), source = structuredClone(f.source), catalog = structuredClone(f.catalog);
    source.excerpts[0].text += '；新增限制'; catalog.entities[0].description += '；目录文字不同';
    expect(() => readEntityReviewEvidence(source, f.catalog, f.model, f.reference, f.archive)).toThrow('frozen source');
    expect(() => readEntityReviewEvidence(f.source, catalog, f.model, f.reference, f.archive)).toThrow('frozen source');
    expect(f.inspect).not.toHaveBeenCalled();
    const dispatch = entityReviewRequestDigest(f.receipt), old = f.reference.receiptRef;
    f.receipt.finishedAt = '2026-10-23T00:00:02Z'; const reference = f.reseal();
    expect(entityReviewRequestDigest(f.receipt)).toBe(dispatch); expect(reference.receiptRef).not.toEqual(old);
    expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model, f.reference, f.archive)).toThrow('byte identity');
    expect(readEntityReviewEvidence(f.source, f.catalog, f.model, reference, f.archive).checked.status).toBe('checked');
  });

  it.each(['unsuccessful', 'cancelled', 'missing-output', 'refusal', 'tools', 'malformed-tools', 'subagents', 'retry', 'turns',
    'missing-turns', 'zero-turns', 'malformed-turns', 'full-turns',
    'cleanup', 'exception', 'projection', 'unencodable-output'] as const)(
    'keeps but does not accept a %s native channel', mode => {
      const f = setup();
      if (mode === 'unsuccessful') f.result().ok = false;
      if (mode === 'cancelled') f.result().stopReason = 'cancelled';
      if (mode === 'missing-output') f.result().output = null;
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
      const reference = f.reseal(), before = f.nativeBytes();
      expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model, reference, f.archive)).toThrow();
      expect(f.nativeBytes()).toEqual(before);
    });

  it('rejects corrupt references, non-UTF8/BOM archives and oversized channels without repairing bytes', () => {
    const f = setup();
    expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model,
      { ...f.reference, receiptRef: { ...f.reference.receiptRef, digest: hash('wrong receipt bytes') } }, f.archive)).toThrow('byte identity');
    for (const receiptBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(ENTITY_REVIEW_RECEIPT_MAX_BYTES + 1)]) {
      const archive = { ...f.archive, read: () => ({ receiptBytes, outcomeBytes: f.nativeBytes() }) };
      expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model,
        { ...f.reference, receiptRef: ref(receiptBytes) }, archive)).toThrow();
    }
    expect(f.inspect).not.toHaveBeenCalled();
    for (const outcomeBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(f.receipt.producer.maxOutcomeJsonBytes + 513)]) {
      const reference = f.setNativeBytes(outcomeBytes);
      expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model, reference, f.archive)).toThrow();
    }
    const oversized = setup(); oversized.receipt.producer.maxOutcomeJsonBytes = EXTRACTION_OUTCOME_MAX_BYTES + 1;
    const reference = oversized.reseal(), archive = { ...oversized.archive, inspect: () => oversized.receipt.producer };
    expect(() => readEntityReviewEvidence(oversized.source, oversized.catalog, oversized.model, reference, archive)).toThrow('producer differs');
  });

  it.each(['invalid-json', 'binding', 'unknown-entity', 'missing-decision', 'new-quote'] as const)(
    'returns %s review quality rejection with exact raw instead of treating it as a broken archive', mode => {
      const f = setup();
      if (mode === 'binding') f.response.binding.revisionId = uid(80);
      if (mode === 'unknown-entity') f.response.decisions[0].entityId = uid(80);
      if (mode === 'missing-decision') f.response.decisions.pop();
      if (mode === 'new-quote') Object.assign(f.response.decisions[0], { selection: { evidenceRef: 'record-1', quote: 'rewritten quote' } });
      f.result().output = mode === 'invalid-json' ? '  {bad json\n' : ` \n${JSON.stringify(f.response)}\r\n`;
      if (mode === 'binding') f.receipt.binding = JSON.parse(f.execution.request.input).binding;
      const reference = f.reseal(), before = f.nativeBytes();
      const readback = readEntityReviewEvidence(f.source, f.catalog, f.model, reference, f.archive);
      expect(readback).toMatchObject({ rawOutput: f.result().output, rawOutputDigest: hash(f.result().output!),
        checked: { status: 'rejected', semanticStatus: 'not_reviewed' }, semanticStatus: 'not_reviewed' });
      expect(readback.checked.raw.text).toBe(f.result().output);
      expect(f.nativeBytes()).toEqual(before);
    });

  it.each(['alias', 'version'] as const)('rejects %s receipt framing rather than accepting a different task', mode => {
    const f = setup(), receiptBytes = bytes({ ...f.receipt,
      ...(mode === 'alias' ? { receiptKind: 'knowledge-bound-knowledge-receipt' } : { schemaVersion: 2 }) });
    expect(EntityReviewReceiptSchema.safeParse(JSON.parse(receiptBytes.toString('utf8'))).success).toBe(false);
    expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model,
      { ...f.reference, receiptRef: ref(receiptBytes) }, { ...f.archive, read: () => ({ receiptBytes, outcomeBytes: f.nativeBytes() }) })).toThrow();
  });

  it.each(['alias', 'version'] as const)('rejects %s native framing even inside a valid same-task receipt', mode => {
    const f = setup(), nativeBytes = bytes({ ...f.native,
      ...(mode === 'alias' ? { archiveKind: 'knowledge-bound-knowledge-native' } : { schemaVersion: 2 }) });
    const reference = f.setNativeBytes(nativeBytes);
    expect(() => readEntityReviewEvidence(f.source, f.catalog, f.model, reference, f.archive)).toThrow();
    expect(f.nativeBytes()).toEqual(nativeBytes);
  });
});
