import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication, type ExtractionGenerationOptions, type KnowledgeApplicationPorts } from '../../src/knowledge/application/application.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { STRICT_EXTRACTION_PROMPT } from '../../src/knowledge/extraction/strict-prompt.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../../src/knowledge/extraction/model-wire.js';
import { ENTITY_ONLY_EXTRACTION_PROFILE, ENTITY_ONLY_EXTRACTION_PROMPT,
  ENTITY_ONLY_EXTRACTION_PROMPT_VERSION, ENTITY_ONLY_EXTRACTION_SYSTEM_DIGEST } from '../../src/knowledge/extraction/entity-only-prompt.js';
import { boundedExtractionPolicy } from '../../src/knowledge/extraction/generation-policy.js';
import { ExtractionRunSchema, type ExtractionRun } from '../../src/knowledge/extraction/runs.js';
import type { ExtractionPromptProfile } from '../../src/knowledge/extraction/generation.js';
import { extractionModelInput } from '../../src/knowledge/extraction/model-input.js';
import { boundKnowledgeExecution, boundKnowledgeRequestDigest, BoundKnowledgeReceiptSchema,
  type BoundKnowledgeReceipt, type BoundKnowledgeArchivePort } from '../../src/knowledge/extraction/bound-knowledge-evidence.js';
import { entityReviewExecution, entityReviewRequestDigest, EntityReviewReceiptSchema,
  type EntityReviewReceipt, type EntityReviewArchivePort } from '../../src/knowledge/extraction/entity-review-evidence.js';
import { reviewedKnowledgeExecution, reviewedKnowledgeRequestDigest, ReviewedKnowledgeReceiptSchema,
  type ReviewedKnowledgeReceipt, type ReviewedKnowledgeArchivePort } from '../../src/knowledge/extraction/reviewed-knowledge-evidence.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';
import { buildEntityFirstBoundKnowledge } from '../../scripts/bench/assets/entity-first-bound-knowledge-v1/profile.js';
import { nativeStudyFixture, studyNativeResult } from './extraction-study-fixtures.js';
import { draft, wireModelWindow } from './fixtures.js';

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

function entityFixture(entityChange?: (value: ReturnType<typeof wireModelWindow>) => void, entityOnly = true) {
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
  return { ...f, app, ports, model, window, runId };
}
async function setup(entityChange?: (value: ReturnType<typeof wireModelWindow>) => void, entityOnly = true,
  promptProfile: ExtractionPromptProfile = profile) {
  const f = entityFixture(entityChange, entityOnly);
  const run = await f.app.generate(f.window.snapshotId, f.model, f.runId, undefined, { promptProfile });
  return { ...f, run };
}

async function preparedEntityOnlyFixture() {
  const f = entityFixture();
  const write = vi.spyOn(f.ports.entities, 'write').mockImplementationOnce(() => { throw new Error('Authored interrupted entity publication.'); });
  await expect(f.app.generate(f.window.snapshotId, f.model, f.runId, undefined, {
    promptProfile: ENTITY_ONLY_EXTRACTION_PROFILE,
  })).rejects.toThrow('Authored interrupted entity publication.');
  write.mockRestore();
  const run = f.ports.runs.read(f.runId);
  expect(run.status).toBe('prepared'); expect(run.intents).toEqual([]);
  expect(f.ports.entities.list().histories).toEqual([]); expect(f.app.list()).toEqual([]);
  return { ...f, run };
}

/** Authored prior-bug states bypass manifest publication only; schema and archive readers remain real. */
function writePreparedFixture(f: ReturnType<typeof entityFixture>, run: ExtractionRun) {
  writeFileSync(join(f.workspace, 'extraction-runs', `${f.runId}.json`), JSON.stringify(ExtractionRunSchema.parse(run)));
  return f.ports.runs.read(f.runId);
}

