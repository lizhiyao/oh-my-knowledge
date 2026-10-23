import { describe, expect, it } from 'vitest';
import { ENTITY_DISCOVERY_OUTPUT_NAME, ENTITY_DISCOVERY_WIRE_SCHEMA } from '../../src/knowledge/extraction/entity-discovery.js';
import { MENTION_BINDING_OUTPUT_NAME, MENTION_BINDING_WIRE_SCHEMA } from '../../src/knowledge/extraction/mention-binding.js';
import { EXTRACTION_OUTCOME_MAX_BYTES } from '../../src/knowledge/extraction/generation.js';
import { DiscoveredEntitiesNativeError, EntityDiscoveryValidationError, ENTITY_DISCOVERY_RECEIPT_MAX_BYTES,
  MENTION_BINDING_RECEIPT_MAX_BYTES, readEntityDiscoveryEvidence, readMentionBindingEvidence,
  mentionBindingExecution, entityDiscoveryRequestDigest, mentionBindingRequestDigest,
  type EntityDiscoveryArchivePort } from '../../src/knowledge/extraction/discovered-entities-evidence.js';
import { discoveredEntitiesFixture, discoveryBytes, discoveryHash, discoveryRef, discoveryUid } from './discovered-entities-fixtures.js';

const stages = ['discovery', 'binding'] as const;
type Stage = typeof stages[number];
function fixtureRead(f: ReturnType<typeof discoveredEntitiesFixture>, stage: Stage, archive = f.archive,
  reference = stage === 'discovery' ? f.discoveryRef : f.bindingRef) {
  return stage === 'discovery' ? readEntityDiscoveryEvidence(f.source, f.model, reference, archive, f.sourcePlan)
    : readMentionBindingEvidence(f.source, f.readA(), f.model, reference, archive);
}
const receiptFor = (f: ReturnType<typeof discoveredEntitiesFixture>, stage: Stage) => stage === 'discovery' ? f.discoveryReceipt : f.bindingReceipt;
const nativeFor = (f: ReturnType<typeof discoveredEntitiesFixture>, stage: Stage) => stage === 'discovery' ? f.discoveryNative : f.bindingNative;
const reseal = (f: ReturnType<typeof discoveredEntitiesFixture>, stage: Stage) => stage === 'discovery' ? f.resealA() : f.resealB();

