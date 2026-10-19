import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSemanticPlan, parseSemanticPlan, semanticReviewTargets, createSemanticReviewTemplate,
  evaluateSemanticReview, type SemanticReviewContext, type SemanticOutputReview } from '../../scripts/bench/entity-semantic-checks.js';
import { entityReviewInput, type EntityReviewCorpus } from '../../scripts/bench/entity-review-corpus.js';
import { reviewCapture, reviewDigest } from '../../scripts/bench/entity-extraction-review.js';
import { checkWindowExtractionResponse } from '../../src/knowledge/extraction/window-proposals.js';
import { modelWindow } from '../knowledge/fixtures.js';

const sample: EntityReviewCorpus['cases'][number] = {
  caseId: 'scope-case', projectGroup: 'scope-project', conversationGroup: 'scope-conversation', split: 'development',
  messages: [{ role: 'user', text: 'Alpha 使用 Beta' }], limitations: ['Synthetic authored regression, not model evidence.'], tags: ['semantic-review'],
  entities: ['project', 'tool'].map(entityKey => ({ entityKey, referentKinds: ['object'], identityStatus: 'proposed',
    possibleEntities: [], component: null, collection: null, rationale: 'Named source object.' })),
  mentions: [{ mentionKey: 'project', entity: 'project', messageIndex: 0, alternatives: [{ quote: 'Alpha', occurrence: 0 }], rationale: 'Named project.' },
    { mentionKey: 'tool', entity: 'tool', messageIndex: 0, alternatives: [{ quote: 'Beta', occurrence: 0 }], rationale: 'Named tool.' }],
  roles: [{ roleKey: 'usage', coverage: 'required', subject: 'project', object: 'tool', messageIndex: 0,
    anchor: { quote: 'Alpha 使用 Beta', occurrence: 0 }, interpretation: 'The source describes use, not causation.' }],
  knowledgePolicy: 'optional', semanticChecks: ['Check relation, context and source attribution.'],
};
const corpus: EntityReviewCorpus = { corpusVersion: 'omk-entity-quality/v13', guideVersion: 'omk-entity-annotation/v11',
  provenance: 'synthetic', authors: ['author'], annotationScope: 'critical_mentions', cases: [sample] };
const measurementId = reviewDigest('authored unit fixture, not production measurement');
const criteria = { maxConfirmedErrors: 0, confirmedErrorsRationale: 'This scoped regression permits no incorrect decision.',
  maxRequiredGaps: 0, requiredGapsRationale: 'Required facts must be covered in this authored check.' };