function unexpectedKnowledgeIntent(f: Awaited<ReturnType<typeof preparedEntityOnlyFixture>>): ExtractionRun['intents'][number] {
  const analysis = f.run.entityAnalysis!.revision, actor = analysis.revisedBy, evidenceRef = f.window.excerpts[0].evidenceRef;
  const candidate = JSON.parse(JSON.stringify(draft())
    .replaceAll('"project"', JSON.stringify(analysis.entities[0].entityId))
    .replaceAll('"tool"', JSON.stringify(analysis.entities[1].entityId)).replaceAll('record-1', evidenceRef)) as ReturnType<typeof draft>;
  const revisionId = randomUUID();
  return { requestId: randomUUID(), revision: { ...candidate, knowledgeId: randomUUID(), revisionId,
    observationRefs: [], derivations: [], createdAt: analysis.revisedAt, revisedAt: analysis.revisedAt,
    createdBy: actor, revisedBy: actor, revisionReason: 'Authored unexpected prepared intent, not model evidence.' },
  grounding: { revisionId, mentions: analysis.mentions, identityUncertainties: [], reuseRationale: 'Authored unexpected intent.',
    citations: [{ evidenceLinkId: 'link', selection: { evidenceRef, start: 0, end: 13, quote: 'Alpha 使用 Beta' } }],
    entityAnalysisRef: { analysisId: f.runId, revisionId: analysis.revisionId },
    sourceBindings: [{ snapshotId: f.window.snapshotId, sourceVersion: f.window.sourceVersion, evidenceRefs: [evidenceRef] }] } };
}

