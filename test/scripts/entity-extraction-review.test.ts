import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkWindowExtractionResponse } from '../../src/knowledge/extraction/window-proposals.js';
import { ENTITY_CHECK_VERSION, EntityReviewCorpusSchema, entityReviewInput, parseEntityReviewCorpus, reviewMentions, type EntityReviewCase } from '../../scripts/bench/entity-review-corpus.js';
import { checkEntityReview, reviewCapturedOutput } from '../../scripts/bench/entity-review-checks.js';
import { annotationReadiness, authorReviewStatus, entityReviewHtml, parseEntityReviewArguments, reviewCapture, reviewDigest, reviewReceiptStatus, reviewOutputRoot } from '../../scripts/bench/entity-extraction-review.js';
import { runCli, runCliFailing, PROJECT_ROOT } from '../helpers/cli-process.js';
import { modelWindow } from '../knowledge/fixtures.js';
import { identityDigest, type CaptureRuntime } from '../../scripts/bench/entity-capture-provider.js';
import { WINDOW_EXTRACTION_WIRE_SCHEMA_JSON } from '../../src/knowledge/extraction/model-wire.js';

const corpusText = readFileSync(new URL('../fixtures/entity-extraction-review-v13.json', import.meta.url), 'utf8');
const corpus = parseEntityReviewCorpus(corpusText);
const measurementId = reviewDigest('frozen measurement');
const sample: EntityReviewCase = {
  caseId: 'roles', projectGroup: 'project', conversationGroup: 'conversation', split: 'development',
  messages: [{ role: 'user', text: 'Alpha drives Beta.' }], limitations: ['Selected messages only.'], tags: ['roles'],
  entities: ['alpha', 'beta'].map(entityKey => ({ entityKey, referentKinds: ['object'], identityStatus: 'proposed', possibleEntities: [],
    component: null, collection: null, rationale: 'Distinct objects.' })),
  mentions: ['Alpha', 'Beta'].map(quote => ({ mentionKey: quote.toLowerCase(), entity: quote.toLowerCase(), messageIndex: 0,
    alternatives: [{ quote, occurrence: 0 }], rationale: 'Explicit name.' })),
  roles: [{ roleKey: 'drives', coverage: 'if_selected', subject: 'alpha', object: 'beta', messageIndex: 0,
    anchor: { quote: 'Alpha drives Beta.', occurrence: 0 }, interpretation: 'Alpha drives Beta; equivalent wording allowed.' }],
  knowledgePolicy: 'optional', semanticChecks: ['Verify meaning independently.'],
};
function packet() {
  const output = modelWindow();
  output.mentions.forEach(mention => { mention.selection.evidenceRef = 'roles:0'; });
  output.proposals[0].draft.evidence[0].evidenceRef = 'roles:0';
  output.proposals[0].citations[0].selection = { evidenceRef: 'roles:0', quote: 'Alpha drives Beta.' };
  return output;
}
const check = (response: unknown) => checkWindowExtractionResponse(response, entityReviewInput(sample).excerpts);
function receipt() {
  return { reviewVersion: 'omk-entity-annotation-review/v1', measurementId, reviewer: 'independent-reader', reviewedAt: '2020-01-01T00:00:00Z',
    reviewKind: 'independent-human', reviewedBeforeOutputs: true, independenceAttestation: true,
    decisions: corpus.cases.map(value => ({ caseId: value.caseId, decision: 'approved', rationale: 'Read sources and annotations; agree.' })), disputes: [] };
}

describe('critical source coverage diagnostic v1 (authored responses, no model calls)', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/entity-source-coverage-v1.json', import.meta.url), 'utf8'));
  const sample = EntityReviewCorpusSchema.shape.cases.element.parse(fixture.sample);
  // This targeted fixture is not added to the current 64-window corpus or its mention denominator.
  function authored() {
    const output = modelWindow();
    output.entities[0] = { ...output.entities[0], entityId: 'handler', label: 'Handler', description: '事件处理函数' };
    output.entities[1] = { ...output.entities[1], entityId: 'session', label: 'Session', description: '事件归属概念' };
    output.mentions.forEach((mention, index) => {
      mention.entityId = output.entities[index].entityId;
      mention.selection = { evidenceRef: `${sample.caseId}:0`, quote: output.entities[index].label, occurrence: 0 };
      mention.rationale = '首条消息明确定义对象，后文保持同一含义。';
    });
    const proposal = output.proposals[0];
    proposal.entityIds = output.entities.map(entity => entity.entityId);
    proposal.draft.title = '事件归属复制的目的、范围与待修正约束';
    const meanings = [
      { relation: '复制归属用于固定', modality: 'descriptive', polarity: 'positive', conditions: [], exceptions: [], unknowns: [] },
      { relation: '当前复制范围过大', modality: 'descriptive', polarity: 'positive', conditions: [], exceptions: [], unknowns: ['收窄尚未实施'] },
      { relation: '需要固定归属', modality: 'descriptive', polarity: 'positive', conditions: ['跨异步事件'], exceptions: ['同步路径无需复制'], unknowns: [] },
      { relation: '使迟到错误影响新归属', modality: 'normative', polarity: 'negative', conditions: ['修正后须满足的约束'], exceptions: [], unknowns: ['修正尚未实施'] },
      { relation: '收窄已经实施', modality: 'descriptive', polarity: 'negative', conditions: [], exceptions: [], unknowns: ['设备行为未验证'] },
    ] as const;
    const context = proposal.draft.content.statements[0].context;
    proposal.draft.content.statements = sample.roles.map((role, index) => ({
      statementId: role.roleKey, subject: { entityId: role.subject }, ...(role.object ? { object: { entityId: role.object } } : {}),
      relation: meanings[index].relation, modality: meanings[index].modality, polarity: meanings[index].polarity,
      context: { ...context, scenario: '合成对话中的来源判断与修正计划', conditions: [...meanings[index].conditions],
        exceptions: [...meanings[index].exceptions], unknowns: [...meanings[index].unknowns] },
    }));
    proposal.draft.evidence = sample.roles.map(role => ({ evidenceLinkId: role.roleKey, evidenceRef: `${sample.caseId}:${role.messageIndex}`,
      statementIds: [role.roleKey], relation: 'supports', basis: 'source_assertion', interpretation: role.interpretation }));
    proposal.citations = sample.roles.map(role => ({ evidenceLinkId: role.roleKey,
      selection: { evidenceRef: `${sample.caseId}:${role.messageIndex}`, ...role.anchor } }));
    return output;
  }
  function inspect(output: ReturnType<typeof authored>) {
    const checked = checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
    expect(checked.rejected).toEqual([]);
    expect(checked.analysis.rejected).toEqual([]);
    return { checked, review: checkEntityReview(sample, checked) };
  }
  it('locates distinct purposes, limits, conditions, constraints and corrections without requiring every repeated name', () => {
    expect(fixture).toMatchObject({ reviewVersion: 'omk-entity-source-coverage/v1', provenance: 'synthetic' });
    const output = authored(); const before = structuredClone(output);
    const { checked, review } = inspect(output);
    expect(review.roles.map(role => role.endpointStatus)).toEqual(Array(5).fill('endpoints_matched'));
    expect(review.criticalMentionRecall).toMatchObject({ matched: 2, total: 2 });
    expect(checked.analysis.mentions).toHaveLength(2);
    expect(checked.accepted[0].citations).toHaveLength(5);
    expect(review.semanticReview).toBe('pending');
    expect(output).toEqual(before);
  });
  it('does not treat an entity name or access to the same complete message as a located key source', () => {
    const output = authored();
    const citation = output.proposals[0].citations[1];
    citation.selection = { evidenceRef: `${sample.caseId}:1`, quote: 'Session', occurrence: 0 };
    const { review } = inspect(output);
    expect(review.criticalMentionRecall).toMatchObject({ matched: 2, total: 2 });
    expect(review.roles[1]).toMatchObject({ roleKey: 'current-limit', endpointStatus: 'not_observed', observed: [] });
    expect(review.knowledgeCoverage[1].status).toBe('needs_review');
  });
  it('exposes a misplaced citation even when another statement has the same endpoints', () => {
    const output = authored();
    // All statements still have structurally valid evidence, and all five quotes still exist.
    output.proposals[0].draft.evidence[3].statementIds = ['purpose'];
    output.proposals[0].draft.evidence[0].statementIds.push('late-constraint');
    const { review } = inspect(output);
    expect(review.roles[3]).toMatchObject({ roleKey: 'late-constraint', endpointStatus: 'endpoints_matched' });
    expect(review.roles[3].observed.map(value => value.statementId)).toEqual(['purpose']);
    expect(review.roles[3].observed.some(value => value.statementId === 'late-constraint')).toBe(false);
    expect(review.semanticReview).toBe('pending');
  });
  it('keeps exact citations separate from semantic truth and permits structurally empty knowledge', () => {
    const output = authored();
    output.proposals[0].draft.content.statements[4].polarity = 'positive'; // Contradicts the correction.
    const { review } = inspect(output);
    expect(review.roles[4]).toMatchObject({ endpointStatus: 'endpoints_matched', semanticReview: 'pending' });
    output.proposals = [];
    const empty = inspect(output);
    expect(empty.review.criticalMentionRecall).toMatchObject({ matched: 2, total: 2 });
    expect(empty.review.knowledgeCoverage.every(role => role.status === 'required_not_observed')).toBe(true);
  });
});

