import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { BodyGenerationApplication, type KnowledgeGenerationOptions } from '../../src/knowledge/application/body-generation.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { FileGenerationJournalStore } from '../../src/knowledge/adapters/generation-journal-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileSourceLedgerStore, FileSourceCoverageStore } from '../../src/knowledge/adapters/source-review-store.js';
import { knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import type { GenerationJournal, GenerationStage } from '../../src/knowledge/extraction/generation-journal.js';
import type { SourceCoverageData, SourceCoverageDecisionRef, SourceLedgerData } from '../../src/knowledge/source-review.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { captureTraceFixture, sourceRef } from '../helpers/knowledge-source.js';
import { WRITING_DRAFT_PROFILE } from '../../src/knowledge/extraction/writing-draft.js';
import { generationImportRunId, bodySourcePassages, WORKFLOW_ID } from '../../src/knowledge/extraction/source-input.js';
import { passageRange } from '../helpers/source-passages.js';
import { sourceSetPreimage, type SourceRef } from '../../src/knowledge/sources.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { ASSOCIATION_GENERATION_PROFILE, BODY_GENERATION_PROFILE, generationTextDigest, type BodyGenerationResponseSchema, type AssociationGenerationResponse } from '../../src/knowledge/extraction/body-generation-wire.js';
import { SOURCE_REVIEW_INPUT_VERSION, type sourceLedgerInput, type SourceReviewInput } from '../../src/knowledge/extraction/source-review-input.js';
import { type SourceLedgerResponseSchema, type SourceCoverageResponseSchema } from '../../src/knowledge/extraction/source-review-wire.js';
import { KNOWLEDGE_RECORD_SCOPE_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';
import { configuredKnowledgeGenerationModel, type KnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import { createCodexArchiveProducer } from '../../src/executors/openai/codex/archive.js';
import type { ExecResult } from '../../src/executors/contracts/result.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stages = ['body_draft', 'body', 'source_ledger', 'source_coverage', 'association'] as const;
const testReviewActor = { actorKind: 'agent' as const, actorId: 'explicit-test-source-reviewer', executionRef: 'test:actual-review-operation' };
type State = ReturnType<BodyGenerationApplication['resume']>;
type CoverageResponse = z.infer<typeof SourceCoverageResponseSchema>;
type CoverageRequest = SourceReviewInput & { ledger: { data: SourceLedgerData };
  bodies: { bodyKey: string; bodyRef: SourceCoverageData['bodyRefs'][number]; segments: { segmentId: string; text: string }[] }[];
  targets: { targetKey: string; target: SourceCoverageData['checks'][number]['target'] }[] };
const locator = (unitKey: string, quote: string) => ({ unitKey, quote, contextBefore: null, contextAfter: null });
/** Authored native fixtures exercise the real strict wires, not model semantic quality. */
function ledgerOutput(input: string): z.infer<typeof SourceLedgerResponseSchema> {
  const request = JSON.parse(input) as ReturnType<typeof sourceLedgerInput>;
  return { responseKind: 'knowledge-source-ledger', schemaVersion: 3,
    passageIndexDigest: request.passageIndexDigest,
    unitDispositions: request.units.map(unit => ({ unitKey: unit.unitKey, disposition: 'retain', reason: 'Explicit delivered-unit inventory fixture.' })),
    items: request.units.map((unit, index) => ({ itemId: `i${index}`, statement: `Authored inventory of ${unit.unitKey}; scope is limited to this delivered unit.`,
      disposition: 'retain', reason: 'Exercise exact unit custody.', equivalentItemIds: [], evidence: [{
        startPassageId: unit.passages[0].passageId, endPassageId: unit.passages.at(-1)!.passageId }], facets: [] })),
    limitations: ['Authored protocol fixture; neither semantic quality nor source truth is certified.'] };
}
function coverageOutput(input: string): CoverageResponse {
  const request = JSON.parse(input) as CoverageRequest;
  const base = { coverageTarget: 'knowledge_meaning' as const, status: 'unassessable' as const, factualValue: 'not_applicable' as const,
    reason: 'The fixture keeps this inventory unresolved for the actual test actor; it does not infer semantic acceptance.', bodyEvidence: [], boundedInput: null };
  const sourceQuote = (unitKey: string) => locator(unitKey, request.units.find(unit => unit.unitKey === unitKey)!.text);
  return { responseKind: 'knowledge-source-coverage', schemaVersion: 3,
    checks: request.targets.map(({ targetKey, target }) => {
      const result = { ...base, checkId: `check:${targetKey}`, targetKey, sourceEvidence: [] as ReturnType<typeof locator>[] };
      if (target.targetKind === 'source_unit') return { ...result, sourceEvidence: [sourceQuote(target.unitKey)] };
      if (target.targetKind === 'ledger_item' || target.targetKind === 'ledger_facet') {
        const item = request.ledger.data.items.find(item => item.itemId === target.itemId)!;
        const evidence = target.targetKind === 'ledger_facet' ? item.facets.find(facet => facet.facetId === target.facetId)!.evidence : item.evidence;
        return { ...result, sourceEvidence: evidence.map(anchor => sourceQuote(anchor.unitKey)) };
      }
      const body = request.bodies.find(body => canonicalJson(body.bodyRef) === canonicalJson(target.bodyRef))!;
      const segment = body.segments.find(segment => segment.segmentId === target.segmentId)!;
      return { ...result, bodyEvidence: [{ bodyKey: body.bodyKey, segmentId: segment.segmentId, quote: segment.text, contextBefore: null, contextAfter: null }] };
    }),
    findings: [], limitations: ['All inventory uncertainty remains visible; no native response supplies an actual decision.'] };
}
function setup(splitMentionContext = false) {
  const root = mkdtempSync(join(tmpdir(), 'omk-body-generation-')); roots.push(root);
  const source = join(root, 'source.jsonl'), messages = splitMentionContext ? ['Alpha is the source object.', 'It works only in this test; time and other environments remain unknown.']
    : ['Alpha works only in this test; time and other environments remain unknown.'];
  writeFileSync(source, messages.map(text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })).join('\n'));
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'local', root), entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const ports = { knowledge, entities, journals: new FileGenerationJournalStore(join(root, 'generation-journals'), root), sources: new FileSourceStore(join(root, 'sources'), root),
    ledgers: new FileSourceLedgerStore(join(root, 'source-ledgers'), 'local', root), coverage: new FileSourceCoverageStore(join(root, 'source-coverage'), 'local', root),
    tags: new FileKnowledgeTags(join(root, 'tags'), 'local', root), associations: new FileKnowledgeAssociationStore(join(root, 'associations'), 'local', knowledge, entities, root),
    id: randomUUID, now: () => '2026-10-28T00:00:00Z', hash: (v: unknown) => generationTextDigest(canonicalJson(v)),
    actor: { actorKind: 'human' as const, actorId: 'test-maintainer' }, reviewActor: testReviewActor };
  const library = new KnowledgeApplication(ports), app = new BodyGenerationApplication(ports), window = captureTraceFixture(root, { path: source });
  const body: z.infer<typeof BodyGenerationResponseSchema> = { responseKind: 'knowledge-body-generation', schemaVersion: 3, proposals: [{ proposalId: 'p1', title: 'Limited source report', requiredContexts: [],
    segments: [{ segmentId: 's1', text: window.excerpts[0].text, evidence: [{ ...passageRange(bodySourcePassages([window]).index, window.excerpts[0].evidenceRef, 'Alpha'), basis: 'source_assertion', interpretation: null }] }],
    organization: null, reuseRationale: 'Retain the limitation for later comparisons.' }], passageIndexDigest: bodySourcePassages([window]).index.digest };
  const association: AssociationGenerationResponse = { responseKind: 'knowledge-association-generation', schemaVersion: 3, catalogs: [{ sourceKey: 's0', entities: [] }], associations: [{ bodyKey: 'b0',
    segmentDecisions: [{ segmentId: 's1', decisionKind: 'abstained', entityRefs: [], reason: 'No reliable object in this authored fixture.' }], typedRelations: [], issues: [] }] };
  const output = (stage: GenerationStage['stageKind'], input: string): unknown => {
    if (stage === 'body') { body.passageIndexDigest = JSON.parse(input).passageIndexDigest; return body; }
    return stage === 'source_ledger' ? ledgerOutput(input) : stage === 'source_coverage' ? coverageOutput(input)
      : stage === 'body_draft' ? { responseKind: 'knowledge-writing-draft', schemaVersion: 1, text: 'Unverified Alpha writing fixture.' } : association;
  };
  const dispatched: GenerationStage['stageKind'][] = [];
  const invoke = vi.fn<KnowledgeGenerationModel['invoke']>(async (profile, input, _signal, gate) => {
    gate?.(); dispatched.push(profile.stageKind);
    return { outcomeKind: 'result', result: { ok: true, output: JSON.stringify(output(profile.stageKind, input)), opaqueNestedField: { preserved: ['original', 1] } } };
  });
  const model: KnowledgeGenerationModel = { executor: 'authored-test', model: 'fixture', timeoutMs: 300000,
    inspect: () => ({ producerId: 'authored-test', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024 * 1024, proof: { synthetic: true } }), invoke };
  const reopen = () => new BodyGenerationApplication({ ...ports, journals: new FileGenerationJournalStore(join(root, 'generation-journals'), root) });
  return { root, app, library, ports, window, body, association, model, invoke, output, dispatched, reopen };
}
type Fixture = ReturnType<typeof setup>;
async function dispatch(f: Fixture, prepared: State, model = f.model, options: KnowledgeGenerationOptions = {}) {
  return f.app.continueStage(prepared.journal.runId, prepared.journal.generation, model, undefined,
    { ...options, confirmedRequestDigest: prepared.journal.stages.at(-1)!.requestDigest });
}
async function runBodies(f: Fixture, model = f.model, runId?: string, refs: SourceRef[] = [sourceRef(f.window)]) {
  let state = f.app.prepareGeneration(refs, model, runId);
  for (const stage of ['body_draft', 'body']) {
    if (state.journal.stages.at(-1)!.stageKind !== stage) state = f.app.prepareGeneration(refs, model, state.journal.runId);
    state = await dispatch(f, state, model);
    if (state.journal.status === 'failed') return state;
  }
  return state;
}
/** Review is explicitly separate from completed body generation; never supplies a decision. */
async function runAnalyses(f: Fixture, model = f.model, runId?: string, refs: SourceRef[] = [sourceRef(f.window)]) {
  const body = await runBodies(f, model, runId, refs);
  if (body.journal.status === 'failed') return body;
  let state = f.app.prepareSourceReview(refs, body.journal.bodies, model);
  state = await dispatch(f, state, model);
  if (state.journal.status === 'failed') return state;
  return dispatch(f, f.app.prepareSourceReview(refs, body.journal.bodies, model, undefined, state.journal.runId), model);
}
/** An explicit actual test actor opinion, never a model callback or an implicit all-covered approval. */
function recordActualTestDecision(f: Fixture, state: State, kind: 'proceed_with_limits' | 'needs_revision' | 'stop'): SourceCoverageDecisionRef {
  const ref = state.journal.coverageRef!, status = f.app.sourceCoverageStatus(ref.coverageId, ref.revisionId), requestId = randomUUID();
  const decision = { coverageRef: ref, sourceSetId: state.journal.sourceSetId, ledgerRef: state.journal.ledgerRef!, bodyRefs: state.journal.bodies,
    decisionKind: kind, reason: 'Actual test operator deliberately decides this exact authored case.', limitations: ['Protocol fixture only; no factual, semantic-quality or human-Gold claim.'],
    dispositions: status.unresolvedIds!.map(unresolvedId => ({ unresolvedId, disposition: kind === 'proceed_with_limits' ? 'accepted_limit' as const : 'blocks' as const,
      reason: 'Explicit test-operator disposition of the recorded uncertainty.' })), supersedesEventIds: [] };
  f.app.reviewSourceCoverage({ commandKind: 'record_decision', coverageId: ref.coverageId, requestId,
    expectedGeneration: status.history.generation, expectedHeadEventId: status.history.writeHeadEventId, decision });
  return { coverageRef: ref, sourceSetId: decision.sourceSetId, ledgerRef: decision.ledgerRef, bodyRefs: decision.bodyRefs, eventId: requestId };
}
async function generateWithActualTestReview(f: Fixture, model = f.model, runId?: string) {
  const analyses = await runAnalyses(f, model, runId);
  recordActualTestDecision(f, analyses, 'proceed_with_limits');
  const prepared = f.app.prepareAssociationRebuild([sourceRef(f.window)], analyses.journal.bodies, model);
  return dispatch(f, prepared, model);
}
function revokeActualTestDecision(f: Fixture, decision: SourceCoverageDecisionRef) {
  const status = f.app.sourceCoverageStatus(decision.coverageRef.coverageId, decision.coverageRef.revisionId);
  return f.app.reviewSourceCoverage({ commandKind: 'revoke_decision', coverageId: decision.coverageRef.coverageId, requestId: randomUUID(),
    expectedGeneration: status.history.generation, expectedHeadEventId: status.history.writeHeadEventId, targetEventId: decision.eventId, reason: 'Actual test operator withdraws the exact opinion.' });
}
async function preparePhase(f: Fixture, kind: GenerationStage['stageKind']) {
  let state = f.app.prepareGeneration([sourceRef(f.window)], f.model);
  for (const stage of ['body_draft', 'body'] as const) {
    if (stage === kind) return state;
    state = await dispatch(f, state);
    if (stage === 'body_draft') state = f.app.prepareGeneration([sourceRef(f.window)], f.model, state.journal.runId);
  }
  state = f.app.prepareSourceReview([sourceRef(f.window)], state.journal.bodies, f.model);
  if (kind === 'source_ledger') return state;
  state = await dispatch(f, state);
  state = f.app.prepareSourceReview([sourceRef(f.window)], state.journal.bodies, f.model, undefined, state.journal.runId);
  if (kind === 'source_coverage') return state;
  state = await dispatch(f, state);
  return f.app.prepareAssociationRebuild([sourceRef(f.window)], state.journal.bodies, f.model);
}
/** A real revision adds a second source, so it needs its own source-ledger/coverage analyses and actual review. */
async function prepareTwoSourceRebuildWithActualReview(f: Fixture) {
  const initial = await generateWithActualTestReview(f), first = f.library.detail(initial.journal.bodies[0].knowledgeId);
  const second = captureTraceFixture(f.root, { path: join(f.root, 'second-source.jsonl'), records: [{ recordIndex: 0,
    raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha has a separate source-local context.' }] } }) }] });
  const draft = { title: first.revision.title, content: { segments: [...first.revision.content.segments, { segmentId: 's2', text: second.excerpts[0].text,
    evidence: [{ source: sourceRef(second), selection: { evidenceRef: second.excerpts[0].evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'source_assertion' as const }] }] }, reuseRationale: first.revision.reuseRationale };
  const detail = f.library.revise(first.revision.knowledgeId, first.revision.revisionId, first.history.generation, draft, 'Explicit two-source revision'), ref = knowledgeBodyRef(detail.revision);
  const refs = [sourceRef(f.window), sourceRef(second)], review = f.app.prepareSourceReview(refs, [ref], f.model);
  const inventoried = await dispatch(f, review), coverage = f.app.prepareSourceReview(refs, [ref], f.model, undefined, inventoried.journal.runId);
  const checked = await dispatch(f, coverage); recordActualTestDecision(f, checked, 'proceed_with_limits');
  const sources = [f.window, second].sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
  f.association.catalogs = sources.map((source, index) => ({ sourceKey: `s${index}`, entities: [{ entityId: 'e1', label: 'Alpha', description: 'Distinct source-local subject; no cross-window identity merge.',
    qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: ['Cross-window identity remains unknown.'], referentKind: 'object', componentLink: null, collectionLink: null,
    mentions: [{ mentionKey: 'm1', selection: { evidenceRef: source.excerpts[0].evidenceRef, quote: 'Alpha', contextBefore: null, contextAfter: null }, basis: 'explicit', rationale: 'Own literal mention in this exact source.' }] }] }));
  f.association.associations = [{ bodyKey: 'b0', segmentDecisions: [f.window, second].map((source, index) => ({ segmentId: `s${index + 1}`, decisionKind: 'mapped',
    entityRefs: [{ sourceKey: `s${sources.findIndex(value => value.snapshotId === source.snapshotId)}`, entityId: 'e1', mentionKeys: ['m1'] }], reason: 'Each paragraph discusses its own exact source object.' })), typedRelations: [], issues: [] }];
  const bodyFile = join(f.root, 'items', readdirSync(join(f.root, 'items')).find(name => name.endsWith('.json'))!);
  return { ref, second, bodyFile, bodyBytes: readFileSync(bodyFile), prepared: f.app.prepareAssociationRebuild(refs, [ref], f.model) };
}
const archivePath = (f: Fixture, j: GenerationJournal, stage: GenerationStage) => join(f.root, 'generation-journals', 'outcomes', j.runId, `${stage.invocationId}.json`);

describe('source-first generation and zero-model recovery', () => {
  it('completes canonical generation after two separately confirmed requests, without review or association calls', async () => {
    const f = setup(), refs = [sourceRef(f.window)], prepared = f.app.prepareGeneration(refs, f.model);
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.library.list()).toEqual([]);
    expect(prepared.journal).toMatchObject({ schemaVersion: 10, workflowId: WORKFLOW_ID, inputVersion: SOURCE_REVIEW_INPUT_VERSION,
      runId: generationImportRunId(prepared.journal.sourceSetId), stages: [{ stageKind: 'body_draft', state: 'prepared', system: WRITING_DRAFT_PROFILE.system }] });
    const input = JSON.parse(prepared.journal.stages[0].input);
    expect(input.sources[0].source).toMatchObject(refs[0]);
    expect(input.ledger).toBeUndefined(); expect(prepared.journal.stages[0].input).not.toContain(f.root);
    for (const confirmedRequestDigest of [undefined, `sha256:${'0'.repeat(64)}`]) {
      await expect(f.app.generate(refs, f.model, undefined, undefined, { confirmedRequestDigest })).rejects.toThrow('Confirm the exact');
      expect(f.invoke).not.toHaveBeenCalled(); expect(f.app.inspect(prepared.journal.runId).journal).toEqual(prepared.journal);
    }
    let state = await f.app.generate(refs, f.model, undefined, undefined, { confirmedRequestDigest: prepared.journal.stages[0].requestDigest });
    expect(state.journal.stages).toHaveLength(1); expect(state.journal.writingDraftRef).toBeDefined();
    expect(f.library.list()).toEqual([]); expect(state.journal.ledgerRef).toBeUndefined();
    state = f.app.prepareGeneration(refs, f.model, state.journal.runId);
    const bodyInput = JSON.parse(state.journal.stages[1].input);
    expect(state.journal.stages[1].system).toBe(BODY_GENERATION_PROFILE.system);
    expect(bodyInput.writingDraft).toEqual({ ref: state.journal.writingDraftRef, text: 'Unverified Alpha writing fixture.' });
    expect(bodyInput.ledger).toBeUndefined();
    await expect(f.app.continueStage(state.journal.runId, state.journal.generation, f.model, undefined,
      { confirmedRequestDigest: prepared.journal.stages[0].requestDigest })).rejects.toThrow('Confirm the exact');
    state = await dispatch(f, state);
    expect(state.journal.status).toBe('completed'); expect(state.nextAction).toBe('none');
    expect(state.journal.stages).toHaveLength(2); expect(f.dispatched).toEqual(['body_draft', 'body']);
    expect(state.journal.coverageRef).toBeUndefined(); expect(state.journal).not.toHaveProperty('sourceCoverageDecisionRef');
    const detail = f.library.detail(state.journal.bodies[0].knowledgeId);
    expect(detail.maintenance).toBeNull(); expect(detail.derivedAssociations.status).toBe('absent');
    expect(f.reopen().inspect(state.journal.runId).nativeOutcomes).toHaveLength(2);
    expect(f.app.prepareGeneration(refs, f.model, state.journal.runId)).toEqual(state);
    expect(await f.app.generate(refs, f.model)).toEqual(f.reopen().resume(state.journal.runId)); expect(f.dispatched).toHaveLength(2);
    const bodyFile = join(f.root, 'items', readdirSync(join(f.root, 'items'))[0]), bodyBytes = readFileSync(bodyFile);
    const association = f.app.prepareAssociationRebuild(refs, state.journal.bodies, f.model);
    expect(f.dispatched).toHaveLength(2); expect(association.journal.ledgerRef).toBeUndefined(); expect(association.journal.coverageRef).toBeUndefined();
    const associated = await dispatch(f, association);
    expect(associated.journal.status).toBe('completed'); expect(f.dispatched).toEqual(['body_draft', 'body', 'association']);
    expect(readFileSync(bodyFile)).toEqual(bodyBytes);
    expect(existsSync(join(f.root, 'source-ledgers'))).toBe(false); expect(existsSync(join(f.root, 'source-coverage'))).toBe(false);
    expect(f.library.detail(state.journal.bodies[0].knowledgeId)).toMatchObject({ maintenance: null, derivedAssociations: { status: 'available', reviewStatus: 'pending' } });
  });

  it('archives a failed long-body window without publishing or redispatching it on recovery', async () => {
    const f = setup();
    const path = join(f.root, 'long-source.jsonl');
    const literal = 'This selected record describes a constrained source example. '.repeat(110);
    writeFileSync(path, Array.from({ length: 92 }, (_, index) => JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: `Record ${index}: ${literal}` }],
    } })).join('\n'));
    const refs = [sourceRef(captureTraceFixture(f.root, { path }))];
    const execute = vi.fn(async request => {
      expect(request).toMatchObject({ outputFormat: { name: 'knowledge_body_window_v1' }, timeoutMs: 150_000, effort: 'low' });
      const input = JSON.parse(request.prompt);
      expect(input.bodyWindow).toMatchObject({ index: 1 });
      expect(input).not.toHaveProperty('writingDraft');
      return { ok: false, output: null, durationMs: 150_001, failure: { failureKind: 'timeout' } } as unknown as ExecResult;
    });
    const model = configuredKnowledgeGenerationModel('codex', 'fixture-model', createCodexArchiveProducer({}, () => execute));
    const prepared = f.app.prepareGeneration(refs, model);
    expect(prepared.journal.bodyPlan!.windows.length).toBeGreaterThan(1);
    expect(prepared.journal.stages).toEqual([expect.objectContaining({ stageKind: 'body_window', state: 'prepared' })]);
    expect(prepared.journal.writingDraftRef).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    const failed = await f.app.generate(refs, model, prepared.journal.runId, undefined,
      { confirmedRequestDigest: prepared.journal.stages[0].requestDigest });
    expect(failed).toMatchObject({ journal: { status: 'failed', bodies: [] }, nextAction: 'none' });
    expect(failed.journal.stages.at(-1)).toMatchObject({ stageKind: 'body_window', state: 'failed', committed: 0 });
    const reopened = f.reopen();
    expect(reopened.inspect(failed.journal.runId).nativeOutcomes.at(-1)?.outcome).toMatchObject({ result: { ok: false, durationMs: 150_001 } });
    expect(reopened.resume(failed.journal.runId)).toEqual(failed);
    expect(reopened.prepareGeneration(refs, model, failed.journal.runId)).toEqual(failed);
    expect(f.library.list()).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('reviews zero saved bodies against the full ledger and does not invent a body, approval or association call', async () => {
    const f = setup(); f.body.proposals = [];
    const state = await runAnalyses(f);
    expect(state.journal.bodies).toEqual([]); expect(f.library.list()).toEqual([]); expect(f.dispatched).toEqual(stages.slice(0, 4));
    const status = f.app.sourceCoverageStatus(state.journal.coverageRef!.coverageId);
    expect(status.revision.data.bodyRefs).toEqual([]); expect(status.unresolvedIds!.length).toBeGreaterThan(0); expect(status.decision.status).toBe('not_reviewed');
    recordActualTestDecision(f, state, 'proceed_with_limits');
    expect(state.journal.status).toBe('completed'); expect(state.journal.stages).toHaveLength(2);
    expect(() => f.app.prepareAssociationRebuild([sourceRef(f.window)], [{ knowledgeId: randomUUID(), revisionId: randomUUID(), bodyDigest: `sha256:${'0'.repeat(64)}` }], f.model)).toThrow();
    expect(f.dispatched).toHaveLength(4);
  });

  it.each(['source_ledger', 'source_coverage'] as const)('archives and rejects a %s response that tries to self-approve instead of silently coercing it', async kind => {
    const f = setup(), prepared = await preparePhase(f, kind), stage = prepared.journal.stages.at(-1)!;
    const raw = JSON.stringify({ ...f.output(kind, stage.input) as object, decisionKind: 'proceed_with_limits' });
    f.invoke.mockImplementationOnce(async (profile, _input, _signal, gate) => { gate?.(); f.dispatched.push(profile.stageKind); return { outcomeKind: 'result', result: { ok: true, output: raw } }; });
    const failed = await dispatch(f, prepared);
    expect(failed.journal.status).toBe('failed'); expect(failed.journal.stages.at(-1)?.issues.join(' ')).toContain('wire rejected');
    expect(f.reopen().inspect(failed.journal.runId).nativeOutcomes.at(-1)?.outcome).toMatchObject({ result: { output: raw } });
    const calls = f.dispatched.length; expect(f.app.resume(failed.journal.runId).journal).toEqual(failed.journal);
    expect(f.app.prepareSourceReview([sourceRef(f.window)], failed.journal.bodies, f.model, undefined, failed.journal.runId)).toEqual(f.app.resume(failed.journal.runId)); expect(f.dispatched).toHaveLength(calls);
    expect(f.app.prepareGeneration([sourceRef(f.window)], f.model, randomUUID()).journal.runId).not.toBe(failed.journal.runId);
  });

  it.each(stages)('never redispatches an unknown claimed %s phase', async kind => {
    const f = setup(), prepared = await preparePhase(f, kind), before = f.dispatched.length;
    f.invoke.mockImplementationOnce(async (profile, _input, _signal, gate) => { gate?.(); f.dispatched.push(profile.stageKind); throw new Error('process lost native outcome'); });
    await expect(dispatch(f, prepared)).rejects.toThrow('lost native');
    const reopened = f.reopen(), state = reopened.resume(prepared.journal.runId);
    expect(state.nextAction).toBe('outcome_unknown_do_not_redispatch');
    expect(f.ports.journals.list().archiveChecks.find(check => check.invocationId === prepared.journal.stages.at(-1)!.invocationId)).toMatchObject({ invocationId: prepared.journal.stages.at(-1)!.invocationId, archiveStatus: 'unknown', verificationStatus: 'not_verified' });
    await expect(reopened.continueStage(state.journal.runId, state.journal.generation, f.model)).rejects.toThrow('never-claimed');
    expect(f.dispatched).toHaveLength(before + 1);
  });

  it.each(stages)('archives %s cleanup failure completely and does not publish a successful phase', async kind => {
    const f = setup(), prepared = await preparePhase(f, kind), stage = prepared.journal.stages.at(-1)!;
    const outcome = { outcomeKind: 'result' as const, result: { ok: true, output: JSON.stringify(f.output(kind, stage.input)), extra: { retained: true } }, cleanupFailure: { diagnostic: 'Authored cleanup failure.' } };
    f.invoke.mockImplementationOnce(async (profile, _input, _signal, gate) => { gate?.(); f.dispatched.push(profile.stageKind); return outcome; });
    const result = await dispatch(f, prepared), saved = result.journal.stages.at(-1)!;
    expect(saved.state === 'failed' || saved.issues.length > 0).toBe(true);
    expect(f.reopen().inspect(result.journal.runId).nativeOutcomes.at(-1)?.outcome).toEqual(outcome);
    const calls = f.dispatched.length; f.reopen().resume(result.journal.runId); expect(f.dispatched).toHaveLength(calls);
    if (kind === 'association') expect(f.library.detail(result.journal.bodies[0].knowledgeId).derivedAssociations.status).toBe('failed');
  });

  it.each(['source_ledger', 'body', 'source_coverage'] as const)('replays an acknowledged %s store receipt after interruption without another analysis, revision or model call', async kind => {
    const f = setup(), prepared = await preparePhase(f, kind);
    if (kind === 'source_ledger') {
      const write = f.ports.ledgers.write.bind(f.ports.ledgers);
      vi.spyOn(f.ports.ledgers, 'write').mockImplementationOnce((...args) => { write(...args); throw new Error('after durable publication'); });
    } else if (kind === 'body') {
      const write = f.ports.knowledge.write.bind(f.ports.knowledge);
      vi.spyOn(f.ports.knowledge, 'write').mockImplementationOnce((...args) => { write(...args); throw new Error('after durable publication'); });
    } else {
      const write = f.ports.coverage.write.bind(f.ports.coverage);
      vi.spyOn(f.ports.coverage, 'write').mockImplementationOnce((...args) => { write(...args); throw new Error('after durable publication'); });
    }
    const before = f.dispatched.length; await expect(dispatch(f, prepared)).rejects.toThrow('after durable publication');
    const resumed = f.reopen().resume(prepared.journal.runId); expect(f.dispatched).toHaveLength(before + 1);
    expect(resumed.journal.stages.at(-1)).toMatchObject({ state: 'completed', committed: 1 });
    if (kind === 'body') expect(f.ports.knowledge.read(resumed.journal.bodies[0].knowledgeId).revisions).toHaveLength(1);
    else if (kind === 'source_ledger') expect(f.ports.ledgers.read(resumed.journal.ledgerRef!.ledgerId)!.events).toHaveLength(1);
    else expect(f.ports.coverage.read(resumed.journal.coverageRef!.coverageId)!.events).toHaveLength(1);
    expect(f.reopen().resume(resumed.journal.runId)).toEqual(resumed);
  });

  it('recovers the archived writing draft after completion persistence fails without a second model call or canonical write', async () => {
    const f = setup(), prepared = await preparePhase(f, 'body_draft'), before = f.dispatched.length;
    const write = f.ports.journals.write.bind(f.ports.journals);
    vi.spyOn(f.ports.journals, 'write').mockImplementation((journal, ...args) => {
      if (journal.writingDraftRef) throw new Error('draft completion disk failure');
      return write(journal, ...args);
    });
    await expect(dispatch(f, prepared)).rejects.toThrow('draft completion disk failure');
    const reopened = f.reopen(), recovered = reopened.resume(prepared.journal.runId), stage = recovered.journal.stages.at(-1)!;
    expect(stage).toMatchObject({ stageKind: 'body_draft', state: 'completed', committed: 0 });
    expect(recovered.journal.writingDraftRef).toMatchObject({ invocationId: stage.invocationId, requestDigest: stage.requestDigest, archiveDigest: stage.outcomeRef!.digest });
    expect(f.library.list()).toEqual([]); expect(f.dispatched).toHaveLength(before + 1);
    expect(reopened.resume(recovered.journal.runId)).toEqual(recovered);
    const grounded = reopened.prepareGeneration([sourceRef(f.window)], f.model, recovered.journal.runId);
    expect(JSON.parse(grounded.journal.stages.at(-1)!.input).writingDraft.ref).toEqual(recovered.journal.writingDraftRef);
    expect(() => new FileGenerationJournalStore(join(f.root, 'generation-journals'), f.root).write({ ...grounded.journal,
      generation: grounded.journal.generation + 1, writingDraftRef: { ...grounded.journal.writingDraftRef!, outputDigest: `sha256:${'0'.repeat(64)}` } }, grounded.journal.generation)).toThrow('writing draft reference');
  });

  it('rejects draft-only evidence rather than publishing an ungrounded draft as canonical knowledge', async () => {
    const f = setup(), prepared = await preparePhase(f, 'body');
    f.body.proposals[0].segments[0].evidence[0].startPassageId = 'unverified-draft-only';
    const result = await dispatch(f, prepared);
    expect(result.journal.stages.at(-1)!.rejected).toHaveLength(1);
    expect(result.journal.bodies).toEqual([]); expect(f.library.list()).toEqual([]);
    expect(f.reopen().inspect(result.journal.runId).nativeOutcomes.at(-1)?.outcome).toMatchObject({ result: { output: JSON.stringify(f.body) } });
  });

  it.each([8, 9])('refuses a new workflow10 run in a journal%s workspace without changing the old claim', schemaVersion => {
    const f = setup(), runId = randomUUID(); mkdirSync(join(f.root, 'generation-journals'));
    const path = join(f.root, 'generation-journals', `${runId}.json`), bytes = JSON.stringify({ storeKind: 'knowledge-generation-journal', schemaVersion, unknownClaim: true });
    writeFileSync(path, bytes);
    expect(() => f.app.prepareGeneration([sourceRef(f.window)], f.model)).toThrow('explicit independent-copy');
    expect(readFileSync(path, 'utf8')).toBe(bytes); expect(f.invoke).not.toHaveBeenCalled();
  });

  it('retains a returned native outcome under archive backpressure and resumes without another dispatch', async () => {
    const f = setup(), prepared = f.app.prepareGeneration([sourceRef(f.window)], f.model);
    vi.spyOn(f.ports.journals, 'archive').mockImplementationOnce(() => { throw new Error('archive disk failure'); });
    await expect(dispatch(f, prepared)).rejects.toThrow('archive disk failure'); expect(f.dispatched).toEqual(['body_draft']);
    expect(f.library.list()).toEqual([]); expect(f.ports.ledgers.read(randomUUID())).toBeUndefined();
    const recovered = f.app.resume(prepared.journal.runId); expect(recovered.journal.writingDraftRef).toBeDefined(); expect(recovered.journal.bodies).toEqual([]);
    expect(f.reopen().inspect(recovered.journal.runId).nativeOutcomes[0].outcome).toMatchObject({ result: { opaqueNestedField: { preserved: ['original', 1] } } });
    expect(f.dispatched).toHaveLength(1);
  });

  it('rejects a producer over archive capacity before creating a journal, and respects a permission refusal before claiming association', async () => {
    const f = setup(), id = randomUUID(), inspect = f.model.inspect;
    f.model.inspect = (profile, input) => ({ ...inspect(profile, input), maxOutcomeJsonBytes: 1024 ** 4 });
    expect(() => f.app.prepareGeneration([sourceRef(f.window)], f.model, id)).toThrow('archive capacity'); expect(f.ports.journals.read(id)).toBeUndefined();
    f.model.inspect = inspect;
    const prepared = await preparePhase(f, 'association'), calls = f.dispatched.length;
    await expect(dispatch(f, prepared, f.model, { beforeDispatch() { throw new Error('phase quota exhausted'); } })).rejects.toThrow('phase quota exhausted');
    const state = f.app.inspect(prepared.journal.runId); expect(state.journal.stages.at(-1)?.state).toBe('prepared'); expect(f.dispatched).toHaveLength(calls);
    expect(f.ports.journals.list().archiveChecks.find(check => check.invocationId === prepared.journal.stages.at(-1)!.invocationId)).toMatchObject({ archiveStatus: 'not_recorded' });
    expect((await dispatch(f, state)).journal.status).toBe('completed');
  });

  it('rechecks complete sources under the claim lock and refuses a newly unavailable source without dispatch', async () => {
    const f = setup(), body = await runBodies(f), prepared = f.app.prepareAssociationRebuild([sourceRef(f.window)], body.journal.bodies, f.model), before = f.dispatched.length;
    const read = f.ports.sources.read.bind(f.ports.sources), lockedReads: boolean[] = [];
    vi.spyOn(f.ports.sources, 'read').mockImplementation((...args) => {
      const locked = existsSync(join(f.root, '.knowledge-write.lock')); lockedReads.push(locked);
      return locked ? { status: 'unavailable', reason: 'deleted', detail: 'Source disappeared before claim.' } : read(...args);
    });
    await expect(dispatch(f, prepared)).rejects.toThrow('source unavailable');
    expect(lockedReads).toContain(true); expect(f.dispatched).toHaveLength(before);
    const state = f.app.inspect(prepared.journal.runId); expect(state.journal.stages.at(-1)?.state).toBe('prepared'); expect(state.nativeOutcomes.at(-1)).not.toHaveProperty('outcome');
  });

  it('keeps optional source-review decisions independent of explicitly requested pending associations', async () => {
    const f = setup(), reviewed = await runAnalyses(f), decision = recordActualTestDecision(f, reviewed, 'proceed_with_limits');
    const prepared = f.app.prepareAssociationRebuild([sourceRef(f.window)], reviewed.journal.bodies, f.model);
    const result = await dispatch(f, prepared, f.model, { onOutcomeArchived(event) {
      expect(event.stageKind).toBe('association'); expect(event.ref.digest).toMatch(/^sha256:/); revokeActualTestDecision(f, decision);
    } });
    expect(result.journal).not.toHaveProperty('sourceCoverageDecisionRef'); expect(result.journal.status).toBe('completed');
    expect(f.library.detail(result.journal.bodies[0].knowledgeId).derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending' });
    expect(f.app.sourceCoverageStatus(decision.coverageRef.coverageId).decision.status).toBe('not_reviewed');
    expect(f.reopen().inspect(result.journal.runId).nativeOutcomes.at(-1)).toHaveProperty('outcome'); expect(f.dispatched).toEqual(stages);
  });

  it.each(['claimed', 'completed'] as const)('reads a %s rebuild again without treating its historical request as unsent', async state => {
    const f = setup(), { ref, second, prepared } = await prepareTwoSourceRebuildWithActualReview(f), sources = [sourceRef(f.window), sourceRef(second)];
    if (state === 'claimed') {
      f.invoke.mockImplementationOnce(async (profile, _input, _signal, gate) => { gate?.(); f.dispatched.push(profile.stageKind); throw new Error('lost rebuild outcome'); });
      await expect(dispatch(f, prepared)).rejects.toThrow('lost rebuild outcome');
    } else await dispatch(f, prepared);
    const before = f.app.resume(prepared.journal.runId), calls = f.dispatched.length;
    const phase = before.journal.stages[0], bytes = state === 'completed' ? readFileSync(archivePath(f, before.journal, phase)) : undefined;
    const reopened = f.reopen();
    expect(reopened.prepareAssociationRebuild(sources, [ref], f.model, before.journal.runId).journal).toEqual(before.journal);
    expect(await reopened.rebuild(sources, [ref], f.model, before.journal.runId)).toEqual(before);
    expect(f.dispatched).toHaveLength(calls);
    if (bytes) expect(readFileSync(archivePath(f, before.journal, phase))).toEqual(bytes);
    else expect(before.nextAction).toBe('outcome_unknown_do_not_redispatch');
  });

  it('rejects empty, duplicate or unavailable rebuild bodies before creating another journal or invoking a model', async () => {
    const f = setup(), state = await runBodies(f);
    const ref = state.journal.bodies[0], calls = f.dispatched.length, journals = f.ports.journals.list().current.length;
    for (const bodyRefs of [[], [ref, ref], [{ ...ref, revisionId: randomUUID() }]]) {
      expect(() => f.app.prepareAssociationRebuild([sourceRef(f.window)], bodyRefs, f.model)).toThrow(/distinct exact|body identity mismatch/);
      expect(f.dispatched).toHaveLength(calls); expect(f.ports.journals.list().current).toHaveLength(journals);
    }
    const first = f.library.detail(ref.knowledgeId);
    const revised = f.library.revise(ref.knowledgeId, ref.revisionId, first.history.generation, {
      title: first.revision.title, content: first.revision.content,
      reuseRationale: `${first.revision.reuseRationale} Maintained revision.`,
    }, 'Authored second revision with the same source evidence.');
    const revisions = [ref, knowledgeBodyRef(revised.revision)];
    const before = { calls: f.dispatched.length, journals: f.ports.journals.list().current.length };
    expect(() => f.app.prepareAssociationRebuild([sourceRef(f.window)], revisions, f.model)).toThrow('one revision per knowledge identity');
    expect(f.dispatched).toHaveLength(before.calls); expect(f.ports.journals.list().current).toHaveLength(before.journals);
  });

  it('requires an actual actor and exact CAS for optional source decisions without using them as association approval', async () => {
    const f = setup(), state = await runAnalyses(f), decision = recordActualTestDecision(f, state, 'needs_revision');
    expect(f.app.prepareAssociationRebuild([sourceRef(f.window)], state.journal.bodies, f.model).journal).toMatchObject({ mode: 'rebuild_associations', stages: [{ stageKind: 'association', state: 'prepared' }] });
    const readonly = new BodyGenerationApplication({ ...f.ports, reviewActor: undefined });
    expect(() => recordActualTestDecision({ ...f, app: readonly }, state, 'proceed_with_limits')).toThrow('trusted actual');
    const history = f.ports.coverage.read(state.journal.coverageRef!.coverageId)!;
    expect(() => f.app.reviewSourceCoverage({ commandKind: 'revoke_decision', coverageId: history.coverageId, requestId: randomUUID(),
      expectedGeneration: history.generation - 1, expectedHeadEventId: history.writeHeadEventId, targetEventId: decision.eventId, reason: 'Stale actual write.' })).toThrow('revision conflict');
    expect(f.dispatched).toEqual(stages.slice(0, 4));
  });

  it('preserves a full authorized source set through revise, coverage-only review and rebuild even when one source has no body citation', async () => {
    const f = setup(), second = captureTraceFixture(f.root, { path: join(f.root, 'second.jsonl'), records: [{ recordIndex: 0,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Beta is an independently selected, uncited source.' }] } }) }] });
    Object.assign(f.body.proposals[0].segments[0].evidence[0],
      passageRange(bodySourcePassages([second, f.window]).index, f.window.excerpts[0].evidenceRef, 'Alpha'));
    const refs = [sourceRef(second), sourceRef(f.window)], state = await runAnalyses(f, f.model, undefined, refs);
    const reordered = f.app.prepareGeneration([...refs].reverse(), f.model); expect(reordered.journal.bodies).toEqual(state.journal.bodies);
    recordActualTestDecision(f, state, 'proceed_with_limits');
    f.association.catalogs = sourceSetPreimage(refs).sources.map((_, index) => ({ sourceKey: `s${index}`, entities: [] }));
    await dispatch(f, f.app.prepareAssociationRebuild(refs, state.journal.bodies, f.model));
    const original = f.library.detail(state.journal.bodies[0].knowledgeId);
    const draft = { title: original.revision.title, content: structuredClone(original.revision.content), reuseRationale: original.revision.reuseRationale };
    draft.content.segments[0].evidence[0].selection.quote = 'wrong';
    expect(() => f.library.revise(original.revision.knowledgeId, original.revision.revisionId, original.history.generation, draft, 'Invalid source replacement')).toThrow('evidence');
    draft.content = structuredClone(original.revision.content); draft.content.segments[0].text += ' This maintained revision still has no evidence of behavior elsewhere.';
    const revised = f.library.revise(original.revision.knowledgeId, original.revision.revisionId, original.history.generation, draft, 'Explicit bounded revision'), ref = knowledgeBodyRef(revised.revision);
    expect(revised.derivedAssociations.status).toBe('stale');
    const beforeInvalid = { calls: f.dispatched.length, journals: f.ports.journals.list().current.length };
    expect(() => f.app.prepareAssociationRebuild([sourceRef(second)], [ref], f.model)).toThrow('Association sources omit a body evidence source');
    expect(f.dispatched).toHaveLength(beforeInvalid.calls); expect(f.ports.journals.list().current).toHaveLength(beforeInvalid.journals);
    expect(() => f.app.prepareSourceReview([sourceRef(f.window)], [ref], f.model, state.journal.ledgerRef)).toThrow('manifest mismatch');
    const review = f.app.prepareSourceReview(refs, [ref], f.model, state.journal.ledgerRef);
    expect(review.journal).toMatchObject({ mode: 'review_sources', bodies: [ref], stages: [{ stageKind: 'source_coverage', state: 'prepared' }] });
    const reviewed = await dispatch(f, review); recordActualTestDecision(f, reviewed, 'proceed_with_limits');
    f.association.catalogs = sourceSetPreimage(refs).sources.map((_, index) => ({ sourceKey: `s${index}`, entities: [] }));
    const rebuild = f.app.prepareAssociationRebuild(refs, [ref], f.model), input = JSON.parse(rebuild.journal.stages[0].input);
    expect(input.sources.map((source: { source: SourceRef }) => ({ snapshotId: source.source.snapshotId, sourceVersion: source.source.sourceVersion }))).toEqual(sourceSetPreimage(refs).sources);
    const done = await dispatch(f, rebuild); expect(done.journal.status).toBe('completed');
    expect(f.library.detail(ref.knowledgeId, original.revision.revisionId).revision).toEqual(original.revision);
    expect(f.library.detail(ref.knowledgeId).derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending' });
    expect(f.dispatched).toEqual(['body_draft', 'body', 'source_ledger', 'source_coverage', 'association', 'source_coverage', 'association']);
  });

  it('replays an interrupted second catalog publication without merging identities or adding another native call', async () => {
    const f = setup(), { ref, bodyFile, bodyBytes, prepared } = await prepareTwoSourceRebuildWithActualReview(f), before = f.dispatched.length;
    const write = f.ports.entities.write.bind(f.ports.entities); let published = 0;
    vi.spyOn(f.ports.entities, 'write').mockImplementation((...args) => { const receipt = write(...args); if (++published === 2) throw new Error('second catalog acknowledgement interrupted'); return receipt; });
    await expect(dispatch(f, prepared)).rejects.toThrow('acknowledgement interrupted'); expect(f.dispatched).toHaveLength(before + 1);
    const saved = f.ports.journals.read(prepared.journal.runId)!; expect(saved.stages[0].committed).toBe(1); expect(saved.stages[0].entityWrites).toHaveLength(2);
    const done = f.reopen().resume(saved.runId), detail = f.library.detail(ref.knowledgeId), projection = detail.derivedAssociations.revision!;
    expect(done.journal.status).toBe('completed'); expect(f.dispatched).toHaveLength(before + 1);
    expect(projection.catalogRefs).toHaveLength(2); expect(new Set(projection.segmentEntityRefs.map(value => value.entityId)).size).toBe(2);
    for (const intent of done.journal.stages[0].entityWrites!) expect(f.ports.entities.read(intent.analysisId).revisions).toHaveLength(1);
    expect(readFileSync(bodyFile)).toEqual(bodyBytes); expect(f.library.detail(ref.knowledgeId).derivedAssociations.reviewStatus).toBe('pending');
  });

  it.each(['native_failure', 'duplicate_mention_position'] as const)('keeps body and full originals after %s without publishing a misleading partial projection', async failure => {
    const f = setup(), { ref, second, bodyFile, bodyBytes, prepared } = await prepareTwoSourceRebuildWithActualReview(f), before = f.dispatched.length;
    const rejected = f.association.catalogs.find(catalog => catalog.entities[0].mentions[0].selection.evidenceRef === second.excerpts[0].evidenceRef)!;
    rejected.entities[0].mentions.push({ ...rejected.entities[0].mentions[0], mentionKey: 'duplicate-position' });
    const outcome = { outcomeKind: 'result' as const, result: { ok: failure !== 'native_failure', output: failure === 'native_failure' ? '' : JSON.stringify(f.association), originalDiagnostic: { preserved: true } } };
    f.invoke.mockImplementationOnce(async (profile, _input, _signal, gate) => { gate?.(); f.dispatched.push(profile.stageKind); return outcome; });
    const result = await dispatch(f, prepared), detail = f.library.detail(ref.knowledgeId), phase = result.journal.stages[0];
    expect(detail.derivedAssociations).toMatchObject({ status: 'failed', reviewStatus: 'pending', revision: { catalogRefs: [], segmentEntityRefs: [] } });
    expect(phase.entityWrites ?? []).toHaveLength(failure === 'native_failure' ? 0 : 1);
    if (failure !== 'native_failure') expect(f.ports.entities.read(phase.entityWrites![0].analysisId).snapshotId).toBe(f.window.snapshotId);
    expect(f.reopen().inspect(result.journal.runId).nativeOutcomes[0].outcome).toEqual(outcome);
    expect(f.reopen().resume(result.journal.runId).journal).toEqual(result.journal); expect(f.dispatched).toHaveLength(before + 1); expect(readFileSync(bodyFile)).toEqual(bodyBytes);
  });

  it('preserves a maximum-length abstention reason and exact segment identity in the persisted projection and raw archive', async () => {
    const f = setup(), segmentId = 's'.repeat(256), reason = '界'.repeat(32768);
    f.body.proposals[0].segments[0].segmentId = segmentId;
    f.association.associations[0].segmentDecisions = [{ segmentId, decisionKind: 'abstained', entityRefs: [], reason }];
    const result = await generateWithActualTestReview(f), detail = f.library.detail(result.journal.bodies[0].knowledgeId);
    expect(detail.derivedAssociations.revision?.issues).toEqual([`AI association abstained for ${segmentId}; reason follows.`, reason]);
    expect(f.reopen().inspect(result.journal.runId).nativeOutcomes[0].outcome).toMatchObject({ result: { output: JSON.stringify(f.association) } });
    expect(f.reopen().resume(result.journal.runId)).toEqual(result); expect(f.dispatched).toEqual(stages);
  });

  it('records a failed association when the requested semantic projection is missing without editing the body or replaying the call', async () => {
    const f = setup(), prepared = await preparePhase(f, 'association');
    f.association.associations[0].typedRelations = null;
    const bodyFiles = readdirSync(join(f.root, 'items')).map(file => join(f.root, 'items', file));
    const before = bodyFiles.map(file => readFileSync(file));
    const result = await dispatch(f, prepared), detail = f.library.detail(result.journal.bodies[0].knowledgeId);
    expect(detail.derivedAssociations).toMatchObject({ status: 'failed', revision: { issues: ['Requested typed relation projection was not returned.'] } });
    expect(bodyFiles.map(file => readFileSync(file))).toEqual(before);
    expect(f.reopen().inspect(result.journal.runId).nativeOutcomes[0].outcome).toMatchObject({ result: { output: JSON.stringify(f.association) } });
    expect(f.reopen().resume(result.journal.runId)).toEqual(result); expect(f.dispatched).toEqual(stages);
  });

  it('uses the real producer, retains every native field and reads two bodies through a subject in an uncited excerpt', async () => {
    expect(BODY_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-body-generation/v20', outputName: 'knowledge_body_v3',
      profileId: 'sha256:9170f3c707305a5b970628bb16ae0e3d4a2286ee2f23c35885e48020426ca189',
      wireId: 'sha256:bc3089693087eb4eef0a03cfc141a0c6eabb8e7b838526228d22c689fb4b797d' });
    expect(ASSOCIATION_GENERATION_PROFILE).toMatchObject({ promptVersion: 'knowledge-association-generation/v9',
      profileId: 'sha256:a5c24a7183d5bc5291479eb28561e4419aaafa63fa7a1888c8b276baf20eac91',
      wireId: 'sha256:2c9acd3fc02d852587b89dc6fa8c5b6d91c0bea41073ebaa0a64bbad066fa226' });
    const f = setup(true), proposal = f.body.proposals[0], evidence = { ...proposal.segments[0].evidence[0],
      ...passageRange(bodySourcePassages([f.window]).index, f.window.excerpts[1].evidenceRef, f.window.excerpts[1].text) };
    f.body.proposals = [{ ...proposal, proposalId: 'p1', segments: [{ ...proposal.segments[0], text: 'Alpha works only in this test.', evidence: [evidence] }] },
      { ...proposal, proposalId: 'p2', segments: [{ ...proposal.segments[0], text: 'Alpha in other environments remains unknown.', evidence: [evidence] }] }];
    f.association.catalogs = [{ sourceKey: 's0', entities: [{ entityId: 'e1', label: 'Alpha', description: 'Source-local fixture subject.', qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
      referentKind: 'object', componentLink: null, collectionLink: null, mentions: [{ mentionKey: 'm1', selection: { evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'Alpha', contextBefore: null, contextAfter: null }, basis: 'explicit', rationale: 'Exact own mention in the uncited excerpt.' }] }] }];
    f.association.associations = ['b0', 'b1'].map(bodyKey => ({ bodyKey, segmentDecisions: [{ segmentId: 's1', decisionKind: 'mapped', entityRefs: [{ sourceKey: 's0', entityId: 'e1', mentionKeys: ['m1'] }], reason: 'The paragraph discusses the exact source-local subject.' }], typedRelations: [{ relationId: 'r1', segmentIds: ['s1'], subject: { sourceKey: 's0', entityId: 'e1' }, object: null,
      relation: bodyKey === 'b0' ? 'works only in this test' : 'other environments remain unknown', modality: 'descriptive', polarity: 'positive',
      evidence: [{ segmentId: 's1', evidenceIndex: 0 }], issues: [] }], issues: [] }));
    const paths: string[] = [], execute = vi.fn(async request => {
      paths.push(request.cwd); expect(request.cwd).toMatch(/omk-knowledge-text-[A-Za-z0-9]{6}$/); expect(request.timeoutMs).toBe(300000);
      if (request.outputFormat.name.includes('association')) expect(request.system).toContain(KNOWLEDGE_RECORD_SCOPE_POLICY);
      const kind = request.outputFormat.name.includes('source_ledger') ? 'source_ledger' : request.outputFormat.name.includes('source_coverage') ? 'source_coverage' : request.outputFormat.name.includes('body_draft') ? 'body_draft' : request.outputFormat.name.includes('association') ? 'association' : 'body';
      return { ok: true, output: JSON.stringify(f.output(kind, request.prompt)), opaqueNestedField: { preserved: ['original', 1] } } as unknown as ExecResult;
    });
    const model = configuredKnowledgeGenerationModel('codex', 'fixture-model', createCodexArchiveProducer({}, () => execute));
    const body = await runBodies(f, model), prepared = f.app.prepareAssociationRebuild([sourceRef(f.window)], body.journal.bodies, model);
    const result = await dispatch(f, prepared, model), detail = f.library.detail(result.journal.bodies[0].knowledgeId);
    expect(execute).toHaveBeenCalledTimes(3); expect(paths.every(path => !existsSync(path))).toBe(true); expect(result.journal.bodies).toHaveLength(2);
    const projection = detail.derivedAssociations.revision!, entityId = projection.segmentEntityRefs[0].entityId;
    expect(f.library.entityDetail(projection.catalogRefs[0].analysisId, entityId).knowledge.map(item => item.knowledgeId).sort()).toEqual(result.journal.bodies.map(ref => ref.knowledgeId).sort());
    for (const ref of result.journal.bodies) {
      const saved = f.library.detail(ref.knowledgeId); expect(saved.derivedAssociations.reviewStatus).toBe('pending'); expect(saved.maintenance).toBeNull();
      expect(saved.revision.content.segments[0].evidence[0].selection.quote).not.toContain('Alpha');
      expect(saved.derivedCatalogs[0]).not.toHaveProperty('source');
      const projected = saved.derivedAssociations.revision!;
      expect(projected.typedRelations).toEqual([expect.objectContaining({ subject: { ...projected.catalogRefs[0], entityId },
        relation: ref === result.journal.bodies[0] ? 'works only in this test' : 'other environments remain unknown',
        evidence: [saved.revision.content.segments[0].evidence[0]] })]);
    }
    for (const original of f.reopen().inspect(result.journal.runId).nativeOutcomes) expect(original.outcome).toMatchObject({ result: { opaqueNestedField: { preserved: ['original', 1] } } });
  });

  it('keeps archive inventory observations unverified and refuses same-size corruption or missing originals during full recovery', async () => {
    const f = setup(), result = await generateWithActualTestReview(f), decode = vi.spyOn(f.ports.journals, 'outcome');
    expect(f.ports.journals.list().archiveChecks.filter(check => check.runId === result.journal.runId)).toEqual(result.journal.stages.map(stage => expect.objectContaining({ invocationId: stage.invocationId, archiveStatus: 'present', verificationStatus: 'not_verified' })));
    expect(decode).not.toHaveBeenCalled();
    const first = result.journal.stages[0], path = archivePath(f, result.journal, first), bytes = readFileSync(path, 'utf8');
    writeFileSync(path, bytes.replace('knowledge-generation-native', 'knowledge-generation-broken'));
    expect(f.ports.journals.list().archiveChecks.find(check => check.runId === result.journal.runId)).toMatchObject({ archiveStatus: 'present', verificationStatus: 'not_verified' });
    expect(() => f.reopen().inspect(result.journal.runId)).toThrow('digest mismatch'); expect(() => f.reopen().resume(result.journal.runId)).toThrow('digest mismatch');
    writeFileSync(path, bytes); rmSync(path);
    expect(f.ports.journals.list().archiveChecks.find(check => check.runId === result.journal.runId)!.archiveStatus).toBe('missing'); expect(() => f.reopen().resume(result.journal.runId)).toThrow('missing');
    expect(f.dispatched).toEqual(stages);
  });

  it('lists corrupt identities separately and refuses journal3, journal6, journal7 and journal8 in every state without decoding its native archive or replaying writes', async () => {
    const f = setup(), prepared = f.app.prepareGeneration([sourceRef(f.window)], f.model), root = join(f.root, 'generation-journals');
    writeFileSync(join(root, 'bad-name.json'), '{}'); const corrupt = randomUUID(); writeFileSync(join(root, `${corrupt}.json`), '{broken');
    const decoder = vi.spyOn(f.ports.journals, 'outcome');
    for (const state of ['prepared', 'claimed', 'archived', 'prepared_writes', 'completed', 'failed']) for (const schemaVersion of [3, 6, 7, 8]) {
      const id = randomUUID(), invocationId = randomUUID(), legacyPath = join(root, `${id}.json`), legacyArchive = join(root, 'outcomes', id, `${invocationId}.json`);
      const legacy = JSON.stringify({ ...prepared.journal, runId: id, schemaVersion, workflowId: `knowledge-body-first/v${schemaVersion}`, inputVersion: 'knowledge-source-generation-input/v1', stages: [{ ...prepared.journal.stages[0], stageKind: 'body', invocationId, state }] });
      mkdirSync(join(root, 'outcomes', id), { recursive: true }); writeFileSync(legacyArchive, '{original-legacy-native-bytes'); writeFileSync(legacyPath, legacy);
      expect(() => f.ports.journals.read(id)).toThrow('knowledge_storage_unsupported'); expect(() => f.app.inspect(id)).toThrow('knowledge_storage_unsupported'); expect(() => f.app.resume(id)).toThrow('knowledge_storage_unsupported');
      await expect(f.app.continueStage(id, 1, f.model)).rejects.toThrow('knowledge_storage_unsupported');
      expect(readFileSync(legacyPath, 'utf8')).toBe(legacy); expect(readFileSync(legacyArchive, 'utf8')).toBe('{original-legacy-native-bytes');
    }
    const inventory = f.ports.journals.list(); expect(inventory.current).toEqual([prepared.journal]); expect(inventory.unsupported).toHaveLength(24);
    expect(inventory.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'bad-name', reason: 'invalid_identity' }), expect.objectContaining({ runId: corrupt, reason: 'unreadable' })]));
    expect(decoder).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled(); expect(f.library.list()).toEqual([]);
  });
});
