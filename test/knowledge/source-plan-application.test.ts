import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeStudyFixture, studyNativeResult } from './extraction-study-fixtures.js';
import { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { sourcePlanExecution, sourcePlanRequestDigest, type SourcePlanReceipt,
  type SourcePlanArchivePort, SourcePlanValidationError, SourcePlanReceiptSchema, readSourcePlanEvidence } from '../../src/knowledge/extraction/source-plan-evidence.js';
import { SOURCE_PLAN_FINAL_INPUT_VERSION, buildSourcePlannedExtractionInput } from '../../src/knowledge/extraction/source-plan-input.js';
import { SOURCE_PLAN_SYSTEM, SOURCE_PLAN_WIRE_SCHEMA_JSON, SOURCE_PLAN_OUTPUT_NAME } from '../../src/knowledge/extraction/source-plan.js';
import { ENTITY_REFERENT_KIND_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';
import { EXTRACTION_INPUT_MAX_BYTES, ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import { boundedExtractionPolicy } from '../../src/knowledge/extraction/generation-policy.js';
import { STRICT_EXTRACTION_PROMPT } from '../../src/knowledge/extraction/strict-prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const ref = (value: Uint8Array) => ({ bytes: value.byteLength, digest: hash(value) });

function setup(reply?: Parameters<typeof nativeStudyFixture>[1]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-source-plan-'))); roots.push(root);
  const f = nativeStudyFixture(root, reply), window = f.corpus.cases[0].window, model = f.model();
  const producer = createOpenAiArchiveProducer({ NODE_ENV: 'test', OPENAI_API_KEY: 'authored-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' });
  const execution = sourcePlanExecution(window, model), receiptId = randomUUID(), attemptId = randomUUID();
  const anchor = (quote: string) => ({ evidenceRef: window.excerpts[0].evidenceRef, quote, occurrence: null });
  // Intentionally wrong context roles must remain untrusted; the final authored return still admits both source objects and their knowledge.
  const plan = { responseKind: 'knowledge-source-plan', schemaVersion: 2, snapshotId: window.snapshotId, sourceVersion: window.sourceVersion,
    objects: ['Alpha', 'Beta'].map((meaning, index) => ({ objectId: `o${index}`, meaning,
      planningRole: index === 0 ? 'context_only' : 'entity_candidate', qualificationBasis: 'Authored unreviewed role claim, not semantic truth.',
      referentKind: 'object', identityStatus: 'proposed',
      identityBasis: 'Explicit local object in this authored source.', typeBasis: 'No finer role is specified.',
      anchors: [anchor(meaning)], uncertainties: [], sharedScope: null })),
    materials: [{ materialId: 'u0', retentionIntent: 'context_only', reuseBasis: 'Intentionally incorrect authored role claim.',
      participantObjectIds: ['o0', 'o1'], contextObjectIds: [], meaning: 'Source asserts that Alpha uses Beta.', conditions: [], limits: [],
      unknowns: ['Authored source assertion; no independently verified fact or fact-time.'], anchors: [anchor('Alpha 使用 Beta')] }] };
  const native = { archiveKind: 'knowledge-source-plan-native', schemaVersion: 1, receiptId, attemptId,
    outcome: { outcomeKind: 'result', result: studyNativeResult(` \n${JSON.stringify(plan)}\n `) } };
  const receipt: SourcePlanReceipt = { receiptKind: 'knowledge-source-plan-receipt', schemaVersion: 1, receiptId, attemptId,
    snapshotId: window.snapshotId, sourceVersion: window.sourceVersion, request: execution.request,
    producer: SourcePlanReceiptSchema.shape.producer.parse(producer.inspect(model.executor, execution.input)), requestDigest: '', nativeRef: ref(bytes(native)),
    startedAt: '2020-01-01T00:00:00Z', finishedAt: '2020-01-01T00:00:01Z' };
  let outcomeBytes: Buffer = bytes(native), receiptBytes: Buffer;
  const reseal = () => {
    outcomeBytes = bytes(native); receipt.nativeRef = ref(outcomeBytes);
    receipt.requestDigest = sourcePlanRequestDigest(receipt); receiptBytes = bytes(receipt);
    return { receiptId, receiptRef: ref(receiptBytes) };
  };
  const reference = reseal();
  const inspect = vi.fn((...args: Parameters<SourcePlanArchivePort['inspect']>) => producer.inspect(...args));
  const archive: SourcePlanArchivePort = { read: () => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(outcomeBytes) }), inspect };
  const app = (port: SourcePlanArchivePort | null = archive) => new KnowledgeApplication({
    runs: f.ports.runs, actor: f.ports.actor, hash: value => hash(canonicalJson(value)), id: randomUUID, now: () => new Date().toISOString(),
    evidence: new TraceEvidenceStore(join(f.workspace, 'sources'), f.workspace),
    knowledge: new FileKnowledgeStore(join(f.workspace, 'items'), 'local', f.workspace),
    tags: new FileKnowledgeTags(join(f.workspace, 'tags'), 'local', f.workspace),
    entities: new FileEntityAnalysisStore(join(f.workspace, 'entities'), f.workspace), ...(port ? { sourcePlanArchive: port } : {}) });
  return { ...f, window, model, app, archive, inspect, plan, native, receipt, reference, reseal,
    receiptBytes: () => receiptBytes, setOutcomeBytes: (value: Buffer) => { outcomeBytes = value; receipt.nativeRef = ref(value); receipt.requestDigest = sourcePlanRequestDigest(receipt); receiptBytes = bytes(receipt); } };
}

describe('source semantic plan to real application admission (authored native evidence)', () => {
  it('authenticates the separate task and preserves untrusted roles without filtering final strict30/native admission', async () => {
    const f = setup(), app = f.app(), id = randomUUID(), options = { sourceSemanticPlan: f.reference };
    const nativeOriginal = bytes(f.native), receiptOriginal = f.receiptBytes();
    const run = await app.generate(f.window.snapshotId, f.model, id, undefined, options);
    const actual = f.effects.mock.calls[0][0], input = JSON.parse(actual.prompt);
    expect(SOURCE_PLAN_FINAL_INPUT_VERSION).toBe('knowledge-extraction-source-plan-input/v2');
    expect(input).toMatchObject({ taskKind: 'source_planned_extraction', taskVersion: SOURCE_PLAN_FINAL_INPUT_VERSION,
      excerpts: f.window.excerpts, limitations: f.window.limitations,
      sourcePlanResponse: { receiptRef: f.reference.receiptRef, rawOutput: f.native.outcome.result.output, semanticStatus: 'not_reviewed' } });
    expect(input).not.toHaveProperty('sourcePath');
    expect(f.inspect.mock.calls[0][1]).toMatchObject({ system: SOURCE_PLAN_SYSTEM,
      outputFormat: { name: SOURCE_PLAN_OUTPUT_NAME, schema: SOURCE_PLAN_WIRE_SCHEMA_JSON } });
    expect(f.receipt.request).toMatchObject({ systemVersion: 'knowledge-source-plan-system/v3', system: SOURCE_PLAN_SYSTEM });
    expect(f.receipt.request.system.split(ENTITY_REFERENT_KIND_POLICY)).toHaveLength(2);
    expect(run.status).toBe('completed'); expect(run.attempts).toHaveLength(1);
    expect(run.promptVersion).toBe('knowledge-extraction-v30');
    expect(run.committed).toHaveLength(1); expect(run.entityAnalysis?.revision.entities).toHaveLength(2);
    const outcome = f.ports.runs.readOutcome(id, run.attempts[0].attemptId).outcome;
    expect(outcome).toMatchObject({ outcomeKind: 'result', result: { output: run.rawOutput } });
    expect(f.receiptBytes()).toEqual(receiptOriginal); expect(bytes(f.native)).toEqual(nativeOriginal);
    await app.generate(f.window.snapshotId, f.model, id, undefined, options);
    expect(f.effects).toHaveBeenCalledTimes(1);
    f.receipt.finishedAt = '2020-01-01T00:00:02Z';
    const changedReceipt = f.reseal();
    await expect(app.generate(f.window.snapshotId, f.model, id, undefined,
      { sourceSemanticPlan: changedReceipt })).rejects.toThrow('identity conflict');
    expect(f.effects).toHaveBeenCalledTimes(1);
    await expect(app.generate(f.window.snapshotId, f.model, id)).rejects.toThrow('identity conflict');
    await expect(app.generate(f.window.snapshotId, f.model, randomUUID(), undefined,
      { coverageReview: { previousRunId: id } })).rejects.toThrow('source-only first task');
  });

  it('never repairs final re-authored quotes even when every planning anchor was correct', async () => {
    const f = setup((_index, output) => {
      const result = JSON.parse(output); result.mentions[0].selection.quote = 'not in this source';
      return studyNativeResult(JSON.stringify(result));
    });
    const run = await f.app().generate(f.window.snapshotId, f.model, randomUUID(), undefined, { sourceSemanticPlan: f.reference });
    expect(run.rawOutput).toContain('not in this source');
    expect(run.entityRejections?.some(value => value.reasons.includes('quote_mismatch'))).toBe(true);
    expect(run.rejections.length).toBeGreaterThan(0); expect(run.committed).toEqual([]);
    expect(run.entityAnalysis?.revision.entities).toHaveLength(1);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it('preserves the complete plan and source at the final strict30 capacity boundary', () => {
    const f = setup(), plan = readSourcePlanEvidence(f.window, f.model, f.reference, f.archive);
    const window = { ...f.window, limitations: [''] };
    const baseline = buildSourcePlannedExtractionInput(window, plan);
    const available = EXTRACTION_INPUT_MAX_BYTES - Buffer.byteLength(STRICT_EXTRACTION_PROMPT) - Buffer.byteLength(baseline);
    window.limitations[0] = 'x'.repeat(available);
    const input = buildSourcePlannedExtractionInput(window, plan);
    expect(Buffer.byteLength(input) + Buffer.byteLength(STRICT_EXTRACTION_PROMPT)).toBe(EXTRACTION_INPUT_MAX_BYTES);
    expect(JSON.parse(input).sourcePlanResponse.rawOutput).toBe(f.native.outcome.result.output);
    expect(JSON.parse(input).limitations).toEqual(window.limitations);
    window.limitations[0] += 'x';
    const original = structuredClone({ window, plan });
    expect(() => buildSourcePlannedExtractionInput(window, plan)).toThrow(ExtractionInputCapacityError);
    expect({ window, plan }).toEqual(original);
    window.limitations[0] = '\ud800';
    expect(() => buildSourcePlannedExtractionInput(window, plan)).toThrow('UTF-8');
    expect(f.effects).not.toHaveBeenCalled();
  });

  it.each(['receipt-ref', 'native-bytes', 'receipt-id', 'attempt-id', 'source', 'input', 'system', 'system-version', 'wire', 'model', 'timeout', 'tokens', 'producer', 'request-digest', 'finish-time'] as const)(
    'rejects %s binding before any final reservation', async mode => {
      const f = setup();
      if (mode === 'receipt-id') f.receipt.receiptId = randomUUID();
      if (mode === 'attempt-id') f.native.attemptId = randomUUID();
      if (mode === 'source') f.receipt.sourceVersion = hash('different source');
      if (mode === 'input') f.receipt.request.input += ' ';
      if (mode === 'system') f.receipt.request.system += ' ';
      if (mode === 'system-version') Object.assign(f.receipt.request, { systemVersion: 'knowledge-source-plan-system/v2' });
      if (mode === 'wire') f.receipt.request.wireId = hash('different wire');
      if (mode === 'model') f.receipt.request.model = 'other';
      if (mode === 'timeout') f.receipt.request.timeoutMs++;
      if (mode === 'tokens') f.receipt.request.maxOutputTokens = 65;
      if (mode === 'producer') f.receipt.producer.producerRevision = hash('different producer');
      if (mode === 'finish-time') f.receipt.finishedAt = '2019-01-01T00:00:00Z';
      let reference = f.reseal();
      if (mode === 'receipt-ref') reference = { ...reference, receiptRef: { ...reference.receiptRef, digest: hash('wrong receipt') } };
      if (mode === 'native-bytes') { f.native.outcome.result.output += ' '; /* deliberately do not update nativeRef */
        const port: SourcePlanArchivePort = { ...f.archive, read: () => ({ receiptBytes: f.receiptBytes(), outcomeBytes: bytes(f.native) }) };
        await expect(f.app(port).generate(f.window.snapshotId, f.model, randomUUID(), undefined, { sourceSemanticPlan: reference })).rejects.toThrow();
      } else if (mode === 'request-digest') {
        f.receipt.requestDigest = hash('wrong request');
        const wrongBytes = bytes(f.receipt), port: SourcePlanArchivePort = { ...f.archive,
          read: () => ({ receiptBytes: wrongBytes, outcomeBytes: bytes(f.native) }) };
        reference = { ...reference, receiptRef: ref(wrongBytes) };
        await expect(f.app(port).generate(f.window.snapshotId, f.model, randomUUID(), undefined, { sourceSemanticPlan: reference })).rejects.toThrow();
      } else await expect(f.app().generate(f.window.snapshotId, f.model, randomUUID(), undefined, { sourceSemanticPlan: reference })).rejects.toThrow();
      expect(f.effects).not.toHaveBeenCalled(); expect(f.ports.runs.listManifests()).toEqual([]);
    });

  it.each(['failed', 'cleanup', 'refusal', 'tools', 'incomplete', 'projection', 'exception'] as const)(
    'retains but never advances a %s native return', async mode => {
      const f = setup();
      if (mode === 'failed') f.native.outcome.result.ok = false;
      if (mode === 'refusal') Object.assign(f.native.outcome.result, { refusal: 'authored' });
      if (mode === 'tools') Object.assign(f.native.outcome.result, { toolCalls: [{ tool: 'authored' }] });
      if (mode === 'incomplete') f.native.outcome.result.stopReason = 'length';
      const outcome = mode === 'cleanup' ? { ...f.native.outcome, cleanupFailure: { diagnostic: 'authored' } }
        : mode === 'projection' ? { outcomeKind: 'model-port-projection', scope: 'authored-model-port/v1', result: { output: '{}', durationMs: 1 } }
          : mode === 'exception' ? { outcomeKind: 'exception', error: { representationKind: 'exception-diagnostic/v1', sourceType: 'string', name: null,
            message: 'authored', truncated: false, accessorsSkipped: false } } : f.native.outcome;
      f.setOutcomeBytes(bytes({ ...f.native, outcome }));
      const reference = { receiptId: f.receipt.receiptId, receiptRef: ref(f.receiptBytes()) };
      await expect(f.app().generate(f.window.snapshotId, f.model, randomUUID(), undefined, { sourceSemanticPlan: reference })).rejects.toThrow('complete successful native');
      expect(f.effects).not.toHaveBeenCalled(); expect(f.ports.runs.listManifests()).toEqual([]);
    });

  it('distinguishes source-plan quality rejection from corrupt UTF-8 without hiding either raw return', async () => {
    const f = setup(); f.plan.objects[0].anchors[0].quote = 'missing quote';
    f.native.outcome.result.output = JSON.stringify(f.plan); const reference = f.reseal();
    try { await f.app().generate(f.window.snapshotId, f.model, randomUUID(), undefined, { sourceSemanticPlan: reference }); throw new Error('Expected source plan validation failure.'); }
    catch (error) { expect(error).toBeInstanceOf(SourcePlanValidationError);
      expect((error as SourcePlanValidationError).assessment).toMatchObject({ status: 'rejected', rawOutput: f.native.outcome.result.output }); }
    f.setOutcomeBytes(Buffer.from([0xff]));
    const bad = { receiptId: reference.receiptId, receiptRef: ref(f.receiptBytes()) };
    await expect(f.app().generate(f.window.snapshotId, f.model, randomUUID(), undefined, { sourceSemanticPlan: bad })).rejects.not.toBeInstanceOf(SourcePlanValidationError);
    expect(f.effects).not.toHaveBeenCalled(); expect(f.ports.runs.listManifests()).toEqual([]);
  });

  it('keeps the research entry opt-in, exclusive, strict30-only and outside bounded retry', async () => {
    const f = setup(), options = { sourceSemanticPlan: f.reference }, app = f.app();
    const policy = boundedExtractionPolicy({ maxInvocations: 2, maxReasks: 1, maxTotalTokens: 2176, maxOutputTokens: 64, profileId: 'loopback-test/v1' });
    await expect(f.app(null).generate(f.window.snapshotId, f.model, randomUUID(), undefined, options)).rejects.toThrow('archive is unavailable');
    await expect(app.generate(f.window.snapshotId, f.model, randomUUID(), undefined, { ...options, coverageReview: { previousRunId: randomUUID() } })).rejects.toThrow('mutually exclusive');
    await expect(app.generate(f.window.snapshotId, f.model, randomUUID(), undefined, { ...options, policy })).rejects.toThrow('single-invocation');
    await expect(app.generate(f.window.snapshotId, f.model, randomUUID(), undefined, { ...options,
      promptProfile: { profileVersion: 'knowledge-extraction-prompt-profile/v1', promptVersion: 'knowledge-extraction-v35', system: STRICT_EXTRACTION_PROMPT } })).rejects.toThrow('unchanged strict30');
    const normal = await app.generate(f.window.snapshotId, f.model);
    expect(JSON.parse(f.effects.mock.calls.at(-1)![0].prompt)).not.toHaveProperty('sourcePlanResponse');
    expect(normal.committed).toHaveLength(1);
  });
});
