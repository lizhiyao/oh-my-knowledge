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
const coreFixtureText = readFileSync(new URL('../fixtures/entity-core-object-coverage-v1.json', import.meta.url), 'utf8');
const coreFixture = JSON.parse(coreFixtureText);
const coreCases = EntityReviewCorpusSchema.shape.cases.element.array().parse(coreFixture.cases);
const coreSelected = (caseId: string) => coreCases.find(sample => sample.caseId === caseId)!;
const baseline = parseEntityReviewCorpus(readFileSync(new URL('../fixtures/entity-extraction-review-v13.json', import.meta.url), 'utf8'));
const selected = (caseId: string) => cases.find(sample => sample.caseId === caseId)!;

function authored(sample: EntityReviewCase) {
  const output = modelWindow(); output.proposals = [];
  const isContextFixture = cases.some(value => value.caseId === sample.caseId);
  output.entities = sample.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
    label: sample.mentions.find(mention => mention.entity === entity.entityKey)?.alternatives[0]?.quote ?? entity.entityKey,
    description: entity.rationale, referentKind: entity.referentKinds[0] ?? 'object',
    qualifiers: !isContextFixture ? [] : sample.caseId === 'dev-unconfirmed-context-correspondence'
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

/** The isolated diagnostic supplies its own bytes; its cases never enter the published 64-case corpus. */
function semanticContext(sample: EntityReviewCase, output: ReturnType<typeof authored>,
  source: { raw: string; authors: string[] } = { raw: fixtureText, authors: fixture.authors }) {
  const corpus = { ...baseline, authors: source.authors, cases: [sample] };
  const measurementId = reviewDigest(source.raw);
  const plan = createSemanticPlan({ measurementId, declaredAt: '2020-01-01T00:00:00Z', split: 'development', repeats: 1,
    caseIds: [sample.caseId], criteria: { maxConfirmedErrors: 0,
      confirmedErrorsRationale: 'This scoped authored regression permits no confirmed semantic error.',
      maxRequiredGaps: 0, requiredGapsRationale: 'These entity-only diagnostics declare no mandatory knowledge roles.' } });
  const raw = JSON.stringify({ captureVersion: 'omk-entity-captures/v1', measurementId, split: 'development', repeats: 1,
    startedAt: '2020-02-01T00:00:00Z', executor: 'authored-fixture', model: 'no-model-call',
    records: [{ caseId: sample.caseId, repeat: 1, inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))),
      result: { captureStatus: 'output', output: JSON.stringify(output) } }] });
  const capture = reviewCapture(raw, corpus, measurementId, checkWindowExtractionResponse);
  return { plan, capturesDigest: reviewDigest(raw), capture, corpus, measurementId, authorReview: 'completed' as const,
    annotationReview: 'pending' as const, now: '2020-04-01T00:00:00Z' };
}

