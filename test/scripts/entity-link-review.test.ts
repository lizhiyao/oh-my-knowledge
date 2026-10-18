import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EntityLinkModelInputSchema } from '../../src/knowledge/entities/link-invocation.js';
import { EntityLinkSuggestionSchema, checkEntityLinkSuggestion } from '../../src/knowledge/entities/links.js';
import { ENTITY_LINK_PROMPT, ENTITY_LINK_PROMPT_HASH, ENTITY_LINK_PROMPT_VERSION, ENTITY_LINK_RESPONSE_JSON_SCHEMA,
  ENTITY_LINK_RESPONSE_SCHEMA_HASH } from '../../src/knowledge/linking/entity-link-prompt.js';
import { annotationReadiness, authorReviewStatus, reviewDigest, reviewReceiptStatus } from '../../scripts/bench/entity-extraction-review.js';
import { entityLinkReviewInput, parseEntityLinkReviewCorpus, type EntityLinkReviewCase, type EntityLinkReviewCorpus } from '../../scripts/bench/entity-link-review-corpus.js';
import { canonicalLinkReview, entityLinkReviewHostIdentity, reviewEntityLinkCapture, type EntityLinkReviewRuntime } from '../../scripts/bench/entity-link-review.js';

const corpusText = readFileSync(new URL('../fixtures/entity-link-review-v1.json', import.meta.url), 'utf8');
const validateInput = (value: unknown) => EntityLinkModelInputSchema.parse(value);
const corpus = parseEntityLinkReviewCorpus(corpusText, validateInput);
type FullCorpus = Omit<EntityLinkReviewCorpus, 'cases'> & { cases: (Omit<EntityLinkReviewCase, 'input'> & { input: ReturnType<typeof validateInput> })[] };
const freshCorpus = () => JSON.parse(corpusText) as FullCorpus;
const parse = (value: unknown) => parseEntityLinkReviewCorpus(JSON.stringify(value), validateInput);
const measurementId = reviewDigest('entity-link offline test measurement');
const runtime: EntityLinkReviewRuntime = {
  validateInput, parseSuggestion: value => EntityLinkSuggestionSchema.parse(value),
  admitSuggestion: (value, input) => checkEntityLinkSuggestion(value, { left: input.left.binding, right: input.right.binding }),
  prompt: ENTITY_LINK_PROMPT, promptVersion: ENTITY_LINK_PROMPT_VERSION, promptHash: ENTITY_LINK_PROMPT_HASH,
  responseSchema: ENTITY_LINK_RESPONSE_JSON_SCHEMA, responseSchemaHash: ENTITY_LINK_RESPONSE_SCHEMA_HASH,
};
const development = corpus.cases.filter(sample => sample.split === 'development');
function suggestion(sample: EntityLinkReviewCase, assessment = sample.expectedAssessment) {
  return { responseKind: 'entity-link-suggestion', schemaVersion: 1, assessment,
    leftEntityId: sample.input.left.binding.entityId, rightEntityId: sample.input.right.binding.entityId,
    leftMentionIds: sample.input.left.binding.mentionIds, rightMentionIds: sample.input.right.binding.mentionIds,
    rationale: '离线测试响应，仅用于验证生产接纳与作者参考比较，不表示模型或人工语义结论。' };
}
type Result = { captureStatus: 'output'; output: string; usage?: unknown; costUSD?: number }
  | { captureStatus: 'call_failure' | 'cancelled'; failure: string; costUSD?: number };
const record = (sample: EntityLinkReviewCase, result: Result, repeat = 1) => ({ caseId: sample.caseId, repeat,
  inputDigest: reviewDigest(canonicalLinkReview(entityLinkReviewInput(sample))), result });
const capture = (records: ReturnType<typeof record>[], repeats = 1) => ({ captureVersion: 'omk-entity-link-captures/v1', measurementId,
  split: 'development', repeats, startedAt: '2020-02-01T00:00:00Z', executor: 'fixture-only', model: 'fixture-only', records });
const review = (value: unknown) => reviewEntityLinkCapture(JSON.stringify(value), corpus, measurementId, runtime);

