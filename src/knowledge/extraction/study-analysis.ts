import { canonicalJson } from '../store.js';
import type { ExtractionStudyCase } from './study-corpus.js';
import { evaluateExtractionStudyReview, STUDY_SEMANTIC_ERROR_CODES, STUDY_CRITICAL_ERROR_CODES } from './study-review.js';
import type { ExtractionStudyReviewInput } from './study-review.js';

type Review = ReturnType<typeof evaluateExtractionStudyReview>;
type Decision = Review['decisions'][number];
type Target = Review['targets'][number];
type MatchingMetrics = Review['slots'][number]['metrics']['entities'];
const known = (decision: Decision | undefined) => !!decision && decision.verdict !== 'uncertain';
const error = (decision: Decision) => decision.verdict === 'incorrect' || decision.verdict === 'required_missing';
const codes = (decision: Decision) => decision.verdict === 'incorrect' ? decision.errorCodes
  : decision.verdict === 'required_missing' ? ['coverage'] : [];

function aggregateMatchingMetrics(rows: readonly MatchingMetrics[], eligible: boolean) {
  const outputCount = rows.reduce((sum, row) => sum + row.outputCount, 0);
  const referenceCount = rows.reduce((sum, row) => sum + row.referenceCount, 0);
  const matchedCount = rows.reduce((sum, row) => sum + row.matchedCount, 0);
  const ready = eligible && rows.length > 0 && rows.every(row => row.eligible);
  const precision = ready && outputCount ? matchedCount / outputCount : null;
  const recall = ready && referenceCount ? matchedCount / referenceCount : null;
  return { outputCount, referenceCount, matchedCount, eligible: ready, precision, recall,
    truePositive: ready ? matchedCount : null, falsePositive: ready ? outputCount - matchedCount : null,
    falseNegative: ready ? referenceCount - matchedCount : null,
    f1: ready && outputCount + referenceCount > 0 ? 2 * matchedCount / (outputCount + referenceCount) : null,
    metricReason: !ready ? 'incomplete_independent_full_review' : !outputCount || !referenceCount ? 'no_metric_denominator' : null };
}

