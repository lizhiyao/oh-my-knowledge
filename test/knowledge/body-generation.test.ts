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
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import type { GenerationJournal, GenerationStage } from '../../src/knowledge/extraction/generation-journal.js';
import type { KnowledgeWrite } from '../../src/knowledge/store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { captureTraceFixture, sourceRef } from '../helpers/knowledge-source.js';
import { generationSourceInput, generationImportRunId, SOURCE_GENERATION_INPUT_VERSION } from '../../src/knowledge/extraction/source-input.js';
import { sourceSetPreimage } from '../../src/knowledge/sources.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE, generationTextDigest } from '../../src/knowledge/extraction/body-generation-wire.js';
import { KNOWLEDGE_RECORD_SCOPE_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';
import type { KnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import type { GenerationProfile } from '../../src/knowledge/extraction/body-generation-wire.js';
import { configuredKnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import { createCodexArchiveProducer } from '../../src/executors/openai/codex/archive.js';
import type { ExecResult } from '../../src/executors/contracts/result.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(splitMentionContext = false) {
  const root = mkdtempSync(join(tmpdir(), 'omk-body-generation-')); roots.push(root);
  const source = join(root, 'source.jsonl');
  const messages = splitMentionContext ? ['Alpha is the source object.', 'It works only in this test; time and other environments remain unknown.']
    : ['Alpha works only in this test; time and other environments remain unknown.'];
  writeFileSync(source, messages.map(text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })).join('\n'));
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root), entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const journals = new FileGenerationJournalStore(join(root, 'generation-journals'), root);
  const ports = { knowledge, entities, journals, sources: new FileSourceStore(join(root, 'sources'), root),
    tags: new FileKnowledgeTags(join(root, 'tags'), 'local', root), associations: new FileKnowledgeAssociationStore(join(root, 'associations'), 'local', knowledge, entities, root),
    id: randomUUID, now: () => '2026-10-28T00:00:00Z', hash: (v: unknown) => generationTextDigest(canonicalJson(v)), actor: { actorKind: 'human' as const, actorId: 'test-user' } };
  const app = new KnowledgeApplication(ports), window = captureTraceFixture(root, { path: source });
  const body = { responseKind: 'knowledge-body-generation', schemaVersion: 2, proposals: [{ proposalId: 'p1', title: 'Limited source report', requiredContexts: [],
    segments: [{ segmentId: 's1', text: window.excerpts[0].text, evidence: [{ evidenceRef: window.excerpts[0].evidenceRef, quote: 'Alpha', contextBefore: null, contextAfter: null, basis: 'source_assertion', interpretation: null }] }], organization: null, reuseRationale: 'Retain the limitation for later comparisons.' }] };
  const association = { responseKind: 'knowledge-association-generation', schemaVersion: 3, catalogs: [{ sourceKey: 's0', entities: [] }], associations: [{ bodyKey: 'b0',
    segmentDecisions: [{ segmentId: 's1', decisionKind: 'abstained', entityRefs: [], reason: 'No identity confirmation.' }], typedRelations: [], issues: ['No identity confirmation.'] }] };
  const invoke = vi.fn(async (profile: GenerationProfile, _input: string, _signal?: AbortSignal, gate?: () => void) => {
    gate?.();
    if (profile.stageKind === 'association') expect(app.list()).toHaveLength(1);
    return { outcomeKind: 'result' as const, result: { ok: true, output: JSON.stringify(profile.stageKind === 'body' ? body : association), runtime: { producer: 'authored-test-not-native' } } };
  });
  const model: KnowledgeGenerationModel = { executor: 'authored-test', model: 'fixture', timeoutMs: 300000,
    inspect: () => ({ producerId: 'authored-test', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024 * 1024, proof: { synthetic: true } }), invoke };
  return { root, app, ports, window, body, association, model, invoke };
}

async function generateFixture(f: Pick<ReturnType<typeof setup>, 'app' | 'window'>, model: KnowledgeGenerationModel, runId?: string, signal?: AbortSignal, options: Parameters<KnowledgeApplication['generate']>[4] = {}) {
  const prepared = f.app.prepareGeneration([sourceRef(f.window)], model, runId, signal);
  const result = await f.app.generate([sourceRef(f.window)], model, prepared.journal.runId, signal, { ...options, confirmedRequestDigest: prepared.journal.stages[0].requestDigest });
  const stage = result.journal.stages.at(-1)!;
  return stage.stageKind === 'association' && stage.state === 'prepared' && !signal?.aborted
    ? f.app.continueStage(result.journal.runId, result.journal.generation, model, signal, { ...options, confirmedRequestDigest: stage.requestDigest }) : result;
}
async function rebuildFixture(f: Pick<ReturnType<typeof setup>, 'app'>, ref: Parameters<KnowledgeApplication['rebuildAssociations']>[0], model: KnowledgeGenerationModel, runId?: string, signal?: AbortSignal) {
  const prepared = f.app.prepareAssociationRebuild(ref, model, runId, signal);
  return f.app.rebuildAssociations(ref, model, prepared.journal.runId, signal, { confirmedRequestDigest: prepared.journal.stages[0].requestDigest });
}

