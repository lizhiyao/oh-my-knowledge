import { z } from 'zod';
import { canonicalJson } from '../store.js';
import { validateEvidenceSelection } from '../validation.js';
import { ExtractionRunSchema, type ExtractionRun } from './runs.js';
import { ExtractionStudyDigestSchema, extractionStudyDigest, parseExtractionStudyCorpus, type ExtractionStudyCorpus } from './study-corpus.js';
import { locateQuoteOccurrence } from './quote-occurrence.js';

export interface ExtractionStudySlot {
  slotId: string; caseId: string; variantId: string; repeat: number;
  run: ExtractionRun | null; nativeVerified: boolean;
}
export interface ExtractionStudyReviewPlan {
  planId: string; declaredAt: string; corpusDigest: string;
  split: 'development' | 'validation'; caseIds: readonly string[]; variants: readonly { variantId: string }[]; repeats: number;
  slots: readonly { slotId: string; caseId: string; variantId: string; repeat: number; runId: string }[];
  criteria: { maxConfirmedErrors: number; confirmedErrorsRationale: string; maxRequiredGaps: number; requiredGapsRationale: string };
}
export interface ExtractionStudyReviewInput {
  plan: ExtractionStudyReviewPlan; corpus: ExtractionStudyCorpus; slots: readonly ExtractionStudySlot[];
  outputDigest: string; integrity: { planVerified: boolean; outputVerified: boolean };
  authorReceipt?: unknown; referenceReceipt?: unknown; outputReceipt?: unknown; now: string;
}

const id = z.string().trim().min(1).max(256), text = z.string().trim().min(1).max(8192);
const time = z.iso.datetime({ offset: true });
const reviewer = z.strictObject({ actorKind: z.enum(['agent', 'human']), actorId: id });
export const ExtractionStudyReferenceReceiptSchema = z.strictObject({
  reviewVersion: z.literal('omk-extraction-study-reference-review/v1'), corpusDigest: ExtractionStudyDigestSchema,
  reviewer, reviewRole: z.enum(['author', 'independent']), independentHuman: z.boolean(), reviewedBeforeOutputs: z.literal(true), reviewedAt: time,
  decisions: z.array(z.strictObject({ caseId: id, verdict: z.enum(['approved', 'changes_requested', 'uncertain']), rationale: text })),
  disputes: z.array(z.strictObject({ caseId: id, question: text, resolution: text.nullable(), adjudicator: id.nullable() })),
}).superRefine((value, context) => {
  if (value.independentHuman && (value.reviewRole !== 'independent' || value.reviewer.actorKind !== 'human')) {
    context.addIssue({ code: 'custom', message: 'Only an independent human can attest independent reference review.' });
  }
});
export const STUDY_SEMANTIC_ERROR_CODES = ['scope', 'boundary', 'identity', 'referent_kind', 'unsupported_qualifier',
  'relation', 'polarity', 'modality', 'conditions', 'time', 'coverage', 'provenance', 'unsupported_fact'] as const;
