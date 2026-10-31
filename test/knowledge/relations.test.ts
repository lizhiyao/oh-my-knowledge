import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KnowledgeRelationProposeInputSchema } from '../../src/knowledge/relations.js';
import { applyKnowledgeRelationWrite, selectKnowledgeRelation, validateKnowledgeRelationHistory } from '../../src/knowledge/relation-history.js';
import { relationActor, relationAt, relationOtherActor, relationsFixture } from './relations-fixtures.js';

describe('knowledge relation opinions', () => {
  it('requires distinct knowledge identities, both endpoint evidence and compatible conflict scope', () => {
    const f = relationsFixture(), proposal = f.propose();
    expect(() => KnowledgeRelationProposeInputSchema.parse({ ...proposal, to: proposal.from })).toThrow();
    expect(() => KnowledgeRelationProposeInputSchema.parse({ ...proposal, evidence: [proposal.evidence[0]] })).toThrow();
    expect(() => f.app.propose({ ...proposal, relationType: 'conflicts_with', comparisonScope: { ...proposal.comparisonScope, status: 'different' } })).toThrow();
    f.app.propose({ ...proposal, relationType: 'conflicts_with' });
    expect(() => f.app.review(f.review())).toThrow('unknown comparison scope');
    f.app.review(f.review('reject'));
    expect(f.app.relation(f.relationId)).toMatchObject({ opinionStatus: 'rejected' });
  });
  it('retains opposing actual opinions without ranking actors or timestamps and only supersedes an own opinion', () => {
    const f = relationsFixture(); f.app.propose(f.propose());
    const first = f.app.review(f.review());
    const other = f.appFor(relationOtherActor); other.review(f.review('reject'));
    expect(f.app.relation(f.relationId)).toMatchObject({ opinionStatus: 'disputed' });
    expect(() => other.review(f.review('reject', { supersedesReviewEventIds: [first.eventId] }))).toThrow('own opinion');
    const laterExecution = f.appFor({ ...relationActor, executionRef: 'authored-fixture:later' });
    laterExecution.review(f.review('reject', { supersedesReviewEventIds: [first.eventId] }));
    const result = laterExecution.relation(f.relationId);
    expect(result).toMatchObject({ opinionStatus: 'rejected', withdrawn: false });
    if (result.storageStatus !== 'available') throw new Error('Expected saved history.');
    expect(result.history.events).toHaveLength(4);
    expect(result.permissions.supersedableReviewEventIds).toEqual([result.history.events[3].eventId]);
  });
  it('allows only the current proposal author to withdraw, across execution refs, without erasing history', () => {
    const f = relationsFixture(); f.app.propose(f.propose()); f.app.review(f.review());
    expect(() => f.appFor(relationOtherActor).withdraw(f.withdraw())).toThrow('author');
    f.appFor({ ...relationActor, executionRef: 'authored-fixture:new-author-execution' }).withdraw(f.withdraw());
    expect(f.app.relation(f.relationId)).toMatchObject({ withdrawn: true, opinionStatus: 'withdrawn' });
    expect(() => f.app.review(f.review())).toThrow('withdrawn');
    f.app.propose(f.propose());
    expect(f.app.relation(f.relationId)).toMatchObject({ opinionStatus: 'pending', withdrawn: false, activeReviews: [] });
  });
  it('validates event ancestry, fixed endpoint identities, receipts and historical proposal state', () => {
    const f = relationsFixture(), command = { ...f.propose(), eventKind: 'relation_proposed' as const };
    const history = applyKnowledgeRelationWrite(undefined, command, relationActor, 'local', `sha256:${'a'.repeat(64)}`, relationAt);
    const same = applyKnowledgeRelationWrite(history, command, relationActor, 'local', `sha256:${'a'.repeat(64)}`, '2026-11-01T00:00:00Z');
    expect(same).toBe(history);
    const broken = structuredClone(history); broken.events[0].parentEventId = randomUUID();
    expect(() => validateKnowledgeRelationHistory(broken)).toThrow('references');
    expect(() => applyKnowledgeRelationWrite(history, { ...command, requestId: randomUUID(), expectedGeneration: 1, expectedHeadEventId: command.requestId,
      parentRelationRevisionId: command.requestId, from: command.to, to: command.from }, relationActor, 'local', `sha256:${'b'.repeat(64)}`, relationAt)).toThrow('endpoint identity');
    expect(selectKnowledgeRelation(history).opinionStatus).toBe('pending');
  });
});
