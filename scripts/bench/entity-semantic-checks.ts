import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EntityReviewCorpus } from './entity-review-corpus.js';
import { annotationReadiness } from './entity-extraction-review.js';
import type { authorReviewStatus, reviewCapture, reviewReceiptStatus } from './entity-extraction-review.js';

const text = z.string().trim().min(1).max(8192);
const id = z.string().trim().min(1).max(256);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const repeats = z.union([z.literal(1), z.literal(2)]);
const limit = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const planBody = z.strictObject({
  planVersion: z.literal('omk-entity-semantic-plan/v1').default('omk-entity-semantic-plan/v1'),
  measurementId: digest, declaredAt: instant, split: z.enum(['development', 'validation']), repeats,
  caseIds: z.array(id).min(1),
  criteria: z.strictObject({ maxConfirmedErrors: limit, confirmedErrorsRationale: text,
    maxRequiredGaps: limit, requiredGapsRationale: text }),
}).refine(value => new Set(value.caseIds).size === value.caseIds.length, 'Duplicate planned case.');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Semantic identity contains non-JSON data.');
  return result;
}
const hash = (value: unknown) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
export function createSemanticPlan(input: unknown) {
  const body = planBody.parse(input);
  return { ...body, planId: hash(body) };
}
export type SemanticAcceptancePlan = ReturnType<typeof createSemanticPlan>;
export function parseSemanticPlan(input: unknown): SemanticAcceptancePlan {
  const value = z.strictObject({ ...planBody.shape, planVersion: z.literal('omk-entity-semantic-plan/v1'), planId: digest }).parse(input);
  const { planId, ...body } = value;
  const plan = createSemanticPlan(body);
  if (planId !== plan.planId) throw new Error('Semantic plan identity mismatch.');
  return plan;
}

const targetBase = { caseId: id, repeat: repeats };
export const SemanticReviewTargetSchema = z.discriminatedUnion('itemKind', [
  z.strictObject({ ...targetBase, itemKind: z.literal('entity'), entityId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('mention'), mentionId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('statement'), proposalId: id, statementId: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('role'), roleKey: id }),
  z.strictObject({ ...targetBase, itemKind: z.literal('semantic_check'), checkIndex: z.number().int().nonnegative() }),
  z.strictObject({ ...targetBase, itemKind: z.literal('case') }),
]);
export type SemanticReviewTarget = z.infer<typeof SemanticReviewTargetSchema>;
export const SEMANTIC_ERROR_CODES = ['scope', 'boundary', 'identity', 'referent_kind', 'unsupported_qualifier',
  'relation', 'polarity', 'modality', 'conditions', 'time', 'coverage', 'provenance', 'unsupported_fact'] as const;
export const FORCED_BLOCKING_ERROR_CODES = ['identity', 'provenance', 'unsupported_fact'] as const;
const verdict = z.enum(['correct', 'incorrect', 'uncertain', 'required_missing', 'optional_not_selected']);
const decision = z.strictObject({ target: SemanticReviewTargetSchema, verdict,
  errorCodes: z.array(z.enum(SEMANTIC_ERROR_CODES)), rationale: text }).superRefine((value, context) => {
  if (new Set(value.errorCodes).size !== value.errorCodes.length) context.addIssue({ code: 'custom', message: 'Duplicate semantic error code.' });
  if ((value.verdict === 'incorrect') !== !!value.errorCodes.length) context.addIssue({ code: 'custom', message: 'Only incorrect decisions require error codes.' });
});
export const SemanticOutputReviewSchema = z.strictObject({
  reviewVersion: z.literal('omk-entity-output-review/v1'), planId: digest, capturesDigest: digest,
  reviewer: z.strictObject({ actorKind: z.enum(['agent', 'human']), actorId: id }),
  independentHuman: z.boolean(), reviewedAt: instant, decisions: z.array(decision),
}).superRefine((value, context) => {
  if (value.independentHuman && value.reviewer.actorKind !== 'human') context.addIssue({ code: 'custom', message: 'An agent cannot attest independent human review.' });
});
export type SemanticOutputReview = z.infer<typeof SemanticOutputReviewSchema>;
export type SemanticCorpus = Pick<EntityReviewCorpus, 'authors' | 'cases'>;
type Capture = ReturnType<typeof reviewCapture>;
type ReviewEvidence = { corpus: SemanticCorpus; capture: Capture };
export interface SemanticReviewContext extends ReviewEvidence {
  plan: unknown; measurementId: string; capturesDigest: string;
  authorReview: ReturnType<typeof authorReviewStatus>['status'];
  annotationReview: ReturnType<typeof reviewReceiptStatus>['status'];
  receipt?: unknown; now: string;
}