export const STUDY_CRITICAL_ERROR_CODES = ['identity', 'provenance', 'unsupported_fact'] as const;
const targetBase = { slotId: id };
export const ExtractionStudyReviewTargetSchema = z.discriminatedUnion('itemKind', [
  z.strictObject({ ...targetBase, itemKind: z.literal('entity'), entityId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('mention'), mentionId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('statement'), knowledgeId: id, statementId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('reference_entity'), referenceId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('reference_mention'), referenceId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('knowledge_obligation'), referenceId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('semantic_check'), checkId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('case') }),
]);
export type ExtractionStudyReviewTarget = z.infer<typeof ExtractionStudyReviewTargetSchema>;
export const ExtractionStudyDecisionSchema = z.strictObject({
  target: ExtractionStudyReviewTargetSchema,
  verdict: z.enum(['correct', 'incorrect', 'uncertain', 'required_missing', 'optional_not_selected']),
  referenceId: id.nullable(), errorCodes: z.array(z.enum(STUDY_SEMANTIC_ERROR_CODES)), rationale: text,
}).superRefine((value, context) => {
  if (new Set(value.errorCodes).size !== value.errorCodes.length || ((value.verdict === 'incorrect') !== !!value.errorCodes.length)) {
    context.addIssue({ code: 'custom', message: 'Only incorrect judgments require unique semantic error codes.' });
  }
  if (value.referenceId !== null && (value.verdict !== 'correct' || !['entity', 'mention', 'statement'].includes(value.target.itemKind))) {
    context.addIssue({ code: 'custom', message: 'Reference matching belongs only to correct output judgments.' });
  }
});
export type ExtractionStudyDecision = z.infer<typeof ExtractionStudyDecisionSchema>;
const judgeEvidenceRef = z.strictObject({ reference: text, digest: ExtractionStudyDigestSchema });
const observedCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const observedMeasure = z.number().finite().nonnegative().nullable();
export const ExtractionStudyJudgeIdentitySchema = z.strictObject({
  identityVersion: z.literal('omk-extraction-study-judge-identity/v1'),
  evidenceScope: z.literal('reviewer-declared;not-native-verified/v1'),
  executor: id, executorRevision: text, model: id, modelRevision: text,
  promptVersion: id, promptDigest: ExtractionStudyDigestSchema, configurationDigest: ExtractionStudyDigestSchema,
  selectedAttemptId: id,
  attempts: z.array(z.strictObject({ attemptId: id, attemptStatus: z.enum(['completed', 'failed', 'unknown']),
    runEvidence: judgeEvidenceRef, outputEvidence: judgeEvidenceRef.nullable(),
    usage: z.strictObject({ durationMs: observedMeasure, inputTokens: observedCount, outputTokens: observedCount, costUSD: observedMeasure }),
  })).min(1),
}).superRefine((value, context) => {
  if (new Set(value.attempts.map(attempt => attempt.attemptId)).size !== value.attempts.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate declared judge attempt identity.' });
  }
  const selected = value.attempts.find(attempt => attempt.attemptId === value.selectedAttemptId);
  if (!selected || selected.attemptStatus !== 'completed' || !selected.outputEvidence
    || value.attempts.some(attempt => attempt.attemptStatus === 'completed' && !attempt.outputEvidence)) {
    context.addIssue({ code: 'custom', message: 'Selected judge attempt requires its completed output evidence.' });
  }
});
export type ExtractionStudyJudgeIdentity = z.infer<typeof ExtractionStudyJudgeIdentitySchema>;
export const ExtractionStudyOutputReceiptSchema = z.strictObject({
  reviewVersion: z.literal('omk-extraction-study-output-review/v1'), planId: ExtractionStudyDigestSchema, outputDigest: ExtractionStudyDigestSchema,
  reviewer, independentHuman: z.boolean(), reviewedAt: time, decisions: z.array(ExtractionStudyDecisionSchema),
  judgeIdentity: ExtractionStudyJudgeIdentitySchema.optional(),
}).superRefine((value, context) => {
  if (value.independentHuman && value.reviewer.actorKind !== 'human') context.addIssue({ code: 'custom', message: 'An agent cannot attest independent human output review.' });
  if (value.reviewer.actorKind === 'agent' && !value.judgeIdentity) context.addIssue({ code: 'custom', message: 'Agent output review requires a versioned judgeIdentity.' });
  if (value.reviewer.actorKind === 'human' && value.judgeIdentity) context.addIssue({ code: 'custom', message: 'Human output review cannot declare an agent judgeIdentity.' });
});
export type ExtractionStudyOutputReceipt = z.infer<typeof ExtractionStudyOutputReceiptSchema>;

