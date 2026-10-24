import { describe, expect, it, vi } from 'vitest';
import { ENTITY_REFINEMENT_OUTPUT_NAME, ENTITY_REFINEMENT_SYSTEM, ENTITY_REFINEMENT_WIRE_SCHEMA } from '../../src/knowledge/extraction/entity-refinement.js';
import { MENTION_REBINDING_OUTPUT_NAME, MENTION_REBINDING_SYSTEM, MENTION_REBINDING_WIRE_SCHEMA } from '../../src/knowledge/extraction/mention-rebinding.js';
import { EXTRACTION_OUTCOME_MAX_BYTES } from '../../src/knowledge/extraction/generation.js';
import { ENTITY_REFINEMENT_RECEIPT_MAX_BYTES, MENTION_REBINDING_RECEIPT_MAX_BYTES,
  RefinedEntitiesNativeError, RefinedEntitiesValidationError, entityRefinementExecution, mentionRebindingExecution,
  entityRefinementRequestDigest, readEntityRefinementEvidence, readMentionRebindingEvidence,
  type RefinedEntitiesArchivePort } from '../../src/knowledge/extraction/refined-entities-evidence.js';
import { discoveryBytes, discoveryHash, discoveryRef, discoveryUid } from './discovered-entities-fixtures.js';
import { refinedEntitiesFixture } from './refined-entities-fixtures.js';

const stages = ['refinement', 'rebinding'] as const;
type Stage = typeof stages[number];
type Fixture = ReturnType<typeof refinedEntitiesFixture>;
const receiptFor = (f: Fixture, stage: Stage) => stage === 'refinement' ? f.refinementReceipt : f.rebindingReceipt;
const nativeFor = (f: Fixture, stage: Stage) => stage === 'refinement' ? f.refinementNative : f.rebindingNative;
const referenceFor = (f: Fixture, stage: Stage) => stage === 'refinement' ? f.refinementRef : f.rebindingRef;
const bytesFor = (f: Fixture, stage: Stage) => stage === 'refinement' ? f.bytesRefinement() : f.bytesRebinding();
const reseal = (f: Fixture, stage: Stage) => stage === 'refinement' ? f.resealRefinement() : f.resealRebinding();
function readStage(f: Fixture, stage: Stage, archive = f.refinedEntitiesArchive, reference = referenceFor(f, stage)) {
  return stage === 'refinement' ? readEntityRefinementEvidence(f.source, f.model, reference, archive, f.readBase())
    : readMentionRebindingEvidence(f.source, f.model, reference, archive, f.readRefinement());
}
function archiveBytes(f: Fixture, stage: Stage, receiptBytes: Uint8Array, outcomeBytes: Uint8Array): RefinedEntitiesArchivePort {
  return { ...f.refinedEntitiesArchive, read: (which, id, ref) => which === stage
    ? { receiptBytes, outcomeBytes } : f.refinedEntitiesArchive.read(which, id, ref) };
}
function originalBytes(f: Fixture) {
  const plan = f.references().sourcePlan;
  return { source: structuredClone(f.source), plan: f.sourcePlanArchive.read(plan.receiptId, plan.receiptRef),
    discovery: f.old.bytesA(), binding: f.old.bytesB(), refinement: f.bytesRefinement(), rebinding: f.bytesRebinding() };
}

