import { describe, expect, it } from 'vitest';
import { SourceCoverageWriteSchema, SourceLedgerDataSchema, SourceReviewActorSchema, SourceReviewEvidenceSchema } from '../../src/knowledge/source-review.js';
import { applySourceCoverageWrite, applySourceLedgerWrite, assertSourceCoverageDecision, selectSourceCoverageDecision, sourceCoverageUnresolved,
  validateSourceCoverageData, validateSourceCoverageDecisionDispositions, validateSourceCoverageHistory, validateSourceLedgerData, validateSourceLedgerHistory } from '../../src/knowledge/source-review-history.js';
import { bodyAt } from './body-fixtures.js';
import { reviewActor, reviewDigest, reviewId, sourceReviewFixture } from './source-review-fixtures.js';

const append = (f: ReturnType<typeof sourceReviewFixture>) => applySourceCoverageWrite(undefined, f.coverageCommand, reviewActor, 'test', reviewDigest(), bodyAt);
describe('source inventory and coverage contracts', () => {
  it('requires a disposition for every delivered metadata/text unit, exact references and explicit evidence kind', () => {
    const f = sourceReviewFixture(); validateSourceLedgerData(SourceLedgerDataSchema.parse(f.ledgerData));
    const missing = structuredClone(f.ledgerData); missing.unitDispositions.pop();
    expect(() => validateSourceLedgerData(missing)).toThrow('unit dispositions');
    const duplicate = structuredClone(f.ledgerData); duplicate.manifest.units.push(duplicate.manifest.units[0]);
    expect(() => validateSourceLedgerData(duplicate)).toThrow('unit keys');
    const forged = structuredClone(f.ledgerData); forged.items[0].evidence[0].unitKind = 'source_metadata';
    expect(() => validateSourceLedgerData(forged)).toThrow('delivered unit');
    const orphan = structuredClone(f.ledgerData); orphan.unitDispositions[1].itemIds = [];
    expect(() => validateSourceLedgerData(orphan)).toThrow('requires an item');
    const outOfBounds = structuredClone(f.ledgerData); outOfBounds.items[0].evidence[0].end = 6;
    expect(() => validateSourceLedgerData(outOfBounds)).toThrow('delivered unit');
    expect(SourceReviewEvidenceSchema.safeParse({ unitKey: 'u', unitKind: 'excerpt_text', start: 0, end: 1, quote: '😀' }).success).toBe(false);
    expect(SourceReviewEvidenceSchema.parse({ unitKey: 'u', unitKind: 'excerpt_text', start: 0, end: 2, quote: '😀' }).end).toBe(2);
  });
  it('requires every unit, candidate, facet and exact paragraph, without making quote validity a semantic pass', () => {
    const f = sourceReviewFixture(); validateSourceCoverageData(f.coverageData, f.ledger, [f.body]);
    const incomplete = structuredClone(f.coverageData); incomplete.checks.splice(3, 1);
    expect(() => validateSourceCoverageData(incomplete, f.ledger, [f.body])).toThrow('every exact unit');
    const stale = structuredClone(f.coverageData); stale.bodyRefs[0].revisionId = 'other-version';
    expect(() => validateSourceCoverageData(stale, f.ledger, [f.body])).toThrow('body refs');
    const fabricated = structuredClone(f.coverageData); fabricated.checks[1].bodyEvidence[0].quote = 'Invented paragraph';
    expect(() => validateSourceCoverageData(fabricated, f.ledger, [f.body])).toThrow('quote mismatch');
    const wrongLedger = structuredClone(f.coverageData); wrongLedger.ledgerRef.digest = reviewDigest('d');
    expect(() => validateSourceCoverageData(wrongLedger, f.ledger, [f.body])).toThrow('ledger identity');
  });
  it('distinguishes unknown factual value from preserving unknowns and inspected input limitations', () => {
    const f = sourceReviewFixture(), covered = structuredClone(f.coverageData); covered.checks[3].status = 'covered';
    expect(() => validateSourceCoverageData(covered, f.ledger, [f.body])).toThrow('Unknown factual value');
    covered.checks[3].coverageTarget = 'preserved_source_declared_unknown'; covered.checks[3].factualValue = 'not_applicable'; covered.checks[3].sourceEvidence = [f.ledgerData.items[0].evidence[0]];
    validateSourceCoverageData(covered, f.ledger, [f.body]);
    covered.checks[3].coverageTarget = 'preserved_bounded_input_limitation';
    expect(() => validateSourceCoverageData(covered, f.ledger, [f.body])).toThrow('exact inspected input');
    covered.checks[3].boundedInput = { sourceInputDigest: f.ledgerData.manifest.sourceInputDigest, unitKeys: f.ledgerData.manifest.units.map(unit => unit.unitKey), inspectedFields: ['/source/sourceKind'], scope: 'Only the two delivered units were inspected.' };
    validateSourceCoverageData(covered, f.ledger, [f.body]);
    covered.checks[3].boundedInput.inspectedFields = ['/fabricated'];
    expect(() => validateSourceCoverageData(covered, f.ledger, [f.body])).toThrow('unknown field');
    covered.checks[3].boundedInput.inspectedFields = ['/source/sourceKind'];
    covered.checks[3].boundedInput.unitKeys.pop();
    expect(() => validateSourceCoverageData(covered, f.ledger, [f.body])).toThrow('bounded input units');
    expect(f.coverageData.checks[3].factualValue).toBe('unknown');
  });
  it('reviews a zero-body result against all delivered units and candidates without fabricating content or approval', () => {
    const f = sourceReviewFixture(), data = structuredClone(f.coverageData);
    data.bodyRefs = []; data.checks = data.checks.filter(check => check.target.targetKind !== 'body_segment');
    for (const check of data.checks) { check.bodyEvidence = []; if (check.status === 'covered') check.status = 'omitted'; }
    validateSourceCoverageData(data, f.ledger, []);
    expect(sourceCoverageUnresolved(data, f.ledgerData)).toContain('check:c3');
    const command = structuredClone(f.coverageCommand); command.revision.data = data;
    const history = applySourceCoverageWrite(undefined, command, reviewActor, 'test', reviewDigest(), bodyAt);
    expect(selectSourceCoverageDecision(history, f.coverageRef).status).toBe('not_reviewed');
    data.checks[1].status = 'covered';
    expect(() => validateSourceCoverageData(data, f.ledger, [])).toThrow('cannot be covered');
  });
  it('retains exclusions/pending opinions and requires every unresolved disposition for an actual decision', () => {
    const f = sourceReviewFixture(), decision = f.decision();
    expect(sourceCoverageUnresolved(f.coverageData, f.ledgerData)).toEqual(['unit:s1/metadata', 'check:c1', 'check:c4']);
    validateSourceCoverageDecisionDispositions(decision, f.coverage, f.ledger);
    decision.decision.dispositions.pop();
    expect(() => validateSourceCoverageDecisionDispositions(decision, f.coverage, f.ledger)).toThrow('unresolved dispositions');
    expect(SourceCoverageWriteSchema.safeParse({ ...f.decision(), actor: reviewActor }).success).toBe(false);
    expect(() => SourceReviewActorSchema.parse({ actorKind: 'agent', actorId: ' ', executionRef: ' ' })).toThrow();
  });
});
describe('append-only actual source coverage decisions', () => {
  it('keeps model analysis unapproved and uses actor-bound receipts plus CAS for both stores', () => {
    const f = sourceReviewFixture(), ledger = applySourceLedgerWrite(undefined, f.ledgerCommand, reviewActor, 'test', reviewDigest(), bodyAt);
    validateSourceLedgerHistory(ledger);
    expect(applySourceLedgerWrite(ledger, f.ledgerCommand, reviewActor, 'test', reviewDigest(), bodyAt)).toBe(ledger);
    expect(() => applySourceLedgerWrite(ledger, { ...f.ledgerCommand, requestId: reviewId(10) }, reviewActor, 'test', reviewDigest(), bodyAt)).toThrow('revision conflict');
    const history = append(f); expect(selectSourceCoverageDecision(history, f.coverageRef)).toEqual({ status: 'not_reviewed', events: [] });
    const command = f.decision(), reviewed = applySourceCoverageWrite(history, command, reviewActor, 'test', reviewDigest('b'), bodyAt);
    expect(selectSourceCoverageDecision(reviewed, f.coverageRef).status).toBe('proceed_with_limits');
    expect(applySourceCoverageWrite(reviewed, command, reviewActor, 'test', reviewDigest('b'), bodyAt)).toBe(reviewed);
    expect(() => applySourceCoverageWrite(reviewed, command, reviewActor, 'test', reviewDigest('c'), bodyAt)).toThrow('idempotency conflict');
    assertSourceCoverageDecision(reviewed, { ...command.decision, eventId: command.requestId });
    expect(() => assertSourceCoverageDecision(reviewed, { ...command.decision, eventId: reviewId(99) })).toThrow('active nonconflicting');
    const tampered = structuredClone(reviewed); tampered.events[1].parentEventId = null;
    expect(() => validateSourceCoverageHistory(tampered)).toThrow('history references');
  });
  it('blocks conflicting active opinions, explicit blockers, revocations and changed identities regardless of time', () => {
    const f = sourceReviewFixture(), yes = f.decision();
    let history = applySourceCoverageWrite(append(f), yes, reviewActor, 'test', reviewDigest('b'), bodyAt);
    const no = f.decision(10); no.expectedGeneration = 2; no.expectedHeadEventId = yes.requestId; no.decision.decisionKind = 'needs_revision';
    history = applySourceCoverageWrite(history, no, reviewActor, 'test', reviewDigest('c'), '2026-09-13T00:00:00Z');
    expect(selectSourceCoverageDecision(history, f.coverageRef).status).toBe('disputed');
    expect(() => assertSourceCoverageDecision(history, { ...yes.decision, eventId: yes.requestId })).toThrow('active nonconflicting');
    const reconcile = f.decision(11); reconcile.expectedGeneration = 3; reconcile.expectedHeadEventId = no.requestId; reconcile.decision.supersedesEventIds = [yes.requestId, no.requestId];
    history = applySourceCoverageWrite(history, reconcile, reviewActor, 'test', reviewDigest('d'), bodyAt);
    expect(selectSourceCoverageDecision(history, f.coverageRef).status).toBe('proceed_with_limits'); expect(history.events).toHaveLength(4);
    history = applySourceCoverageWrite(history, { commandKind: 'revoke_decision', coverageId: f.coverageRef.coverageId, requestId: reviewId(12), expectedGeneration: 4, expectedHeadEventId: reconcile.requestId, targetEventId: reconcile.requestId, reason: 'New source evidence invalidates the opinion.' }, reviewActor, 'test', reviewDigest('e'), bodyAt);
    expect(selectSourceCoverageDecision(history, f.coverageRef).status).toBe('not_reviewed');
    const blocked = f.decision(); blocked.decision.dispositions[0].disposition = 'blocks';
    expect(() => applySourceCoverageWrite(append(f), blocked, reviewActor, 'test', reviewDigest('b'), bodyAt)).toThrow('cannot proceed');
    const changed = f.decision(); changed.decision.bodyRefs[0].revisionId = 'new-body';
    expect(() => applySourceCoverageWrite(append(f), changed, reviewActor, 'test', reviewDigest('b'), bodyAt)).toThrow('identity conflict');
  });
});