/** All accepted output units and predeclared obligations, including a whole-case judgment. */
export function semanticReviewTargets({ corpus, capture }: ReviewEvidence): SemanticReviewTarget[] {
  const result: SemanticReviewTarget[] = [];
  for (const sample of corpus.cases.filter(value => value.split === capture.capture.split)) {
    for (let repeat = 1; repeat <= capture.capture.repeats; repeat++) {
      const base = { caseId: sample.caseId, repeat: repeat as 1 | 2 };
      const record = capture.records.find(value => value.caseId === sample.caseId && value.repeat === repeat);
      const checked = record && 'checked' in record ? record.checked : undefined;
      if (checked) {
        for (const entity of checked.analysis.entities) result.push({ ...base, itemKind: 'entity', entityId: entity.entityId });
        for (const mention of checked.analysis.mentions) result.push({ ...base, itemKind: 'mention', mentionId: mention.mentionId });
        for (const proposal of checked.accepted) for (const statement of proposal.draft.content.statements) {
          result.push({ ...base, itemKind: 'statement', proposalId: proposal.proposalId, statementId: statement.statementId });
        }
      }
      for (const role of sample.roles) result.push({ ...base, itemKind: 'role', roleKey: role.roleKey });
      sample.semanticChecks.forEach((_check, checkIndex) => result.push({ ...base, itemKind: 'semantic_check', checkIndex }));
      result.push({ ...base, itemKind: 'case' });
    }
  }
  const keys = result.map(canonical);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate semantic review target.');
  return result;
}

export function createSemanticReviewTemplate(input: ReviewEvidence & { plan: unknown; capturesDigest: string }) {
  const plan = parseSemanticPlan(input.plan);
  digest.parse(input.capturesDigest);
  return { reviewVersion: 'omk-entity-output-review/v1' as const, planId: plan.planId, capturesDigest: input.capturesDigest,
    reviewer: { actorKind: 'agent' as const, actorId: '' }, independentHuman: false, reviewedAt: '',
    decisions: semanticReviewTargets(input).map(target => ({ target, verdict: 'uncertain' as const, errorCodes: [], rationale: '' })) };
}

