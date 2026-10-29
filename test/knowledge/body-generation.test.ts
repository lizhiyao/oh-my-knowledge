import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { FileGenerationJournalStore } from '../../src/knowledge/adapters/generation-journal-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { generationTextDigest } from '../../src/knowledge/extraction/body-generation-wire.js';
import type { KnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import type { GenerationProfile } from '../../src/knowledge/extraction/body-generation-wire.js';
import { configuredKnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import { createCodexArchiveProducer } from '../../src/executors/openai/codex/archive.js';
import type { ExecResult } from '../../src/executors/contracts/result.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'omk-body-generation-')); roots.push(root);
  const source = join(root, 'source.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha works only in this test; time and other environments remain unknown.' }] } }));
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root), entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const journals = new FileGenerationJournalStore(join(root, 'generation-journals'), root);
  const ports = { knowledge, entities, journals, evidence: new TraceEvidenceStore(join(root, 'sources'), root),
    tags: new FileKnowledgeTags(join(root, 'tags'), 'local', root), associations: new FileKnowledgeAssociationStore(join(root, 'associations'), 'local', knowledge, entities, root),
    id: randomUUID, now: () => '2026-10-28T00:00:00Z', hash: (v: unknown) => generationTextDigest(canonicalJson(v)), actor: { actorKind: 'human' as const, actorId: 'test-user' } };
  const app = new KnowledgeApplication(ports), window = app.capture({ path: source });
  const body = { responseKind: 'knowledge-body-generation', schemaVersion: 1, proposals: [{ proposalId: 'p1', title: 'Limited source report',
    segments: [{ segmentId: 's1', text: window.excerpts[0].text, evidence: [{ evidenceRef: window.excerpts[0].evidenceRef, quote: 'Alpha', occurrence: null, basis: 'source_assertion', interpretation: null }] }], organization: null, reuseRationale: 'Retain the limitation for later comparisons.' }] };
  const association = { responseKind: 'knowledge-association-generation', schemaVersion: 1, entities: [], mentions: [], associations: [{ bodyKey: 'b0', segmentEntityRefs: [], typedRelations: [], issues: ['No identity confirmation.'] }] };
  const invoke = vi.fn(async (profile: GenerationProfile, _input: string, _signal?: AbortSignal, gate?: () => void) => {
    gate?.();
    if (profile.stageKind === 'association') expect(app.list()).toHaveLength(1);
    return { outcomeKind: 'result' as const, result: { ok: true, output: JSON.stringify(profile.stageKind === 'body' ? body : association), runtime: { producer: 'authored-test-not-native' } } };
  });
  const model: KnowledgeGenerationModel = { executor: 'authored-test', model: 'fixture', timeoutMs: 300000,
    inspect: () => ({ producerId: 'authored-test', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024 * 1024, proof: { synthetic: true } }), invoke };
  return { root, app, ports, window, body, association, model, invoke };
}