/** Test-authored judgment; the deterministic engine validates it rather than inferring qualifier support. */
function qualifierReview(sample: EntityReviewCase, output: ReturnType<typeof authored>) {
  const context = semanticContext(sample, output);
  const receipt = { reviewVersion: 'omk-entity-output-review/v1', planId: context.plan.planId, capturesDigest: context.capturesDigest,
    reviewer: { actorKind: 'agent', actorId: fixture.authors[0] }, independentHuman: false, reviewedAt: '2020-03-01T00:00:00Z',
    decisions: semanticReviewTargets(context).map(target => {
      const wrong = target.itemKind === 'entity' && target.entityId === 'atlas-prompt';
      return { target, verdict: wrong ? 'incorrect' : 'uncertain', errorCodes: wrong ? ['unsupported_qualifier'] : [],
        rationale: wrong ? 'Atlas 的版本未给；r14 来自没有确认对应关系的另一处记录，不能移入 Atlas 的 description 或 qualifiers。'
          : '本测试只裁决已知的限定归属错误，其余目标仍待逐项语义复核。' };
    }) };
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


describe('core content-object coverage diagnostic (authored responses, separate development scope)', () => {
  it('admits the source-defined targets without forcing background content or changing the published denominator', () => {
    expect(coreFixture).toMatchObject({ reviewVersion: 'omk-entity-core-object-coverage/v1', provenance: 'synthetic' });
    expect(baseline.cases).toHaveLength(64);
    expect(baseline.cases.reduce((total, sample) => total + sample.mentions.length, 0)).toBe(212);
    for (const sample of coreCases) {
      expect(sample.split).toBe('development');
      expect(baseline.cases.some(value => value.caseId === sample.caseId)).toBe(false);
      const { checked, review } = inspect(sample, authored(sample));
      expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
      expect(review.criticalMentionRecall).toMatchObject({ matched: sample.mentions.length, total: sample.mentions.length });
      expect(review.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
      expect(review.identities.every(identity => identity.status === 'matched')).toBe(true);
      expect(review.semanticReview).toBe('pending'); expect(review.precision).toBeNull(); expect(review.f1).toBeNull();
    }
    expect(coreSelected('dev-edit-file-with-background-content').entities.map(value => value.entityKey)).toEqual(['edited-file']);
    expect(coreSelected('dev-background-section-not-target').entities.map(value => value.entityKey)).toEqual(['shift-guide']);
    expect(coreSelected('dev-whole-review-with-local-guidance').entities.map(value => value.entityKey)).toEqual(['rescue-manual']);
    expect(coreSelected('dev-local-guidance-with-background-owner').entities.map(value => value.entityKey)).toEqual(['appointment-rule', 'arrival-rule']);
  });

  it.each([
    { caseId: 'dev-file-only-locates-content', entityId: 'locator-file', quote: 'lessons/rook-pair.md',
      description: '保存被审查棋类教学练习《双车配合》的来源文件。', missingEntity: 'chess-exercise' },
    { caseId: 'dev-whole-review-with-local-guidance', entityId: 'rope-guidance', quote: '绳索收纳提示',
      description: '《岬湾救援手册》中的一条工具存放指引，只指局部，不指手册整体。', missingEntity: 'rescue-manual' },
    { caseId: 'dev-content-and-carrier-evaluated', entityId: 'tour-script', quote: '导览词《潮汐》',
      description: '记录在存储卡 card-7 上的导览词《潮汐》，这里只保留导览内容身份。', missingEntity: 'storage-card' },
  ])('blocks an omitted independent object even when its name remains in another description ($caseId)', ({ caseId, entityId, quote, description, missingEntity }) => {
    const sample = coreSelected(caseId), output = authored(sample);
    output.entities = [{ ...output.entities[0], entityId, label: quote, description }];
    output.mentions = [{ mentionId: 'substitute-only', entityId, basis: 'explicit',
      rationale: '这里只保留一个有据对象；description 中的其它名称没有对应的独立实体与提及。',
      selection: { evidenceRef: `${sample.caseId}:0`, quote, occurrence: 0 } }];
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    expect(checked.analysis.entities).toHaveLength(1);
    const missingMentions = sample.mentions.filter(mention => mention.entity === missingEntity);
    expect(review.criticalMentions.filter(mention => mention.status === 'missing')
      .map(({ mentionKey, status, entityId }) => ({ mentionKey, status, entityId }))).toEqual(missingMentions.map(mention => ({
      mentionKey: mention.mentionKey, status: 'missing', entityId: null,
    })));
    expect(review.identities.find(identity => identity.entity === missingEntity)).toMatchObject({ status: 'not_evaluable' });
    const report = evaluateSemanticReview(semanticContext(sample, output, { raw: coreFixtureText, authors: coreFixture.authors }));
    expect(report).toMatchObject({ status: 'blocked', reference: { goldReady: false } });
    expect(report.blockers).toContain('critical_regression_failure');
    expect(report.blockers).not.toContain('structural_rejection');
  });

  it('keeps a part-only identity pending despite the owner title span until an explicit coverage judgment blocks it', () => {
    const sample = coreSelected('dev-whole-review-with-local-guidance'), output = authored(sample);
    output.entities[0] = { ...output.entities[0], entityId: 'rope-guidance', label: '手册中的绳索收纳提示',
      description: '手册内部的一条工具存放指引，范围仅是该提示，不是整本救援手册。' };
    output.mentions[0].entityId = 'rope-guidance';
    output.mentions[0].rationale = '用所属手册的标题定位其中的局部存放提示，只指该局部指引。';
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    expect(review.criticalMentionRecall.value).toBe(1);
    expect(review.identities.every(identity => identity.status === 'matched')).toBe(true);
    expect(review.semanticReview).toBe('pending');
    const context = semanticContext(sample, output, { raw: coreFixtureText, authors: coreFixture.authors });
    expect(evaluateSemanticReview(context)).toMatchObject({ status: 'pending', outputReview: { reviewed: 0 } });
    const receipt = { reviewVersion: 'omk-entity-output-review/v1', planId: context.plan.planId, capturesDigest: context.capturesDigest,
      reviewer: { actorKind: 'agent', actorId: coreFixture.authors[0] }, independentHuman: false, reviewedAt: '2020-03-01T00:00:00Z',
      decisions: semanticReviewTargets(context).map(target => {
        const missingWhole = target.itemKind === 'semantic_check' && target.checkIndex === 0;
        return { target, verdict: missingWhole ? 'incorrect' : 'uncertain', errorCodes: missingWhole ? ['coverage'] : [],
          rationale: missingWhole ? '响应只有局部指引；标题字符命中和所属描述不能替代本轮独立受审的手册整体。'
            : '本诊断仅裁决整体覆盖缺口，其余输出仍待逐项语义复核。' };
      }) };
    // Entity obligations have no required_missing verdict here; use the existing scoped coverage judgment.
    const judged = evaluateSemanticReview({ ...context, receipt });
    expect(judged).toMatchObject({ status: 'blocked', reference: { goldReady: false },
      outputReview: { confirmedErrors: 1, requiredGaps: 0, independentHuman: false } });
    expect(judged.blockers).toContain('confirmed_error_threshold');
    expect(judged.blockers).not.toContain('critical_regression_failure');
    expect(judged.blockers).not.toContain('structural_rejection');
  });

  it('does not let complete source spans hide a merge of independently reviewed content and carrier', () => {
    const sample = coreSelected('dev-content-and-carrier-evaluated'), output = authored(sample);
    output.entities = output.entities.filter(entity => entity.entityId === 'tour-script');
    output.entities[0].description = '导览词《潮汐》及其存储卡 card-7。';
    output.mentions.forEach(mention => { mention.entityId = 'tour-script'; });
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    expect(review.criticalMentionRecall.value).toBe(1);
    expect(review.identityPairs).toMatchObject([{ expected: 'different', status: 'wrong_merge' }]);
  });

  it('detects splitting two explicit names for one artifact instead of inventing a content-container pair', () => {
    const sample = coreSelected('dev-explicit-document-alias'), output = authored(sample);
    output.entities.push({ ...output.entities[0], entityId: 'separate-artifact' });
    output.mentions.find(mention => mention.mentionId === 'manual-alias')!.entityId = 'separate-artifact';
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    expect(review.criticalMentionRecall.value).toBe(1);
    expect(review.identityPairs).toMatchObject([{ expected: 'same', status: 'wrong_split' }]);
  });
});


/** These authored judgments exercise the existing gate; no source-claim NLP is added. */
describe('source-claim fields remain semantic review obligations (isolated synthetic development)', () => {
  const claims = [
    { caseId: 'dev-independent-review-with-unsupported-containment', entityId: 'harbor-script',
      claim: '河港导览词包含珊瑚展柜清单，清单属于该导览词。', errorCode: 'unsupported_fact',
      rationale: '同批分别审查不支持两份资料间的包含或所属关系；明确的内部播报段落不能替该关系背书。' },
    { caseId: 'dev-provider-organizer-with-unknown-origin', entityId: 'tundra-plan',
      claim: '青禾最先提出苔原采样构想，是该构想的提出者。', errorCode: 'provenance',
      rationale: '来源只支持青禾提供与整理，未给苔原构想提出者；另一方案的明确来源不能转借。' },
  ];
  const fieldCases = claims.flatMap(claim => (['description', 'qualifiers', 'rationale'] as const).map(field => ({ ...claim, field })));
  it.each(fieldCases)('blocks an authored unsupported $field claim despite explicit exact anchors ($caseId)',
    ({ caseId, entityId, claim, errorCode, rationale, field }) => {
      const sample = coreSelected(caseId), output = authored(sample);
      const entity = output.entities.find(value => value.entityId === entityId)!;
      const mention = output.mentions.find(value => value.entityId === entityId)!;
      if (field === 'description') entity.description = claim;
      else if (field === 'qualifiers') entity.qualifiers = [claim];
      else mention.rationale = claim;
      entity.uncertainties = ['该来源关系或角色尚未获确认；此说明不能抵消其它字段已写入的无保留断言。'];
      expect(mention.basis).toBe('explicit');
      const { checked, review } = inspect(sample, output);
      expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
      expect(review.criticalMentionRecall.value).toBe(1);
      expect(review.identities.every(value => value.status === 'matched')).toBe(true);
      expect(review.identityPairs.every(value => value.status === 'matched')).toBe(true);
      expect(review.semanticReview).toBe('pending');
      const context = semanticContext(sample, output, { raw: coreFixtureText, authors: coreFixture.authors });
      expect(evaluateSemanticReview(context)).toMatchObject({ status: 'pending', outputReview: { reviewed: 0 } });
      const receipt = { reviewVersion: 'omk-entity-output-review/v1', planId: context.plan.planId, capturesDigest: context.capturesDigest,
        reviewer: { actorKind: 'agent', actorId: coreFixture.authors[0] }, independentHuman: false, reviewedAt: '2020-03-01T00:00:00Z',
        decisions: semanticReviewTargets(context).map(target => {
          const wrong = field === 'rationale' ? target.itemKind === 'mention' && target.mentionId === mention.mentionId
            : target.itemKind === 'entity' && target.entityId === entityId;
          return { target, verdict: wrong ? 'incorrect' : 'uncertain', errorCodes: wrong ? [errorCode] : [],
            rationale: wrong ? rationale : '本用例只显式裁决这项来源断言；其它目标仍待逐项复核。' };
        }) };
      const report = evaluateSemanticReview({ ...context, receipt });
      expect(report).toMatchObject({ status: 'blocked', reference: { goldReady: false },
        outputReview: { confirmedErrors: 1, requiredGaps: 0, independentHuman: false } });
      expect(report.blockers).toContain('critical_semantic_error');
      expect(report.blockers).not.toContain('structural_rejection');
      expect(report.blockers).not.toContain('critical_regression_failure');
    });

  it.each([
    { caseId: claims[0].caseId, form: 'neutral independent review' },
    { caseId: claims[0].caseId, form: 'explicit local inclusion' },
    { caseId: claims[1].caseId, form: 'provider with unknown origin' },
    { caseId: claims[1].caseId, form: 'explicit origin and organizer' },
  ])('keeps faithful $form without mechanical rejection ($caseId)', ({ caseId, form }) => {
    const sample = coreSelected(caseId), output = authored(sample);
    if (form === 'explicit local inclusion') {
      output.entities[0].description = '河港导览词；来源明确其内部包含闭馆播报段落，展柜清单另行审查。';
      output.entities[0].qualifiers = ['内部有闭馆播报段落'];
    } else if (form === 'provider with unknown origin') {
      output.entities[0].description = '青禾提供并整理的苔原采样方案；来源未说明最初构想提出者。';
      output.entities[0].uncertainties = ['最初构想提出者未知'];
      expect(output.entities[0].identityStatus).toBe('proposed');
    } else if (form === 'explicit origin and organizer') {
      output.entities[1].qualifiers = ['最初构想由闻溪提出', '青禾整理成稿'];
    }
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    expect(review.criticalMentionRecall.value).toBe(1);
    const context = semanticContext(sample, output, { raw: coreFixtureText, authors: coreFixture.authors });
    const receipt = { reviewVersion: 'omk-entity-output-review/v1', planId: context.plan.planId, capturesDigest: context.capturesDigest,
      reviewer: { actorKind: 'agent', actorId: coreFixture.authors[0] }, independentHuman: false, reviewedAt: '2020-03-01T00:00:00Z',
      decisions: semanticReviewTargets(context).map(target => ({ target, verdict: 'correct', errorCodes: [],
        rationale: '此合成响应保留有据指代和关系／角色，来源未知仍如实保留；判断仅为测试作者提供的局部复核见证。' })) };
    expect(evaluateSemanticReview({ ...context, receipt })).toMatchObject({ status: 'exploratory_reviewed',
      reference: { goldReady: false }, outputReview: { confirmedErrors: 0, requiredGaps: 0, uncertain: 0, independentHuman: false } });
    // This demonstrates that no deterministic keyword filter rejects the faithful response, not model success or Gold.
  });
});
