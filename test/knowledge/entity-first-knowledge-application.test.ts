import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication, type KnowledgeApplicationPorts } from '../../src/knowledge/application/application.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { STRICT_EXTRACTION_PROMPT } from '../../src/knowledge/extraction/strict-prompt.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../../src/knowledge/extraction/model-wire.js';
import { boundKnowledgeExecution, boundKnowledgeRequestDigest, BoundKnowledgeReceiptSchema,
  type BoundKnowledgeReceipt, type BoundKnowledgeArchivePort } from '../../src/knowledge/extraction/bound-knowledge-evidence.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';
import { buildEntityFirstBoundKnowledge } from '../../scripts/bench/assets/entity-first-bound-knowledge-v1/profile.js';
import { nativeStudyFixture, studyNativeResult } from './extraction-study-fixtures.js';
import { wireModelWindow } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const ref = (value: Uint8Array) => ({ bytes: value.byteLength, digest: hash(value) });
const profile = buildEntityFirstBoundKnowledge({
  baselineSystem: STRICT_EXTRACTION_PROMPT, wireId: WINDOW_EXTRACTION_WIRE_ID,
  rules: readFileSync(new URL('../../scripts/bench/assets/entity-evidence-semantics-v1/rules.txt', import.meta.url), 'utf8'),
  suffix: readFileSync(new URL('../../scripts/bench/assets/entity-task-only-ablation-v1/task-suffix.txt', import.meta.url), 'utf8'),
  manifest: JSON.parse(readFileSync(new URL('../../scripts/bench/assets/entity-first-bound-knowledge-v1/manifest.json', import.meta.url), 'utf8')),
}).candidate;

async function setup(entityChange?: (value: ReturnType<typeof wireModelWindow>) => void, entityOnly = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-entity-first-'))); roots.push(root);
  const f = nativeStudyFixture(root, (_index, original) => {
    const output = JSON.parse(original) as ReturnType<typeof wireModelWindow>;
    if (entityOnly) output.proposals = [];
    entityChange?.(output);
    return studyNativeResult(JSON.stringify(output));
  });
  const ports: KnowledgeApplicationPorts = {
    runs: f.ports.runs, actor: f.ports.actor, hash: value => hash(canonicalJson(value)), id: randomUUID,
    now: () => '2020-02-01T00:00:00Z',
    evidence: new TraceEvidenceStore(join(f.workspace, 'sources'), f.workspace),
    entities: new FileEntityAnalysisStore(join(f.workspace, 'entities'), f.workspace),
    knowledge: new FileKnowledgeStore(join(f.workspace, 'items'), 'local', f.workspace),
    tags: new FileKnowledgeTags(join(f.workspace, 'tags'), 'local', f.workspace),
  };
  const app = new KnowledgeApplication(ports), model = f.model(), window = f.corpus.cases[0].window, runId = randomUUID();
  const run = await app.generate(window.snapshotId, model, runId, undefined, { promptProfile: profile });
  return { ...f, app, ports, model, window, runId, run };
}

function knowledgeReturn(f: Awaited<ReturnType<typeof setup>>, change?: (response: Record<string, unknown>) => void) {
  const context = f.app.boundKnowledgeContext(f.runId, f.model, profile);
  const execution = boundKnowledgeExecution(context.window, context.catalog, f.model);
  // Authored K data, not a generated answer or semantic acceptance result.
  const proposal = structuredClone(wireModelWindow().proposals[0]);
  const entityIds = new Map([['project', context.catalog.entities[0].entityId], ['tool', context.catalog.entities[1].entityId]]);
  const mentionIds = new Map([['m1', context.catalog.mentions[0].mentionId], ['m2', context.catalog.mentions[1].mentionId]]);
  proposal.entityIds = proposal.entityIds.map(id => entityIds.get(id)!);
  proposal.mentionIds = proposal.mentionIds.map(id => mentionIds.get(id)!);
  for (const statement of proposal.draft.content.statements) {
    statement.subject.entityId = entityIds.get(statement.subject.entityId)!;
    if (statement.object) statement.object.entityId = entityIds.get(statement.object.entityId)!;
  }
  for (const link of proposal.draft.evidence) link.evidenceRef = context.window.excerpts[0].evidenceRef;
  for (const citation of proposal.citations) citation.selection.evidenceRef = context.window.excerpts[0].evidenceRef;
  const response: Record<string, unknown> = { responseKind: 'bound-knowledge', schemaVersion: 1,
    binding: JSON.parse(execution.request.input).binding, proposals: [proposal], catalogGaps: [] };
  change?.(response);
  const receiptId = randomUUID(), attemptId = randomUUID();
  const native = { archiveKind: 'knowledge-bound-knowledge-native', schemaVersion: 1, receiptId, attemptId,
    outcome: { outcomeKind: 'result', result: studyNativeResult(JSON.stringify(response)) } };
  const producer = createOpenAiArchiveProducer({ NODE_ENV: 'test', OPENAI_API_KEY: 'authored-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' });
  const receipt: BoundKnowledgeReceipt = { receiptKind: 'knowledge-bound-knowledge-receipt', schemaVersion: 1,
    receiptId, attemptId, binding: JSON.parse(execution.request.input).binding, request: execution.request,
    producer: BoundKnowledgeReceiptSchema.shape.producer.parse(producer.inspect(f.model.executor, execution.input)),
    requestDigest: '', nativeRef: ref(bytes(native)), startedAt: '2020-02-01T00:00:01Z', finishedAt: '2020-02-01T00:00:02Z' };
  let nativeBytes: Buffer, receiptBytes: Buffer;
  const reseal = () => {
    nativeBytes = bytes(native); receipt.nativeRef = ref(nativeBytes);
    receipt.requestDigest = boundKnowledgeRequestDigest(receipt); receiptBytes = bytes(receipt);
    return { receiptId, receiptRef: ref(receiptBytes) };
  };
  const reference = reseal();
  const read = vi.fn(() => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(nativeBytes) }));
  const archive: BoundKnowledgeArchivePort = { read, inspect: (...args) => producer.inspect(...args) };
  const app = new KnowledgeApplication({ ...f.ports, boundKnowledgeArchive: archive });
  return { app, context, reference, read, archive, native, receipt, reseal, response,
    receiptBytes: () => Buffer.from(receiptBytes), nativeBytes: () => Buffer.from(nativeBytes) };
}