describe('entity-link review corpus with the production input parser', () => {
  it('binds the executing checker rather than a different repository copy of its files', () => {
    const repository = mkdtempSync(join(tmpdir(), 'omk-link-identity-'));
    try {
      mkdirSync(join(repository, 'dist'));
      mkdirSync(join(repository, 'dist', 'knowledge', 'entities'), { recursive: true });
      writeFileSync(join(repository, 'dist', 'knowledge', 'entities', 'link-invocation.js'), '// fixture module location');
      mkdirSync(join(repository, 'node_modules'));
      symlinkSync(dirname(createRequire(import.meta.url).resolve('zod/package.json')), join(repository, 'node_modules', 'zod'), 'dir');
      mkdirSync(join(repository, 'dist-scripts', 'bench'), { recursive: true });
      writeFileSync(join(repository, 'dist', 'runtime.js'), 'export const fixture = 1;');
      writeFileSync(join(repository, 'package.json'), '{"name":"identity-fixture"}');
      writeFileSync(join(repository, 'yarn.lock'), 'fixture lock');
      const before = entityLinkReviewHostIdentity(repository);
      for (const name of ['entity-link-review', 'entity-link-review-corpus', 'entity-extraction-review', 'entity-review-corpus', 'entity-review-checks']) {
        writeFileSync(join(repository, 'dist-scripts', 'bench', name + '.js'), 'different checker that is not executed');
      }
      expect(entityLinkReviewHostIdentity(repository)).toEqual(before);
      writeFileSync(join(repository, 'dist', 'runtime.js'), 'export const fixture = 2;');
      const changed = entityLinkReviewHostIdentity(repository);
      expect(changed.runtimeDigest).not.toBe(before.runtimeDigest);
      expect(changed.checkerDigest).toBe(before.checkerDigest);
      const drifted = join(repository, 'different-install');
      mkdirSync(join(drifted, 'dist', 'knowledge', 'entities'), { recursive: true });
      writeFileSync(join(drifted, 'dist', 'knowledge', 'entities', 'link-invocation.js'), '// different module location');
      mkdirSync(join(drifted, 'node_modules', 'zod'), { recursive: true });
      writeFileSync(join(drifted, 'node_modules', 'zod', 'package.json'), '{"name":"zod","version":"different-installed-validator"}');
      expect(() => entityLinkReviewHostIdentity(drifted)).toThrow('validators differ');
    } finally { rmSync(repository, { recursive: true, force: true }); }
  });

  it('keeps twelve public synthetic cases balanced and excludes authored labels from every model input', () => {
    expect(corpus.provenance).toBe('synthetic'); expect(corpus.cases).toHaveLength(12);
    for (const split of ['development', 'validation']) for (const assessment of ['same_object', 'different_objects', 'insufficient_evidence']) {
      expect(corpus.cases.filter(sample => sample.split === split && sample.expectedAssessment === assessment)).toHaveLength(2);
    }
    for (const sample of corpus.cases) {
      const input = entityLinkReviewInput(sample); const rendered = canonicalLinkReview(input);
      expect(validateInput(input)).toEqual(input);
      expect(Object.keys(input).sort()).toEqual(['left', 'protocolId', 'right']);
      for (const field of ['caseId', 'split', 'projectGroup', 'conversationGroup', 'tags', 'expectedAssessment', 'referenceRationale', 'semanticChecks']) {
        expect(rendered).not.toContain(`"${field}":`);
      }
    }
  });

  it.each(['projectGroup', 'conversationGroup'] as const)('rejects a %s reused across development and validation', field => {
    const value = freshCorpus(); value.cases[6][field] = value.cases[0][field];
    expect(() => parse(value)).toThrow('group leaks');
  });

  it('rejects cross-split source content copies even when the selected analysis identities differ', () => {
    const value = freshCorpus(); const target = value.cases[6]; const previous = target.input;
    target.input = structuredClone(value.cases[0].input);
    target.input.left.binding.analysisId = previous.left.binding.analysisId;
    target.input.right.binding.analysisId = previous.right.binding.analysisId;
    expect(() => parse(value)).toThrow('content leaks');
  });

  it.each(['one-side', 'swapped-pair'] as const)('rejects %s source reuse across splits', mode => {
    const value = freshCorpus(); const target = value.cases[6]; const source = value.cases[0].input;
    const leftAnalysisId = target.input.left.binding.analysisId, rightAnalysisId = target.input.right.binding.analysisId;
    if (mode === 'one-side') target.input.left = structuredClone(source.left);
    else target.input = { ...structuredClone(source), left: structuredClone(source.right), right: structuredClone(source.left) };
    target.input.left.binding.analysisId = leftAnalysisId; target.input.right.binding.analysisId = rightAnalysisId;
    expect(() => parse(value)).toThrow('content leaks');
  });

  it('requires production structure, cross-window identity and closed entity/mention selections', () => {
    const mutations = [
      (value: FullCorpus) => { value.cases[0].input.left.binding.analysisId = value.cases[0].input.right.binding.analysisId; },
      (value: FullCorpus) => { value.cases[0].input.left.entity.entityId = value.cases[1].input.left.entity.entityId; },
      (value: FullCorpus) => { value.cases[0].input.left.mentions[0].entityId = value.cases[1].input.left.entity.entityId; },
      (value: FullCorpus) => { value.cases[0].input.left.binding.mentionIds = [value.cases[1].input.left.mentions[0].mentionId]; },
      (value: FullCorpus) => { value.cases[0].input.left.mentions.push(structuredClone(value.cases[0].input.left.mentions[0])); },
      (value: FullCorpus) => { value.cases[0].input.left.mentions[0].selection.end += 1; },
      (value: FullCorpus) => { value.cases[0].input.left.mentions[0].selection.start = -1; },
      (value: FullCorpus) => { Object.assign(value.cases[0].input, { expectedAssessment: 'same_object' }); },
    ];
    for (const mutate of mutations) { const value = freshCorpus(); mutate(value); expect(() => parse(value)).toThrow(); }
    const incomplete = freshCorpus(); incomplete.cases.filter(sample => sample.split === 'validation')
      .forEach(sample => { sample.expectedAssessment = 'same_object'; });
    expect(() => parse(incomplete)).toThrow('all three assessments');
  });
});