describe('prefrozen work-record boundary (authored responses, no model calls)', () => {
  function selected(caseId: string) { return corpus.cases.find(value => value.caseId === caseId)!; }
  function authored(value: EntityReviewCase) {
    const output = modelWindow(); output.proposals = [];
    output.entities = value.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
      label: value.mentions.find(mention => mention.entity === entity.entityKey)!.alternatives[0].quote,
      description: entity.rationale, referentKind: entity.referentKinds[0] }));
    output.mentions = value.mentions.map(mention => ({ mentionId: mention.mentionKey, entityId: mention.entity,
      basis: 'explicit', rationale: mention.rationale,
      selection: { evidenceRef: `${value.caseId}:${mention.messageIndex}`, ...mention.alternatives[0] } }));
    return output;
  }
  function inspect(value: EntityReviewCase, output: ReturnType<typeof modelWindow>) {
    const checked = checkWindowExtractionResponse(output, entityReviewInput(value).excerpts);
    expect(checked.analysis.rejected).toEqual([]); expect(checked.rejected).toEqual([]);
    return { checked, review: checkEntityReview(value, checked) };
  }
  function addExtra(value: EntityReviewCase, output: ReturnType<typeof modelWindow>, quote: string, messageIndex = 0) {
    const entityId = `extra-${output.entities.length}`; const mentionId = `mention-${entityId}`;
    output.entities.push({ ...output.entities[0], entityId, label: quote, description: 'Authored counterexample awaiting semantic review.' });
    output.mentions.push({ mentionId, entityId, basis: 'explicit', rationale: 'Authored record-boundary counterexample.',
      selection: { evidenceRef: `${value.caseId}:${messageIndex}`, quote, occurrence: 0 } });
    return mentionId;
  }

  it('keeps v12 historical bytes and annotations while giving v13 a distinct guide identity', () => {
    const historicalBytes = readFileSync(new URL('../fixtures/entity-extraction-review-v12.json', import.meta.url));
    expect(createHash('sha256').update(historicalBytes).digest('hex')).toBe('7ad03efda303cd55300c11d04f3029a59f59df0ef569a51dfaf4570096c230af');
    const historical = JSON.parse(historicalBytes.toString('utf8'));
    expect(historical).toMatchObject({ corpusVersion: 'omk-entity-quality/v12', guideVersion: 'omk-entity-annotation/v10' });
    expect(corpus).toMatchObject({ corpusVersion: 'omk-entity-quality/v13', guideVersion: 'omk-entity-annotation/v11' });
    expect(corpus.cases.slice(0, historical.cases.length)).toEqual(historical.cases);
    expect(corpus.cases.slice(historical.cases.length).every(value => value.split === 'development')).toBe(true);
    expect(() => parseEntityReviewCorpus(historicalBytes.toString('utf8'))).toThrow();
  });

  it('retains independently discussed Issue/PR concepts and sends concrete record entities to semantic review', () => {
    const value = selected('dev-work-record-concepts'); const output = authored(value);
    const good = inspect(value, output).review;
    expect(good.criticalMentionRecall).toMatchObject({ matched: 4, total: 4 });
    expect(good.identities.every(identity => identity.status === 'matched')).toBe(true);
    output.entities = output.entities.filter(entity => entity.entityId === 'budget');
    output.mentions = output.mentions.filter(mention => mention.entityId === 'budget');
    expect(inspect(value, output).review.criticalMentions.filter(mention => mention.status === 'missing').map(mention => mention.mentionKey))
      .toEqual(['issue-concept', 'pr-concept']);
    const withRecords = authored(value);
    const extras = ['Issue #314', 'PR #315'].map(quote => addExtra(value, withRecords, quote, 1));
    const review = inspect(value, withRecords).review;
    expect(review.unmatchedMentionsNeedReview).toEqual(extras);
    expect(review.semanticReview).toBe('pending'); expect(review.precision).toBeNull();
  });

  it.each([
    ['concrete records', ['Issue #416', 'PR #417']], ['stripped prefixes', ['Issue', 'PR']],
  ] as const)('does not silently approve %s where only numbered work records were discussed', (_name, quotes) => {
    const value = selected('dev-numbered-records-no-concept'); const output = authored(value);
    const extras = quotes.map(quote => addExtra(value, output, quote));
    const review = inspect(value, output).review;
    expect(review.criticalMentionRecall).toMatchObject({ matched: 2, total: 2 });
    expect(review.unmatchedMentionsNeedReview).toEqual(extras);
    // Critical recall is not a precision pass; the predeclared exclusion remains a semantic review obligation.
    expect(review.semanticReview).toBe('pending'); expect(review.precision).toBeNull(); expect(review.f1).toBeNull();
  });

  it('preserves work-record identifiers and links in context and citations without dangling record endpoints', () => {
    const value = selected('dev-work-record-title-context'); const output = authored(value);
    const proposal = modelWindow().proposals[0]; const statement = proposal.draft.content.statements[0];
    proposal.entityIds = output.entities.map(entity => entity.entityId);
    proposal.mentionIds = output.mentions.map(mention => mention.mentionId);
    proposal.draft.content.statements = [{ ...statement, subject: { entityId: 'validator' }, object: { entityId: 'ledger' },
      relation: '校验', context: { ...statement.context, scenario: value.messages[0].text,
        conditions: [], exceptions: [], unknowns: ['没有本轮工具验收记录。'] } }];
    proposal.draft.evidence = [{ ...proposal.draft.evidence[0], evidenceRef: `${value.caseId}:0`,
      relation: 'supports', basis: 'source_assertion', interpretation: value.roles[0].interpretation }];
    proposal.citations = [{ ...proposal.citations[0], selection: { evidenceRef: `${value.caseId}:0`, quote: value.messages[0].text } }];
    output.proposals = [proposal];
    const { checked, review } = inspect(value, output);
    expect(checked.accepted).toHaveLength(1);
    expect(checked.accepted[0].draft.content.statements[0].context.scenario).toBe(value.messages[0].text);
    expect(checked.accepted[0].citations[0].selection.quote).toBe(value.messages[0].text);
    expect(checked.accepted[0].draft.entities.map(entity => entity.entityId)).toEqual(['ledger', 'validator']);
    expect(review.roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched', semanticReview: 'pending' });
    const extra = addExtra(value, output, '知识架构整理');
    expect(inspect(value, output).review.unmatchedMentionsNeedReview).toEqual([extra]);
    // Even a structurally valid sentence that drops context still needs semantic review, not a keyword verdict.
    proposal.draft.content.statements[0].context.scenario = '函数校验文件';
    expect(inspect(value, output).review.knowledgeCoverage[0]).toMatchObject({ status: 'needs_review', semanticReview: 'pending' });
    proposal.draft.content.statements[0].subject.entityId = 'excluded-work-record';
    const dangling = checkWindowExtractionResponse(output, entityReviewInput(value).excerpts);
    expect(dangling.accepted).toEqual([]);
    expect(dangling.rejected[0].reasons).toContain('unknown_entity:content.statements.0.subject');
  });

  it('keeps ordinary concrete devices and their identities while work records stay contextual', () => {
    const value = selected('dev-work-record-normal-instances'); const output = authored(value);
    const good = inspect(value, output).review;
    expect(good.criticalMentionRecall).toMatchObject({ matched: 3, total: 3 });
    expect(good.identities.every(identity => identity.status === 'matched')).toBe(true);
    expect(output.entities.map(entity => entity.referentKind)).toEqual(['instance', 'instance', 'instance']);
    output.entities = output.entities.filter(entity => entity.entityId !== 'router-two');
    output.mentions = output.mentions.filter(mention => mention.entityId !== 'router-two');
    expect(inspect(value, output).review.criticalMentions.find(mention => mention.mentionKey === 'router-two')!.status).toBe('missing');
  });
});

