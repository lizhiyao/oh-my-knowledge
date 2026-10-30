import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { knowledgeReviewCliActor } from '../../src/cli/lib/knowledge-review-actor.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import * as generationHost from '../../src/knowledge/adapters/generation-host.js';
import { bodyActor, bodyWrite } from '../knowledge/body-fixtures.js';
import { testDirectory } from '../helpers/temp-directory.js';
import { runCommand } from '../helpers/run-command.js';
import { captureTraceFixture } from '../helpers/knowledge-source.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const threadId = '00000000-0000-4000-8000-000000000140';
function fixture() {
  const root = testDirectory('omk-review-cli-'), workspace = join(root, 'workspace');
  vi.stubEnv('OMK_HOME', join(root, 'home')); vi.stubEnv('OMK_SKIP_UPDATE_CHECK', '1');
  vi.stubEnv('CODEX_THREAD_ID', ''); vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', '');
  vi.spyOn(generationHost, 'createLocalKnowledgeGenerationModel').mockImplementation(() => { throw new Error('Review commands must not configure a model.'); });
  const source = captureTraceFixture(workspace, { path: join(root, 'source.jsonl'), records: [{ recordIndex: 1, raw: JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 的版本未知；不能把个案当通则。' }],
  } }) }] });
  const command = bodyWrite();
  command.revision.content.segments[0].evidence = [{ source: { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion },
    selection: { evidenceRef: source.excerpts[0].evidenceRef, start: 0, end: 5, quote: 'Alpha' }, basis: 'source_assertion' }];
  command.revision.bodyDigest = knowledgeBodyDigest(command.revision);
  const store = new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace); store.write(command, bodyActor);
  const bodyRef = knowledgeBodyRef(command.revision), sources = [{ snapshotId: source.snapshotId, sourceVersion: source.sourceVersion }];
  const statusArgs = (ref = bodyRef) => ['review-status', '--id', ref.knowledgeId, '--revision', ref.revisionId, '--body-digest', ref.bodyDigest];
  const run = (args: string[]) => runCommand(ObserveKnowledge, [...args, '--workspace', workspace, '--json'], { cwd: root });
  const save = (operation: string, value: unknown) => { const path = join(root, `${operation}.json`); writeFileSync(path, JSON.stringify(value)); return run([operation, '--input', path]); };
  const review = { requestId: randomUUID(), bodyRef, sources, expectedGeneration: 0, expectedHeadEventId: null,
    status: 'needs_revision', reason: '测试夹具的明确复核意见，非模型测量。', limitations: ['只检查当前测试来源'],
    findings: [{ problemKind: 'omission', description: '需要保留案例适用范围', segmentIds: ['s1'], evidence: [] }] };
  return { root, workspace, run, save, statusArgs, review, store, command, bodyRef, sources };
}
function codexHost() { vi.stubEnv('CODEX_THREAD_ID', threadId); vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'Codex Desktop'); }

describe('knowledge review CLI boundaries', () => {
  it('keeps exact review-status readable without an actor and refuses an unknown writer or self-declared payload actor', async () => {
    const f = fixture();
    expect(JSON.parse((await f.run(f.statusArgs())).stdout)).toMatchObject({ storageStatus: 'absent', generation: 0, headEventId: null,
      bodyRef: f.bodyRef, content: { status: 'not_reviewed' } });
    expect(existsSync(join(f.workspace, 'reviews'))).toBe(false);
    await expect(f.save('review-content', f.review)).rejects.toMatchObject({ code: 2 });
    codexHost();
    await expect(f.save('review-content', { ...f.review, actor: { actorKind: 'human', actorId: 'forged' } })).rejects.toMatchObject({ code: 2 });
    expect(existsSync(join(f.workspace, 'reviews'))).toBe(false);
    expect(generationHost.createLocalKnowledgeGenerationModel).not.toHaveBeenCalled();
    expect(knowledgeReviewCliActor({ CODEX_THREAD_ID: threadId })).toBeUndefined();
    expect(knowledgeReviewCliActor({ CODEX_THREAD_ID: 'not-a-thread', CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' })).toBeUndefined();
  });

  it('records the actual launcher actor and replays one request without changing the body or emitting another event', async () => {
    const f = fixture(); codexHost();
    const bodyPath = join(f.workspace, 'items', readdirSync(join(f.workspace, 'items'))[0]), original = readFileSync(bodyPath);
    const receipt = JSON.parse((await f.save('review-content', f.review)).stdout);
    expect(JSON.parse((await f.save('review-content', f.review)).stdout)).toEqual(receipt);
    const status = JSON.parse((await f.run(f.statusArgs())).stdout);
    expect(status).toMatchObject({ generation: 1, content: { status: 'needs_revision' } });
    expect(status.history.events).toHaveLength(1); expect(status.history.receipts).toHaveLength(1);
    expect(status.history.events[0]).toMatchObject({ bodyRef: f.bodyRef, actor: { actorKind: 'agent', actorId: `codex:${threadId}`, executionRef: `codex-thread:${threadId}` } });
    expect(readFileSync(bodyPath)).toEqual(original);
    await expect(f.run(['review-content', '--input', join(f.root, 'review-content.json'), '--model', 'not-allowed'])).rejects.toMatchObject({ code: 2 });
    expect(generationHost.createLocalKnowledgeGenerationModel).not.toHaveBeenCalled();
  });

  it('attaches use feedback to the delivered old revision after a new body is saved, with no inherited review on the new body', async () => {
    const f = fixture(); codexHost();
    const receipt = JSON.parse((await f.save('review-content', f.review)).stdout);
    const next = structuredClone(f.command);
    next.requestId = randomUUID(); next.expectedGeneration = 1; next.expectedHeadRevisionId = f.bodyRef.revisionId;
    next.revision.revisionId = 'revision-2'; next.revision.parentRevision = { knowledgeId: f.bodyRef.knowledgeId, revisionId: f.bodyRef.revisionId };
    next.revision.revisedAt = '2026-10-29T00:00:00Z'; next.revision.revisionReason = '明确创建测试新修订';
    next.revision.content.segments[0].text += ' 这是新的测试修订。'; next.revision.bodyDigest = knowledgeBodyDigest(next.revision);
    f.store.write(next, bodyActor);
    await f.save('record-use', { requestId: randomUUID(), bodyRef: f.bodyRef, sources: f.sources, expectedGeneration: 1, expectedHeadEventId: receipt.eventId,
      taskRef: 'fixture-task', query: 'Alpha 的适用范围是什么？', segmentIds: ['s1'], signal: 'read', issueKind: 'content_missing', reason: '只记录实际读取旧版本时发现缺口；不证明采用或任务收益。' });
    const oldStatus = JSON.parse((await f.run(f.statusArgs())).stdout), newStatus = JSON.parse((await f.run(f.statusArgs(knowledgeBodyRef(next.revision)))).stdout);
    expect(oldStatus.usage).toEqual([expect.objectContaining({ bodyRef: f.bodyRef, signal: 'read', issueKind: 'content_missing', taskRef: 'fixture-task' })]);
    expect(newStatus.content.status).toBe('not_reviewed'); expect(newStatus.usage).toEqual([]);
    expect(oldStatus.content.status).toBe('needs_revision'); expect(f.store.read(f.bodyRef.knowledgeId).revisions).toHaveLength(2);
    expect(generationHost.createLocalKnowledgeGenerationModel).not.toHaveBeenCalled();
  });
});
