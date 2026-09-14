import { executeKnowledgeCandidateAction } from '../../src/studio/application/knowledge/knowledge-candidates.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeApplication, type ExtractionModel } from '../../src/observability/knowledge-extraction/application.js';
import { CodexEvidenceStore } from '../../src/observability/knowledge-extraction/adapters/codex-evidence.js';
import { FileKnowledgeStore } from '../../src/observability/knowledge-extraction/adapters/knowledge-store.js';
import { FileExtractionRunStore } from '../../src/observability/knowledge-extraction/adapters/run-store.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { proposal } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-app-')); roots.push(root);
  const source = join(root, 'log.jsonl');
  writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }));
  const knowledge = new FileKnowledgeStore(join(root, 'items'), 'test');
  const runs = new FileExtractionRunStore(join(root, 'runs'));
  const evidence = new CodexEvidenceStore(join(root, 'sources'));
  const ports = {
    evidence, knowledge, runs, id: randomUUID, now: () => '2026-09-14T00:00:00Z',
    hash: (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex'),
    actor: { actorKind: 'human' as const, actorId: 'tester' },
  };
  const app = new KnowledgeApplication(ports);
  const snapshot = app.capture({ path: source });
  const generate = vi.fn(async (_system: string, input: string) => {
    const data = JSON.parse(input);
    const ref = data.excerpts.find((entry: { text: string }) => entry.text === 'Alpha 使用 Beta').evidenceRef;
    return { output: JSON.stringify({ proposals: [JSON.parse(JSON.stringify(proposal()).replaceAll('record-1', ref))] }), durationMs: 5 };
  });
  const model: ExtractionModel = { executor: 'fake', model: 'test-model', generate };
  return { app, snapshot, knowledge, runs, evidence, model, generate, ports, source };
}

