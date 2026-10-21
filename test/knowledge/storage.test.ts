import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { EXTRACTION_OUTCOME_MAX_BYTES, EXTRACTION_RUN_MAX_BYTES, FileExtractionRunStore } from '../../src/knowledge/adapters/run-store.js';
import { ExtractionOutcomeSchema, ExtractionRunSchema, extractionRunSummary, type ExtractionAttempt, type ExtractionJson, type ExtractionOutcome, type ExtractionRun } from '../../src/knowledge/extraction/runs.js';
import { accountExtractionOutcome, boundedExtractionPolicy } from '../../src/knowledge/extraction/generation-policy.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileLibraryStore } from '../../src/knowledge/adapters/library-store.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from '../../src/knowledge/adapters/durable-publication.js';
import type { LibraryWrite } from '../../src/knowledge/entity-library/contracts.js';
import { recoverStorageLock, storageLockState, withWorkspaceWrite, WORKSPACE_LOCK_FILE } from '../../src/evidence/storage/knowledge-workspace.js';
import { applyEntityAnalysisWrite } from '../../src/knowledge/entities/history.js';
import { EntityAnalysisWriteCapacityError, type EntityAnalysisWrite } from '../../src/knowledge/entities/contracts.js';

const faults = vi.hoisted(() => ({ beforeRecovery: undefined as (() => void) | undefined, afterOutcomeLink: false, afterManifestRename: false, syncs: 0, descriptors: new Map<number, string>(), durable: undefined as { events: string[]; failSync?: string; afterPublish?: boolean; shortWrite?: boolean; noProgress?: boolean; beforeOpen?: () => void } | undefined }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: (path: string, flags: string | number, mode?: number) => {
    if (path.includes('.recovery-') && faults.beforeRecovery) {
      const operation = faults.beforeRecovery; faults.beforeRecovery = undefined; operation();
    }
    const durable = faults.durable;
    if (durable?.beforeOpen && !String(path).endsWith('.lock')) { const before = durable.beforeOpen; durable.beforeOpen = undefined; before(); }
    const fd = fs.openSync(path, flags, mode); faults.descriptors.set(fd, String(path));
    durable?.events.push(`open:${path}`); return fd;
  }, linkSync: (source: string, path: string) => {
    fs.linkSync(source, path); faults.durable?.events.push(`publish:${path}`);
    if (faults.durable?.afterPublish) { faults.durable.afterPublish = false; throw new Error('domain publication acknowledgement interrupted'); }
    if (faults.afterOutcomeLink && path.includes('outcomes')) { faults.afterOutcomeLink = false; throw new Error('outcome acknowledgement interrupted'); }
  }, renameSync: (source: string, path: string) => {
    fs.renameSync(source, path); faults.durable?.events.push(`publish:${path}`);
    if (faults.durable?.afterPublish) { faults.durable.afterPublish = false; throw new Error('domain publication acknowledgement interrupted'); }
    if (faults.afterManifestRename && path.includes('extraction-runs') && path.endsWith('.json')) { faults.afterManifestRename = false; throw new Error('manifest acknowledgement interrupted'); }
  }, writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) => {
    const durable = faults.durable;
    if (durable?.noProgress) return 0;
    const count = fs.writeSync(fd, buffer, offset, durable?.shortWrite ? Math.min(7, length) : length);
    durable?.events.push(`write:${faults.descriptors.get(fd)}:${count}`); return count;
  }, closeSync: (fd: number) => {
    faults.durable?.events.push(`close:${faults.descriptors.get(fd)}`); faults.descriptors.delete(fd); fs.closeSync(fd);
  }, fsyncSync: (fd: number) => {
    const path = faults.descriptors.get(fd); faults.durable?.events.push(`sync:${path}`);
    if (faults.durable?.failSync !== undefined && path === faults.durable.failSync) throw new Error('domain durability confirmation interrupted');
    faults.syncs++; fs.fsyncSync(fd);
  } };
});
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'omk-current-storage-')); roots.push(path); return path; };
afterEach(() => { faults.beforeRecovery = undefined; faults.afterOutcomeLink = false; faults.afterManifestRename = false; faults.syncs = 0; faults.durable = undefined; faults.descriptors.clear(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const sha = (digit = 'a') => `sha256:${digit.repeat(64)}`;
function runFixture(): ExtractionRun {
  const at = '2026-10-16T00:00:00Z';
  return { runKind: 'knowledge-extraction-run', schemaVersion: 5, runId: randomUUID(), requestDigest: sha(), generation: 1,
    snapshotId: randomUUID(), sourceVersion: sha(), executor: 'codex', model: 'fixture', promptVersion: 'knowledge-extraction-v14',
    promptHash: sha(), inputDigest: sha(), actor: { actorKind: 'human', actorId: 'tester' }, startedAt: at, status: 'generating',
    policy: { policyId: 'knowledge-generation-single/v1', maxInvocations: 1, retry: 'none', fallback: 'none' },
    attempts: [{ attemptId: randomUUID(), startedAt: at, requestDigest: sha(),
      request: { systemDigest: sha(), inputDigest: sha(), outputMode: 'prompt-json', timeoutMs: 300_000 },
      producer: { producerId: 'storage-fixture', producerRevision: sha(), sourceChannels: [{ channel: 'fixture', maxBytes: 1024 * 1024 }],
        maxOutcomeJsonBytes: 1024 * 1024, proof: { scope: 'synthetic-storage-fixture-not-transport-proof' } } }],
    intents: [], committed: [], rejections: [], entityRejections: [] };
}
function nativeOutcome(output = 'original output'): Extract<ExtractionOutcome, { outcomeKind: 'result' }> {
  return { outcomeKind: 'result', result: { ok: true, output, durationMs: -3, durationApiMs: 0, inputTokens: 42, outputTokens: 5,
    cacheReadTokens: 12, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false,
    stopReason: 'end_turn', numTurns: 1, additionalProviderField: { retained: true } } };
}
function boundedRunFixture(): ExtractionRun {
  const run = runFixture(), attempt = run.attempts[0];
  return { ...run, executor: 'openai-api', model: 'authored-loopback-test',
    policy: boundedExtractionPolicy({ maxInvocations: 3, maxReasks: 2, profileId: 'loopback-test/v1', maxTotalTokens: 3264, maxOutputTokens: 64 }),
    attempts: [{ ...attempt, request: { ...attempt.request, maxOutputTokens: 64 },
      budget: { profileId: 'loopback-test/v1', authority: 'loopback-test-only', evidenceDigest: sha('0'), inputUpperBound: 1024, outputUpperBound: 64, tokensReserved: 1088 } }] };
}
function followingAttempt(run: ExtractionRun): ExtractionAttempt {
  const previous = run.attempts[run.attempts.length - 1], first = run.attempts[0];
  return { attemptId: randomUUID(), startedAt: run.startedAt, requestDigest: sha('b'), request: first.request, producer: first.producer,
    budget: first.budget, trigger: { triggerKind: 'transient', previousAttemptId: previous.attemptId, notBefore: run.startedAt, delayMs: 0 } };
}
function archiveBoundedAttempt(store: FileExtractionRunStore, run: ExtractionRun, outcome: ExtractionOutcome, failure?: ExtractionAttempt['failure']): ExtractionRun {
  const attempt = run.attempts[run.attempts.length - 1];
  const ref = store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes);
  const settled: ExtractionAttempt = { ...attempt, outcome: ref, accounting: accountExtractionOutcome(outcome, attempt.budget!), ...(failure ? { failure } : {}) };
  const next = { ...run, generation: run.generation + 1, attempts: [...run.attempts.slice(0, -1), settled] };
  store.save(next, run.generation); return next;
}

describe('v5 extraction manifests and immutable native evidence', () => {
  it('archives before metadata acknowledgement, preserves every JSON field and replays the same bytes before new capacity checks', () => {
    const workspace = root(), directory = join(workspace, 'extraction-runs'), store = new FileExtractionRunStore(directory, workspace);
    const run = runFixture(), attempt = run.attempts[0]; store.create(run);
    const outcome = nativeOutcome(`${'界'.repeat(16_383)}😀\ud800`);
    const ref = store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes);
    expect(store.read(run.runId).attempts[0].outcome).toBeUndefined();
    expect(store.readOutcome(run.runId, attempt.attemptId)).toEqual({ outcome, ref });
    expect(store.writeOutcome(run.runId, attempt.attemptId, outcome, 1)).toEqual(ref);
    const next: ExtractionRun = { ...run, generation: 2, selectedAttemptId: attempt.attemptId, rawOutput: outcome.result.output!,
      runtime: { durationMs: -3, cacheReadTokens: 12, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costReportedByExecutor: false },
      attempts: [{ ...attempt, outcome: ref }] };
    store.save(next, 1); store.save(next, 1);
    expect(store.read(run.runId)).toEqual(next); expect(store.listManifests()).toHaveLength(1);
    expect(() => store.readOutcome(run.runId, attempt.attemptId, { ...ref, digest: sha('b') })).toThrow('integrity mismatch');
    expect(() => store.writeOutcome(run.runId, attempt.attemptId, nativeOutcome('different output'), attempt.producer.maxOutcomeJsonBytes)).toThrow('identity conflict');
    expect(() => store.save({ ...next, generation: 3, attempts: [{ ...next.attempts[0], requestDigest: sha('b') }] }, 2)).toThrow('attempt conflict');
    expect(() => store.save({ ...next, generation: 3, runtime: { durationMs: 5 } }, 2)).toThrow('runtime differs');
    expect(() => store.save({ ...next, generation: 3, runtime: undefined }, 2)).toThrow('runtime differs');
    expect(() => store.save({ ...next, generation: 3, rawOutput: 'replacement' }, 2)).toThrow('output differs');
    expect(() => store.save({ ...next, generation: 3 }, 1)).toThrow('run conflict');
    expect(store.read(run.runId).generation).toBe(2);
    rmSync(join(directory, 'outcomes', run.runId, `${attempt.attemptId}.json`));
    expect(() => store.read(run.runId)).toThrow('Archived extraction outcome is missing');
  });
  it.each(['missing', 'corrupt'] as const)('lists manifest receipts without reading %s native evidence while execution reads fail closed', problem => {
    const workspace = root(), directory = join(workspace, 'extraction-runs'), store = new FileExtractionRunStore(directory, workspace);
    const run = runFixture(), attempt = run.attempts[0], outcome = nativeOutcome(); store.create(run);
    const ref = store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes);
    const saved = { ...run, generation: 2, attempts: [{ ...attempt, outcome: ref }] }; store.save(saved, 1);
    const manifestPath = join(directory, `${run.runId}.json`), before = readFileSync(manifestPath);
    const path = join(directory, 'outcomes', run.runId, `${attempt.attemptId}.json`);
    if (problem === 'missing') rmSync(path); else writeFileSync(path, '{invalid native archive');
    expect(store.listManifests()).toEqual([saved]);
    expect(extractionRunSummary(saved).invocation.archiveStatus).toBe('recorded');
    expect(() => store.read(run.runId)).toThrow();
    expect(() => store.save({ ...saved, generation: 3 }, 2)).toThrow();
    expect(() => store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes)).toThrow();
    expect(() => store.readOutcome(run.runId, attempt.attemptId, ref)).toThrow();
    expect(readFileSync(manifestPath)).toEqual(before);
    expect(existsSync(join(workspace, WORKSPACE_LOCK_FILE))).toBe(false);
  });
  it.each(['invalid-json', 'invalid-utf8', 'invalid-shape', 'wrong-identity', 'linked', 'oversized'] as const)(
    'rejects a %s manifest before it enters a listing', problem => {
      const workspace = root(), directory = join(workspace, 'extraction-runs'), store = new FileExtractionRunStore(directory, workspace);
      const run = runFixture(); store.create(run); const path = join(directory, `${run.runId}.json`);
      if (problem === 'invalid-json') writeFileSync(path, '{');
      if (problem === 'invalid-utf8') writeFileSync(path, Buffer.from([0xff]));
      if (problem === 'invalid-shape') writeFileSync(path, JSON.stringify({ ...run, generation: 0 }));
      if (problem === 'wrong-identity') writeFileSync(path, JSON.stringify({ ...run, runId: randomUUID() }));
      if (problem === 'linked') {
        const target = join(workspace, 'linked-manifest.json'); writeFileSync(target, JSON.stringify(run));
        rmSync(path); symlinkSync(target, path);
      }
      if (problem === 'oversized') truncateSync(path, EXTRACTION_RUN_MAX_BYTES + 1);
      expect(() => store.listManifests()).toThrow(); expect(() => store.read(run.runId)).toThrow();
      expect(existsSync(join(workspace, WORKSPACE_LOCK_FILE))).toBe(false);
    },
  );
  it('recovers an exclusively published sidecar after lost acknowledgement without another invocation or metadata overwrite', () => {
    const workspace = root(), directory = join(workspace, 'extraction-runs'), store = new FileExtractionRunStore(directory, workspace);
    const run = runFixture(), attempt = run.attempts[0], outcome = nativeOutcome(); store.create(run);
    faults.afterOutcomeLink = true;
    expect(() => store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes)).toThrow('acknowledgement interrupted');
    const recovered = store.readOutcome(run.runId, attempt.attemptId);
    expect(recovered.outcome).toEqual(outcome); expect(store.read(run.runId).generation).toBe(1);
    expect(store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes)).toEqual(recovered.ref);
    // Large/failed output may have an honest metric projection without selecting raw output.
    const next: ExtractionRun = { ...run, generation: 2, runtime: { durationMs: -3, cacheReadTokens: 12 }, attempts: [{ ...attempt, outcome: recovered.ref }] };
    faults.afterManifestRename = true;
    expect(() => store.save(next, 1)).toThrow('manifest acknowledgement interrupted');
    expect(store.read(run.runId)).toEqual(next);
    const syncs = faults.syncs; store.save(next, 1);
    expect(faults.syncs).toBeGreaterThan(syncs);
    expect(readdirSync(join(directory, 'outcomes', run.runId))).toEqual([`${attempt.attemptId}.json`]);
    expect(existsSync(join(workspace, WORKSPACE_LOCK_FILE))).toBe(false);
  });
  it('handles deep native JSON iteratively and refuses cycles and getters without invoking accessors', () => {
    const workspace = root(), store = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace);
    const run = runFixture(), attempt = run.attempts[0]; store.create(run);
    let trace: ExtractionJson = 'tail'; for (let index = 0; index < 20_000; index++) trace = { next: trace };
    const outcome = nativeOutcome(); outcome.result.trace = trace;
    const toolCall = { name: 'fixture-tool', arguments: { nested: true } };
    outcome.result.toolCalls = [toolCall]; outcome.result.turns = [{ toolCalls: [toolCall] }];
    const ref = store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes);
    const loaded = store.readOutcome(run.runId, attempt.attemptId, ref).outcome;
    expect(loaded.outcomeKind).toBe('result');
    if (loaded.outcomeKind !== 'result') throw new Error('Expected native result.');
    let current = loaded.result.trace; let depth = 0;
    while (current && typeof current === 'object' && !Array.isArray(current)) { depth++; current = current.next; }
    expect(depth).toBe(20_000); expect(current).toBe('tail');
    expect(loaded.result.toolCalls).toEqual([toolCall]); expect(loaded.result.turns).toEqual([{ toolCalls: [toolCall] }]);
    const cyclic = nativeOutcome(); cyclic.result.self = cyclic.result;
    expect(ExtractionOutcomeSchema.safeParse(cyclic).success).toBe(false);
    const getter = vi.fn(() => 'must not run'); const unsafe = nativeOutcome(); Object.defineProperty(unsafe.result, 'secret', { enumerable: true, get: getter });
    expect(ExtractionOutcomeSchema.safeParse(unsafe).success).toBe(false); expect(getter).not.toHaveBeenCalled();
  });
  it('preserves failure/refusal/cleanup evidence, failed terminal states and authored projections', () => {
    const workspace = root(), store = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace);
    const outcomes: ExtractionOutcome[] = [
      { ...nativeOutcome('partial output'), result: { ...nativeOutcome().result, ok: false, output: 'partial output', refusal: 'original refusal', failure: { failureKind: 'refusal' } }, cleanupFailure: { diagnostic: 'cleanup did not finish' } },
      { outcomeKind: 'exception' as const, error: { representationKind: 'exception-diagnostic/v1' as const, sourceType: 'object' as const,
        name: 'Error', message: 'observed failure', truncated: false, accessorsSkipped: true } },
      { outcomeKind: 'model-port-projection' as const, scope: 'authored-model-port/v1' as const, result: { output: 'authored', durationMs: 0 } },
    ];
    for (const outcome of outcomes) {
      const run = runFixture(), attempt = run.attempts[0]; store.create(run);
      const ref = store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes);
      expect(store.readOutcome(run.runId, attempt.attemptId, ref).outcome).toEqual(outcome);
      if (outcome.outcomeKind === 'exception') expect(() => store.save({ ...run, generation: 2, runtime: { durationMs: 0 }, attempts: [{ ...attempt, outcome: ref }] }, 1)).toThrow('no returned result archive');
      const unacknowledged: ExtractionRun = { ...run, generation: 2, status: 'failed', attempts: [{ ...attempt, failure: { failureKind: 'fixture_failure', diagnostic: 'final failure' } }] };
      store.save(unacknowledged, 1);
      // Failure is terminal, while acknowledgement of the same archived attempt remains possible.
      const failed: ExtractionRun = { ...unacknowledged, generation: 3, attempts: [{ ...unacknowledged.attempts[0], outcome: ref }] };
      store.save(failed, 2);
      const manifest = join(workspace, 'extraction-runs', `${run.runId}.json`);
      const sidecar = join(workspace, 'extraction-runs', 'outcomes', run.runId, `${attempt.attemptId}.json`);
      const manifestBytes = readFileSync(manifest), outcomeBytes = readFileSync(sidecar);
      store.save(failed, 2); // An identical acknowledgement wins before the generation check.
      for (const status of ['generating', 'cancelled'] as const) {
        expect(() => store.save({ ...failed, generation: 4, status }, 3)).toThrow('terminal');
      }
      expect(() => store.save({ ...failed, generation: 4, attempts: [{ ...failed.attempts[0], failure: { failureKind: 'different', diagnostic: 'changed' } }] }, 3)).toThrow('attempt conflict');
      expect(store.read(run.runId)).toEqual(failed);
      expect(readFileSync(manifest)).toEqual(manifestBytes); expect(readFileSync(sidecar)).toEqual(outcomeBytes);
    }
  });
  it('keeps prepared UUIDs, rejections and intents immutable and never rolls a completed run back', () => {
    const workspace = root(), store = new FileExtractionRunStore(join(workspace, 'extraction-runs'), workspace);
    const run = runFixture(), attempt = run.attempts[0], outcome = nativeOutcome(); store.create(run);
    const ref = store.writeOutcome(run.runId, attempt.attemptId, outcome, attempt.producer.maxOutcomeJsonBytes);
    const prepared: ExtractionRun = { ...run, generation: 2, status: 'prepared', rawOutput: outcome.result.output!, selectedAttemptId: attempt.attemptId,
      attempts: [{ ...attempt, outcome: ref }], entityRejections: [], entityAnalysis: { requestId: randomUUID(), analysisId: run.runId,
        snapshotId: run.snapshotId, sourceVersion: run.sourceVersion, expectedGeneration: 0, expectedHeadRevisionId: null,
        revision: { revisionId: randomUUID(), revisedAt: run.startedAt, revisedBy: { actorKind: 'agent', actorId: `extractor:${run.executor}`, executionRef: run.runId },
          revisionReason: 'Empty birth analysis', entities: [], mentions: [], limitations: [] } } };
    store.save(prepared, 1);
    expect(() => store.save({ ...prepared, generation: 3, entityAnalysis: { ...prepared.entityAnalysis!, requestId: randomUUID() } }, 2)).toThrow('intents are immutable');
    expect(() => store.save({ ...prepared, generation: 3, rejections: [{ index: 0, reasons: ['replacement'] }] }, 2)).toThrow('intents are immutable');
    expect(() => store.save({ ...prepared, generation: 3, entityRejections: [{ component: 'entity', index: 0, reasons: ['replacement'] }] }, 2)).toThrow('intents are immutable');
    const completed: ExtractionRun = { ...prepared, generation: 3, status: 'completed' }; store.save(completed, 2);
    expect(() => store.save({ ...completed, generation: 4, status: 'failed' }, 3)).toThrow('terminal');
    expect(store.read(run.runId)).toEqual(completed);
  });
  it('rejects occupied legacy/entity UUIDs without decoding them, leaves old runs untouched and admits fresh identities', () => {
    const workspace = root(), directory = join(workspace, 'extraction-runs'), store = new FileExtractionRunStore(directory, workspace);
    const run = runFixture();
    for (const namespace of ['runs', 'entities']) {
      mkdirSync(join(workspace, namespace), { recursive: true }); const old = join(workspace, namespace, `${run.runId}.json`); writeFileSync(old, 'not decoded');
      expect(() => store.create(run)).toThrow('already occupied'); expect(readFileSync(old, 'utf8')).toBe('not decoded');
      expect(existsSync(directory)).toBe(false); rmSync(old);
    }
    writeFileSync(join(workspace, 'runs', `${randomUUID()}.json`), 'unrelated malformed v4');
    store.create(run); expect(store.listManifests().map(value => value.runId)).toEqual([run.runId]);
    expect(() => store.create(run)).toThrow('already exists');
    expect(readdirSync(join(workspace, 'runs'))).toHaveLength(1);
  });
  it('rejects producer reservations before creating a manifest and bounds corrupt/linked sidecars before reading', () => {
    const workspace = root(), directory = join(workspace, 'extraction-runs'), store = new FileExtractionRunStore(directory, workspace);
    const run = runFixture();
    expect(() => store.create({ ...run, attempts: [{ ...run.attempts[0], producer: { ...run.attempts[0].producer, maxOutcomeJsonBytes: EXTRACTION_OUTCOME_MAX_BYTES } }] })).toThrow('capacity exceeded before invocation');
    expect(existsSync(directory)).toBe(false); store.create(run);
    const attempt = run.attempts[0], outcome = nativeOutcome();
    expect(() => store.writeOutcome(run.runId, attempt.attemptId, outcome, 1)).toThrow('reservation conflict');
    const path = join(directory, 'outcomes', run.runId, `${attempt.attemptId}.json`); mkdirSync(join(directory, 'outcomes', run.runId), { recursive: true });
    writeFileSync(path, '{}'); truncateSync(path, EXTRACTION_OUTCOME_MAX_BYTES + 1);
    expect(() => store.readOutcome(run.runId, attempt.attemptId)).toThrow('Invalid extraction file'); rmSync(path);
    const target = join(workspace, 'private.json'); writeFileSync(target, '{}'); symlinkSync(target, path);
    expect(() => store.readOutcome(run.runId, attempt.attemptId)).toThrow('Invalid extraction file');
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });
  it('preserves single-policy v5 bytes and enforces bounded reservations, cumulative limits and an immutable attempt prefix', () => {
    const workspace = root(), directory = join(workspace, 'extraction-runs'), store = new FileExtractionRunStore(directory, workspace);
    const single = runFixture(); store.create(single);
    const singlePath = join(directory, `${single.runId}.json`), singleBytes = readFileSync(singlePath, 'utf8');
    expect(store.read(single.runId)).toEqual(single); expect(readFileSync(singlePath, 'utf8')).toBe(singleBytes);
    let run = boundedRunFixture(); store.create(run);
    const pending = followingAttempt(run);
    expect(() => store.save({ ...run, generation: 2, attempts: [...run.attempts, pending] }, 1)).toThrow('predecessor');
    const firstOutcome = nativeOutcome('private failed native output');
    firstOutcome.result.ok = false; firstOutcome.result.failure = { failureKind: 'server_error' };
    run = archiveBoundedAttempt(store, run, firstOutcome, { failureKind: 'server_error', diagnostic: 'private native diagnostic' });
    const firstSidecar = join(directory, 'outcomes', run.runId, `${run.attempts[0].attemptId}.json`), firstBytes = readFileSync(firstSidecar, 'utf8');
    const second = followingAttempt(run), two: ExtractionRun = { ...run, generation: 3, attempts: [...run.attempts, second] };
    expect(() => store.create({ ...two, runId: randomUUID() })).toThrow('start with one');
    store.save(two, 2);
    expect(() => store.save({ ...two, attempts: [...run.attempts, { ...second, attemptId: randomUUID() }] }, 2)).toThrow('run conflict');
    expect(() => store.save({ ...two, generation: 4, attempts: [two.attempts[0]] }, 3)).toThrow('prefix conflict');
    expect(() => store.save({ ...two, generation: 4, attempts: [{ ...two.attempts[0], budget: { ...two.attempts[0].budget!, authority: 'official-contract' } }, second] }, 3)).toThrow('attempt conflict');
    expect(() => store.save({ ...two, generation: 4, attempts: [{ ...two.attempts[0], accounting: { ...two.attempts[0].accounting!, observedTokens: 0 } }, second] }, 3)).toThrow('attempt conflict');
    const secondOutcome = nativeOutcome('second native output'); secondOutcome.result.tokenUsageReportedByExecutor = true;
    run = archiveBoundedAttempt(store, two, secondOutcome);
    const summary = extractionRunSummary(run);
    expect(summary.invocation).toMatchObject({ attemptCount: 2, archiveStatus: 'recorded', failureKind: null,
      limits: { maxInvocations: 3, maxReasks: 2 }, budget: { reservedTokens: 2176, observedTokens: null, unknownAttempts: 1, maxTotalTokens: 3264 } });
    expect(JSON.stringify(summary)).not.toContain('private'); expect(readFileSync(firstSidecar, 'utf8')).toBe(firstBytes);
    const third = followingAttempt(run); const three = { ...run, generation: run.generation + 1, attempts: [...run.attempts, third] };
    store.save(three, run.generation);
    expect(ExtractionRunSchema.safeParse({ ...three, policy: { ...three.policy, maxTotalTokens: 3263 } }).success).toBe(false);
    expect(ExtractionRunSchema.safeParse({ ...three, attempts: [...three.attempts, followingAttempt(three)] }).success).toBe(false);
    expect(ExtractionRunSchema.safeParse({ ...single, attempts: [...single.attempts, single.attempts[0]] }).success).toBe(false);
    expect(ExtractionRunSchema.safeParse({ ...single, attempts: [{ ...single.attempts[0], budget: run.attempts[0].budget }] }).success).toBe(false);
    expect(readFileSync(singlePath, 'utf8')).toBe(singleBytes);
    const failedBase = boundedRunFixture(); store.create(failedBase);
    const archived = archiveBoundedAttempt(store, failedBase, firstOutcome, { failureKind: 'server_error', diagnostic: 'terminal native failure' });
    const failed: ExtractionRun = { ...archived, generation: archived.generation + 1, status: 'failed' };
    store.save(failed, archived.generation);
    const failedPath = join(directory, `${failed.runId}.json`), failedBytes = readFileSync(failedPath);
    const failedSidecar = join(directory, 'outcomes', failed.runId, `${failed.attempts[0].attemptId}.json`), failedOutcomeBytes = readFileSync(failedSidecar);
    expect(() => store.save({ ...failed, generation: failed.generation + 1,
      attempts: [...failed.attempts, followingAttempt(failed)] }, failed.generation)).toThrow('cannot append another attempt');
    expect(store.read(failed.runId)).toEqual(failed);
    expect(readFileSync(failedPath)).toEqual(failedBytes); expect(readFileSync(failedSidecar)).toEqual(failedOutcomeBytes);
  });
  it('verifies accounting against every native archive and binds the single birth to the selected final attempt', () => {
    const workspace = root(), directory = join(workspace, 'extraction-runs'), store = new FileExtractionRunStore(directory, workspace);
    let run = boundedRunFixture(); store.create(run);
    const firstOutcome = nativeOutcome('malformed first response');
    run = archiveBoundedAttempt(store, run, firstOutcome, { failureKind: 'parse_error', diagnostic: 'invalid JSON' });
    const second = followingAttempt(run);
    second.trigger = { ...second.trigger!, triggerKind: 'validation', feedback: { feedbackVersion: 'knowledge-generation-feedback/v1', body: 'invalid_json', digest: sha('c') } };
    run = { ...run, generation: run.generation + 1, attempts: [...run.attempts, second] }; store.save(run, run.generation - 1);
    const outcome = nativeOutcome('final response'); outcome.result.durationMs = 23; outcome.result.tokenUsageReportedByExecutor = true;
    const ref = store.writeOutcome(run.runId, second.attemptId, outcome, second.producer.maxOutcomeJsonBytes);
    const accounting = accountExtractionOutcome(outcome, second.budget!);
    expect(() => store.save({ ...run, generation: run.generation + 1, attempts: [run.attempts[0], { ...second, outcome: ref, accounting: { ...accounting, observedTokens: 0 } }] }, run.generation)).toThrow('accounting differs');
    run = archiveBoundedAttempt(store, run, outcome);
    const attempt = run.attempts[1];
    const prepared: ExtractionRun = { ...run, generation: run.generation + 1, status: 'prepared', selectedAttemptId: attempt.attemptId,
      rawOutput: outcome.result.output!, runtime: { durationMs: 23 }, entityAnalysis: { requestId: randomUUID(), analysisId: run.runId,
        snapshotId: run.snapshotId, sourceVersion: run.sourceVersion, expectedGeneration: 0, expectedHeadRevisionId: null,
        revision: { revisionId: randomUUID(), revisedAt: run.startedAt, revisedBy: { actorKind: 'agent', actorId: `extractor:${run.executor}`, executionRef: run.runId },
          revisionReason: 'One final birth', entities: [], mentions: [], limitations: [] } } };
    expect(() => store.save({ ...prepared, rawOutput: firstOutcome.result.output! }, run.generation)).toThrow('output differs');
    expect(() => store.save({ ...prepared, runtime: { durationMs: -3 } }, run.generation)).toThrow('runtime differs');
    store.save(prepared, run.generation);
    expect(store.read(run.runId).selectedAttemptId).toBe(attempt.attemptId);
    expect(() => store.save({ ...prepared, generation: prepared.generation + 1, attempts: [...prepared.attempts, followingAttempt(prepared)] }, prepared.generation)).toThrow('select its final attempt');
    const firstSidecar = join(directory, 'outcomes', run.runId, `${run.attempts[0].attemptId}.json`);
    const original = readFileSync(firstSidecar, 'utf8'); writeFileSync(firstSidecar, original.replace('malformed first response', 'changed first response'));
    expect(() => store.read(run.runId)).toThrow('integrity mismatch');
  });
});