/** Related mentions, statements and repeats are never treated as independent samples. */
export function analyzeExtractionStudy(input: ExtractionStudyReviewInput) {
  const review = evaluateExtractionStudyReview(input);
  const variantIds = input.plan.variants.map(variant => variant.variantId);
  const cases = input.corpus.cases.filter(sample => input.plan.caseIds.includes(sample.caseId));
  const describe = (selected: readonly ExtractionStudyCase[]) => {
    const selectedIds = new Set(selected.map(sample => sample.caseId));
    const slots = input.slots.filter(slot => selectedIds.has(slot.caseId));
    const slotIds = new Set(slots.map(slot => slot.slotId));
    const targets = review.targets.filter(target => slotIds.has(target.slotId));
    const decisions = review.decisions.filter(decision => slotIds.has(decision.target.slotId));
    const byTarget = new Map(decisions.map(decision => [canonicalJson(decision.target), decision]));
    const lineageIds = [...new Set(selected.map(sample => sample.lineageGroup))].sort();
    const commonReasons = (() => {
      const reasons: string[] = [];
      if (!review.reference.goldReady) reasons.push('reference_not_ready');
      if (!review.outputReview.independentHuman) reasons.push('independent_human_output_review_missing');
      if (!input.integrity.planVerified || !input.integrity.outputVerified) reasons.push('unverified_frozen_evidence');
      if (selected.some(sample => sample.reference.annotationScope !== 'full')) reasons.push('full_reference_annotations_missing');
      return reasons;
    })();
    const armReasons = new Map(variantIds.map(variantId => {
      const reasons = [...commonReasons], armSlots = slots.filter(slot => slot.variantId === variantId);
      const armIds = new Set(armSlots.map(slot => slot.slotId));
      if (armSlots.length !== selected.length * input.plan.repeats
        || armSlots.some(slot => !slot.nativeVerified || slot.run?.status !== 'completed')) reasons.push('native_outputs_incomplete_or_failed');
      if (targets.some(target => armIds.has(target.slotId) && !known(byTarget.get(canonicalJson(target))))) reasons.push('review_targets_missing_or_uncertain');
      return [variantId, reasons] as const;
    }));
    const metricReasons = [...new Set([...armReasons.values()].flat())];
    const groups = lineageIds.map(lineageGroup => {
      const groupCases = selected.filter(sample => sample.lineageGroup === lineageGroup);
      const caseIds = new Set(groupCases.map(sample => sample.caseId));
      const arms = variantIds.map(variantId => {
        const armSlots = slots.filter(slot => caseIds.has(slot.caseId) && slot.variantId === variantId);
        const armIds = new Set(armSlots.map(slot => slot.slotId));
        const armTargets = targets.filter(target => armIds.has(target.slotId));
        const armDecisions = decisions.filter(decision => armIds.has(decision.target.slotId));
        const expectedSlots = groupCases.length * input.plan.repeats;
        const complete = armSlots.length === expectedSlots && armSlots.every(slot => slot.nativeVerified && slot.run?.status === 'completed')
          && armTargets.every(target => known(byTarget.get(canonicalJson(target))));
        const eligible = review.reference.goldReady && review.outputReview.independentHuman && input.integrity.planVerified && input.integrity.outputVerified
          && groupCases.every(sample => sample.reference.annotationScope === 'full') && complete;
        const metricRows = review.slots.filter(slot => armIds.has(slot.slotId));
        return { variantId, expectedSlots, observedSlots: armSlots.filter(slot => slot.run !== null).length,
          complete, observedErrorDecisions: armDecisions.filter(error).length,
          hasObservedError: armDecisions.some(error),
          scopedMetrics: { entities: aggregateMatchingMetrics(metricRows.map(row => row.metrics.entities), eligible),
            mentions: aggregateMatchingMetrics(metricRows.map(row => row.metrics.mentions), eligible) },
          groupHasError: eligible ? armDecisions.some(error) : null };
      });
      return { lineageGroup, caseIds: [...caseIds].sort(),
        projectGroups: [...new Set(groupCases.map(sample => sample.projectGroup))].sort(),
        conversationGroups: [...new Set(groupCases.map(sample => sample.conversationGroup))].sort(), arms };
    });
    const arms = variantIds.map(variantId => {
      const rows = groups.map(group => group.arms.find(arm => arm.variantId === variantId)!);
      const errorGroups = rows.filter(row => row.groupHasError === true).length;
      const reasons = armReasons.get(variantId)!;
      const ready = !reasons.length && rows.length > 0 && rows.every(row => row.groupHasError !== null);
      const metricRows = review.slots.filter(slot => slotIds.has(slot.slotId) && slot.variantId === variantId);
      return { variantId, plannedGroups: rows.length, completeGroups: rows.filter(row => row.complete).length,
        observedErrorDecisions: rows.reduce((sum, row) => sum + row.observedErrorDecisions, 0),
        errorGroups: ready ? errorGroups : null, groupErrorRate: ready ? errorGroups / rows.length : null,
        scopedMetrics: { entities: aggregateMatchingMetrics(metricRows.map(row => row.metrics.entities), ready),
          mentions: aggregateMatchingMetrics(metricRows.map(row => row.metrics.mentions), ready) },
        metricReasons: ready ? [] : reasons.length ? reasons : ['no_complete_groups'] };
    });
    const [baselineVariantId, candidateVariantId] = variantIds;
    const transitions = { bothClear: 0, bothError: 0, improved: 0, regressed: 0 };
    let completePairs = 0;
    for (const group of groups) {
      const baseline = group.arms.find(arm => arm.variantId === baselineVariantId), candidate = group.arms.find(arm => arm.variantId === candidateVariantId);
      if (!baseline || !candidate || baseline.groupHasError === null || candidate.groupHasError === null) continue;
      completePairs++;
      if (!baseline.groupHasError && !candidate.groupHasError) transitions.bothClear++;
      else if (baseline.groupHasError && candidate.groupHasError) transitions.bothError++;
      else if (baseline.groupHasError) transitions.improved++;
      else transitions.regressed++;
    }
    const pairedReady = variantIds.length === 2 && !metricReasons.length && groups.length > 0 && completePairs === groups.length;
    const pairedMetrics = (component: 'entities' | 'mentions') => {
      const difference = (metric: 'precision' | 'recall' | 'f1') => {
        const pairs = groups.map(group => [group.arms.find(arm => arm.variantId === baselineVariantId)?.scopedMetrics[component][metric],
          group.arms.find(arm => arm.variantId === candidateVariantId)?.scopedMetrics[component][metric]]);
        return pairedReady && pairs.every(pair => pair.every(value => typeof value === 'number'))
          ? pairs.reduce((sum, pair) => sum + pair[1]! - pair[0]!, 0) / pairs.length : null;
      };
      return { precision: difference('precision'), recall: difference('recall'), f1: difference('f1'),
        metricReason: !pairedReady ? 'incomplete_independent_full_pairs' : groups.some(group => group.arms.some(arm => arm.scopedMetrics[component].metricReason)) ? 'undefined_metric_in_planned_group' : null };
    };
    return { cases: selected.length, plannedGroups: groups.length, groups, arms,
      observedReviewDecisions: { expected: targets.length, reviewed: decisions.length,
        confirmedErrors: decisions.filter(decision => decision.verdict === 'incorrect').length,
        requiredMissing: decisions.filter(decision => decision.verdict === 'required_missing').length,
        unknown: targets.filter(target => !known(byTarget.get(canonicalJson(target)))).length },
      paired: { baselineVariantId: baselineVariantId ?? null, candidateVariantId: candidateVariantId ?? null,
        completePairs, unknownPairs: groups.length - completePairs,
        knownPairTransitions: completePairs ? transitions : null,
        transitions: pairedReady ? transitions : null,
        candidateMinusBaselineGroupErrorRate: pairedReady ? (transitions.regressed - transitions.improved) / groups.length : null,
        scopedMetricDifferences: { countingUnit: 'lineage-group-macro-average' as const,
          entities: pairedMetrics('entities'), mentions: pairedMetrics('mentions') },
        metricReasons: pairedReady ? [] : variantIds.length !== 2 ? ['two_variants_required'] : metricReasons.length ? metricReasons : ['incomplete_pairs'],
        confidenceInterval: null, confidenceIntervalReason: 'independent_exchangeable_group_sampling_not_established' },
    };
  };
  return { analysisVersion: 'omk-extraction-study-analysis/v1' as const, planId: input.plan.planId, outputDigest: input.outputDigest,
    reviewReportId: review.reportId,
    studyStatus: review.status, goldReady: review.reference.goldReady, independentHumanReview: review.outputReview.independentHuman,
    assessment: { engineering: { ...input.integrity, plannedSlots: input.plan.slots.length,
      completeNativeSlots: input.slots.filter(slot => slot.run?.status === 'completed' && slot.nativeVerified).length,
      structurallyRejectedSlots: input.slots.filter(slot => slot.run && (slot.run.rejections.length || slot.run.entityRejections?.length)).length },
      semantic: { status: review.status, reviewer: review.outputReview.reviewer, blockers: review.blockers } },
    variants: review.variants,
    slots: review.slots,
    countingUnit: 'lineage-group' as const, scope: 'frozen-real-study' as const,
    overall: describe(cases), strata: [...new Set(cases.map(sample => sample.stratumId))].sort()
      .map(stratumId => ({ stratumId, ...describe(cases.filter(sample => sample.stratumId === stratumId)) })),
    populationMetrics: { precision: null, recall: null, f1: null, confidenceInterval: null,
      reason: 'finite_selected_sources_do_not_establish_population_sampling' },
    limits: [
      'All planned cases, variants and repeats remain in scope. Missing, uncertain or unreviewed targets are not correct outcomes.',
      'Lineage groups are descriptive units, not asserted independent or exchangeable samples; no population confidence interval is estimated.',
      'A group has an error when any reviewed target is incorrect or required-missing; correlated decisions are not independent error incidents.',
      'A lineage can occur in several strata. Stratum summaries overlap and must not be added as independent groups.',
      'Candidate minus baseline differences describe these frozen groups only; no causal or population improvement is established.',
      'Scoped matching metrics pool birth output and reference occurrences, including planned repeats. Paired metric differences give equal weight to lineage groups.',
    ] };
}