/** Authored prior-profile states use current public storage, never an old-output compatibility reader. */
function legacyRun(f: ReturnType<typeof setup>, state: 'prepared' | 'claimed' | 'archived' | 'body_completed' | 'prepared_writes' | 'completed' | 'failed') {
  const runId = randomUUID(), invocationId = randomUUID(), at = f.ports.now();
  const sourceSetId = generationTextDigest(canonicalJson(sourceSetPreimage([sourceRef(f.window)])));
  const input = canonicalJson({ inputVersion: SOURCE_GENERATION_INPUT_VERSION, sourceSetId, sources: [generationSourceInput(f.window, 0)] });
  const system = 'Authored prior generation profile fixture; not a native observation.', wireSchema = { type: 'object', authoredPriorProtocol: true };
  const profileId = generationTextDigest('authored-prior-body-profile'), wireId = generationTextDigest(canonicalJson(wireSchema));
  const producer = f.model.inspect(BODY_GENERATION_PROFILE, input);
  const stage: GenerationStage = { stageKind: 'body', invocationId, state: state === 'prepared' ? 'prepared' : 'claimed',
    profileId, promptVersion: 'knowledge-body-generation/v3', system, wireId, wireSchema, input, inputDigest: generationTextDigest(input),
    requestDigest: generationTextDigest(canonicalJson({ executor: f.model.executor, model: f.model.model, timeoutMs: f.model.timeoutMs,
      profileId, system, wireId, input, producer })), producer, committed: 0, issues: [] };
  let journal: GenerationJournal = f.ports.journals.write({ storeKind: 'knowledge-generation-journal', schemaVersion: 3, workflowId: 'knowledge-body-first/v3', inputVersion: SOURCE_GENERATION_INPUT_VERSION, sourceSetId,
    runId, generation: 1, mode: 'generate', status: 'active', createdAt: at, actor: f.ports.actor,
    sources: [{ snapshotId: f.window.snapshotId, sourceVersion: f.window.sourceVersion, sourceDigest: generationTextDigest(canonicalJson(f.window)) }],
    executor: f.model.executor, model: f.model.model, timeoutMs: f.model.timeoutMs, bodies: [], stages: [stage] }, 0);
  const actor = { actorKind: 'agent' as const, actorId: `extractor:${f.model.executor}`, executionRef: `${runId}:${invocationId}` };
  const draft = { title: 'Prior profile source report', reuseRationale: 'Keep the recorded test limitation.', content: { segments: [{ segmentId: 's1',
    text: f.window.excerpts[0].text, evidence: [{ source: { snapshotId: f.window.snapshotId, sourceVersion: f.window.sourceVersion },
      selection: { evidenceRef: f.window.excerpts[0].evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'source_assertion' as const }] }] } };
  const knowledgeId = randomUUID();
  const write: Extract<KnowledgeWrite, { commandKind: 'append_revision' }> = { commandKind: 'append_revision', requestId: randomUUID(),
    knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null, revision: { ...draft, knowledgeId, revisionId: randomUUID(),
      bodyDigest: knowledgeBodyDigest(draft), observationRefs: [f.window.snapshotId], derivations: [], createdAt: at, createdBy: actor,
      revisedAt: at, revisedBy: actor, revisionReason: 'Authored fixed prior-profile intent.' } };
  const oldProposal = { proposalId: 'p1', title: draft.title, segments: [{ segmentId: 's1', text: draft.content.segments[0].text,
    evidence: [{ evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'Alpha', occurrence: null, basis: 'source_assertion', interpretation: null }] }],
  organization: null, reuseRationale: draft.reuseRationale };
  const outcome = { outcomeKind: 'result' as const, result: { ok: state !== 'failed', output: JSON.stringify({ responseKind: 'knowledge-body-generation',
    schemaVersion: 1, proposals: state === 'completed' ? [] : [oldProposal] }), authoredPriorProfileFixture: true } };
  const journalPath = join(f.root, 'generation-journals', `${runId}.json`), paths = [journalPath];
  if (state !== 'prepared') {
    const outcomeRef = f.ports.journals.archive(journal, stage, outcome);
    paths.push(join(f.root, 'generation-journals', 'outcomes', runId, `${invocationId}.json`));
    if (state !== 'claimed') {
      const hasBody = state === 'body_completed';
      if (hasBody) f.ports.knowledge.write(write, actor);
      const updated: GenerationStage = { ...stage, state: state === 'body_completed' ? 'completed' : state, outcomeRef,
        ...(['prepared_writes', 'body_completed', 'completed'].includes(state) ? { bodyWrites: state === 'completed' ? [] : [write] } : {}),
        committed: hasBody ? 1 : 0, issues: state === 'failed' ? ['Authored prior-profile failure.'] : [] };
      journal = f.ports.journals.write({ ...journal, generation: 2, stages: [updated], bodies: hasBody ? [knowledgeBodyRef(write.revision)] : [],
        status: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'active' }, 1);
      if (hasBody) paths.push(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]));
    }
  }
  return { journal, outcome, write, paths };
}

