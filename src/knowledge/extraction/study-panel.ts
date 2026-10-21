import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../store.js';
import { ExtractionStudyDigestSchema, extractionStudyDigest } from './study-corpus.js';
import { evaluateExtractionStudyReview, extractionStudyReviewTargets, ExtractionStudyOutputReceiptSchema,
  ExtractionStudyReviewTargetSchema, STUDY_SEMANTIC_ERROR_CODES, type ExtractionStudyDecision,
  type ExtractionStudyReviewInput, type ExtractionStudyReviewTarget } from './study-review.js';

const id = z.string().trim().min(1).max(256), rationale = z.string().trim().min(1).max(8192);
const time = z.iso.datetime({ offset: true }), digest = ExtractionStudyDigestSchema;
const actor = z.strictObject({ actorKind: z.enum(['human', 'agent']), actorId: id });
const rater = z.strictObject({ reviewer: actor, independentHuman: z.boolean(), authorRelationship: z.enum(['author', 'non_author']), independenceRationale: rationale });
export const ExtractionStudyPanelRosterSchema = z.strictObject({ raters: z.array(rater).min(1).max(64), adjudicator: rater });
const policy = {
  metric: 'exact-verdict-error-categories-reference/v1',
  missing: 'retain-in-planned-denominator;no-agreement',
  uncertain: 'retain-separately;exclude-observed-definite-agreement',
  targetScope: 'all-output-reference-obligation-check-case',
} as const;
const body = z.strictObject({ panelVersion: z.literal('omk-extraction-study-panel/v1'), declaredAt: time,
  analysisMode: z.enum(['prospective', 'retrospective']), planId: digest, corpusDigest: digest, evidenceDigest: digest,
  outputDigest: digest, targetSetDigest: digest, reviewVersion: z.literal('omk-extraction-study-review/v2'),
  targets: z.array(ExtractionStudyReviewTargetSchema).min(1), roster: ExtractionStudyPanelRosterSchema,
  policy: z.strictObject({ metric: z.literal(policy.metric), missing: z.literal(policy.missing), uncertain: z.literal(policy.uncertain), targetScope: z.literal(policy.targetScope) }),
});
const panelSchema = z.strictObject({ ...body.shape, panelId: digest });
export type ExtractionStudyPanel = z.infer<typeof panelSchema>;
export type ExtractionStudyPanelContext = Omit<ExtractionStudyReviewInput, 'outputReceipt'> & { evidenceDigest: string };
export const ExtractionStudyPanelSubmissionSchema = z.strictObject({ submissionVersion: z.literal('omk-extraction-study-panel-submission/v1'), panelId: digest,
  receipts: z.array(z.strictObject({ reviewerId: id, receiptFile: z.string().min(1).max(4096), receiptDigest: digest })).max(64) });
const adjudicationSchema = z.strictObject({ adjudicationVersion: z.literal('omk-extraction-study-panel-adjudication/v1'), panelId: digest,
  initialSetDigest: digest, disputedTargetsDigest: digest, reviewReceiptFile: z.string().min(1).max(4096), reviewReceiptDigest: digest });