export interface ExtractionStudyCalibrationInput extends Omit<ExtractionStudyReviewInput, 'outputReceipt'> {
  judgeReceipt?: unknown; humanReceipt?: unknown;
}

/** Calibrate actual saved AI judgments against independent human labels, including failed candidates. */
export function calibrateExtractionStudyJudge(input: ExtractionStudyCalibrationInput) {
  const judge = evaluateExtractionStudyReview({ ...input, outputReceipt: input.judgeReceipt });
  const human = evaluateExtractionStudyReview({ ...input, outputReceipt: input.humanReceipt });
  const judgeIdentity = judge.outputReview.judgeIdentity;
  const declaredAttempts = judgeIdentity?.attempts ?? [];
  const usage = (field: 'durationMs' | 'inputTokens' | 'outputTokens' | 'costUSD') => {
    const values = declaredAttempts.map(attempt => attempt.usage[field]), observed = values.filter((value): value is number => value !== null);
    const sum = observed.reduce((sum, value) => sum + value, 0);
    const knownTotal = observed.length && Number.isFinite(sum) && (!field.endsWith('Tokens') || Number.isSafeInteger(sum)) ? sum : null;
    const unknownAttempts = values.filter(value => value === null).length;
    return { knownTotal, unknownAttempts, total: declaredAttempts.length && !unknownAttempts ? knownTotal : null };
  };
  const byJudge = new Map(judge.decisions.map(decision => [canonicalJson(decision.target), decision]));
  const byHuman = new Map(human.decisions.map(decision => [canonicalJson(decision.target), decision]));
  const eligibleHuman = human.reference.goldReady && human.outputReview.independentHuman;
  const pairs = human.targets.map(target => ({ target, judge: byJudge.get(canonicalJson(target)), human: byHuman.get(canonicalJson(target)) }));
  const compared = pairs.filter((pair): pair is { target: Target; judge: Decision; human: Decision } => eligibleHuman && known(pair.judge) && known(pair.human));
  const reasons: string[] = [];
  if (!input.judgeReceipt) reasons.push('judge_receipt_missing');
  if (!input.humanReceipt) reasons.push('human_receipt_missing');
  if (judge.outputReview.reviewer?.actorKind !== 'agent') reasons.push('agent_judge_receipt_required');
  if (!human.reference.goldReady) reasons.push('reference_not_ready');
  if (!human.outputReview.independentHuman) reasons.push('independent_human_output_review_missing');
  if (input.corpus.cases.some(sample => input.plan.caseIds.includes(sample.caseId) && sample.reference.annotationScope !== 'full')) reasons.push('full_reference_annotations_missing');
  if (!input.integrity.planVerified || !input.integrity.outputVerified) reasons.push('unverified_frozen_evidence');
  if (input.slots.length !== input.plan.caseIds.length * input.plan.variants.length * input.plan.repeats
    || input.slots.some(slot => !slot.nativeVerified || slot.run?.status !== 'completed')) reasons.push('native_outputs_incomplete_or_failed');
  if (compared.length !== pairs.length) reasons.push('review_targets_missing_or_uncertain');
  const ready = reasons.length === 0 && pairs.length > 0;
  const byClass = STUDY_SEMANTIC_ERROR_CODES.map(errorCode => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const pair of compared) {
      const predicted = codes(pair.judge).includes(errorCode), actual = codes(pair.human).includes(errorCode);
      if (predicted && actual) tp++; else if (predicted) fp++; else if (actual) fn++; else tn++;
    }
    const precision = ready && tp + fp ? tp / (tp + fp) : null;
    const recall = ready && tp + fn ? tp / (tp + fn) : null;
    return { errorCode, observed: compared.length ? { tp, fp, fn, tn } : null,
      precision, recall, f1: ready && 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : null,
      precisionReason: precision === null ? ready ? 'no_predicted_positives' : 'calibration_not_ready' : null,
      recallReason: recall === null ? ready ? 'no_reference_positives' : 'calibration_not_ready' : null,
      metricReasons: ready ? tp + fp + fn ? [] : ['no_positive_reference_or_prediction'] : reasons };
  });
  const criticalMisses = pairs.flatMap(pair => {
    if (!eligibleHuman || !known(pair.human)) return [];
    const missedCodes = codes(pair.human!).filter(code => (STUDY_CRITICAL_ERROR_CODES as readonly string[]).includes(code)
      && (!known(pair.judge) || !codes(pair.judge!).includes(code)));
    return missedCodes.length ? [{ target: pair.target, errorCodes: missedCodes, judgeVerdict: pair.judge?.verdict ?? null,
      detectionStatus: known(pair.judge) ? 'known_miss' as const : 'judge_unknown' as const }] : [];
  });
  return { calibrationVersion: 'omk-extraction-study-judge-calibration/v1' as const,
    planId: input.plan.planId, outputDigest: input.outputDigest, ready, reasons,
    judgeReviewReportId: judge.reportId, humanReviewReportId: human.reportId,
    judgeEvidence: { identity: judgeIdentity, evidenceStatus: judgeIdentity ? 'reviewer_declared' as const : 'missing' as const,
      nativeVerification: 'not_performed' as const, declaredAttemptCount: judgeIdentity ? declaredAttempts.length : null,
      usage: { durationMs: usage('durationMs'), inputTokens: usage('inputTokens'), outputTokens: usage('outputTokens'), costUSD: usage('costUSD') } },
    status: ready ? 'ready' as const : 'pending' as const, countingUnit: 'paired-review-target' as const,
    judgeAcceptance: { status: 'not_assessed' as const, reason: 'calibration_acceptance_criteria_not_predeclared' },
    expectedTargets: pairs.length, knownComparedTargets: compared.length, unknownOrMissingTargets: pairs.length - compared.length,
    byClass, criticalMisses,
    confidenceInterval: null, confidenceIntervalReason: 'correlated_targets_are_not_independent_samples',
    limits: [
      'These are multi-label detection counts over matched saved review targets, not independent error incidents or population estimates.',
      'Unknown or absent judgments are excluded from observed pairs and never imputed as correct; full metrics remain null until ready.',
      'Readiness validates evidence coverage and declared reviewer independence; it neither authenticates a human nor requires the candidate to pass quality acceptance.',
      'Judge identity, revisions, prompt/configuration digests, artifact references and usage are reviewer declarations; no judge executor or native artifact verification runs here.',
    ] };
}