describe('entity-link captured output checks with actual production suggestion admission', () => {
  it('separates parse, schema, binding and author agreement while preserving failure evidence and planned repeats', () => {
    const wrongBinding = { ...suggestion(development[2]), leftEntityId: development[0].input.left.binding.entityId };
    const differentAssessment = suggestion(development[3], 'insufficient_evidence');
    const artifact = capture([
      record(development[0], { captureStatus: 'output', output: '{ not JSON', usage: { rawProviderUsage: true } }),
      record(development[1], { captureStatus: 'output', output: '{}' }),
      record(development[2], { captureStatus: 'output', output: JSON.stringify(wrongBinding) }),
      record(development[3], { captureStatus: 'output', output: JSON.stringify(differentAssessment) + '\n', costUSD: 0.25 }),
      record(development[4], { captureStatus: 'call_failure', failure: 'Recorded fixture network failure', costUSD: 0 }),
      record(development[5], { captureStatus: 'cancelled', failure: 'Recorded fixture cancellation' }),
      record(development[3], { captureStatus: 'output', output: JSON.stringify(suggestion(development[3])) }, 2),
    ], 2);
    const before = structuredClone(artifact); const checked = review(artifact);
    expect(checked.records.map(result => result.checkStatus)).toEqual([
      'parse_failure', 'schema_rejection', 'binding_rejection', 'admitted', 'call_failure', 'cancelled', 'admitted',
    ]);
    expect(checked.records[3]).toMatchObject({ assessment: 'insufficient_evidence', authorReference: 'different_objects',
      agreesWithAuthorReference: false, rationale: differentAssessment.rationale, rationaleReview: 'pending' });
    expect(checked.records[4]).toMatchObject({ failure: 'Recorded fixture network failure' });
    expect(checked.records[5]).toMatchObject({ failure: 'Recorded fixture cancellation' });
    expect(checked.summary).toMatchObject({ planned: 12, recorded: 7, unattempted: 5, outputCount: 5,
      callFailures: 1, cancelled: 1, parseFailures: 1, schemaRejections: 1, bindingRejections: 1, admitted: 2,
      authorReferenceCompared: 2, authorReferenceMatches: 1, parseFailureRate: 0.2, structureRejectionRate: 0.25,
      costReportingRecords: 2, reportedCostUSD: 0.25, totalCostUSD: null, semanticReview: 'pending', qualityConclusion: 'not_evaluated' });
    expect(checked.unattempted).toEqual(development.filter(sample => sample.caseId !== development[3].caseId)
      .map(sample => ({ caseId: sample.caseId, repeat: 2 })));
    for (const field of ['accuracy', 'precision', 'recall', 'f1']) expect(checked.summary).not.toHaveProperty(field);
    expect(checked.summary.coverage).toContain('not independent semantic accuracy');
    expect(checked.capture).toEqual(before); expect(artifact).toEqual(before);
  });

  it('does not turn missing outputs or unreported cost into zero failures or free execution', () => {
    const empty = review(capture([]));
    expect(empty.summary).toMatchObject({ planned: 6, recorded: 0, unattempted: 6, admitted: 0,
      parseFailureRate: null, structureRejectionRate: null, reportedCostUSD: null, totalCostUSD: null });
    const unreported = capture([record(development[0], { captureStatus: 'output', output: JSON.stringify(suggestion(development[0])) })]);
    expect(review(unreported).summary).toMatchObject({ costReportingRecords: 0, reportedCostUSD: null, totalCostUSD: null });
    const reportedZero = structuredClone(unreported); reportedZero.records[0].result.costUSD = 0;
    expect(review(reportedZero).summary).toMatchObject({ unattempted: 5, costReportingRecords: 1, reportedCostUSD: 0, totalCostUSD: null });
    const completedZero = capture(development.map(sample => record(sample, {
      captureStatus: 'output', output: JSON.stringify(suggestion(sample)), costUSD: 0,
    })));
    expect(review(completedZero).summary).toMatchObject({ unattempted: 0, costReportingRecords: 6, reportedCostUSD: 0, totalCostUSD: 0 });
  });

  it('rejects duplicate/unplanned records, input drift and measurement/time mismatches before scoring', () => {
    const initial = capture([record(development[0], { captureStatus: 'output', output: JSON.stringify(suggestion(development[0])) })]);
    for (const mutate of [
      (value: typeof initial) => { value.records.push(structuredClone(value.records[0])); },
      (value: typeof initial) => { value.records[0].caseId = corpus.cases[6].caseId; },
      (value: typeof initial) => { value.records[0].repeat = 2; },
      (value: typeof initial) => { value.records[0].inputDigest = reviewDigest('different source input'); },
      (value: typeof initial) => { value.measurementId = reviewDigest('different measurement'); },
      (value: typeof initial) => { value.startedAt = '2999-01-01T00:00:00Z'; },
    ]) { const value = structuredClone(initial); mutate(value); expect(() => review(value)).toThrow(); }
  });
});