async function twoSourceSetup() {
    const f = setup(), initial = await generateFixture(f, f.model), first = f.app.detail(initial.journal.bodies[0].knowledgeId);
    const secondPath = join(f.root, 'second-source.jsonl');
    writeFileSync(secondPath, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha has a separate context; identity across windows is unknown.' }] } }));
    const second = captureTraceFixture(f.root, { path: secondPath });
    const draft = { title: first.revision.title, content: { segments: [...first.revision.content.segments,
      { segmentId: 's2', text: second.excerpts[0].text, evidence: [{ source: { snapshotId: second.snapshotId, sourceVersion: second.sourceVersion },
        selection: { evidenceRef: second.excerpts[0].evidenceRef, start: second.excerpts[0].text.indexOf('Alpha'), end: second.excerpts[0].text.indexOf('Alpha') + 5, quote: 'Alpha' }, basis: 'source_assertion' as const }] }] },
      reuseRationale: first.revision.reuseRationale };
    const detail = f.app.revise(first.revision.knowledgeId, first.revision.revisionId, first.history.generation, draft, 'Explicit two-source body revision');
    const bodyBytes = readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]));
    const catalog = (sourceKey: string, evidenceRef: string) => ({ sourceKey, entities: [{ entityId: 'e1', label: 'Alpha', description: 'Window-local source object; cross-window identity unconfirmed.',
      qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: ['Cross-window identity is unknown.'], referentKind: 'object', componentLink: null, collectionLink: null,
      mentions: [{ mentionKey: 'm1', selection: { evidenceRef, quote: 'Alpha', contextBefore: null, contextAfter: null }, basis: 'explicit', rationale: 'Exact local mention.' }] }] });
    const output = { responseKind: 'knowledge-association-generation', schemaVersion: 3,
      catalogs: [f.window, second].sort((a, b) => a.snapshotId.localeCompare(b.snapshotId)).map((source, index) => catalog(`s${index}`, source.excerpts[0].evidenceRef)),
      associations: [{ bodyKey: 'b0', segmentDecisions: [
        { segmentId: 's1', decisionKind: 'mapped', entityRefs: [{ sourceKey: f.window.snapshotId < second.snapshotId ? 's0' : 's1', entityId: 'e1', mentionKeys: ['m1'] }], reason: 'First exact source.' },
        { segmentId: 's2', decisionKind: 'mapped', entityRefs: [{ sourceKey: f.window.snapshotId < second.snapshotId ? 's1' : 's0', entityId: 'e1', mentionKeys: ['m1'] }], reason: 'Second exact source.' }], typedRelations: null, issues: ['Distinct source catalogs are not an identity merge.'] }] };
  return { f, detail, second, bodyBytes, output };
}

