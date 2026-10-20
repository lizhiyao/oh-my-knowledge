import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWindowExtractionResponse } from '../../src/knowledge/extraction/window-proposals.js';
import { EntityReviewCorpusSchema, entityReviewInput, parseEntityReviewCorpus } from '../../scripts/bench/entity-review-corpus.js';
import { checkEntityReview } from '../../scripts/bench/entity-review-checks.js';
import { reviewCapture, reviewDigest } from '../../scripts/bench/entity-extraction-review.js';
import { createSemanticPlan, evaluateSemanticReview, semanticReviewTargets } from '../../scripts/bench/entity-semantic-checks.js';
import { modelWindow } from '../knowledge/fixtures.js';

const fixtureText = readFileSync(new URL('../fixtures/entity-atomic-statement-v1.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText);
const sample = EntityReviewCorpusSchema.shape.cases.element.parse(fixture.sample);
const baseline = parseEntityReviewCorpus(readFileSync(new URL('../fixtures/entity-extraction-review-v13.json', import.meta.url), 'utf8'));
// A selected test harness, with a distinct measurement identity; the v13 corpus stays unchanged.
const corpus = { ...baseline, authors: ['atomic-regression-author'], cases: [sample] };
const measurementId = reviewDigest(fixtureText);
const plan = createSemanticPlan({ measurementId, declaredAt: '2020-01-01T00:00:00Z', split: 'development', repeats: 1,
  caseIds: [sample.caseId], criteria: { maxConfirmedErrors: 0,
    confirmedErrorsRationale: 'A confirmed mixed-polarity atomicity error blocks this authored development regression.',
    maxRequiredGaps: 0, requiredGapsRationale: 'Both delivery and unaccepted quality obligations were declared before outputs.' } });

function authored(split: boolean) {
  const output = modelWindow();
  output.entities = [{ ...output.entities[0], entityId: 'lumen', label: 'Lumen', description: '本次来源陈述中的软件' }];
  output.mentions = [{ ...output.mentions[0], mentionId: 'lumen-name', entityId: 'lumen',
    selection: { evidenceRef: `${sample.caseId}:0`, quote: 'Lumen', occurrence: 0 }, rationale: '原文中的软件名' }];
  const proposal = output.proposals[0];
  proposal.proposalId = 'status-report'; proposal.entityIds = ['lumen']; proposal.mentionIds = ['lumen-name'];
  proposal.draft.title = 'Lumen 交付与提取语义质量验收状态';
  const context = { scenario: '助手报告的软件状态，仅保留来源说法', conditions: [], exceptions: [], unknowns: ['没有独立交付或质量验收证据'],
    occurredDuring: { timeKind: 'unknown' as const, reason: '来源没有提供事实发生时间' },
    validDuring: { timeKind: 'unknown' as const, reason: '来源没有提供状态的有效期间' } };
  proposal.draft.content.statements = split ? [
    { statementId: 'delivery-completed', subject: { entityId: 'lumen' }, relation: '软件已交付', modality: 'descriptive', polarity: 'positive', context },
    { statementId: 'quality-not-accepted', subject: { entityId: 'lumen' }, relation: '提取语义质量已验收', modality: 'descriptive', polarity: 'negative', context },
  ] : [{ statementId: 'mixed-status', subject: { entityId: 'lumen' }, relation: '软件已交付，但提取语义质量尚未验收',
    modality: 'descriptive', polarity: 'positive', context }];
  proposal.draft.evidence = (split ? sample.roles : [{ roleKey: 'mixed-status', interpretation: '来源同时报告交付完成和提取语义质量未验收。' }])
    .map(role => ({ evidenceLinkId: role.roleKey, evidenceRef: `${sample.caseId}:0`, statementIds: [role.roleKey],
      relation: 'supports', basis: 'source_assertion', interpretation: role.interpretation }));
  proposal.citations = split ? sample.roles.map(role => ({ evidenceLinkId: role.roleKey,
    selection: { evidenceRef: `${sample.caseId}:0`, ...role.anchor } })) : [{ evidenceLinkId: 'mixed-status',
    selection: { evidenceRef: `${sample.caseId}:0`, quote: sample.messages[0].text, occurrence: 0 } }];
  proposal.reuseRationale = '区分已交付与质量尚未验收，供后续核对状态时参考';
  return output;
}

function captured(output: ReturnType<typeof authored>) {
  const raw = JSON.stringify({ captureVersion: 'omk-entity-captures/v1', measurementId, split: 'development', repeats: 1,
    startedAt: '2020-02-01T00:00:00Z', executor: 'authored-fixture', model: 'no-model-call',
    records: [{ caseId: sample.caseId, repeat: 1, inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))),
      result: { captureStatus: 'output', output: JSON.stringify(output) } }] });
  return { capture: reviewCapture(raw, corpus, measurementId, checkWindowExtractionResponse), capturesDigest: reviewDigest(raw) };
}

