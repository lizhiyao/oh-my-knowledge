import { describe, expect, it } from 'vitest';
import { analyzeExtractionStudy, calibrateExtractionStudyJudge } from '../../src/knowledge/extraction/study-analysis.js';
import { extractionStudyDigest, freezeExtractionStudyCorpus } from '../../src/knowledge/extraction/study-corpus.js';
import type { ExtractionStudyDecision, ExtractionStudyOutputReceipt } from '../../src/knowledge/extraction/study-review.js';
import { studyFixture, studyJudgeIdentity } from './extraction-study-fixtures.js';

function wrong(decision: ExtractionStudyDecision, errorCodes: ExtractionStudyDecision['errorCodes']) {
  decision.verdict = 'incorrect'; decision.referenceId = null; decision.errorCodes = errorCodes;
}
function agentReceipt(receipt: ExtractionStudyOutputReceipt) {
  return { ...structuredClone(receipt), reviewer: { actorKind: 'agent' as const, actorId: 'authored-judge-fixture' }, independentHuman: false,
    judgeIdentity: studyJudgeIdentity() };
}

describe('finite extraction study analysis', () => {
  it('retains scoped matching denominators and paired lineage differences without inventing population confidence', () => {
    const f = studyFixture();
    for (const decision of f.receipt.decisions.filter(value => value.target.slotId.startsWith('baseline'))) {
      if (decision.referenceId === 'entity-0' || decision.referenceId === 'mention-0') wrong(decision, ['identity']);
      if ((decision.target.itemKind === 'reference_entity' || decision.target.itemKind === 'reference_mention')
        && ['entity-0', 'mention-0'].includes(decision.target.referenceId)) decision.verdict = 'required_missing';
    }
    const before = JSON.stringify(f.input), analysis = analyzeExtractionStudy(f.input);
    expect(analysis).toMatchObject({ analysisVersion: 'omk-extraction-study-analysis/v2', studyStatus: 'blocked', countingUnit: 'lineage-group', goldReady: true, independentHumanReview: true,
      assessment: { engineering: { plannedSlots: 2, completeNativeSlots: 2, structurallyRejectedSlots: 0 } } });
    expect(analysis.overall.arms[0]).toMatchObject({ variantId: 'baseline', plannedGroups: 1, errorGroups: 1, groupErrorRate: 1,
      scopedMetrics: { entities: { outputCount: 2, referenceCount: 2, truePositive: 1, falsePositive: 1, falseNegative: 1, precision: 0.5, recall: 0.5, f1: 0.5 } } });
    expect(analysis.overall.arms[1].scopedMetrics.entities).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(analysis.overall.paired).toMatchObject({ completePairs: 1, unknownPairs: 0, candidateMinusBaselineGroupErrorRate: -1,
      transitions: { bothClear: 0, bothError: 0, improved: 1, regressed: 0 }, confidenceInterval: null,
      scopedMetricDifferences: { countingUnit: 'lineage-group-macro-average', entities: { precision: 0.5, recall: 0.5, f1: 0.5 } } });
    expect(analysis.strata).toMatchObject([{ stratumId: 'work-record', plannedGroups: 1, paired: { candidateMinusBaselineGroupErrorRate: -1 } }]);
    expect(analysis.populationMetrics).toMatchObject({ precision: null, recall: null, f1: null, confidenceInterval: null });
    expect(analysis.overall.paired.confidenceIntervalReason).toContain('sampling_not_established');
    expect(analysis.reviewReportId).toMatch(/^sha256:/); expect(JSON.stringify(f.input)).toBe(before);
  });

  it.each(['reference', 'agent', 'partial', 'integrity'] as const)('keeps %s-limited evidence visible with null quality metrics', limitation => {
    const f = studyFixture();
    if (limitation === 'reference') delete f.input.referenceReceipt;
    if (limitation === 'agent') f.input.outputReceipt = agentReceipt(f.receipt);
    if (limitation === 'partial') {
      const { corpusDigest: _digest, ...body } = f.input.corpus; void _digest;
      body.cases[0].reference.annotationScope = 'critical_only'; f.input.corpus = freezeExtractionStudyCorpus(body);
      f.input.plan.corpusDigest = f.input.corpus.corpusDigest;
      f.authorReceipt.corpusDigest = f.input.corpus.corpusDigest; f.referenceReceipt.corpusDigest = f.input.corpus.corpusDigest;
    }
    if (limitation === 'integrity') f.input.integrity.outputVerified = false;
    const analysis = analyzeExtractionStudy(f.input);
    expect(analysis.overall.arms.every(arm => arm.groupErrorRate === null && arm.scopedMetrics.entities.precision === null
      && arm.scopedMetrics.entities.truePositive === null && arm.metricReasons.length)).toBe(true);
    expect(analysis.overall.paired).toMatchObject({ candidateMinusBaselineGroupErrorRate: null, transitions: null,
      scopedMetricDifferences: { entities: { precision: null, recall: null, f1: null } } });
    expect(analysis.overall.observedReviewDecisions).toMatchObject({ reviewed: f.receipt.decisions.length, unknown: 0 });
  });

  it.each(['baseline', 'candidate'])('retains the failed %s slot without hiding the other arm or scoring incomplete pairs', variantId => {
    const f = studyFixture(), failedIndex = variantId === 'baseline' ? 0 : 1, completeIndex = 1 - failedIndex;
    f.input.slots[failedIndex].run = null;
    f.receipt.decisions = f.receipt.decisions.filter(value => !value.target.slotId.startsWith(variantId)
      || !['entity', 'mention', 'statement'].includes(value.target.itemKind));
    for (const decision of f.receipt.decisions.filter(value => value.target.slotId.startsWith(variantId))) decision.verdict = 'uncertain';
    const analysis = analyzeExtractionStudy(f.input);
    expect(analysis.assessment.engineering).toMatchObject({ plannedSlots: 2, completeNativeSlots: 1 });
    expect(analysis.overall.groups[0].arms[failedIndex]).toMatchObject({ expectedSlots: 1, observedSlots: 0, complete: false, groupHasError: null });
    expect(analysis.overall.arms[failedIndex]).toMatchObject({ groupErrorRate: null, scopedMetrics: { entities: { precision: null, recall: null, f1: null } } });
    expect(analysis.overall.arms[completeIndex]).toMatchObject({ groupErrorRate: 0, metricReasons: [], scopedMetrics: { entities: { precision: 1, recall: 1, f1: 1 } } });
    expect(analysis.overall.paired).toMatchObject({ completePairs: 0, unknownPairs: 1, candidateMinusBaselineGroupErrorRate: null });
    expect(analysis.overall.observedReviewDecisions.unknown).toBeGreaterThan(0);
    expect(analysis.overall.arms[failedIndex].metricReasons).toContain('native_outputs_incomplete_or_failed');
    expect(analysis.strata[0].arms[completeIndex]).toMatchObject({ groupErrorRate: 0, metricReasons: [], scopedMetrics: { mentions: { f1: 1 } } });
  });

  it.each(['baseline', 'candidate'])('withholds the %s arm and paired metrics when completed-run time is unverified', variantId => {
    const f = studyFixture(), index = variantId === 'baseline' ? 0 : 1;
    delete f.input.slots[index].run!.finishedAt;
    const before = JSON.stringify(f.input), analysis = analyzeExtractionStudy(f.input);
    expect(analysis).toMatchObject({ analysisVersion: 'omk-extraction-study-analysis/v2', studyStatus: 'blocked', goldReady: true,
      completionTime: { verifiedCompletedSlots: 1, unverifiedSlotIds: [f.input.slots[index].slotId] } });
    const arm = analysis.overall.arms[index], other = analysis.overall.arms[1 - index];
    expect(arm).toMatchObject({ completeGroups: 0, errorGroups: null, groupErrorRate: null, scopedMetrics: { entities: { eligible: false, f1: null } } });
    expect(arm.metricReasons).toContain('completion_time_unverified');
    expect(other).toMatchObject({ completeGroups: 1, groupErrorRate: 0, scopedMetrics: { mentions: { eligible: true, f1: 1 } } });
    expect(analysis.overall.paired).toMatchObject({ completePairs: 0, unknownPairs: 1, transitions: null,
      candidateMinusBaselineGroupErrorRate: null, scopedMetricDifferences: { entities: { f1: null }, mentions: { f1: null } } });
    expect(analysis.strata[0].arms[index].metricReasons).toContain('completion_time_unverified');
    expect(JSON.stringify(f.input)).toBe(before);
  });

  it('preserves explicit zero denominators instead of reporting perfect precision for empty negative cases', () => {
    const analysis = analyzeExtractionStudy(studyFixture(true).input);
    expect(analysis.overall.arms[0]).toMatchObject({ errorGroups: 0, groupErrorRate: 0,
      scopedMetrics: { entities: { outputCount: 0, referenceCount: 0, precision: null, recall: null, f1: null, metricReason: 'no_metric_denominator' } } });
    expect(analysis.overall.paired).toMatchObject({ candidateMinusBaselineGroupErrorRate: 0,
      scopedMetricDifferences: { entities: { precision: null, recall: null, f1: null } } });
  });

  it.each(['no_outputs', 'no_references'] as const)('keeps finite F1 zero with %s and a nonzero opposite denominator', side => {
    const f = studyFixture();
    if (side === 'no_outputs') {
      for (const slot of f.input.slots) {
        slot.run!.entityAnalysis!.revision.entities = []; slot.run!.entityAnalysis!.revision.mentions = [];
        slot.run!.intents = []; slot.run!.committed = [];
      }
      f.receipt.decisions = f.receipt.decisions.filter(decision => !['entity', 'mention', 'statement'].includes(decision.target.itemKind));
      for (const decision of f.receipt.decisions) if (['reference_entity', 'reference_mention', 'knowledge_obligation'].includes(decision.target.itemKind)) decision.verdict = 'required_missing';
    } else {
      const { corpusDigest: _digest, ...body } = f.input.corpus; void _digest;
      const reference = body.cases[0].reference; reference.entities = []; reference.mentions = []; reference.knowledge = [];
      f.input.corpus = freezeExtractionStudyCorpus(body); f.input.plan.corpusDigest = f.input.corpus.corpusDigest;
      f.authorReceipt.corpusDigest = f.input.corpus.corpusDigest; f.referenceReceipt.corpusDigest = f.input.corpus.corpusDigest;
      f.receipt.decisions = f.receipt.decisions.filter(decision => !['reference_entity', 'reference_mention', 'knowledge_obligation'].includes(decision.target.itemKind));
      for (const decision of f.receipt.decisions) if (['entity', 'mention', 'statement'].includes(decision.target.itemKind)) wrong(decision, ['unsupported_fact']);
    }
    const analysis = analyzeExtractionStudy(f.input), metrics = analysis.overall.arms[0].scopedMetrics.entities;
    expect(metrics).toMatchObject({ eligible: true, matchedCount: 0, f1: 0 });
    expect(side === 'no_outputs' ? metrics.precision : metrics.recall).toBeNull();
    expect(side === 'no_outputs' ? metrics.recall : metrics.precision).toBe(0);
    expect(analysis.overall.paired.scopedMetricDifferences.entities.f1).toBe(0);
  });
});