describe('fixed entity-only extraction task (authored native returns)', () => {
  it('publishes the actual E-only revision and exposes it to the subsequent bound-knowledge task', async () => {
    const f = await setup(undefined, true, ENTITY_ONLY_EXTRACTION_PROFILE), initial = f.ports.entities.read(f.runId);
    const context = f.app.boundKnowledgeContext(f.runId, f.model, ENTITY_ONLY_EXTRACTION_PROFILE);
    expect(f.run).toMatchObject({ status: 'completed', promptVersion: ENTITY_ONLY_EXTRACTION_PROMPT_VERSION, intents: [], committed: [] });
    expect(f.run.attempts).toHaveLength(1); expect(f.run.attempts[0].request.systemDigest).toBe(ENTITY_ONLY_EXTRACTION_SYSTEM_DIGEST);
    expect(f.effects).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      system: ENTITY_ONLY_EXTRACTION_PROMPT, prompt: extractionModelInput(f.window),
    }));
    expect(initial.revisions).toHaveLength(1); expect(initial.revisions[0].entities).toHaveLength(2);
    expect(initial.revisions[0].mentions).toHaveLength(2);
    expect(context.catalog.entities).toEqual(initial.revisions[0].entities);
    expect(context.catalog.mentions).toEqual(initial.revisions[0].mentions);
    expect(context.catalog).toMatchObject({ analysisId: f.runId, revisionId: initial.revisions[0].revisionId });
    expect(f.app.list()).toEqual([]); expect(JSON.parse(f.run.rawOutput!).proposals).toEqual([]);
    expect(f.ports.runs.readOutcome(f.runId, f.run.attempts[0].attemptId, f.run.attempts[0].outcome).outcome)
      .toMatchObject({ outcomeKind: 'result', result: { output: f.run.rawOutput } });
  });

  it.each(['valid-proposal', 'invalid-proposal'] as const)(
    'archives %s unchanged but rejects the task before preparing or publishing anything', async mode => {
      const f = entityFixture(output => { if (mode === 'invalid-proposal') output.proposals = [null] as never; }, false);
      const entityWrite = vi.spyOn(f.ports.entities, 'write'), knowledgeWrite = vi.spyOn(f.ports.knowledge, 'write');
      const archived = vi.fn((event: Parameters<NonNullable<ExtractionGenerationOptions['onOutcomeArchived']>>[0]) => {
        expect(f.ports.runs.readOutcome(event.runId, event.attemptId, event.ref).outcome).toEqual(event.outcome);
        expect(entityWrite).not.toHaveBeenCalled(); expect(knowledgeWrite).not.toHaveBeenCalled();
      });
      const run = await f.app.generate(f.window.snapshotId, f.model, f.runId, undefined, {
        promptProfile: ENTITY_ONLY_EXTRACTION_PROFILE, onOutcomeArchived: archived,
      });
      expect(archived).toHaveBeenCalledTimes(1);
      expect(run).toMatchObject({ status: 'failed', intents: [], committed: [],
        attempts: [{ failure: { failureKind: 'entity_only_task_violation', diagnostic: expect.stringContaining('empty proposals') } }] });
      expect(run.entityAnalysis).toBeUndefined(); expect(JSON.parse(run.rawOutput!).proposals).toHaveLength(1);
      const attempt = run.attempts[0], original = f.ports.runs.readOutcome(f.runId, attempt.attemptId, attempt.outcome);
      expect(original.outcome).toMatchObject({ outcomeKind: 'result', result: { output: run.rawOutput } });
      const restarted = new KnowledgeApplication(f.ports);
      expect(restarted.resume(f.runId)).toEqual(run);
      expect(await restarted.generate(f.window.snapshotId, f.model, f.runId, undefined, {
        promptProfile: ENTITY_ONLY_EXTRACTION_PROFILE,
      })).toEqual(run);
      expect(f.ports.runs.readOutcome(f.runId, attempt.attemptId, attempt.outcome)).toEqual(original);
      expect(entityWrite).not.toHaveBeenCalled(); expect(knowledgeWrite).not.toHaveBeenCalled();
      expect(f.ports.entities.list().histories).toEqual([]); expect(f.app.list()).toEqual([]);
      expect(f.effects).toHaveBeenCalledTimes(1);
    });

  it.each([false, true])('resumes an archived cancellation without another invocation (nonempty proposals: %s)', async nonempty => {
    const f = entityFixture(undefined, !nonempty), controller = new AbortController();
    const entityWrite = vi.spyOn(f.ports.entities, 'write'), knowledgeWrite = vi.spyOn(f.ports.knowledge, 'write');
    const cancelled = await f.app.generate(f.window.snapshotId, f.model, f.runId, controller.signal, {
      promptProfile: ENTITY_ONLY_EXTRACTION_PROFILE, onOutcomeArchived: () => controller.abort(),
    });
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.entityAnalysis).toBeUndefined();
    expect(entityWrite).not.toHaveBeenCalled(); expect(knowledgeWrite).not.toHaveBeenCalled();
    const attempt = cancelled.attempts[0], original = f.ports.runs.readOutcome(f.runId, attempt.attemptId, attempt.outcome);
    const resumed = new KnowledgeApplication(f.ports).resume(f.runId);
    if (nonempty) {
      expect(resumed).toMatchObject({ status: 'failed', attempts: [{ failure: { failureKind: 'entity_only_task_violation' } }] });
      expect(entityWrite).not.toHaveBeenCalled(); expect(f.ports.entities.list().histories).toEqual([]);
    } else {
      expect(resumed.status).toBe('completed'); expect(entityWrite).toHaveBeenCalledTimes(1);
      expect(f.app.boundKnowledgeContext(f.runId, f.model, ENTITY_ONLY_EXTRACTION_PROFILE).catalog.entities).toHaveLength(2);
    }
    expect(knowledgeWrite).not.toHaveBeenCalled(); expect(f.app.list()).toEqual([]);
    expect(resumed.rawOutput).toBe(cancelled.rawOutput); expect(resumed.attempts[0].outcome).toEqual(attempt.outcome);
    expect(f.ports.runs.readOutcome(f.runId, attempt.attemptId, attempt.outcome)).toEqual(original);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it.each(['prompt-bytes', 'prompt-json', 'missing-mode', 'wrong-wire', 'bounded-policy', 'coverage-review', 'semantic-plan'] as const)(
    'rejects %s before creating a run or dispatching the fixed task', async mode => {
      const f = entityFixture(), model = { ...f.model };
      const options: ExtractionGenerationOptions = { promptProfile: ENTITY_ONLY_EXTRACTION_PROFILE };
      if (mode === 'prompt-bytes') options.promptProfile = { ...ENTITY_ONLY_EXTRACTION_PROFILE, system: ENTITY_ONLY_EXTRACTION_PROMPT + '\n' };
      if (mode === 'prompt-json') model.outputMode = 'prompt-json';
      if (mode === 'missing-mode') delete model.outputMode;
      if (mode === 'wrong-wire') model.wireId = hash('authored wrong wire');
      if (mode === 'bounded-policy') options.policy = boundedExtractionPolicy({
        maxInvocations: 2, maxReasks: 1, profileId: 'loopback-test/v1', maxTotalTokens: 2176, maxOutputTokens: 64,
      });
      if (mode === 'coverage-review') options.coverageReview = { previousRunId: randomUUID() };
      if (mode === 'semantic-plan') options.sourceSemanticPlan = { receiptId: randomUUID(), receiptRef: ref(bytes({ authored: true })) };
      const create = vi.spyOn(f.ports.runs, 'create'), entityWrite = vi.spyOn(f.ports.entities, 'write');
      const knowledgeWrite = vi.spyOn(f.ports.knowledge, 'write');
      await expect(f.app.generate(f.window.snapshotId, model, f.runId, undefined, options)).rejects.toThrow(
        mode === 'prompt-bytes' ? 'A known extraction prompt version cannot identify different bytes.' : 'Entity-only extraction requires');
      expect(create).not.toHaveBeenCalled(); expect(f.effects).not.toHaveBeenCalled(); expect(f.app.runs()).toEqual([]);
      expect(entityWrite).not.toHaveBeenCalled(); expect(knowledgeWrite).not.toHaveBeenCalled();
    });

  it('recovers the genuine prepared empty-proposal outcome without allocating another invocation or revision', async () => {
    const f = await preparedEntityOnlyFixture(), original = f.ports.runs.readOutcome(f.runId, f.run.attempts[0].attemptId, f.run.attempts[0].outcome);
    const restarted = new KnowledgeApplication(f.ports), result = restarted.resume(f.runId);
    expect(result.status).toBe('completed'); expect(result.entityAnalysis).toEqual(f.run.entityAnalysis);
    expect(result.rawOutput).toBe(f.run.rawOutput); expect(result.intents).toEqual([]); expect(result.committed).toEqual([]);
    expect(f.ports.entities.read(f.runId).revisions).toEqual([f.run.entityAnalysis!.revision]);
    expect(restarted.resume(f.runId)).toEqual(result); expect(f.ports.entities.read(f.runId).generation).toBe(1);
    expect(f.ports.runs.readOutcome(f.runId, f.run.attempts[0].attemptId, f.run.attempts[0].outcome)).toEqual(original);
    expect(f.effects).toHaveBeenCalledTimes(1); expect(f.app.list()).toEqual([]);
  });

  it.each(['native-proposals', 'knowledge-intent', 'prompt-hash'] as const)(
    'rechecks %s in an authored prepared state before the first E or K write', async mode => {
      const f = await preparedEntityOnlyFixture();
      const originalAttempt = f.run.attempts[0];
      const original = f.ports.runs.readOutcome(f.runId, originalAttempt.attemptId, originalAttempt.outcome);
      let prepared = structuredClone(f.run);
      if (mode === 'native-proposals') {
        // Reserve another authored sidecar, preserving the actual fixed task request/producer digests.
        // The first native archive remains intact; this fixture does not dispatch a second invocation.
        const attempt = { ...originalAttempt, attemptId: randomUUID() }; delete attempt.outcome; delete attempt.wireDiagnostic;
        const staging = { ...prepared, status: 'generating' as const, attempts: [attempt], selectedAttemptId: undefined,
          rawOutput: undefined, runtime: undefined, entityAnalysis: undefined };
        writePreparedFixture(f, staging);
        const rawOutput = JSON.stringify(wireModelWindow()).replaceAll('record-1', f.window.excerpts[0].evidenceRef);
        const outcome = structuredClone(original.outcome);
        if (outcome.outcomeKind !== 'result') throw new Error('Authored fixture expected a native result.');
        outcome.result.output = rawOutput;
        const outcomeRef = f.ports.runs.writeOutcome(f.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes);
        prepared = { ...prepared, attempts: [{ ...attempt, outcome: outcomeRef }], selectedAttemptId: attempt.attemptId, rawOutput };
      }
      if (mode === 'knowledge-intent') prepared.intents = [unexpectedKnowledgeIntent(f)];
      if (mode === 'prompt-hash') prepared.promptHash = hash('authored wrong prompt hash');
      const admittedFixture = writePreparedFixture(f, prepared);
      if (mode === 'native-proposals') {
        expect(admittedFixture.intents).toEqual([]); expect(JSON.parse(admittedFixture.rawOutput!).proposals).toHaveLength(1);
        expect(admittedFixture.requestDigest).toBe(f.run.requestDigest);
        expect(admittedFixture.attempts[0].requestDigest).toBe(originalAttempt.requestDigest);
        expect(admittedFixture.attempts[0].request).toEqual(originalAttempt.request);
        expect(admittedFixture.attempts[0].producer).toEqual(originalAttempt.producer);
      }
      if (mode === 'knowledge-intent') expect(JSON.parse(admittedFixture.rawOutput!).proposals).toEqual([]);
      const entityWrite = vi.spyOn(f.ports.entities, 'write'), knowledgeWrite = vi.spyOn(f.ports.knowledge, 'write');
      const result = new KnowledgeApplication(f.ports).resume(f.runId);
      expect(result).toMatchObject({ status: 'failed', committed: [], attempts: [{ failure: { failureKind: 'entity_only_task_violation',
        diagnostic: expect.stringContaining(mode === 'native-proposals' ? 'empty proposals' : mode === 'knowledge-intent' ? 'knowledge intents' : 'task identity') } }] });
      expect(result.rawOutput).toBe(admittedFixture.rawOutput); expect(result.intents).toEqual(admittedFixture.intents);
      expect(result.entityAnalysis).toEqual(admittedFixture.entityAnalysis);
      expect(entityWrite).not.toHaveBeenCalled(); expect(knowledgeWrite).not.toHaveBeenCalled();
      expect(f.ports.entities.list().histories).toEqual([]); expect(f.app.list()).toEqual([]);
      expect(f.ports.runs.readOutcome(f.runId, originalAttempt.attemptId, originalAttempt.outcome)).toEqual(original);
      expect(f.effects).toHaveBeenCalledTimes(1);
    });

  it.each(['default-strict30', 'prior-E35'] as const)('does not reinterpret the %s task as entity-only', async mode => {
    const f = entityFixture(undefined, false);
    const result = await f.app.generate(f.window.snapshotId, f.model, f.runId, undefined,
      mode === 'prior-E35' ? { promptProfile: profile } : undefined);
    expect(result.status).toBe('completed'); expect(result.promptVersion).toBe(mode === 'prior-E35' ? profile.promptVersion : 'knowledge-extraction-v30');
    expect(result.intents).toHaveLength(1); expect(result.committed).toHaveLength(1); expect(f.app.list()).toHaveLength(1);
    expect(f.ports.entities.read(f.runId).revisions[0].entities).toHaveLength(2);
    expect(JSON.parse(result.rawOutput!).proposals).toHaveLength(1); expect(f.effects).toHaveBeenCalledTimes(1);
  });
});

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
  const response: Record<string, unknown> = { responseKind: 'bound-knowledge', schemaVersion: 2,
    binding: JSON.parse(execution.request.input).binding, proposals: [proposal], catalogGaps: [],
    materialAccounting: [{ materialId: 'material-1', meaning: 'Authored use claim, not independent verification.',
      anchors: [{ evidenceRef: context.window.excerpts[0].evidenceRef, quote: 'Alpha 使用 Beta', occurrence: null }],
      dispositionKind: 'expressed', statementRefs: [{ proposalId: proposal.proposalId, statementId: 'usage' }],
      reason: null, catalogGapIds: [] }],
    excerptAccounting: [{ evidenceRef: context.window.excerpts[0].evidenceRef, materialIds: ['material-1'], noMaterialReason: null }] };
  change?.(response);
  const receiptId = randomUUID(), attemptId = randomUUID();
  const native = { archiveKind: 'knowledge-bound-knowledge-native', schemaVersion: 1, receiptId, attemptId,
    outcome: { outcomeKind: 'result', result: studyNativeResult(JSON.stringify(response)) } };
  const producer = createOpenAiArchiveProducer({ NODE_ENV: 'test', OPENAI_API_KEY: 'authored-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' });
  const receipt: BoundKnowledgeReceipt = { receiptKind: 'knowledge-bound-knowledge-receipt', schemaVersion: 2,
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
    expect(result).toMatchObject({ proposalAdmissionStatus: 'admitted', coverageStatus: 'declared_only' });
    expect(result.committed).toHaveLength(1);
    expect(result.committed[0].proposalId).toBe('candidate-1');
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
      response.catalogGaps = [{ gapId: 'missing-object', gapKind: 'catalog_blocker', reason: 'Authored unreviewed model gap, not a host classification.',
        anchors: [{ evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'Alpha', occurrence: null }] }];
    });
    const result = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
    expect(result.admissionStatus).toBe('partial'); expect(result.committed).toEqual([]);
    expect(result.evidence.rawOutput).toContain('not in this authored source');
    expect(result.evidence.checked).toMatchObject({ status: 'checked', catalogGaps: [{ gapId: 'missing-object' }] });
    expect(k.app.list()).toEqual([]); expect(f.ports.entities.read(f.runId).revisions).toHaveLength(1);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it.each(['bad-anchor', 'missing-statement', 'unexpressed', 'missing-excerpt'] as const)(
    'commits valid knowledge with %s accounting while preserving unresolved claims and raw evidence', async mode => {
      const f = await setup(), k = knowledgeReturn(f, response => {
        const materials = response.materialAccounting as { anchors: { quote: string }[]; dispositionKind: string;
          statementRefs: { proposalId: string; statementId: string }[]; reason: string | null }[];
        if (mode === 'bad-anchor') materials[0].anchors[0].quote = 'authored quote absent from the source';
        if (mode === 'missing-statement') materials[0].statementRefs[0].statementId = 'not-returned';
        if (mode === 'unexpressed') {
          materials[0].dispositionKind = 'not_expressed'; materials[0].statementRefs = [];
          materials[0].reason = 'Authored unresolved material, not a host finding of missing knowledge.';
        }
        if (mode === 'missing-excerpt') response.excerptAccounting = [];
      });
      const beforeNative = k.nativeBytes(), beforeReceipt = k.receiptBytes();
      const result = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
      expect(result).toMatchObject({ admissionStatus: 'partial', proposalAdmissionStatus: 'admitted',
        coverageStatus: 'unresolved', semanticStatus: 'not_reviewed' });
      expect(result.committed).toHaveLength(1); expect(result.committed[0].proposalId).toBe('candidate-1');
      expect(result.evidence.rawOutput).toBe(k.native.outcome.result.output);
      expect(k.nativeBytes()).toEqual(beforeNative); expect(k.receiptBytes()).toEqual(beforeReceipt);
      expect(f.effects).toHaveBeenCalledTimes(1); expect(f.ports.entities.read(f.runId).revisions).toHaveLength(1);
      expect(k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference).committed).toEqual(result.committed);
      expect(k.app.list()).toHaveLength(1);
    });

  it('keeps invalid gap metadata separate from proposal admission without promoting its scope claim', async () => {
    const f = await setup(), k = knowledgeReturn(f, response => {
      response.catalogGaps = [{ gapId: 'scope', gapKind: 'scope_excluded', reason: 'Authored scope claim, unreviewed.',
        anchors: [{ evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'absent quote', occurrence: null }] }];
    });
    const result = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
    expect(result).toMatchObject({ admissionStatus: 'partial', proposalAdmissionStatus: 'admitted',
      coverageStatus: 'unresolved', semanticStatus: 'not_reviewed' });
    expect(result.committed).toHaveLength(1); expect(f.effects).toHaveBeenCalledTimes(1);
    expect(result.evidence.rawOutput).toContain('absent quote');
  });

  it('reports a closed scope declaration without declaring semantic coverage or a catalog blocker', async () => {
    const f = await setup(), k = knowledgeReturn(f, response => {
      response.catalogGaps = [{ gapId: 'context', gapKind: 'scope_excluded', reason: 'Authored scope declaration awaiting review.',
        anchors: [{ evidenceRef: f.window.excerpts[0].evidenceRef, quote: 'Alpha', occurrence: null }] }];
    });
    const result = k.app.importBoundKnowledge(f.runId, f.model, profile, k.reference);
    expect(result).toMatchObject({ admissionStatus: 'admitted', proposalAdmissionStatus: 'admitted',
      coverageStatus: 'declared_only', semanticStatus: 'not_reviewed' });
    expect(result.committed).toHaveLength(1); expect(f.effects).toHaveBeenCalledTimes(1);
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


function entityReviewReturn(f: Awaited<ReturnType<typeof setup>>, betaStatus: 'supported' | 'unsupported' | 'undetermined' = 'supported') {
  const context = f.app.boundKnowledgeContext(f.runId, f.model, profile), execution = entityReviewExecution(context.window, context.catalog, f.model);
  const response = { responseKind: 'entity-review', schemaVersion: 1, binding: JSON.parse(execution.request.input).binding,
    decisions: context.catalog.entities.map((entity, index) => ({ entityId: entity.entityId,
      qualification: { status: index ? betaStatus : 'supported', reason: 'Authored judgment, not independent acceptance.' },
      referent: { status: 'supported', reason: 'Authored current referent judgment.' }, type: { status: 'supported', reason: 'Authored current type judgment.' },
      mentionIds: context.catalog.mentions.filter(mention => mention.entityId === entity.entityId).map(mention => mention.mentionId),
      evidenceRefs: [context.window.excerpts[0].evidenceRef] })) };
  const receiptId = randomUUID(), attemptId = randomUUID();
  const native = { archiveKind: 'knowledge-entity-review-native', schemaVersion: 1, receiptId, attemptId,
    outcome: { outcomeKind: 'result', result: studyNativeResult(JSON.stringify(response)) } };
  const producer = createOpenAiArchiveProducer({ NODE_ENV: 'test', OPENAI_API_KEY: 'authored-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' });
  const receipt: EntityReviewReceipt = { receiptKind: 'knowledge-entity-review-receipt', schemaVersion: 1, receiptId, attemptId,
    binding: response.binding, request: execution.request,
    producer: EntityReviewReceiptSchema.shape.producer.parse(producer.inspect(f.model.executor, execution.input)),
    requestDigest: '', nativeRef: ref(bytes(native)), startedAt: '2020-02-01T00:00:01Z', finishedAt: '2020-02-01T00:00:02Z' };
  let nativeBytes: Buffer, receiptBytes: Buffer;
  const reseal = () => { nativeBytes = bytes(native); receipt.nativeRef = ref(nativeBytes);
    receipt.requestDigest = entityReviewRequestDigest(receipt); receiptBytes = bytes(receipt); return { receiptId, receiptRef: ref(receiptBytes) }; };
  const reference = reseal();
  const archive: EntityReviewArchivePort = { read: () => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(nativeBytes) }),
    inspect: (...args) => producer.inspect(...args) };
  const app = new KnowledgeApplication({ ...f.ports, entityReviewArchive: archive });
  return { response, native, receipt, reference, reseal, archive, app, selection: { reference, model: f.model },
    receiptBytes: () => Buffer.from(receiptBytes), nativeBytes: () => Buffer.from(nativeBytes) };
}
function reviewedReturn(f: Awaited<ReturnType<typeof setup>>, review: ReturnType<typeof entityReviewReturn>, twoProposals = false) {
  const context = review.app.reviewedKnowledgeContext(f.runId, f.model, profile, review.selection);
  const execution = reviewedKnowledgeExecution(context.window, context.catalog, context.entityReview, f.model);
  const response: Record<string, unknown> = { ...knowledgeReturn(f).response, responseKind: 'reviewed-knowledge', schemaVersion: 1,
    binding: JSON.parse(execution.request.input).binding };
  if (twoProposals) {
    const proposals = response.proposals as ReturnType<typeof wireModelWindow>['proposals'];
    const sibling = structuredClone(proposals[0]); sibling.proposalId = 'alpha-only';
    sibling.entityIds = [context.catalog.entities[0].entityId]; sibling.mentionIds = [context.catalog.mentions[0].mentionId];
    sibling.draft.content.statements[0].object = null; sibling.draft.content.statements[0].relation = '在来源中被提及'; proposals.push(sibling);
  }
  const receiptId = randomUUID(), attemptId = randomUUID();
  const native = { archiveKind: 'knowledge-reviewed-knowledge-native', schemaVersion: 1, receiptId, attemptId,
    outcome: { outcomeKind: 'result', result: studyNativeResult(JSON.stringify(response)) } };
  const producer = createOpenAiArchiveProducer({ NODE_ENV: 'test', OPENAI_API_KEY: 'authored-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' });
  const receipt: ReviewedKnowledgeReceipt = { receiptKind: 'knowledge-reviewed-knowledge-receipt', schemaVersion: 1, receiptId, attemptId,
    binding: JSON.parse(execution.request.input).binding, request: execution.request,
    producer: ReviewedKnowledgeReceiptSchema.shape.producer.parse(producer.inspect(f.model.executor, execution.input)),
    requestDigest: '', nativeRef: ref(bytes(native)), startedAt: '2020-02-01T00:00:03Z', finishedAt: '2020-02-01T00:00:04Z' };
  let nativeBytes: Buffer, receiptBytes: Buffer;
  const reseal = () => { nativeBytes = bytes(native); receipt.nativeRef = ref(nativeBytes);
    receipt.requestDigest = reviewedKnowledgeRequestDigest(receipt); receiptBytes = bytes(receipt); return { receiptId, receiptRef: ref(receiptBytes) }; };
  const reference = reseal();
  const archive: ReviewedKnowledgeArchivePort = { read: () => ({ receiptBytes: Buffer.from(receiptBytes), outcomeBytes: Buffer.from(nativeBytes) }),
    inspect: (...args) => producer.inspect(...args) };
  const app = new KnowledgeApplication({ ...f.ports, entityReviewArchive: review.archive, reviewedKnowledgeArchive: archive });
  return { response, native, receipt, reference, reseal, app, archive };
}