function judged(output: ReturnType<typeof authored>, incorrect: boolean) {
  const { capture, capturesDigest } = captured(output);
  const targets = semanticReviewTargets({ capture, corpus });
  const receipt = { reviewVersion: 'omk-entity-output-review/v1', planId: plan.planId, capturesDigest,
    reviewer: { actorKind: 'agent', actorId: corpus.authors[0] }, independentHuman: false, reviewedAt: '2020-03-01T00:00:00Z',
    decisions: targets.map(target => {
      const wrong = incorrect && target.itemKind === 'statement' && target.statementId === 'mixed-status';
      return { target, verdict: wrong ? 'incorrect' : incorrect ? 'uncertain' : 'correct', errorCodes: wrong ? ['polarity'] : [],
        rationale: wrong ? '来源包含交付完成与质量尚未验收两项命题；单条 positive 无法为二者提供统一 polarity，须分别陈述。'
          : incorrect ? '本错误回归只裁决已知的混合陈述，其余目标保留未完成语义复核。'
            : '开发样本作者读取了来源、定位引文和完整陈述；此显式裁决不是关键词分类，也不是独立人工验收。' };
    }) };
  return evaluateSemanticReview({ plan, capturesDigest, capture, corpus, measurementId, authorReview: 'completed',
    annotationReview: 'pending', receipt, now: '2020-04-01T00:00:00Z' });
}

describe('atomic statement development regression (authored judgments, no model calls)', () => {
  it('admits a mixed positive structurally while an explicit semantic error blocks the gate', () => {
    expect(fixture).toMatchObject({ reviewVersion: 'omk-entity-atomic-statement/v1', provenance: 'synthetic', sample: { split: 'development' } });
    expect(baseline.cases.some(value => value.caseId === sample.caseId)).toBe(false);
    const output = authored(false);
    const checked = checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]); expect(checked.accepted).toHaveLength(1);
    const review = checkEntityReview(sample, checked);
    expect(review.roles.map(role => role.endpointStatus)).toEqual(['endpoints_matched', 'endpoints_matched']);
    expect(review.roles.map(role => role.observed.map(statement => statement.statementId))).toEqual([['mixed-status'], ['mixed-status']]);
    expect(review.semanticReview).toBe('pending');
    const report = judged(output, true);
    expect(report).toMatchObject({ status: 'blocked', outputReview: { confirmedErrors: 1 } });
    expect(report.blockers).toContain('confirmed_error_threshold');
  });

  it('keeps separately supported unified propositions exploratory after an explicit agent review', () => {
    const output = authored(true);
    const checked = checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    expect(checked.accepted[0].draft.content.statements.map(statement => ({ statementId: statement.statementId,
      modality: statement.modality, polarity: statement.polarity }))).toEqual([
      { statementId: 'delivery-completed', modality: 'descriptive', polarity: 'positive' },
      { statementId: 'quality-not-accepted', modality: 'descriptive', polarity: 'negative' },
    ]);
    expect(checkEntityReview(sample, checked).roles.map(role => role.observed.map(statement => statement.statementId)))
      .toEqual([['delivery-completed'], ['quality-not-accepted']]);
    expect(checked.accepted[0].citations.map(citation => citation.selection.quote)).toEqual(sample.roles.map(role => role.anchor.quote));
    expect(judged(output, false)).toMatchObject({ status: 'exploratory_reviewed',
      reference: { goldReady: false }, outputReview: { independentHuman: false, confirmedErrors: 0 } });
  });
});