export function extractionStudyReviewTargets(input: Pick<ExtractionStudyReviewInput, 'corpus' | 'slots'>): ExtractionStudyReviewTarget[] {
  const result: ExtractionStudyReviewTarget[] = [];
  for (const slot of input.slots) {
    const sample = input.corpus.cases.find(value => value.caseId === slot.caseId);
    if (!sample) throw new Error('Study slot references an unknown source.');
    const base = { slotId: slot.slotId }, birth = slot.run?.entityAnalysis?.revision;
    for (const entity of birth?.entities ?? []) result.push({ ...base, itemKind: 'entity', entityId: entity.entityId });
    for (const mention of birth?.mentions ?? []) result.push({ ...base, itemKind: 'mention', mentionId: mention.mentionId });
    for (const intent of slot.run?.intents ?? []) for (const statement of intent.revision.content.statements) {
      result.push({ ...base, itemKind: 'statement', knowledgeId: intent.revision.knowledgeId, statementId: statement.statementId });
    }
    for (const entity of sample.reference.entities) result.push({ ...base, itemKind: 'reference_entity', referenceId: entity.referenceId });
    for (const mention of sample.reference.mentions) result.push({ ...base, itemKind: 'reference_mention', referenceId: mention.referenceId });
    for (const knowledge of sample.reference.knowledge) result.push({ ...base, itemKind: 'knowledge_obligation', referenceId: knowledge.referenceId });
    for (const check of sample.reference.semanticChecks) result.push({ ...base, itemKind: 'semantic_check', checkId: check.checkId });
    result.push({ ...base, itemKind: 'case' });
  }
  if (new Set(result.map(value => canonicalJson(value))).size !== result.length) throw new Error('Duplicate study review target.');
  return result;
}

/** No decision, human identity, timestamp or attestation is filled on a reviewer's behalf. */
export function createExtractionStudyOutputTemplate(input: Pick<ExtractionStudyReviewInput, 'corpus' | 'slots' | 'outputDigest' | 'plan'>) {
  return { reviewVersion: 'omk-extraction-study-output-review/v1' as const, planId: input.plan.planId, outputDigest: input.outputDigest,
    reviewer: { actorKind: 'human' as const, actorId: '' }, independentHuman: false, reviewedAt: '',
    decisions: extractionStudyReviewTargets(input).map(target => ({ target, verdict: 'uncertain' as const, referenceId: null, errorCodes: [], rationale: '' })) };
}

