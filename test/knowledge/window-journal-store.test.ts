import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileGenerationJournalStore } from '../../src/knowledge/adapters/generation-journal-store.js';
import { generationTextDigest } from '../../src/knowledge/extraction/body-generation-wire.js';
import { GENERATION_JOURNAL_SCHEMA_VERSION, type GenerationJournal, type GenerationStage } from '../../src/knowledge/extraction/generation-journal.js';
import { BODY_WINDOW_PROFILE, bodyWindowInput, createLongBodyPlan } from '../../src/knowledge/extraction/long-body.js';
import { SOURCE_REVIEW_INPUT_VERSION } from '../../src/knowledge/extraction/source-review-input.js';
import { generationSourceInput, generationSourceMetadata, WORKFLOW_ID } from '../../src/knowledge/extraction/source-input.js';
import { sourceSetPreimage } from '../../src/knowledge/sources.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { sourceRef, traceSnapshotFixture } from '../helpers/knowledge-source.js';
import { testDirectory } from '../helpers/temp-directory.js';

const sha = (value: unknown) => generationTextDigest(canonicalJson(value));

function fixture() {
  const root = testDirectory('omk-window-journal-');
  const store = new FileGenerationJournalStore(join(root, 'generation-journals'), root);
  const source = traceSnapshotFixture('Selected original evidence. '.repeat(11_000));
  const sources = [source];
  const sourceSetId = sha(sourceSetPreimage(sources.map(sourceRef)));
  const bodyPlan = createLongBodyPlan(sources);
  const { profileId, promptVersion, system, wireId, wireSchema } = BODY_WINDOW_PROFILE;
  const model = { executor: 'codex', model: 'fixture', timeoutMs: 300_000 };
  const producer = { producerId: 'authored-fixture', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024, proof: {} };
  const stages = bodyPlan.windows.map((_, index): GenerationStage => {
    const input = bodyWindowInput(sources, sourceSetId, bodyPlan, index);
    return { stageKind: 'body_window', invocationId: randomUUID(), state: 'prepared', profileId, promptVersion, system, wireId,
      wireSchema, input, inputDigest: generationTextDigest(input), requestDigest: sha({ ...model, profileId, system, wireId, input, producer }),
      producer, issues: [], committed: 0 };
  });
  const seed: GenerationJournal = { storeKind: 'knowledge-generation-journal', schemaVersion: GENERATION_JOURNAL_SCHEMA_VERSION,
    workflowId: WORKFLOW_ID, inputVersion: SOURCE_REVIEW_INPUT_VERSION, sourceSetId, runId: randomUUID(), generation: 1,
    mode: 'generate', status: 'active', createdAt: '2026-11-08T00:00:00.000Z', actor: { actorKind: 'human', actorId: 'fixture' },
    sources: [{ ...sourceRef(source), sourceDigest: sha(source) }], ...model, bodies: [], stages, bodyPlan,
    bodySourceMetadata: sources.map(generationSourceInput).map(({ source }) => generationSourceMetadata(source)) };
  expect(stages.length).toBeGreaterThanOrEqual(3);
  const validateClaim = vi.fn();
  const update = (journal: GenerationJournal, index: number, patch: Partial<GenerationStage>, extra: Partial<GenerationJournal> = {}) =>
    store.write({ ...journal, ...extra, generation: journal.generation + 1,
      stages: journal.stages.map((stage, ordinal) => ordinal === index ? { ...stage, ...patch } : stage) }, journal.generation, validateClaim);
  return { store, seed, validateClaim, update };
}

describe('durable long window journal', () => {
  it('claims in any order under a shared two-window cap and waits at the publication barrier', () => {
    const { store, seed, update, validateClaim } = fixture();
    expect(() => store.write({ ...seed, stages: seed.stages.slice(0, 1) }, 0)).toThrow('all windows');
    const initial = store.write(seed, 0), last = initial.stages.length - 1;
    const firstClaim = update(initial, last, { state: 'claimed' });
    expect(() => update(initial, 0, { state: 'claimed' })).toThrow('journal conflict');
    const twoClaims = update(firstClaim, 0, { state: 'claimed' });
    expect(() => update(twoClaims, 1, { state: 'claimed' })).toThrow('bounded native claims');
    expect(validateClaim.mock.calls.map(([, stage]) => stage.invocationId)).toEqual([seed.stages[last].invocationId, seed.stages[0].invocationId]);
    const ref = store.archive(twoClaims, twoClaims.stages[last], { outcomeKind: 'result', result: { ok: true, output: '{}' } });
    const archivedLast = update(twoClaims, last, { state: 'archived', outcomeRef: ref });
    expect(() => update(archivedLast, last, { state: 'prepared_writes', bodyWrites: [] })).toThrow('publication requires every window');
    expect(update(archivedLast, 1, { state: 'claimed' }).stages.map(stage => stage.state))
      .toEqual(['claimed', 'claimed', ...seed.stages.slice(2, last).map(() => 'prepared'), 'archived']);
  });

  it('allows one fresh invocation only after an exact archived interruption and keeps the old receipt', () => {
    const { store, seed, update } = fixture();
    const initial = store.write(seed, 0);
    const claimed = update(initial, 0, { state: 'claimed' });
    expect(() => update(claimed, 0, { invocationId: randomUUID(), state: 'prepared' })).toThrow('exact interrupted attempt');
    const timeout = { outcomeKind: 'result' as const, result: { ok: false, output: null, stopReason: 'timeout', failure: { failureKind: 'timeout' } } };
    const ref = store.archive(claimed, claimed.stages[0], timeout);
    const archived = update(claimed, 0, { state: 'archived', outcomeRef: ref });
    const interrupted = update(archived, 0, { state: 'interrupted' });
    const prior = { windowIndex: 0, stage: interrupted.stages[0] };
    const replacement = { ...initial.stages[0], invocationId: randomUUID() };
    const next = { ...interrupted, generation: interrupted.generation + 1,
      stages: [replacement, ...interrupted.stages.slice(1)], bodyAttempts: [prior] };
    expect(() => store.write({ ...next, bodyAttempts: [] }, interrupted.generation)).toThrow('exact interrupted attempt');
    expect(() => store.write({ ...next, stages: [{ ...replacement, requestDigest: sha('changed request') }, ...next.stages.slice(1)] },
      interrupted.generation)).toThrow('attempt history');
    const retry = store.write(next, interrupted.generation);
    expect(store.outcome(retry, prior.stage)).toEqual(timeout);
    expect(() => store.archive(retry, prior.stage, { ...timeout, result: { ...timeout.result, output: 'different original' } }))
      .toThrow('archive identity conflict');
    expect(store.list().archiveChecks).toContainEqual(expect.objectContaining({ invocationId: prior.stage.invocationId, archiveStatus: 'present' }));
    expect(() => store.write({ ...retry, generation: retry.generation + 1, bodyAttempts: [] }, retry.generation)).toThrow('attempt history changed');
    const retryClaimed = update(retry, 0, { state: 'claimed' });
    const retryRef = store.archive(retryClaimed, retryClaimed.stages[0], timeout);
    const retryArchived = update(retryClaimed, 0, { state: 'archived', outcomeRef: retryRef });
    expect(() => update(retryArchived, 0, { state: 'interrupted' })).toThrow('attempt history');
    expect(update(retryArchived, 0, { state: 'failed' }, { status: 'failed' }).bodyAttempts).toEqual([prior]);
  });
});