describe('saved AI judge calibration', () => {
  it('counts multi-label false positives and critical misses even when reviewed candidates are blocked', () => {
    const f = studyFixture(), judge = agentReceipt(f.receipt);
    judge.judgeIdentity.attempts[0].usage = { durationMs: 2, inputTokens: 3, outputTokens: 5, costUSD: 0.25 };
    judge.judgeIdentity.attempts.push({ ...structuredClone(judge.judgeIdentity.attempts[0]), attemptId: 'authored-extra-failed-attempt',
      attemptStatus: 'failed', outputEvidence: null, usage: { durationMs: null, inputTokens: null, outputTokens: null, costUSD: null } });
    const humanBaseline = f.receipt.decisions.find(value => value.target.itemKind === 'case' && value.target.slotId.startsWith('baseline'))!;
    const humanCandidate = f.receipt.decisions.find(value => value.target.itemKind === 'case' && value.target.slotId.startsWith('candidate'))!;
    const judgeCandidate = judge.decisions.find(value => value.target.itemKind === 'case' && value.target.slotId.startsWith('candidate'))!;
    wrong(humanBaseline, ['identity']); wrong(humanCandidate, ['conditions']); wrong(judgeCandidate, ['conditions', 'scope']);
    const calibration = calibrateExtractionStudyJudge({ ...f.input, judgeReceipt: judge, humanReceipt: f.receipt });
    expect(calibration).toMatchObject({ calibrationVersion: 'omk-extraction-study-judge-calibration/v2', ready: true, status: 'ready', unknownOrMissingTargets: 0,
      judgeAcceptance: { status: 'not_assessed' }, confidenceInterval: null,
      judgeEvidence: { identity: { modelRevision: 'authored-model-r1', promptVersion: 'authored-judge-prompt/v1',
        evidenceScope: 'reviewer-declared;not-native-verified/v1', attempts: [{ attemptStatus: 'completed' }, { attemptStatus: 'failed' }] },
      nativeVerification: 'not_performed', declaredAttemptCount: 2,
      usage: { costUSD: { total: null, knownTotal: 0.25, unknownAttempts: 1 }, inputTokens: { total: null, knownTotal: 3, unknownAttempts: 1 } } } });
    expect(calibration.byClass.find(row => row.errorCode === 'identity')).toMatchObject({ observed: { tp: 0, fp: 0, fn: 1 }, recall: 0, precision: null, precisionReason: 'no_predicted_positives', f1: 0 });
    expect(calibration.byClass.find(row => row.errorCode === 'conditions')).toMatchObject({ observed: { tp: 1, fp: 0, fn: 0 }, precision: 1, recall: 1, f1: 1 });
    expect(calibration.byClass.find(row => row.errorCode === 'scope')).toMatchObject({ observed: { tp: 0, fp: 1, fn: 0 }, precision: 0, recall: null, recallReason: 'no_reference_positives' });
    expect(calibration.criticalMisses).toEqual([{ target: humanBaseline.target, errorCodes: ['identity'], judgeVerdict: 'correct', detectionStatus: 'known_miss' }]);
    expect(calibration.humanReviewReportId).toMatch(/^sha256:/); expect(calibration.judgeReviewReportId).not.toBe(calibration.humanReviewReportId);
  });

  it('keeps observed judgments but prevents calibration readiness and rates without completed-run time', () => {
    const f = studyFixture(), judge = agentReceipt(f.receipt);
    delete f.input.slots[0].run!.finishedAt;
    const before = JSON.stringify(f.input), calibration = calibrateExtractionStudyJudge({ ...f.input, judgeReceipt: judge, humanReceipt: f.receipt });
    expect(calibration).toMatchObject({ calibrationVersion: 'omk-extraction-study-judge-calibration/v2', ready: false, status: 'pending',
      knownComparedTargets: f.receipt.decisions.length, unknownOrMissingTargets: 0,
      completionTime: { unverifiedSlotIds: [f.input.slots[0].slotId] } });
    expect(calibration.reasons).toContain('completion_time_unverified');
    expect(calibration.byClass.every(row => row.observed !== null && row.precision === null && row.recall === null && row.f1 === null
      && row.metricReasons.includes('completion_time_unverified'))).toBe(true);
    expect(JSON.stringify(f.input)).toBe(before);
  });

  it('never treats missing human or uncertain AI judgments as correct and rejects substituted evidence', () => {
    const f = studyFixture(), judge = agentReceipt(f.receipt);
    const missing = calibrateExtractionStudyJudge({ ...f.input, judgeReceipt: judge });
    expect(missing).toMatchObject({ ready: false, status: 'pending', knownComparedTargets: 0 });
    expect(missing.reasons).toContain('human_receipt_missing');
    expect(missing.judgeEvidence.usage.costUSD).toEqual({ total: null, knownTotal: null, unknownAttempts: 1 });
    expect(missing.byClass.every(row => row.observed === null && row.precision === null && row.recall === null && row.f1 === null)).toBe(true);
    const humanCase = f.receipt.decisions.find(value => value.target.itemKind === 'case')!;
    wrong(humanCase, ['provenance']);
    const unknown = judge.decisions.find(value => value.target.slotId === humanCase.target.slotId && value.target.itemKind === 'case')!;
    unknown.verdict = 'uncertain';
    const partial = calibrateExtractionStudyJudge({ ...f.input, judgeReceipt: judge, humanReceipt: f.receipt });
    expect(partial).toMatchObject({ ready: false, unknownOrMissingTargets: 1 });
    expect(partial.byClass.every(row => row.precision === null && row.recall === null && row.f1 === null)).toBe(true);
    expect(partial.criticalMisses).toEqual([{ target: humanCase.target, errorCodes: ['provenance'], judgeVerdict: 'uncertain', detectionStatus: 'judge_unknown' }]);
    expect(() => calibrateExtractionStudyJudge({ ...f.input, humanReceipt: f.receipt,
      judgeReceipt: { ...judge, outputDigest: extractionStudyDigest('substituted capture') } })).toThrow('identity');
    expect(calibrateExtractionStudyJudge({ ...f.input, judgeReceipt: f.receipt, humanReceipt: f.receipt }).reasons).toContain('agent_judge_receipt_required');
  });
});
