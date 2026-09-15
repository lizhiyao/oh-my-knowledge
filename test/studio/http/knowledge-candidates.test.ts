import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalKnowledgeApplication } from '../../../src/observability/knowledge-extraction/local.js';
import type { ConversationCatalog, ConversationTaskTrajectory } from '../../../src/observability/conversation/catalog.js';
import { createReportServer } from '../../../src/studio/http/report-server.js';

describe('Studio candidate action boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-candidate-api-'));
  const workspace = join(root, 'knowledge');
  const source = join(root, 'source.jsonl');
  let changed = false;
  let whole = false;
  let incomplete = false;
  const message = (role: string, text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  const catalog: ConversationCatalog = {
    async listConversations() { return { conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 }; },
    async getConversation(threadId) { return threadId === 'thread' ? { threadId, sourceThreadId: threadId, sourceKind: 'codex', title: '项目对话', cwd: '/project', tasks: [{ turnId: 'turn', title: '处理问题', status: 'completed', eventCount: 3, toolCallCount: 0, toolFailureCount: 0, relatedSkillNames: [] }, ...(whole ? [{ turnId: 'second', title: '第二轮', status: 'completed' as const, eventCount: 1, toolCallCount: 0, toolFailureCount: 0, relatedSkillNames: [] }] : [])], relatedSkillNames: [] } : undefined; },
    async loadTaskTrajectory(_thread, turn, options) { expect(options?.includeNextHumanMessage).toBe(false); if (incomplete) return undefined; if (turn === 'second') return { session: { sourceTrace: source }, sourceRecords: { status: 'available', truncated: false, records: [{ sourceIndex: 20, raw: message('user', '第二轮事实'), truncated: false }] } } as ConversationTaskTrajectory; return { session: { sourceTrace: source }, sourceRecords: { status: 'available', truncated: false, records: [
      { sourceIndex: 10, raw: message('user', changed ? 'changed' : '选择这条约束'), truncated: false },
      { sourceIndex: 11, raw: message('assistant', '不要自动带上这条回复'), truncated: false },
    ] } } as ConversationTaskTrajectory; },
  };
  let server: ReturnType<typeof createReportServer>;
  let url: string;
  beforeAll(async () => {
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '项目约束' }] } }));
    server = createReportServer({ port: 0, conversationCatalog: catalog, observationsDir: join(root, 'observations'), analysesDir: join(root, 'analyses'), doctorsDir: join(root, 'doctors') });
    url = await server.start();
  });
  afterAll(async () => { await server?.stop(); rmSync(root, { recursive: true, force: true }); });
  const post = (body: Record<string, unknown>, origin?: string) => fetch(`${url}/api/knowledge/candidates`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ workspace, ...body }),
  });
  it('uses the selected local workspace and shared capture operation', async () => {
    expect(await (await post({ operation: 'list' })).json()).toEqual([]);
    const captured = await post({ operation: 'capture', source });
    expect(captured.status).toBe(200);
    const snapshot = await captured.json() as { snapshotId: string };
    expect(snapshot.snapshotId).toBeTruthy();
    expect((await post({ operation: 'delete-source', snapshot: snapshot.snapshotId })).status).toBe(200);
  });
  it('previews catalog messages, captures only the selection, and preserves the return identity', async () => {
    const preview = await (await post({ operation: 'preview-conversation', threadId: 'thread', turnId: 'turn' })).json() as { sourceVersion: string; messages: { text: string }[] };
    expect(preview.messages.map(message => message.text)).toEqual(['选择这条约束', '不要自动带上这条回复']);
    const input = { operation: 'capture-conversation', threadId: 'thread', turnId: 'turn', sourceVersion: preview.sourceVersion, recordIndexes: [10] };
    expect((await post({ ...input, recordIndexes: [999] })).status).toBe(400);
    expect((await post({ ...input, turnId: 'other' })).status).toBe(400);
    const captured = await (await post(input)).json() as { snapshotId: string; excerpts: { text: string }[] };
    expect(captured.excerpts.map(entry => entry.text)).toEqual(['选择这条约束']);
    const stored = createLocalKnowledgeApplication(workspace).source(captured.snapshotId);
    expect(stored.status === 'available' && stored.window.origin).toEqual({ threadId: 'thread', turnId: 'turn', title: '项目对话', cwd: '/project' });
    changed = true;
    expect((await post(input)).status).toBe(409);
    changed = false;
  });
  it('captures the whole conversation across turns, preserving scope and rejecting changed or incomplete sources', async () => {
    whole = true;
    try {
      const preview = await (await post({ operation: 'preview-conversation', threadId: 'thread' })).json();
      expect(preview.messages.map((item: { recordIndex: number }) => item.recordIndex)).toEqual([10, 11, 20]);
      expect(preview.origin).not.toHaveProperty('turnId');
      const input = { operation: 'capture-conversation', threadId: 'thread', sourceVersion: preview.sourceVersion, recordIndexes: [10, 11, 20] };
      const response = await post(input);
      expect(response.status).toBe(200);
      const captured = await response.json();
      expect(captured.excerpts).toHaveLength(3);
      expect(createLocalKnowledgeApplication(workspace).source(captured.snapshotId).status).toBe('available');
      whole = false;
      expect((await post(input)).status).toBe(409);
      incomplete = true;
      expect((await post({ operation: 'preview-conversation', threadId: 'thread' })).status).toBe(400);
    } finally { whole = false; incomplete = false; }
  });
  it('rejects cross-origin mutation before touching a source', async () => {
    const response = await post({ operation: 'capture', source }, 'https://untrusted.example');
    expect(response.status).toBe(403);
  });
  it('does not expose raw filesystem exceptions or accept unrecognized request fields', async () => {
    const invalid = await post({ operation: 'capture', source: join(root, 'private-missing-file') });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(root);
    expect((await post({ operation: 'list', approved: true })).status).toBe(400);
  });
});
