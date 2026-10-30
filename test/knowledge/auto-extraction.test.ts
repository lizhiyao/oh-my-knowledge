import { mkdirSync } from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_EXTRACTION_WORKFLOW, ConversationAutoExtraction } from '../../src/knowledge/application/auto-extraction.js';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import type { ConversationCatalog } from '../../src/observability/conversation/catalog.js';
import type { GenerationOutcome } from '../../src/knowledge/extraction/native-outcome.js';
import type { KnowledgeGenerationModel } from '../../src/knowledge/adapters/generation-executor.js';
import { FileGenerationJournalStore } from '../../src/knowledge/adapters/generation-journal-store.js';
import { executeAutoExtractionAction } from '../../src/studio/application/knowledge/auto-extraction.js';

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-auto-body-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'knowledge'); let now = Date.parse('2026-10-28T00:00:00Z'), suffix = '';
  const tasks = [0, 1, 2, 3].map(index => ({ turnId: `turn-${index}`, title: 'Authored work', status: 'completed' as 'completed' | 'open',
    eventCount: 1, toolCallCount: 0, toolFailureCount: 0, relatedSkillNames: [] }));
  const catalog: ConversationCatalog = {
    async listConversations() { return { conversations: [(await this.getConversation('thread'))!], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 }; },
    async getConversation(threadId) { return { threadId, sourceThreadId: threadId, sourceKind: 'codex', title: 'Authored conversation', cwd: '/authored', tasks, relatedSkillNames: [] }; },
    async loadTaskTrajectory() { throw new Error('Must use selected message records.'); },
    async loadTaskMessageRecords(_thread, turnId) { return { path: join(root, 'authored.jsonl'), records: [{ recordIndex: Number(turnId.split('-')[1]), raw: JSON.stringify({
      type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Alpha 仅用于选定测试，时间未知 ${turnId}${suffix}` }] },
    }) }] }; },
  };
  const inputs: { stageKind: 'body' | 'association'; input: string }[] = [];
  let afterGate: (() => Promise<void>) | undefined;
  let failure: { retryAfterMs?: number } | undefined;
  const model: KnowledgeGenerationModel = { executor: 'codex', model: 'authored-no-native', timeoutMs: 300_000,
    inspect: () => ({ producerId: 'authored-auto-fixture', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024 * 1024, proof: { nativeObserved: false } }),
    async invoke(profile, input, _signal, gate): Promise<GenerationOutcome> {
      gate?.(); inputs.push({ stageKind: profile.stageKind, input }); await afterGate?.();
      if (failure) return { outcomeKind: 'result', result: { ok: false, output: null, failure: { failureKind: 'rate_limit', ...failure } } };
      const source = JSON.parse(input);
      const output = profile.stageKind === 'body' ? { responseKind: 'knowledge-body-generation', schemaVersion: 2, proposals: [{
        proposalId: 'p1', title: '有条件的来源报告', requiredContexts: [], segments: [{ segmentId: 's1', text: source.sources[0].excerpts[0].text, evidence: [{ evidenceRef: source.sources[0].excerpts[0].evidenceRef,
          quote: 'Alpha', contextBefore: null, contextAfter: null, basis: 'source_assertion', interpretation: null }] }], organization: null, reuseRationale: '核对相同环境时复用' }] }
        : { responseKind: 'knowledge-association-generation', schemaVersion: 3, catalogs: [{ sourceKey: 's0', entities: [] }], associations: [{ bodyKey: 'b0',
          segmentDecisions: [{ segmentId: 's1', decisionKind: 'abstained', entityRefs: [], reason: '无可确认关联' }], typedRelations: [], issues: ['无可确认关联'] }] };
      return { outcomeKind: 'result', result: { ok: true, output: JSON.stringify(output), authoredFixture: true } };
    },
  };
  const create = () => { const service = new ConversationAutoExtraction(catalog, { intervalMs: 0, stableMs: 30_000, now: () => now, model: () => model }); cleanups.push(() => service.close()); return service; };
  const service = create();
  const enable = async (maxCalls = 5, target = service) => target.enable(workspace, 'thread', { workflowId: AUTO_EXTRACTION_WORKFLOW,
    token: (await target.preview('thread', { executor: model.executor, model: model.model })).token, executor: 'codex', model: model.model, maxCalls });
  const tick = async () => { await service.tick(); now += 30_000; await service.tick(); };
  const state = () => { const value = service.status(workspace, 'thread'); if (value?.schemaStatus !== 'current') throw new Error('Expected Source3 state.'); return value; };
  const directory = () => join(workspace, 'auto-extraction');
  return { root, workspace, tasks, catalog, model, service, create, enable, tick, inputs, state, directory,
    advance: (ms: number) => { now += ms; }, change: () => { suffix += ' changed'; }, setFailure: (value: typeof failure) => { failure = value; }, setAfterGate: (value: typeof afterGate) => { afterGate = value; } };
}
describe('explicit Source3 body-first conversation auto permission', () => {
  it('previews bounded stable turns and separately charges body and association while leaving both candidate states pending', async () => {
    const f = fixture(), preview = await f.service.preview('thread', { executor: f.model.executor, model: f.model.model }); expect(preview.messages.map(item => item.recordIndex)).toEqual([1, 2, 3]);
    expect(existsSync(f.workspace)).toBe(false); await f.service.tick(); expect(f.inputs).toEqual([]);
    f.change(); await expect(f.service.enable(f.workspace, 'thread', { workflowId: AUTO_EXTRACTION_WORKFLOW, token: preview.token, executor: 'codex', model: f.model.model, maxCalls: 2 })).rejects.toThrow('conflict');
    await f.enable(2); await f.tick(); expect(f.inputs.map(input => input.stageKind)).toEqual(['body', 'association']);
    expect(f.state()).toMatchObject({ schemaVersion: 3, workflowId: AUTO_EXTRACTION_WORKFLOW, callsUsed: 2, maxCalls: 2, enabled: false, reason: 'quota' });
    const app = createLocalKnowledgeApplication(f.workspace), body = app.list()[0]; expect(body.choice).toBeNull();
    expect(app.detail(body.knowledgeId).derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending' });
    expect(JSON.parse(f.inputs[1].input).bodies[0].bodyRef.bodyDigest).toBeTruthy();
    const receipts = readdirSync(f.directory()).filter(name => name.startsWith('phase-')).map(name => JSON.parse(readFileSync(join(f.directory(), name), 'utf8')));
    expect(receipts.every(receipt => receipt.sources.length === 1 && receipt.sourceSetId && receipt.request.input && receipt.request.system && receipt.request.wireSchema)).toBe(true);
    const journals = app.runs().current;
    for (const receipt of receipts) { const stage = journals.find(journal => journal.runId === receipt.runId)!.stages.find(stage => stage.invocationId === receipt.invocationId)!; expect(receipt.request.input).toBe(stage.input); expect(receipt.requestDigest).toBe(stage.requestDigest); }
    expect(receipts.map(receipt => receipt.callNumber).sort()).toEqual([1, 2]); expect(receipts.every(receipt => receipt.evidenceKind === 'dispatch-reservation')).toBe(true);
  });
  it('saves body when the last slot is spent and refuses association without claiming or producing a second original', async () => {
    const f = fixture(); await f.enable(1); await f.tick(); expect(f.inputs.map(input => input.stageKind)).toEqual(['body']);
    expect(f.state()).toMatchObject({ callsUsed: 1, enabled: false, reason: 'quota' });
    const app = createLocalKnowledgeApplication(f.workspace), journal = app.runs().current[0];
    expect(app.list()).toHaveLength(1); expect(journal.stages.map(stage => stage.state)).toEqual(['completed', 'prepared']);
    expect(journal.stages[1].outcomeRef).toBeUndefined(); expect(app.detail(app.list()[0].knowledgeId).derivedAssociations.status).toBe('absent');
    await f.enable(5); await f.tick(); expect(f.inputs).toHaveLength(1); // Renewing permission is not a retry of an attempted source.
  });
  it('keeps completed-turn filtering and preceding context, and never resends an identical attempted window', async () => {
    const f = fixture(); await f.enable(6); await f.tick(); await f.tick(); expect(f.inputs).toHaveLength(2);
    f.tasks.push({ ...f.tasks[0], turnId: 'turn-4', status: 'open' }); await f.tick(); expect(f.inputs).toHaveLength(2);
    f.tasks[4].status = 'completed'; await f.tick(); expect(f.inputs).toHaveLength(4);
    expect(JSON.parse(f.inputs[2].input).sources[0].excerpts.map((item: { coordinate: { recordIndex: number } }) => item.coordinate.recordIndex)).toEqual([2, 3, 4]);
  });
  it('recovers missing counting/cooldown receipts from the actual journal originals with zero new invocations', async () => {
    const f = fixture(); await f.enable(4); await f.tick();
    const phases = readdirSync(f.directory()).filter(name => name.startsWith('phase-')); const outcomes = readdirSync(f.directory()).filter(name => name.startsWith('outcome-'));
    rmSync(join(f.directory(), phases[0])); rmSync(join(f.directory(), outcomes[0]));
    expect(f.state().callsUsed).toBe(2); expect(f.inputs).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(f.directory(), phases[0]), 'utf8'))).toMatchObject({ evidenceKind: 'journal-claim-recovery', recoveredFrom: { nativeOutcome: expect.any(Object) } });
    expect(existsSync(join(f.directory(), outcomes[0]))).toBe(true); await f.tick(); expect(f.inputs).toHaveLength(2);
  });
  it('does not refund a quota reservation or redispatch after journal claim acknowledgement failed', async () => {
    const f = fixture(), original = FileGenerationJournalStore.prototype.write;
    vi.spyOn(FileGenerationJournalStore.prototype, 'write').mockImplementation(function (this: FileGenerationJournalStore, next, generation) {
      if (next.stages.at(-1)?.state === 'claimed') throw new Error('claim acknowledgement unknown'); return original.call(this, next, generation);
    });
    await f.enable(4); await f.tick(); expect(f.inputs).toHaveLength(0); expect(f.state()).toMatchObject({ callsUsed: 1, enabled: false, reason: 'failed' });
    vi.restoreAllMocks(); await f.enable(4); await f.tick(); expect(f.inputs).toHaveLength(0);
    expect(createLocalKnowledgeApplication(f.workspace).runs().current[0].stages[0].state).toBe('prepared');
  });
  it.each([1, 2])('reports old workflow permission schema %s unsupported and requires a separate workspace before new consent', async schemaVersion => {
    const f = fixture(); await f.enable(); f.service.stop(f.workspace, 'thread');
    const stateFile = join(f.directory(), readdirSync(f.directory()).find(name => /^[a-f0-9]{64}\.json$/.test(name))!);
    const raw = JSON.stringify({ schemaVersion, automationKind: 'conversation-knowledge-extraction', workflowId: 'knowledge-body-first/v1', oldOpaqueAllowance: 'single' });
    writeFileSync(stateFile, raw);
    expect(f.service.status(f.workspace, 'thread')).toEqual({ schemaStatus: 'unsupported', threadId: 'thread', enabled: false, reason: 'permission_upgrade_required' });
    expect(readFileSync(stateFile, 'utf8')).toBe(raw);
    const token = (await f.service.preview('thread', { executor: f.model.executor, model: f.model.model })).token;
    expect(() => executeAutoExtractionAction({ operation: 'enable', workspace: f.workspace, threadId: 'thread', token,
      executor: 'codex', model: f.model.model, maxCalls: 4 }, f.service)).toThrow();
    await expect(f.enable(4)).rejects.toThrow('Migrate to a separate workspace');
    expect(readFileSync(stateFile, 'utf8')).toBe(raw);
    rmSync(stateFile);
    writeFileSync(join(f.directory(), 'schedule-old.json'), JSON.stringify({ workflowId: 'knowledge-body-first/v1' }));
    await expect(f.enable(4)).rejects.toThrow('Migrate to a separate workspace');
    expect(f.inputs).toHaveLength(0);
    await f.service.enable(join(f.root, 'fresh-workspace'), 'thread', { workflowId: AUTO_EXTRACTION_WORKFLOW, token,
      executor: 'codex', model: f.model.model, maxCalls: 4 });
    expect(f.inputs).toHaveLength(0);
  });
  it('preserves archived server cooldown across explicit renewal and never starts with expired permission', async () => {
    const f = fixture(); f.setFailure({ retryAfterMs: 120_000 }); await f.enable(4); await f.tick();
    expect(f.state()).toMatchObject({ enabled: false, reason: 'failed', callsUsed: 1 }); const notBefore = f.state().notBefore!;
    f.service.stop(f.workspace, 'thread'); f.tasks.push({ ...f.tasks[0], turnId: 'turn-4' }); await f.enable(4); await f.tick(); expect(f.inputs).toHaveLength(1);
    expect(f.state().notBefore).toBe(notBefore); f.advance(24 * 60 * 60 * 1000); await f.tick();
    expect(f.state()).toMatchObject({ enabled: false, reason: 'expired' }); expect(f.inputs).toHaveLength(1);
  });
  it('stops on close and never lets a late old owner overwrite a new permission', async () => {
    const f = fixture(); let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), late = new Promise<void>(resolve => { finish = resolve; });
    f.setAfterGate(async () => { entered(); await late; }); f.setFailure({ retryAfterMs: 120_000 }); await f.enable(4);
    await f.service.tick(); f.advance(30_000); const generating = f.service.tick(); await started;
    f.service.close(); const next = f.create(); await f.enable(4, next);
    const stateFile = join(f.directory(), `${createHash('sha256').update(JSON.stringify('thread')).digest('hex')}.json`), before = readFileSync(stateFile);
    finish(); await generating; expect(readFileSync(stateFile)).toEqual(before);
    const renewed = next.status(f.workspace, 'thread'); expect(renewed).toMatchObject({ enabled: true, callsUsed: 0 });
    expect(renewed?.schemaStatus === 'current' && renewed.notBefore).toBeTruthy(); expect(f.inputs).toHaveLength(1);
  });
  it('refuses an old Source2 workspace before creating new permission, ledger or captures', async () => {
    const f = fixture(), directory = join(f.workspace, 'sources'); mkdirSync(directory, { recursive: true });
    const path = join(directory, '00000000-0000-4000-8000-000000000001.json'), original = JSON.stringify({ schemaVersion: 2, storeKind: 'trace-evidence-snapshot', privateText: 'old original' });
    writeFileSync(path, original);
    await expect(f.enable()).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(original); expect(existsSync(f.directory())).toBe(false); expect(f.inputs).toHaveLength(0);
  });
  it('stops on producer scope drift before a native phase is claimed', async () => {
    const f = fixture(); await f.enable();
    const original = f.model.inspect; f.model.inspect = (profile, input) => ({ ...original(profile, input), proof: { environmentDigest: 'changed' } });
    await f.tick(); expect(f.inputs).toHaveLength(0); expect(f.state()).toMatchObject({ enabled: false, callsUsed: 0, reason: 'failed' });
    expect(readdirSync(f.directory()).filter(name => name.startsWith('phase-'))).toHaveLength(0);
  });

  it('shows and binds all readable events in a selected mixed original record, including tool text unchanged by the message preview', async () => {
    const f = fixture(), original = f.catalog.getConversation.bind(f.catalog); let command = 'authored tool context';
    f.catalog.getConversation = async id => ({ ...(await original(id))!, sourceKind: 'claude' });
    f.catalog.loadTaskMessageRecords = async (_thread, turnId) => ({ path: join(f.root, 'authored-claude.jsonl'), records: [{ recordIndex: Number(turnId.split('-')[1]), raw: JSON.stringify({ type: 'assistant', sessionId: 'authored-claude', message: { role: 'assistant', content: [
      { type: 'text', text: 'Alpha 只是合成消息' }, { type: 'tool_use', id: `tool-${turnId}`, name: 'Bash', input: { command } },
    ] } }) }] });
    const target = { executor: 'codex' as const, model: f.model.model }, preview = await f.service.preview('thread', target);
    expect(preview.sourcePreview?.projection.rawUnits).toHaveLength(3);
    expect(preview.sourcePreview?.projection.excerpts.some(excerpt => excerpt.coordinate.coordinateKind === 'trace_event' && excerpt.coordinate.eventKind === 'tool_call')).toBe(true);
    expect(preview.sourcePreview?.projection.excerpts.some(excerpt => excerpt.text.includes(command))).toBe(true);
    command = 'changed tool context with unchanged message';
    const changed = await f.service.preview('thread', target); expect(changed.messages.map(message => message.text)).toEqual(preview.messages.map(message => message.text));
    expect(changed.sourceVersion).not.toBe(preview.sourceVersion); expect(changed.token).not.toBe(preview.token);
    await expect(f.service.enable(f.workspace, 'thread', { workflowId: AUTO_EXTRACTION_WORKFLOW, token: preview.token, ...target, maxCalls: 2 })).rejects.toThrow('conflict');
    expect(existsSync(f.directory())).toBe(false); expect(f.inputs).toHaveLength(0);
  });

  it('rejects an oversized selected window before model inspection, permission or workspace creation', async () => {
    const f = fixture(), inspect = vi.spyOn(f.model, 'inspect');
    f.catalog.loadTaskMessageRecords = async (_thread, turnId) => ({ path: join(f.root, 'authored-large.jsonl'), records: [{ recordIndex: Number(turnId.split('-')[1]), raw: JSON.stringify({
      type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha ' + 'x'.repeat(1_500_000) }] },
    }) }] });
    await expect(f.service.preview('thread', { executor: 'codex', model: f.model.model })).rejects.toThrow('capacity');
    expect(inspect).toHaveBeenCalledTimes(0); expect(f.inputs).toHaveLength(0); expect(existsSync(f.workspace)).toBe(false);
  });

});
