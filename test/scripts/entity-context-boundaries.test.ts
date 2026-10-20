import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWindowExtractionResponse } from '../../src/knowledge/extraction/window-proposals.js';
import { EntityReviewCorpusSchema, entityReviewInput, parseEntityReviewCorpus, type EntityReviewCase } from '../../scripts/bench/entity-review-corpus.js';
import { checkEntityReview } from '../../scripts/bench/entity-review-checks.js';
import { reviewCapture, reviewDigest } from '../../scripts/bench/entity-extraction-review.js';
import { createSemanticPlan, evaluateSemanticReview, semanticReviewTargets } from '../../scripts/bench/entity-semantic-checks.js';
import { modelWindow } from '../knowledge/fixtures.js';

const fixtureText = readFileSync(new URL('../fixtures/entity-context-boundaries-v1.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText);
const cases = EntityReviewCorpusSchema.shape.cases.element.array().parse(fixture.cases);
const baseline = parseEntityReviewCorpus(readFileSync(new URL('../fixtures/entity-extraction-review-v13.json', import.meta.url), 'utf8'));
const selected = (caseId: string) => cases.find(sample => sample.caseId === caseId)!;

function authored(sample: EntityReviewCase) {
  const output = modelWindow(); output.proposals = [];
  output.entities = sample.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
    label: entity.entityKey, description: entity.rationale, referentKind: 'object',
    qualifiers: sample.caseId === 'dev-unconfirmed-context-correspondence'
      ? entity.entityKey === 'unresolved-prompt' ? ['记录内当前版本 r14'] : []
      : [entity.entityKey === 'example-prompt' ? '示例内当前版本 r14' : '本轮审查当前版本 r17'],
    identityStatus: entity.identityStatus, possibleEntityIds: entity.possibleEntities,
    uncertainties: entity.identityStatus === 'unresolved' ? [entity.rationale]
      : sample.caseId === 'dev-unconfirmed-context-correspondence' ? ['来源未给此对象的版本'] : [],
    componentRef: null, collection: null }));
  output.mentions = sample.mentions.map(mention => ({ mentionId: mention.mentionKey, entityId: mention.entity,
    basis: 'explicit', rationale: mention.rationale,
    selection: { evidenceRef: `${sample.caseId}:${mention.messageIndex}`, ...mention.alternatives[0] } }));
  return output;
}
const inspect = (sample: EntityReviewCase, output: ReturnType<typeof authored>) => {
  const checked = checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
  return { checked, review: checkEntityReview(sample, checked) };
};

/** Test-authored judgment; the deterministic engine validates it rather than inferring qualifier support. */
function qualifierReview(sample: EntityReviewCase, output: ReturnType<typeof authored>) {
  // A targeted development harness with its own identity; never relabel these cases as held-out v13 data.
  const corpus = { ...baseline, authors: fixture.authors, cases: [sample] };
  const measurementId = reviewDigest(fixtureText);
  const plan = createSemanticPlan({ measurementId, declaredAt: '2020-01-01T00:00:00Z', split: 'development', repeats: 1,
    caseIds: [sample.caseId], criteria: { maxConfirmedErrors: 0,
      confirmedErrorsRationale: 'This authored qualifier-boundary regression permits no confirmed unsupported qualifier.',
      maxRequiredGaps: 0, requiredGapsRationale: 'No knowledge coverage obligations are declared in this entity-only diagnostic.' } });
  const raw = JSON.stringify({ captureVersion: 'omk-entity-captures/v1', measurementId, split: 'development', repeats: 1,
    startedAt: '2020-02-01T00:00:00Z', executor: 'authored-fixture', model: 'no-model-call',
    records: [{ caseId: sample.caseId, repeat: 1, inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))),
      result: { captureStatus: 'output', output: JSON.stringify(output) } }] });
  const capture = reviewCapture(raw, corpus, measurementId, checkWindowExtractionResponse);
  const capturesDigest = reviewDigest(raw);
  const receipt = { reviewVersion: 'omk-entity-output-review/v1', planId: plan.planId, capturesDigest,
    reviewer: { actorKind: 'agent', actorId: fixture.authors[0] }, independentHuman: false, reviewedAt: '2020-03-01T00:00:00Z',
    decisions: semanticReviewTargets({ capture, corpus }).map(target => {
      const wrong = target.itemKind === 'entity' && target.entityId === 'atlas-prompt';
      return { target, verdict: wrong ? 'incorrect' : 'uncertain', errorCodes: wrong ? ['unsupported_qualifier'] : [],
        rationale: wrong ? 'Atlas 的版本未给；r14 来自没有确认对应关系的另一处记录，不能移入 Atlas 的 description 或 qualifiers。'
          : '本测试只裁决已知的限定归属错误，其余目标仍待逐项语义复核。' };
    }) };
  const context = { plan, capturesDigest, capture, corpus, measurementId, authorReview: 'completed' as const,
    annotationReview: 'pending' as const, now: '2020-04-01T00:00:00Z' };
  return { pending: evaluateSemanticReview(context), judged: evaluateSemanticReview({ ...context, receipt }) };
}