function validateInput(input: ExtractionStudyReviewInput) {
  const corpus = parseExtractionStudyCorpus(input.corpus), plan = input.plan;
  ExtractionStudyDigestSchema.parse(plan.planId); ExtractionStudyDigestSchema.parse(input.outputDigest);
  time.parse(plan.declaredAt); time.parse(input.now);
  if (plan.corpusDigest !== corpus.corpusDigest || Date.parse(plan.declaredAt) > Date.parse(input.now)) throw new Error('Study plan source identity or declaration is invalid.');
  const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
  if (!plan.caseIds.length || !plan.variants.length || !Number.isSafeInteger(plan.repeats) || plan.repeats < 1
    || !unique(plan.caseIds) || !unique(plan.variants.map(value => value.variantId)) || !unique(plan.slots.map(value => value.slotId))) {
    throw new Error('Study plan selection or slot identity is invalid.');
  }
  if (BigInt(plan.caseIds.length) * BigInt(plan.variants.length) * BigInt(plan.repeats) !== BigInt(plan.slots.length)) {
    throw new Error('Study slots do not cover the exact predeclared selection.');
  }
  text.parse(plan.criteria.confirmedErrorsRationale); text.parse(plan.criteria.requiredGapsRationale);
  for (const value of [plan.criteria.maxConfirmedErrors, plan.criteria.maxRequiredGaps]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Study criteria must be explicit nonnegative integer counts.');
  }
  const expected = plan.caseIds.flatMap(caseId => plan.variants.flatMap(variant => Array.from({ length: plan.repeats }, (_, index) =>
    ({ caseId, variantId: variant.variantId, repeat: index + 1 }))));
  if (expected.some(value => !corpus.cases.some(sample => sample.caseId === value.caseId && sample.split === plan.split)) || expected.length !== plan.slots.length
    || expected.some(value => plan.slots.filter(slot => slot.caseId === value.caseId && slot.variantId === value.variantId && slot.repeat === value.repeat).length !== 1)
    || input.slots.length !== plan.slots.length || !unique(input.slots.map(value => value.slotId))) throw new Error('Study slots do not cover the exact predeclared selection.');
  const seenRuns = new Set<string>();
  for (const slot of input.slots) {
    const planned = plan.slots.find(value => value.slotId === slot.slotId), sample = corpus.cases.find(value => value.caseId === slot.caseId);
    if (!planned || !sample || slot.caseId !== planned.caseId || slot.variantId !== planned.variantId || slot.repeat !== planned.repeat) throw new Error('Study slot differs from its frozen plan.');
    if (!slot.run) continue;
    const run = ExtractionRunSchema.parse(slot.run);
    if (seenRuns.has(run.runId) || run.runId !== planned.runId || run.snapshotId !== sample.window.snapshotId || run.sourceVersion !== sample.window.sourceVersion
      || Date.parse(run.startedAt) > Date.parse(input.now) || (run.finishedAt && (Date.parse(run.finishedAt) > Date.parse(input.now)
        || Date.parse(run.finishedAt) < Date.parse(run.startedAt)))) throw new Error('Study run differs from its frozen source or slot.');
    seenRuns.add(run.runId);
    const selections = [...(run.entityAnalysis?.revision.mentions.map(value => value.selection) ?? []), ...run.intents.flatMap(value => value.grounding.citations.map(citation => citation.selection))];
    if (selections.some(value => validateEvidenceSelection(value, sample.window.excerpts).length)) throw new Error('Study run quote differs from its frozen source.');
  }
  return corpus;
}

function referenceStatus(input: ExtractionStudyReviewInput, corpus: ExtractionStudyCorpus) {
  const receipts = ([['author', input.authorReceipt], ['independent', input.referenceReceipt]] as const).flatMap(([role, value]) => {
    if (value === undefined) return [];
    const parsed = ExtractionStudyReferenceReceiptSchema.parse(value);
    if (parsed.reviewRole !== role) throw new Error('Study reference receipt is supplied for the wrong review phase.');
    return [parsed];
  });
  if (new Set(receipts.map(value => value.reviewRole)).size !== receipts.length) throw new Error('Duplicate study reference review role.');
  const firstOutput = Math.min(...input.slots.flatMap(slot => slot.run ? [Date.parse(slot.run.startedAt)] : []));
  for (const receipt of receipts) {
    if (receipt.corpusDigest !== corpus.corpusDigest || Date.parse(receipt.reviewedAt) > Date.parse(input.now)
      || Date.parse(receipt.reviewedAt) > firstOutput) throw new Error('Study reference review must bind frozen source and precede outputs.');
    const author = corpus.authors.some(value => value.toLowerCase() === receipt.reviewer.actorId.toLowerCase());
    if ((receipt.reviewRole === 'author') !== author || (receipt.reviewRole === 'independent' && receipt.independentHuman && receipt.reviewer.actorKind !== 'human')) throw new Error('Study reference reviewer independence is invalid.');
    if (receipt.decisions.length !== corpus.cases.length || new Set(receipt.decisions.map(value => value.caseId)).size !== corpus.cases.length
      || receipt.decisions.some(value => !corpus.cases.some(sample => sample.caseId === value.caseId))) throw new Error('Study reference review must cover every frozen case.');
    if (receipt.disputes.some(value => !corpus.cases.some(sample => sample.caseId === value.caseId)
      || (value.adjudicator && corpus.authors.some(authorId => authorId.toLowerCase() === value.adjudicator!.toLowerCase())))) throw new Error('Study reference dispute requires an independent adjudicator.');
  }
  const state = (role: 'author' | 'independent') => {
    const receipt = receipts.find(value => value.reviewRole === role);
    return !receipt ? 'pending' as const : receipt.decisions.some(value => value.verdict === 'changes_requested') ? 'changes_requested' as const
      : receipt.decisions.some(value => value.verdict === 'uncertain') || receipt.disputes.some(value => !value.resolution || !value.adjudicator) ? 'pending' as const
        : role === 'independent' && !receipt.independentHuman ? 'non_independent_reviewed' as const : 'completed' as const;
  };
  const authorReview = state('author'), independentReview = state('independent');
  return { authorReview, independentReview, goldReady: authorReview === 'completed' && independentReview === 'completed' };
}

