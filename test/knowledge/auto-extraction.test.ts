import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationAutoExtraction } from '../../src/knowledge/application/auto-extraction.js';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import type { ConversationCatalog } from '../../src/observability/conversation/catalog.js';
import type { ExtractionModel } from '../../src/knowledge/application/application.js';
import { modelWindow, wireModelWindow } from './fixtures.js';
import { boundedExtractionPolicy, type ExtractionGenerationPolicy } from '../../src/knowledge/extraction/generation-policy.js';
import { FileExtractionRunStore } from '../../src/knowledge/adapters/run-store.js';
import { configuredExtractionModel } from '../../src/knowledge/adapters/executor.js';
import { createOpenAiArchiveProducer } from '../../src/executors/openai/archive.js';
import { buildOpenAiChatRequest } from '../../src/executors/openai/request.js';
import { executeKnowledgeCandidateAction } from '../../src/studio/application/knowledge/knowledge-candidates.js';
import { conversationExtractionSource } from '../../src/knowledge/extraction/conversation-source.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture(options?: { realTime?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'omk-auto-extraction-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'knowledge');
  let now = Date.parse('2026-10-10T00:00:00Z');
  const tasks = [0, 1, 2, 3].map(index => ({ turnId: `turn-${index}`, title: 'Synthetic work', status: 'completed' as 'completed' | 'open',
    eventCount: 1, toolCallCount: 0, toolFailureCount: 0, relatedSkillNames: [] }));
  let changed = '';
  const catalog: ConversationCatalog = {
    async listConversations() { return { conversations: [(await this.getConversation('thread'))!, (await this.getConversation('other'))!], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 }; },
    async getConversation(threadId) { return { threadId, sourceThreadId: threadId, sourceKind: 'codex', title: 'Synthetic conversation', cwd: threadId === 'thread' ? '/project' : '/other', tasks, relatedSkillNames: [] }; },
    async loadTaskTrajectory() { throw new Error('Full trajectory must not be read.'); },
    async loadTaskMessageRecords(_thread, turnId) { return { path: join(root, 'synthetic.jsonl'), records: [{ recordIndex: Number(turnId.split('-')[1]),
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Alpha 使用 Beta ${turnId}${changed}` }] } }) }] }; },
  };
  const inputs: string[] = [];
  let implementation: ExtractionModel['generate'] = async (_system, input) => {
    inputs.push(input); const parsed = JSON.parse(input);
    const output = JSON.stringify(modelWindow()).replaceAll('record-1', parsed.excerpts[0].evidenceRef);
    return { output, durationMs: 1 };
  };
  let factory: ((executor: string, model: string, policy?: ExtractionGenerationPolicy) => ExtractionModel) | undefined;
  const create = () => {
    const service = new ConversationAutoExtraction(catalog, { intervalMs: 0, stableMs: options?.realTime ? 0 : 30_000, now: options?.realTime ? Date.now : () => now,
      model: (executor, model, policy) => factory?.(executor, model, policy) ?? { executor, model, generate: (...args) => implementation(...args) } });
    cleanups.push(() => service.close()); return service;
  };
  const service = create();
  const enable = async (limit = 5, policy?: ExtractionGenerationPolicy, selection = { executor: 'codex', model: 'synthetic' }) => service.enable(workspace, 'thread', {
    token: (await service.preview('thread')).token, ...selection, maxCalls: limit, ...(policy ? { policy } : {}) });
  const tick = async () => { await service.tick(); now += 30_000; await service.tick(); };
  return { root, workspace, tasks, catalog, service, create, inputs, enable, tick,
    now: () => now, advance: (ms: number) => { now += ms; }, change: () => { changed += ' changed'; }, setModel: (fn: ExtractionModel['generate']) => { implementation = fn; },
    setFactory: (value: NonNullable<typeof factory>) => { factory = value; } };
}
describe('authorized conversation auto extraction', () => {
  it('previews locally, rejects stale consent, then processes a stable bounded window and pauses at quota', async () => {
    const f = fixture(); const preview = await f.service.preview('thread');
    expect(preview.turnCount).toBe(3); expect(preview.messages.map(item => item.recordIndex)).toEqual([1, 2, 3]);
    await f.service.tick(); expect(f.inputs).toHaveLength(0);
    f.change(); await expect(f.service.enable(f.workspace, 'thread', { token: preview.token, executor: 'codex', model: 'synthetic', maxCalls: 1 })).rejects.toThrow(/conflict/);
    await f.enable(1); await f.service.tick(); expect(f.inputs).toHaveLength(0);
    f.advance(29_999); await f.service.tick(); expect(f.inputs).toHaveLength(0);
    f.advance(1); await f.service.tick(); expect(f.inputs).toHaveLength(1);
    expect(f.inputs[0]).not.toContain(f.root);
    const permissionFiles = readdirSync(join(f.workspace, 'auto-extraction'));
    const attempt = JSON.parse(readFileSync(join(f.workspace, 'auto-extraction', permissionFiles.find(name => name.startsWith('attempt-'))!), 'utf8'));
    const permission = JSON.parse(readFileSync(join(f.workspace, 'auto-extraction', `permission-${attempt.permissionId}.json`), 'utf8'));
    expect(attempt.turnIds).toEqual(['turn-1', 'turn-2', 'turn-3']); expect(permission.maxCalls).toBe(1);
    expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'quota', callsUsed: 1 });
    const app = createLocalKnowledgeApplication(f.workspace);
    expect(app.list()).toHaveLength(1); expect(app.list()[0].choice).toBeNull();
    expect(app.runs()[0].origin?.threadId).toBe('thread');
  });
  it('waits for finished turns, includes preceding context, and never re-sends an attempted identical window', async () => {
    const f = fixture(); await f.enable(); await f.tick();
    await f.tick(); expect(f.inputs).toHaveLength(1);
    f.tasks.push({ ...f.tasks[0], turnId: 'turn-4', status: 'open' }); await f.tick(); expect(f.inputs).toHaveLength(1);
    f.tasks[4].status = 'completed'; await f.tick(); expect(f.inputs).toHaveLength(2);
    expect(JSON.parse(f.inputs[1]).excerpts.map((entry: { recordIndex: number }) => entry.recordIndex)).toEqual([2, 3, 4]);
    f.service.stop(f.workspace, 'thread'); await f.enable(); await f.tick(); expect(f.inputs).toHaveLength(2);
  });
  it('does not retry errors and does not leak raw errors to the status view', async () => {
    const f = fixture(); let calls = 0;
    f.setModel(async () => { calls++; throw new Error('/secret/path credential'); });
    await f.enable(); await f.tick(); await f.tick();
    expect(calls).toBe(1); expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'failed', callsUsed: 1 });
    expect(JSON.stringify(f.service.status(f.workspace, 'thread'))).not.toContain('credential');
    await f.enable(); await f.tick(); expect(calls).toBe(1);
  });
  it('charges every bounded dispatch across attempts and recovers stale counters without refunding or re-sending a source', async () => {
    const f = fixture(); let calls = 0;
    const policy = boundedExtractionPolicy({ profileId: 'loopback-test/v1', maxInvocations: 3, maxReasks: 0, maxTotalTokens: 3264, maxOutputTokens: 64 });
    const producer = createOpenAiArchiveProducer({ OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'http://127.0.0.1:9321/v1' }, (_executor, options) => async input => {
      options.apiDispatchPolicy.beforeDispatch(buildOpenAiChatRequest(input, options.env, 'single-completion/v1'));
      calls++;
      return { ok: false, output: null, error: 'Synthetic transient failure', failure: { failureKind: 'network_error' }, durationMs: 1, durationApiMs: 1, stopReason: 'error',
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false,
        costUSD: 0, costReportedByExecutor: false, numTurns: 0 };
    });
    f.setFactory((executor, model, selected) => configuredExtractionModel(executor, model, producer,
      { maxOutputTokens: selected?.policyId === 'knowledge-generation-bounded/v1' ? selected.maxOutputTokens : 64 }));
    await f.enable(2, policy, { executor: 'openai-api', model: 'authored-loopback-test' }); await f.tick();
    expect(calls).toBe(2);
    const state = f.service.status(f.workspace, 'thread')!;
    expect(state).toMatchObject({ enabled: false, reason: 'quota', callsUsed: 2, tokensReserved: 2176, policy });
    const directory = join(f.workspace, 'auto-extraction'), files = readdirSync(directory);
    const receipts = files.filter(name => name.startsWith('attempt-')).map(name => ({ path: join(directory, name), bytes: readFileSync(join(directory, name)) }));
    expect(receipts).toHaveLength(2);
    expect(receipts.map(({ bytes }) => JSON.parse(bytes.toString())).sort((a, b) => a.callNumber - b.callNumber)).toMatchObject([
      { permissionId: state.permissionId, runId: state.lastRunId, callNumber: 1, requestDigest: expect.stringMatching(/^sha256:/), budget: { tokensReserved: 1088 } },
      { permissionId: state.permissionId, runId: state.lastRunId, callNumber: 2, requestDigest: expect.stringMatching(/^sha256:/), budget: { tokensReserved: 1088 } },
    ]);
    const statePath = join(directory, files.find(name => /^[a-f0-9]{64}\.json$/.test(name))!);
    const staging = `${receipts[0].path}.123.00000000-0000-4000-8000-000000000000.tmp`;
    writeFileSync(staging, receipts[0].bytes, { flag: 'wx' });
    const old = { schemaVersion: 1, automationKind: 'conversation-knowledge-attempt', runId: randomUUID(), permissionId: randomUUID(),
      threadId: 'thread', turnIds: ['turn-0'], sourceVersion: `sha256:${'a'.repeat(64)}`, reservedAt: new Date(f.now()).toISOString(), callNumber: 1 };
    const oldPath = join(directory, `attempt-${old.runId}.json`), oldBytes = JSON.stringify(old);
    writeFileSync(oldPath, oldBytes, { flag: 'wx' });
    // The immutable dispatch receipt wins when the mutable state acknowledgement was lost.
    writeFileSync(statePath, JSON.stringify({ ...state, callsUsed: 0, tokensReserved: 0 }));
    expect(f.service.status(f.workspace, 'thread')).toMatchObject({ callsUsed: 2, tokensReserved: 2176 });
    await f.tick(); expect(calls).toBe(2);
    await f.enable(); expect(f.service.status(f.workspace, 'thread')).not.toHaveProperty('policy');
    await f.tick(); expect(calls).toBe(2);
    for (const receipt of receipts) expect(readFileSync(receipt.path)).toEqual(receipt.bytes);
    expect(readFileSync(staging)).toEqual(receipts[0].bytes);
    expect(readFileSync(oldPath, 'utf8')).toBe(oldBytes);
  });
  it('records cooldown once before ordinary retry backoff and permits the next invocation after that wait', async () => {
    const f = fixture({ realTime: true }); let calls = 0;
    const dispatched: number[] = [];
    const policy = boundedExtractionPolicy({ profileId: 'loopback-test/v1', maxInvocations: 3, maxReasks: 0, maxTotalTokens: 3264, maxOutputTokens: 64 });
    const producer = createOpenAiArchiveProducer({ OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'http://127.0.0.1:9321/v1' }, (_executor, options) => async input => {
      options.apiDispatchPolicy.beforeDispatch(buildOpenAiChatRequest(input, options.env, 'single-completion/v1'));
      calls++; dispatched.push(Date.now());
      return { ok: calls > 1, output: calls > 1 ? JSON.stringify(wireModelWindow()).replaceAll('record-1', JSON.parse(input.prompt).excerpts[0].evidenceRef) : null,
        ...(calls === 1 ? { error: 'Synthetic rate limit', failure: { failureKind: 'rate_limit' as const, retryAfterMs: 20 } } : {}),
        durationMs: 1, durationApiMs: 1, stopReason: calls > 1 ? 'stop' : 'error', inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, numTurns: 1 };
    });
    f.setFactory((executor, model) => configuredExtractionModel(executor, model, producer, { maxOutputTokens: 64 }));
    await f.enable(5, policy, { executor: 'openai-api', model: 'authored-loopback-test' }); await f.tick();
    expect(calls).toBe(2); expect(createLocalKnowledgeApplication(f.workspace).runs()[0].status).toBe('completed');
    const directory = join(f.workspace, 'auto-extraction', 'cooldowns');
    const facts = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => ({ path: join(directory, name), value: JSON.parse(readFileSync(join(directory, name), 'utf8')) }));
    const required = facts.find(fact => fact.value.decision === 'required')!;
    expect(required.value.retryAfterMs).toBe(20); expect(dispatched[1]).toBeGreaterThanOrEqual(Date.parse(required.value.notBefore));
    const bytes = readFileSync(required.path); f.service.status(f.workspace, 'thread'); f.service.status(f.workspace, 'thread');
    expect(readFileSync(required.path)).toEqual(bytes);
    const receiptPaths = readdirSync(join(f.workspace, 'auto-extraction')).filter(name => name.startsWith('attempt-'))
      .map(name => join(f.workspace, 'auto-extraction', name)).sort();
    const reads = vi.spyOn(fs, 'readFileSync'), syncs = vi.spyOn(fs, 'fsyncSync');
    const manifests = vi.spyOn(FileExtractionRunStore.prototype, 'readManifest'), outcomes = vi.spyOn(FileExtractionRunStore.prototype, 'readOutcome');
    try {
      syncBuiltinESMExports();
      for (let repeat = 0; repeat < 2; repeat++) {
        for (const poll of [() => f.service.status(f.workspace, 'thread'), () => f.service.tick()]) {
          reads.mockClear(); syncs.mockClear(); manifests.mockClear(); outcomes.mockClear(); await poll();
          expect(reads.mock.calls.map(([path]) => path).filter(path => typeof path === 'string' && receiptPaths.includes(path)).sort()).toEqual(receiptPaths);
          expect(syncs).not.toHaveBeenCalled(); expect(manifests).not.toHaveBeenCalled(); expect(outcomes).not.toHaveBeenCalled();
        }
      }
      // A new lifetime confirms each existing fact once; close also clears the old lifetime's cache.
      const next = f.create(); syncs.mockClear(); next.status(f.workspace, 'thread');
      expect(syncs).toHaveBeenCalledTimes(facts.length * 3);
      syncs.mockClear(); next.status(f.workspace, 'thread'); expect(syncs).not.toHaveBeenCalled();
      next.close(); syncs.mockClear(); next.status(f.workspace, 'thread');
      expect(syncs).toHaveBeenCalledTimes(facts.length * 3);
    } finally { reads.mockRestore(); syncs.mockRestore(); manifests.mockRestore(); outcomes.mockRestore(); syncBuiltinESMExports(); }
    expect(calls).toBe(2); expect(readFileSync(required.path)).toEqual(bytes);
  });
  it('revalidates cooldown bytes and file identity instead of trusting unchanged size and timestamps', async () => {
    const f = fixture(); await f.enable(1); await f.tick();
    const directory = join(f.workspace, 'auto-extraction', 'cooldowns'), path = join(directory, readdirSync(directory)[0]);
    const pinnedTime = new Date('2026-10-10T00:00:00Z'); fs.utimesSync(path, pinnedTime, pinnedTime);
    f.service.status(f.workspace, 'thread');
    const original = readFileSync(path), before = fs.lstatSync(path);
    const changed = Buffer.from(original.toString().replace('  "', '\t "'));
    expect(changed.equals(original)).toBe(false); expect(changed.length).toBe(original.length);
    const syncs = vi.spyOn(fs, 'fsyncSync');
    try {
      syncBuiltinESMExports();
      writeFileSync(path, changed); fs.utimesSync(path, pinnedTime, pinnedTime);
      expect(fs.lstatSync(path)).toMatchObject({ dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs });
      f.service.status(f.workspace, 'thread'); expect(syncs).toHaveBeenCalledTimes(3);
      syncs.mockClear(); f.service.status(f.workspace, 'thread'); expect(syncs).not.toHaveBeenCalled();
      const replacement = join(directory, 'owned-replacement.tmp'); writeFileSync(replacement, changed); fs.utimesSync(replacement, pinnedTime, pinnedTime);
      fs.renameSync(replacement, path); expect(fs.lstatSync(path).ino).not.toBe(before.ino);
      expect(fs.lstatSync(path)).toMatchObject({ dev: before.dev, size: before.size, mtimeMs: before.mtimeMs });
      f.service.status(f.workspace, 'thread'); expect(syncs).toHaveBeenCalledTimes(3);
      const invalid = JSON.parse(changed.toString()); invalid.requestDigest = `sha256:${'f'.repeat(64)}`;
      writeFileSync(path, JSON.stringify(invalid, null, 2)); syncs.mockClear();
      expect(() => f.service.status(f.workspace, 'thread')).toThrow('Automation cooldown identity conflict');
      expect(syncs).not.toHaveBeenCalled();
      writeFileSync(path, changed); fs.utimesSync(path, pinnedTime, pinnedTime);
      f.service.status(f.workspace, 'thread'); expect(syncs).toHaveBeenCalledTimes(3);
      expect(readFileSync(path)).toEqual(changed); expect(f.inputs).toHaveLength(1);
    } finally { syncs.mockRestore(); syncBuiltinESMExports(); }
  });
  it('recovers a lost cooldown acknowledgement with one native read and keeps resume archive validation complete', async () => {
    const f = fixture(); let beforeArchive!: Buffer, manifestPath!: string;
    f.setModel(async (_system, input) => {
      f.inputs.push(input);
      const run = createLocalKnowledgeApplication(f.workspace).runs()[0];
      manifestPath = join(f.workspace, 'extraction-runs', `${run.runId}.json`); beforeArchive = readFileSync(manifestPath);
      return { output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 };
    });
    await f.enable(1); await f.tick();
    const directory = join(f.workspace, 'auto-extraction', 'cooldowns'), path = join(directory, readdirSync(directory)[0]);
    const originalFact = readFileSync(path), fact = JSON.parse(originalFact.toString());
    const outcomePath = join(f.workspace, 'extraction-runs', 'outcomes', fact.runId, `${fact.attemptId}.json`), native = readFileSync(outcomePath);
    const reads = vi.spyOn(FileExtractionRunStore.prototype, 'read'), manifests = vi.spyOn(FileExtractionRunStore.prototype, 'readManifest');
    const outcomes = vi.spyOn(FileExtractionRunStore.prototype, 'readOutcome'), originalSync = fs.fsyncSync;
    let loseAcknowledgement = true;
    const syncs = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (loseAcknowledgement && fs.fstatSync(fd).isFile()) {
        let value: { automationKind?: string } | undefined;
        try { value = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { /* Not a cooldown JSON document. */ }
        if (value?.automationKind === 'conversation-knowledge-cooldown') {
          loseAcknowledgement = false; throw new Error('Synthetic cooldown acknowledgement lost.');
        }
      }
      originalSync(fd);
    });
    try {
      syncBuiltinESMExports(); rmSync(path);
      expect(() => f.service.status(f.workspace, 'thread')).toThrow('Synthetic cooldown acknowledgement lost');
      expect(reads).not.toHaveBeenCalled(); expect(manifests).toHaveBeenCalledTimes(1); expect(outcomes).toHaveBeenCalledTimes(1);
      expect(readFileSync(path)).toEqual(originalFact); expect(readFileSync(outcomePath)).toEqual(native);
      reads.mockClear(); manifests.mockClear(); outcomes.mockClear(); syncs.mockClear();
      expect(f.service.status(f.workspace, 'thread')).toMatchObject({ reason: 'quota', callsUsed: 1 });
      expect(syncs).toHaveBeenCalledTimes(3); expect(reads).not.toHaveBeenCalled(); expect(manifests).not.toHaveBeenCalled(); expect(outcomes).not.toHaveBeenCalled();
      syncs.mockClear(); f.service.status(f.workspace, 'thread'); expect(syncs).not.toHaveBeenCalled();
      // Status observes the immutable fact. A real resume still verifies the native bytes.
      const alteredNative = Buffer.concat([native, Buffer.from(' ')]); writeFileSync(outcomePath, alteredNative);
      expect(() => createLocalKnowledgeApplication(f.workspace).resume(fact.runId)).toThrow('integrity mismatch');
      expect(reads).toHaveBeenCalledTimes(1);
      reads.mockClear(); manifests.mockClear(); outcomes.mockClear(); syncs.mockClear(); rmSync(path);
      expect(() => f.service.status(f.workspace, 'thread')).toThrow('integrity mismatch');
      expect(reads).not.toHaveBeenCalled(); expect(manifests).toHaveBeenCalledTimes(1); expect(outcomes).toHaveBeenCalledTimes(1);
      expect(existsSync(path)).toBe(false); expect(syncs).not.toHaveBeenCalled(); expect(readFileSync(outcomePath)).toEqual(alteredNative);
      writeFileSync(outcomePath, native); f.service.status(f.workspace, 'thread'); expect(syncs).toHaveBeenCalledTimes(3);
      expect(readFileSync(path)).toEqual(originalFact); expect(f.inputs).toHaveLength(1);
      // Recreate an actual saved pre-outcome manifest: its native sidecar outlived the lost manifest acknowledgement.
      const completedManifest = readFileSync(manifestPath); writeFileSync(manifestPath, beforeArchive); rmSync(path);
      reads.mockClear(); manifests.mockClear(); outcomes.mockClear(); syncs.mockClear();
      f.service.status(f.workspace, 'thread');
      expect(reads).not.toHaveBeenCalled(); expect(manifests).toHaveBeenCalledTimes(1); expect(outcomes).toHaveBeenCalledTimes(1);
      expect(outcomes).toHaveBeenCalledWith(fact.runId, fact.attemptId, undefined);
      expect(syncs).toHaveBeenCalledTimes(8); // Native file + its four parent directories, then cooldown file + two directories.
      expect(readFileSync(manifestPath)).toEqual(beforeArchive); expect(readFileSync(outcomePath)).toEqual(native);
      expect(readFileSync(path)).toEqual(originalFact); expect(f.inputs).toHaveLength(1);
      writeFileSync(manifestPath, completedManifest);
    } finally { reads.mockRestore(); manifests.mockRestore(); outcomes.mockRestore(); syncs.mockRestore(); syncBuiltinESMExports(); }
  });
  it('preserves an already-archived rate limit when stopped during retry backoff before reapproval', async () => {
    const f = fixture(); let calls = 0;
    const policy = boundedExtractionPolicy({ profileId: 'loopback-test/v1', maxInvocations: 3, maxReasks: 0, maxTotalTokens: 3264, maxOutputTokens: 64 });
    const producer = createOpenAiArchiveProducer({ OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'http://127.0.0.1:9321/v1' }, (_executor, options) => async input => {
      options.apiDispatchPolicy.beforeDispatch(buildOpenAiChatRequest(input, options.env, 'single-completion/v1')); calls++;
      return { ok: false, output: null, error: 'Synthetic rate limit', failure: { failureKind: 'rate_limit', retryAfterMs: 120_000 },
        durationMs: 1, durationApiMs: 1, stopReason: 'error', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, numTurns: 0 };
    });
    f.setFactory((executor, model) => configuredExtractionModel(executor, model, producer, { maxOutputTokens: 64 }));
    const selection = { executor: 'openai-api', model: 'authored-loopback-test' };
    await f.enable(5, policy, selection); await f.service.tick(); f.advance(30_000);
    const generating = f.service.tick();
    await vi.waitFor(() => expect(createLocalKnowledgeApplication(f.workspace).runs()[0]?.attempts).toHaveLength(2));
    f.service.stop(f.workspace, 'thread'); await generating;
    const stopped = f.service.status(f.workspace, 'thread')!;
    expect(stopped).toMatchObject({ enabled: false, reason: 'stopped', callsUsed: 1 }); expect(stopped.notBefore).toBeTruthy();
    const run = createLocalKnowledgeApplication(f.workspace).runs()[0]; expect(run.status).toBe('cancelled'); expect(run.attempts[1].outcome).toBeUndefined();
    // The processing fact keeps its original deadline across explicit reapproval.
    const directory = join(f.workspace, 'auto-extraction', 'cooldowns');
    const required = readdirSync(directory).map(name => join(directory, name)).find(path => JSON.parse(readFileSync(path, 'utf8')).decision === 'required')!;
    const bytes = readFileSync(required);
    f.tasks.push({ ...f.tasks[0], turnId: 'turn-4' }); await f.enable(5, policy, selection); await f.tick();
    expect(calls).toBe(1); expect(f.service.status(f.workspace, 'thread')?.notBefore).toBe(stopped.notBefore); expect(readFileSync(required)).toEqual(bytes);
    // Recreate the crash boundary before fact/state publication using only this fixture's files.
    f.service.stop(f.workspace, 'thread');
    const statePath = join(f.workspace, 'auto-extraction', readdirSync(join(f.workspace, 'auto-extraction')).find(name => /^[a-f0-9]{64}\.json$/.test(name))!);
    const withoutDeadline = f.service.status(f.workspace, 'thread')!; delete withoutDeadline.notBefore;
    writeFileSync(statePath, JSON.stringify(withoutDeadline)); rmSync(required);
    f.advance(1000); await f.enable(5, policy, selection); await f.tick();
    const recovered = JSON.parse(readFileSync(required, 'utf8'));
    expect(recovered).toMatchObject({ decision: 'required', runId: run.runId, attemptId: run.attempts[0].attemptId, outcome: run.attempts[0].outcome });
    expect(Date.parse(recovered.notBefore)).toBeGreaterThanOrEqual(Date.parse(stopped.notBefore!)); expect(calls).toBe(1);
  });
  it('honors archived server cooldown across windows and applies one non-refundable token allowance', async () => {
    for (const retryAfterMs of [120_000, 300_001, 86_400_001, -1]) {
    const f = fixture(); let calls = 0;
    const policy = boundedExtractionPolicy({ profileId: 'loopback-test/v1', maxInvocations: 1, maxReasks: 0, maxTotalTokens: 2176, maxOutputTokens: 64 });
    const producer = createOpenAiArchiveProducer({ OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'http://127.0.0.1:9321/v1' }, (_executor, options) => async input => {
      options.apiDispatchPolicy.beforeDispatch(buildOpenAiChatRequest(input, options.env, 'single-completion/v1')); calls++;
      const output = JSON.stringify(wireModelWindow()).replaceAll('record-1', JSON.parse(input.prompt).excerpts[0].evidenceRef);
      return { ok: calls > 1, output: calls > 1 ? output : null,
        ...(calls === 1 ? { error: 'Synthetic transient failure', failure: { failureKind: 'rate_limit' as const, retryAfterMs } } : {}),
        durationMs: 1, durationApiMs: 1, stopReason: calls > 1 ? 'stop' : 'error', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, numTurns: 1 };
    });
    f.setFactory((executor, model) => configuredExtractionModel(executor, model, producer, { maxOutputTokens: 64 }));
    await f.enable(5, policy, { executor: 'openai-api', model: 'authored-loopback-test' }); await f.tick();
    if (retryAfterMs < 0) {
      expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'failed', callsUsed: 1, tokensReserved: 1088 });
      f.tasks.push({ ...f.tasks[0], turnId: 'turn-4' }); await f.tick(); expect(calls).toBe(1); continue;
    }
    expect(calls).toBe(1); expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: true, reason: 'waiting', callsUsed: 1, tokensReserved: 1088 });
    const notBefore = f.service.status(f.workspace, 'thread')!.notBefore!;
    expect(Date.parse(notBefore) - f.now()).toBe(retryAfterMs);
    if (retryAfterMs > 24 * 60 * 60 * 1000) {
      f.tasks.push({ ...f.tasks[0], turnId: 'turn-4' }); f.advance(24 * 60 * 60 * 1000); await f.service.tick();
      expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'expired', callsUsed: 1 });
      expect(calls).toBe(1); continue;
    }
    await f.tick(); expect(calls).toBe(1);
    f.tasks.push({ ...f.tasks[0], turnId: 'turn-4' }); await f.tick(); expect(calls).toBe(1);
    expect(createLocalKnowledgeApplication(f.workspace).runs()).toHaveLength(1);
    f.advance(Date.parse(notBefore) - f.now() - 1); await f.service.tick(); expect(calls).toBe(1);
    f.advance(1); await f.service.tick(); expect(calls).toBe(1); // The new source must still become stable.
    f.advance(30_000); await f.service.tick(); expect(calls).toBe(2);
    expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'quota', callsUsed: 2, tokensReserved: 2176 });
    f.tasks.push({ ...f.tasks[0], turnId: 'turn-5' }); await f.tick(); expect(calls).toBe(2);
    expect(createLocalKnowledgeApplication(f.workspace).list()).toHaveLength(1);
    }
  });
  it('rejects oversized input without reserving calls and can be explicitly enabled again after narrowing', async () => {
    const f = fixture();
    const load = f.catalog.loadTaskMessageRecords!.bind(f.catalog);
    f.catalog.loadTaskMessageRecords = async (thread, turn) => {
      const source = (await load(thread, turn))!;
      return { ...source, records: source.records.map(record => ({ ...record, raw: record.raw.replace('Alpha 使用 Beta', '中'.repeat(140_000)) })) };
    };
    await f.enable(1); await f.tick();
    expect(f.inputs).toHaveLength(0);
    expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'capacity', callsUsed: 0, attemptedVersions: [] });
    expect(readdirSync(join(f.workspace, 'auto-extraction')).some(name => name.startsWith('attempt-'))).toBe(false);
    expect(createLocalKnowledgeApplication(f.workspace).runs()).toEqual([]);
    f.catalog.loadTaskMessageRecords = load;
    await f.enable(1); await f.tick();
    expect(f.inputs).toHaveLength(1);
    expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'quota', callsUsed: 1 });
    const preflight = fixture(); let dispatched = 0;
    const producer = createOpenAiArchiveProducer({ OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'http://127.0.0.1:9321/v1' }, (_executor, options) => async input => {
      options.apiDispatchPolicy.beforeDispatch(buildOpenAiChatRequest(input, options.env, 'single-completion/v1')); dispatched++;
      return { ok: true, output: JSON.stringify(wireModelWindow()).replaceAll('record-1', JSON.parse(input.prompt).excerpts[0].evidenceRef),
        durationMs: 1, durationApiMs: 1, stopReason: 'stop', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, costReportedByExecutor: false, numTurns: 1 };
    });
    preflight.setFactory((executor, model) => configuredExtractionModel(executor, model, producer, { maxOutputTokens: 64 }));
    const policy = boundedExtractionPolicy({ profileId: 'loopback-test/v1', maxInvocations: 1, maxReasks: 0, maxTotalTokens: 1087, maxOutputTokens: 64 });
    const selection = { executor: 'openai-api', model: 'authored-loopback-test' };
    await preflight.enable(1, policy, selection); await preflight.tick();
    expect(dispatched).toBe(0); expect(preflight.service.status(preflight.workspace, 'thread')).toMatchObject({ enabled: false, callsUsed: 0, attemptedVersions: [] });
    expect(readdirSync(join(preflight.workspace, 'auto-extraction')).some(name => name.startsWith('attempt-'))).toBe(false);
    await preflight.enable(1, { ...policy, maxTotalTokens: 1088 }, selection); await preflight.tick();
    expect(dispatched).toBe(1);
    preflight.service.stop(preflight.workspace, 'thread'); await preflight.enable(1, { ...policy, maxTotalTokens: 1088 }, selection); await preflight.tick();
    expect(dispatched).toBe(1); // Explicit reapproval never refunds or resends the already-dispatched window.
  });
  it('rejects whole-conversation byte or message capacity while keeping each task and a later narrowed source readable', async () => {
    for (const boundary of ['bytes', 'messages'] as const) {
      const f = fixture(), load = f.catalog.loadTaskMessageRecords!.bind(f.catalog);
      f.tasks.splice(2);
      const message = (index: number, text: string) => ({ recordIndex: index, raw: JSON.stringify({ type: 'response_item', payload: {
        type: 'message', role: index % 2 ? 'assistant' : 'user', content: [{ type: index % 2 ? 'output_text' : 'input_text', text }],
      } }) });
      const windows = boundary === 'bytes'
        ? [[message(0, 'a'.repeat(9 * 1024 * 1024))], [message(1, 'b'.repeat(9 * 1024 * 1024))]]
        : [Array.from({ length: 501 }, (_, index) => message(index, `Message ${index}`)),
          Array.from({ length: 500 }, (_, index) => message(index + 501, `Message ${index + 501}`))];
      f.catalog.loadTaskMessageRecords = async (_thread, turn) => ({ path: join(f.root, 'synthetic.jsonl'), records: windows[Number(turn.split('-')[1])] });
      const rawBytes = windows.map(records => records.reduce((sum, record) => sum + Buffer.byteLength(record.raw), 0));
      expect(rawBytes.every(bytes => bytes < 16 * 1024 * 1024)).toBe(true);
      if (boundary === 'bytes') expect(rawBytes[0] + rawBytes[1]).toBeGreaterThan(16 * 1024 * 1024);
      else expect(rawBytes[0] + rawBytes[1]).toBeLessThan(16 * 1024 * 1024);
      for (let index = 0; index < 2; index++) {
        const task = await conversationExtractionSource(f.catalog, 'thread', `turn-${index}`);
        expect(task.messages.map(item => item.recordIndex)).toEqual(windows[index].map(item => item.recordIndex));
      }
      await expect(conversationExtractionSource(f.catalog, 'thread')).rejects.toThrow(boundary === 'bytes'
        ? 'Conversation exceeds capacity' : 'Conversation exceeds message capacity');
      expect(f.inputs).toHaveLength(0);
      expect(existsSync(f.workspace)).toBe(false);
      expect(readdirSync(f.root)).toEqual([]);
      f.catalog.loadTaskMessageRecords = load; f.tasks.splice(1);
      const narrowed = await conversationExtractionSource(f.catalog, 'thread');
      expect(narrowed.messages.map(item => item.text)).toEqual(['Alpha 使用 Beta turn-0']);
      expect(narrowed.window.origin).toEqual({ threadId: 'thread', title: 'Synthetic conversation', cwd: '/project' });
      expect(f.inputs).toHaveLength(0); expect(readdirSync(f.root)).toEqual([]);
    }
  });
  it('stops at durable automation capacity before a reservation and recovers only after its owned filler is removed', async () => {
    for (const boundary of ['attempted-versions', 'directory-entries'] as const) {
      const f = fixture(); await f.enable(1);
      const directory = join(f.workspace, 'auto-extraction');
      const files = readdirSync(directory), stateFile = join(directory, files.find(name => /^[a-f0-9]{64}\.json$/.test(name))!);
      const permissionFile = join(directory, files.find(name => name.startsWith('permission-'))!);
      const permission = readFileSync(permissionFile);
      const fillers: string[] = [];
      const versions = Array.from({ length: 1000 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`);
      if (boundary === 'attempted-versions') {
        const state = f.service.status(f.workspace, 'thread')!;
        writeFileSync(stateFile, JSON.stringify({ ...state, attemptedVersions: versions }));
      } else {
        for (let index = files.length; index < 3000; index++) {
          const path = join(directory, `owned-capacity-${index}.json`);
          writeFileSync(path, '{}', { flag: 'wx' }); fillers.push(path);
        }
      }
      await f.tick();
      const stopped = f.service.status(f.workspace, 'thread')!;
      expect(stopped).toMatchObject({ enabled: false, reason: 'capacity', callsUsed: 0 });
      expect(stopped).not.toHaveProperty('lastRunId');
      expect(stopped.attemptedVersions).toEqual(boundary === 'attempted-versions' ? versions : []);
      expect(readFileSync(permissionFile)).toEqual(permission);
      expect(readdirSync(directory).some(name => name.startsWith('attempt-'))).toBe(false);
      expect(createLocalKnowledgeApplication(f.workspace).runs()).toEqual([]);
      expect(readdirSync(f.workspace)).toEqual(['auto-extraction']);
      expect(f.inputs).toHaveLength(0);
      const before = () => readdirSync(directory).sort().map(name => [name, name === 'cooldowns'
        ? readdirSync(join(directory, name)).sort() : readFileSync(join(directory, name), 'utf8')]);
      const stoppedBytes = before(); await f.tick();
      expect(before()).toEqual(stoppedBytes); expect(f.inputs).toHaveLength(0);
      if (boundary === 'directory-entries') {
        await expect(f.enable(1)).rejects.toThrow('Automation capacity exceeded');
        expect(before()).toEqual(stoppedBytes);
        for (const path of fillers) { expect(readFileSync(path, 'utf8')).toBe('{}'); rmSync(path); }
      } else {
        // These entries were created by this fixture, never real invocation history.
        const state = f.service.status(f.workspace, 'thread')!;
        writeFileSync(stateFile, JSON.stringify({ ...state, attemptedVersions: state.attemptedVersions.filter(value => !versions.includes(value)) }));
      }
      await f.enable(1); await f.tick();
      expect(f.inputs).toHaveLength(1);
      expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'quota', callsUsed: 1 });
      expect(readdirSync(directory).filter(name => name.startsWith('attempt-'))).toHaveLength(1);
      expect(createLocalKnowledgeApplication(f.workspace).runs()).toHaveLength(1);
      expect(readFileSync(permissionFile)).toEqual(permission);
    }
  });
  it('stops in-flight generation, preserves a late 429 and protects a renewed owner until its own cooldown check', async () => {
    const f = fixture(); let aborted = false, calls = 0; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finishLate!: () => void;
    const late = new Promise<void>(resolve => { finishLate = resolve; });
    const producer = createOpenAiArchiveProducer({ OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'http://127.0.0.1:9321/v1' }, (_executor, options) => async input => {
      options.apiDispatchPolicy.beforeDispatch(buildOpenAiChatRequest(input, options.env, 'single-completion/v1')); calls++;
      input.abortSignal!.addEventListener('abort', () => { aborted = true; }, { once: true }); entered(); await late;
      return { ok: false, output: null, error: 'Synthetic late rate limit', failure: { failureKind: 'rate_limit', retryAfterMs: 120_000 },
        durationMs: 1, durationApiMs: 1, stopReason: 'error', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, numTurns: 0 };
    });
    f.setFactory((executor, model) => configuredExtractionModel(executor, model, producer, { maxOutputTokens: 64 }));
    await f.enable(5, undefined, { executor: 'openai-api', model: 'authored-loopback-test' }); await f.service.tick(); f.advance(30_000);
    const generating = f.service.tick(); await started;
    f.service.stop(f.workspace, 'thread');
    const stopped = f.service.status(f.workspace, 'thread')!;
    expect(aborted).toBe(true); expect(stopped).toMatchObject({ enabled: false, reason: 'stopped', callsUsed: 1 });
    f.tasks.push({ ...f.tasks[0], turnId: 'turn-4' });
    const next = f.create();
    const renewed = await next.enable(f.workspace, 'thread', { token: (await next.preview('thread')).token,
      executor: 'openai-api', model: 'authored-loopback-test', maxCalls: 5 });
    expect(renewed.lastRunId).toBe(stopped.lastRunId); expect(renewed.permissionId).not.toBe(stopped.permissionId);
    expect(renewed).toMatchObject({ enabled: true, reason: 'waiting', callsUsed: 0 });
    const statePath = join(f.workspace, 'auto-extraction', readdirSync(join(f.workspace, 'auto-extraction')).find(name => /^[a-f0-9]{64}\.json$/.test(name))!);
    const before = readFileSync(statePath);
    finishLate(); await generating;
    expect(readFileSync(statePath)).toEqual(before); // The old owner published a fact, never rewrote the new grant.
    const reconciled = next.status(f.workspace, 'thread')!;
    expect(reconciled).toMatchObject({ permissionId: renewed.permissionId, owner: renewed.owner, enabled: true, reason: 'waiting', callsUsed: 0 });
    expect(Date.parse(reconciled.notBefore!)).toBe(f.now() + 120_000);
    await next.tick(); f.advance(30_000); await next.tick(); expect(calls).toBe(1);
    expect(createLocalKnowledgeApplication(f.workspace).runs()[0].status).toBe('cancelled');
  });
  it('expires without calling and requires another explicit enable after Studio closes', async () => {
    const f = fixture(); await f.enable(); f.advance(24 * 60 * 60 * 1000); await f.tick();
    expect(f.inputs).toHaveLength(0); expect(f.service.status(f.workspace, 'thread')?.reason).toBe('expired');
    await f.enable(); f.service.close(); const next = f.create();
    expect(next.status(f.workspace, 'thread')?.enabled).toBe(false); await next.tick(); expect(f.inputs).toHaveLength(0);
    const delayed = fixture(); await delayed.enable(); await delayed.service.tick(); delayed.advance(24 * 60 * 60 * 1000 - 1);
    const original = fs.fsyncSync; let crossedDeadline = false;
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      original(fd);
      if (crossedDeadline || !fs.fstatSync(fd).isFile()) return;
      let document: { automationKind?: string };
      try { document = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { return; }
      if (document.automationKind === 'conversation-knowledge-attempt') { crossedDeadline = true; delayed.advance(100); }
    });
    try {
      syncBuiltinESMExports();
      await delayed.service.tick();
    } finally { sync.mockRestore(); syncBuiltinESMExports(); }
    expect(crossedDeadline).toBe(true); expect(delayed.inputs).toHaveLength(0);
    expect(delayed.service.status(delayed.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'expired', callsUsed: 1 });
    expect(readdirSync(join(delayed.workspace, 'auto-extraction')).filter(name => /^attempt-.*\.json$/.test(name))).toHaveLength(1);
  });
  it('recovers a dead owner conservatively and rejects invalid sidecars or concurrent owners', async () => {
    const f = fixture(); await f.enable();
    const other = f.create(); await expect(other.enable(f.workspace, 'thread', { token: (await other.preview('thread')).token, executor: 'codex', model: 'synthetic', maxCalls: 5 })).rejects.toThrow(/conflict/);
    f.service.close();
    const state = f.service.status(f.workspace, 'thread')!;
    const { createHash } = await import('node:crypto');
    const path = join(f.workspace, 'auto-extraction', `${createHash('sha256').update(JSON.stringify('thread')).digest('hex')}.json`);
    writeFileSync(path, JSON.stringify({ ...state, enabled: true, reason: 'generating', pid: 2147483647 }));
    expect(other.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'interrupted' });
    writeFileSync(path, '{'); expect(() => other.status(f.workspace, 'thread')).toThrow();
  });
  it('projects the project inbox from source identities and current maintenance decisions', async () => {
    const f = fixture(); await f.enable(); await f.tick();
    const queue = await executeKnowledgeCandidateAction({ operation: 'queue', workspace: f.workspace, projectId: '/project' }, undefined, undefined, f.catalog) as { rows: { knowledgeId: string; choice: string | null }[] };
    expect(queue.rows).toHaveLength(1); expect(queue.rows[0].choice).toBeNull();
    const app = createLocalKnowledgeApplication(f.workspace), item = app.detail(queue.rows[0].knowledgeId);
    app.maintain(item.revision.knowledgeId, item.revision.revisionId, 'retain', 'Synthetic review', item.history.generation);
    expect(await executeKnowledgeCandidateAction({ operation: 'queue', workspace: f.workspace, threadId: 'other' }, undefined, undefined, f.catalog)).toMatchObject({ rows: [] });
    expect(await executeKnowledgeCandidateAction({ operation: 'queue', workspace: f.workspace, projectId: '/project' }, undefined, undefined, f.catalog)).toMatchObject({ rows: [{ choice: 'retain' }] });
  });
});