describe('entity context boundary development diagnostic (authored responses, no model calls)', () => {
  it('keeps the targeted cases outside the unchanged critical corpus and accepts their declared identity groups', () => {
    expect(fixture).toMatchObject({ reviewVersion: 'omk-entity-context-boundaries/v1', provenance: 'synthetic' });
    for (const sample of cases) {
      expect(sample.split).toBe('development');
      expect(baseline.cases.some(value => value.caseId === sample.caseId)).toBe(false);
      const { checked, review } = inspect(sample, authored(sample));
      expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
      expect(review.criticalMentionRecall).toMatchObject({ matched: sample.mentions.length, total: sample.mentions.length });
      expect(review.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
      expect(review.identities.every(identity => identity.status === 'matched')).toBe(true);
      expect(review.semanticReview).toBe('pending'); expect(review.precision).toBeNull(); expect(review.f1).toBeNull();
    }
  });

  it('detects binding isolated example mentions to the current object despite exact source locations', () => {
    const sample = selected('dev-isolated-example-objects'), output = authored(sample);
    output.entities = output.entities.filter(entity => entity.entityId === 'current-prompt');
    output.mentions.forEach(mention => { mention.entityId = 'current-prompt'; });
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]);
    expect(review.criticalMentionRecall.value).toBe(1);
    expect(review.identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
  });

  it('detects an unnecessary split when the source explicitly confirms cross-quotation identity', () => {
    const sample = selected('dev-explicit-cross-quotation-identity'), output = authored(sample);
    output.entities.push({ ...output.entities[0], entityId: 'quoted-copy' });
    output.mentions.find(mention => mention.mentionId === 'quoted-name')!.entityId = 'quoted-copy';
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]);
    expect(review.criticalMentionRecall.value).toBe(1);
    expect(review.identityPairs.some(pair => pair.status === 'wrong_split')).toBe(true);
  });

  it('detects choosing a candidate without source clarification while leaving named objects proposed', () => {
    const sample = selected('dev-unconfirmed-context-correspondence'), output = authored(sample);
    const original = inspect(sample, output).checked.analysis.entities;
    expect(original.find(entity => entity.entityId === 'unresolved-prompt')).toMatchObject({ identityStatus: 'unresolved',
      possibleEntityIds: ['atlas-prompt', 'beacon-prompt'] });
    expect(original.filter(entity => entity.entityId !== 'unresolved-prompt').every(entity => entity.identityStatus === 'proposed')).toBe(true);
    output.entities = output.entities.filter(entity => entity.entityId !== 'unresolved-prompt');
    output.mentions.filter(mention => mention.entityId === 'unresolved-prompt').forEach(mention => { mention.entityId = 'atlas-prompt'; });
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]);
    expect(review.identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
    expect(review.identities.find(identity => identity.entity === 'unresolved-prompt')!.problems).toContain('identity_status');
  });

  it('keeps unsupported qualifiers pending until an explicit semantic judgment blocks the scoped gate', () => {
    const sample = selected('dev-unconfirmed-context-correspondence'), output = authored(sample);
    const atlas = output.entities.find(entity => entity.entityId === 'atlas-prompt')!;
    atlas.description = '本轮审查的 Atlas 提示词，当前是 r14。'; atlas.qualifiers = ['当前版本 r14'];
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    expect(review.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
    expect(review.identities.every(identity => identity.status === 'matched')).toBe(true);
    expect(review.semanticReview).toBe('pending');
    const { pending, judged } = qualifierReview(sample, output);
    expect(pending).toMatchObject({ status: 'pending', reference: { goldReady: false }, outputReview: { reviewed: 0 } });
    expect(judged).toMatchObject({ status: 'blocked', reference: { goldReady: false },
      outputReview: { independentHuman: false, confirmedErrors: 1 } });
    expect(judged.blockers).toContain('confirmed_error_threshold');
    expect(judged.blockers).not.toContain('structural_rejection');
  });
});
