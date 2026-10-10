import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationAutoExtraction } from '../../src/observability/knowledge-extraction/auto-extraction.js';
import { createLocalKnowledgeApplication } from '../../src/observability/knowledge-extraction/local.js';
import type { ConversationCatalog } from '../../src/observability/conversation/catalog.js';
import type { ExtractionModel } from '../../src/observability/knowledge-extraction/application.js';
import { modelWindow } from './fixtures.js';
import { executeKnowledgeCandidateAction } from '../../src/studio/application/knowledge/knowledge-candidates.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
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
  const create = () => {
    const service = new ConversationAutoExtraction(catalog, { intervalMs: 0, stableMs: 30_000, now: () => now,
      model: (executor, model) => ({ executor, model, generate: (...args) => implementation(...args) }) });
    cleanups.push(() => service.close()); return service;
  };
  const service = create();
  const enable = async (limit = 5) => service.enable(workspace, 'thread', { token: (await service.preview('thread')).token, executor: 'codex', model: 'synthetic', maxCalls: limit });
  const tick = async () => { await service.tick(); now += 30_000; await service.tick(); };
  return { root, workspace, tasks, catalog, service, create, inputs, enable, tick,
    advance: (ms: number) => { now += ms; }, change: () => { changed += ' changed'; }, setModel: (fn: ExtractionModel['generate']) => { implementation = fn; } };
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
  it('aborts in-flight generation on stop and preserves the reservation without a retry', async () => {
    const f = fixture(); let aborted = false; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.setModel(async (_system, _input, signal) => { entered(); await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }); throw new Error('unreachable'); });
    await f.enable(); await f.service.tick(); f.advance(30_000);
    const generating = f.service.tick(); await started;
    f.service.stop(f.workspace, 'thread'); await generating;
    expect(aborted).toBe(true); expect(f.service.status(f.workspace, 'thread')).toMatchObject({ enabled: false, reason: 'stopped', callsUsed: 1 });
    expect(createLocalKnowledgeApplication(f.workspace).runs()[0].status).toBe('cancelled');
  });
  it('expires without calling and requires another explicit enable after Studio closes', async () => {
    const f = fixture(); await f.enable(); f.advance(24 * 60 * 60 * 1000); await f.tick();
    expect(f.inputs).toHaveLength(0); expect(f.service.status(f.workspace, 'thread')?.reason).toBe('expired');
    await f.enable(); f.service.close(); const next = f.create();
    expect(next.status(f.workspace, 'thread')?.enabled).toBe(false); await next.tick(); expect(f.inputs).toHaveLength(0);
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
