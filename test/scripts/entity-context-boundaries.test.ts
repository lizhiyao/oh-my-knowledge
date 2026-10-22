import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWindowExtractionResponse } from '../../src/knowledge/extraction/window-proposals.js';
import { EntityReviewCorpusSchema, entityReviewInput, parseEntityReviewCorpus, type EntityReviewCase } from '../../scripts/bench/entity-review-corpus.js';
import { checkEntityReview } from '../../scripts/bench/entity-review-checks.js';
import { reviewCapture, reviewDigest } from '../../scripts/bench/entity-extraction-review.js';
import { createSemanticPlan, evaluateSemanticReview, semanticReviewTargets, type SemanticOutputReview } from '../../scripts/bench/entity-semantic-checks.js';
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
    uncertainties: entity.identityStatus === 'unresolved' || (entity.collection && entity.collection.completeness !== 'complete') ? [entity.rationale]
      : sample.caseId === 'dev-unconfirmed-context-correspondence' ? ['来源未给此对象的版本'] : [],
    componentRef: entity.component ? { entityId: entity.component,
      mentionIds: sample.mentions.filter(mention => mention.entity === entity.entityKey).map(mention => mention.mentionKey), rationale: entity.rationale } : null,
    collection: entity.collection ? { memberEntityIds: entity.collection.members, completeness: entity.collection.completeness,
      mentionIds: sample.mentions.filter(mention => mention.entity === entity.entityKey).map(mention => mention.mentionKey), rationale: entity.rationale } : null }));
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
      description: '保存被审查棋类教学练习《双车配合》的来源文件。' },
    { caseId: 'dev-whole-review-with-local-guidance', entityId: 'rope-guidance', quote: '绳索收纳提示',
      description: '《岬湾救援手册》中的一条工具存放指引，只指局部，不指手册整体。' },
  ])('blocks the absent core when only a locator or local guidance is returned ($caseId)', ({ caseId, entityId, quote, description }) => {
    const sample = coreSelected(caseId), output = authored(sample);
    output.entities = [{ ...output.entities[0], entityId, label: quote, description }];
    output.mentions = [{ mentionId: 'substitute-only', entityId, basis: 'explicit',
      rationale: '这里只保留有据的定位载体或局部指引，未返回本轮被审查的核心整体。',
      selection: { evidenceRef: `${sample.caseId}:0`, quote, occurrence: 0 } }];
    const { checked, review } = inspect(sample, output);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    expect(checked.analysis.entities).toHaveLength(1);
    expect(review.criticalMentions).toMatchObject([{ mentionKey: sample.mentions[0].mentionKey, status: 'missing', entityId: null }]);
    expect(review.identities).toMatchObject([{ entity: sample.entities[0].entityKey, status: 'not_evaluable' }]);
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

/** Synthetic identity graphs and test-authored judgments; no natural-language classifier or model execution. */
describe('collective subjects and source-grounded identity candidates (authored development)', () => {
  type ReferenceEntity = EntityReviewCase['entities'][number];
  const reference = (entityKey: string, rationale: string, identity: Partial<ReferenceEntity> = {}): ReferenceEntity => ({
    entityKey, rationale, referentKinds: ['object'], identityStatus: 'proposed', possibleEntities: [], component: null, collection: null, ...identity,
  });
  const anchor = (entity: string, messageIndex: number, quote: string, occurrence = 0, mentionKey = entity): EntityReviewCase['mentions'][number] => ({
    mentionKey, entity, messageIndex, alternatives: [{ quote, occurrence }], rationale: '合成来源中的精确锚点；身份由显式参考关系约束。',
  });
  const sample = (caseId: string, messages: string[], entities: ReferenceEntity[], mentions: EntityReviewCase['mentions'], policy: string): EntityReviewCase => ({
    caseId, projectGroup: caseId, conversationGroup: caseId, split: 'development', messages: messages.map(text => ({ role: 'user', text })),
    entities, mentions, roles: [], knowledgePolicy: 'optional', tags: ['identity-grounding'],
    limitations: ['合成开发诊断，无私人来源或模型调用；不进入既有关键集分母，也不证明模型能够理解自然语言。'], semanticChecks: [policy],
  });
  const collectionCases = [
    sample('dev-known-collective-unknown-members', ['请一起审查这批新增测试；成员清单没有列出。'],
      [reference('tests', '本轮共同审查的测试集合已确定，具体成员未列出。',
        { referentKinds: ['collection'], collection: { members: [], completeness: 'unknown' } })],
      [anchor('tests', 0, '这批新增测试')], '共同审查的集合主体确定；成员未知不等于主体身份未消解，不得退回 object/null。'),
    sample('dev-single-suite-artifact', ['海湾测试套件是一个有固定发布编号的单一制品；本条只讨论这个制品，没有逐项讨论内部测试。'],
      [reference('suite', '被单独讨论的一个测试套件制品，不是其内部测试的共同集合。')], [anchor('suite', 0, '海湾测试套件')],
      '保留单一制品对象；名称含测试不构成强制 collection 的依据。'),
    sample('dev-abstract-test-category', ['这里把回归测试作为方法类别讨论，不指任何本轮测试集合或单一实现。'],
      [reference('category', '抽象的方法类别，不指本轮某批测试。')], [anchor('category', 0, '回归测试')],
      '抽象类别可为 object；不能因名称看似复数而制造集合及成员。'),
  ];
  const distinct = sample('dev-same-name-api-implementation', ['同名 QueryBag 标准接口与 QueryBag 自写实现是两个对象；后者实现前者。'],
    [reference('api', '独立命名的标准接口。'), reference('implementation', '来源明确区别于标准接口的自写实现。')],
    [anchor('api', 0, 'QueryBag', 0), anchor('implementation', 0, 'QueryBag', 1)],
    '同名接口和实现按来源明确区分；名称相同不支持合并，也不要求额外发明宿主或入口层。');
  const alias = sample('dev-api-explicit-file-alias', ['Harbor 是 QueryBag 模块的另一个名字；这里明确两者指同一份源文件。'],
    [reference('module', '同一份源文件有两个明确别名，不额外拆出接口和实现。')],
    [anchor('module', 0, 'Harbor', 0, 'first-name'), anchor('module', 0, 'QueryBag 模块', 0, 'second-name')],
    '明确同一对象的别名不应机械拆成接口和实现。');
  const candidateCases = [
    { caseId: 'dev-current-candidate-support', text: '待识别模块可能是 Cedar，尚未确认。', candidates: ['cedar'] },
    { caseId: 'dev-sole-candidate-evidence-withdrawn', text: '先前把待识别模块认成 Cedar 的唯一依据是猜测；现明确撤回，未保留其它对应证据。', candidates: [] },
    { caseId: 'dev-independent-candidate-support-remains', text: '照片猜测已撤回；独立构建标识仍支持待识别模块可能是 Cedar，尚未确认。', candidates: ['cedar'] },
  ].map(value => sample(value.caseId, ['Cedar 是已登记模块。', value.text],
    [reference('cedar', '有明确名称的模块。'), reference('unknown', '所指尚未消解；当前候选仅取仍有效的来源依据。',
      { identityStatus: 'unresolved', possibleEntities: value.candidates })],
    [anchor('cedar', 0, 'Cedar'), anchor('unknown', 1, '待识别模块')],
    '候选边是当前可能同一性的断言：唯一依据撤回则不保留；明确的当前或独立剩余依据可以保留，均不能冒充已确认身份。'));
  const ambiguousCases = [
    sample('dev-module-reference-ambiguous', ['Cedar 是自写实现，Maple 是备选依赖入口；两者并不相同。', '记录只写查询模块，没有说明指向 Cedar 还是 Maple。'],
      [reference('cedar', '自写实现。'), reference('maple', '备选依赖入口。'), reference('unknown', '模块指向尚未说明，两个同层次候选保留。',
        { identityStatus: 'unresolved', possibleEntities: ['cedar', 'maple'] })],
      [anchor('cedar', 0, 'Cedar'), anchor('maple', 0, 'Maple'), anchor('unknown', 1, '查询模块')],
      '精确 module 字符锚点不能证明归属；不按名称接近、上下文邻近或后来副作用自动指定自写实现或替代入口。'),
    sample('dev-conflicting-identity-with-later-record', ['Cedar 和 Maple 是两个不同模块。', '记录甲称查询模块就是 Cedar。', '较晚的记录乙称查询模块就是 Maple；记录互相冲突，没有澄清。'],
      [reference('cedar', '明确命名的一个模块。'), reference('maple', '明确命名的另一个模块。'), reference('unknown', '两条身份记录冲突且未澄清，不能按最新时间消解。',
        { identityStatus: 'unresolved', possibleEntities: ['cedar', 'maple'] })],
      [anchor('cedar', 0, 'Cedar'), anchor('maple', 0, 'Maple'), anchor('unknown', 1, '查询模块', 0, 'earlier'), anchor('unknown', 2, '查询模块', 0, 'later')],
      '冲突记录保留来源和 unresolved 身份；latest 不构成获胜规则。'),
  ];
  const scopedCases = [...collectionCases, distinct, alias, ...candidateCases, ...ambiguousCases];
  const source = { raw: JSON.stringify({ provenance: 'synthetic', cases: scopedCases }), authors: ['identity-grounding-fixture-author'] };
  const inspectImmutable = (sample: EntityReviewCase, output: ReturnType<typeof authored>) => {
    const before = structuredClone(output), result = inspect(sample, output);
    expect(output).toEqual(before);
    expect(result.checked.analysis.rejected).toEqual([]); expect(result.checked.rejected).toEqual([]);
    expect(result.review.criticalMentionRecall.value).toBe(1);
    return result;
  };
  const scopedReview = (sample: EntityReviewCase, output: ReturnType<typeof authored>) => {
    const context = semanticContext(sample, output, source);
    // Judgments below are supplied by the test author; the engine only validates coverage and gate wiring.
    const receipt: SemanticOutputReview = { reviewVersion: 'omk-entity-output-review/v1', planId: context.plan.planId, capturesDigest: context.capturesDigest,
      reviewer: { actorKind: 'agent', actorId: source.authors[0] }, independentHuman: false, reviewedAt: '2020-03-01T00:00:00Z',
      decisions: semanticReviewTargets(context).map(target => ({ target, verdict: target.itemKind === 'semantic_check' ? 'uncertain' : 'correct',
        errorCodes: [], rationale: '测试作者提供的局部判据见证；新身份政策的语义义务尚待明确裁决，结构接纳不替代该判断。' })) };
    return { context, receipt };
  };

  it('preserves the authored graphs and keeps every new policy target uncertain rather than semantically passing', () => {
    expect(baseline.cases).toHaveLength(64);
    expect(baseline.cases.reduce((total, value) => total + value.mentions.length, 0)).toBe(212);
    for (const sample of scopedCases) {
      expect(baseline.cases.some(value => value.caseId === sample.caseId)).toBe(false);
      const output = authored(sample), { checked, review } = inspectImmutable(sample, output);
      expect(checked.analysis.entities).toEqual(output.entities);
      expect(review.identities.every(value => value.status === 'matched')).toBe(true);
      expect(review.identityPairs.every(value => value.status === 'matched')).toBe(true);
      const { context, receipt } = scopedReview(sample, output);
      expect(receipt.decisions.filter(value => value.verdict === 'uncertain').map(value => value.target))
        .toEqual([{ caseId: sample.caseId, repeat: 1, itemKind: 'semantic_check', checkIndex: 0 }]);
      expect(evaluateSemanticReview({ ...context, receipt })).toMatchObject({ status: 'pending', reference: { goldReady: false },
        outputReview: { uncertain: 1, independentHuman: false } });
    }
  });

  it.each(collectionCases)('detects the wrong collective/object graph despite valid shape and exact mentions ($caseId)', sample => {
    const output = authored(sample), entity = output.entities[0];
    if (entity.referentKind === 'collection') { entity.referentKind = 'object'; entity.collection = null; }
    else { entity.referentKind = 'collection'; entity.uncertainties = ['合成错误响应没有列出任何成员'];
      entity.collection = { memberEntityIds: [], completeness: 'unknown', mentionIds: [output.mentions[0].mentionId], rationale: '合成错误响应将单一制品或类别当成集合。' }; }
    const { review } = inspectImmutable(sample, output);
    expect(review.identities[0]).toMatchObject({ status: 'mismatched', problems: ['referent_kind', 'membership'] });
  });

  it.each([distinct, alias])('does not use a shared API name as an automatic merge or split rule ($caseId)', sample => {
    const output = authored(sample);
    if (sample.caseId === distinct.caseId) { output.entities.pop(); output.mentions[1].entityId = 'api'; }
    else { output.entities.push({ ...output.entities[0], entityId: 'separate-implementation' }); output.mentions[1].entityId = 'separate-implementation'; }
    const { review } = inspectImmutable(sample, output);
    expect(review.identityPairs).toMatchObject([{ status: sample.caseId === distinct.caseId ? 'wrong_merge' : 'wrong_split' }]);
  });

  it.each(candidateCases)('checks current candidate edges independently of unresolved status ($caseId)', sample => {
    const output = authored(sample), unresolved = output.entities.find(value => value.entityId === 'unknown')!;
    unresolved.possibleEntityIds = unresolved.possibleEntityIds.length ? [] : ['cedar'];
    const { review } = inspectImmutable(sample, output);
    expect(review.identities.find(value => value.entity === 'unknown')).toMatchObject({ status: 'mismatched', problems: ['candidate_identities'] });
  });

  it.each(ambiguousCases)('detects an unsupported choice of one module, including a later conflicting record ($caseId)', sample => {
    const output = authored(sample);
    output.entities = output.entities.filter(value => value.entityId !== 'unknown');
    output.mentions.filter(value => value.entityId === 'unknown').forEach(value => { value.entityId = 'maple'; });
    const { review } = inspectImmutable(sample, output);
    expect(review.identityPairs.some(value => value.status === 'wrong_merge')).toBe(true);
    expect(review.identities.find(value => value.entity === 'unknown')!.problems).toContain('identity_status');
  });

  it.each(['referent_kind', 'identity'] as const)('routes an explicit %s policy judgment to the existing semantic gate', errorCode => {
    const sample = errorCode === 'referent_kind' ? collectionCases[0] : candidateCases[1];
    const output = authored(sample), entity = output.entities.find(value => value.entityId === (errorCode === 'referent_kind' ? 'tests' : 'unknown'))!;
    if (errorCode === 'referent_kind') { entity.referentKind = 'object'; entity.collection = null; }
    else entity.possibleEntityIds = ['cedar'];
    inspectImmutable(sample, output);
    const { context, receipt } = scopedReview(sample, output);
    const judgment = receipt.decisions.find(value => value.target.itemKind === 'entity' && value.target.entityId === entity.entityId)!;
    judgment.verdict = 'incorrect'; judgment.errorCodes = [errorCode];
    judgment.rationale = '测试作者对该已构造字段错误显式提供裁决；仅验证既有语义门禁接线，不是规则引擎自主理解来源的证据。';
    const report = evaluateSemanticReview({ ...context, receipt });
    expect(report).toMatchObject({ status: 'blocked', reference: { goldReady: false }, outputReview: { confirmedErrors: 1, independentHuman: false } });
    expect(report.blockers).toContain(errorCode === 'identity' ? 'critical_semantic_error' : 'confirmed_error_threshold');
    expect(report.blockers).not.toContain('structural_rejection');
    expect(report.blockers).toContain('critical_regression_failure');
  });
});