describe('shared knowledge application', () => {
  it('generates once, assigns host identities, and preserves raw response and source bindings', async () => {
    const { app, snapshot, model, generate, source } = setup();
    const id = randomUUID();
    const run = await app.generate(snapshot.snapshotId, model, id);
    expect(run.status).toBe('completed');
    expect(run.rawOutput).toBeTruthy();
    expect(run.committed).toHaveLength(1);
    expect(run.runtime).not.toHaveProperty('costUSD');
    expect(generate.mock.calls[0][1]).not.toContain(source);
    const entry = app.detail(run.committed[0].knowledgeId);
    expect(entry.revision.knowledgeId).not.toBe('candidate-1');
    expect(entry.revision.entities[0].entityId).not.toBe('project');
    expect(entry.grounding.mentions[0].entityId).toBe(entry.revision.entities[0].entityId);
    expect(entry.reviewStatus).toBe('pending');
    expect(entry.revision.createdBy).toMatchObject({ actorKind: 'agent', executionRef: id });
    expect(await app.generate(snapshot.snapshotId, model, id)).toEqual(run);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('retains conversation links and maintenance choices after deleting source text', async () => {
    const { app, model, source, generate } = setup();
    const origin = { threadId: 'thread', turnId: 'turn', title: 'Private conversation title', cwd: '/private/project' };
    const snapshot = app.capture({ path: source, origin });
    const run = await app.generate(snapshot.snapshotId, model);
    expect(run.origin).toEqual(origin);
    expect(generate.mock.calls[0][1]).not.toContain(origin.title);
    const ref = run.committed[0];
    app.maintain(ref.knowledgeId, ref.revisionId, 'retain', 'Checked', 1);
    app.deleteSource(snapshot.snapshotId);
    const related = await executeKnowledgeCandidateAction({ operation: 'related', workspace: 'fixture', threadId: 'thread' }, undefined, () => app);
    expect(related).toMatchObject([{ runId: run.runId, committed: [{ knowledgeId: ref.knowledgeId, choice: 'retain' }] }]);
    const detail = await executeKnowledgeCandidateAction({ operation: 'show', workspace: 'fixture', id: ref.knowledgeId }, undefined, () => app);
    expect(detail).toMatchObject({ origin, sources: [{ status: 'unavailable', reason: 'deleted' }] });
  });
  it('recovers interrupted commits using persisted identities without calling the model again', async () => {
    const { app, snapshot, model, generate, knowledge, runs } = setup();
    const original = knowledge.write.bind(knowledge);
    const write = vi.spyOn(knowledge, 'write').mockImplementationOnce((command, actor) => {
      original(command, actor);
      throw new Error('simulated lost response after commit');
    });
    const id = randomUUID();
    await expect(app.generate(snapshot.snapshotId, model, id)).rejects.toThrow('lost response');
    expect(runs.read(id).status).toBe('prepared');
    write.mockRestore();
    expect(app.resume(id).status).toBe('completed');
    expect(knowledge.list()).toHaveLength(1);
    expect(knowledge.list()[0].generation).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('keeps invalid model output as failure evidence and treats an empty result as completed', async () => {
    const { app, snapshot, model } = setup();
    model.generate = async () => ({ output: 'invalid JSON', durationMs: 1 });
    const failed = await app.generate(snapshot.snapshotId, model);
    expect(failed).toMatchObject({ status: 'failed', rawOutput: 'invalid JSON' });
    expect(app.list()).toEqual([]);
    model.generate = async () => ({ output: '{"proposals":[]}', durationMs: 1 });
    expect(await app.generate(snapshot.snapshotId, model)).toMatchObject({ status: 'completed', committed: [] });
  });
  it('corrects entity labels and evidence interpretation without changing source positions', async () => {
    const { app, snapshot, model } = setup();
    const run = await app.generate(snapshot.snapshotId, model);
    const { knowledgeId, revisionId } = run.committed[0];
    const before = app.detail(knowledgeId);
    const draft = structuredClone({ title: before.revision.title, content: before.revision.content,
      entities: before.revision.entities, evidence: before.revision.evidence });
    draft.entities[0].label = '项目 Alpha';
    draft.evidence[0].interpretation = '仅描述本次任务，未证实未来仍适用';
    const after = app.revise(knowledgeId, revisionId, 1, draft, '澄清实体与来源范围');
    expect(after.revision.entities[0].label).toBe('项目 Alpha');
    expect(after.grounding.mentions).toEqual(before.grounding.mentions);
    expect(after.reviewStatus).toBe('pending');
    draft.entities[0].entityId = 'invented';
    expect(() => app.revise(knowledgeId, after.revision.revisionId, 2, draft, '错误身份')).toThrow();
    expect(app.detail(knowledgeId).history.generation).toBe(2);
  });
  it('retains and revises without transferring a maintenance choice or changing the original revision', async () => {
    const { app, snapshot, model } = setup();
    const run = await app.generate(snapshot.snapshotId, model);
    const { knowledgeId, revisionId } = run.committed[0];
    app.maintain(knowledgeId, revisionId, 'retain', '未来工具排查会用到', 1);
    expect(app.list()[0]).toMatchObject({ knowledgeId, revisionId, choice: 'retain', reviewStatus: 'pending' });
    const before = app.detail(knowledgeId);
    const draft = { title: '修订后的标题', content: before.revision.content, entities: before.revision.entities, evidence: before.revision.evidence };
    const after = app.revise(knowledgeId, revisionId, 2, draft, '明确适用项目');
    expect(after.revision.title).toBe('修订后的标题');
    expect(after.reviewStatus).toBe('pending');
    expect(after.maintenance).toBeNull();
    expect(app.list()[0]).toMatchObject({ revisionId: after.revision.revisionId, title: draft.title, choice: null, reviewStatus: 'pending' });
    expect(app.detail(knowledgeId, revisionId).maintenance?.choice).toBe('retain');
    app.deleteSource(snapshot.snapshotId);
    expect(app.detail(knowledgeId).sources[0]).toMatchObject({ status: 'unavailable', reason: 'deleted' });
  });
});