describe('current knowledge storage', () => {
  it('publishes exact bytes only after complete short writes, file sync and every directory sync, and closes on failures', () => {
    const workspace = root(), parent = join(workspace, 'entities', 'nested'), path = join(parent, 'fixture.json');
    const bytes = '{"fixture":"中文短写"}'; const events: string[] = []; faults.durable = { events, shortWrite: true };
    publishKnowledgeBytes(path, bytes, workspace, true); expect(readFileSync(path, 'utf8')).toBe(bytes);
    const publication = events.indexOf(`publish:${path}`), fileSync = events.findIndex(value => value.startsWith('sync:') && value.endsWith('.tmp'));
    expect(fileSync).toBeGreaterThan(0); expect(publication).toBeGreaterThan(fileSync);
    expect(events.filter(value => value.startsWith('write:')).length).toBeGreaterThan(1);
    expect(events.slice(publication + 1).filter(value => value.startsWith('sync:'))).toEqual([`sync:${parent}`, `sync:${join(workspace, 'entities')}`, `sync:${workspace}`]);
    expect(faults.descriptors.size).toBe(0); expect(readdirSync(parent)).toEqual(['fixture.json']);
    events.length = 0; confirmKnowledgePublication(path, workspace);
    expect(events.filter(value => value.startsWith('sync:'))).toEqual([`sync:${path}`, `sync:${parent}`, `sync:${join(workspace, 'entities')}`, `sync:${workspace}`]);
    faults.durable.noProgress = true;
    expect(() => publishKnowledgeBytes(path, '{"changed":true}', workspace, false)).toThrow('did not progress');
    expect(readFileSync(path, 'utf8')).toBe(bytes); expect(faults.descriptors.size).toBe(0); expect(readdirSync(parent)).toEqual(['fixture.json']);
    faults.durable.noProgress = false; faults.durable.beforeOpen = () => { rmSync(path); symlinkSync(join(workspace, 'untouched.json'), path); };
    writeFileSync(join(workspace, 'untouched.json'), 'private-fixture');
    expect(() => confirmKnowledgePublication(path, workspace)).toThrow();
    expect(readFileSync(join(workspace, 'untouched.json'), 'utf8')).toBe('private-fixture'); expect(faults.descriptors.size).toBe(0);
    expect(() => publishKnowledgeBytes(join(workspace, '..', 'outside.json'), '{}', workspace, true)).toThrow('inside its workspace');
    const redirected = root(); symlinkSync(redirected, join(workspace, 'redirect'));
    expect(() => publishKnowledgeBytes(join(workspace, 'redirect', 'must-not-create', 'fixture.json'), '{}', workspace, true)).toThrow('Invalid knowledge storage directory');
    expect(readdirSync(redirected)).toEqual([]);
  });

  it.each(['entity', 'library'] as const)('confirms %s exact replay after lost publication or directory-sync acknowledgement without rewriting bytes', domain => {
    const workspace = root(), directory = join(workspace, domain === 'entity' ? 'entities' : 'library'), id = randomUUID();
    const path = join(directory, `${id}.json`), actor = { actorKind: 'human' as const, actorId: 'durability-reviewer' };
    const entity = new FileEntityAnalysisStore(directory, workspace), library = new FileLibraryStore(directory, workspace);
    const entityCommand: EntityAnalysisWrite = { requestId: randomUUID(), analysisId: id, snapshotId: randomUUID(), sourceVersion: sha(), expectedGeneration: 0, expectedHeadRevisionId: null,
      revision: { revisionId: randomUUID(), revisedAt: '2026-10-21T00:00:00Z', revisedBy: actor, revisionReason: 'durability fixture', entities: [], mentions: [], limitations: [] } };
    const libraryCommand: LibraryWrite = { requestId: randomUUID(), objectId: id, expectedGeneration: 0, expectedHeadRevisionId: null,
      revision: { revisionId: randomUUID(), revisedAt: '2026-10-21T00:00:00Z', revisedBy: actor, reason: 'durability fixture', draft: { label: 'fixture', description: 'authored storage fixture', referentKind: 'object', members: [] } } };
    const write = () => domain === 'entity' ? entity.write(entityCommand, actor) : library.write(libraryCommand, () => {});
    const read = () => domain === 'entity' ? entity.read(id) : library.read(id);
    const events: string[] = []; faults.durable = { events, afterPublish: true };
    expect(write).toThrow('publication acknowledgement interrupted'); expect(read().generation).toBe(1);
    // Existing valid envelopes may use a different whitespace encoding; an exact replay must retain it.
    const original = readFileSync(path, 'utf8') + '\n'; writeFileSync(path, original);
    faults.durable.failSync = path; expect(write).toThrow('durability confirmation interrupted'); expect(readFileSync(path, 'utf8')).toBe(original);
    faults.durable.failSync = undefined; events.length = 0; write();
    expect(read().generation).toBe(1); expect(readFileSync(path, 'utf8')).toBe(original);
    expect(events.filter(value => value.startsWith('sync:'))).toEqual([`sync:${path}`, `sync:${directory}`, `sync:${workspace}`]);
    expect(events.some(value => value.startsWith('publish:') || value.startsWith('write:'))).toBe(false);
    const head = read().writeHeadRevisionId;
    Object.assign(entityCommand, { requestId: randomUUID(), expectedGeneration: 1, expectedHeadRevisionId: head });
    entityCommand.revision = { ...entityCommand.revision, revisionId: randomUUID(), parentRevisionId: head, limitations: ['explicit second fixture revision'] };
    Object.assign(libraryCommand, { requestId: randomUUID(), expectedGeneration: 1, expectedHeadRevisionId: head });
    libraryCommand.revision = { ...libraryCommand.revision, revisionId: randomUUID(), parentRevisionId: head, draft: { ...libraryCommand.revision.draft, label: 'fixture 2' } };
    faults.durable.failSync = directory; expect(write).toThrow('durability confirmation interrupted'); expect(read().generation).toBe(2);
    const visible = readFileSync(path); faults.durable.failSync = undefined; write();
    expect(read().generation).toBe(2); expect(readFileSync(path)).toEqual(visible);
    expect(faults.descriptors.size).toBe(0); expect(readdirSync(directory).some(name => name.endsWith('.lock') || name.endsWith('.tmp'))).toBe(false);
  });

  it('rejects an entity revision that exceeds readable disk capacity, preserving the previous history and releasing locks', () => {
    const workspace = root(); const directory = join(workspace, 'entities');
    const store = new FileEntityAnalysisStore(directory, workspace);
    const actor = { actorKind: 'human' as const, actorId: 'tester' };
    const command: EntityAnalysisWrite = {
      requestId: randomUUID(), analysisId: randomUUID(), snapshotId: randomUUID(), sourceVersion: `sha256:${'0'.repeat(64)}`,
      expectedGeneration: 0, expectedHeadRevisionId: null,
      revision: { revisionId: randomUUID(), revisedAt: '2026-10-10T00:00:00Z', revisedBy: actor,
        revisionReason: '初始分析', entities: [], mentions: [], limitations: [] },
    };
    store.write(command, actor);
    const path = join(directory, `${command.analysisId}.json`); const before = readFileSync(path, 'utf8');
    const entities = Array.from({ length: 256 }, () => ({ entityId: randomUUID(), label: '对象', description: '来源中的对象',
      qualifiers: Array<string>(32).fill('界'.repeat(670)), identityStatus: 'proposed' as const,
      possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null }));
    const edit: EntityAnalysisWrite = { ...command, requestId: randomUUID(), expectedGeneration: 1,
      expectedHeadRevisionId: command.revision.revisionId,
      revision: { ...command.revision, revisionId: randomUUID(), parentRevisionId: command.revision.revisionId,
        entities, mentions: entities.map((entity, index) => ({ mentionId: randomUUID(), entityId: entity.entityId,
          basis: 'explicit' as const, rationale: '原文提及',
          selection: { evidenceRef: 'record-1', start: index, end: index + 1, quote: '界' } })) },
    };
    const candidate = applyEntityAnalysisWrite(store.read(command.analysisId), edit, actor, 'size-check');
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(16 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(candidate, null, 2))).toBeGreaterThan(16 * 1024 * 1024);
    expect(() => store.write(edit, actor)).toThrow(EntityAnalysisWriteCapacityError);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(store.read(command.analysisId).generation).toBe(1);
    expect(existsSync(join(workspace, WORKSPACE_LOCK_FILE))).toBe(false);
    expect(readdirSync(directory)).toEqual([`${command.analysisId}.json`]);
    edit.revision.entities = entities.map(entity => ({ ...entity, qualifiers: [] }));
    store.write(edit, actor);
    expect(store.read(command.analysisId)).toMatchObject({ generation: 2, writeHeadRevisionId: edit.revision.revisionId });
    expect(store.list()).toMatchObject({ unavailable: 0, histories: [expect.objectContaining({ generation: 2 })] });
  });
  it('reads an empty entity catalog without creating storage and refuses over-capacity catalogs without truncating', () => {
    const workspace = root(); const directory = join(workspace, 'entities');
    const store = new FileEntityAnalysisStore(directory, workspace);
    expect(store.list()).toEqual({ histories: [], unavailable: 0 }); expect(existsSync(directory)).toBe(false);
    expect(() => withWorkspaceWrite('', () => 'invalid')).toThrow('Explicit knowledge storage directory required');
    mkdirSync(directory); const file = join(directory, `${randomUUID()}.json`); writeFileSync(file, '{}');
    expect(store.list()).toEqual({ histories: [], unavailable: 1 }); expect(readFileSync(file, 'utf8')).toBe('{}');
    truncateSync(file, 65 * 1024 * 1024);
    expect(() => store.list()).toThrow('capacity exceeded');
  });
  it('rejects unsupported storage envelopes without rewriting the original bytes', () => {
    const workspace = root(); const items = join(workspace, 'items'); const runs = join(workspace, 'extraction-runs');
    mkdirSync(items); mkdirSync(runs);
    const knowledge = new FileKnowledgeStore(items, 'local', workspace); const runStore = new FileExtractionRunStore(runs, workspace);
    const itemPath = join(items, 'unsupported.json'); const runId = randomUUID(); const runPath = join(runs, `${runId}.json`);
    for (const value of [{ storeKind: 'knowledge-item-history', schemaVersion: 1 }, { storeKind: 'unknown', schemaVersion: 2 }]) {
      const bytes = JSON.stringify(value); writeFileSync(itemPath, bytes);
      expect(() => knowledge.list()).toThrow('knowledge_storage_unsupported'); expect(readFileSync(itemPath, 'utf8')).toBe(bytes);
    }
    for (const value of [{ runId }, { runKind: 'knowledge-extraction-run', schemaVersion: 1 },
      { runKind: 'knowledge-extraction-run', schemaVersion: 2, promptVersion: 'knowledge-extraction-v3' },
      { runKind: 'knowledge-extraction-run', schemaVersion: 3, promptVersion: 'knowledge-extraction-v2' },
      { runKind: 'knowledge-extraction-run', schemaVersion: 4, promptVersion: 'knowledge-extraction-v14' }]) {
      const bytes = JSON.stringify(value); writeFileSync(runPath, bytes);
      expect(() => runStore.read(runId)).toThrow('knowledge_storage_unsupported');
      expect(() => runStore.listManifests()).toThrow('knowledge_storage_unsupported'); expect(readFileSync(runPath, 'utf8')).toBe(bytes);
    }
  });
  it('does not infer dead writers from lock age, unverifiable hosts, or malformed owners', () => {
    const lock = join(root(), WORKSPACE_LOCK_FILE);
    const owner = { owner: randomUUID(), pid: process.pid, hostname: hostname(), acquiredAt: '2000-01-01T00:00:00Z' };
    for (const value of [owner, { ...owner, hostname: 'unverifiable-remote-host' }, {}]) {
      const bytes = JSON.stringify(value); writeFileSync(lock, bytes);
      expect(storageLockState(lock)).toBe('busy'); recoverStorageLock(lock); expect(readFileSync(lock, 'utf8')).toBe(bytes);
    }
  });
  it('recovers proven exited local owners and interrupted recovery guards without removing a new live owner', () => {
    const workspace = root(); const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']); expect(dead.status).toBe(0);
    const lock = join(workspace, WORKSPACE_LOCK_FILE); const owner = randomUUID();
    const deadOwner = { owner, pid: dead.pid, hostname: hostname(), acquiredAt: '2026-10-08T00:00:00Z' };
    writeFileSync(lock, JSON.stringify(deadOwner));
    const guard = `${lock}.recovery-${owner}.lock`; writeFileSync(guard, JSON.stringify({ ...deadOwner, owner: randomUUID() }));
    expect(storageLockState(lock)).toBe('dead');
    expect(withWorkspaceWrite(workspace, () => 'written')).toBe('written');
    expect(existsSync(lock)).toBe(false); expect(existsSync(guard)).toBe(false);
    const bytes = JSON.stringify({ ...deadOwner, owner: randomUUID(), pid: process.pid });
    writeFileSync(lock, bytes); recoverStorageLock(lock); expect(readFileSync(lock, 'utf8')).toBe(bytes);
    writeFileSync(lock, JSON.stringify(deadOwner)); faults.beforeRecovery = () => writeFileSync(lock, bytes);
    recoverStorageLock(lock); expect(readFileSync(lock, 'utf8')).toBe(bytes);
  });
});