describe('entity-first / bound knowledge application (authored native returns)', () => {
  it('keeps the actual initial E revision and both raw returns separate, with restart-safe K writes', async () => {
    const f = await setup(), k = knowledgeReturn(f), beforeRun = f.ports.runs.read(f.runId);
    const beforeEntities = f.ports.entities.read(f.runId), receiptBytes = k.receiptBytes(), nativeBytes = k.nativeBytes();
    const result = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
    expect(result.admissionStatus).toBe('admitted'); expect(result.semanticStatus).toBe('not_reviewed');
    expect(result.committed).toHaveLength(1);
    const { knowledgeId, revisionId } = result.committed[0];
    const detail = k.app.detail(knowledgeId, revisionId);
    expect(detail.grounding.entityAnalysisRef).toEqual({ analysisId: f.runId, revisionId: beforeEntities.revisions[0].revisionId });
    expect(detail.grounding.sourceBindings[0]).toMatchObject({ snapshotId: f.window.snapshotId, sourceVersion: f.window.sourceVersion });
    expect(detail.revision.entities.map(entity => entity.entityId)).toEqual(k.context.catalog.entities.map(entity => entity.entityId));
    expect(detail.revision.createdAt).toBe(k.receipt.finishedAt);
    const restarted = new KnowledgeApplication({ ...f.ports, boundKnowledgeArchive: k.archive,
      id: () => { throw new Error('Import cannot allocate fresh identities.'); },
      now: () => { throw new Error('Import cannot change native-bound birth time.'); } });
    expect(restarted.importBoundKnowledge(f.runId, f.model, profile, k.reference).committed).toEqual(result.committed);
    expect(f.ports.knowledge.read(knowledgeId).generation).toBe(1);
    expect(f.ports.entities.read(f.runId)).toEqual(beforeEntities);
    expect(f.ports.runs.read(f.runId)).toEqual(beforeRun);
    expect(k.receiptBytes()).toEqual(receiptBytes); expect(k.nativeBytes()).toEqual(nativeBytes);
    expect(f.effects).toHaveBeenCalledTimes(1); expect(k.app.runs()).toHaveLength(1);
    expect(beforeRun.intents).toEqual([]); expect(JSON.parse(beforeRun.rawOutput!).proposals).toEqual([]);
    expect(k.native.outcome.result.output).not.toContain('"entities":');
  });

  it.each(['lost-ack', 'abort'] as const)('resumes partial K publication after %s without overwriting E or redispatching', async mode => {
    const f = await setup(), k = knowledgeReturn(f, response => {
      const proposals = response.proposals as Record<string, unknown>[];
      proposals.push({ ...structuredClone(proposals[0]), proposalId: 'second-proposal' });
    });
    const before = f.ports.entities.read(f.runId), controller = new AbortController();
    const write = f.ports.knowledge.write.bind(f.ports.knowledge);
    let interrupted = false;
    vi.spyOn(f.ports.knowledge, 'write').mockImplementation((...args) => {
      const result = write(...args);
      if (!interrupted) { interrupted = true; if (mode === 'lost-ack') throw new Error('Authored lost acknowledgement.'); controller.abort(); }
      return result;
    });
    expect(() => k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference, controller.signal)).toThrow();
    expect(k.app.list()).toHaveLength(1);
    const resumed = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
    expect(resumed.committed).toHaveLength(2); expect(k.app.list()).toHaveLength(2);
    for (const item of resumed.committed) expect(f.ports.knowledge.read(item.knowledgeId).generation).toBe(1);
    expect(f.ports.entities.read(f.runId)).toEqual(before); expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it('uses the pinned initial revision after a later entity correction', async () => {
    const f = await setup(), k = knowledgeReturn(f), original = f.app.entities(f.runId);
    const corrected = structuredClone({ entities: original.revision.entities, mentions: original.revision.mentions });
    corrected.entities[0].description = 'Authored later correction; never a semantic validation claim.';
    f.app.correctEntities(f.runId, original.revision.revisionId, original.history.generation, corrected, 'Authored later revision.');
    expect(f.app.entities(f.runId).revision.revisionId).not.toBe(original.revision.revisionId);
    const result = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
    expect(result.entityAnalysisRef.revisionId).toBe(original.revision.revisionId);
    expect(k.app.detail(result.committed[0].knowledgeId).grounding.entityAnalysisRef).toEqual(result.entityAnalysisRef);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it('preserves the original E evidence when the K native task fails', async () => {
    const f = await setup(), k = knowledgeReturn(f), before = f.ports.entities.read(f.runId);
    k.native.outcome.result.ok = false; const reference = k.reseal();
    expect(() => k.app.importBoundKnowledge(f.runId, f.model, profile, reference)).toThrow('complete successful native');
    expect(k.app.list()).toEqual([]); expect(f.ports.entities.read(f.runId)).toEqual(before);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it('never repairs invalid K citations or pretends source-grounded catalog gaps are full success', async () => {
    const f = await setup(), k = knowledgeReturn(f, response => {
      const proposal = (response.proposals as ReturnType<typeof wireModelWindow>['proposals'])[0];
      proposal.citations[0].selection.quote = 'not in this authored source';
      response.catalogGaps = [{ gapId: 'missing-object', reason: 'Authored unreviewed model gap, not a host classification.',
        anchors: [{ evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'Alpha', occurrence: null }] }];
    });
    const result = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
    expect(result.admissionStatus).toBe('partial'); expect(result.committed).toEqual([]);
    expect(result.evidence.rawOutput).toContain('not in this authored source');
    expect(result.evidence.checked).toMatchObject({ status: 'checked', catalogGaps: [{ gapId: 'missing-object' }] });
    expect(k.app.list()).toEqual([]); expect(f.ports.entities.read(f.runId).revisions).toHaveLength(1);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it('rejects a conflicting replay instead of generating duplicate knowledge identities', async () => {
    const f = await setup(), k = knowledgeReturn(f);
    const first = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
    k.receipt.finishedAt = '2020-02-01T00:00:03Z'; const changed = k.reseal();
    expect(() => k.app.importBoundKnowledge(f.runId, f.model, profile, changed)).toThrow();
    expect(k.app.list()).toHaveLength(1); expect(f.ports.knowledge.read(first.committed[0].knowledgeId).generation).toBe(1);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it('rejects a K task timed before E completion without writing or calling a model', async () => {
    const f = await setup(), k = knowledgeReturn(f);
    k.receipt.startedAt = '2020-01-31T23:59:59Z'; const reference = k.reseal();
    expect(() => k.app.importBoundKnowledge(f.runId, f.model, profile, reference)).toThrow('predates');
    expect(k.app.list()).toEqual([]); expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it.each(['profile', 'configuration', 'forged-analysis', 'source-unavailable'] as const)(
    'refuses %s E provenance before reading the K archive', async mode => {
      const f = await setup(), k = knowledgeReturn(f);
      let model = f.model, expected = profile;
      if (mode === 'profile') expected = { ...profile, system: profile.system + '\n' };
      if (mode === 'configuration') model = { ...f.model, maxOutputTokens: 65 };
      if (mode === 'source-unavailable') f.app.deleteSource(f.window.snapshotId);
      if (mode === 'forged-analysis') {
        const forged = structuredClone(f.ports.runs.read(f.runId));
        forged.entityAnalysis!.revision.entities[0].description = 'Forged field not present in initial store.';
        vi.spyOn(f.ports.runs, 'read').mockReturnValueOnce(forged);
      }
      expect(() => k.app.importBoundKnowledge(f.runId, model, expected, k.reference)).toThrow();
      expect(k.read).not.toHaveBeenCalled(); expect(k.app.list()).toEqual([]); expect(f.effects).toHaveBeenCalledTimes(1);
    });

  it('does not install this workflow on ordinary hosts or consume rejected/full-business E predecessors', async () => {
    const f = await setup();
    expect(() => f.app.importBoundKnowledge(f.runId, f.model, profile, { receiptId: randomUUID(), receiptRef: ref(bytes({})) }))
      .toThrow('archive unavailable');
    const invalid = await setup(value => { value.mentions[0].selection.quote = 'invalid source location'; });
    expect(() => invalid.app.boundKnowledgeContext(invalid.runId, invalid.model, profile)).toThrow('entity-only predecessor');
    const full = await setup(undefined, false);
    expect(() => full.app.boundKnowledgeContext(full.runId, full.model, profile)).toThrow('entity-only predecessor');
    expect(f.effects).toHaveBeenCalledTimes(1); expect(invalid.effects).toHaveBeenCalledTimes(1); expect(full.effects).toHaveBeenCalledTimes(1);
  });
});
