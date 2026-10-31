import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { FileKnowledgeRelationStore } from '../../../src/knowledge/adapters/relation-store.js';
import * as generationHost from '../../../src/knowledge/adapters/generation-host.js';
import { relationsFixture, relationActor, relationOtherActor } from '../../knowledge/relations-fixtures.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function serverFor(root: string, actor = relationActor) {
  return createReportServer({ port: 0, observationInbox: false, knowledgeReviewActor: actor,
    observationsDir: join(root, 'observations'), analysesDir: join(root, 'analyses'), doctorsDir: join(root, 'doctors'),
    conversationCatalog: { listConversations: async () => ({ conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 }),
      getConversation: async () => undefined, loadTaskTrajectory: async () => undefined } });
}
function post(url: string, workspace: string, input: object, origin?: string) {
  return fetch(`${url}/api/knowledge/relations`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ workspace, ...input }) });
}

describe('Studio relation HTTP boundary', () => {
  it('shares all five operations, refuses forged actors and origins, and keeps opposing opinions and author-only withdrawal', async () => {
    const f = relationsFixture(); vi.stubEnv('OMK_HOME', join(f.root, 'home'));
    vi.spyOn(generationHost, 'createLocalKnowledgeGenerationModel').mockImplementation(() => { throw new Error('No relation model adapter.'); });
    const a = serverFor(f.root), b = serverFor(f.root, relationOtherActor);
    try {
      const [url, otherUrl] = await Promise.all([a.start(), b.start()]);
      expect((await post(url, f.root, { operation: 'relations', bodyRef: f.bodyRefs[0] }, 'https://foreign.example')).status).toBe(403);
      expect((await post(url, f.root, { operation: 'propose-relation', ...f.propose(), actor: relationOtherActor })).status).toBe(400);
      const proposal = f.propose(), response = await post(url, f.root, { operation: 'propose-relation', ...proposal });
      expect(response.status).toBe(200); const receipt = await response.json();
      expect(await (await post(url, f.root, { operation: 'propose-relation', ...proposal })).json()).toEqual(receipt);
      expect((await post(otherUrl, f.root, { operation: 'review-relation', ...f.review('reject') })).status).toBe(200);
      expect((await post(url, f.root, { operation: 'review-relation', ...f.review() })).status).toBe(200);
      const status = await (await post(url, f.root, { operation: 'relation', relationId: f.relationId, relationRevisionId: proposal.requestId })).json();
      expect(status).toMatchObject({ opinionStatus: 'disputed', permissions: { canWithdraw: true }, revision: { actor: relationActor } });
      expect((await post(otherUrl, f.root, { operation: 'withdraw-relation', ...f.withdraw() })).status).toBe(403);
      expect((await post(url, f.root, { operation: 'withdraw-relation', ...f.withdraw() })).status).toBe(200);
      const list = await (await post(url, f.root, { operation: 'relations', bodyRef: f.bodyRefs[0] })).json();
      expect(list).toMatchObject({ completeness: 'complete', relations: [{ opinionStatus: 'withdrawn', generation: 4 }] });
      expect(f.knowledge.read(f.bodyRefs[0].knowledgeId).generation).toBe(1);
      expect(generationHost.createLocalKnowledgeGenerationModel).not.toHaveBeenCalled();
    } finally { await Promise.all([a.stop(), b.stop()]); }
  });

  it('reads back the original receipt after publication succeeds but acknowledgement is lost, without redispatch', async () => {
    const f = relationsFixture(); vi.stubEnv('OMK_HOME', join(f.root, 'home'));
    const server = serverFor(f.root), original = FileKnowledgeRelationStore.prototype.write;
    const write = vi.spyOn(FileKnowledgeRelationStore.prototype, 'write').mockImplementationOnce(function (this: FileKnowledgeRelationStore, ...args) {
      original.apply(this, args); throw new Error('Authored lost acknowledgement after durable publication.');
    });
    try {
      const url = await server.start(), proposal = f.propose();
      const failed = await post(url, f.root, { operation: 'propose-relation', ...proposal });
      expect(failed.status).toBe(500); expect(await failed.json()).toEqual({ error: 'knowledge_request_failed' });
      const checked = await post(url, f.root, { operation: 'relation', relationId: f.relationId });
      expect(checked.status).toBe(200);
      expect(await checked.json()).toMatchObject({ generation: 1, opinionStatus: 'pending', history: { receipts: [{ requestId: proposal.requestId }] } });
      expect(write).toHaveBeenCalledTimes(1);
      expect(f.store.read(f.relationId)?.events).toHaveLength(1);
    } finally { await server.stop(); }
  });
});
