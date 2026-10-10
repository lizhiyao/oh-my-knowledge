import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWindowExtractionResponse } from '../../src/observability/knowledge-extraction/window-proposals.js';
import { entityReviewInput, parseEntityReviewCorpus, reviewMentions, type EntityReviewCase } from '../../scripts/bench/entity-review-corpus.js';
import { checkEntityReview, reviewCapturedOutput } from '../../scripts/bench/entity-review-checks.js';
import { entityReviewHtml, parseEntityReviewArguments, reviewCapture, reviewDigest, reviewReceiptStatus } from '../../scripts/bench/entity-extraction-review.js';
import { modelWindow } from '../knowledge/fixtures.js';

const corpusText = readFileSync(new URL('../fixtures/entity-extraction-review.json', import.meta.url), 'utf8');
const corpus = parseEntityReviewCorpus(corpusText);
const measurementId = reviewDigest('frozen measurement');
const sample: EntityReviewCase = {
  caseId: 'roles', projectGroup: 'project', conversationGroup: 'conversation', split: 'development',
  messages: [{ role: 'user', text: 'Alpha drives Beta.' }], limitations: ['Selected messages only.'], tags: ['roles'],
  entities: ['alpha', 'beta'].map(entityKey => ({ entityKey, referentKinds: ['object'], identityStatus: 'proposed', possibleEntities: [],
    component: null, collection: null, rationale: 'Distinct objects.' })),
  mentions: ['Alpha', 'Beta'].map(quote => ({ mentionKey: quote.toLowerCase(), entity: quote.toLowerCase(), messageIndex: 0,
    alternatives: [{ quote, occurrence: 0 }], rationale: 'Explicit name.' })),
  roles: [{ roleKey: 'drives', subject: 'alpha', object: 'beta', messageIndex: 0,
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

describe('entity extraction review v2', () => {
  it('validates the synthetic draft and prevents group/window leakage and contradictory annotations', () => {
    expect(corpus.cases.filter(value => value.split === 'development')).toHaveLength(8);
    expect(corpus.cases.filter(value => value.split === 'validation')).toHaveLength(8);
    expect(corpus.cases.reduce((count, value) => count + value.mentions.length, 0)).toBe(50);
    for (const mutate of [
      (copy: typeof corpus) => { copy.cases[8].projectGroup = copy.cases[0].projectGroup; },
      (copy: typeof corpus) => { copy.cases[8].conversationGroup = copy.cases[0].conversationGroup; },
      (copy: typeof corpus) => { copy.cases[8].messages = copy.cases[0].messages; },
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
    for (const field of ['referentKinds', 'semanticChecks', 'projectGroup', 'split', 'alternatives']) expect(JSON.stringify(input)).not.toContain(field);
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

  it('uses cited endpoints across synonyms, preserves optional omission and leaves direction conflicts for semantic review', () => {
    const output = packet(); output.proposals[0].draft.content.statements[0].relation = 'employs as a dependency';
    expect(checkEntityReview(sample, check(output)).roles[0].endpointStatus).toBe('endpoints_matched');
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
    const captured = entityReviewHtml(corpus, measurementId, { annotationReview: 'attested_independent_human', hasCaptures: true });
    expect(captured).toContain('已提供捕获'); expect(captured).not.toContain('尚无模型输出');
  });

  it('exposes only an explicit offline input/output interface', () => {
    expect(parseEntityReviewArguments(['--corpus', '/corpus', '--output', '/outside/review'])).toMatchObject({ corpus: '/corpus', output: '/outside/review' });
    for (const args of [[], ['--model', 'model'], ['--corpus', '/corpus'], ['--corpus', '/corpus', '--output', '/outside', '--output', '/again']]) expect(() => parseEntityReviewArguments(args)).toThrow();
  });
});
