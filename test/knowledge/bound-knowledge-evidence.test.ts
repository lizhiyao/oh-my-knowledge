import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutorInput } from '../../src/executors/contracts/ports.js';
import { ExtractionOutcomeSchema } from '../../src/knowledge/extraction/runs.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { admitEntities } from '../../src/knowledge/extraction/entities.js';
import { BOUND_KNOWLEDGE_RECEIPT_MAX_BYTES, BoundKnowledgeReceiptSchema,
  boundKnowledgeExecution, boundKnowledgeRequestDigest, readBoundKnowledgeEvidence,
  type BoundKnowledgeArchivePort, type BoundKnowledgeReceipt } from '../../src/knowledge/extraction/bound-knowledge-evidence.js';
import { BOUND_KNOWLEDGE_SYSTEM, BOUND_KNOWLEDGE_WIRE_ID, BOUND_KNOWLEDGE_WIRE_SCHEMA,
  BOUND_KNOWLEDGE_OUTPUT_NAME, buildBoundKnowledgeInput,
  type BoundKnowledgeSource, type BoundKnowledgeCatalog } from '../../src/knowledge/extraction/bound-knowledge.js';
import { EXTRACTION_OUTCOME_MAX_BYTES } from '../../src/knowledge/extraction/generation.js';
import { modelWindow, wireModelWindow } from './fixtures.js';
import { studyNativeResult } from './extraction-study-fixtures.js';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const bytes = (value: unknown) => Buffer.from(canonicalJson(value));
const ref = (value: Uint8Array) => ({ bytes: value.byteLength, digest: hash(value) });
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** Authored ports test archive binding, not a provider, semantic extraction or catalog persistence. */
function setup(executor: 'codex' | 'openai-api' = 'codex') {
  const ids: Record<string, string> = { project: uid(1), tool: uid(2), m1: uid(3), m2: uid(4) };
  const packet = JSON.parse(JSON.stringify(modelWindow(), (_key, value) => typeof value === 'string' ? ids[value] ?? value : value)) as ReturnType<typeof modelWindow>;
  const source: BoundKnowledgeSource = { snapshotId: uid(5), sourceVersion: hash('authored source bytes'),
    excerpts: [{ evidenceRef: 'record-1', recordIndex: 1, eventKind: 'message', role: 'assistant', text: 'Alpha 使用 Beta' }],
    limitations: ['Only an authored source assertion.'] };
  const analysis = admitEntities(packet.entities, packet.mentions, source.excerpts);
  const catalog: BoundKnowledgeCatalog = { analysisId: uid(6), revisionId: uid(7), snapshotId: source.snapshotId,
    sourceVersion: source.sourceVersion, entities: analysis.entities, mentions: analysis.mentions, limitations: [] };
  const model = { executor, model: 'authored-model', timeoutMs: 2000, maxOutputTokens: 1024 };
  const execution = boundKnowledgeExecution(source, catalog, model);
  const response = { responseKind: 'bound-knowledge', schemaVersion: 2, binding: JSON.parse(execution.request.input).binding,
    proposals: wireModelWindow(packet).proposals, catalogGaps: [],
    materialAccounting: [{ materialId: 'material-1', meaning: 'Authored use claim, not independent verification.',
      anchors: [{ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta', occurrence: null }],
      dispositionKind: 'expressed', statementRefs: [{ proposalId: packet.proposals[0].proposalId, statementId: 'usage' }],
      reason: null, catalogGapIds: [] }],
    excerptAccounting: [{ evidenceRef: 'record-1', materialIds: ['material-1'], noMaterialReason: null }] };
  const receiptId = uid(8), attemptId = uid(9);
  const native = { archiveKind: 'knowledge-bound-knowledge-native', schemaVersion: 1, receiptId, attemptId,
    outcome: ExtractionOutcomeSchema.parse({ outcomeKind: 'result', result: studyNativeResult(` \n${JSON.stringify(response)}\r\n`, {
      stopReason: executor === 'codex' ? 'end_turn' : 'stop', numSubAgents: 0,
    }) }) };
  // The raw input serialization participates in this authored proof, making schema-key reordering observable.
  const producer = (name: string, input: ExecutorInput) => ({ producerId: 'authored-bound-knowledge/v1', producerRevision: hash('authored producer'),
    sourceChannels: [{ channel: 'authored-native-result', maxBytes: 1024 * 1024 }], maxOutcomeJsonBytes: 2 * 1024 * 1024,
    proof: { requestDigest: hash(JSON.stringify({ executor: name, input })), scope: 'authored-test-only' } });
  const receipt: BoundKnowledgeReceipt = { receiptKind: 'knowledge-bound-knowledge-receipt', schemaVersion: 2,
    receiptId, attemptId, binding: response.binding, request: execution.request,
    producer: producer(executor, execution.input), requestDigest: '', nativeRef: ref(bytes(native)),
    startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:01Z' };
  let nativeBytes: Buffer = bytes(native), receiptBytes: Buffer;
  const sealReceipt = () => { receipt.nativeRef = ref(nativeBytes); receipt.requestDigest = boundKnowledgeRequestDigest(receipt);
    receiptBytes = bytes(receipt); return { receiptId, receiptRef: ref(receiptBytes) }; };
  const reseal = () => { nativeBytes = bytes(native); return sealReceipt(); };
  const reference = reseal(), inspect = vi.fn(producer), read = vi.fn(() => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(nativeBytes) }));
  const archive: BoundKnowledgeArchivePort = { read, inspect };
  const result = () => { if (native.outcome.outcomeKind !== 'result') throw new Error('Not a native result'); return native.outcome.result; };
  return { source, catalog, model, execution, response, native, receipt, reference, archive, inspect, read, result, reseal,
    receiptBytes: () => receiptBytes, nativeBytes: () => nativeBytes,
    setNativeBytes: (value: Buffer) => { nativeBytes = value; return sealReceipt(); }, producer };
}

describe('bound knowledge native archive evidence', () => {
  it.each(['codex', 'openai-api'] as const)('rereads %s task bytes and uses the current original K schema rather than an E wire or sorted copy', executor => {
    const f = setup(executor), before = { native: f.nativeBytes(), receipt: f.receiptBytes(), source: structuredClone(f.source), catalog: structuredClone(f.catalog) };
    const readback = readBoundKnowledgeEvidence(f.source, f.catalog, f.model, f.reference, f.archive);
    expect(readback).toMatchObject({ receipt: f.receipt, receiptRef: f.reference.receiptRef,
      rawOutput: f.result().output, rawOutputDigest: hash(f.result().output!), semanticStatus: 'not_reviewed',
      checked: { status: 'checked', semanticStatus: 'not_reviewed', rejected: [] } });
    expect(readback.checked.status === 'checked' && readback.checked.accepted).toHaveLength(1);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(f.reference.receiptId, f.reference.receiptRef);
    const input = f.inspect.mock.calls[0][1];
    expect(input).toEqual(f.execution.input); expect(input.system).toBe(BOUND_KNOWLEDGE_SYSTEM);
    expect(input.outputFormat).toMatchObject({ mode: 'json-schema', name: BOUND_KNOWLEDGE_OUTPUT_NAME });
    expect(input.outputFormat?.mode === 'json-schema' && input.outputFormat.schema).toBe(BOUND_KNOWLEDGE_WIRE_SCHEMA);
    expect(f.receipt.request.wireId).toBe(BOUND_KNOWLEDGE_WIRE_ID);
    expect(f.receipt.request.input).toBe(buildBoundKnowledgeInput(f.source, f.catalog));
    expect(f.nativeBytes()).toEqual(before.native); expect(f.receiptBytes()).toEqual(before.receipt);
    expect(f.source).toEqual(before.source); expect(f.catalog).toEqual(before.catalog);
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
        expect(() => readBoundKnowledgeEvidence(f.source, f.catalog, f.model, reference, archive)).toThrow();
      } else expect(() => readBoundKnowledgeEvidence(f.source, f.catalog, f.model, reference, f.archive)).toThrow();
    });

  it('binds the complete supplied catalog/source content, and posterior times via receiptRef rather than the dispatch digest', () => {
    const f = setup();
    const source = structuredClone(f.source); source.excerpts[0].text += '；新增限制';
    expect(() => readBoundKnowledgeEvidence(source, f.catalog, f.model, f.reference, f.archive)).toThrow('frozen source');
    const catalog = structuredClone(f.catalog); catalog.entities[0].description += '；原目录文字不同';
    expect(() => readBoundKnowledgeEvidence(f.source, catalog, f.model, f.reference, f.archive)).toThrow('frozen source');
    expect(f.inspect).not.toHaveBeenCalled();
    const dispatch = boundKnowledgeRequestDigest(f.receipt), old = f.reference.receiptRef;
    f.receipt.finishedAt = '2026-10-23T00:00:02Z'; const reference = f.reseal();
    expect(boundKnowledgeRequestDigest(f.receipt)).toBe(dispatch); expect(reference.receiptRef).not.toEqual(old);
    expect(() => readBoundKnowledgeEvidence(f.source, f.catalog, f.model, f.reference, f.archive)).toThrow('byte identity');
    expect(readBoundKnowledgeEvidence(f.source, f.catalog, f.model, reference, f.archive).checked.status).toBe('checked');
  });

  it.each(['unsuccessful', 'cancelled', 'refusal', 'tools', 'malformed-tools', 'subagents', 'retry', 'cleanup', 'exception', 'projection', 'unencodable-output'] as const)(
    'keeps but does not accept a %s native channel', mode => {
      const f = setup();
      if (mode === 'unsuccessful') f.result().ok = false;
      if (mode === 'cancelled') f.result().stopReason = 'cancelled';
      if (mode === 'refusal') f.result().refusal = 'authored refusal';
      if (mode === 'tools') f.result().toolCalls = [{ tool: 'authored-tool' }];
      if (mode === 'malformed-tools') f.result().toolCalls = 'unknown-shape';
      if (mode === 'subagents') f.result().numSubAgents = 1;
      if (mode === 'retry') f.result().attemptCount = 2;
      if (mode === 'cleanup') f.native.outcome = { outcomeKind: 'result', result: f.result(), cleanupFailure: { diagnostic: 'authored cleanup failure' } };
      if (mode === 'exception') f.native.outcome = { outcomeKind: 'exception', error: { representationKind: 'exception-diagnostic/v1',
        sourceType: 'string', name: null, message: 'authored exception', truncated: false, accessorsSkipped: false } };
      if (mode === 'projection') f.native.outcome = { outcomeKind: 'model-port-projection', scope: 'authored-model-port/v1', result: { output: '{}', durationMs: 1 } };
      if (mode === 'unencodable-output') f.result().output = String.fromCharCode(0xd800);
      const reference = f.reseal(), original = f.nativeBytes();
      expect(() => readBoundKnowledgeEvidence(f.source, f.catalog, f.model, reference, f.archive)).toThrow();
      expect(f.nativeBytes()).toEqual(original);
    });

  it('rejects corrupt references, invalid UTF-8 and capacity conflicts before archive use', () => {
    const f = setup();
    expect(() => readBoundKnowledgeEvidence(f.source, f.catalog, f.model,
      { ...f.reference, receiptRef: { ...f.reference.receiptRef, digest: hash('wrong receipt bytes') } }, f.archive)).toThrow('byte identity');
    for (const receiptBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(BOUND_KNOWLEDGE_RECEIPT_MAX_BYTES + 1)]) {
      const archive = { ...f.archive, read: () => ({ receiptBytes, outcomeBytes: f.nativeBytes() }) };
      expect(() => readBoundKnowledgeEvidence(f.source, f.catalog, f.model,
        { ...f.reference, receiptRef: ref(receiptBytes) }, archive)).toThrow();
    }
    expect(f.inspect).not.toHaveBeenCalled();
    for (const outcomeBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(f.receipt.producer.maxOutcomeJsonBytes + 513)]) {
      const reference = f.setNativeBytes(outcomeBytes);
      expect(() => readBoundKnowledgeEvidence(f.source, f.catalog, f.model, reference, f.archive)).toThrow();
    }
    const oversized = setup(); oversized.receipt.producer.maxOutcomeJsonBytes = EXTRACTION_OUTCOME_MAX_BYTES + 1;
    const reference = oversized.reseal();
    const archive = { ...oversized.archive, inspect: () => oversized.receipt.producer };
    expect(() => readBoundKnowledgeEvidence(oversized.source, oversized.catalog, oversized.model, reference, archive)).toThrow('producer differs');
  });

  it.each(['invalid_json', 'binding', 'unknown_entity', 'bad_quote'] as const)(
    'returns %s K quality rejection with the complete archived raw rather than a channel failure or repaired proposal', mode => {
      const f = setup();
      if (mode === 'binding') f.response.binding.revisionId = uid(80);
      if (mode === 'unknown_entity') f.response.proposals[0].entityIds[0] = uid(80);
      if (mode === 'bad_quote') f.response.proposals[0].citations[0].selection.quote = 'not in the source';
      f.result().output = mode === 'invalid_json' ? '  {bad json\n' : ` \n${JSON.stringify(f.response)}\r\n`;
      // Binding of the native request remains intact; only its untrusted response is changed.
      if (mode === 'binding') f.receipt.binding = JSON.parse(f.execution.request.input).binding;
      const reference = f.reseal(), original = f.nativeBytes();
      const readback = readBoundKnowledgeEvidence(f.source, f.catalog, f.model, reference, f.archive);
      expect(readback.rawOutput).toBe(f.result().output); expect(readback.rawOutputDigest).toBe(hash(f.result().output!));
      expect(readback.checked.raw.text).toBe(f.result().output); expect(readback.semanticStatus).toBe('not_reviewed');
      if (mode === 'invalid_json' || mode === 'binding') expect(readback.checked.status).toBe('rejected');
      else {
        expect(readback.checked.status).toBe('checked');
        if (readback.checked.status !== 'checked') throw new Error('Unexpected envelope rejection');
        expect(readback.checked.accepted).toEqual([]); expect(readback.checked.rejected).toHaveLength(1);
        expect(readback.checked.rejected[0].reasons).toContain(mode === 'unknown_entity' ? 'unknown_entity_analysis_reference' : 'citation:quote_mismatch');
      }
      expect(f.nativeBytes()).toEqual(original);
    });

  it.each(['alias', 'v1'] as const)('does not accept %s framing as the current private K task receipt', mode => {
    const f = setup(), receiptBytes = bytes({ ...f.receipt,
      ...(mode === 'alias' ? { receiptKind: 'knowledge-source-plan-receipt' } : { schemaVersion: 1 }) });
    expect(BoundKnowledgeReceiptSchema.safeParse(JSON.parse(receiptBytes.toString('utf8'))).success).toBe(false);
    expect(() => readBoundKnowledgeEvidence(f.source, f.catalog, f.model,
      { ...f.reference, receiptRef: ref(receiptBytes) }, { ...f.archive, read: () => ({ receiptBytes, outcomeBytes: f.nativeBytes() }) })).toThrow();
  });
});