describe('entity review constrained knowledge application (authored native returns)', () => {
  it.each(['unsupported', 'undetermined'] as const)('enforces %s entity usage in actual writes and keeps the authentic E revision and R evidence intact', async status => {
    const f = await setup(), review = entityReviewReturn(f, status), k = reviewedReturn(f, review, true);
    const before = f.ports.entities.read(f.runId), native = review.nativeBytes(), receipt = review.receiptBytes();
    const result = k.app.importReviewedKnowledge(f.runId, f.model, profile, review.selection, k.reference);
    expect(result.committed.map(item => item.proposalId)).toEqual(['alpha-only']);
    expect(result.proposalAdmissionStatus).toBe('partial'); expect(result.semanticStatus).toBe('not_reviewed');
    const saved = k.app.detail(result.committed[0].knowledgeId);
    expect(saved.revision.entities.map(entity => entity.entityId)).toEqual([before.revisions[0].entities[0].entityId]);
    expect(saved.grounding.entityAnalysisRef).toEqual({ analysisId: f.runId, revisionId: before.revisions[0].revisionId });
    expect(saved.reviewStatus).toBe('pending'); expect(f.ports.entities.read(f.runId)).toEqual(before);
    expect(review.nativeBytes()).toEqual(native); expect(review.receiptBytes()).toEqual(receipt);
    expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it.each(['lost-ack', 'abort'] as const)('restarts after %s without redispatch, duplicate knowledge or a rewritten E revision', async mode => {
    const f = await setup(), review = entityReviewReturn(f), k = reviewedReturn(f, review, true), before = f.ports.entities.read(f.runId);
    const controller = new AbortController(), write = f.ports.knowledge.write.bind(f.ports.knowledge); let interrupted = false;
    vi.spyOn(f.ports.knowledge, 'write').mockImplementation((...args) => {
      const result = write(...args);
      if (!interrupted) { interrupted = true; if (mode === 'lost-ack') throw new Error('Authored lost acknowledgement.'); controller.abort(); }
      return result;
    });
    expect(() => k.app.importReviewedKnowledge(f.runId, f.model, profile, review.selection, k.reference, controller.signal)).toThrow();
    const restarted = new KnowledgeApplication({ ...f.ports, entityReviewArchive: review.archive, reviewedKnowledgeArchive: k.archive });
    const result = restarted.importReviewedKnowledge(f.runId, f.model, profile, review.selection, k.reference);
    expect(result.committed).toHaveLength(2); expect(restarted.list()).toHaveLength(2);
    for (const item of result.committed) expect(f.ports.knowledge.read(item.knowledgeId).generation).toBe(1);
    expect(f.ports.entities.read(f.runId)).toEqual(before); expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it('pins the initial revision despite a later correction and never activates without the explicit archive ports', async () => {
    const f = await setup(), review = entityReviewReturn(f), k = reviewedReturn(f, review), initial = f.app.entities(f.runId);
    const correction = structuredClone({ entities: initial.revision.entities, mentions: initial.revision.mentions });
    correction.entities[0].description = 'Authored later revision.';
    f.app.correctEntities(f.runId, initial.revision.revisionId, initial.history.generation, correction, 'Authored correction.');
    const result = k.app.importReviewedKnowledge(f.runId, f.model, profile, review.selection, k.reference);
    expect(result.entityAnalysisRef.revisionId).toBe(initial.revision.revisionId);
    expect(f.app.entities(f.runId).history.revisions).toHaveLength(2);
    expect(() => f.app.reviewedKnowledgeContext(f.runId, f.model, profile, review.selection)).toThrow('archive unavailable');
    expect(() => f.app.importReviewedKnowledge(f.runId, f.model, profile, review.selection, k.reference)).toThrow('archive unavailable');
  });

  it.each(['early-review', 'early-knowledge', 'invalid-review'] as const)('blocks %s before any knowledge write and retains the original E evidence', async mode => {
    const f = await setup(), review = entityReviewReturn(f), k = reviewedReturn(f, review), before = f.ports.entities.read(f.runId);
    if (mode === 'early-review') { review.receipt.startedAt = '2020-01-31T23:59:59Z'; review.selection.reference = review.reseal(); }
    if (mode === 'early-knowledge') { k.receipt.startedAt = '2020-02-01T00:00:01Z'; k.reference = k.reseal(); }
    if (mode === 'invalid-review') { review.response.decisions.pop(); review.native.outcome.result.output = JSON.stringify(review.response); review.selection.reference = review.reseal(); }
    expect(() => k.app.importReviewedKnowledge(f.runId, f.model, profile, review.selection, k.reference)).toThrow();
    expect(k.app.list()).toEqual([]); expect(f.ports.entities.read(f.runId)).toEqual(before); expect(f.effects).toHaveBeenCalledTimes(1);
  });
});
