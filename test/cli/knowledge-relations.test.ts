import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import * as generationHost from '../../src/knowledge/adapters/generation-host.js';
import { relationsFixture } from '../knowledge/relations-fixtures.js';
import { runCommand } from '../helpers/run-command.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const threadId = '00000000-0000-4000-8000-000000000149';
function fixture() {
  const f = relationsFixture();
  vi.stubEnv('OMK_HOME', join(f.root, 'home')); vi.stubEnv('OMK_SKIP_UPDATE_CHECK', '1');
  vi.stubEnv('CODEX_THREAD_ID', ''); vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', '');
  vi.spyOn(generationHost, 'createLocalKnowledgeGenerationModel').mockImplementation(() => { throw new Error('Relation commands cannot configure a model.'); });
  const run = (args: string[]) => runCommand(ObserveKnowledge, [...args, '--workspace', f.root, '--json'], { cwd: f.root });
  const save = (operation: string, value: unknown) => { const path = join(f.root, `${operation}.json`); writeFileSync(path, JSON.stringify(value)); return run([operation, '--input', path]); };
  const list = () => run(['relations', '--id', f.bodyRefs[0].knowledgeId, '--revision', f.bodyRefs[0].revisionId, '--body-digest', f.bodyRefs[0].bodyDigest]);
  return { ...f, run, save, list };
}
function trustedHost() { vi.stubEnv('CODEX_THREAD_ID', threadId); vi.stubEnv('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'Codex Desktop'); }

describe('knowledge relation CLI', () => {
  it('reads exact bodies without an actor, and refuses unknown or self-declared writers and model flags', async () => {
    const f = fixture();
    expect(JSON.parse((await f.list()).stdout)).toMatchObject({ bodyRef: f.bodyRefs[0], relations: [], completeness: 'complete' });
    expect(JSON.parse((await f.run(['relation', '--id', f.relationId])).stdout)).toEqual({ relationId: f.relationId, storageStatus: 'absent' });
    await expect(f.save('propose-relation', f.propose())).rejects.toMatchObject({ code: 2 });
    trustedHost();
    await expect(f.save('propose-relation', { ...f.propose(), actor: { actorKind: 'human', actorId: 'forged' } })).rejects.toMatchObject({ code: 2 });
    await expect(f.run(['relation', '--id', f.relationId, '--model', 'not-used'])).rejects.toMatchObject({ code: 2 });
    expect(existsSync(join(f.root, 'knowledge-relations'))).toBe(false);
    expect(JSON.parse((await f.save('graph', { knowledgeIds: [] })).stdout)).toMatchObject({ schemaVersion: 3, nodes: [], edges: [] });
    await expect(f.run(['graph', '--model', 'not-used'])).rejects.toMatchObject({ code: 2 });
    expect(generationHost.createLocalKnowledgeGenerationModel).not.toHaveBeenCalled();
  });

  it('attributes, replays, reviews and withdraws one exact relation while preserving the original bodies', async () => {
    const f = fixture(); trustedHost();
    const files = readdirSync(join(f.root, 'items')).map(file => join(f.root, 'items', file));
    const original = files.map(file => readFileSync(file));
    const proposal = f.propose(), receipt = JSON.parse((await f.save('propose-relation', proposal)).stdout);
    expect(JSON.parse((await f.save('propose-relation', proposal)).stdout)).toEqual(receipt);
    const status = JSON.parse((await f.run(['relation', '--id', f.relationId, '--revision', receipt.eventId])).stdout);
    expect(status).toMatchObject({ opinionStatus: 'pending', generation: 1, revision: { eventId: proposal.requestId,
      actor: { actorKind: 'agent', actorId: `codex:${threadId}`, executionRef: `codex-thread:${threadId}` } } });
    expect(status.history.events).toHaveLength(1);
    await f.save('review-relation', f.review());
    expect(JSON.parse((await f.list()).stdout).relations[0].opinionStatus).toBe('accepted');
    await expect(f.save('withdraw-relation', { ...f.withdraw(), expectedGeneration: 1 })).rejects.toMatchObject({ code: 1 });
    await f.save('withdraw-relation', f.withdraw());
    expect(JSON.parse((await f.run(['relation', '--id', f.relationId])).stdout)).toMatchObject({ opinionStatus: 'withdrawn', generation: 3 });
    const graph = JSON.parse((await f.save('graph', { knowledgeIds: f.bodyRefs.map(ref => ref.knowledgeId) })).stdout);
    expect(graph.schemaVersion).toBe(3);
    expect(graph.edges.filter((edge: { edgeKind: string }) => edge.edgeKind === 'knowledge_relation')).toEqual([expect.objectContaining({ relation: expect.objectContaining({ opinionStatus: 'withdrawn' }) })]);
    expect(files.map(file => readFileSync(file))).toEqual(original);
    expect(generationHost.createLocalKnowledgeGenerationModel).not.toHaveBeenCalled();
    vi.stubEnv('CODEX_THREAD_ID', randomUUID());
    await expect(f.save('propose-relation', proposal)).rejects.toMatchObject({ code: 1 });
  });
});
