import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication, createLocalKnowledgeRelations, knowledgeWorkspaceRefreshToken } from '../../src/knowledge/application/local.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import { captureTraceFixture, sourceRef } from '../helpers/knowledge-source.js';
import { relationActor, relationOtherActor, relationsFixture } from './relations-fixtures.js';

describe('shared exact knowledge relation application', () => {
  it('keeps unknown actors read-only and never changes bodies, reviews, maintenance or other stores', () => {
    const f = relationsFixture(), readonly = createLocalKnowledgeRelations(f.root), input = f.propose();
    const original = readdirSync(join(f.root, 'items')).map(name => [name, readFileSync(join(f.root, 'items', name))] as const);
    expect(() => readonly.propose(input)).toThrow('trusted actual relation actor');
    const before = knowledgeWorkspaceRefreshToken(f.root, 'relations', {});
    createLocalKnowledgeRelations(f.root, relationActor).propose(input);
    expect(knowledgeWorkspaceRefreshToken(f.root, 'relations', {})).not.toBe(before);
    expect(readonly.relation(f.relationId)).toMatchObject({ opinionStatus: 'pending', bodyStatus: 'current', sourceStatus: 'available', permissions: { canReview: false, canWithdraw: false, canAccept: false } });
    expect(f.app.relation(f.relationId)).toMatchObject({ permissions: { canReview: true, canWithdraw: true, canAccept: true } });
    expect(f.app.list(f.bodyRefs[0]).relations).toHaveLength(1);
    for (const [name, bytes] of original) expect(readFileSync(join(f.root, 'items', name))).toEqual(bytes);
    expect(existsSync(join(f.root, 'reviews'))).toBe(false);
    expect(createLocalKnowledgeApplication(f.root).detail(f.bodyRefs[0].knowledgeId).maintenance).toBeNull();
  });
  it('rejects wrong body digests, segments, UTF-16 quotes and sources outside the bound segment', () => {
    const f = relationsFixture(), p = f.propose();
    expect(() => f.app.propose({ ...p, from: { bodyRef: { ...p.from.bodyRef, bodyDigest: `sha256:${'b'.repeat(64)}` } } })).toThrow('body identity');
    expect(() => f.app.propose({ ...p, from: { ...p.from, segmentIds: ['absent'] } })).toThrow('segment');
    const evidence = structuredClone(p.evidence); evidence[0].bodySelection.end -= 1;
    expect(() => f.app.propose({ ...p, evidence })).toThrow('UTF-16');
    const foreign = structuredClone(p.evidence); foreign[0].source = p.evidence[1].source;
    expect(() => f.app.propose({ ...p, evidence: foreign })).toThrow('not bound');
    expect(f.store.read(f.relationId)).toBeUndefined(); expect(existsSync(join(f.root, '.knowledge-write.lock'))).toBe(false);
  });
  it('rechecks every supporting source, including sources outside the selected quote and selected segment', () => {
    const f = relationsFixture(), extra = captureTraceFixture(f.root, { path: join(f.root, 'extra.jsonl'), records: [{ recordIndex: 0,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Additional limitation.' }] } }) }] });
    const previous = f.commands[0].revision, segment = { segmentId: 's2', text: extra.excerpts[0].text, evidence: [{ source: sourceRef(extra),
      selection: { evidenceRef: extra.excerpts[0].evidenceRef, start: 0, end: extra.excerpts[0].text.length, quote: extra.excerpts[0].text }, basis: 'source_assertion' as const }] };
    const revision = { ...previous, content: { ...previous.content, segments: [...previous.content.segments, segment] }, revisionId: randomUUID(),
      parentRevision: { knowledgeId: previous.knowledgeId, revisionId: previous.revisionId } }; revision.bodyDigest = knowledgeBodyDigest(revision);
    f.knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: previous.knowledgeId, expectedGeneration: 1, expectedHeadRevisionId: previous.revisionId, revision }, relationActor);
    const input = f.propose({ from: { bodyRef: knowledgeBodyRef(revision), segmentIds: ['s1'] } });
    f.sources.delete(extra.snapshotId, extra.sourceVersion);
    expect(() => f.app.propose(input)).toThrow('supporting source unavailable');
  });
  it('preserves rejection and author withdrawal when old endpoints or sources are unavailable', () => {
    const f = relationsFixture(); f.app.propose(f.propose());
    f.sources.delete(f.snapshots[0].snapshotId, f.snapshots[0].sourceVersion);
    expect(f.app.relation(f.relationId)).toMatchObject({ opinionStatus: 'pending', sourceStatus: 'unavailable', permissions: { canAccept: false, canReview: true, canWithdraw: true } });
    expect(() => f.app.review(f.review())).toThrow('source unavailable');
    f.appFor(relationOtherActor).review(f.review('reject'));
    expect(() => f.appFor(relationOtherActor).withdraw(f.withdraw())).toThrow('author');
    f.app.withdraw(f.withdraw());
    expect(f.app.relation(f.relationId)).toMatchObject({ opinionStatus: 'withdrawn', sourceStatus: 'unavailable' });
  });
  it('marks old endpoints stale and makes an explicit rebind pending while preserving old exact-body navigation', () => {
    const f = relationsFixture(), proposal = f.propose(); f.app.propose(proposal); f.app.review(f.review());
    const next = f.appendBody(0);
    expect(f.app.relation(f.relationId)).toMatchObject({ opinionStatus: 'accepted', bodyStatus: 'stale' });
    const rebind = f.propose({ from: { bodyRef: knowledgeBodyRef(next) } }); f.app.propose(rebind);
    expect(f.app.relation(f.relationId)).toMatchObject({ opinionStatus: 'pending', activeReviews: [], isCurrentRevision: true });
    expect(f.app.list(f.bodyRefs[0]).relations[0]).toMatchObject({ opinionStatus: 'accepted', isCurrentRevision: false, bodyStatus: 'stale', revision: { eventId: proposal.requestId } });
    expect(f.app.relation(f.relationId, proposal.requestId)).toMatchObject({ opinionStatus: 'accepted', isCurrentRevision: false, revision: { eventId: proposal.requestId } });
    expect(f.app.list(knowledgeBodyRef(next)).relations[0]).toMatchObject({ opinionStatus: 'pending', revision: { eventId: rebind.requestId } });
  });
  it('does not read an out-of-scope endpoint while retaining its exact reference and a visible gap', () => {
    const f = relationsFixture(); f.app.propose(f.propose()); const h = f.store.read(f.relationId)!;
    const read = f.knowledge.read.bind(f.knowledge), spy = vi.spyOn(f.knowledge, 'read').mockImplementation(id => {
      if (id === f.bodyRefs[1].knowledgeId) throw new Error('Out-of-scope body must not be read.'); return read(id);
    });
    try {
      const projection = f.app.project(h, undefined, new Set([f.bodyRefs[0].knowledgeId]));
      expect(projection.endpoints.to).toMatchObject({ bodyRef: f.bodyRefs[1], status: 'out_of_scope' });
      expect(spy.mock.calls.map(c => c[0])).toEqual([f.bodyRefs[0].knowledgeId]);
      expect(projection.bodyStatus).toBe('unavailable');
      expect(projection.sources.map(s => s.snapshotId)).not.toContain(f.snapshots[1].snapshotId);
    } finally { spy.mockRestore(); }
  });
});
