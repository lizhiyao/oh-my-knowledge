import { describe, expect, it } from 'vitest';
import { createExtractionStudyReferenceTemplate, extractionStudyDigest, freezeExtractionStudyCorpus, parseExtractionStudyCorpus } from '../../src/knowledge/extraction/study-corpus.js';
import { createExtractionStudyOutputTemplate, evaluateExtractionStudyReview, extractionStudyReviewTargets } from '../../src/knowledge/extraction/study-review.js';
import { studyFixture, studyJudgeIdentity } from './extraction-study-fixtures.js';

function body(input: ReturnType<typeof studyFixture>['corpus']) {
  const { corpusDigest: _digest, ...value } = input; void _digest; return value;
}
function refresh(value: ReturnType<typeof studyFixture>) {
  value.input.corpus = freezeExtractionStudyCorpus(body(value.input.corpus));
  value.input.plan.corpusDigest = value.input.corpus.corpusDigest;
  for (const key of ['authorReceipt', 'referenceReceipt'] as const) {
    const receipt = value.input[key] as { corpusDigest: string } | undefined;
    if (receipt) receipt.corpusDigest = value.input.corpus.corpusDigest;
  }
}

describe('frozen real extraction study protocol', () => {
  it('binds exact source/reference bytes and leaves both reviewer phases unsigned', () => {
    const f = studyFixture(), before = JSON.stringify(f.input);
    expect(parseExtractionStudyCorpus(f.corpus)).toEqual(f.corpus);
    expect(() => parseExtractionStudyCorpus({ ...f.corpus, sourceKind: 'public-redacted-real' })).toThrow('identity');
    const template = createExtractionStudyReferenceTemplate(f.corpus);
    expect(template).toMatchObject({ reviewer: { actorId: '' }, reviewedAt: '', independentHuman: false, reviewedBeforeOutputs: false });
    expect(template.decisions.every(value => value.verdict === 'uncertain' && !value.rationale)).toBe(true);
    const outputs = createExtractionStudyOutputTemplate(f.input);
    expect(outputs.decisions).toHaveLength(extractionStudyReviewTargets(f.input).length);
    expect(outputs).toMatchObject({ reviewer: { actorId: '' }, reviewedAt: '', independentHuman: false });
    const report = evaluateExtractionStudyReview(f.input);
    expect(report).toMatchObject({ scope: 'frozen-real-study', status: 'accepted_within_scope', reference: { goldReady: true } });
    expect(report.slots[0].metrics.entities).toMatchObject({ truePositive: 2, falsePositive: 0, falseNegative: 0, precision: 1, recall: 1, f1: 1 });
    expect(JSON.stringify(f.input)).toBe(before);
  });

  it('rejects source duplicates, cross-split record/lineage leakage, seen validation and invented quote spans', () => {
    const f = studyFixture(), base = body(f.corpus);
    const other = structuredClone(base.cases[0]); other.caseId = 'case-b';
    expect(() => freezeExtractionStudyCorpus({ ...base, cases: [...base.cases, other] })).toThrow('Duplicate study source text');
    other.split = 'validation'; other.exposure = 'unseen';
    other.projectGroup = 'other-project'; other.conversationGroup = 'other-conversation'; other.lineageGroup = 'other-lineage';
    other.window.excerpts[0].text = 'Other source text';
    expect(() => freezeExtractionStudyCorpus({ ...base, cases: [...base.cases, other] })).toThrow('leaks across splits');
    const seen = structuredClone(base); seen.cases[0].split = 'validation';
    expect(() => freezeExtractionStudyCorpus(seen)).toThrow('Seen');
    const quote = structuredClone(base); quote.cases[0].reference.mentions[0].locators[0].quote = 'invented';
    expect(() => freezeExtractionStudyCorpus(quote)).toThrow('not exact');
    const lineage = structuredClone(other); lineage.originDigest = extractionStudyDigest('other-origin'); lineage.sourceRecords[0].recordId = 'other-id';
    lineage.sourceRecords[0].originalDigest = extractionStudyDigest('other-record'); lineage.ancestorLineageIds = ['lineage-a'];
    expect(() => freezeExtractionStudyCorpus({ ...base, cases: [...base.cases, lineage] })).toThrow('leaks across splits');
  });

  it('accepts any preregistered exact mention boundary and rejects coverage verdicts disguised as ordinary errors', () => {
    const f = studyFixture();
    f.input.corpus.cases[0].reference.mentions[0].locators.unshift({ evidenceRef: 'record-1', quote: 'Alpha 使用' }); refresh(f);
    expect(evaluateExtractionStudyReview(f.input).slots[0].metrics.mentions.recall).toBe(1);
    const coverage = f.receipt.decisions.find(value => value.target.itemKind === 'reference_mention')!;
    coverage.verdict = 'incorrect'; coverage.errorCodes = ['coverage'];
    f.input.plan.criteria.maxConfirmedErrors = 999;
    expect(() => evaluateExtractionStudyReview(f.input)).toThrow('reference coverage');
    coverage.verdict = 'correct'; coverage.errorCodes = [];
    const obligation = f.receipt.decisions.find(value => value.target.itemKind === 'knowledge_obligation')!;
    obligation.verdict = 'incorrect'; obligation.errorCodes = ['coverage'];
    expect(() => evaluateExtractionStudyReview(f.input)).toThrow('declared obligation');
    expect(() => evaluateExtractionStudyReview({ ...f.input, plan: { ...f.input.plan, repeats: Number.MAX_SAFE_INTEGER } })).toThrow('exact predeclared');
  });

  it('accepts explicit full negative reference sets but never calls unannotated sources accepted', () => {
    const f = studyFixture(true);
    expect(f.corpus.cases[0].reference.entities).toEqual([]);
    expect(evaluateExtractionStudyReview(f.input)).toMatchObject({ status: 'accepted_within_scope', slots: [{ metrics: { entities: { outputCount: 0, referenceCount: 0, precision: null, recall: null } } }, {}] });
    f.input.corpus.cases[0].reference.annotationScope = 'unannotated'; refresh(f);
    expect(evaluateExtractionStudyReview(f.input).status).toBe('exploratory_reviewed');
  });

  it('reports full-reference omissions as false negatives and zero F1 even when precision has no output denominator', () => {
    const f = studyFixture();
    for (const slot of f.input.slots) {
      slot.run!.entityAnalysis!.revision.entities = []; slot.run!.entityAnalysis!.revision.mentions = [];
      slot.run!.intents = []; slot.run!.committed = [];
    }
    f.receipt.decisions = f.receipt.decisions.filter(value => !['entity', 'mention', 'statement'].includes(value.target.itemKind));
    for (const decision of f.receipt.decisions) if (['reference_entity', 'reference_mention', 'knowledge_obligation'].includes(decision.target.itemKind)) {
      decision.verdict = 'required_missing';
    }
    const report = evaluateExtractionStudyReview(f.input);
    expect(report.slots[0].metrics.entities).toMatchObject({ truePositive: 0, falsePositive: 0, falseNegative: 2, precision: null, recall: 0, f1: 0 });
    expect(report.variants.every(value => value.blockers.includes('required_gap_threshold'))).toBe(true);
  });

  it('keeps human readiness, full annotation and complete native captures separate', () => {
    const f = studyFixture(); delete f.input.referenceReceipt;
    expect(evaluateExtractionStudyReview(f.input)).toMatchObject({ status: 'exploratory_reviewed', reference: { goldReady: false } });
    expect(evaluateExtractionStudyReview(f.input).slots[0].metrics.entities.precision).toBeNull();
    f.input.referenceReceipt = f.referenceReceipt; f.receipt.reviewer = { actorKind: 'agent', actorId: 'agent' }; f.receipt.independentHuman = false;
    f.receipt.judgeIdentity = studyJudgeIdentity();
    expect(evaluateExtractionStudyReview(f.input).slots[0].metrics.entities.precision).toBeNull();
    f.receipt.reviewer = { actorKind: 'human', actorId: 'fictional-independent-output-reader' }; f.receipt.independentHuman = true;
    delete f.receipt.judgeIdentity;
    f.input.corpus.cases[0].reference.annotationScope = 'critical_only'; refresh(f);
    expect(evaluateExtractionStudyReview(f.input).slots[0].metrics.entities).toMatchObject({ eligible: false, precision: null, recall: null, f1: null });
    f.input.slots[0].nativeVerified = false;
    expect(evaluateExtractionStudyReview(f.input).variants[0].blockers).toContain('native_evidence_unverified');
    f.input.integrity.outputVerified = false;
    expect(evaluateExtractionStudyReview(f.input).blockers).toContain('unverified_frozen_evidence');
  });

  it.each(['identity', 'provenance', 'unsupported_fact'] as const)('blocks critical %s in its own variant without hiding candidate results', code => {
    const f = studyFixture();
    const decision = f.receipt.decisions.find(value => value.target.itemKind === 'case' && value.target.slotId.startsWith('baseline'))!;
    decision.verdict = 'incorrect'; decision.errorCodes = [code];
    f.input.plan.criteria.maxConfirmedErrors = 999;
    const report = evaluateExtractionStudyReview(f.input);
    expect(report.variants).toMatchObject([{ variantId: 'baseline', status: 'blocked', blockers: ['critical_semantic_error'] }, { variantId: 'candidate', status: 'accepted_within_scope' }]);
    expect(report.slots).toHaveLength(2);
  });

  it('keeps missing targets, uncertain judgments and missing execution visible instead of shrinking denominators', () => {
    const f = studyFixture(); f.receipt.decisions.pop();
    let report = evaluateExtractionStudyReview(f.input);
    expect(report.status).toBe('pending'); expect(report.missingTargets).toHaveLength(1);
    expect(report.slots[1].metrics.entities).toMatchObject({ outputCount: 2, referenceCount: 2, precision: null });
    f.input.slots[1].run = null;
    f.receipt.decisions = f.receipt.decisions.filter(value => !['entity', 'mention', 'statement'].includes(value.target.itemKind) || !value.target.slotId.startsWith('candidate'));
    for (const decision of f.receipt.decisions) if (decision.target.slotId.startsWith('candidate')) decision.verdict = 'uncertain';
    report = evaluateExtractionStudyReview(f.input);
    expect(report.variants[1].blockers).toContain('capture_incomplete_or_failed');
    expect(report.slots[1].metrics.entities).toMatchObject({ eligible: false, referenceCount: 2, recall: null });
    expect(() => evaluateExtractionStudyReview({ ...f.input, slots: f.input.slots.slice(0, 1) })).toThrow('exact predeclared');
  });

  it('rejects dishonest one-to-one matches, wrong spans and missing-output reference approvals', () => {
    const f = studyFixture();
    const outputs = f.receipt.decisions.filter(value => value.target.slotId.startsWith('baseline') && value.target.itemKind === 'entity');
    outputs[1].referenceId = outputs[0].referenceId;
    expect(() => evaluateExtractionStudyReview(f.input)).toThrow('one-to-one');
    outputs[1].referenceId = 'entity-1';
    const mention = f.receipt.decisions.find(value => value.target.slotId.startsWith('baseline') && value.target.itemKind === 'mention')!;
    mention.referenceId = 'mention-1';
    expect(() => evaluateExtractionStudyReview(f.input)).toThrow(/one-to-one|exact reference span/);
    mention.referenceId = 'mention-0';
    outputs[0].verdict = 'uncertain'; outputs[0].referenceId = null;
    expect(() => evaluateExtractionStudyReview(f.input)).toThrow(/reviewed entity identity|explicit reviewed output match/);
  });

  it('rejects receipt substitutions, late references, false human roles, duplicate and unknown targets', () => {
    const f = studyFixture();
    expect(() => evaluateExtractionStudyReview({ ...f.input, outputReceipt: { ...f.receipt, outputDigest: extractionStudyDigest('other') } })).toThrow('identity');
    expect(() => evaluateExtractionStudyReview({ ...f.input, outputReceipt: { ...f.receipt, reviewer: { actorKind: 'agent', actorId: 'agent' } } })).toThrow('agent');
    expect(() => evaluateExtractionStudyReview({ ...f.input, referenceReceipt: { ...f.referenceReceipt, reviewedAt: '2020-02-10T00:00:00Z' } })).toThrow('precede outputs');
    expect(() => evaluateExtractionStudyReview({ ...f.input, referenceReceipt: { ...f.referenceReceipt, reviewer: { actorKind: 'human', actorId: 'author' } } })).toThrow('independence');
    f.receipt.decisions.push(f.receipt.decisions.find(value => value.target.itemKind === 'case')!); expect(() => evaluateExtractionStudyReview(f.input)).toThrow('Duplicate'); f.receipt.decisions.pop();
    f.receipt.decisions[0].target = { slotId: 'absent', itemKind: 'case' }; f.receipt.decisions[0].referenceId = null;
    expect(() => evaluateExtractionStudyReview(f.input)).toThrow('unknown');
  });

  it('requires versioned agent judge declarations and refuses conflicting roles or attempt identities', () => {
    const f = studyFixture(), identity = studyJudgeIdentity();
    const agent = { ...f.receipt, reviewer: { actorKind: 'agent', actorId: 'authored-judge' }, independentHuman: false };
    expect(() => evaluateExtractionStudyReview({ ...f.input, outputReceipt: agent })).toThrow('judgeIdentity');
    expect(() => evaluateExtractionStudyReview({ ...f.input, outputReceipt: { ...f.receipt, judgeIdentity: identity } })).toThrow('Human');
    const valid = { ...agent, judgeIdentity: identity };
    const report = evaluateExtractionStudyReview({ ...f.input, outputReceipt: valid });
    expect(report).toMatchObject({ status: 'exploratory_reviewed', outputReview: { independentHuman: false, judgeIdentity: identity } });
    expect(() => evaluateExtractionStudyReview({ ...f.input, outputReceipt: { ...valid, judgeIdentity: { ...identity, selectedAttemptId: 'other-attempt' } } })).toThrow('Selected judge attempt');
    expect(() => evaluateExtractionStudyReview({ ...f.input, outputReceipt: { ...valid, judgeIdentity: { ...identity, attempts: [identity.attempts[0], identity.attempts[0]] } } })).toThrow('Duplicate declared judge attempt');
    for (const field of ['executorRevision', 'modelRevision', 'promptVersion', 'promptDigest', 'configurationDigest'] as const) {
      const invalid = { ...identity, [field]: '' };
      expect(() => evaluateExtractionStudyReview({ ...f.input, outputReceipt: { ...valid, judgeIdentity: invalid } })).toThrow();
    }
    expect(() => evaluateExtractionStudyReview({ ...f.input, outputReceipt: { ...valid, judgeIdentity: { ...identity, nativeVerified: true } } })).toThrow();
    const changed = evaluateExtractionStudyReview({ ...f.input, outputReceipt: { ...valid, judgeIdentity: { ...identity, modelRevision: 'authored-model-r2' } } });
    expect(changed.reportId).not.toBe(report.reportId);
  });
});