function fixture() {
  const raw = JSON.stringify({ captureVersion: 'omk-entity-captures/v1', measurementId,
    split: 'development', repeats: 1, startedAt: '2020-02-01T00:00:00Z', executor: 'authored', model: 'fixture',
    records: [{ caseId: sample.caseId, repeat: 1, inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))),
      result: { captureStatus: 'output', output: JSON.stringify(modelWindow()).replaceAll('record-1', `${sample.caseId}:0`) } }] });
  const capture = reviewCapture(raw, corpus, measurementId, checkWindowExtractionResponse);
  const plan = createSemanticPlan({ measurementId, declaredAt: '2020-01-01T00:00:00Z', split: 'development', repeats: 1,
    caseIds: [sample.caseId], criteria });
  const context: SemanticReviewContext = { corpus: structuredClone(corpus), capture, plan, measurementId,
    capturesDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}`, authorReview: 'completed',
    annotationReview: 'pending', now: '2020-04-01T00:00:00Z' };
  const receipt: SemanticOutputReview = { reviewVersion: 'omk-entity-output-review/v1', planId: plan.planId,
    capturesDigest: context.capturesDigest, reviewer: { actorKind: 'agent', actorId: 'author' }, independentHuman: false,
    reviewedAt: '2020-03-01T00:00:00Z', decisions: semanticReviewTargets(context).map(target => ({ target,
      verdict: 'correct', errorCodes: [], rationale: 'Authored test judgment; not independent semantic evidence.' })) };
  return { context, receipt, plan };
}
function independent(value: ReturnType<typeof fixture>) {
  value.context.annotationReview = 'attested_independent_human';
  value.receipt.reviewer = { actorKind: 'human', actorId: 'independent-reader' }; value.receipt.independentHuman = true;
  return { ...value.context, receipt: value.receipt };
}

describe('offline scoped semantic judgments', () => {
  it('requires explicit justified thresholds and binds plans independently of JSON property order', () => {
    const { plan } = fixture();
    expect(parseSemanticPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    const { planVersion: _version, ...withoutVersion } = plan; void _version;
    expect(() => parseSemanticPlan(withoutVersion)).toThrow();
    expect(createSemanticPlan({ criteria, caseIds: [sample.caseId], repeats: 1, split: 'development',
      declaredAt: plan.declaredAt, measurementId }).planId).toBe(plan.planId);
    expect(() => parseSemanticPlan({ ...plan, criteria: { ...criteria, maxConfirmedErrors: 1 } })).toThrow('identity');
    const { planId: _id, ...body } = plan; void _id;
    expect(() => createSemanticPlan({ ...body, criteria: {} })).toThrow();
    expect(() => createSemanticPlan({ ...body, criteria: { ...criteria, requiredGapsRationale: ' ' } })).toThrow();
    expect(() => createSemanticPlan({ ...body, caseIds: [sample.caseId, sample.caseId] })).toThrow('Duplicate');
  });
  it('enumerates accepted outputs, every role/check, and a whole-case obligation without signing templates', () => {
    const { context } = fixture(); const targets = semanticReviewTargets(context);
    expect(targets.map(value => value.itemKind)).toEqual(['entity', 'entity', 'mention', 'mention', 'statement', 'role', 'semantic_check', 'case']);
    const template = createSemanticReviewTemplate(context);
    expect(template.reviewer).toEqual({ actorKind: 'agent', actorId: '' }); expect(template.independentHuman).toBe(false);
    expect(template.decisions.every(value => value.verdict === 'uncertain' && !value.rationale)).toBe(true);
    const report = evaluateSemanticReview(context);
    expect(report).toMatchObject({ status: 'pending', scope: 'synthetic-critical-regression',
      planBinding: { declaration: 'attested_before_outputs', transportBound: false } });
    expect(report.missingTargets).toEqual(targets); expect(report.reference.goldReady).toBe(false);
  });
  it('separates complete agent review, independent reference readiness and independent output review', () => {
    const f = fixture();
    expect(evaluateSemanticReview({ ...f.context, receipt: f.receipt }).status).toBe('exploratory_reviewed');
    f.context.annotationReview = 'attested_independent_human';
    expect(evaluateSemanticReview({ ...f.context, receipt: f.receipt }).status).toBe('exploratory_reviewed');
    const input = independent(f); const report = evaluateSemanticReview(input);
    expect(report.status).toBe('accepted_within_scope'); expect(report.reference.goldReady).toBe(true);
    input.authorReview = 'pending';
    expect(evaluateSemanticReview(input).status).toBe('exploratory_reviewed');
    input.authorReview = 'changes_requested';
    expect(evaluateSemanticReview(input).blockers).toContain('reference_changes_requested');
  });
  it.each(['entity', 'mention', 'statement', 'role', 'semantic_check', 'case'])('keeps omitted %s decisions pending', itemKind => {
    const f = fixture(); const input = independent(f); const removed = f.receipt.decisions.find(value => value.target.itemKind === itemKind)!;
    f.receipt.decisions = f.receipt.decisions.filter(value => value !== removed);
    const report = evaluateSemanticReview(input);
    expect(report.status).toBe('pending'); expect(report.missingTargets).toEqual([removed.target]);
  });
  it('keeps uncertainty pending and applies explicit ordinary error/gap thresholds by review decision', () => {
    const f = fixture(); const input = independent(f);
    f.receipt.decisions[0].verdict = 'uncertain'; expect(evaluateSemanticReview(input).status).toBe('pending');
    f.receipt.decisions[0] = { ...f.receipt.decisions[0], verdict: 'incorrect', errorCodes: ['scope'] };
    expect(evaluateSemanticReview(input).blockers).toContain('confirmed_error_threshold');
    const { planId: _planId, ...body } = f.plan; void _planId;
    f.context.plan = createSemanticPlan({ ...body, criteria: { ...criteria, maxConfirmedErrors: 1 } });
    input.plan = f.context.plan; f.receipt.planId = (f.context.plan as typeof f.plan).planId;
    expect(evaluateSemanticReview(input)).toMatchObject({ status: 'accepted_within_scope', countingUnit: 'review-decision', outputReview: { confirmedErrors: 1 } });
  });
  it.each(['identity', 'provenance', 'unsupported_fact'] as const)('never averages away critical %s errors', errorCode => {
    const f = fixture(); const { planId: _planId, ...body } = f.plan; void _planId;
    f.context.plan = createSemanticPlan({ ...body, criteria: { ...criteria, maxConfirmedErrors: 100 } });
    f.receipt.planId = (f.context.plan as typeof f.plan).planId;
    f.receipt.decisions[0] = { ...f.receipt.decisions[0], verdict: 'incorrect', errorCodes: [errorCode] };
    const report = evaluateSemanticReview(independent(f));
    expect(report.status).toBe('blocked'); expect(report.blockers).toContain('critical_semantic_error');
    expect(report.blockers).not.toContain('confirmed_error_threshold');
  });
  it('rejects receipt/plan substitution, duplicate or out-of-scope decisions and false human roles', () => {
    const f = fixture();
    expect(() => evaluateSemanticReview({ ...f.context, receipt: { ...f.receipt, capturesDigest: reviewDigest('other raw bytes') } })).toThrow('identity');
    expect(() => evaluateSemanticReview({ ...f.context, receipt: { ...f.receipt, planId: reviewDigest('other plan') } })).toThrow('identity');
    expect(() => evaluateSemanticReview({ ...f.context, measurementId: reviewDigest('other measurement') })).toThrow('measurement');
    expect(() => evaluateSemanticReview({ ...f.context, receipt: { ...f.receipt, independentHuman: true } })).toThrow('agent');
    const input = independent(f); f.receipt.reviewer.actorId = ' AUTHOR ';
    expect(() => evaluateSemanticReview(input)).toThrow('author');
    f.receipt.reviewer.actorId = 'reviewer'; f.receipt.decisions.push(f.receipt.decisions[0]);
    expect(() => evaluateSemanticReview(input)).toThrow('Duplicate');
    f.receipt.decisions.pop(); f.receipt.decisions[0].target = { caseId: sample.caseId, repeat: 1, itemKind: 'semantic_check', checkIndex: 200 };
    expect(() => evaluateSemanticReview(input)).toThrow('unknown output');
  });
  it('distinguishes required gaps and optional nonselection, rejecting disguised incorrect judgments', () => {
    const f = fixture(); const input = independent(f); const role = f.receipt.decisions.find(value => value.target.itemKind === 'role')!;
    role.verdict = 'required_missing'; expect(evaluateSemanticReview(input).blockers).toContain('required_gap_threshold');
    role.verdict = 'optional_not_selected'; expect(() => evaluateSemanticReview(input)).toThrow('wrong obligation');
    f.context.corpus.cases[0].roles[0].coverage = 'if_selected';
    expect(evaluateSemanticReview(input)).toMatchObject({ status: 'accepted_within_scope', outputReview: { optionalNotSelected: 1 } });
    f.receipt.decisions[0].errorCodes = ['polarity']; expect(() => evaluateSemanticReview(input)).toThrow('Only incorrect');
  });
  it('blocks known failures and late plans even without a receipt, and rejects future/early review claims', () => {
    const f = fixture(); f.context.capture.unattempted.push({ caseId: sample.caseId, repeat: 1 });
    expect(evaluateSemanticReview(f.context).blockers).toContain('capture_incomplete_or_failed');
    f.context.capture.unattempted = [];
    // This projection intentionally carries opaque rejection payloads from several admission stages.
    (f.context.capture.records[0].structuralRejections as unknown[]).push({ reason: 'authored structural failure' });
    expect(evaluateSemanticReview(f.context).blockers).toContain('structural_rejection');
    f.context.capture.records[0].structuralRejections = [];
    const { planId: _planId, ...body } = f.plan; void _planId;
    f.context.plan = createSemanticPlan({ ...body, declaredAt: '2020-02-02T00:00:00Z' });
    expect(evaluateSemanticReview(f.context).blockers).toContain('plan_not_predeclared');
    f.context.plan = f.plan;
    expect(() => evaluateSemanticReview({ ...f.context, receipt: { ...f.receipt, reviewedAt: '2020-01-01T00:00:00Z' } })).toThrow('interval');
    expect(() => evaluateSemanticReview({ ...f.context, receipt: { ...f.receipt, reviewedAt: '2020-05-01T00:00:00Z' } })).toThrow('interval');
  });
  it.each(['criticalMentions', 'identityPairs', 'identities', 'unexpectedKnowledge', 'knowledgeCoverage'])('does not let correct receipts override deterministic %s failures', field => {
    const f = fixture(); const checks = f.context.capture.records[0].checks!;
    if (field === 'criticalMentions') checks.criticalMentions[0].status = 'missing';
    else if (field === 'identityPairs') checks.identityPairs[0].status = 'not_evaluable';
    else if (field === 'identities') checks.identities[0].status = 'mismatched';
    else if (field === 'unexpectedKnowledge') checks.unexpectedKnowledge = true;
    else checks.knowledgeCoverage[0].status = 'required_not_observed';
    const report = evaluateSemanticReview(independent(f));
    expect(report.status).toBe('blocked'); expect(report.blockers).toContain('critical_regression_failure');
  });
});