describe('shared annotation receipts applied to the entity-link corpus', () => {
  it('uses complete author/human declarations with the same measurement, timing and independence boundaries', () => {
    // Test declarations only: these objects are not real human review evidence.
    const author = { selfReviewVersion: 'omk-entity-author-review/v1', measurementId, reviewer: corpus.authors[0],
      reviewedAt: '2020-01-01T00:00:00Z', reviewedBeforeOutputs: true,
      decisions: corpus.cases.map(sample => ({ caseId: sample.caseId, decision: 'approved', rationale: 'Fixture declaration.' })) };
    const human = { reviewVersion: 'omk-entity-annotation-review/v1', measurementId, reviewer: 'fixture-independent-reviewer',
      reviewedAt: author.reviewedAt, reviewKind: 'independent-human', reviewedBeforeOutputs: true, independenceAttestation: true,
      decisions: structuredClone(author.decisions), disputes: [{ caseId: corpus.cases[0].caseId, question: 'Fixture dispute.',
        resolution: 'Fixture resolution only.', adjudicator: 'fixture-independent-adjudicator' }] };
    const authorStatus = () => authorReviewStatus(JSON.stringify(author), corpus, measurementId, '2020-02-01T00:00:00Z').status;
    const humanStatus = () => reviewReceiptStatus(JSON.stringify(human), corpus, measurementId, '2020-02-01T00:00:00Z').status;
    expect(authorStatus()).toBe('completed');
    expect(annotationReadiness(authorStatus(), 'pending')).toEqual({ goldReady: false, exploratoryReady: true });
    expect(annotationReadiness(authorStatus(), humanStatus())).toEqual({ goldReady: true, exploratoryReady: true });
    human.decisions[0].decision = 'changes_requested';
    expect(annotationReadiness(authorStatus(), humanStatus())).toEqual({ goldReady: false, exploratoryReady: false });
    human.decisions[0].decision = 'approved';
    human.measurementId = reviewDigest('changed identity'); expect(humanStatus).toThrow('identity'); human.measurementId = measurementId;
    author.reviewedAt = '2020-03-01T00:00:00Z'; expect(authorStatus).toThrow('precede'); author.reviewedAt = '2020-01-01T00:00:00Z';
    human.reviewedAt = '2999-01-01T00:00:00Z'; expect(humanStatus).toThrow('future'); human.reviewedAt = '2020-01-01T00:00:00Z';
    human.reviewer = corpus.authors[0].toUpperCase(); expect(humanStatus).toThrow('independent'); human.reviewer = 'fixture-independent-reviewer';
    human.disputes[0].caseId = 'not-in-this-corpus'; expect(humanStatus).toThrow('unknown case'); human.disputes[0].caseId = corpus.cases[0].caseId;
    human.disputes[0].adjudicator = corpus.authors[0].toUpperCase(); expect(humanStatus).toThrow('independent');
  });
});