describe('entity extraction review with author evidence', () => {
  it('accepts current prefrozen boundaries and leaves property or claim spans as review candidates', () => {
    const admission = (sample: EntityReviewCase, mentionKey: string, selection: { quote: string; occurrence: number }) => {
      const mention = sample.mentions.find(value => value.mentionKey === mentionKey)!;
      const output = modelWindow(); output.proposals = [];
      output.entities = [{ ...output.entities[0], entityId: mention.entity, label: mention.entity }];
      output.mentions = [{ mentionId: 'boundary', entityId: mention.entity, basis: 'explicit', rationale: 'Authored source-boundary probe.',
        selection: { evidenceRef: `${sample.caseId}:${mention.messageIndex}`, ...selection } }];
      const checked = checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
      expect(checked.analysis.rejected).toEqual([]);
      return checkEntityReview(sample, checked).criticalMentions.find(value => value.mentionKey === mentionKey)!;
    };
    for (const sample of corpus.cases) for (const mention of sample.mentions) for (const alternative of mention.alternatives) {
      expect(admission(sample, mention.mentionKey, alternative).status).toBe('matched');
    }
    const state = corpus.cases.find(value => value.caseId === 'held-code-state-without-sha')!;
    expect(admission(state, 'state-unreleased', { quote: 'main 上的改造', occurrence: 0 }).status).toBe('missing');
    const field = corpus.cases.find(value => value.caseId === 'held-config-literal-types')!;
    expect(admission(field, 'field', { quote: 'enabled 字段在测试环境为布尔值 false', occurrence: 0 }).status).toBe('missing');
  });

  it('validates the current synthetic corpus and prevents group/window leakage and contradictory annotations', () => {
    expect(corpus.cases.filter(value => value.split === 'development')).toHaveLength(62);
    expect(corpus.cases.filter(value => value.split === 'validation')).toHaveLength(2);
    expect(corpus.cases.reduce((count, value) => count + value.mentions.length, 0)).toBe(212);
    for (const mutate of [
      (copy: typeof corpus) => { copy.cases[52].projectGroup = copy.cases[0].projectGroup; },
      (copy: typeof corpus) => { copy.cases[52].conversationGroup = copy.cases[0].conversationGroup; },
      (copy: typeof corpus) => { copy.cases[52].messages = copy.cases[0].messages; },
      (copy: typeof corpus) => { copy.cases[0].mentions[0].alternatives[0].occurrence = 99; },
      (copy: typeof corpus) => { copy.cases[0].entities[0].component = 'file'; },
      (copy: typeof corpus) => { copy.cases[3].entities[2].collection!.members.push('pair'); },
    ]) {
      const copy = structuredClone(corpus); mutate(copy);
      expect(() => parseEntityReviewCorpus(JSON.stringify(copy))).toThrow();
    }
    const repeated = corpus.cases.find(value => value.caseId === 'dev-repeated-code')!;
    expect(reviewMentions(repeated).map(value => value.spans[0].start)).toEqual([4, 18, 29]);
    const input = entityReviewInput(repeated);
    expect(Object.keys(input)).toEqual(['excerpts', 'limitations']);
    expect(input.excerpts[0].text).toBe(repeated.messages[0].text);
    for (const field of ['referentKinds', 'semanticChecks', 'projectGroup', 'split', 'alternatives', 'coverage', 'interpretation']) expect(JSON.stringify(input)).not.toContain(field);
    for (const mutation of [
      { corpusVersion: 'omk-entity-quality/v12' },
      { guideVersion: 'omk-entity-annotation/v10' },
    ]) {
      expect(() => parseEntityReviewCorpus(JSON.stringify({ ...corpus, ...mutation }))).toThrow();
    }
    const rule = corpus.cases.find(value => value.caseId === 'fresh-negative-requirement')!;
    expect(rule.mentions.find(value => value.mentionKey === 'rule-first')!.alternatives).toEqual([
      { quote: 'F9', occurrence: 0 }, { quote: 'Rule F9', occurrence: 0 },
    ]);
    const replaced = reviewMentions(corpus.cases.find(value => value.caseId === 'dev-replacement')!);
    expect(replaced.slice(0, 2).map(value => value.spans[0].quote)).toEqual(['config.json', 'config.json']);
    expect(replaced[0].entity).not.toBe(replaced[1].entity);
    expect(replaced[0].spans[0].start).not.toBe(replaced[1].spans[0].start);
  });

  it.each(['dev-property-values', 'held-unnamed-metric-concepts'])('checks the prefrozen %s identity boundary without demanding property entities or collapsing independent concepts', caseId => {
    const sample = corpus.cases.find(value => value.caseId === caseId)!;
    const output = modelWindow();
    output.proposals = [];
    output.entities = sample.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
      label: entity.entityKey, description: entity.rationale }));
    output.mentions = sample.mentions.map(mention => ({ mentionId: mention.mentionKey, entityId: mention.entity,
      basis: 'explicit', rationale: mention.rationale,
      selection: { evidenceRef: `${sample.caseId}:${mention.messageIndex}`, ...mention.alternatives[0] } }));
    const admit = () => checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
    expect(admit().analysis.rejected).toEqual([]);
    const checked = checkEntityReview(sample, admit());
    expect(checked.criticalMentionRecall).toEqual({ matched: sample.mentions.length, total: sample.mentions.length, value: 1 });
    expect(checked.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
    // This exercises the offline checker with a fabricated response, not model capability or knowledge coverage.
    if (caseId === 'held-unnamed-metric-concepts') {
      output.entities = output.entities.slice(0, 1);
      output.mentions.forEach(mention => { mention.entityId = output.entities[0].entityId; });
      expect(checkEntityReview(sample, admit()).identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
    }
  });

  it('requires exact allowed boundaries and separates false merges, false splits and missing mentions', () => {
    const output = packet(); output.proposals = [];
    const good = checkEntityReview(sample, check(output));
    expect(good.criticalMentionRecall).toEqual({ matched: 2, total: 2, value: 1 });
    expect(good.precision).toBeNull(); expect(good.f1).toBeNull();
    output.mentions[0].selection.quote = 'Alpha drives';
    const broad = checkEntityReview(sample, check(output));
    expect(broad.criticalMentions[0]).toMatchObject({ status: 'missing', boundaryCandidates: ['m1'] });
    expect(broad.identityPairs[0].status).toBe('not_evaluable');
    output.mentions[0].selection.quote = 'Alpha'; output.entities = output.entities.slice(0, 1); output.mentions[1].entityId = 'project';
    expect(checkEntityReview(sample, check(output)).identityPairs[0].status).toBe('wrong_merge');
    const alias = structuredClone(sample); alias.messages[0].text = 'Alpha Alpha'; alias.entities = [alias.entities[0]];
    alias.mentions[1] = { ...alias.mentions[0], mentionKey: 'alias', alternatives: [{ quote: 'Alpha', occurrence: 1 }] }; alias.roles = [];
    const split = packet(); split.proposals = []; split.mentions[0].selection.occurrence = 0;
    split.mentions[1].selection = { evidenceRef: 'roles:0', quote: 'Alpha', occurrence: 1 };
    expect(checkEntityReview(alias, checkWindowExtractionResponse(split, entityReviewInput(alias).excerpts)).identityPairs[0].status).toBe('wrong_split');
  });

  it('keeps required knowledge separate from entity coverage, optional absence and semantic completeness', () => {
    const selected = corpus.cases.find(value => value.caseId === 'dev-config-rationale')!;
    const output = modelWindow();
    const base = output.proposals[0];
    output.entities = selected.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
      label: entity.entityKey, description: entity.rationale }));
    output.mentions = selected.mentions.map(mention => ({ ...output.mentions[0], mentionId: mention.mentionKey,
      entityId: mention.entity, selection: { evidenceRef: `${selected.caseId}:0`, ...mention.alternatives[0] } }));
    base.entityIds = output.entities.map(entity => entity.entityId);
    base.mentionIds = output.mentions.map(mention => mention.mentionId);
    base.draft.content.statements = [{ ...base.draft.content.statements[0], subject: { entityId: 'field' },
      object: undefined, relation: '配置合理' }];
    base.draft.evidence[0].evidenceRef = `${selected.caseId}:0`;
    base.draft.evidence[0].basis = 'source_assertion';
    base.citations[0].selection = { evidenceRef: `${selected.caseId}:0`, quote: selected.messages[0].text };
    const review = () => checkEntityReview(selected, checkWindowExtractionResponse(output, entityReviewInput(selected).excerpts));
    expect(review().checkVersion).toBe(ENTITY_CHECK_VERSION);
    expect(ENTITY_CHECK_VERSION).toBe('omk-entity-critical-checks/v5');
    expect(review().criticalMentionRecall.value).toBe(1);
    expect(review().roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched', semanticReview: 'pending' });
    // An endpoint match with a lossy sentence still requires semantic review; there is no literal-keyword pass.
    expect(review().knowledgeCoverage[0]).toMatchObject({ coverage: 'required', status: 'needs_review', semanticReview: 'pending',
      interpretation: selected.roles[0].interpretation, candidates: [{ proposalId: base.proposalId, statementId: 'usage' }] });
    base.draft.content.statements[0].subject.entityId = 'client';
    expect(review().knowledgeCoverage[0].status).toBe('needs_review');
    // An existing owner subject is reviewable even when the field-subject endpoint projection differs.
    expect(review().knowledgeCoverage[0].candidates).toHaveLength(1);
    base.entityIds = ['absent'];
    expect(review().knowledgeCoverage[0].status).toBe('not_evaluable');
    output.proposals = [];
    expect(review().criticalMentionRecall.value).toBe(1);
    expect(review().knowledgeCoverage[0]).toMatchObject({ status: 'required_not_observed', candidates: [], semanticReview: 'pending' });
    const optional = { ...selected, roles: selected.roles.map(role => ({ ...role, coverage: 'if_selected' as const })) };
    expect(checkEntityReview(optional, checkWindowExtractionResponse(output, entityReviewInput(optional).excerpts))
      .knowledgeCoverage[0].status).toBe('not_observed');
    const conflicting = structuredClone(corpus);
    conflicting.cases.find(value => value.caseId === selected.caseId)!.knowledgePolicy = 'none';
    expect(() => parseEntityReviewCorpus(JSON.stringify(conflicting))).toThrow('Required knowledge contradicts none policy');
    const unmarked = structuredClone(corpus);
    Reflect.deleteProperty(unmarked.cases.find(value => value.caseId === selected.caseId)!.roles[0], 'coverage');
    expect(() => parseEntityReviewCorpus(JSON.stringify(unmarked))).toThrow();
    expect(entityReviewHtml(corpus, measurementId)).toContain('coverage 为 required');
  });

  it('allows prefrozen tested-state levels while keeping distinct commits apart and unknown SHAs out of resolution', () => {
    for (const caseId of ['dev-branch-commits', 'held-code-state-without-sha']) {
      const selected = corpus.cases.find(value => value.caseId === caseId)!;
      const output = modelWindow(); output.proposals = [];
      output.entities = selected.entities.map(entity => ({ ...output.entities[0], entityId: entity.entityKey,
        label: entity.entityKey, description: entity.rationale, referentKind: entity.referentKinds[0] }));
      output.mentions = selected.mentions.map(mention => ({ ...output.mentions[0], mentionId: mention.mentionKey,
        entityId: mention.entity, selection: { evidenceRef: `${selected.caseId}:0`, ...mention.alternatives[0] } }));
      const review = () => checkEntityReview(selected, checkWindowExtractionResponse(output, entityReviewInput(selected).excerpts));
      expect(review().identities.every(identity => identity.status === 'matched')).toBe(true);
      if (caseId === 'held-code-state-without-sha') {
        output.entities[0].referentKind = 'version';
        expect(review().identities.every(identity => identity.status === 'matched')).toBe(true);
        output.entities[0].identityStatus = 'unresolved'; output.entities[0].uncertainties = ['未提供 SHA'];
        expect(review().identities[0].problems).toContain('identity_status');
      } else {
        output.mentions[3].entityId = 'a1';
        expect(review().identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
      }
    }
  });

  it('detects omitted concepts and premature disambiguation without rejecting valid nested spans or explicit clarification', () => {
    for (const caseId of ['dev-session-properties', 'dev-unconfirmed-memory', 'dev-confirmed-memory']) {
      const sample = corpus.cases.find(value => value.caseId === caseId)!;
      const output = modelWindow(); output.proposals = [];
      output.entities = sample.entities.map(value => ({ ...output.entities[0], entityId: value.entityKey,
        label: value.entityKey, description: value.rationale, identityStatus: value.identityStatus,
        possibleEntityIds: value.possibleEntities, uncertainties: value.identityStatus === 'unresolved' ? [value.rationale] : [] }));
      output.mentions = sample.mentions.map(value => ({ ...output.mentions[0], mentionId: value.mentionKey, entityId: value.entity,
        selection: { evidenceRef: `${caseId}:${value.messageIndex}`, ...value.alternatives[0] } }));
      const excerpts = entityReviewInput(sample).excerpts;
      const admitted = checkWindowExtractionResponse(output, excerpts);
      expect(admitted.analysis.rejected).toEqual([]);
      const good = checkEntityReview(sample, admitted);
      expect(good.criticalMentions.every(value => value.status === 'matched')).toBe(true);
      expect(good.identities.every(value => value.status === 'matched')).toBe(true);
      if (caseId === 'dev-session-properties') {
        output.entities = output.entities.filter(entity => entity.entityId !== 'session');
        output.mentions = output.mentions.filter(mention => mention.entityId !== 'session');
        const missing = checkEntityReview(sample, checkWindowExtractionResponse(output, excerpts));
        expect(missing.criticalMentions.filter(value => value.status === 'missing')).toHaveLength(4);
        expect(missing.criticalMentions.filter(value => value.status === 'matched').map(value => value.mentionKey)).toEqual(['adaptation']);
      } else if (caseId === 'dev-unconfirmed-memory') {
        output.entities = output.entities.filter(entity => entity.entityId !== 'unknown');
        output.mentions[0].entityId = 'atlas';
        output.mentions[0].rationale = 'Assistant chose Atlas, but user did not confirm.';
        const guessed = checkEntityReview(sample, checkWindowExtractionResponse(output, excerpts));
        expect(guessed.criticalMentions.every(value => value.status === 'matched')).toBe(true);
        expect(guessed.identityPairs.some(value => value.status === 'wrong_merge')).toBe(true);
        expect(guessed.identities.find(value => value.entity === 'unknown')!.problems).toContain('identity_status');
      }
    }
  });

  it('keeps polarity review separate from structural admission for the atomic-statement regression', () => {
    const sample = corpus.cases.find(value => value.caseId === 'dev-session-atomic-negation')!;
    const output = modelWindow();
    output.entities = [{ ...output.entities[0], entityId: 'session', label: 'Session', description: sample.entities[0].rationale }];
    output.mentions = sample.mentions.map(value => ({ ...output.mentions[0], mentionId: value.mentionKey, entityId: 'session',
      selection: { evidenceRef: `${sample.caseId}:0`, ...value.alternatives[0] } }));
    const proposal = output.proposals[0];
    proposal.entityIds = ['session']; proposal.mentionIds = output.mentions.map(value => value.mentionId);
    const base = proposal.draft.content.statements[0];
    proposal.draft.content.statements = [
      { ...base, statementId: 'count', subject: { entityId: 'session' }, object: undefined, relation: '总数按初始化记录计算', modality: 'normative', polarity: 'positive' },
      { ...base, statementId: 'update', subject: { entityId: 'session' }, object: undefined, relation: '状态更新增加分母', modality: 'normative', polarity: 'negative' },
    ];
    proposal.draft.evidence = sample.roles.map((role, index) => ({ ...proposal.draft.evidence[0], evidenceLinkId: role.roleKey,
      evidenceRef: `${sample.caseId}:0`, statementIds: [proposal.draft.content.statements[index].statementId] }));
    proposal.citations = sample.roles.map(role => ({ evidenceLinkId: role.roleKey,
      selection: { evidenceRef: `${sample.caseId}:0`, ...role.anchor } }));
    const checked = checkEntityReview(sample, checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts));
    expect(checked.roles.map(role => role.observed.map(statement => ({ relation: statement.relation, polarity: statement.polarity, modality: statement.modality })))).toEqual([
      [{ relation: '总数按初始化记录计算', polarity: 'positive', modality: 'normative' }],
      [{ relation: '状态更新增加分母', polarity: 'negative', modality: 'normative' }],
    ]);
    expect(checked.roles.every(role => role.semanticReview === 'pending')).toBe(true);
    expect(checked.semanticReview).toBe('pending');
  });

  it.each([
    { caseId: 'dev-necessity-versus-prohibition', action: '修改', predicates: ['需要修改', '修改', '修改'],
      modalities: ['descriptive', 'normative', 'normative'], polarities: ['negative', 'negative', 'positive'] },
    { caseId: 'dev-absence-versus-permission', action: '修改', predicates: ['修改受到禁止', '修改', '修改'],
      modalities: ['descriptive', 'permission', 'permission'], polarities: ['negative', 'positive', 'negative'] },
    { caseId: 'dev-reported-modal-scope', action: 'restart', predicates: ['needs to restart', 'restart'],
      modalities: ['descriptive', 'normative'], polarities: ['negative', 'negative'] },
    { caseId: 'dev-conditional-necessity', action: '执行迁移', predicates: ['需要执行迁移', '执行迁移'],
      modalities: ['descriptive', 'normative'], polarities: ['negative', 'positive'] },
    { caseId: 'held-material-modal-scope', action: '更换', predicates: ['需要更换', '更换为未认证的配方'],
      modalities: ['descriptive', 'normative'], polarities: ['negative', 'negative'] },
    { caseId: 'held-repair-permission-scope', action: '拆开', predicates: ['拆开受到禁止', '拆开'],
      modalities: ['descriptive', 'permission'], polarities: ['negative', 'positive'] },
  ] as const)('exposes modal scope and its corrupted alternative for $caseId without pretending to judge semantics', expected => {
    const sample = corpus.cases.find(value => value.caseId === expected.caseId)!;
    const output = modelWindow();
    output.entities = [{ ...output.entities[0], entityId: 'target', label: sample.mentions[0].alternatives[0].quote }];
    output.mentions = sample.mentions.map(value => ({ ...output.mentions[0], mentionId: value.mentionKey, entityId: 'target',
      selection: { evidenceRef: `${sample.caseId}:${value.messageIndex}`, ...value.alternatives[0] } }));
    const proposal = output.proposals[0];
    proposal.entityIds = ['target']; proposal.mentionIds = output.mentions.map(value => value.mentionId);
    const base = proposal.draft.content.statements[0];
    proposal.draft.content.statements = sample.roles.map((role, index) => ({ ...base, statementId: role.roleKey,
      subject: { entityId: 'target' }, object: undefined, relation: expected.predicates[index],
      modality: expected.modalities[index], polarity: expected.polarities[index],
      context: { ...base.context, scenario: sample.messages[role.messageIndex].text } }));
    proposal.draft.evidence = sample.roles.map(role => ({ ...proposal.draft.evidence[0], evidenceLinkId: role.roleKey,
      evidenceRef: `${sample.caseId}:${role.messageIndex}`, statementIds: [role.roleKey], basis: 'source_assertion' }));
    proposal.citations = sample.roles.map(role => ({ evidenceLinkId: role.roleKey,
      selection: { evidenceRef: `${sample.caseId}:${role.messageIndex}`, ...role.anchor } }));
    const review = () => {
      const admitted = checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
      expect(admitted.rejected).toEqual([]); expect(admitted.analysis.rejected).toEqual([]);
      if (output.proposals.length) {
        expect(admitted.accepted[0].draft.content.statements[0].context).toEqual(proposal.draft.content.statements[0].context);
        expect(admitted.accepted[0].draft.evidence.every(link => link.basis === 'source_assertion')).toBe(true);
      }
      return checkEntityReview(sample, admitted);
    };
    const checked = review();
    expect(checked.roles.map(role => role.observed.map(statement => ({ relation: statement.relation,
      modality: statement.modality, polarity: statement.polarity })))).toEqual(expected.predicates.map((relation, index) => [
      { relation, modality: expected.modalities[index], polarity: expected.polarities[index] },
    ]));
    expect(checked.roles.every(role => role.semanticReview === 'pending')).toBe(true);
    // Fabricated responses exercise the review path, never the model's extraction quality.
    // A context quoting “no need” cannot repair this stronger, structurally valid prohibition.
    proposal.draft.content.statements[0].relation = expected.action;
    proposal.draft.content.statements[0].modality = 'normative';
    const corrupted = review();
    expect(corrupted.roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched', semanticReview: 'pending',
      observed: [{ relation: expected.action, modality: 'normative', polarity: 'negative' }] });
    expect(entityReviewHtml(corpus, measurementId)).toContain(sample.roles[0].interpretation);
    output.proposals = [];
    expect(review().roles.every(role => role.endpointStatus === 'not_observed' && role.semanticReview === 'pending')).toBe(true);
  });

  it('admits ordinary objects and concepts while detecting same-level homonym merges and alias splits', () => {
    for (const caseId of ['dev-apple-senses', 'held-policy-terms', 'held-material-object', 'held-database-alias', 'held-empty-knowledge']) {
      const sample = corpus.cases.find(value => value.caseId === caseId)!;
      const output = modelWindow(); output.proposals = [];
      output.entities = sample.entities.map(value => ({ ...output.entities[0], entityId: value.entityKey,
        label: value.entityKey, description: value.rationale, referentKind: 'object', componentRef: null, collection: null }));
      output.mentions = sample.mentions.map(value => ({ ...output.mentions[0], mentionId: value.mentionKey, entityId: value.entity,
        selection: { evidenceRef: `${caseId}:${value.messageIndex}`, ...value.alternatives[0] } }));
      const admit = () => checkWindowExtractionResponse(output, entityReviewInput(sample).excerpts);
      expect(admit().analysis.rejected).toEqual([]);
      const result = checkEntityReview(sample, admit());
      expect(result.criticalMentionRecall.value).toBe(1);
      expect(result.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
      if (sample.entities.length > 1) {
        output.mentions[1].entityId = output.entities[0].entityId;
        expect(checkEntityReview(sample, admit()).identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
      } else {
        output.entities.push({ ...output.entities[0], entityId: 'duplicate' });
        output.mentions[1].entityId = 'duplicate';
        expect(checkEntityReview(sample, admit()).identityPairs.some(pair => pair.status === 'wrong_split')).toBe(true);
      }
    }
  });

  it('uses cited endpoints across synonyms, preserves optional omission and leaves direction conflicts for semantic review', () => {
    const output = packet(); output.proposals[0].draft.content.statements[0].relation = 'employs as a dependency';
    expect(checkEntityReview(sample, check(output)).roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched',
      observed: [{ relation: 'employs as a dependency', modality: 'descriptive', polarity: 'positive' }], semanticReview: 'pending' });
    output.proposals[0].draft.content.statements[0].relation = 'does not employ';
    output.proposals[0].draft.content.statements[0].modality = 'normative';
    output.proposals[0].draft.content.statements[0].polarity = 'negative';
    // Even a potentially double-negated relation remains visible for review; no lexical semantic classifier.
    expect(checkEntityReview(sample, check(output)).roles[0]).toMatchObject({ endpointStatus: 'endpoints_matched',
      observed: [{ relation: 'does not employ', modality: 'normative', polarity: 'negative' }], semanticReview: 'pending' });
    output.proposals[0].draft.content.statements[0].subject.entityId = 'tool';
    output.proposals[0].draft.content.statements[0].object!.entityId = 'project';
    const swapped = checkEntityReview(sample, check(output));
    expect(swapped.roles[0]).toMatchObject({ endpointStatus: 'direction_conflict_needs_review', semanticReview: 'pending' });
    output.proposals = [];
    expect(checkEntityReview(sample, check(output)).roles[0].endpointStatus).toBe('not_observed');
    expect(checkEntityReview(sample, check(output)).unexpectedKnowledge).toBe(false);
    const otherAnchor = structuredClone(sample); otherAnchor.messages.push({ role: 'user', text: 'Unrelated later observation.' });
    otherAnchor.roles[0] = { ...otherAnchor.roles[0], messageIndex: 1, anchor: { quote: 'Unrelated later observation.', occurrence: 0 } };
    expect(checkEntityReview(otherAnchor, check(packet())).roles[0].endpointStatus).toBe('not_observed');
  });

  it('accepts prefrozen backticked instance boundaries without losing component links', () => {
    const instances = corpus.cases.find(value => value.caseId === 'dev-instances')!;
    const raw = modelWindow(); raw.proposals = [];
    raw.entities = ['component', 'test', 'prod'].map((entityId, index) => ({ ...raw.entities[0], entityId, label: entityId,
      referentKind: index === 0 ? 'component' : 'instance',
      componentRef: index === 0 ? null : { entityId: 'component', mentionIds: [entityId], rationale: 'Explicit instance of Sieve.' } }));
    raw.mentions = ['Sieve', '`sieve/dev01`', '`sieve/prod01`'].map((quote, index) => ({ ...raw.mentions[0],
      mentionId: raw.entities[index].entityId, entityId: raw.entities[index].entityId, selection: { evidenceRef: 'dev-instances:0', quote } }));
    const admitted = checkWindowExtractionResponse(raw, entityReviewInput(instances).excerpts);
    expect(admitted.analysis.rejected).toEqual([]);
    const result = checkEntityReview(instances, admitted);
    expect(result.criticalMentionRecall).toEqual({ matched: 3, total: 3, value: 1 });
    expect(result.identities.every(value => value.status === 'matched')).toBe(true);
  });

  it.each(['fresh-type-evidence', 'fresh-shared-property'])('reports unsupported types and shared-reference misattribution in %s', caseId => {
    const value = corpus.cases.find(entry => entry.caseId === caseId)!;
    const base = modelWindow();
    const raw = { ...base, proposals: [],
      entities: value.entities.map(entity => ({ ...base.entities[0], entityId: entity.entityKey, label: entity.entityKey,
        referentKind: entity.referentKinds[0], uncertainties: ['Type or scope remains source-limited.'],
        collection: entity.collection ? { memberEntityIds: entity.collection.members, completeness: entity.collection.completeness,
          mentionIds: value.mentions.filter(mention => mention.entity === entity.entityKey).map(mention => mention.mentionKey), rationale: entity.rationale } : null })),
      mentions: value.mentions.map(mention => ({ ...base.mentions[0], mentionId: mention.mentionKey, entityId: mention.entity,
        selection: { evidenceRef: `${caseId}:${mention.messageIndex}`, ...mention.alternatives[0] } })),
    };
    const admit = () => checkWindowExtractionResponse(raw, entityReviewInput(value).excerpts);
    expect(admit().analysis.rejected).toEqual([]);
    const correct = checkEntityReview(value, admit());
    expect(correct.identities.every(identity => identity.status === 'matched')).toBe(true);
    expect(correct.identityPairs.every(pair => pair.status === 'matched')).toBe(true);
    if (caseId === 'fresh-type-evidence') {
      raw.entities[0].referentKind = 'component';
      expect(checkEntityReview(value, admit()).identities[0]).toMatchObject({ status: 'mismatched', problems: ['referent_kind'] });
    } else {
      raw.mentions.find(mention => mention.mentionId === 'their')!.entityId = 'file-a';
      const incorrect = checkEntityReview(value, admit());
      expect(incorrect.identityPairs.some(pair => pair.status === 'wrong_merge')).toBe(true);
      expect(incorrect.identityPairs.some(pair => pair.status === 'wrong_split')).toBe(true);
    }
    // Production validates structure; source meaning is still subject to explicit review.
    expect(admit().analysis.rejected).toEqual([]);
  });

  it('does not reject source-scoped unresolved knowledge merely because the source is truncated', () => {
    const truncated = corpus.cases.find(value => value.caseId === 'val-truncated')!;
    const raw = modelWindow();
    raw.entities = [{ ...raw.entities[0], entityId: 'unknown', label: '它', identityStatus: 'unresolved',
      uncertainties: ['Source has no antecedent.'] }];
    raw.mentions = [{ ...raw.mentions[0], entityId: 'unknown', selection: { evidenceRef: 'val-truncated:0', quote: '它' } }];
    const proposal = raw.proposals[0]; proposal.entityIds = ['unknown']; proposal.mentionIds = ['m1'];
    proposal.draft.title = '身份未知对象的失败主张，待调查';
    const statement = proposal.draft.content.statements[0];
    statement.subject.entityId = 'unknown'; delete statement.object; statement.relation = '据本条消息失败，尚待调查';
    statement.context.scenario = '仅此截断消息'; statement.context.unknowns = ['主体身份及失败原因未知'];
    proposal.draft.evidence[0].evidenceRef = 'val-truncated:0';
    proposal.citations[0].selection = { evidenceRef: 'val-truncated:0', quote: truncated.messages[0].text };
    proposal.identityUncertainties = ['主体未消解，不补充来源外候选。'];
    const admitted = checkWindowExtractionResponse(raw, entityReviewInput(truncated).excerpts);
    expect(admitted.analysis.rejected).toEqual([]); expect(admitted.rejected).toEqual([]); expect(admitted.accepted).toHaveLength(1);
    const result = checkEntityReview(truncated, admitted);
    expect(result.unexpectedKnowledge).toBe(false); expect(result.identities[0].status).toBe('matched');
    expect(result.semanticReview).toBe('pending');
  });

  it('detects component and membership semantics even when production structure accepts them', () => {
    const collective = corpus.cases.find(value => value.caseId === 'dev-collective')!;
    const raw = { responseKind: 'knowledge-extraction', schemaVersion: 4, proposals: [],
      entities: [
        ...['atlas', 'birch'].map(entityId => ({ entityId, label: entityId, description: 'Named object', qualifiers: [],
          referentKind: 'object', identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], componentRef: null, collection: null })),
        { entityId: 'pair', label: '它们', description: 'Partial membership hypothesis', qualifiers: [], referentKind: 'collection', identityStatus: 'proposed',
          possibleEntityIds: [], uncertainties: ['Missing membership'], componentRef: null,
          collection: { memberEntityIds: ['atlas'], completeness: 'partial', mentionIds: ['pair'], rationale: 'Hypothesized membership' } },
      ],
      mentions: ['Atlas', 'Birch', '它们'].map((quote, index) => ({ mentionId: ['atlas','birch','pair'][index], entityId: ['atlas','birch','pair'][index],
        basis: 'explicit', rationale: 'Named in source', selection: { evidenceRef: 'dev-collective:0', quote } })),
    };
    const checked = checkWindowExtractionResponse(raw, entityReviewInput(collective).excerpts);
    expect(checked.analysis.rejected).toEqual([]);
    expect(checkEntityReview(collective, checked).identities.find(value => value.entity === 'pair')).toMatchObject({ status: 'mismatched', problems: ['membership'] });
    const kind = packet(); kind.entities[0].referentKind = 'component'; kind.proposals = [];
    expect(checkEntityReview(sample, check(kind)).identities[0].problems).toEqual(['referent_kind']);
  });

  it('records capture failures separately from envelope/partial structural rejections and propagates checker defects', () => {
    expect(reviewCapturedOutput(sample, 'not JSON', check).captureStatus).toBe('parse_failure');
    const envelope = reviewCapturedOutput(sample, '{}', check);
    expect(envelope.captureStatus).toBe('captured'); expect(envelope.structuralRejections).toHaveLength(1); expect(envelope.checks).toBeNull();
    const invalid = packet(); invalid.proposals = []; invalid.mentions[1].selection.quote = 'Invented';
    const partial = reviewCapturedOutput(sample, JSON.stringify(invalid), check);
    expect(partial.captureStatus).toBe('captured'); expect(partial.structuralRejections).toHaveLength(2);
    expect(partial.checks?.criticalMentions[1].status).toBe('missing');
    expect(() => reviewCapturedOutput(sample, '{}', () => { throw new Error('Internal defect'); })).toThrow('Internal defect');
  });

  it('preserves planned coverage and raw failures without treating structural rejection as a capture failure', () => {
    const single = { ...corpus, cases: [sample] };
    const artifact = { captureVersion: 'omk-entity-captures/v1', measurementId, split: 'development', repeats: 1, startedAt: '2020-02-01T00:00:00Z', executor: 'fixture', model: 'fixture',
      records: [{ caseId: 'roles', repeat: 1, inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))), result: { captureStatus: 'output', output: '{}', usage: { tokens: 10 } } }] };
    const review = () => reviewCapture(JSON.stringify(artifact), single, measurementId, checkWindowExtractionResponse);
    expect(review().summary).toMatchObject({ captureStatus: 'captured', captured: 1, callFailures: 0, parseFailures: 0, structuralRejectingOutputs: 1, rejectedItems: 1, usdCost: 'unknown', semanticReview: 'pending' });
    expect(review().capture.records[0].result).toEqual(artifact.records[0].result);
    const reported = { ...artifact, records: artifact.records.map(record => ({ ...record, result: { ...record.result, costUSD: 0, durationMs: 20 } })) };
    expect(reviewCapture(JSON.stringify(reported), single, measurementId, checkWindowExtractionResponse).summary).toMatchObject({ usdCost: 0, reportedCostUSD: 0, reportedDurationMs: 20, uncheckedCriticalMentions: 2 });
    artifact.records[0].result.output = 'bad'; expect(review().summary).toMatchObject({ captureStatus: 'capture_failures', parseFailures: 1, structuralRejectingOutputs: 0 });
    artifact.records.push(artifact.records[0]); expect(review).toThrow('duplicate'); artifact.records.pop();
    artifact.records[0].inputDigest = reviewDigest('wrong input'); expect(review).toThrow('frozen source input');
    artifact.records = []; expect(review().summary).toMatchObject({ captureStatus: 'incomplete', notAttempted: 1, checkedCriticalMentions: 0, uncheckedCriticalMentions: 2 });
    expect(review().unattempted).toEqual([{ caseId: 'roles', repeat: 1 }]);
    for (const status of ['call_failure', 'cancelled']) {
      const failed = { ...artifact, records: [{ caseId: 'roles', repeat: 1, inputDigest: reviewDigest(JSON.stringify(entityReviewInput(sample))), result: { captureStatus: status, failure: 'Captured failure' } }] };
      expect(reviewCapture(JSON.stringify(failed), single, measurementId, checkWindowExtractionResponse).summary[status === 'call_failure' ? 'callFailures' : 'cancellations']).toBe(1);
    }
  });

  it('cannot mark draft gold reviewed without an independent complete receipt bound before outputs', () => {
    expect(reviewReceiptStatus(undefined, corpus, measurementId).status).toBe('pending');
    expect(reviewReceiptStatus(JSON.stringify(receipt()), corpus, measurementId, '2020-02-01T00:00:00Z').status).toBe('attested_independent_human');
    const changes = receipt(); changes.decisions[0].decision = 'changes_requested';
    expect(reviewReceiptStatus(JSON.stringify(changes), corpus, measurementId).status).toBe('changes_requested');
    for (const mutate of [
      (value: ReturnType<typeof receipt>) => { value.reviewer = corpus.authors[0]; },
      (value: ReturnType<typeof receipt>) => { value.measurementId = reviewDigest('other'); },
      (value: ReturnType<typeof receipt>) => { value.decisions.pop(); },
      (value: ReturnType<typeof receipt>) => { value.decisions[0] = value.decisions[1]; },
      (value: ReturnType<typeof receipt>) => { value.independenceAttestation = false; },
    ]) { const value = receipt(); mutate(value); expect(() => reviewReceiptStatus(JSON.stringify(value), corpus, measurementId)).toThrow(); }
    expect(() => reviewReceiptStatus(JSON.stringify(receipt()), corpus, measurementId, '2019-01-01T00:00:00Z')).toThrow('precede');
    const html = entityReviewHtml({ ...corpus, cases: [{ ...sample, messages: [{ role: 'user', text: '<script>unsafe</script> Alpha drives Beta.' }] }] }, measurementId);
    expect(html).not.toContain('<script>unsafe</script>'); expect(html).toContain('&lt;script&gt;');
    const captured = entityReviewHtml(corpus, measurementId, { annotationReview: 'attested_independent_human', authorReview: 'pending', hasCaptures: true });
    expect(captured).toContain('已提供捕获'); expect(captured).not.toContain('尚无模型输出');
  });

  it('records complete author judgment without counting it as independent approval or overriding disagreements', () => {
    const author = { selfReviewVersion: 'omk-entity-author-review/v1', measurementId, reviewer: corpus.authors[0],
      reviewedAt: '2020-01-01T00:00:00Z', reviewedBeforeOutputs: true, decisions: receipt().decisions };
    const approved = authorReviewStatus(JSON.stringify(author), corpus, measurementId, '2020-02-01T00:00:00Z');
    expect(approved.status).toBe('completed');
    for (const [authorStatus, independentStatus, goldReady, exploratoryReady] of [
      ['pending', 'pending', false, false],
      ['pending', 'attested_independent_human', false, true],
      ['pending', 'changes_requested', false, false],
      ['completed', 'pending', false, true],
      ['completed', 'attested_independent_human', true, true],
      ['completed', 'changes_requested', false, false],
      ['changes_requested', 'pending', false, false],
      ['changes_requested', 'attested_independent_human', false, false],
      ['changes_requested', 'changes_requested', false, false],
    ] as const) expect(annotationReadiness(authorStatus, independentStatus)).toEqual({ goldReady, exploratoryReady });
    const changes = structuredClone(author); changes.decisions[0].decision = 'changes_requested';
    expect(authorReviewStatus(JSON.stringify(changes), corpus, measurementId).status).toBe('changes_requested');
    expect(authorReviewStatus(undefined, corpus, measurementId).status).toBe('pending');
    expect(() => reviewReceiptStatus(JSON.stringify(author), corpus, measurementId)).toThrow();
    for (const mutate of [
      (value: typeof author) => { value.reviewer = 'not-an-author'; },
      (value: typeof author) => { value.measurementId = reviewDigest('other'); },
      (value: typeof author) => { value.decisions.pop(); },
      (value: typeof author) => { value.decisions[0] = value.decisions[1]; },
      (value: typeof author) => { value.decisions[0].rationale = ''; },
      (value: typeof author) => { value.reviewedAt = '2999-01-01T00:00:00Z'; },
    ]) { const value = structuredClone(author); mutate(value); expect(() => authorReviewStatus(JSON.stringify(value), corpus, measurementId)).toThrow(); }
    expect(() => authorReviewStatus(JSON.stringify(author), corpus, measurementId, '2019-01-01T00:00:00Z')).toThrow('precede');
    expect(entityReviewHtml(corpus, measurementId, { annotationReview: 'pending', authorReview: 'completed', hasCaptures: false }))
      .toContain('作者自审：completed；独立人工标注复核：pending');
    expect(parseEntityReviewArguments(['--corpus', '/c', '--output', '/out', '--self-review', '/s'])).toMatchObject({ selfReview: '/s' });
  });

  it('rejects repository output through symlinks and permits a new external directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-review-boundary-'));
    try {
      const repo = join(root, 'repo'); mkdirSync(repo);
      symlinkSync(repo, join(root, 'link'), 'dir');
      for (const requested of ['relative', repo, join(repo, 'run'), join(root, 'link', 'run'), join(root, 'link')]) {
        expect(() => reviewOutputRoot(repo, requested)).toThrow();
      }
      expect(reviewOutputRoot(repo, join(root, 'run'))).toBe(join(realpathSync(root), 'run'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('builds an offline review package bound to the current tools without invoking a model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-review-package-'));
    try {
      const output = join(root, 'review');
      await runCli(['--corpus', resolve('test/fixtures/entity-extraction-review-v13.json'), '--output', output], {
        entry: join(PROJECT_ROOT, 'dist-scripts/bench/entity-extraction-review.js'), cwd: PROJECT_ROOT,
      });
      const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ promptVersion: 'knowledge-extraction-v25', checkVersion: ENTITY_CHECK_VERSION,
        conclusion: 'not_evaluated', goldReady: false, modelCallsByThisCommand: 0,
        splitCounts: { development: 62, validation: 2 } });
      const currentTools = ['entity-extraction-review.js', 'entity-review-corpus.js', 'entity-review-checks.js']
        .map(file => readFileSync(join(PROJECT_ROOT, 'dist-scripts/bench', file), 'utf8')).join('\0');
      expect(manifest.checkerDigest).toBe(reviewDigest(currentTools));
      expect(readFileSync(join(output, 'corpus.json'), 'utf8')).toBe(corpusText);
      const inputs = JSON.parse(readFileSync(join(output, 'inputs.json'), 'utf8'));
      expect(inputs).toHaveLength(corpus.cases.length);
      expect(JSON.stringify(inputs)).not.toContain('semanticChecks');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('exposes only an explicit offline input/output interface', () => {
    expect(parseEntityReviewArguments(['--corpus', '/corpus', '--output', '/outside/review'])).toMatchObject({ corpus: '/corpus', output: '/outside/review' });
    for (const args of [[], ['--model', 'model'], ['--corpus', '/corpus'], ['--corpus', '/corpus', '--output', '/outside', '--output', '/again']]) expect(() => parseEntityReviewArguments(args)).toThrow();
  });
});


