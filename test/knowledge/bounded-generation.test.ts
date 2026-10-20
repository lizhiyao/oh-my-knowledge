import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorFn, ExecutorInput } from '../../src/executors/contracts/ports.js';
import type { ExecResult, ExecutorFailureKind } from '../../src/executors/contracts/result.js';
import { createOpenAiArchiveProducer, type OpenAiArchiveExecutorFactory } from '../../src/executors/openai/archive.js';
import { buildOpenAiChatRequest } from '../../src/executors/openai/request.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import { configuredExtractionModel } from '../../src/knowledge/adapters/executor.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileExtractionRunStore } from '../../src/knowledge/adapters/run-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { TraceEvidenceStore } from '../../src/knowledge/adapters/trace-evidence.js';
import { boundedExtractionPolicy } from '../../src/knowledge/extraction/generation-policy.js';
import { extractionRunSummary, type ExtractionRun } from '../../src/knowledge/extraction/runs.js';
import { modelWindow, wireModelWindow } from './fixtures.js';
import { extractionModelInput, EXTRACTION_INPUT_MAX_BYTES } from '../../src/knowledge/extraction/model-input.js';
import { STRICT_EXTRACTION_PROMPT, STRICT_EXTRACTION_PROMPT_VERSION } from '../../src/knowledge/extraction/strict-prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const textDigest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const policy = (maxTotalTokens = 3264) => boundedExtractionPolicy({
  maxInvocations: 3, maxReasks: 2, profileId: 'loopback-test/v1', maxTotalTokens, maxOutputTokens: 64,
});
function native(output: string | null, changes: Partial<ExecResult> = {}): ExecResult {
  return { ok: true, output, durationMs: 5, durationApiMs: 4, inputTokens: 7, outputTokens: 5,
    cacheReadTokens: 3, cacheCreationTokens: 0, tokenUsageReportedByExecutor: true,
    costUSD: 0, costReportedByExecutor: false, stopReason: 'stop', numTurns: 1, attemptCount: 1, ...changes };
}
function failed(failureKind: ExecutorFailureKind, changes: Partial<ExecResult> = {}): ExecResult {
  return native('original failed assistant text', { ok: false, error: 'original native diagnostic', failure: { failureKind }, ...changes });
}
function validOutput(evidenceRef: string) {
  return JSON.stringify(wireModelWindow()).replaceAll('record-1', evidenceRef);
}
type Reply = (input: ExecutorInput, index: number, evidenceRef: string) => ExecResult | Promise<ExecResult>;
function setup(reply: Reply = (_input, _index, ref) => native(validOutput(ref)), text = 'Alpha 使用 Beta') {
  const root = mkdtempSync(join(tmpdir(), 'omk-bounded-generation-')); roots.push(root);
  const source = join(root, 'log.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text }] } }));
  let currentTime = Date.parse('2026-10-16T00:00:00Z');
  const generationTiming = { now: () => currentTime, random: () => 0.5,
    wait: vi.fn(async (ms: number, signal?: AbortSignal) => { signal?.throwIfAborted(); currentTime += ms; signal?.throwIfAborted(); }) };
  const runs = new FileExtractionRunStore(join(root, 'extraction-runs'), root);
  const ports = { runs, evidence: new TraceEvidenceStore(join(root, 'sources'), root),
    knowledge: new FileKnowledgeStore(join(root, 'items'), 'test', root), tags: new FileKnowledgeTags(join(root, 'tags'), 'test', root),
    entities: new FileEntityAnalysisStore(join(root, 'entities'), root), id: randomUUID,
    now: () => new Date(currentTime).toISOString(), generationTiming,
    hash: (value: unknown) => textDigest(canonicalJson(value)), actor: { actorKind: 'human' as const, actorId: 'tester' } };
  const app = new KnowledgeApplication(ports), snapshot = app.capture({ path: source });
  let index = 0;
  const effects = vi.fn(async (input: ExecutorInput) => reply(input, index++, snapshot.excerpts[0].evidenceRef));
  const create = vi.fn((name: string, options: Parameters<OpenAiArchiveExecutorFactory>[1]): ExecutorFn => {
    expect(name).toBe('openai-api');
    return async input => {
      // Exercise the real producer identity check and dispatch gate, with no HTTP or subprocess.
      options.apiDispatchPolicy.beforeDispatch(buildOpenAiChatRequest(input, options.env, options.apiDispatchPolicy.requestConstraints));
      return effects(input);
    };
  });
  const producer = createOpenAiArchiveProducer({ OPENAI_API_KEY: 'loopback-fixture-key', OPENAI_BASE_URL: 'http://127.0.0.1:1' }, create);
  const model = configuredExtractionModel('openai-api', 'authored-loopback-test', producer, { maxOutputTokens: 64 });
  return { root, app, ports, snapshot, model, effects, create, runs, generationTiming };
}
function archived(run: ExtractionRun, runs: FileExtractionRunStore) {
  return run.attempts.map(attempt => {
    expect(attempt.outcome).toBeDefined();
    return runs.readOutcome(run.runId, attempt.attemptId, attempt.outcome).outcome;
  });
}

describe('bounded extraction generation', () => {
  it.each(['single', 'bounded'] as const)('binds explicit study prompt bytes through the %s production dispatch and immutable recovery', async mode => {
    const f = setup(), id = randomUUID();
    const promptProfile = { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const,
      promptVersion: 'knowledge-extraction-v9001', system: `${STRICT_EXTRACTION_PROMPT}\n\n受控开发候选：逐条保留条件。\n` };
    const options = { promptProfile, ...(mode === 'bounded' ? { policy: policy() } : {}) };
    const run = await f.app.generate(f.snapshot.snapshotId, f.model, id, undefined, options);
    expect(run.status).toBe('completed');
    expect(run.promptVersion).toBe(promptProfile.promptVersion);
    expect(run.promptHash).toBe(f.ports.hash(promptProfile.system));
    expect(f.effects.mock.calls[0][0].system).toBe(promptProfile.system);
    expect(run.attempts[0].request.systemDigest).toBe(textDigest(promptProfile.system));
    expect(run.attempts[0].producer).toEqual(f.model.inspect!(promptProfile.system, f.effects.mock.calls[0][0].prompt));
    const savedBytes = readFileSync(join(f.root, 'extraction-runs', `${id}.json`));
    expect(new KnowledgeApplication(f.ports).resume(id)).toEqual(run);
    await expect(f.app.generate(f.snapshot.snapshotId, f.model, id, undefined, { ...options,
      promptProfile: { ...promptProfile, promptVersion: 'knowledge-extraction-v9002' } })).rejects.toThrow('identity conflict');
    await expect(f.app.generate(f.snapshot.snapshotId, f.model, id, undefined, { ...options,
      promptProfile: { ...promptProfile, promptVersion: 'knowledge-extraction-v9002', system: `${promptProfile.system}改变候选。` } })).rejects.toThrow('identity conflict');
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(f.root, 'extraction-runs', `${id}.json`))).toEqual(savedBytes);
  });

  it('rejects malformed profiles and relabelled default prompts before creating a run or dispatching', async () => {
    const f = setup();
    for (const promptProfile of [
      { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const, promptVersion: 'knowledge-extraction-v9001', system: '   ' },
      { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const, promptVersion: 'knowledge-extraction-v9001\n', system: '候选' },
      { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const, promptVersion: 'knowledge-extraction-v9001', system: '\ud800' },
      { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const, promptVersion: 'knowledge-extraction-v9001', system: '字'.repeat(700_000) },
      ...['knowledge-extraction-v19', 'knowledge-extraction-v20', 'knowledge-extraction-v21', 'knowledge-extraction-v22', 'knowledge-extraction-v23'].map(promptVersion => ({
        profileVersion: 'knowledge-extraction-prompt-profile/v1' as const, promptVersion, system: 'Different bytes cannot borrow a published identity.',
      })),
      { profileVersion: 'knowledge-extraction-prompt-profile/v1' as const, promptVersion: STRICT_EXTRACTION_PROMPT_VERSION, system: `${STRICT_EXTRACTION_PROMPT}\n改变` },
    ]) await expect(f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { promptProfile })).rejects.toThrow();
    expect(f.app.runs()).toEqual([]); expect(f.effects).not.toHaveBeenCalled();
    const original = await f.app.generate(f.snapshot.snapshotId, f.model);
    expect(original.promptVersion).toBe(STRICT_EXTRACTION_PROMPT_VERSION);
    expect(f.effects.mock.calls[0][0].system).toBe(STRICT_EXTRACTION_PROMPT);
  });

  it('acknowledges the native archive before host observation and recovers a failed observer without redispatch', async () => {
    const f = setup(), id = randomUUID();
    const observed = vi.fn((event: { runId: string; attemptId: string; ref: { bytes: number; digest: string } }) => {
      const saved = f.runs.read(event.runId);
      expect(saved.attempts[0].outcome).toEqual(event.ref);
      expect(f.runs.readOutcome(event.runId, event.attemptId, event.ref).outcome).toMatchObject({ outcomeKind: 'result', result: { ok: true } });
      // Re-entering a host store proves the callback runs after the archive publisher releases its lock.
      f.runs.save(saved, saved.generation - 1);
      throw new Error('host observation publication failed');
    });
    await expect(f.app.generate(f.snapshot.snapshotId, f.model, id, undefined, { policy: policy(), onOutcomeArchived: observed }))
      .rejects.toThrow('host observation publication failed');
    expect(f.effects).toHaveBeenCalledTimes(1); expect(observed).toHaveBeenCalledTimes(1);
    const pending = f.runs.read(id), path = join(f.root, 'extraction-runs', 'outcomes', id, `${pending.attempts[0].attemptId}.json`);
    const bytes = readFileSync(path);
    expect(pending.attempts).toHaveLength(1); expect(pending.attempts[0].accounting).toBeUndefined();
    expect(new KnowledgeApplication(f.ports).resume(id).status).toBe('completed');
    expect(f.effects).toHaveBeenCalledTimes(1); expect(observed).toHaveBeenCalledTimes(1); expect(readFileSync(path)).toEqual(bytes);
  });
  it('archives invalid JSON before a feedback reask and creates one final entity and knowledge birth', async () => {
    const f = setup((_input, index, ref) => native(index ? validOutput(ref) : 'private invalid JSON {'));
    const entityWrite = vi.spyOn(f.ports.entities, 'write'), knowledgeWrite = vi.spyOn(f.ports.knowledge, 'write');
    const runId = randomUUID(), beforeDispatch = vi.fn(() => {
      const reserved = f.runs.read(runId), attempt = reserved.attempts.at(-1)!;
      expect(attempt.budget?.tokensReserved).toBe(1088); expect(attempt.outcome).toBeUndefined();
    });
    const run = await f.app.generate(f.snapshot.snapshotId, f.model, runId, undefined, { policy: policy(), beforeDispatch });
    expect(run.status).toBe('completed'); expect(run.attempts).toHaveLength(2); expect(f.effects).toHaveBeenCalledTimes(2);
    expect(beforeDispatch).toHaveBeenCalledTimes(2); expect(entityWrite).toHaveBeenCalledTimes(1); expect(knowledgeWrite).toHaveBeenCalledTimes(1);
    expect(run.selectedAttemptId).toBe(run.attempts[1].attemptId); expect(run.committed).toHaveLength(1);
    const outcomes = archived(run, f.runs);
    expect(outcomes[0]).toMatchObject({ outcomeKind: 'result', result: { output: 'private invalid JSON {', inputTokens: 7, cacheReadTokens: 3, costReportedByExecutor: false } });
    expect(run.attempts[0]).toMatchObject({ failure: { failureKind: 'parse_error' }, accounting: { status: 'reported', chargedTokens: 1088, observedTokens: 15, costUSD: null } });
    expect(run.attempts[1]).toMatchObject({ trigger: { triggerKind: 'validation', previousAttemptId: run.attempts[0].attemptId,
      feedback: { feedbackVersion: 'knowledge-generation-feedback/v1' } }, accounting: { chargedTokens: 1088, observedTokens: 15 } });
    expect(run.attempts[1].trigger?.feedback?.body).not.toContain('private invalid JSON');
    expect(run.attempts[1].request.inputDigest).not.toBe(run.attempts[0].request.inputDigest);
    for (const [index, attempt] of run.attempts.entries()) expect(attempt.request.inputDigest).toBe(textDigest(f.effects.mock.calls[index][0].prompt));
    expect(f.app.entities(runId).history.revisions).toHaveLength(1);
    expect(f.app.detail(run.committed[0].knowledgeId).history.revisions).toHaveLength(1);
    expect(readdirSync(join(f.root, 'extraction-runs', 'outcomes', runId))).toHaveLength(2);
    expect(extractionRunSummary(run).invocation.budget).toEqual({ reservedTokens: 2176, observedTokens: 30, unknownAttempts: 0, maxTotalTokens: 3264 });
  });

  it('charges unknown usage in full, honors Retry-After and applies exponential jitter before later success', async () => {
    const f = setup((_input, index, ref) => index === 0
      ? failed('rate_limit', { failure: { failureKind: 'rate_limit', httpStatus: 429, retryAfterMs: 1000 },
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, tokenUsageReportedByExecutor: false })
      : index === 1 ? failed('timeout') : native(validOutput(ref)));
    const run = await f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { policy: policy() });
    expect(run.status).toBe('completed'); expect(run.attempts).toHaveLength(3); expect(f.effects).toHaveBeenCalledTimes(3);
    expect(f.generationTiming.wait.mock.calls.map(([ms]) => ms)).toEqual([1000, 500]);
    expect(run.attempts[0].accounting).toMatchObject({ status: 'unknown', chargedTokens: 1088, observedTokens: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, costUSD: null });
    expect(run.attempts[1].trigger).toMatchObject({ triggerKind: 'transient', delayMs: 1000, previousAttemptId: run.attempts[0].attemptId });
    expect(run.attempts[2].trigger).toMatchObject({ triggerKind: 'transient', delayMs: 500, previousAttemptId: run.attempts[1].attemptId });
    expect(archived(run, f.runs)[0]).toMatchObject({ outcomeKind: 'result', result: { tokenUsageReportedByExecutor: false, inputTokens: 0, error: 'original native diagnostic' } });
    expect(extractionRunSummary(run).invocation.budget).toEqual({ reservedTokens: 3264, observedTokens: null, unknownAttempts: 1, maxTotalTokens: 3264 });
  });

  it('bounds validation reasks and allocates only one empty birth when the final envelope remains structurally admissible', async () => {
    for (const invalidJson of [true, false]) {
      const f = setup((_input, index) => native(invalidJson ? `invalid JSON ${index}`
        : JSON.stringify({ ...wireModelWindow(), entities: [{ entityId: 'invalid-item' }], mentions: [], proposals: [] })));
      const entityWrite = vi.spyOn(f.ports.entities, 'write'), knowledgeWrite = vi.spyOn(f.ports.knowledge, 'write');
      const run = await f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { policy: policy() });
      expect(run.status).toBe(invalidJson ? 'failed' : 'completed'); expect(run.attempts).toHaveLength(3); expect(f.effects).toHaveBeenCalledTimes(3);
      expect(run.attempts.slice(1).every(attempt => attempt.trigger?.triggerKind === 'validation')).toBe(true);
      expect(archived(run, f.runs)).toHaveLength(3); expect(run.committed).toEqual([]);
      expect(entityWrite).toHaveBeenCalledTimes(invalidJson ? 0 : 1); expect(knowledgeWrite).not.toHaveBeenCalled();
      expect(extractionRunSummary(run).invocation.budget.reservedTokens).toBe(3264);
      expect(f.app.quality().groups[0].runs).toMatchObject({ total: 1, withAdmission: invalidJson ? 0 : 1 });
    }
  });

  it('does not retry hard failures, unbounded Retry-After, invalid usage or hidden multiple-attempt results', async () => {
    const cases: ExecResult[] = [
      ...(['authentication', 'permission', 'invalid_request', 'unsupported_output', 'refusal', 'content_filter', 'truncation', 'capacity', 'unknown'] as const).map(failureKind => failed(failureKind)),
      failed('rate_limit', { failure: { failureKind: 'rate_limit', retryAfterMs: 300_001 } }),
      failed('server_error', { inputTokens: 1022, cacheReadTokens: 3 }),
      failed('server_error', { outputTokens: 65 }),
      failed('server_error', { inputTokens: -1 }),
      failed('server_error', { attemptCount: 2 }),
    ];
    for (const result of cases) {
      const f = setup(() => result);
      const run = await f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { policy: policy() });
      expect(run.status).toBe('failed'); expect(run.attempts).toHaveLength(1); expect(f.effects).toHaveBeenCalledTimes(1);
      expect(f.generationTiming.wait).not.toHaveBeenCalled(); expect(archived(run, f.runs)).toEqual([{ outcomeKind: 'result', result }]);
      expect(run.committed).toEqual([]);
    }
  });

  it('checks total reservation before the first request and never refunds a failed attempt to authorize another', async () => {
    const f = setup(() => failed('server_error'));
    await expect(f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { policy: policy(1087) })).rejects.toThrow(/budget|token/i);
    expect(f.effects).not.toHaveBeenCalled(); expect(f.runs.list()).toEqual([]);
    const run = await f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { policy: policy(1088) });
    expect(run.status).toBe('failed'); expect(run.attempts).toHaveLength(1); expect(f.effects).toHaveBeenCalledTimes(1);
    expect(f.generationTiming.wait).not.toHaveBeenCalled(); expect(run.attempts[0].accounting?.chargedTokens).toBe(1088);
  });
  it('settles an archived attempt when adding validation feedback would exceed the input capacity', async () => {
    const base = setup(), overhead = Buffer.byteLength(STRICT_EXTRACTION_PROMPT) + Buffer.byteLength(extractionModelInput(base.snapshot));
    const f = setup(() => native('{'), 'Alpha 使用 Beta' + 'x'.repeat(EXTRACTION_INPUT_MAX_BYTES - overhead));
    expect(Buffer.byteLength(STRICT_EXTRACTION_PROMPT) + Buffer.byteLength(extractionModelInput(f.snapshot))).toBe(EXTRACTION_INPUT_MAX_BYTES);
    const run = await f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { policy: policy() });
    expect(run.status).toBe('failed'); expect(run.error).toContain('1 MiB'); expect(run.finishedAt).toBeDefined();
    expect(run.attempts).toHaveLength(1); expect(run.attempts[0].failure?.failureKind).toBe('parse_error');
    expect(run.attempts[0].accounting?.chargedTokens).toBe(1088); expect(f.effects).toHaveBeenCalledTimes(1);
    expect(f.generationTiming.wait).not.toHaveBeenCalled(); expect(run.committed).toEqual([]);
    expect(archived(run, f.runs)[0]).toMatchObject({ outcomeKind: 'result', result: { output: '{' } });
    expect(f.app.resume(run.runId)).toEqual(run); expect(f.effects).toHaveBeenCalledTimes(1);
  });

  it('preserves valid siblings and legitimate empty responses without reasking or merging another output', async () => {
    for (const partial of [true, false]) {
      const f = setup((_input, _index, ref) => {
        const packet = wireModelWindow(partial ? modelWindow() : { ...modelWindow(), entities: [], mentions: [], proposals: [] });
        const output = partial ? { ...packet, entities: [...packet.entities, { entityId: 'invalid-sibling' }] } : packet;
        return native(JSON.stringify(output).replaceAll('record-1', ref));
      });
      const run = await f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { policy: policy() });
      expect(run.status).toBe('completed'); expect(run.attempts).toHaveLength(1); expect(f.effects).toHaveBeenCalledTimes(1);
      expect(run.committed).toHaveLength(partial ? 1 : 0); expect(f.generationTiming.wait).not.toHaveBeenCalled();
      expect(f.app.entities(run.runId).revision.entities).toHaveLength(partial ? 2 : 0);
      expect(run.attempts[0].wireDiagnostic?.wireStatus).toBe(partial ? 'item_failures' : 'valid');
    }
  });

  it('reopens completed or unknown started runs without dispatch, and keeps failure archives byte-identical', async () => {
    const f = setup((_input, index, ref) => native(index ? validOutput(ref) : '{'));
    const id = randomUUID(), selected = policy(), run = await f.app.generate(f.snapshot.snapshotId, f.model, id, undefined, { policy: selected });
    const first = run.attempts[0], path = join(f.root, 'extraction-runs', 'outcomes', id, `${first.attemptId}.json`), before = readFileSync(path);
    const reopened = new KnowledgeApplication(f.ports), noDispatch = vi.fn(() => { throw new Error('replay cannot dispatch'); });
    expect(await reopened.generate(f.snapshot.snapshotId, f.model, id, undefined, { policy: selected, beforeDispatch: noDispatch })).toEqual(run);
    expect(reopened.resume(id)).toEqual(run); expect(f.effects).toHaveBeenCalledTimes(2); expect(noDispatch).not.toHaveBeenCalled();
    expect(readFileSync(path)).toEqual(before);
    const startedId = randomUUID();
    const create = f.runs.create.bind(f.runs);
    const acknowledgement = vi.spyOn(f.runs, 'create').mockImplementationOnce(value => { create(value); throw new Error('reservation acknowledgement interrupted'); });
    await expect(reopened.generate(f.snapshot.snapshotId, f.model, startedId, undefined, { policy: selected, beforeDispatch: noDispatch })).rejects.toThrow('reservation acknowledgement interrupted');
    acknowledgement.mockRestore();
    const started = f.runs.read(startedId);
    expect(reopened.resume(startedId)).toEqual(started);
    expect(await reopened.generate(f.snapshot.snapshotId, f.model, startedId, undefined, { policy: selected, beforeDispatch: noDispatch })).toEqual(started);
    expect(f.effects).toHaveBeenCalledTimes(2); expect(noDispatch).not.toHaveBeenCalled();
  });

  it('settles native failures and decoded responses when their source is deleted during the invocation', async () => {
    for (const decodedSuccess of [false, true]) {
      let deleteSource: () => void = () => { throw new Error('Fixture source deletion was not configured.'); };
      const f = setup(async (_input, _index, ref) => {
        await Promise.resolve(); deleteSource();
        return decodedSuccess ? native(validOutput(ref)) : failed('server_error');
      });
      deleteSource = () => f.app.deleteSource(f.snapshot.snapshotId);
      const entityWrite = vi.spyOn(f.ports.entities, 'write'), knowledgeWrite = vi.spyOn(f.ports.knowledge, 'write'), beforeDispatch = vi.fn();
      const run = await f.app.generate(f.snapshot.snapshotId, f.model, randomUUID(), undefined, { policy: policy(), beforeDispatch });
      expect(f.app.source(f.snapshot.snapshotId)).toMatchObject({ status: 'unavailable', reason: 'deleted' });
      expect(run.status).toBe('failed'); expect(run.finishedAt).toBeDefined(); expect(run.attempts).toHaveLength(1);
      expect(run.attempts[0]).toMatchObject({ failure: { failureKind: decodedSuccess ? 'source_unavailable' : 'server_error' },
        accounting: { status: 'reported', chargedTokens: 1088, observedTokens: 15, costUSD: null } });
      expect(archived(run, f.runs)).toEqual([{ outcomeKind: 'result', result: decodedSuccess
        ? native(validOutput(f.snapshot.excerpts[0].evidenceRef)) : failed('server_error') }]);
      expect(f.effects).toHaveBeenCalledTimes(1); expect(beforeDispatch).toHaveBeenCalledTimes(1); expect(f.generationTiming.wait).not.toHaveBeenCalled();
      expect(entityWrite).not.toHaveBeenCalled(); expect(knowledgeWrite).not.toHaveBeenCalled(); expect(run.committed).toEqual([]);
      const manifestPath = join(f.root, 'extraction-runs', `${run.runId}.json`), before = readFileSync(manifestPath);
      expect(new KnowledgeApplication(f.ports).resume(run.runId)).toEqual(run);
      expect(f.app.resume(run.runId)).toEqual(run); expect(readFileSync(manifestPath)).toEqual(before);
      expect(f.effects).toHaveBeenCalledTimes(1); expect(beforeDispatch).toHaveBeenCalledTimes(1);
    }
  });

  it('cancels a pending backoff and archives gate refusal without a second or unapproved dispatch', async () => {
    const f = setup(() => failed('server_error')), controller = new AbortController(), id = randomUUID();
    f.generationTiming.wait.mockImplementationOnce(async (_ms, signal) => { controller.abort(); signal?.throwIfAborted(); });
    const cancelled = await f.app.generate(f.snapshot.snapshotId, f.model, id, controller.signal, { policy: policy() })
      .then(run => ({ run }), error => ({ error: error as unknown }));
    if ('error' in cancelled) expect(cancelled.error).toBe(controller.signal.reason);
    const saved = f.runs.read(id);
    expect(saved.status).toBe('cancelled'); expect(f.effects).toHaveBeenCalledTimes(1); expect(saved.attempts).toHaveLength(2);
    expect(f.runs.readOutcome(id, saved.attempts[0].attemptId, saved.attempts[0].outcome).outcome).toMatchObject({ outcomeKind: 'result', result: { failure: { failureKind: 'server_error' } } });
    expect(saved.attempts[1].outcome).toBeUndefined(); expect(saved.attempts[1].accounting).toBeUndefined();
    expect(extractionRunSummary(saved).invocation.budget).toMatchObject({ reservedTokens: 2176, observedTokens: null, unknownAttempts: 1 });
    const blocked = setup(), gate = vi.fn(() => { throw new Error('permission quota refused'); });
    const run = await blocked.app.generate(blocked.snapshot.snapshotId, blocked.model, randomUUID(), undefined, { policy: policy(), beforeDispatch: gate });
    expect(run.status).toBe('failed'); expect(gate).toHaveBeenCalledTimes(1); expect(blocked.effects).not.toHaveBeenCalled();
    expect(run.attempts).toHaveLength(1); expect(archived(run, blocked.runs)[0]).toMatchObject({ outcomeKind: 'exception', error: { message: 'permission quota refused' } });
    expect(run.attempts[0].accounting).toMatchObject({ status: 'unknown', chargedTokens: 1088, observedTokens: null });
    expect(blocked.generationTiming.wait).not.toHaveBeenCalled();
  });
});