describe('body-first generation and zero-model recovery', () => {
  it('uses the real producer gate/private cwd with complete originals and independent optional typed projections', async () => {
    const f = setup();
    const association = { ...f.association, entities: [{ entityId: 'e1', label: 'Alpha', description: 'The source test object, without version identity confirmation.',
      qualifiers: ['selected test only'], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null }],
    mentions: [{ mentionId: 'm1', entityId: 'e1', selection: { evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'Alpha', occurrence: null }, basis: 'explicit', rationale: 'Exact source mention.' }],
    associations: [{ bodyKey: 'b0', segmentEntityRefs: [{ segmentId: 's1', entityId: 'e1', mentionIds: ['m1'] }], typedRelations: [{ relationId: 'r1', segmentIds: ['s1'],
      subject: { entityId: 'e1' }, relation: 'works in the selected test', object: null, modality: 'capability', polarity: 'positive', evidence: [{ segmentId: 's1', evidenceIndex: 0 }], issues: [] }], issues: [] }] };
    const execute = vi.fn(async request => {
      expect(request.cwd).toMatch(/omk-knowledge-text-[A-Za-z0-9]{6}$/);
      expect(request.timeoutMs).toBe(300000); expect(request.effort).toBeUndefined();
      return { ok: true, output: JSON.stringify(request.outputFormat.name.includes('association') ? association : f.body),
        opaqueNestedField: { preserved: ['original', 1] } } as unknown as ExecResult;
    });
    const model = configuredKnowledgeGenerationModel('codex', 'fixture-model', createCodexArchiveProducer({}, () => execute));
    const result = await f.app.generate(f.window.snapshotId, model), detail = f.app.detail(result.journal.bodies[0].knowledgeId);
    expect(execute).toHaveBeenCalledTimes(2); expect(detail.derivedAssociations.revision?.typedRelations).toHaveLength(1);
    expect(detail.derivedCatalog).toMatchObject({ status: 'available', analysisId: result.journal.runId,
      revisionId: detail.derivedAssociations.revision?.entityAnalysisRef?.revisionId });
    expect(detail.derivedCatalog).not.toHaveProperty('source');
    expect(detail.derivedAssociations.revision?.segmentEntityRefs[0].entityId).not.toBe('e1');
    expect(f.app.inspect(result.journal.runId).nativeOutcomes[0].outcome).toMatchObject({ result: { opaqueNestedField: { preserved: ['original', 1] } } });
    const before = detail.revision.bodyDigest, projection = detail.derivedAssociations.revision!;
    const reviewed = f.app.reviewAssociations(detail.revision.knowledgeId, projection.revisionId, detail.derivedAssociations.generation, 'accept', 'explicit derived review');
    expect(reviewed.derivedAssociations.reviewStatus).toBe('accepted'); expect(reviewed.revision.bodyDigest).toBe(before);
    expect(reviewed.maintenance).toBeNull();
  });
  it('saves body before independent association, reopens exact originals and replays completed identity with zero calls', async () => {
    const f = setup(), runId = randomUUID(), result = await f.app.generate(f.window.snapshotId, f.model, runId);
    expect(result.journal.status).toBe('completed'); expect(f.invoke).toHaveBeenCalledTimes(2);
    const detail = f.app.detail(result.journal.bodies[0].knowledgeId);
    expect(detail.revision.content.segments[0].text).toBe(f.window.excerpts[0].text);
    expect(detail.revision.createdBy.actorKind).toBe('agent'); expect(detail.maintenance).toBeNull();
    expect(detail.derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending' });
    const reopened = createLocalKnowledgeApplication(f.root);
    expect(reopened.inspect(runId).nativeOutcomes).toHaveLength(2);
    expect(reopened.resume(runId)).toEqual(result);
    await f.app.generate(f.window.snapshotId, f.model, runId); expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(readdirSync(join(f.root, 'items'))).toHaveLength(1);
    expect(() => reopened.detail(detail.revision.knowledgeId, detail.revision.revisionId)).not.toThrow();
  });
  it('keeps a readable pending body when the association original fails and permits independent review/rebuild', async () => {
    const f = setup(); f.invoke.mockImplementationOnce(async (_p, _i, _s, gate) => { gate?.(); return { outcomeKind: 'result', result: { ok: true, output: JSON.stringify(f.body), runtime: { producer: 'authored-test-not-native' } } }; });
    f.invoke.mockImplementationOnce(async (_p, _i, _s, gate) => { gate?.(); return { outcomeKind: 'result', result: { ok: false, output: '', runtime: { producer: 'authored-test-not-native' } } }; });
    const result = await f.app.generate(f.window.snapshotId, f.model), ref = result.journal.bodies[0], detail = f.app.detail(ref.knowledgeId);
    expect(detail.derivedAssociations.status).toBe('failed'); expect(detail.revision.content.segments).toHaveLength(1);
    const bodyBytes = readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]));
    await f.app.rebuildAssociations(ref, f.model);
    expect(f.app.detail(ref.knowledgeId).derivedAssociations.status).toBe('available');
    expect(readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]))).toEqual(bodyBytes);
  });
  it('replays an acknowledged store write after journal interruption without an extra revision or native call', async () => {
    const f = setup(), write = f.ports.knowledge.write.bind(f.ports.knowledge);
    vi.spyOn(f.ports.knowledge, 'write').mockImplementationOnce((command, actor) => { write(command, actor); throw new Error('after body publish'); });
    const runId = randomUUID(); await expect(f.app.generate(f.window.snapshotId, f.model, runId)).rejects.toThrow('after body publish');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const restored = createLocalKnowledgeApplication(f.root).resume(runId);
    expect(restored.journal.bodies).toHaveLength(1); expect(restored.nextAction).toBe('continue_stage');
    expect(f.ports.knowledge.list()[0].revisions).toHaveLength(1);
    const completed = await f.app.continueStage(runId, restored.journal.generation, f.model);
    expect(completed.journal.status).toBe('completed'); expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('retains a real returned outcome under archive backpressure and stops before the next native stage', async () => {
    const f = setup(), id = randomUUID();
    vi.spyOn(f.ports.journals, 'archive').mockImplementationOnce(() => { throw new Error('archive disk failure'); });
    await expect(f.app.generate(f.window.snapshotId, f.model, id)).rejects.toThrow('archive disk failure');
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.app.list()).toHaveLength(0);
    const recovered = f.app.resume(id);
    expect(recovered.journal.bodies).toHaveLength(1); expect(recovered.nextAction).toBe('continue_stage');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const first = f.app.inspect(id).nativeOutcomes[0].outcome;
    expect(first?.outcomeKind).toBe('result');
    expect(first && 'result' in first && first.result.output).toBe(JSON.stringify(f.body));
  });
  it('never redispatches an unknown claimed phase, and refuses an unarchivable producer before writing a journal', async () => {
    const f = setup(), id = randomUUID();
    f.invoke.mockImplementationOnce(async (_p, _i, _s, gate) => { gate?.(); throw new Error('process lost native outcome'); });
    await expect(f.app.generate(f.window.snapshotId, f.model, id)).rejects.toThrow('lost native');
    expect(f.ports.journals.list().archiveChecks).toEqual([expect.objectContaining({ runId: id,
      archiveStatus: 'unknown', verificationStatus: 'not_verified' })]);
    const state = createLocalKnowledgeApplication(f.root).resume(id);
    expect(state.nextAction).toBe('outcome_unknown_do_not_redispatch');
    await expect(f.app.continueStage(id, state.journal.generation, f.model)).rejects.toThrow('never-claimed'); expect(f.invoke).toHaveBeenCalledTimes(1);
    const other = randomUUID(), inspect = f.model.inspect;
    f.model.inspect = () => ({ ...inspect({} as GenerationProfile, ''), maxOutcomeJsonBytes: 1024 ** 4 });
    await expect(f.app.generate(f.window.snapshotId, f.model, other)).rejects.toThrow('archive capacity');
    expect(f.ports.journals.read(other)).toBeUndefined();
  });
  it('keeps an unclaimed association eligible for explicit continuation after its permission gate refuses', async () => {
    const f = setup(), runId = randomUUID();
    await expect(f.app.generate(f.window.snapshotId, f.model, runId, undefined, { beforeDispatch(claim) {
      if (claim.stageKind === 'association') { expect(f.app.list()).toHaveLength(1); throw new Error('phase quota exhausted'); }
    } })).rejects.toThrow('phase quota exhausted');
    const read = f.app.inspect(runId); expect(read.journal.stages.at(-1)?.state).toBe('prepared');
    expect(f.ports.journals.list().archiveChecks.at(-1)).toMatchObject({ archiveStatus: 'not_recorded', verificationStatus: 'not_verified' });
    expect(read.nativeOutcomes.filter(o => o.outcome)).toHaveLength(1);
    expect(f.app.resume(runId).nextAction).toBe('continue_stage');
    const result = await f.app.continueStage(runId, read.journal.generation, f.model);
    expect(result.journal.status).toBe('completed');
  });
  it('reports legacy runs unsupported and refuses corrupt archived originals instead of presenting completed success', async () => {
    const f = setup(), result = await f.app.generate(f.window.snapshotId, f.model), id = randomUUID();
    mkdirSync(join(f.root, 'extraction-runs'));
    writeFileSync(join(f.root, 'extraction-runs', `${id}.json`), JSON.stringify({ runKind: 'knowledge-extraction-run', schemaVersion: 5 }));
    expect(f.app.runs().unsupported).toMatchObject([{ runId: id, schemaStatus: 'unsupported' }]);
    expect(() => f.app.resume(id)).toThrow('knowledge_storage_unsupported');
    const stage = result.journal.stages[0], path = join(f.root, 'generation-journals', 'outcomes', result.journal.runId, `${stage.invocationId}.json`);
    const original = JSON.parse(readFileSync(path, 'utf8')); original.outcome.result.output = 'altered'; writeFileSync(path, JSON.stringify(original));
    expect(() => createLocalKnowledgeApplication(f.root).resume(result.journal.runId)).toThrow('digest mismatch');
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('inventories journal state without decoding originals, and reports unavailable journals and archive metadata separately', async () => {
    const f = setup(), result = await f.app.generate(f.window.snapshotId, f.model);
    const decode = vi.spyOn(f.ports.journals, 'outcome');
    const first = f.ports.journals.list();
    expect(decode).not.toHaveBeenCalled();
    expect(first.current).toEqual([result.journal]);
    expect(first.archiveChecks).toEqual(result.journal.stages.map(stage => ({ runId: result.journal.runId,
      invocationId: stage.invocationId, archiveStatus: 'present', verificationStatus: 'not_verified',
      reason: 'File metadata observed; content, digest and native binding have not been verified.' })));
    const brokenId = randomUUID();
    writeFileSync(join(f.root, 'generation-journals', `${brokenId}.json`), '{broken');
    const invalidName = 'not-a-run'; writeFileSync(join(f.root, 'generation-journals', `${invalidName}.json`), '{}');
    const mismatchedId = randomUUID(); writeFileSync(join(f.root, 'generation-journals', `${mismatchedId}.json`), JSON.stringify(result.journal));
    const unsupportedId = randomUUID(); writeFileSync(join(f.root, 'generation-journals', `${unsupportedId}.json`), JSON.stringify({ storeKind: 'knowledge-generation-journal', schemaVersion: 2 }));
    const missing = result.journal.stages[0], altered = result.journal.stages[1];
    rmSync(join(f.root, 'generation-journals', 'outcomes', result.journal.runId, `${missing.invocationId}.json`));
    writeFileSync(join(f.root, 'generation-journals', 'outcomes', result.journal.runId, `${altered.invocationId}.json`), '{}');
    const observed = f.ports.journals.list();
    expect(decode).not.toHaveBeenCalled();
    expect(observed.current).toEqual([result.journal]);
    expect(observed.unavailable).toEqual(expect.arrayContaining([
      { runId: brokenId, reason: 'unreadable', detail: 'Generation journal is invalid or unreadable.' },
      { runId: mismatchedId, reason: 'unreadable', detail: 'Generation journal is invalid or unreadable.' },
      { runId: invalidName, reason: 'invalid_identity', detail: 'Generation journal filename is not a run identity.' },
    ]));
    expect(observed.unsupported).toContainEqual({ runId: unsupportedId, schemaStatus: 'unsupported', reason: 'Generation journal requires a matching workflow version.' });
    expect(observed.archiveChecks).toEqual([
      expect.objectContaining({ invocationId: missing.invocationId, archiveStatus: 'missing', verificationStatus: 'not_verified' }),
      expect.objectContaining({ invocationId: altered.invocationId, archiveStatus: 'invalid', verificationStatus: 'not_verified' }),
    ]);
    expect(() => f.ports.journals.read(result.journal.runId)).toThrow('missing');
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('does not label same-size archive content as verified or weaken full inspection and recovery checks', async () => {
    const f = setup(), result = await f.app.generate(f.window.snapshotId, f.model);
    const stage = result.journal.stages[0], path = join(f.root, 'generation-journals', 'outcomes', result.journal.runId, `${stage.invocationId}.json`);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('knowledge-generation-native', 'knowledge-generation-broken'));
    expect(f.ports.journals.list().archiveChecks[0]).toMatchObject({ archiveStatus: 'present', verificationStatus: 'not_verified' });
    expect(() => f.app.inspect(result.journal.runId)).toThrow('digest mismatch');
    expect(() => f.app.resume(result.journal.runId)).toThrow('digest mismatch');
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('validates full replacement inline evidence before revise and makes old derived projection stale', async () => {
    const f = setup(), result = await f.app.generate(f.window.snapshotId, f.model), ref = result.journal.bodies[0], detail = f.app.detail(ref.knowledgeId);
    const draft = { title: detail.revision.title, content: structuredClone(detail.revision.content), reuseRationale: detail.revision.reuseRationale };
    draft.content.segments[0].evidence[0].selection.quote = 'wrong';
    expect(() => f.app.revise(ref.knowledgeId, ref.revisionId, detail.history.generation, draft, 'invalid edit')).toThrow('evidence');
    draft.content = detail.revision.content;
    const next = f.app.revise(ref.knowledgeId, ref.revisionId, detail.history.generation, draft, 'explicit new revision');
    expect(next.derivedAssociations.status).toBe('stale'); expect(next.maintenance).toBeNull();
  });
});