describe('body-first generation and zero-model recovery', () => {
  it('prepares the complete exact request without calling a model, then confirms body and association separately', async () => {
    const f = setup(), refs = [sourceRef(f.window)], prepared = f.app.prepareGeneration(refs, f.model);
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.app.list()).toEqual([]);
    expect(prepared.journal).toMatchObject({ schemaVersion: 3, workflowId: 'knowledge-body-first/v3', inputVersion: SOURCE_GENERATION_INPUT_VERSION,
      runId: generationImportRunId(prepared.journal.sourceSetId), stages: [{ state: 'prepared', system: BODY_GENERATION_PROFILE.system }] });
    const input = JSON.parse(prepared.journal.stages[0].input);
    expect(input).toMatchObject({ inputVersion: SOURCE_GENERATION_INPUT_VERSION, sourceSetId: prepared.journal.sourceSetId,
      sources: [{ sourceKey: 's0', source: { ...refs[0], sourceKind: 'agent_trace' }, excerpts: f.window.excerpts }] });
    expect(prepared.journal.stages[0].input).not.toContain(f.root); expect(input.sources[0]).not.toHaveProperty('rawUnits');
    for (const confirmedRequestDigest of [undefined, `sha256:${'0'.repeat(64)}`]) {
      await expect(f.app.generate(refs, f.model, undefined, undefined, { confirmedRequestDigest })).rejects.toThrow('Confirm the exact');
      expect(f.invoke).not.toHaveBeenCalled(); expect(f.app.inspect(prepared.journal.runId).journal).toEqual(prepared.journal);
    }
    const body = await f.app.generate(refs, f.model, undefined, undefined, { confirmedRequestDigest: prepared.journal.stages[0].requestDigest });
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(body.journal.bodies).toHaveLength(1);
    expect(body).toMatchObject({ nextAction: 'continue_stage', journal: { status: 'active', stages: [{ state: 'completed' }, { stageKind: 'association', state: 'prepared' }] } });
    await expect(f.app.continueStage(body.journal.runId, body.journal.generation, f.model, undefined,
      { confirmedRequestDigest: prepared.journal.stages[0].requestDigest })).rejects.toThrow('Confirm the exact');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const done = await f.app.continueStage(body.journal.runId, body.journal.generation, f.model, undefined,
      { confirmedRequestDigest: body.journal.stages[1].requestDigest });
    expect(done.journal.status).toBe('completed'); expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(await f.app.generate(refs, f.model)).toEqual(f.app.resume(done.journal.runId)); expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('keeps a failed default import idempotent and requires a new explicit run for a new attempt', async () => {
    const f = setup(), refs = [sourceRef(f.window)];
    f.invoke.mockImplementationOnce(async (_p, _i, _s, gate) => { gate?.(); return { outcomeKind: 'result', result: { ok: true, output: '{', runtime: { producer: 'authored-test-not-native' } } }; });
    const first = await generateFixture(f, f.model); expect(first.journal.status).toBe('failed'); expect(f.invoke).toHaveBeenCalledTimes(1);
    const bytes = readFileSync(join(f.root, 'generation-journals', `${first.journal.runId}.json`));
    expect(await f.app.generate(refs, f.model)).toEqual(f.app.resume(first.journal.runId));
    expect(f.invoke).toHaveBeenCalledTimes(1); expect(readFileSync(join(f.root, 'generation-journals', `${first.journal.runId}.json`))).toEqual(bytes);
    expect(f.app.prepareGeneration(refs, f.model, randomUUID()).journal.runId).not.toBe(first.journal.runId); expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('canonicalizes a multi-source set without merging sources or creating another default import', async () => {
    const f = setup(), path = join(f.root, 'beta.jsonl');
    const second = captureTraceFixture(f.root, { path, records: [{ recordIndex: 4, raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Beta has another source.' }] } }) }] });
    const refs = [sourceRef(second), sourceRef(f.window)], prepared = f.app.prepareGeneration(refs, f.model);
    expect(f.app.prepareGeneration([refs[1], refs[0], refs[0]], f.model)).toEqual(prepared); expect(f.invoke).not.toHaveBeenCalled();
    const input = JSON.parse(prepared.journal.stages[0].input);
    expect(input.sources.map((source: { sourceKey: string }) => source.sourceKey)).toEqual(['s0', 's1']);
    expect(input.sources.map((source: { source: { snapshotId: string } }) => source.source.snapshotId)).toEqual(sourceSetPreimage(refs).sources.map(ref => ref.snapshotId));
    const evidence = [f.window, second].map(source => ({ ...f.body.proposals[0].segments[0].evidence[0], evidenceRef: source.excerpts[0].evidenceRef,
      quote: source.excerpts[0].text }));
    f.body.proposals[0].segments[0] = { segmentId: 's1', text: 'Alpha and Beta are separate source assertions; identity is not merged.', evidence };
    const result = await f.app.generate(refs, f.model, undefined, undefined, { confirmedRequestDigest: prepared.journal.stages[0].requestDigest });
    const detail = f.app.detail(result.journal.bodies[0].knowledgeId);
    expect(detail.revision.content.segments[0].evidence.map(value => value.source)).toEqual([sourceRef(f.window), sourceRef(second)]);
    expect(detail.revision.observationRefs.sort()).toEqual(refs.map(ref => ref.snapshotId).sort());
    expect(f.app.prepareGeneration([refs[1], refs[0]], f.model).journal.runId).toBe(result.journal.runId); expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it('uses the real producer gate and reads two bodies through a subject in an uncited excerpt of their exact source', async () => {
    expect(BODY_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-body-generation/v8', outputName: 'knowledge_body_v2',
      profileId: 'sha256:5455186952f8a76b587b749f46385a770c17ffa2dc22a328c3181ce65ba91cea',
      wireId: 'sha256:523f048835fb6ddd0df5cfa4e9f84d6b958da95ae00632b847ce053caa7fd5c2' });
    expect(generationTextDigest(BODY_GENERATION_PROFILE.system)).toBe('sha256:3a6dd23160bad0aeed77478872c77cd0b775a45ee14ba391e2a0800b2784b864');
    expect(ASSOCIATION_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-association-generation/v7', outputName: 'knowledge_association_v3',
      profileId: 'sha256:72cc6f3f6dd514cad1c2307a30f3b80df57215625d8ac30348602d745663ce9c',
      wireId: 'sha256:2c9acd3fc02d852587b89dc6fa8c5b6d91c0bea41073ebaa0a64bbad066fa226' });
    expect(generationTextDigest(ASSOCIATION_GENERATION_PROFILE.system)).toBe('sha256:d469588aed399d54d1d000cad7397c35541e302df3d65bcdfc87beb52838079f');
    const f = setup(true);
    // Authored model responses verify source/association wiring, not model semantic quality.
    const proposal = f.body.proposals[0], segment = proposal.segments[0], evidence = { ...segment.evidence[0], evidenceRef: f.window.excerpts[1].evidenceRef };
    const body = { ...f.body, proposals: [
      { ...proposal, proposalId: 'p1', title: 'Alpha in the selected test', segments: [{ ...segment,
        text: 'Alpha works only in this test.', evidence: [{ ...evidence, quote: 'works only in this test' }] }] },
      { ...proposal, proposalId: 'p2', title: 'Alpha applicability remains unknown', segments: [{ ...segment,
        text: 'The fact time and behavior of Alpha in other environments remain unknown.',
        evidence: [{ ...evidence, quote: 'time and other environments remain unknown.' }] }] },
    ] };
    const association = { ...f.association, catalogs: [{ sourceKey: 's0', entities: [{ entityId: 'e1', label: 'Alpha', description: 'The source test object, without version identity confirmation.',
      qualifiers: ['selected test only'], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentLink: null, collectionLink: null,
      mentions: [{ mentionKey: 'm1', selection: { evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'Alpha', contextBefore: null, contextAfter: null }, basis: 'explicit', rationale: 'Exact source mention.' }] }] }],
    associations: [{ bodyKey: 'b0', segmentDecisions: [{ segmentId: 's1', decisionKind: 'mapped', entityRefs: [{ sourceKey: 's0', entityId: 'e1', mentionKeys: ['m1'] }], reason: 'Source context binds Alpha.' }], typedRelations: [{ relationId: 'r1', segmentIds: ['s1'],
      subject: { sourceKey: 's0', entityId: 'e1' }, relation: 'works in the selected test', object: null, modality: 'capability', polarity: 'positive', evidence: [{ segmentId: 's1', evidenceIndex: 0 }], issues: [] }], issues: [] },
    { bodyKey: 'b1', segmentDecisions: [{ segmentId: 's1', decisionKind: 'mapped', entityRefs: [{ sourceKey: 's0', entityId: 'e1', mentionKeys: ['m1'] }], reason: 'Shared original source context, not title inference.' }], typedRelations: null, issues: [] }] };
    const execute = vi.fn(async request => {
      expect(request.cwd).toMatch(/omk-knowledge-text-[A-Za-z0-9]{6}$/);
      expect(request.timeoutMs).toBe(300000); expect(request.effort).toBeUndefined();
      if (request.outputFormat.name.includes('association')) expect(request.system).toContain(KNOWLEDGE_RECORD_SCOPE_POLICY);
      return { ok: true, output: JSON.stringify(request.outputFormat.name.includes('association') ? association : body),
        opaqueNestedField: { preserved: ['original', 1] } } as unknown as ExecResult;
    });
    const model = configuredKnowledgeGenerationModel('codex', 'fixture-model', createCodexArchiveProducer({}, () => execute));
    const result = await generateFixture(f, model), detail = f.app.detail(result.journal.bodies[0].knowledgeId);
    expect(execute).toHaveBeenCalledTimes(2); expect(detail.derivedAssociations.revision?.typedRelations).toHaveLength(1);
    expect(detail.derivedCatalogs).toMatchObject([{ status: 'available', ...detail.derivedAssociations.revision?.catalogRefs[0] }]);
    expect(detail.derivedCatalogs[0]).not.toHaveProperty('source');
    expect(detail.derivedAssociations.revision?.segmentEntityRefs[0].entityId).not.toBe('e1');
    expect(result.journal.bodies).toHaveLength(2);
    const entityId = detail.derivedAssociations.revision!.segmentEntityRefs[0].entityId;
    expect(f.app.entityDetail(detail.derivedAssociations.revision!.catalogRefs[0].analysisId, entityId).knowledge.map(item => item.knowledgeId).sort())
      .toEqual(result.journal.bodies.map(ref => ref.knowledgeId).sort());
    for (const ref of result.journal.bodies) {
      const saved = f.app.detail(ref.knowledgeId);
      const sourceCatalog = saved.derivedCatalogs[0];
      if (sourceCatalog?.status !== 'available') throw new Error('Expected the source catalog to remain available.');
      expect(saved.derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending' });
      expect(saved.revision.content.segments[0].evidence[0].selection.quote).not.toContain('Alpha');
      expect(saved.revision.content.segments[0].evidence[0].selection.evidenceRef).not.toBe(sourceCatalog.mentions[0].selection.evidenceRef);
    }
    expect(f.app.inspect(result.journal.runId).nativeOutcomes[0].outcome).toMatchObject({ result: { opaqueNestedField: { preserved: ['original', 1] } } });
    const before = detail.revision.bodyDigest, projection = detail.derivedAssociations.revision!;
    const reviewed = f.app.reviewAssociations(detail.revision.knowledgeId, projection.revisionId, detail.derivedAssociations.generation, 'accept', 'explicit derived review');
    expect(reviewed.derivedAssociations.reviewStatus).toBe('accepted'); expect(reviewed.revision.bodyDigest).toBe(before);
    expect(reviewed.maintenance).toBeNull();
  });
  it('saves body before independent association, reopens exact originals and replays completed identity with zero calls', async () => {
    const f = setup(), runId = randomUUID(), result = await generateFixture(f, f.model, runId);
    expect(result.journal.status).toBe('completed'); expect(f.invoke).toHaveBeenCalledTimes(2);
    const detail = f.app.detail(result.journal.bodies[0].knowledgeId);
    expect(detail.revision.content.segments[0].text).toBe(f.window.excerpts[0].text);
    expect(detail.revision.createdBy.actorKind).toBe('agent'); expect(detail.maintenance).toBeNull();
    expect(detail.derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending' });
    const reopened = createLocalKnowledgeApplication(f.root);
    expect(reopened.inspect(runId).nativeOutcomes).toHaveLength(2);
    expect(reopened.resume(runId)).toEqual(result);
    await generateFixture(f, f.model, runId); expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(readdirSync(join(f.root, 'items'))).toHaveLength(1);
    expect(() => reopened.detail(detail.revision.knowledgeId, detail.revision.revisionId)).not.toThrow();
  });
  it('preserves a maximum-length abstention and segment identity without overflowing the stored diagnostic', async () => {
    const f = setup(), segmentId = 's'.repeat(256), reason = '界'.repeat(32768);
    f.body.proposals[0].segments[0].segmentId = segmentId;
    f.association.associations[0].segmentDecisions[0] = { segmentId, decisionKind: 'abstained', entityRefs: [], reason };
    f.association.associations[0].issues = [];
    const output = JSON.stringify(f.association);
    const result = await generateFixture(f, f.model), ref = result.journal.bodies[0];
    expect(result.journal.status).toBe('completed'); expect(f.invoke).toHaveBeenCalledTimes(2);
    const reopened = createLocalKnowledgeApplication(f.root), detail = reopened.detail(ref.knowledgeId);
    expect(detail.derivedAssociations.status).toBe('available');
    expect(detail.derivedAssociations.revision?.segmentEntityRefs).toEqual([]);
    expect(detail.derivedAssociations.revision?.issues).toEqual([`AI association abstained for ${segmentId}; reason follows.`, reason]);
    expect(reopened.inspect(result.journal.runId).nativeOutcomes[1].outcome).toMatchObject({ result: { output } });
    expect(reopened.resume(result.journal.runId)).toEqual(result);
  });
  it.each(['native_failure', 'duplicate_mention_position'] as const)('preserves body and originals after %s without hidden retries, and permits explicit rebuild', async failure => {
    const f = setup(); f.invoke.mockImplementationOnce(async (_p, _i, _s, gate) => { gate?.(); return { outcomeKind: 'result', result: { ok: true, output: JSON.stringify(f.body), runtime: { producer: 'authored-test-not-native' } } }; });
    const invalidCatalog = { ...f.association, catalogs: [{ sourceKey: 's0',
      entities: ['e1', 'e2'].map(entityId => ({ entityId, label: 'Alpha', description: 'Authored conflicting source interpretation.', qualifiers: [],
        identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentLink: null, collectionLink: null,
        mentions: [{ mentionKey: 'same-local-key', selection: { evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'Alpha', contextBefore: null, contextAfter: null },
          basis: 'explicit', rationale: 'Same original position assigned twice.' }] })),
    }] };
    const native = { ok: failure !== 'native_failure', output: failure === 'native_failure' ? '' : JSON.stringify(invalidCatalog),
      runtime: { producer: 'authored-test-not-native' } };
    f.invoke.mockImplementationOnce(async (_p, _i, _s, gate) => { gate?.(); return { outcomeKind: 'result', result: native }; });
    const result = await generateFixture(f, f.model), ref = result.journal.bodies[0], detail = f.app.detail(ref.knowledgeId);
    const stageReason = failure === 'native_failure' ? 'Association native execution did not complete cleanly.'
      : 's0: Entity catalog reference closure rejected: duplicate_mention_position.';
    const reason = failure === 'native_failure' ? stageReason : `Required source catalogs rejected: ${stageReason}`;
    expect(f.invoke).toHaveBeenCalledTimes(2); expect(result.journal.stages[1].issues).toEqual([stageReason]);
    expect(detail.derivedAssociations.status).toBe('failed'); expect(detail.revision.content.segments).toHaveLength(1);
    expect(detail.derivedAssociations.revision?.issues).toEqual([reason]);
    const original = f.app.inspect(result.journal.runId).nativeOutcomes[1].outcome;
    expect(original).toEqual({ outcomeKind: 'result', result: native });
    const archivePath = join(f.root, 'generation-journals', 'outcomes', result.journal.runId, `${result.journal.stages[1].invocationId}.json`);
    const archiveBytes = readFileSync(archivePath);
    const bodyBytes = readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]));
    const reopened = createLocalKnowledgeApplication(f.root);
    expect(reopened.resume(result.journal.runId).journal).toEqual(result.journal); expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(reopened.inspect(result.journal.runId).nativeOutcomes[1].outcome).toEqual(original);
    await rebuildFixture(f,ref, f.model);
    expect(f.invoke).toHaveBeenCalledTimes(3);
    expect(f.app.detail(ref.knowledgeId).derivedAssociations.status).toBe('available');
    expect(readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]))).toEqual(bodyBytes);
    expect(readFileSync(archivePath)).toEqual(archiveBytes);
  });
  it('replays an acknowledged store write after journal interruption without an extra revision or native call', async () => {
    const f = setup(), write = f.ports.knowledge.write.bind(f.ports.knowledge);
    vi.spyOn(f.ports.knowledge, 'write').mockImplementationOnce((command, actor) => { write(command, actor); throw new Error('after body publish'); });
    const runId = randomUUID(); await expect(generateFixture(f, f.model, runId)).rejects.toThrow('after body publish');
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const restored = createLocalKnowledgeApplication(f.root).resume(runId);
    expect(restored.journal.bodies).toHaveLength(1); expect(restored.nextAction).toBe('continue_stage');
    expect(f.ports.knowledge.list()[0].revisions).toHaveLength(1);
    await expect(f.app.continueStage(runId, restored.journal.generation, f.model)).rejects.toThrow('Prepare the next');
    expect(f.app.inspect(runId).journal).toEqual(restored.journal);
    const prepared = f.app.prepareGeneration([sourceRef(f.window)], f.model, runId);
    expect(prepared.journal.stages.at(-1)).toMatchObject({ stageKind: 'association', state: 'prepared' });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.app.prepareGeneration([sourceRef(f.window)], f.model, runId)).toEqual(prepared);
    await expect(f.app.continueStage(runId, prepared.journal.generation, f.model)).rejects.toThrow('Confirm the exact');
    expect(f.app.inspect(runId).journal).toEqual(prepared.journal);
    const completed = await f.app.continueStage(runId, prepared.journal.generation, f.model, undefined, { confirmedRequestDigest: prepared.journal.stages.at(-1)!.requestDigest });
    expect(completed.journal.status).toBe('completed'); expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('retains a real returned outcome under archive backpressure and stops before the next native stage', async () => {
    const f = setup(), id = randomUUID();
    vi.spyOn(f.ports.journals, 'archive').mockImplementationOnce(() => { throw new Error('archive disk failure'); });
    await expect(generateFixture(f, f.model, id)).rejects.toThrow('archive disk failure');
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
    await expect(generateFixture(f, f.model, id)).rejects.toThrow('lost native');
    expect(f.ports.journals.list().archiveChecks).toEqual([expect.objectContaining({ runId: id,
      archiveStatus: 'unknown', verificationStatus: 'not_verified' })]);
    const state = createLocalKnowledgeApplication(f.root).resume(id);
    expect(state.nextAction).toBe('outcome_unknown_do_not_redispatch');
    await expect(f.app.continueStage(id, state.journal.generation, f.model)).rejects.toThrow('never-claimed'); expect(f.invoke).toHaveBeenCalledTimes(1);
    const other = randomUUID(), inspect = f.model.inspect;
    f.model.inspect = () => ({ ...inspect({} as GenerationProfile, ''), maxOutcomeJsonBytes: 1024 ** 4 });
    await expect(generateFixture(f, f.model, other)).rejects.toThrow('archive capacity');
    expect(f.ports.journals.read(other)).toBeUndefined();
  });
  it('keeps an unclaimed association eligible for explicit continuation after its permission gate refuses', async () => {
    const f = setup(), runId = randomUUID();
    await expect(generateFixture(f, f.model, runId, undefined, { beforeDispatch(claim) {
      if (claim.stageKind === 'association') { expect(f.app.list()).toHaveLength(1); throw new Error('phase quota exhausted'); }
    } })).rejects.toThrow('phase quota exhausted');
    const read = f.app.inspect(runId); expect(read.journal.stages.at(-1)?.state).toBe('prepared');
    expect(f.ports.journals.list().archiveChecks.at(-1)).toMatchObject({ archiveStatus: 'not_recorded', verificationStatus: 'not_verified' });
    expect(read.nativeOutcomes.filter(o => o.outcome)).toHaveLength(1);
    expect(f.app.resume(runId).nextAction).toBe('continue_stage');
    const result = await f.app.continueStage(runId, read.journal.generation, f.model, undefined, { confirmedRequestDigest: read.journal.stages.at(-1)!.requestDigest });
    expect(result.journal.status).toBe('completed');
  });
  it.each(['prepared', 'claimed', 'archived', 'body_completed'] as const)('leaves an active prior-profile %s run and its originals untouched without decoding or redispatch', async state => {
    const f = setup(), prior = legacyRun(f, state), bytes = prior.paths.map(path => readFileSync(path));
    const reopened = createLocalKnowledgeApplication(f.root), inspected = reopened.inspect(prior.journal.runId);
    expect(inspected).toMatchObject({ journal: prior.journal, nextAction: 'unsupported' });
    if (['archived', 'body_completed'].includes(state)) expect(inspected.nativeOutcomes[0].outcome).toEqual(prior.outcome);
    else expect(inspected.nativeOutcomes[0]).not.toHaveProperty('outcome');
    expect(reopened.resume(prior.journal.runId)).toEqual({ journal: prior.journal, nextAction: 'unsupported' });
    await expect(reopened.continueStage(prior.journal.runId, prior.journal.generation, f.model)).rejects.toThrow(/profile changed.*matching build/);
    expect(prior.paths.map(path => readFileSync(path))).toEqual(bytes);
    expect(reopened.list()).toHaveLength(state === 'body_completed' ? 1 : 0);
    expect(reopened.inspect(prior.journal.runId)).toEqual(inspected); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('replays immutable prior-profile prepared writes once and refuses a new-protocol association on the saved body', async () => {
    const f = setup(), prior = legacyRun(f, 'prepared_writes'), archived = readFileSync(prior.paths[1]);
    const reopened = createLocalKnowledgeApplication(f.root);
    expect(reopened.inspect(prior.journal.runId).nextAction).toBe('resume_publication');
    const replayed = reopened.resume(prior.journal.runId);
    expect(replayed).toMatchObject({ nextAction: 'unsupported', journal: { status: 'active', bodies: [knowledgeBodyRef(prior.write.revision)],
      stages: [{ state: 'completed', bodyWrites: [prior.write], committed: 1 }] } });
    const detail = reopened.detail(prior.write.knowledgeId);
    expect(detail.history.revisions).toEqual([prior.write.revision]); expect(detail.derivedAssociations.status).toBe('absent');
    const journalBytes = readFileSync(prior.paths[0]), bodyPath = join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]), bodyBytes = readFileSync(bodyPath);
    expect(reopened.resume(prior.journal.runId)).toEqual(replayed);
    await expect(reopened.continueStage(prior.journal.runId, replayed.journal.generation, f.model)).rejects.toThrow(/profile changed.*matching build/);
    expect(readFileSync(prior.paths[0])).toEqual(journalBytes); expect(readFileSync(prior.paths[1])).toEqual(archived);
    expect(readFileSync(bodyPath)).toEqual(bodyBytes); expect(f.invoke).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed'] as const)('keeps terminal prior-profile %s results inspectable with zero mutation or model calls', state => {
    const f = setup(), prior = legacyRun(f, state), bytes = prior.paths.map(path => readFileSync(path));
    const reopened = createLocalKnowledgeApplication(f.root);
    expect(reopened.inspect(prior.journal.runId)).toMatchObject({ nextAction: 'none', journal: prior.journal,
      nativeOutcomes: [{ outcome: prior.outcome }] });
    expect(reopened.resume(prior.journal.runId)).toEqual({ journal: prior.journal, nextAction: 'none' });
    expect(prior.paths.map(path => readFileSync(path))).toEqual(bytes); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('reports legacy runs unsupported and refuses corrupt archived originals instead of presenting completed success', async () => {
    const f = setup(), result = await generateFixture(f, f.model), id = randomUUID();
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
    const f = setup(), result = await generateFixture(f, f.model);
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
    const unsupportedId = randomUUID(); writeFileSync(join(f.root, 'generation-journals', `${unsupportedId}.json`), JSON.stringify({ storeKind: 'knowledge-generation-journal', schemaVersion: 1 }));
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
    const f = setup(), result = await generateFixture(f, f.model);
    const stage = result.journal.stages[0], path = join(f.root, 'generation-journals', 'outcomes', result.journal.runId, `${stage.invocationId}.json`);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('knowledge-generation-native', 'knowledge-generation-broken'));
    expect(f.ports.journals.list().archiveChecks[0]).toMatchObject({ archiveStatus: 'present', verificationStatus: 'not_verified' });
    expect(() => f.app.inspect(result.journal.runId)).toThrow('digest mismatch');
    expect(() => f.app.resume(result.journal.runId)).toThrow('digest mismatch');
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('rebuilds a two-source body with isolated catalog identities and resumes an interrupted second catalog publication without redispatch', async () => {
    const { f, detail, second, bodyBytes, output } = await twoSourceSetup();
    const inputs: string[] = [], invoke = vi.fn<KnowledgeGenerationModel['invoke']>(async (_profile, input, _signal, gate) => {
      gate?.(); inputs.push(input); return { outcomeKind: 'result' as const, result: { ok: true, output: JSON.stringify(output) } };
    });
    const model = { ...f.model, invoke }, entityWrite = f.ports.entities.write.bind(f.ports.entities), runId = randomUUID(); let published = 0;
    vi.spyOn(f.ports.entities, 'write').mockImplementation((command, actor) => {
      const result = entityWrite(command, actor); if (++published === 2) throw new Error('Second catalog acknowledgement interrupted.'); return result;
    });
    await expect(rebuildFixture(f,{ knowledgeId: detail.revision.knowledgeId, revisionId: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest }, model, runId)).rejects.toThrow('acknowledgement interrupted');
    expect(invoke).toHaveBeenCalledTimes(1);
    const recorded = f.ports.journals.read(runId)!;
    expect(recorded).toMatchObject({ schemaVersion: 3, workflowId: 'knowledge-body-first/v3', inputVersion: SOURCE_GENERATION_INPUT_VERSION,
      sources: sourceSetPreimage([sourceRef(f.window), sourceRef(second)]).sources });
    expect(recorded.stages[0].entityWrites).toHaveLength(2); expect(recorded.stages[0].committed).toBe(1);
    expect(JSON.parse(inputs[0]).sources.map((source: { sourceKey: string }) => source.sourceKey)).toEqual(['s0', 's1']);
    const completed = createLocalKnowledgeApplication(f.root).resume(runId), reopened = createLocalKnowledgeApplication(f.root).detail(detail.revision.knowledgeId);
    expect(completed.journal.status).toBe('completed'); expect(invoke).toHaveBeenCalledTimes(1);
    expect(reopened.derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending' });
    const revision = reopened.derivedAssociations.revision!;
    expect(revision.catalogRefs).toHaveLength(2);
    expect(new Set(revision.segmentEntityRefs.map(ref => ref.analysisId)).size).toBe(2);
    expect(new Set(revision.segmentEntityRefs.map(ref => ref.entityId)).size).toBe(2);
    expect(new Set(revision.segmentEntityRefs.flatMap(ref => ref.mentionIds)).size).toBe(2);
    expect(reopened.derivedCatalogs).toHaveLength(2);
    for (const write of completed.journal.stages[0].entityWrites!) expect(f.ports.entities.read(write.analysisId).revisions).toHaveLength(1);
    expect(readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]))).toEqual(bodyBytes);
    expect(() => f.ports.journals.write({ ...completed.journal, generation: completed.journal.generation + 1,
      sources: [...completed.journal.sources].reverse() }, completed.journal.generation)).toThrow('Invalid generation source set identity.');
  });
  it('preserves a healthy source catalog and canonical body when another catalog is rejected, without publishing a misleading partial success', async () => {
    const { f, detail, second, bodyBytes, output } = await twoSourceSetup();
    const rejected = output.catalogs.find(catalog => catalog.entities[0].mentions[0].selection.evidenceRef === second.excerpts[0].evidenceRef)!;
    rejected.entities[0].mentions.push({ ...rejected.entities[0].mentions[0], mentionKey: 'duplicate-position' });
    const invoke = vi.fn<KnowledgeGenerationModel['invoke']>(async (_profile, _input, _signal, gate) => {
      gate?.(); return { outcomeKind: 'result', result: { ok: true, output: JSON.stringify(output) } };
    });
    const result = await rebuildFixture(f,{ knowledgeId: detail.revision.knowledgeId, revisionId: detail.revision.revisionId, bodyDigest: detail.revision.bodyDigest }, { ...f.model, invoke });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.journal.stages[0].entityWrites).toHaveLength(1);
    const healthy = result.journal.stages[0].entityWrites![0];
    expect(healthy.snapshotId).toBe(f.window.snapshotId);
    expect(f.ports.entities.read(healthy.analysisId).revisions[0].entities).toHaveLength(1);
    const reopened = createLocalKnowledgeApplication(f.root), failed = reopened.detail(detail.revision.knowledgeId);
    expect(failed.derivedAssociations).toMatchObject({ status: 'failed', reviewStatus: 'pending', revision: { catalogRefs: [], segmentEntityRefs: [],
      issues: [`Required source catalogs rejected: ${rejected.sourceKey}: Entity catalog reference closure rejected: duplicate_mention_position.`] } });
    expect(f.ports.associations.read(detail.revision.knowledgeId).revisions).toHaveLength(2);
    expect(reopened.resume(result.journal.runId).journal).toEqual(result.journal);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]))).toEqual(bodyBytes);
  });
  it('validates full replacement inline evidence before revise and makes old derived projection stale', async () => {
    const f = setup(), result = await generateFixture(f, f.model), ref = result.journal.bodies[0], detail = f.app.detail(ref.knowledgeId);
    const draft = { title: detail.revision.title, content: structuredClone(detail.revision.content), reuseRationale: detail.revision.reuseRationale };
    draft.content.segments[0].evidence[0].selection.quote = 'wrong';
    expect(() => f.app.revise(ref.knowledgeId, ref.revisionId, detail.history.generation, draft, 'invalid edit')).toThrow('evidence');
    draft.content = detail.revision.content;
    const next = f.app.revise(ref.knowledgeId, ref.revisionId, detail.history.generation, draft, 'explicit new revision');
    expect(next.derivedAssociations.status).toBe('stale'); expect(next.maintenance).toBeNull();
  });
});