describe('finite entity refinement archive evidence (authored originals only)', () => {
  it.each(['codex', 'openai-api'] as const)('authenticates all five %s originals without nesting or rewriting them', executor => {
    const f = refinedEntitiesFixture(executor, { collection: true, unresolved: true }), before = originalBytes(f);
    const base = f.readBase(), refinement = f.readRefinement(), rebinding = f.readRebinding();
    expect(base.binding.checked).toMatchObject({ status: 'checked', admission: { status: 'blocked' } });
    expect(refinement).toMatchObject({ receipt: f.refinementReceipt, receiptRef: f.refinementRef.receiptRef,
      receiptRaw: before.refinement.receiptBytes.toString(), rawOutput: f.result('refinement').output,
      checked: { status: 'checked', dispositionIssues: [], semanticStatus: 'not_reviewed' } });
    expect(rebinding).toMatchObject({ receipt: f.rebindingReceipt, receiptRef: f.rebindingRef.receiptRef,
      receiptRaw: before.rebinding.receiptBytes.toString(), rawOutput: f.result('rebinding').output,
      checked: { status: 'checked', admission: { status: 'ready' }, semanticStatus: 'not_reviewed' } });
    const inputA = JSON.parse(f.refinementReceipt.request.input), inputB = JSON.parse(f.rebindingReceipt.request.input);
    for (const [name, predecessor] of Object.entries(base.predecessor)) for (const input of [inputA, inputB]) {
      expect(input.predecessors[name]).toEqual({ receiptId: predecessor.receiptId, receiptRef: predecessor.receiptRef,
        nativeRef: predecessor.nativeRef, requestDigest: predecessor.requestDigest,
        rawDigest: discoveryHash(predecessor.rawOutput), rawOutput: predecessor.rawOutput });
      expect(input.predecessors[name]).not.toHaveProperty('receiptRaw');
    }
    expect(inputB.predecessors.refinement.rawOutput).toBe(refinement.rawOutput);
    expect(inputB.predecessors.refinement.rawDigest).toBe(discoveryHash(refinement.rawOutput));
    expect(inputB.predecessors.refinement).not.toHaveProperty('receiptRaw');
    expect(inputA.excerpts).toEqual(f.source.excerpts); expect(inputB.excerpts).toEqual(f.source.excerpts);
    expect(inputA.limitations).toEqual(f.source.limitations); expect(inputB.limitations).toEqual(f.source.limitations);
    expect(f.refinementExecution.input).toMatchObject({ system: ENTITY_REFINEMENT_SYSTEM,
      outputFormat: { mode: 'json-schema', name: ENTITY_REFINEMENT_OUTPUT_NAME, schema: ENTITY_REFINEMENT_WIRE_SCHEMA } });
    expect(f.rebindingExecution.input).toMatchObject({ system: MENTION_REBINDING_SYSTEM,
      outputFormat: { mode: 'json-schema', name: MENTION_REBINDING_OUTPUT_NAME, schema: MENTION_REBINDING_WIRE_SCHEMA } });
    expect(f.refinedRead.mock.calls.map(call => call[0])).toEqual(['refinement', 'refinement', 'rebinding']);
    expect(originalBytes(f)).toEqual(before);
    expect(rebinding).not.toHaveProperty('entityAnalysis'); expect(rebinding).not.toHaveProperty('extractionRun');
  });

  it('allows a checked ready original B to enter refinement without claiming its catalog is correct', () => {
    const f = refinedEntitiesFixture();
    f.old.bindingResponse.mentions = f.old.bindingResponse.mentions.filter(mention => mention.mentionId !== 'gap');
    f.old.result('binding').output = ` \n${JSON.stringify(f.old.bindingResponse)}\r\n`; f.old.resealB();
    const base = f.readBase();
    expect(base.binding.checked).toMatchObject({ status: 'checked', admission: { status: 'ready' }, semanticStatus: 'not_reviewed' });
    const execution = entityRefinementExecution(f.source, f.model, base, f.refinedEntitiesArchive);
    f.refinementReceipt.request = execution.request; f.refinementReceipt.producer = execution.producer;
    f.refinementResponse.binding = JSON.parse(execution.request.input).binding;
    f.refinementResponse.bindingGapDispositions = [];
    f.result('refinement').output = ` \n${JSON.stringify(f.refinementResponse)}\r\n`; f.resealRefinement();
    expect(f.readRefinement().checked).toMatchObject({ status: 'checked', dispositionIssues: [], semanticStatus: 'not_reviewed' });
    expect(JSON.parse(execution.request.input).predecessors.binding.rawOutput).toBe(f.old.result('binding').output);
  });

  it.each(['A-undetermined', 'B-rejected', 'B-native-failure', 'plan-v3', 'A-v4', 'B-v4'] as const)(
    'rejects ineligible current base %s before any new-stage archive read', mode => {
      const f = refinedEntitiesFixture();
      if (mode === 'A-undetermined') {
        Object.assign(f.old.discoveryResponse.dispositions[0], { dispositionKind: 'undetermined', entityIds: [] });
        f.old.result('discovery').output = JSON.stringify(f.old.discoveryResponse); f.old.resealA();
      }
      if (mode === 'B-rejected') { f.old.result('binding').output = '{bad json'; f.old.resealB(); }
      if (mode === 'B-native-failure') { f.old.result('binding').numTurns = 2; f.old.resealB(); }
      if (mode === 'plan-v3') {
        Object.assign(f.old.plan.sourcePlanReceipt.request, { systemVersion: 'knowledge-source-plan-system/v3' });
        f.old.plan.resealSourcePlan();
      }
      if (mode === 'A-v4') { Object.assign(f.old.discoveryReceipt.request, { systemVersion: 'knowledge-entity-discovery-system/v4' }); f.old.resealA(); }
      if (mode === 'B-v4') { Object.assign(f.old.bindingReceipt.request, { systemVersion: 'knowledge-mention-binding-system/v4' }); f.old.resealB(); }
      expect(() => f.readBase()).toThrow(); expect(f.refinedRead).not.toHaveBeenCalled();
      expect(f.refinedInspect).not.toHaveBeenCalled();
    });

  for (const stage of stages) {
    it.each(['reference-id', 'native-receipt', 'native-attempt', 'source', 'input', 'input-version', 'system', 'system-version', 'wire',
      'producer', 'producer-proof', 'request-digest', 'chronology', 'reversed-time'] as const)(
      `${stage} rejects a resealed %s conflict`, mode => {
        const f = refinedEntitiesFixture(), receipt = receiptFor(f, stage), native = nativeFor(f, stage);
        if (mode === 'native-receipt') native.receiptId = discoveryUid(90);
        if (mode === 'native-attempt') native.attemptId = discoveryUid(90);
        if (mode === 'source') receipt.sourceVersion = discoveryHash('another source');
        if (mode === 'input') receipt.request.input += ' ';
        if (mode === 'input-version') Object.assign(receipt.request, { inputVersion: stage === 'refinement'
          ? 'knowledge-entity-refinement-input/v1' : 'knowledge-mention-rebinding-input/v1' });
        if (mode === 'system') receipt.request.system += ' ';
        if (mode === 'system-version') Object.assign(receipt.request, { systemVersion: stage === 'refinement'
          ? 'knowledge-entity-refinement-system/v2' : 'knowledge-mention-rebinding-system/v2' });
        if (mode === 'wire') Object.assign(receipt.request, { wireId: discoveryHash('another wire') });
        if (mode === 'producer') receipt.producer.producerRevision = discoveryHash('another producer');
        if (mode === 'producer-proof') receipt.producer.proof = { scope: 'another same-task witness' };
        if (mode === 'chronology') receipt.startedAt = stage === 'refinement' ? '2026-10-24T00:00:02Z' : '2026-10-24T00:00:04Z';
        if (mode === 'reversed-time') receipt.finishedAt = '2026-10-23T23:59:58Z';
        let reference = reseal(f, stage), archive = f.refinedEntitiesArchive;
        if (mode === 'reference-id') reference = { ...reference, receiptId: discoveryUid(90) };
        if (mode === 'request-digest') {
          receipt.requestDigest = discoveryHash('incorrect dispatch identity');
          const receiptBytes = discoveryBytes(receipt);
          reference = { ...reference, receiptRef: discoveryRef(receiptBytes) };
          archive = archiveBytes(f, stage, receiptBytes, bytesFor(f, stage).outcomeBytes);
        }
        const before = originalBytes(f);
        expect(() => readStage(f, stage, archive, reference)).toThrow(); expect(originalBytes(f)).toEqual(before);
      });

    it.each(['model', 'executor', 'timeout', 'tokens', 'source-content'] as const)(
      `${stage} refuses changed %s before inspect or archive read`, mode => {
        const f = refinedEntitiesFixture(), base = f.readBase(), refinement = f.readRefinement();
        const model = { ...f.model }, source = structuredClone(f.source);
        if (mode === 'model') model.model += '-changed';
        if (mode === 'executor') model.executor = 'openai-api';
        if (mode === 'timeout') model.timeoutMs++;
        if (mode === 'tokens') model.maxOutputTokens++;
        if (mode === 'source-content') source.excerpts[0].text += ' changed';
        f.refinedInspect.mockClear(); f.refinedRead.mockClear();
        expect(() => stage === 'refinement' ? entityRefinementExecution(source, model, base, f.refinedEntitiesArchive)
          : mentionRebindingExecution(source, model, refinement, f.refinedEntitiesArchive)).toThrow();
        expect(f.refinedInspect).not.toHaveBeenCalled(); expect(f.refinedRead).not.toHaveBeenCalled();
      });

    it(`${stage} rejects collision of either new UUID with every earlier receipt/attempt role and with itself`, () => {
      const previousRoles = ['plan-receipt', 'plan-attempt', 'A-receipt', 'A-attempt', 'B-receipt', 'B-attempt',
        ...(stage === 'rebinding' ? ['A-prime-receipt', 'A-prime-attempt'] : [])];
      for (const field of ['receiptId', 'attemptId'] as const) for (const [index, role] of previousRoles.entries()) {
        const f = refinedEntitiesFixture(), receipt = receiptFor(f, stage), native = nativeFor(f, stage);
        const originals = [f.old.plan.sourcePlanReceipt, f.old.discoveryReceipt, f.old.bindingReceipt,
          ...(stage === 'rebinding' ? [f.refinementReceipt] : [])];
        receipt[field] = originals.flatMap(original => [original.receiptId, original.attemptId])[index]!;
        native[field] = receipt[field]; reseal(f, stage);
        expect(() => readStage(f, stage), `${stage}.${field} overlaps ${role}`).toThrow('independent');
      }
      const f = refinedEntitiesFixture(), receipt = receiptFor(f, stage), native = nativeFor(f, stage);
      receipt.attemptId = receipt.receiptId; native.attemptId = receipt.receiptId; reseal(f, stage);
      expect(() => readStage(f, stage)).toThrow('independent');
    });

    it.each(['unsuccessful', 'cancelled', 'missing-output', 'refusal', 'tools', 'malformed-tools', 'subagents', 'retry',
      'turns', 'missing-turns', 'full-turns', 'cleanup', 'exception', 'projection', 'unencodable-output'] as const)(
      `${stage} preserves a rejected %s native original and assessment`, mode => {
        const f = refinedEntitiesFixture(), native = nativeFor(f, stage), result = f.result(stage);
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
        reseal(f, stage); const before = originalBytes(f); let error: unknown;
        try { readStage(f, stage); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(RefinedEntitiesNativeError);
        expect(error).toMatchObject({ stage, outcome: native.outcome, assessment: { status: 'rejected', issues: ['incomplete_native_return'] } });
        expect(originalBytes(f)).toEqual(before);
      });

    it.each(['receipt-alias', 'receipt-version', 'native-alias', 'native-version'] as const)(
      `${stage} rejects %s instead of relabeling an existing task`, mode => {
        const f = refinedEntitiesFixture(), receipt = receiptFor(f, stage), native = nativeFor(f, stage);
        if (mode === 'receipt-alias') Object.assign(receipt, { receiptKind: 'knowledge-entity-discovery-receipt' });
        if (mode === 'receipt-version') Object.assign(receipt, { schemaVersion: 2 });
        if (mode === 'native-alias') native.archiveKind = 'knowledge-entity-discovery-native';
        if (mode === 'native-version') native.schemaVersion = 2;
        reseal(f, stage); expect(() => readStage(f, stage)).toThrow();
      });

    it(`${stage} rejects corrupt, non-UTF8, BOM and oversized archives without repairing them`, () => {
      const f = refinedEntitiesFixture(), receipt = receiptFor(f, stage), original = bytesFor(f, stage);
      expect(() => readStage(f, stage, f.refinedEntitiesArchive, { receiptId: receipt.receiptId,
        receiptRef: { ...discoveryRef(original.receiptBytes), digest: discoveryHash('wrong receipt bytes') } })).toThrow('byte identity');
      const cap = stage === 'refinement' ? ENTITY_REFINEMENT_RECEIPT_MAX_BYTES : MENTION_REBINDING_RECEIPT_MAX_BYTES;
      for (const receiptBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(cap + 1)]) {
        const archive = archiveBytes(f, stage, receiptBytes, original.outcomeBytes);
        expect(() => readStage(f, stage, archive, { receiptId: receipt.receiptId, receiptRef: discoveryRef(receiptBytes) })).toThrow();
      }
      for (const outcomeBytes of [Buffer.from([0xff]), Buffer.from('\ufeff{}'), Buffer.alloc(receipt.producer.maxOutcomeJsonBytes + 513)]) {
        const receiptBytes = discoveryBytes({ ...receipt, nativeRef: discoveryRef(outcomeBytes) });
        expect(() => readStage(f, stage, archiveBytes(f, stage, receiptBytes, outcomeBytes),
          { receiptId: receipt.receiptId, receiptRef: discoveryRef(receiptBytes) })).toThrow();
      }
      expect(bytesFor(f, stage)).toEqual(original);
    });

    it.each(['outcome-cap', 'receipt-cap', 'normalizing-proof'] as const)(
      `${stage} forces actual inspected-producer %s preflight without reading originals`, mode => {
        const f = refinedEntitiesFixture(), base = f.readBase(), refinement = f.readRefinement(), before = originalBytes(f);
        const producer = structuredClone(receiptFor(f, stage).producer);
        if (mode === 'outcome-cap') producer.maxOutcomeJsonBytes = EXTRACTION_OUTCOME_MAX_BYTES + 1;
        if (mode === 'receipt-cap') producer.proof = { padding: '\\'.repeat(1024 * 1024) };
        if (mode === 'normalizing-proof') Object.assign(producer, { unexpectedField: 'not an exact producer proof' });
        const inspect = vi.fn(() => producer), archive = { inspect };
        f.refinedRead.mockClear();
        expect(() => stage === 'refinement' ? entityRefinementExecution(f.source, f.model, base, archive)
          : mentionRebindingExecution(f.source, f.model, refinement, archive)).toThrow();
        expect(inspect).toHaveBeenCalledTimes(1);
        expect(inspect).toHaveBeenCalledWith(f.model.executor, stage === 'refinement' ? f.refinementExecution.input : f.rebindingExecution.input);
        expect(f.refinedRead).not.toHaveBeenCalled();
        expect(originalBytes(f)).toEqual(before);
      });
  }

  it.each(['plan-attempt', 'A-attempt', 'plan-receipt', 'A-receipt', 'self'] as const)(
    'rejects a base B cross-role UUID collision with %s even when current old readers authenticate the bytes', role => {
      const f = refinedEntitiesFixture(), receipt = f.old.bindingReceipt, native = f.old.bindingNative;
      if (role === 'plan-attempt') receipt.receiptId = f.old.plan.sourcePlanReceipt.attemptId;
      if (role === 'A-attempt') receipt.receiptId = f.old.discoveryReceipt.attemptId;
      if (role === 'plan-receipt') receipt.attemptId = f.old.plan.sourcePlanReceipt.receiptId;
      if (role === 'A-receipt') receipt.attemptId = f.old.discoveryReceipt.receiptId;
      if (role === 'self') receipt.attemptId = receipt.receiptId;
      native.receiptId = receipt.receiptId; native.attemptId = receipt.attemptId; f.old.resealB();
      expect(f.old.readB().checked.status).toBe('checked');
      expect(() => f.readBase()).toThrow('independent'); expect(f.refinedRead).not.toHaveBeenCalled();
    });

  it.each(['posterior-receipt', 'raw-whitespace', 'binding-gap-only'] as const)(
    'authenticates changed A-prime %s locally but rejects stale B-prime full predecessor binding', mode => {
      const f = refinedEntitiesFixture(), catalog = discoveryBytes({ entities: f.refinementResponse.entities, anchors: f.refinementResponse.anchors });
      const dispatchDigest = entityRefinementRequestDigest(f.refinementReceipt);
      if (mode === 'posterior-receipt') f.refinementReceipt.finishedAt = '2026-10-24T00:00:05.500Z';
      if (mode === 'raw-whitespace') f.result('refinement').output += ' ';
      if (mode === 'binding-gap-only') {
        f.refinementResponse.bindingGapDispositions[0].rationale += ' Authored clarification.';
        f.result('refinement').output = JSON.stringify(f.refinementResponse);
      }
      f.resealRefinement();
      expect(f.readRefinement().checked.status).toBe('checked');
      expect(entityRefinementRequestDigest(f.refinementReceipt)).toBe(dispatchDigest);
      expect(discoveryBytes({ entities: f.refinementResponse.entities, anchors: f.refinementResponse.anchors })).toEqual(catalog);
      expect(() => f.readRebinding()).toThrow('frozen source');
    });

  it.each(['entity', 'binding-gap'] as const)('preserves a checked A-prime undetermined %s but refuses B-prime before inspect or archive read', which => {
    const f = refinedEntitiesFixture();
    if (which === 'binding-gap') Object.assign(f.refinementResponse.bindingGapDispositions[0], { resolutionKind: 'undetermined', targets: [] });
    else Object.assign(f.refinementResponse.entityDispositions[0], { dispositionKind: 'undetermined', entityIds: [] });
    f.result('refinement').output = ` \n${JSON.stringify(f.refinementResponse)}\r\n`; f.resealRefinement();
    const refinement = f.readRefinement(), before = originalBytes(f);
    expect(refinement.checked).toMatchObject({ status: 'checked',
      dispositionIssues: [which === 'binding-gap' ? 'binding-gap:gap:undetermined' : 'entity-disposition:e0:undetermined'], semanticStatus: 'not_reviewed' });
    f.refinedRead.mockClear(); f.refinedInspect.mockClear();
    expect(() => mentionRebindingExecution(f.source, f.model, refinement, f.refinedEntitiesArchive)).toThrow(RefinedEntitiesValidationError);
    expect(() => readMentionRebindingEvidence(f.source, f.model, f.rebindingRef, f.refinedEntitiesArchive, refinement)).toThrow(RefinedEntitiesValidationError);
    expect(f.refinedRead).not.toHaveBeenCalled(); expect(f.refinedInspect).not.toHaveBeenCalled();
    expect(originalBytes(f)).toEqual(before);
  });

  it('keeps new-stage structure rejection separate from native failure and preserves final blocked results', () => {
    const rejectedA = refinedEntitiesFixture(); rejectedA.result('refinement').output = ' \n{bad json\r\n'; rejectedA.resealRefinement();
    let error: unknown; try { rejectedA.readRefinement(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RefinedEntitiesValidationError);
    expect(error).toMatchObject({ stage: 'refinement', checked: { status: 'rejected', raw: { text: rejectedA.result('refinement').output }, semanticStatus: 'not_reviewed' } });
    const rejectedB = refinedEntitiesFixture(); rejectedB.result('rebinding').output = ' \n{bad json\r\n'; rejectedB.resealRebinding();
    expect(rejectedB.readRebinding()).toMatchObject({ rawOutput: rejectedB.result('rebinding').output,
      checked: { status: 'rejected', raw: { text: rejectedB.result('rebinding').output }, semanticStatus: 'not_reviewed' } });
    const blocked = refinedEntitiesFixture();
    Object.assign(blocked.rebindingResponse.mentions.find(mention => mention.mentionId === 'next-gap')!, {
      bindingStatus: 'unbound', entityId: null, candidateEntityIds: [], reason: 'Authored unresolved binding remains.' });
    blocked.result('rebinding').output = JSON.stringify(blocked.rebindingResponse); blocked.resealRebinding();
    expect(blocked.readRebinding()).toMatchObject({ checked: { status: 'checked', admission: { status: 'blocked' }, semanticStatus: 'not_reviewed' } });
  });
});