// Actual new CLI child + production createExecutor, with a process-local fake fetch restricted to loopback.
describe('live collector command (zero external/model requests)', () => {
  const entry = join(PROJECT_ROOT, 'dist-scripts/bench/entity-extraction-capture.js');
  function fixture(root: string) {
    const source = join(root, 'source.json'); const prompt = join(root, 'prompt.txt'); const config = join(root, 'config.json');
    const http = join(root, 'http.json'); const log = join(root, 'requests.jsonl'); const preload = join(root, 'transport.mjs');
    writeFileSync(source, JSON.stringify({ sourceVersion: 'omk-entity-capture-source/v1',
      provenance: { sourceKind: 'synthetic', originDigest: reviewDigest('new authored fixture'), transformation: 'Authored synthetic messages.', toolPolicy: 'excluded' },
      review: { human: 'pending', independent: 'pending', gold: 'none' }, cases: [{ caseId: 'capture', split: 'development',
        excerpts: [{ evidenceRef: 'capture:0', recordIndex: 0, eventKind: 'message', role: 'user', text: 'Alpha 使用 Beta' }], limitations: ['Authored test only.'] }] }));
    writeFileSync(prompt, 'Authored candidate extraction prompt; no model-quality claim.');
    const configuration = { executor: 'openai-api', model: 'authored-loopback-test', profileId: 'loopback-test/v1', timeoutMs: 1000,
      maxOutputTokens: 64, maxCalls: 2, maxTokens: 2176, outputMode: 'prompt-json', schemaName: null,
      promptVariant: 'v15-candidate', caseIds: ['capture'], split: 'development', repeats: 2 };
    writeFileSync(config, JSON.stringify(configuration));
    const response = () => ({ choices: [{ message: { content: JSON.stringify(modelWindow()).replaceAll('record-1', 'capture:0') }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } });
    writeFileSync(http, JSON.stringify(response()));
    writeFileSync(preload, `import { readFileSync, appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('Test transport forbids non-loopback traffic.');
  appendFileSync(process.env.OMK_CAPTURE_TEST_LOG, JSON.stringify({ url, body: String(init.body), redirect: init.redirect }) + '\\n');
  return new Response(readFileSync(process.env.OMK_CAPTURE_TEST_RESPONSE, 'utf8'), { status: 200 });
};`);
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: 'authored-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:9321',
      NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, OMK_CAPTURE_TEST_LOG: log, OMK_CAPTURE_TEST_RESPONSE: http };
    const cli = (args: string[]) => runCli(args, { entry, cwd: root, env });
    const fail = (args: string[], code = 1) => runCliFailing(args, code, { entry, cwd: root, env });
    const prepare = async (directory: string) => JSON.parse((await cli(['prepare', '--source', source, '--prompt', prompt, '--config', config, '--out', directory])).stdout);
    const permit = (directory: string) => {
      const value = JSON.parse(readFileSync(join(directory, 'permission-template.json'), 'utf8'));
      Object.assign(value, { authorizationStatus: 'granted', grantedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), authorizedBy: 'Hermetic test only; no online authorization.' });
      const path = join(directory, 'test-permission.json'); writeFileSync(path, JSON.stringify(value)); return path;
    };
    const execute = (directory: string, planId: string, permission: string, slot: string) => ['execute-one', '--plan', directory,
      '--permission', permission, '--authorize-plan', planId, '--slot', slot];
    const requests = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return { source, prompt, config, configuration, http, env, cli, fail, prepare, permit, execute, requests, response };
  }

  it('defaults to zero requests, archives complete native failure/usage, and replays the unchanged production admission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-live-capture-cli-'));
    try {
      const sourceRuntime: CaptureRuntime = await import('../../src/cli/runtime/entity-capture.js');
      expect(typeof sourceRuntime.createExecutor).toBe('function'); // Type-check the compiled bridge's consumer projection.
      const f = fixture(root); const directory = join(root, 'capture');
      await f.cli([]); await f.fail(['execute-one'], 2);
      const prepared = await f.prepare(directory); expect(f.requests()).toEqual([]);
      expect(JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')).host.validatorIdentity).toEqual(sourceRuntime.CAPTURE_VALIDATOR_IDENTITY);
      const budget = readFileSync(join(directory, 'budget-evidence.json'), 'utf8');
      expect(budget).toBe(JSON.stringify(sourceRuntime.OPENAI_TOKEN_BUDGET_EVIDENCE, null, 2) + '\n');
      expect(JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8')).budgetEvidenceDigest).toBe(sourceRuntime.OPENAI_TOKEN_BUDGET_EVIDENCE_DIGEST);
      expect(JSON.parse((await f.cli(['check', '--plan', directory])).stdout)).toMatchObject({ executable: true, permissionRequired: true, requestsByThisCommand: 0 });
      await f.fail(f.execute(directory, prepared.planId, join(directory, 'permission-template.json'), 'capture-repeat-1'));
      expect(f.requests()).toEqual([]);
      const permission = f.permit(directory);
      expect(JSON.parse((await f.cli(f.execute(directory, prepared.planId, permission, 'capture-repeat-1'))).stdout))
        .toMatchObject({ outcome: 'output', dispatchCount: 1, authority: 'loopback-test-only', modelCalls: 'not_attested' });
      await f.fail(f.execute(directory, prepared.planId, permission, 'capture-repeat-1'));
      writeFileSync(f.http, JSON.stringify({ choices: [{ message: { content: 'raw failed output', refusal: 'authored refusal' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } }));
      await f.fail(f.execute(directory, prepared.planId, permission, 'capture-repeat-2'));
      const rawFailure = JSON.parse(readFileSync(join(directory, 'ledger', 'capture-repeat-2.native.json'), 'utf8'));
      expect(rawFailure).toMatchObject({ ok: false, output: 'raw failed output', refusal: 'authored refusal', failure: { failureKind: 'refusal' },
        inputTokens: 10, cacheReadTokens: 2, cacheCreationTokens: 0, outputTokens: 5, costReportedByExecutor: false });
      expect(f.requests()).toHaveLength(2);
      for (const request of f.requests()) expect({ ...JSON.parse(request.body), redirect: request.redirect }).toMatchObject({ n: 1, stream: false, max_completion_tokens: 64, redirect: 'error' });
      const report = join(root, 'replay.json'); await f.cli(['replay', '--plan', directory, '--out', report]);
      const replay = JSON.parse(readFileSync(report, 'utf8'));
      expect(replay.records[0].admission.accepted).toHaveLength(1); expect(replay.records[1].admission).toBeNull();
      expect(replay).toMatchObject({ unattempted: [], requestsByThisCommand: 0, semanticReview: 'pending', independentHumanReview: 'pending', qualityConclusion: 'not_evaluated' });
      expect(f.requests()).toHaveLength(2); expect(existsSync(join(directory, 'active.lock'))).toBe(false);
      writeFileSync(f.prompt, 'A second authored candidate prompt, no quality claim.');
      const right = join(root, 'right'); await f.prepare(right);
      const comparison = JSON.parse((await f.cli(['compare', '--left', directory, '--right', right])).stdout);
      expect(comparison).toMatchObject({ matchingConditions: true, controlledExecutionClaim: false });
      expect(comparison.recordSummaries.left).toHaveLength(2); expect(comparison.recordSummaries.right).toEqual([]);
      writeFileSync(join(directory, 'ledger', 'capture-repeat-1.native.json'), JSON.stringify({ output: 'tampered' }));
      await f.fail(['compare', '--left', directory, '--right', right]); expect(f.requests()).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails closed for unknown usage, reservations, env/permission/budget drift and unsupported Codex caps without invoking even a fake binary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-live-capture-gates-'));
    try {
      const f = fixture(root); const directory = join(root, 'unknown'); const prepared = await f.prepare(directory); const permission = f.permit(directory);
      await runCliFailing(f.execute(directory, prepared.planId, permission, 'capture-repeat-1'), 1, {
        entry, cwd: root, env: { ...f.env, OPENAI_BASE_URL: 'http://127.0.0.1:9999' },
      });
      const permissionBytes = readFileSync(permission, 'utf8');
      writeFileSync(permission, JSON.stringify({ ...JSON.parse(permissionBytes), maxCalls: 1 }));
      await f.fail(f.execute(directory, prepared.planId, permission, 'capture-repeat-1'));
      writeFileSync(permission, permissionBytes); expect(f.requests()).toEqual([]);
      writeFileSync(f.http, JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
      await f.fail(f.execute(directory, prepared.planId, permission, 'capture-repeat-1'));
      const unknown = JSON.parse(readFileSync(join(directory, 'ledger', 'capture-repeat-1.attempt.json'), 'utf8'));
      expect(unknown).toMatchObject({ blocked: true, usage: { inputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: null } });
      await f.fail(f.execute(directory, prepared.planId, permission, 'capture-repeat-2'));
      rmSync(join(directory, 'ledger', 'capture-repeat-1.attempt.json'));
      await f.fail(f.execute(directory, prepared.planId, permission, 'capture-repeat-1'));
      expect(f.requests()).toHaveLength(1);
      const poor = join(root, 'poor'); writeFileSync(f.config, JSON.stringify({ ...f.configuration, maxTokens: 1 }));
      const poorPlan = await f.prepare(poor); await f.fail(['check', '--plan', poor]);
      await f.fail(f.execute(poor, poorPlan.planId, f.permit(poor), 'capture-repeat-1'));
      const binaryDirectory = join(root, 'bin'); mkdirSync(binaryDirectory); const marker = join(root, 'codex-invoked');
      const binary = join(binaryDirectory, 'codex'); writeFileSync(binary, '#!/bin/sh\ntouch "' + marker + '"\n'); chmodSync(binary, 0o700);
      f.env.PATH = binaryDirectory + ':' + (process.env.PATH ?? '');
      writeFileSync(f.config, JSON.stringify({ ...f.configuration, executor: 'codex' }));
      const codex = join(root, 'codex'); const codexPlan = await f.prepare(codex);
      await f.fail(['check', '--plan', codex]);
      await f.fail(f.execute(codex, codexPlan.planId, join(codex, 'permission-template.json'), 'capture-repeat-1'));
      expect(existsSync(marker)).toBe(false); expect(f.requests()).toHaveLength(1);
      writeFileSync(f.config, JSON.stringify(f.configuration));
      const drift = join(root, 'validator-drift'); await f.prepare(drift);
      const previous = JSON.parse(readFileSync(join(drift, 'plan.json'), 'utf8'));
      const identity = { ...previous }; delete identity.planId;
      identity.host.validatorIdentity.zod = '0.0.0';
      writeFileSync(join(drift, 'plan.json'), JSON.stringify({ ...identity, planId: identityDigest(identity) }, null, 2) + '\n');
      expect((await f.fail(['check', '--plan', drift])).stderr).toContain('Capture plan/host/checker identity mismatch');
      await f.fail(['compare', '--left', drift, '--right', directory]);
      expect((await f.fail(f.execute(drift, identityDigest(identity), join(drift, 'permission-template.json'), 'capture-repeat-1'))).stderr).toContain('Capture plan/host/checker identity mismatch');
      expect(f.requests()).toHaveLength(1);
      writeFileSync(f.config, JSON.stringify({ ...f.configuration, model: 'gpt-5.4-2026-03-05', profileId: 'openai-gpt54-snapshot-context/v1', maxCalls: 1, maxTokens: 1_050_064 }));
      const officialEnv = { ...f.env, NODE_OPTIONS: '', OPENAI_BASE_URL: 'https://api.openai.com' };
      const official = join(root, 'official-offline');
      await runCli(['prepare', '--source', f.source, '--prompt', f.prompt, '--config', f.config, '--out', official], { entry, cwd: root, env: officialEnv });
      expect(JSON.parse((await runCli(['check', '--plan', official], { entry, cwd: root, env: officialEnv })).stdout).executable).toBe(true);
      const wrapper = join(root, 'loader-wrapper.mjs');
      writeFileSync(wrapper, `import { spawnSync } from 'node:child_process';\nconst result=spawnSync(process.execPath,[...JSON.parse(process.argv[2]),process.argv[3],...process.argv.slice(4)],{env:process.env,stdio:'inherit'});\nif(result.error)throw result.error;process.exitCode=result.status??99;\n`);
      for (const flags of [['--experimental-loader=data:text/javascript,export{}'], ['--experimental-loader', 'data:text/javascript,export{}']]) {
        const rejected = await runCliFailing([JSON.stringify(flags), entry, 'check', '--plan', official], 1, { entry: wrapper, cwd: root, env: officialEnv });
        expect(JSON.parse(rejected.stdout)).toMatchObject({ executable: false, reasons: ['Error: Official profile rejects injected Node loaders.'], requestsByThisCommand: 0 });
      }
      expect(f.requests()).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('replays explicit strict-wire partial admission and rejects native Unicode replacement while retaining the full native result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-live-capture-wire-'));
    try {
      const f = fixture(root); const directory = join(root, 'capture'); const schema = join(root, 'wire.json');
      writeFileSync(schema, WINDOW_EXTRACTION_WIRE_SCHEMA_JSON);
      writeFileSync(f.config, JSON.stringify({ ...f.configuration, outputMode: 'json-schema', schemaName: 'knowledge_window' }));
      const prepared = JSON.parse((await f.cli(['prepare', '--source', f.source, '--prompt', f.prompt, '--config', f.config,
        '--out', directory, '--wire-schema', schema])).stdout);
      const permission = f.permit(directory);
      const wire = JSON.parse(JSON.stringify(modelWindow()).replaceAll('record-1', 'capture:0'));
      for (const mention of wire.mentions) mention.selection.occurrence = null;
      for (const proposal of wire.proposals) for (const citation of proposal.citations) citation.selection.occurrence = null;
      wire.entities.push({ ...wire.entities[0], entityId: 'bad', unexpected: 'retained' });
      const response = f.response(); response.choices[0].message.content = JSON.stringify(wire);
      writeFileSync(f.http, JSON.stringify(response));
      await f.cli(f.execute(directory, prepared.planId, permission, 'capture-repeat-1'));
      response.choices[0].message.content = JSON.stringify(wire).replace('本次日志中的项目', String.fromCharCode(0xd800));
      writeFileSync(f.http, JSON.stringify(response));
      await f.cli(f.execute(directory, prepared.planId, permission, 'capture-repeat-2'));
      const report = join(root, 'replay.json'); await f.cli(['replay', '--plan', directory, '--out', report]);
      const replay = JSON.parse(readFileSync(report, 'utf8'));
      expect(replay.records[0].wire).toMatchObject({ wireStatus: 'item_failures' });
      expect(replay.records[0].wire.domainInput.entities[2].unexpected).toBe('retained');
      expect(replay.records[0].admission.accepted).toHaveLength(1);
      expect(replay.records[1].admission).toBeNull(); expect(replay.records[1].parseFailure).toContain('round-trip UTF-8');
      expect(replay.records[1].native.output).toBe(response.choices[0].message.content);
      expect(f.requests()).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});