describe('independent discovery and mention-binding archive evidence (authored only)', () => {
  it.each(['codex', 'openai-api'] as const)('authenticates both %s originals and includes A full receipt/raw in exact B input', executor => {
    const f = discoveredEntitiesFixture(executor), before = f.canonicalSnapshot(), bytesA = f.bytesA(), bytesB = f.bytesB();
    const a = f.readA(), b = readMentionBindingEvidence(f.source, a, f.model, f.bindingRef, f.archive);
    expect(a).toMatchObject({ checked: { status: 'checked', dispositionIssues: [] }, receipt: f.discoveryReceipt, receiptRef: f.discoveryRef.receiptRef,
      receiptRaw: bytesA.receiptBytes.toString('utf8'), rawOutput: f.result('discovery').output });
    expect(a.predecessor).toEqual({ receiptId: f.discoveryRef.receiptId, receiptRef: f.discoveryRef.receiptRef,
      nativeRef: f.discoveryReceipt.nativeRef, requestDigest: f.discoveryReceipt.requestDigest,
      receiptRaw: bytesA.receiptBytes.toString('utf8'), rawOutput: f.result('discovery').output });
    const bInput = JSON.parse(f.bindingReceipt.request.input);
    expect(JSON.stringify(bInput)).toContain(JSON.stringify(a.receiptRaw).slice(1, -1));
    expect(JSON.stringify(bInput)).toContain(JSON.stringify(a.rawOutput).slice(1, -1));
    expect(f.discoveryReceipt.request.input).not.toContain('sourcePath');
    expect(JSON.parse(f.discoveryReceipt.request.input).sourcePlanResponse).toEqual(f.planPredecessor);
    expect(bInput.binding.sourcePlanRawDigest).toBe(discoveryHash(f.sourcePlan.rawOutput));
    expect(f.discoveryExecution.input.outputFormat).toMatchObject({ mode: 'json-schema', name: ENTITY_DISCOVERY_OUTPUT_NAME });
    expect(f.discoveryExecution.input.outputFormat?.mode === 'json-schema' && f.discoveryExecution.input.outputFormat.schema).toBe(ENTITY_DISCOVERY_WIRE_SCHEMA);
    expect(f.bindingExecution.input.outputFormat).toMatchObject({ mode: 'json-schema', name: MENTION_BINDING_OUTPUT_NAME });
    expect(f.bindingExecution.input.outputFormat?.mode === 'json-schema' && f.bindingExecution.input.outputFormat.schema).toBe(MENTION_BINDING_WIRE_SCHEMA);
    expect(b).toMatchObject({ receipt: f.bindingReceipt, receiptRaw: bytesB.receiptBytes.toString('utf8'),
      rawOutput: f.result('binding').output, checked: { status: 'checked', admission: { status: 'ready' } } });
    expect(b.receipt.receiptId).not.toBe(a.receipt.receiptId); expect(b.receipt.attemptId).not.toBe(a.receipt.attemptId);
    expect(f.read.mock.calls.map(call => call[0])).toEqual(['discovery', 'binding']);
    expect(f.inspect).toHaveBeenCalledTimes(2); expect(f.canonicalSnapshot()).toBe(before);
    expect(f.bytesA()).toEqual(bytesA); expect(f.bytesB()).toEqual(bytesB);
    expect(b).not.toHaveProperty('entityAnalysis'); expect(b).not.toHaveProperty('extractionRun');
  });

  for (const stage of stages) {
    it.each(['receipt-id', 'native-receipt-id', 'native-attempt-id', 'source', 'source-content', 'input', 'system', 'system-version', 'wire',
      'model', 'executor', 'timeout', 'tokens', 'producer', 'request-digest', 'finish-time'] as const)(
      `${stage} rejects conflicting %s even when resealed`, mode => {
        const f = discoveredEntitiesFixture(), receipt = receiptFor(f, stage), native = nativeFor(f, stage);
        if (mode === 'receipt-id') receipt.receiptId = discoveryUid(90);
        if (mode === 'native-receipt-id') native.receiptId = discoveryUid(90);
        if (mode === 'native-attempt-id') native.attemptId = discoveryUid(90);
        if (mode === 'source') receipt.sourceVersion = discoveryHash('other source');
        if (mode === 'source-content') f.source.excerpts[0].text += '；来源不同';
        if (mode === 'input') receipt.request.input += ' ';
        if (mode === 'system') receipt.request.system += ' ';
        if (mode === 'system-version') Object.assign(receipt.request, { systemVersion: stage === 'discovery'
          ? 'knowledge-entity-discovery-system/v2' : 'knowledge-mention-binding-system/v2' });
        if (mode === 'wire') Object.assign(receipt.request, { wireId: discoveryHash('other wire') });
        if (mode === 'model') receipt.request.model = 'other-model';
        if (mode === 'executor') receipt.request.executor = 'openai-api';
        if (mode === 'timeout') receipt.request.timeoutMs++;
        if (mode === 'tokens') receipt.request.maxOutputTokens = 2048;
        if (mode === 'producer') receipt.producer.producerRevision = discoveryHash('other producer');
        if (mode === 'finish-time') receipt.finishedAt = '2025-10-24T00:00:00Z';
        let reference = reseal(f, stage), archive = f.archive;
        if (mode === 'request-digest') {
          receipt.requestDigest = discoveryHash('incorrect dispatch identity');
          const receiptBytes = discoveryBytes(receipt), oldRead = archive.read;
          reference = { ...reference, receiptRef: discoveryRef(receiptBytes) };
          archive = { ...archive, read: (which, id, ref) => which === stage
            ? { receiptBytes, outcomeBytes: stage === 'discovery' ? f.bytesA().outcomeBytes : f.bytesB().outcomeBytes }
            : oldRead(which, id, ref) };
        }
        expect(() => fixtureRead(f, stage, archive, reference)).toThrow();
      });

    it.each(['unsuccessful', 'cancelled', 'missing-output', 'refusal', 'tools', 'malformed-tools', 'subagents', 'retry',
      'turns', 'missing-turns', 'full-turns', 'cleanup', 'exception', 'projection', 'unencodable-output'] as const)(
      `${stage} retains but rejects %s native originals with an assessment`, mode => {
        const f = discoveredEntitiesFixture(), native = nativeFor(f, stage), result = f.result(stage);
        if (mode === 'unsuccessful') result.ok = false;
        if (mode === 'cancelled') result.stopReason = 'cancelled';
        if (mode === 'missing-output') result.output = null;
        if (mode === 'refusal') result.refusal = 'authored refusal';
        if (mode === 'tools') result.toolCalls = [{ tool: 'authored-tool' }];
        if (mode === 'malformed-tools') result.toolCalls = 'unknown-shape';
        if (mode === 'subagents') result.numSubAgents = 1;
        if (mode === 'retry') result.attemptCount = 2;
        if (mode === 'turns') result.numTurns = 2;
        if (mode === 'missing-turns') delete result.numTurns;
        if (mode === 'full-turns') result.fullNumTurns = 2;
        if (mode === 'cleanup') native.outcome = { outcomeKind: 'result', result, cleanupFailure: { diagnostic: 'authored cleanup failure' } };
        if (mode === 'exception') native.outcome = { outcomeKind: 'exception', error: { representationKind: 'exception-diagnostic/v1',
          sourceType: 'string', name: null, message: 'authored exception', truncated: false, accessorsSkipped: false } };
        if (mode === 'projection') native.outcome = { outcomeKind: 'model-port-projection', scope: 'authored-model-port/v1', result: { output: '{}', durationMs: 1 } };
        if (mode === 'unencodable-output') result.output = String.fromCharCode(0xd800);
        const reference = reseal(f, stage), before = stage === 'discovery' ? f.bytesA() : f.bytesB();
        let error: unknown;
        try { fixtureRead(f, stage, f.archive, reference); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(DiscoveredEntitiesNativeError);
        expect(error).toMatchObject({ stage, outcome: native.outcome, assessment: { status: 'rejected' } });
        expect(stage === 'discovery' ? f.bytesA() : f.bytesB()).toEqual(before);
      });

    it(`${stage} rejects corrupt, non-UTF8, BOM and over-capacity bytes without repair`, () => {
      const f = discoveredEntitiesFixture(), receipt = receiptFor(f, stage), original = stage === 'discovery' ? f.bytesA() : f.bytesB();
      expect(() => fixtureRead(f, stage, f.archive, { receiptId: receipt.receiptId,
        receiptRef: { ...discoveryRef(original.receiptBytes), digest: discoveryHash('wrong bytes') } })).toThrow('byte identity');
      const cap = stage === 'discovery' ? ENTITY_DISCOVERY_RECEIPT_MAX_BYTES : MENTION_BINDING_RECEIPT_MAX_BYTES;
      for (const receiptBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(cap + 1)]) {
        const archive: EntityDiscoveryArchivePort = { ...f.archive, read: (which, id, ref) => which === stage
          ? { ...original, receiptBytes } : f.archive.read(which, id, ref) };
        expect(() => fixtureRead(f, stage, archive, { receiptId: receipt.receiptId, receiptRef: discoveryRef(receiptBytes) })).toThrow();
      }
      for (const outcomeBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(receipt.producer.maxOutcomeJsonBytes + 513)]) {
        const receiptBytes = discoveryBytes({ ...receipt, nativeRef: discoveryRef(outcomeBytes) });
        const archive: EntityDiscoveryArchivePort = { ...f.archive, read: (which, id, ref) => which === stage
          ? { receiptBytes, outcomeBytes } : f.archive.read(which, id, ref) };
        expect(() => fixtureRead(f, stage, archive, { receiptId: receipt.receiptId, receiptRef: discoveryRef(receiptBytes) })).toThrow();
      }
      receipt.producer.maxOutcomeJsonBytes = EXTRACTION_OUTCOME_MAX_BYTES + 1;
      const reference = reseal(f, stage), archive = { ...f.archive, inspect: () => receipt.producer };
      expect(() => fixtureRead(f, stage, archive, reference)).toThrow();
      expect(stage === 'discovery' ? f.bytesA().outcomeBytes : f.bytesB().outcomeBytes).toEqual(original.outcomeBytes);
    });

    it.each(['receipt-alias', 'receipt-version', 'native-alias', 'native-version'] as const)(
      `${stage} rejects %s framing rather than relabeling another task`, mode => {
        const f = discoveredEntitiesFixture(), receipt = receiptFor(f, stage), native = nativeFor(f, stage);
        if (mode === 'receipt-alias') Object.assign(receipt, { receiptKind: 'knowledge-source-plan-receipt' });
        if (mode === 'receipt-version') Object.assign(receipt, { schemaVersion: 1 });
        if (mode === 'native-alias') native.archiveKind = 'knowledge-source-plan-native';
        if (mode === 'native-version') native.schemaVersion = 2;
        const reference = reseal(f, stage);
        expect(() => fixtureRead(f, stage, f.archive, reference)).toThrow();
      });
  }

  it('binds exact A receipt bytes including posterior facts and rejects a changed predecessor/configuration before B archive read', () => {
    const f = discoveredEntitiesFixture(), beforeDigest = entityDiscoveryRequestDigest(f.discoveryReceipt);
    f.discoveryReceipt.finishedAt = '2026-10-24T00:00:01.500Z'; f.resealA();
    expect(entityDiscoveryRequestDigest(f.discoveryReceipt)).toBe(beforeDigest);
    const a = f.readA(); f.read.mockClear();
    expect(() => readMentionBindingEvidence(f.source, a, f.model, f.bindingRef, f.archive)).toThrow('frozen predecessor');
    expect(f.read.mock.calls.map(call => call[0])).toEqual(['binding']);
    f.read.mockClear();
    expect(() => mentionBindingExecution(f.source, a, { ...f.model, timeoutMs: 2001 })).toThrow('same discovery model');
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'attempt', 'chronology'] as const)('requires independent B %s identity and chronology', mode => {
    const f = discoveredEntitiesFixture();
    if (mode === 'receipt') f.bindingReceipt.receiptId = f.discoveryReceipt.receiptId;
    if (mode === 'attempt') f.bindingReceipt.attemptId = f.discoveryReceipt.attemptId;
    if (mode === 'chronology') f.bindingReceipt.startedAt = '2026-10-24T00:00:00Z';
    f.resealB(); expect(() => f.readB()).toThrow();
  });

  it('rejects a new A raw byte sequence even when its parsed discovery catalog is unchanged', () => {
    const f = discoveredEntitiesFixture();
    f.result('discovery').output += ' '; f.resealA();
    expect(f.readA().checked.status).toBe('checked');
    expect(() => f.readB()).toThrow('frozen predecessor');
  });

  it('binds full plan bytes and dispositions even when the entity catalog and anchors remain unchanged', () => {
    const f = discoveredEntitiesFixture(), priorCatalog = JSON.stringify({ entities: f.discoveryResponse.entities, anchors: f.discoveryResponse.anchors });
    f.discoveryResponse.dispositions[0].rationale += ' Authored clarification.';
    f.result('discovery').output = JSON.stringify(f.discoveryResponse); f.resealA();
    expect(f.readA().checked.status).toBe('checked');
    expect(JSON.stringify({ entities: f.discoveryResponse.entities, anchors: f.discoveryResponse.anchors })).toBe(priorCatalog);
    expect(() => f.readB()).toThrow('frozen predecessor');
    const changedPlan = { ...f.sourcePlan, rawOutput: `${f.sourcePlan.rawOutput} ` };
    expect(() => readEntityDiscoveryEvidence(f.source, f.model, f.discoveryRef, f.archive, changedPlan)).toThrow();
    const otherPlanReceipt = { ...f.sourcePlan, receiptRef: discoveryRef(Buffer.from('other plan receipt')) };
    expect(() => readEntityDiscoveryEvidence(f.source, f.model, f.discoveryRef, f.archive, otherPlanReceipt)).toThrow();
  });

  it('rejects an authenticated but multi-turn source-plan native before reading an A archive', () => {
    const f = discoveredEntitiesFixture(), outcome = f.plan.sourcePlanNative.outcome;
    if (outcome.outcomeKind !== 'result') throw new Error('Expected authored native result.');
    outcome.result.numTurns = 2; f.plan.resealSourcePlan();
    const sourcePlan = f.plan.readPlan(); f.read.mockClear();
    let error: unknown;
    try { readEntityDiscoveryEvidence(f.source, f.model, f.discoveryRef, f.archive, sourcePlan); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DiscoveredEntitiesNativeError);
    expect(error).toMatchObject({ stage: 'source-plan', outcome: sourcePlan.outcome, assessment: { status: 'rejected' } });
    expect(f.read).not.toHaveBeenCalled(); expect(outcome.result.numTurns).toBe(2);
  });

  it.each(['receipt', 'attempt', 'chronology'] as const)('requires independent A %s identity and plan chronology', mode => {
    const f = discoveredEntitiesFixture();
    if (mode === 'receipt') f.discoveryReceipt.receiptId = f.sourcePlan.receipt.receiptId;
    if (mode === 'attempt') f.discoveryReceipt.attemptId = f.sourcePlan.receipt.attemptId;
    if (mode === 'chronology') f.discoveryReceipt.startedAt = '2026-10-23T23:59:58Z';
    f.resealA(); expect(() => f.readA()).toThrow();
  });

  it('retains an undecided authenticated A original but blocks B dispatch before reading any B archive', () => {
    const f = discoveredEntitiesFixture(); Object.assign(f.discoveryResponse.dispositions[0], { dispositionKind: 'undetermined', entityIds: [] });
    f.result('discovery').output = ` \n${JSON.stringify(f.discoveryResponse)}\r\n`; f.resealA();
    const discovery = f.readA(), raw = discovery.rawOutput; f.read.mockClear();
    expect(discovery.checked).toMatchObject({ status: 'checked', dispositionIssues: ['disposition:source-object:undetermined'],
      raw: { text: raw }, semanticStatus: 'not_reviewed' });
    expect(() => mentionBindingExecution(f.source, discovery, f.model)).toThrow('undetermined');
    expect(() => readMentionBindingEvidence(f.source, discovery, f.model, f.bindingRef, f.archive)).toThrow('undetermined');
    expect(f.read).not.toHaveBeenCalled(); expect(f.result('discovery').output).toBe(raw);
  });

  it('keeps A quality rejection distinct from corrupt archives and exposes no B context', () => {
    const f = discoveredEntitiesFixture(); f.result('discovery').output = ' \n{bad json\r\n'; f.resealA();
    let error: unknown; try { f.readA(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(EntityDiscoveryValidationError);
    expect(error).toMatchObject({ checked: { status: 'rejected', raw: { text: f.result('discovery').output }, semanticStatus: 'not_reviewed' } });
    expect(f.read.mock.calls.map(call => call[0])).toEqual(['discovery']);
    expect(f.result('discovery').output).toBe(' \n{bad json\r\n');
  });

  it('returns B quality and unresolved admission results with exact raw, without inventing an analysis', () => {
    const malformed = discoveredEntitiesFixture(); malformed.result('binding').output = ' \n{bad json\r\n'; malformed.resealB();
    expect(malformed.readB()).toMatchObject({ rawOutput: malformed.result('binding').output,
      checked: { status: 'rejected', raw: { text: malformed.result('binding').output }, semanticStatus: 'not_reviewed' } });
    const unresolved = discoveredEntitiesFixture(); Object.assign(unresolved.bindingResponse.mentions[0], {
      bindingStatus: 'unbound', entityId: null, candidateEntityIds: ['e0'], reason: 'Authored unresolved binding.' });
    unresolved.result('binding').output = JSON.stringify(unresolved.bindingResponse); unresolved.resealB();
    expect(unresolved.readB()).toMatchObject({ checked: { status: 'checked', admission: { status: 'blocked' } } });
    expect(mentionBindingRequestDigest(unresolved.bindingReceipt)).toBe(unresolved.bindingReceipt.requestDigest);
  });
});
