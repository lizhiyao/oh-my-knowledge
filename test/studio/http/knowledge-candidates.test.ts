import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication } from '../../../src/observability/knowledge-extraction/local.js';
import type { ConversationCatalog, ConversationTaskTrajectory } from '../../../src/observability/conversation/catalog.js';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { executeArtifactAuthoring } from '../../../src/studio/application/knowledge/artifact-authoring.js';
import { WORKSPACE_LOCK_FILE } from '../../../src/evidence/storage/knowledge-workspace.js';
import { modelWindow } from '../../knowledge/fixtures.js';

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
  it('previews automation without permission, requires fresh explicit consent, and can stop before any call', async () => {
    const auto = (body: Record<string, unknown>, origin?: string) => fetch(`${url}/api/knowledge/auto-extraction`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
    });
    expect((await auto({ operation: 'status', workspace, threadId: 'thread' }, 'https://untrusted.example')).status).toBe(403);
    const preview = await (await auto({ operation: 'preview', threadId: 'thread' })).json();
    expect(preview.turnCount).toBe(1); expect(preview.messages).toHaveLength(2);
    expect(await (await auto({ operation: 'status', workspace, threadId: 'thread' })).json()).toBeNull();
    const consent = { operation: 'enable', workspace, threadId: 'thread', token: preview.token, executor: 'codex', model: 'not-invoked', maxCalls: 1 };
    expect((await auto({ ...consent, maxCalls: 0 })).status).toBe(400);
    changed = true; expect((await auto(consent)).status).toBe(409); changed = false;
    expect((await auto(consent)).status).toBe(200);
    expect(await (await auto({ operation: 'stop', workspace, threadId: 'thread' })).json()).toMatchObject({ enabled: false, reason: 'stopped', callsUsed: 0 });
    expect(createLocalKnowledgeApplication(workspace).runs()).toHaveLength(0);
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
  it('inspects and corrects independent entities and applies a knowledge revision through the real HTTP boundary', async () => {
    const entitySource = join(root, 'entity.jsonl');
    writeFileSync(entitySource, [message('user', 'Alpha 使用 Beta'), JSON.stringify({ type: 'unknown_event', payload: { privateMetadata: 'private-raw-value' } })].join('\n'));
    const app = createLocalKnowledgeApplication(workspace); const snapshot = app.capture({ path: entitySource });
    const run = await app.generate(snapshot.snapshotId, { executor: 'fixture', model: 'fixture', generate: async (_prompt, input) => ({
      output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 }) });
    const inspection = await post({ operation: 'entities', analysisId: run.runId }); expect(inspection.status).toBe(200);
    const text = await inspection.text(); expect(text).not.toContain(root); expect(text).not.toContain('private-raw-value');
    const before = JSON.parse(text); expect(before.source.excerpts[0].text).toBe('Alpha 使用 Beta');
    const catalog = await (await post({ operation: 'entity-catalog', query: 'Alpha', pageSize: 1 })).json();
    expect(catalog.rows[0]).toMatchObject({ analysisId: run.runId, mentionCount: 1, knowledgeCount: 1 });
    expect(JSON.stringify(catalog)).not.toContain('rawOutput'); expect(JSON.stringify(catalog)).not.toContain(root);
    for (const bad of [{ page: 0 }, { pageSize: 101 }, { analysisId: '../private' }, { unsafe: true }]) {
      expect((await post({ operation: 'entity-catalog', ...bad })).status).toBe(400);
    }
    const entityResponse = await post({ operation: 'entity-detail', analysisId: run.runId, entityId: before.revision.entities[0].entityId });
    expect(entityResponse.status).toBe(200); const entityText = await entityResponse.text(); expect(entityText).not.toContain(root); expect(entityText).not.toContain('private-raw-value');
    expect(JSON.parse(entityText).knowledge[0].roles[0].role).toBe('subject');
    const edit = { entities: before.revision.entities, mentions: before.revision.mentions }; edit.entities[0].label = '项目 Alpha';
    const request = { operation: 'correct-entities', analysisId: run.runId, revision: before.revision.revisionId, generation: 1, draft: edit, reason: '核对项目名称' };
    expect((await post(request, 'https://untrusted.example')).status).toBe(403);
    const corrected = await (await post(request)).json(); expect(corrected.history.generation).toBe(2);
    const stale = await post(request); expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: 'knowledge_conflict' });
    const candidate = await (await post({ operation: 'show', id: run.committed[0].knowledgeId })).json();
    expect(candidate.entityAnalysis.revision.revisionId).toBe(before.revision.revisionId);
    expect(candidate.entityAnalysis.source).not.toHaveProperty('window');
    const entities = corrected.revision.entities.map(({ entityId, label, description }: { entityId: string; label: string; description: string }) => ({ entityId, label, description }));
    const applied = await post({ operation: 'apply-entities', id: candidate.revision.knowledgeId, revision: candidate.revision.revisionId,
      generation: candidate.history.generation, analysisId: run.runId, entityRevision: corrected.revision.revisionId,
      draft: { title: candidate.revision.title, content: candidate.revision.content, evidence: candidate.revision.evidence, entities }, reason: '明确陈述主体', identityUncertainties: [] });
    expect(applied.status).toBe(200);
    const latest = await applied.json(); expect(latest.history.revisions).toHaveLength(2);
    expect(latest.grounding.entityAnalysisRef.revisionId).toBe(corrected.revision.revisionId);
    const summaries = await (await post({ operation: 'runs' })).json(); expect(JSON.stringify(summaries)).not.toContain('rawOutput');
    expect(summaries.find((entry: { runId: string }) => entry.runId === run.runId).entityAnalysis.entityCount).toBe(2);
    await post({ operation: 'delete-source', snapshot: snapshot.snapshotId });
    const deleted = await post({ ...request, revision: corrected.revision.revisionId, generation: 2 });
    expect(deleted.status).toBe(400); expect(await deleted.text()).not.toContain(root);
  });
  it('organizes exact entity revisions through the real library API and retains history without exposing source paths', async () => {
    const selected = join(root, 'library-workspace'); const app = createLocalKnowledgeApplication(selected);
    const source = app.capture({ path: join(root, 'library-source.jsonl'), records: [{ recordIndex: 2, raw: message('user', 'Alpha 使用 Beta') }] });
    const run = await app.generate(source.snapshotId, { executor: 'recorded-fixture', model: 'no-call', generate: async (_system, input) => ({
      output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 0 }) });
    const entity = app.entities(run.runId); const member = { analysisId: run.runId, entityId: entity.revision.entities[0].entityId,
      entityRevisionId: entity.revision.revisionId, mentionIds: [entity.revision.mentions[0].mentionId], rationale: '按来源确认项目身份' };
    const libraryPost = (body: object, origin?: string) => fetch(`${url}/api/knowledge/library`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ workspace: selected, ...body }) });
    const command = { operation: 'save', objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null,
      draft: { label: 'Alpha', description: '维护的项目对象', referentKind: 'object', members: [member] }, reason: '建立入口', identityConfirmed: true };
    expect((await libraryPost(command, 'https://untrusted.example')).status).toBe(403);
    expect(existsSync(join(selected, 'library'))).toBe(false);
    const response = await libraryPost(command); expect(response.status).toBe(200); const saved = await response.json();
    expect((await libraryPost(command)).status).toBe(200);
    const detail = await libraryPost({ operation: 'show', id: saved.objectId }); const text = await detail.text();
    expect(text).not.toContain(root); expect(text).not.toContain('rawOutput');
    expect(JSON.parse(text).counts).toEqual({ retained: 0, pending: 1, discarded: 0, needsReview: 0 });
    expect((await (await libraryPost({ operation: 'owners', analysisId: member.analysisId, entityId: member.entityId })).json())[0].objectId).toBe(saved.objectId);
    expect((await libraryPost({ ...command, objectId: randomUUID(), requestId: randomUUID() })).status).toBe(409);
    for (const bad of [{ operation: 'show', id: '../private' }, { operation: 'list', unsafe: true }, { ...command, identityConfirmed: false }]) {
      const failed = await libraryPost(bad); expect(failed.status).toBe(400); expect(await failed.text()).not.toContain(root);
    }
    const removed = await libraryPost({ ...command, requestId: randomUUID(), generation: saved.generation, headRevisionId: saved.writeHeadRevisionId,
      draft: { ...command.draft, members: [] }, reason: '明确解除关联' }); expect(removed.status).toBe(200);
    expect((await (await libraryPost({ operation: 'show', id: saved.objectId })).json()).knowledge).toEqual([]);
    expect((await (await libraryPost({ operation: 'show', id: saved.objectId, revision: saved.writeHeadRevisionId })).json()).knowledge).toHaveLength(1);
    expect(app.detail(run.committed[0].knowledgeId).history.revisions).toHaveLength(1);
  });
  it('reports workspace contention consistently for source, tag and carrier writes, then recovers after release', async () => {
    const selected = join(root, 'busy-workspace'); const app = createLocalKnowledgeApplication(selected);
    const fixture = join(root, 'busy-source.jsonl'); writeFileSync(fixture, message('user', 'Alpha 使用 Beta'));
    const snapshot = app.capture({ path: fixture });
    const run = await app.generate(snapshot.snapshotId, { executor: 'fixture', model: 'fixture', generate: async (_prompt, input) => ({
      output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 1 }) });
    const current = app.detail(run.committed[0].knowledgeId);
    app.maintain(current.revision.knowledgeId, current.revision.revisionId, 'retain', '已核对', current.history.generation);
    const draft = executeArtifactAuthoring({ operation: 'preview', workspace: selected, source: { sourceKind: 'new' }, artifactKind: 'prompt', name: '当前知识', ids: [current.revision.knowledgeId] }, 'zh');
    const lock = join(selected, WORKSPACE_LOCK_FILE); const owner = JSON.stringify({ owner: randomUUID(), pid: process.pid, hostname: (await import('node:os')).hostname(), acquiredAt: new Date().toISOString() });
    writeFileSync(lock, owner); const clock = vi.spyOn(Date, 'now'); let tick = 0; clock.mockImplementation(() => tick += 6000);
    try {
      for (const fields of [{ operation: 'capture', source: fixture }, { operation: 'delete-source', snapshot: snapshot.snapshotId },
        { operation: 'tag', id: current.revision.knowledgeId, generation: 0, tags: ['tag'] }]) {
        const response = await post({ workspace: selected, ...fields }); expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'knowledge_workspace_busy' });
      }
      const fields = draft as import('../../../src/studio/view-models/knowledge/artifact-authoring.js').ReviewedCarrierDraft;
      const response = await fetch(`${url}/api/knowledge/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'save', workspace: selected, artifactId: fields.artifactId, source: fields.source, artifactKind: fields.artifactKind, name: fields.name,
          directoryName: fields.directoryName, baselineRevisionId: fields.baselineRevisionId, baselineHash: fields.baselineHash, content: fields.content, selectedRefs: fields.selectedRefs, tagSelections: fields.tagSelections }) });
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'knowledge_workspace_busy' });
      expect(readFileSync(lock, 'utf8')).toBe(owner); expect(app.source(snapshot.snapshotId).status).toBe('available');
      expect(app.detail(current.revision.knowledgeId).tagging).toEqual({ generation: 0, tags: [] });
      expect(existsSync(join(selected, 'artifacts'))).toBe(false);
    } finally { clock.mockRestore(); unlinkSync(lock); }
    expect((await post({ workspace: selected, operation: 'tag', id: current.revision.knowledgeId, generation: 0, tags: ['tag'] })).status).toBe(200);
  });
  it('rejects unsupported storage and removed operations without altering files or exposing data', async () => {
    const selected = join(root, 'unsupported'); const folder = join(selected, 'runs'); mkdirSync(folder, { recursive: true });
    const path = join(folder, `${randomUUID()}.json`);
    const original = JSON.stringify({ schemaVersion: 0, privateValue: 'private-sensitive-value' }); writeFileSync(path, original);
    const required = await post({ workspace: selected, operation: 'runs' }); expect(required.status).toBe(409);
    expect(await required.json()).toEqual({ error: 'knowledge_storage_unsupported' });
    const backup = join(root, 'external-backup');
    for (const operation of ['migration-preview', 'migrate']) {
      const response = await post({ workspace: selected, operation, backupDirectory: backup });
      expect(response.status).toBe(400);
      const body = await response.text(); expect(body).not.toContain(root); expect(body).not.toContain('private-sensitive-value');
    }
    expect(existsSync(backup)).toBe(false); expect(readFileSync(path, 'utf8')).toBe(original);
  });
  it('protects carrier measurement mutations and redacts invalid input without model execution', async () => {
    const send = (body: string, origin?: string) => fetch(`${url}/api/knowledge/measurements`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body });
    expect((await send(JSON.stringify({ operation: 'start', workspace, id: 'invalid' }), 'https://untrusted.example')).status).toBe(403);
    expect((await send('invalid')).status).toBe(400);
    const invalid = await send(JSON.stringify({ operation: 'preview', input: { workspace, secret: 'private-value' } }));
    expect(invalid.status).toBe(400);
    const body = await invalid.text(); expect(body).not.toContain(root); expect(body).not.toContain('private-value');
    expect((await send(JSON.stringify({ operation: 'list', workspace, artifactId: 'invalid', version: 1, unknown: true }))).status).toBe(400);
  });
  it('routes artifact authoring through the same trusted Studio boundary with redacted errors', async () => {
    const send = (body: string, origin?: string) => fetch(`${url}/api/knowledge/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body });
    expect(await (await send(JSON.stringify({ operation: 'list', workspace }))).json()).toEqual([]);
    expect((await send(JSON.stringify({ operation: 'list', workspace }), 'https://untrusted.example')).status).toBe(403);
    expect((await send('invalid')).status).toBe(400);
    const invalid = await send(JSON.stringify({ operation: 'show', workspace, id: 'private-invalid' }));
    expect(await invalid.text()).not.toContain(root);
    expect((await send(JSON.stringify({ operation: 'list', workspace, unknown: true }))).status).toBe(400);
    expect((await send(JSON.stringify({ workspace, content: 'x'.repeat(3 * 1024 * 1024) }))).status).toBe(413);
  });

});