/** No NLP inference: validate declared judgments and apply the frozen, scoped acceptance criteria. */
export function evaluateSemanticReview(input: SemanticReviewContext) {
  const plan = parseSemanticPlan(input.plan);
  const measurementId = digest.parse(input.measurementId), capturesDigest = digest.parse(input.capturesDigest);
  const now = instant.parse(input.now);
  if (plan.measurementId !== measurementId || input.capture.capture.measurementId !== measurementId) throw new Error('Semantic measurement identity mismatch.');
  if (plan.split !== input.capture.capture.split || plan.repeats !== input.capture.capture.repeats) throw new Error('Semantic capture is outside the plan.');
  const selected = input.corpus.cases.filter(value => value.split === plan.split);
  if (canonical([...plan.caseIds].sort()) !== canonical(selected.map(value => value.caseId).sort())) throw new Error('Semantic planned cases differ from the frozen corpus split.');
  if (Date.parse(plan.declaredAt) > Date.parse(now)) throw new Error('Semantic plan declaration is in the future.');
  const targets = semanticReviewTargets(input), byTarget = new Map(targets.map(target => [canonical(target), target]));
  const reference = annotationReadiness(input.authorReview, input.annotationReview);
  const blockers: string[] = [];
  const predeclared = Date.parse(plan.declaredAt) <= Date.parse(input.capture.capture.startedAt);
  if (!predeclared) blockers.push('plan_not_predeclared');
  if (input.capture.summary.captureStatus !== 'captured' || input.capture.unattempted.length) blockers.push('capture_incomplete_or_failed');
  if (input.capture.records.some(value => value.structuralRejections.length)) blockers.push('structural_rejection');
  if (input.capture.records.some(value => value.checks && (
    value.checks.criticalMentions.some(mention => mention.status !== 'matched')
    || value.checks.identityPairs.some(pair => pair.status !== 'matched')
    || value.checks.identities.some(identity => identity.status !== 'matched')
    || value.checks.unexpectedKnowledge
    || value.checks.knowledgeCoverage.some(role => role.status === 'required_not_observed')
  ))) blockers.push('critical_regression_failure');
  if (input.authorReview === 'changes_requested' || input.annotationReview === 'changes_requested') blockers.push('reference_changes_requested');
  const receipt = input.receipt === undefined ? null : SemanticOutputReviewSchema.parse(input.receipt);
  const decisions = receipt?.decisions ?? [];
  const seen = new Set<string>();
  if (receipt) {
    if (receipt.planId !== plan.planId || receipt.capturesDigest !== capturesDigest) throw new Error('Semantic review evidence identity mismatch.');
    if (Date.parse(receipt.reviewedAt) > Date.parse(now) || Date.parse(receipt.reviewedAt) < Date.parse(input.capture.capture.startedAt)) throw new Error('Semantic review time is outside the output-review interval.');
    if (receipt.independentHuman && input.corpus.authors.some(author => author.trim().toLowerCase() === receipt.reviewer.actorId.toLowerCase())) throw new Error('Corpus author cannot attest independent output review.');
    for (const value of decisions) {
      const key = canonical(value.target);
      if (seen.has(key)) throw new Error('Duplicate semantic review decision.');
      if (!byTarget.has(key)) throw new Error('Semantic review references an unknown output or obligation.');
      seen.add(key);
      if (value.verdict === 'required_missing' || value.verdict === 'optional_not_selected') {
        const target = value.target;
        const role = target.itemKind === 'role' ? selected.find(sample => sample.caseId === target.caseId)?.roles.find(role => role.roleKey === target.roleKey) : undefined;
        if (!role || (value.verdict === 'required_missing' ? role.coverage !== 'required' : role.coverage !== 'if_selected')) throw new Error('Semantic coverage decision has the wrong obligation type.');
      }
    }
  }
  const confirmedErrors = decisions.filter(value => value.verdict === 'incorrect').length;
  const requiredGaps = decisions.filter(value => value.verdict === 'required_missing').length;
  const uncertain = decisions.filter(value => value.verdict === 'uncertain').length;
  const missingTargets = targets.filter(target => !seen.has(canonical(target)));
  const forcedBlockingErrors = decisions.filter(value => value.verdict === 'incorrect'
    && value.errorCodes.some(code => (FORCED_BLOCKING_ERROR_CODES as readonly string[]).includes(code)));
  if (forcedBlockingErrors.length) blockers.push('critical_semantic_error');
  if (confirmedErrors > plan.criteria.maxConfirmedErrors) blockers.push('confirmed_error_threshold');
  if (requiredGaps > plan.criteria.maxRequiredGaps) blockers.push('required_gap_threshold');
  const independentOutputReview = !!receipt?.independentHuman && receipt.reviewer.actorKind === 'human';
  const status = blockers.length ? 'blocked' as const : !receipt || missingTargets.length || uncertain ? 'pending' as const
    : reference.goldReady && independentOutputReview ? 'accepted_within_scope' as const : 'exploratory_reviewed' as const;
  return { reportVersion: 'omk-entity-semantic-report/v1' as const, planId: plan.planId, measurementId, capturesDigest,
    scope: 'synthetic-critical-regression' as const, status, countingUnit: 'review-decision' as const,
    reference: { authorReview: input.authorReview, annotationReview: input.annotationReview, goldReady: reference.goldReady },
    outputReview: { reviewer: receipt?.reviewer ?? null, independentHuman: independentOutputReview,
      reviewedAt: receipt?.reviewedAt ?? null, expected: targets.length, reviewed: decisions.length,
      confirmedErrors, requiredGaps, uncertain, optionalNotSelected: decisions.filter(value => value.verdict === 'optional_not_selected').length },
    criteria: plan.criteria, blockers, forcedBlockingErrors, missingTargets, targets,
    planBinding: { declaration: predeclared ? 'attested_before_outputs' as const : 'declared_after_outputs' as const,
      transportBound: false as const },
    limits: ['Only the frozen synthetic critical regression scope is assessed; this is not real-population quality or release acceptance.',
      'Existing capture v1 does not bind the semantic plan at transport time; declaration time and reviewer independence are attestations.',
      'Capture v1 has no completion timestamp: reviewedAt is checked against capture.startedAt and now, not verified output completion.',
      'Judgments are supplied by reviewers; deterministic validation does not establish semantic truth or authenticate a human identity.',
      'Counts are review decisions, not independent errors, causal incidents, or population precision/recall/F1.'],
  };
}