export { adjudicationSchema as ExtractionStudyPanelAdjudicationSchema };
export const extractionStudyPanelBytesDigest = (raw: string) => `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
const key = (target: ExtractionStudyReviewTarget) => canonicalJson(target);
const actorKey = (value: string) => value.toLowerCase();
// Match study-analysis accounting without changing the original single-review receipt.
const semanticCodes = (decision: ExtractionStudyDecision): ExtractionStudyDecision['errorCodes'] => decision.verdict === 'incorrect' ? decision.errorCodes
  : decision.verdict === 'required_missing' ? ['coverage'] : [];
const normalized = (decision: ExtractionStudyDecision) => ({ verdict: decision.verdict, errorCodes: [...semanticCodes(decision)].sort(), referenceId: decision.referenceId });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const rate = (agree: number, total: number) => total ? agree / total : null;
const byteJson = (raw: string): unknown => {
  if (Buffer.from(raw, 'utf8').toString('utf8') !== raw) throw new Error('Panel input is not exact UTF-8.');
  return JSON.parse(raw) as unknown;
};

function checkRoster(roster: ExtractionStudyPanel['roster'], context: ExtractionStudyPanelContext) {
  const identities = [...roster.raters, roster.adjudicator].map(value => actorKey(value.reviewer.actorId));
  if (new Set(identities).size !== identities.length) throw new Error('Panel reviewer and adjudicator identities must be distinct.');
  for (const value of [...roster.raters, roster.adjudicator]) {
    const author = context.corpus.authors.some(authorId => actorKey(authorId) === actorKey(value.reviewer.actorId));
    if ((value.authorRelationship === 'author') !== author || value.independentHuman && (author || value.reviewer.actorKind !== 'human')) {
      throw new Error('Panel author relationship or independence conflicts with the frozen corpus.');
    }
  }
  if (!roster.adjudicator.independentHuman || roster.adjudicator.reviewer.actorKind !== 'human') throw new Error('Panel adjudicator must be another independent human.');
}
function checkContext(context: ExtractionStudyPanelContext) {
  digest.parse(context.evidenceDigest);
  const report = evaluateExtractionStudyReview(context);
  if (report.reportVersion !== 'omk-extraction-study-review/v2') throw new Error('Panel requires the current completion-aware study review.');
  return report;
}
export function createExtractionStudyPanel(context: ExtractionStudyPanelContext, declaration: {
  declaredAt: string; analysisMode: ExtractionStudyPanel['analysisMode']; roster: unknown;
}): ExtractionStudyPanel {
  checkContext(context);
  const targets = extractionStudyReviewTargets(context), roster = ExtractionStudyPanelRosterSchema.parse(declaration.roster);
  const value = body.parse({ panelVersion: 'omk-extraction-study-panel/v1', ...declaration, roster, planId: context.plan.planId,
    corpusDigest: context.corpus.corpusDigest, evidenceDigest: context.evidenceDigest, outputDigest: context.outputDigest,
    targetSetDigest: extractionStudyDigest(targets), reviewVersion: 'omk-extraction-study-review/v2', targets, policy });
  return parseExtractionStudyPanel({ ...value, panelId: extractionStudyDigest(value) }, context);
}
export function parseExtractionStudyPanel(input: unknown, context: ExtractionStudyPanelContext): ExtractionStudyPanel {
  checkContext(context);
  const value = panelSchema.parse(input), { panelId, ...rest } = value;
  if (extractionStudyDigest(rest) !== panelId || value.planId !== context.plan.planId || value.corpusDigest !== context.corpus.corpusDigest
    || value.evidenceDigest !== context.evidenceDigest || value.outputDigest !== context.outputDigest
    || !same(value.targets, extractionStudyReviewTargets(context)) || value.targetSetDigest !== extractionStudyDigest(value.targets)
    || Date.parse(value.declaredAt) > Date.parse(context.now)) throw new Error('Panel declaration, target set or exact evidence identity mismatch.');
  checkRoster(value.roster, context);
  return value;
}

type RawReceipt = { receiptFile: string; raw: string };
/** Preserve every roster member, including missing receipts; no selection or favorable-receipt filter. */
export function evaluateExtractionStudyPanel(input: {
  context: ExtractionStudyPanelContext; panel: unknown; submissionRaw: string; receipts: readonly RawReceipt[];
  adjudication?: { raw: string; reviewReceiptRaw: string };
}) {
  const { context } = input, panel = parseExtractionStudyPanel(input.panel, context);
  const submission = ExtractionStudyPanelSubmissionSchema.parse(byteJson(input.submissionRaw));
  if (submission.panelId !== panel.panelId) throw new Error('Panel submission identity mismatch.');
  const seenReviewers = new Set<string>(), seenFiles = new Set<string>();
  for (const entry of submission.receipts) {
    const reviewerId = actorKey(entry.reviewerId);
    if (seenReviewers.has(reviewerId) || seenFiles.has(entry.receiptFile) || !panel.roster.raters.some(value => actorKey(value.reviewer.actorId) === reviewerId)) {
      throw new Error('Duplicate or unknown panel reviewer or receipt file.');
    }
    seenReviewers.add(reviewerId); seenFiles.add(entry.receiptFile);
  }
  if (input.receipts.length !== submission.receipts.length || new Set(input.receipts.map(value => value.receiptFile)).size !== input.receipts.length
    || input.receipts.some(value => !seenFiles.has(value.receiptFile))) throw new Error('Panel raw receipt inventory differs from the complete submission manifest.');
  const initial = panel.roster.raters.map(declaration => {
    const entry = submission.receipts.find(value => actorKey(value.reviewerId) === actorKey(declaration.reviewer.actorId));
    if (!entry) return { declaration, receipt: null, receiptDigest: null, review: null };
    const raw = input.receipts.find(value => value.receiptFile === entry.receiptFile)!.raw;
    if (extractionStudyPanelBytesDigest(raw) !== entry.receiptDigest) throw new Error('Panel original receipt bytes changed.');
    const receipt = ExtractionStudyOutputReceiptSchema.parse(byteJson(raw));
    if (!same(receipt.reviewer, declaration.reviewer) || receipt.independentHuman !== declaration.independentHuman) throw new Error('Panel receipt reviewer differs from the predeclared roster.');
    if (panel.analysisMode === 'prospective' && Date.parse(panel.declaredAt) >= Date.parse(receipt.reviewedAt)) throw new Error('A prospective panel must be declared strictly before every initial judgment.');
    const review = evaluateExtractionStudyReview({ ...context, outputReceipt: receipt });
    return { declaration, receipt, receiptDigest: entry.receiptDigest, review };
  });
  const submissionDigest = extractionStudyPanelBytesDigest(input.submissionRaw);
  const initialSetDigest = extractionStudyDigest({ panelId: panel.panelId, submissionDigest,
    receipts: initial.map(value => ({ reviewer: value.declaration.reviewer, receiptDigest: value.receiptDigest })) });
  const eligible = initial.filter(value => value.declaration.reviewer.actorKind === 'human' && value.declaration.independentHuman);
  const decisions = initial.map(value => new Map((value.receipt?.decisions ?? []).map(decision => [key(decision.target), decision])));
  const eligibleIndices = initial.flatMap((value, index) => eligible.includes(value) ? [index] : []);
  function comparison(indices: number[]) {
    const common = panel.targets.flatMap(target => {
      const selected = indices.map(index => decisions[index].get(key(target)));
      return indices.length >= 2 && selected.every(value => value && value.verdict !== 'uncertain') ? [{ target, selected: selected as ExtractionStudyDecision[] }] : [];
    });
    const agree = common.filter(value => value.selected.every(decision => same(normalized(decision), normalized(value.selected[0])))).length;
    const verdictAgreement = common.filter(value => value.selected.every(decision => decision.verdict === value.selected[0].verdict)).length;
    const byItemKind = [...new Set(panel.targets.map(target => target.itemKind))].map(itemKind => {
      const rows = common.filter(value => value.target.itemKind === itemKind);
      const exact = rows.filter(value => value.selected.every(decision => same(normalized(decision), normalized(value.selected[0])))).length;
      return { itemKind, commonDefiniteTargets: rows.length, exactAgreement: exact, exactAgreementRate: rate(exact, rows.length) };
    });
    const errors = STUDY_SEMANTIC_ERROR_CODES.map(errorCode => {
      const agree = common.filter(value => value.selected.every(decision => semanticCodes(decision).includes(errorCode) === semanticCodes(value.selected[0]).includes(errorCode))).length;
      return { errorCode, commonDefiniteTargets: common.length, agreement: agree, agreementRate: rate(agree, common.length),
        presentByReviewer: indices.map((index, ordinal) => ({ reviewer: initial[index].declaration.reviewer, count: common.filter(value => semanticCodes(value.selected[ordinal]).includes(errorCode)).length })) };
    });
    const reference = ['entity', 'mention', 'statement'].map(itemKind => {
      const rows = common.filter(value => value.target.itemKind === itemKind);
      const agree = rows.filter(value => value.selected.every(decision => decision.referenceId === value.selected[0].referenceId)).length;
      const byReference = context.slots.flatMap(slot => {
        const sample = context.corpus.cases.find(value => value.caseId === slot.caseId)!;
        const references = itemKind === 'entity' ? sample.reference.entities : itemKind === 'mention' ? sample.reference.mentions : sample.reference.knowledge;
        const outputs = rows.filter(value => value.target.slotId === slot.slotId);
        return references.map(({ referenceId }) => {
          const agreement = outputs.filter(value => value.selected.every(decision => (decision.referenceId === referenceId) === (value.selected[0].referenceId === referenceId))).length;
          return { slotId: slot.slotId, referenceId, commonDefiniteOutputs: outputs.length, agreement, agreementRate: rate(agreement, outputs.length),
            matchesByReviewer: indices.map((index, ordinal) => ({ reviewer: initial[index].declaration.reviewer, count: outputs.filter(value => value.selected[ordinal].referenceId === referenceId).length })) };
        });
      });
      return { itemKind, commonDefiniteTargets: rows.length, agreement: agree, agreementRate: rate(agree, rows.length), byReference,
        // Null is an explicit unmatched result, not a positive semantic match.
        allMatchedTargets: rows.filter(value => value.selected.every(decision => decision.referenceId !== null)).length };
    });
    return { commonDefiniteTargets: common.length, exactAgreement: agree, exactAgreementRate: rate(agree, common.length), verdictAgreement, verdictAgreementRate: rate(verdictAgreement, common.length), byItemKind, errorCategories: errors, referenceMatching: reference };
  }
  const submittedEligibleIndices = eligibleIndices.filter(index => initial[index].receipt !== null);
  const observed = { reviewers: submittedEligibleIndices.map(index => initial[index].declaration.reviewer), ...comparison(submittedEligibleIndices) };
  const pairwise = eligibleIndices.flatMap((left, ordinal) => eligibleIndices.slice(ordinal + 1).map(right => ({
    reviewers: [initial[left].declaration.reviewer, initial[right].declaration.reviewer], ...comparison([left, right]),
    plannedTargets: panel.targets.length,
    missingByReviewer: [left, right].map(index => panel.targets.filter(target => !decisions[index].has(key(target))).length),
    uncertainByReviewer: [left, right].map(index => [...decisions[index].values()].filter(value => value.verdict === 'uncertain').length),
  })));
  const coverage = initial.map((value, index) => ({ reviewer: value.declaration.reviewer, independentHuman: value.declaration.independentHuman,
    submitted: !!value.receipt, receiptDigest: value.receiptDigest, reviewedAt: value.receipt?.reviewedAt ?? null,
    expectedTargets: panel.targets.length, reviewedTargets: decisions[index].size,
    missingTargets: panel.targets.filter(target => !decisions[index].has(key(target))),
    uncertainTargets: [...decisions[index].values()].filter(value => value.verdict === 'uncertain').map(value => value.target),
    requiredMissingTargets: [...decisions[index].values()].filter(value => value.verdict === 'required_missing').map(value => value.target),
    singleReviewStatus: value.review?.status ?? null }));
  // All eight target kinds enter the exact main denominator, including reference omissions and case judgments.
  const disagreements = panel.targets.flatMap(target => {
    const recorded = initial.flatMap((value, index) => {
      const decision = decisions[index].get(key(target));
      return decision ? [{ reviewer: value.declaration.reviewer, receiptDigest: value.receiptDigest!, decision,
        canonicalDecisionDigest: extractionStudyDigest(decision) }] : [];
    });
    return new Set(recorded.map(value => canonicalJson(normalized(value.decision)))).size > 1 ? [{ target, recorded }] : [];
  });
  const disputedTargetsDigest = extractionStudyDigest(disagreements.map(value => value.target));
  const reasons: string[] = [];
  if (eligible.length < 2) reasons.push('fewer_than_two_eligible_humans');
  if (initial.some(value => !value.receipt)) reasons.push('missing_roster_receipt');
  if (coverage.some(value => value.missingTargets.length)) reasons.push('incomplete_target_coverage');
  if (coverage.some(value => value.uncertainTargets.length)) reasons.push('uncertain_judgments');
  if (!observed.commonDefiniteTargets) reasons.push('no_common_definite_targets');
  if (panel.analysisMode === 'retrospective') reasons.push('retrospective_panel');
  if (!context.integrity.planVerified || !context.integrity.outputVerified || context.slots.some(slot => !slot.nativeVerified || slot.run?.status !== 'completed'
    || !slot.run.finishedAt || slot.run.attempts.some(attempt => !attempt.outcome))) reasons.push('incomplete_native_or_completion_evidence');
  let adjudication: null | { receiptDigest: string; envelopeDigest: string; reviewer: { actorKind: 'human' | 'agent'; actorId: string };
    reviewedAt: string; resolved: number; unresolvedTargets: ExtractionStudyReviewTarget[];
    decisions: { target: ExtractionStudyReviewTarget; decision: ExtractionStudyDecision; canonicalDecisionDigest: string; rawReceiptDigest: string }[] } = null;
  if (input.adjudication) {
    const envelope = adjudicationSchema.parse(byteJson(input.adjudication.raw));
    if (!initial.every(value => value.receipt) || envelope.panelId !== panel.panelId || envelope.initialSetDigest !== initialSetDigest
      || envelope.disputedTargetsDigest !== disputedTargetsDigest || envelope.reviewReceiptDigest !== extractionStudyPanelBytesDigest(input.adjudication.reviewReceiptRaw)) {
      throw new Error('Adjudication must bind the complete initial receipt set and exact disputed targets.');
    }
    const receipt = ExtractionStudyOutputReceiptSchema.parse(byteJson(input.adjudication.reviewReceiptRaw));
    if (!same(receipt.reviewer, panel.roster.adjudicator.reviewer) || !receipt.independentHuman
      || Date.parse(receipt.reviewedAt) < Date.parse(panel.declaredAt)
      || initial.some(value => Date.parse(receipt.reviewedAt) <= Date.parse(value.receipt!.reviewedAt))) throw new Error('Adjudication requires the predeclared third human no earlier than panel declaration and after all initial reviews.');
    evaluateExtractionStudyReview({ ...context, outputReceipt: receipt });
    const selected = disagreements.flatMap(({ target }) => {
      const decision = receipt.decisions.find(value => key(value.target) === key(target));
      return decision ? [{ target, decision, canonicalDecisionDigest: extractionStudyDigest(decision), rawReceiptDigest: envelope.reviewReceiptDigest }] : [];
    });
    const unresolvedTargets = disagreements.filter(({ target }) => !selected.some(value => key(value.target) === key(target) && value.decision.verdict !== 'uncertain')).map(value => value.target);
    adjudication = { envelopeDigest: extractionStudyPanelBytesDigest(input.adjudication.raw), receiptDigest: envelope.reviewReceiptDigest,
      reviewer: receipt.reviewer, reviewedAt: receipt.reviewedAt, resolved: disagreements.length - unresolvedTargets.length, unresolvedTargets, decisions: selected };
  }
  const report = { reportVersion: 'omk-extraction-study-panel-report/v1' as const, panelId: panel.panelId, planId: panel.planId,
    evidenceDigest: panel.evidenceDigest, outputDigest: panel.outputDigest, targetSetDigest: panel.targetSetDigest, submissionDigest,
    initialSetDigest, disputedTargetsDigest, analysisMode: panel.analysisMode, qualityAcceptance: 'not_assessed' as const,
    countingUnit: 'review-target' as const, policy: panel.policy, expectedTargets: panel.targets.length, coverage,
    participants: { planned: initial.length, submitted: initial.filter(value => value.receipt).length,
      humans: initial.filter(value => value.receipt?.reviewer.actorKind === 'human').length,
      agents: initial.filter(value => value.receipt?.reviewer.actorKind === 'agent').length,
      nonIndependentHumans: initial.filter(value => value.receipt?.reviewer.actorKind === 'human' && !value.declaration.independentHuman).length,
      eligibleHumansPlanned: eligible.length, eligibleHumansSubmitted: eligible.filter(value => value.receipt).length },
    observed, pairwise, fullIAA: reasons.length ? null : observed.exactAgreementRate, fullIAAUnavailableReasons: reasons,
    disagreements, adjudication,
    limits: ['Agreement is descriptive for this exact finite target set; it is neither accuracy nor release acceptance.',
      'No kappa, confidence interval, independence of samples or population-quality estimate is calculated.',
      'Human identity, independence, prior exposure and declaration time are attestations, not authenticated facts.',
      'The program cannot establish that receipts outside the declared roster and submitted inventory were not concealed.',
      'Missing and uncertain judgments do not count as agreement. Reference omissions and case decisions remain in the main denominator.',
      'Adjudication never rewrites initial judgments or initial agreement. Canonical decision digests bind parsed decisions; raw receipt digests bind original UTF-8 bytes.',
      'This report neither changes goldReady nor substitutes for the existing independent reference and single-output acceptance gates.'] };
  return { ...report, reportId: extractionStudyDigest(report) };
}