/** Deterministic review accounting; reviewer judgments remain attestations rather than inferred truth. */
export function evaluateExtractionStudyReview(input: ExtractionStudyReviewInput) {
  const corpus = validateInput(input), targets = extractionStudyReviewTargets(input), reference = referenceStatus(input, corpus);
  const receipt = input.outputReceipt === undefined ? null : ExtractionStudyOutputReceiptSchema.parse(input.outputReceipt);
  const decisions = receipt?.decisions ?? [], byTarget = new Map(targets.map(value => [canonicalJson(value), value]));
  const seen = new Set<string>(), blockers: string[] = [];
  if (!input.integrity.planVerified || !input.integrity.outputVerified) blockers.push('unverified_frozen_evidence');
  if (input.slots.some(slot => !slot.run || slot.run.status !== 'completed')) blockers.push('capture_incomplete_or_failed');
  const unverifiedCompletionSlots = input.slots.filter(slot => slot.run?.status === 'completed' && !slot.run.finishedAt);
  if (unverifiedCompletionSlots.length) blockers.push('completion_time_unverified');
  if (input.slots.some(slot => slot.run && (!slot.nativeVerified || slot.run.attempts.some(attempt => !attempt.outcome)))) blockers.push('native_evidence_unverified');
  if (input.slots.some(slot => slot.run && (slot.run.rejections.length || slot.run.entityRejections?.length))) blockers.push('structural_rejection');
  if (input.slots.some(slot => slot.run && Date.parse(input.plan.declaredAt) > Date.parse(slot.run.startedAt))) blockers.push('plan_not_predeclared');
  if (reference.authorReview === 'changes_requested' || reference.independentReview === 'changes_requested') blockers.push('reference_changes_requested');
  if (receipt) {
    if (receipt.planId !== input.plan.planId || receipt.outputDigest !== input.outputDigest) throw new Error('Study output review evidence identity mismatch.');
    if (Date.parse(receipt.reviewedAt) > Date.parse(input.now) || input.slots.some(slot => slot.run && Date.parse(receipt.reviewedAt) < Date.parse(slot.run.finishedAt ?? slot.run.startedAt))) throw new Error('Study output review must follow the captured outputs.');
    if (receipt.independentHuman && corpus.authors.some(value => value.toLowerCase() === receipt.reviewer.actorId.toLowerCase())) throw new Error('Study author cannot attest independent output review.');
    for (const decision of decisions) {
      const key = canonicalJson(decision.target);
      if (seen.has(key) || !byTarget.has(key)) throw new Error('Duplicate or unknown study review target.');
      seen.add(key);
      validateDecision(decision, decisions, input, corpus);
    }
  }
  const forcedBlockingErrors = decisions.filter(value => value.verdict === 'incorrect' && value.errorCodes.some(code => (STUDY_CRITICAL_ERROR_CODES as readonly string[]).includes(code)));
  const confirmedErrors = decisions.filter(value => value.verdict === 'incorrect').length, requiredGaps = decisions.filter(value => value.verdict === 'required_missing').length;
  if (forcedBlockingErrors.length) blockers.push('critical_semantic_error');
  if (confirmedErrors > input.plan.criteria.maxConfirmedErrors) blockers.push('confirmed_error_threshold');
  if (requiredGaps > input.plan.criteria.maxRequiredGaps) blockers.push('required_gap_threshold');
  const missingTargets = targets.filter(value => !seen.has(canonicalJson(value))), uncertain = decisions.filter(value => value.verdict === 'uncertain').length;
  const independentHuman = !!receipt?.independentHuman && receipt.reviewer.actorKind === 'human';
  const annotationComplete = input.plan.caseIds.every(caseId => corpus.cases.find(value => value.caseId === caseId)!.reference.annotationScope !== 'unannotated');
  const status = blockers.length ? 'blocked' as const : !receipt || missingTargets.length || uncertain ? 'pending' as const
    : reference.goldReady && independentHuman && annotationComplete ? 'accepted_within_scope' as const : 'exploratory_reviewed' as const;
  const slots = input.slots.map(slot => {
    const sample = corpus.cases.find(value => value.caseId === slot.caseId)!;
    const selected = decisions.filter(value => value.target.slotId === slot.slotId);
    const complete = !!receipt && !targets.some(value => value.slotId === slot.slotId && !seen.has(canonicalJson(value))) && !selected.some(value => value.verdict === 'uncertain');
    return { slotId: slot.slotId, caseId: slot.caseId, variantId: slot.variantId, repeat: slot.repeat,
      runId: slot.run?.runId ?? null, annotationScope: sample.reference.annotationScope, nativeVerified: slot.nativeVerified,
      completionTimeStatus: slot.run?.status !== 'completed' ? 'not_completed' as const
        : slot.run.finishedAt ? 'verified' as const : 'completion_time_unverified' as const,
      metrics: { entities: matchingMetrics('entity', sample.reference.entities.map(value => value.referenceId), slot, selected, complete && reference.goldReady && independentHuman && sample.reference.annotationScope === 'full' && slot.run?.status === 'completed' && !!slot.run.finishedAt && slot.nativeVerified && input.integrity.planVerified && input.integrity.outputVerified),
        mentions: matchingMetrics('mention', sample.reference.mentions.map(value => value.referenceId), slot, selected, complete && reference.goldReady && independentHuman && sample.reference.annotationScope === 'full' && slot.run?.status === 'completed' && !!slot.run.finishedAt && slot.nativeVerified && input.integrity.planVerified && input.integrity.outputVerified) } };
  });
  const variants = input.plan.variants.map(({ variantId }) => {
    const planned = input.slots.filter(value => value.variantId === variantId), slotIds = new Set(planned.map(value => value.slotId));
    const selected = decisions.filter(value => slotIds.has(value.target.slotId)), variantBlockers: string[] = [];
    if (!input.integrity.planVerified || !input.integrity.outputVerified) variantBlockers.push('unverified_frozen_evidence');
    if (planned.some(slot => !slot.run || slot.run.status !== 'completed')) variantBlockers.push('capture_incomplete_or_failed');
    if (planned.some(slot => slot.run?.status === 'completed' && !slot.run.finishedAt)) variantBlockers.push('completion_time_unverified');
    if (planned.some(slot => slot.run && (!slot.nativeVerified || slot.run.attempts.some(attempt => !attempt.outcome)))) variantBlockers.push('native_evidence_unverified');
    if (planned.some(slot => slot.run && (slot.run.rejections.length || slot.run.entityRejections?.length))) variantBlockers.push('structural_rejection');
    if (planned.some(slot => slot.run && Date.parse(input.plan.declaredAt) > Date.parse(slot.run.startedAt))) variantBlockers.push('plan_not_predeclared');
    if (reference.authorReview === 'changes_requested' || reference.independentReview === 'changes_requested') variantBlockers.push('reference_changes_requested');
    if (forcedBlockingErrors.some(value => slotIds.has(value.target.slotId))) variantBlockers.push('critical_semantic_error');
    const errors = selected.filter(value => value.verdict === 'incorrect').length, gaps = selected.filter(value => value.verdict === 'required_missing').length;
    if (errors > input.plan.criteria.maxConfirmedErrors) variantBlockers.push('confirmed_error_threshold');
    if (gaps > input.plan.criteria.maxRequiredGaps) variantBlockers.push('required_gap_threshold');
    return { variantId, confirmedErrors: errors, requiredGaps: gaps, blockers: variantBlockers,
      status: variantBlockers.length ? 'blocked' as const : !receipt || missingTargets.some(value => slotIds.has(value.slotId)) || selected.some(value => value.verdict === 'uncertain') ? 'pending' as const
        : reference.goldReady && independentHuman && annotationComplete ? 'accepted_within_scope' as const : 'exploratory_reviewed' as const };
  });
  const report = { reportVersion: 'omk-extraction-study-review/v2' as const, planId: input.plan.planId, corpusDigest: corpus.corpusDigest,
    outputDigest: input.outputDigest, scope: 'frozen-real-study' as const, status, reference,
    completionTime: { completedSlots: input.slots.filter(slot => slot.run?.status === 'completed').length,
      verifiedCompletedSlots: input.slots.filter(slot => slot.run?.status === 'completed' && slot.run.finishedAt).length,
      unverifiedSlotIds: unverifiedCompletionSlots.map(slot => slot.slotId) },
    releaseEligibility: 'not_assessed' as const,
    remainingRequirements: ['Independent reference and output judgments are required for scoped acceptance.',
      'The separate frozen synthetic critical regression is not evaluated by this real-study report.',
      'Release eligibility and completion of the parent improvement issue require separate evidence.'],
    outputReview: { reviewer: receipt?.reviewer ?? null, independentHuman, reviewedAt: receipt?.reviewedAt ?? null,
      judgeIdentity: receipt?.judgeIdentity ?? null,
      expected: targets.length, reviewed: decisions.length, confirmedErrors, requiredGaps, uncertain },
    countingUnit: 'review-decision' as const, targets, decisions, missingTargets, forcedBlockingErrors, blockers, slots, variants,
    limits: ['Frozen real sources are a scoped study, not a representative population or release acceptance.',
      'Source provenance, prior exposure and human independence are attestations; digests only bind bytes.',
      'Completed runs require finishedAt to qualify for post-completion review and scoped metrics; missing completion evidence blocks acceptance without rewriting the original run. Receipt time remains bounded by available timestamps and the supplied checking clock.',
      'Agent judge model, revisions, prompt/configuration digests, attempts and usage are reviewer declarations; referenced artifacts are not loaded or native-verified.',
      'Partial or missing reference annotation cannot establish overall precision, recall or F1.',
      'Runs and birth revisions are never rewritten by semantic review; later corrections do not alter these denominators.'] };
  return { ...report, reportId: extractionStudyDigest(report) };
}

