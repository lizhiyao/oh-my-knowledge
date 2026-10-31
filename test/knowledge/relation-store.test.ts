import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileKnowledgeRelationStore } from '../../src/knowledge/adapters/relation-store.js';
import { relationActor, relationsFixture } from './relations-fixtures.js';

describe('append-only knowledge relation storage', () => {
  it('validates under the shared lock and replays a receipt before stale CAS or missing sources', () => {
    const f = relationsFixture(), input = f.propose(), observed: boolean[] = [], read = f.sources.read.bind(f.sources);
    const spy = vi.spyOn(f.sources, 'read').mockImplementation((...args) => { observed.push(existsSync(join(f.root, '.knowledge-write.lock'))); return read(...args); });
    try {
      const receipt = f.app.propose(input), file = join(f.root, 'knowledge-relations', `${f.relationId}.json`), bytes = readFileSync(file);
      expect(observed.length).toBeGreaterThan(0); expect(observed.every(Boolean)).toBe(true);
      f.sources.delete(f.snapshots[0].snapshotId, f.snapshots[0].sourceVersion); observed.length = 0;
      expect(f.app.propose(input)).toEqual(receipt); expect(observed).toEqual([]); expect(readFileSync(file)).toEqual(bytes);
      expect(() => f.appFor({ ...relationActor, executionRef: 'different-request-actor' }).propose(input)).toThrow('idempotency');
      expect(() => f.app.propose({ ...input, requestId: randomUUID() })).toThrow('revision conflict');
      expect(existsSync(join(f.root, '.knowledge-write.lock'))).toBe(false);
      expect(readdirSync(join(f.root, 'knowledge-relations'))).toEqual([`${f.relationId}.json`]);
    } finally { spy.mockRestore(); }
  });
  it('keeps partial inventory distinct from no relations and never follows a redirect', () => {
    const f = relationsFixture(); f.app.propose(f.propose());
    const corruptId = randomUUID(), linkedId = randomUUID(), dir = join(f.root, 'knowledge-relations');
    writeFileSync(join(dir, `${corruptId}.json`), '{');
    symlinkSync(join(dir, `${f.relationId}.json`), join(dir, `${linkedId}.json`));
    const inventory = f.store.inventory(new Set([f.bodyRefs[0].knowledgeId]));
    expect(inventory.histories).toHaveLength(1); expect(inventory.completeness).toBe('partial');
    expect(inventory.unavailable).toEqual(expect.arrayContaining([{ relationId: corruptId, reason: 'corrupt' }, { relationId: linkedId, reason: 'corrupt' }]));
    expect(f.app.relation(corruptId)).toMatchObject({ storageStatus: 'unavailable' });
    expect(f.app.relation(randomUUID())).toMatchObject({ storageStatus: 'absent' });
    expect(f.store.inventory(new Set())).toEqual({ histories: [], unavailable: [], completeness: 'complete' });
    expect(() => f.store.read('../outside')).toThrow();
    expect(() => new FileKnowledgeRelationStore(join(f.root, 'other'), 'local', f.root)).toThrow('knowledge-relations');
  });
  it('rejects altered actor-bound receipts and unsupported histories instead of dropping them', () => {
    const f = relationsFixture(); f.app.propose(f.propose());
    const file = join(f.root, 'knowledge-relations', `${f.relationId}.json`), original = JSON.parse(readFileSync(file, 'utf8'));
    const altered = structuredClone(original); altered.events[0].actor.actorId = 'another-author'; writeFileSync(file, JSON.stringify(altered));
    expect(() => f.store.read(f.relationId)).toThrow('receipt integrity');
    writeFileSync(file, JSON.stringify({ ...original, schemaVersion: 2 }));
    expect(f.store.inventory().unavailable).toEqual([{ relationId: f.relationId, reason: 'unsupported' }]);
  });
});