function validateDecision(decision: ExtractionStudyDecision, decisions: ExtractionStudyDecision[], input: ExtractionStudyReviewInput, corpus: ExtractionStudyCorpus) {
  const target = decision.target, slot = input.slots.find(value => value.slotId === target.slotId)!;
  const sample = corpus.cases.find(value => value.caseId === slot.caseId)!;
  const type = target.itemKind, reference = sample.reference;
  if ((type === 'reference_entity' || type === 'reference_mention') && !['correct', 'required_missing', 'uncertain'].includes(decision.verdict)) {
    throw new Error('Study reference coverage requires correct, required_missing or uncertain.');
  }
  if (decision.verdict === 'required_missing' && !['reference_entity', 'reference_mention', 'knowledge_obligation'].includes(type)) throw new Error('Required missing judgment requires a reference obligation.');
  if (type === 'knowledge_obligation') {
    const obligation = reference.knowledge.find(value => value.referenceId === target.referenceId)!;
    const allowed = obligation.coverage === 'required' ? ['correct', 'required_missing', 'uncertain'] : ['correct', 'optional_not_selected', 'uncertain'];
    if (!allowed.includes(decision.verdict)) throw new Error('Study knowledge coverage judgment contradicts its declared obligation.');
    if (decision.verdict === 'correct' && !decisions.some(value => value.target.slotId === slot.slotId && value.target.itemKind === 'statement' && value.verdict === 'correct' && value.referenceId === target.referenceId)) throw new Error('Covered study knowledge obligation requires a reviewed matching statement.');
  } else if (decision.verdict === 'optional_not_selected') throw new Error('Optional nonselection requires an optional knowledge obligation.');
  if (type === 'entity' || type === 'mention') {
    const references = type === 'entity' ? reference.entities : reference.mentions;
    if (decision.verdict === 'correct' && reference.annotationScope === 'full' && !decision.referenceId) throw new Error('Complete annotation requires explicit output-reference matching.');
    if (decision.referenceId && !references.some(value => value.referenceId === decision.referenceId)) throw new Error('Study output matches an unknown reference.');
    if (decision.referenceId && decisions.filter(value => value.target.slotId === slot.slotId && value.target.itemKind === type && value.referenceId === decision.referenceId).length !== 1) throw new Error('Study output-reference matching must be one-to-one.');
    if (decision.referenceId && decisions.some(value => value.target.slotId === slot.slotId && value.target.itemKind === (type === 'entity' ? 'reference_entity' : 'reference_mention')
      && value.target.referenceId === decision.referenceId && !['correct', 'uncertain'].includes(value.verdict))) throw new Error('Study reference coverage contradicts its reviewed output match.');
    if (type === 'mention' && decision.referenceId) {
      const gold = reference.mentions.find(value => value.referenceId === decision.referenceId)!;
      const observed = slot.run?.entityAnalysis?.revision.mentions.find(value => value.mentionId === target.mentionId);
      const located = gold.locators.map(value => locateQuoteOccurrence(value, sample.window.excerpts));
      if (!observed || !located.some(value => typeof value !== 'string' && canonicalJson(observed.selection) === canonicalJson(value))) throw new Error('Matched study mention must preserve its exact reference span.');
      if (!decisions.some(value => value.target.slotId === slot.slotId && value.target.itemKind === 'entity' && value.target.entityId === observed.entityId && value.referenceId === gold.entityReferenceId && value.verdict === 'correct')) throw new Error('Matched study mention must preserve its reviewed entity identity.');
    }
  }
  if (type === 'statement' && decision.referenceId && !reference.knowledge.some(value => value.referenceId === decision.referenceId)) throw new Error('Study statement matches an unknown knowledge obligation.');
  if ((type === 'reference_entity' || type === 'reference_mention') && decision.verdict === 'correct') {
    const outputType = type === 'reference_entity' ? 'entity' : 'mention';
    if (!decisions.some(value => value.target.slotId === slot.slotId && value.target.itemKind === outputType && value.referenceId === target.referenceId && value.verdict === 'correct')) throw new Error('Covered study reference requires an explicit reviewed output match.');
  }
}

function matchingMetrics(type: 'entity' | 'mention', references: string[], slot: ExtractionStudySlot, decisions: ExtractionStudyDecision[], eligible: boolean) {
  const outputs = type === 'entity' ? slot.run?.entityAnalysis?.revision.entities.length ?? 0 : slot.run?.entityAnalysis?.revision.mentions.length ?? 0;
  const matched = decisions.filter(value => value.target.itemKind === type && value.verdict === 'correct' && value.referenceId !== null).length;
  const precision = eligible && outputs ? matched / outputs : null, recall = eligible && references.length ? matched / references.length : null;
  return { outputCount: outputs, referenceCount: references.length, reviewedOutputCount: decisions.filter(value => value.target.itemKind === type).length,
    matchedCount: matched, truePositive: eligible ? matched : null, falsePositive: eligible ? outputs - matched : null, falseNegative: eligible ? references.length - matched : null,
    precision, recall, f1: eligible && outputs + references.length > 0 ? 2 * matched / (outputs + references.length) : null,
    eligible, countingUnit: type as 'entity' | 'mention' };
}
