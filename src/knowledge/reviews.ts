import { z } from 'zod';
import { KnowledgeActorSchema, KnowledgeBodyEvidenceSchema, KnowledgeBodyRefSchema, type KnowledgeActor, type KnowledgeRevision } from './contracts.js';
import { canonicalJson } from './store.js';

const id = z.string().uuid();
const text = z.string().trim().min(1).max(4096);
const segmentId = z.string().min(1).max(256).refine(value => value.trim().length > 0);
export const KnowledgeReviewActorSchema = KnowledgeActorSchema.superRefine((actor, ctx) => {
  if (!actor.actorId.trim() || actor.actorKind === 'agent' && !actor.executionRef.trim()) ctx.addIssue({ code: 'custom', message: 'A concrete actual review actor is required.' });
});
export const KnowledgeReviewSourceRefSchema = KnowledgeBodyEvidenceSchema.shape.source;
export const KnowledgeReviewSourcesSchema = z.array(KnowledgeReviewSourceRefSchema).min(1).max(256).superRefine((sources, ctx) => {
  if (new Set(sources.map(source => canonicalJson(source))).size !== sources.length) ctx.addIssue({ code: 'custom', message: 'Duplicate review source.' });
});
export type KnowledgeReviewSourceRef = z.infer<typeof KnowledgeReviewSourceRefSchema>;
export const KnowledgeReviewFindingSchema = z.strictObject({
  problemKind: z.enum(['omission', 'unsupported_claim', 'scope_error', 'contradiction', 'unclear', 'other']),
  description: text, segmentIds: z.array(segmentId).max(256), evidence: z.array(KnowledgeBodyEvidenceSchema).max(64).default([]),
}).superRefine((finding, ctx) => {
  if (new Set(finding.segmentIds).size !== finding.segmentIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate finding segment.' });
});
export const KnowledgeContentReviewDecisionSchema = z.strictObject({
  status: z.enum(['needs_revision', 'reviewed_with_limits']), reason: text,
  limitations: z.array(text).max(64), findings: z.array(KnowledgeReviewFindingSchema).max(256),
}).superRefine((decision, ctx) => {
  if (decision.status === 'reviewed_with_limits' && !decision.limitations.length) ctx.addIssue({ code: 'custom', message: 'Reviewed content must retain its limits.' });
  if (decision.status === 'needs_revision' && !decision.findings.length) ctx.addIssue({ code: 'custom', message: 'Revision needed requires a finding.' });
});
export const KnowledgeCoverageEntityRefSchema = z.strictObject({
  analysisId: id, entityRevisionId: id, entityId: segmentId, mentionIds: z.array(segmentId).min(1).max(256),
}).superRefine((ref, ctx) => {
  if (new Set(ref.mentionIds).size !== ref.mentionIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate coverage mention.' });
});
export const KnowledgeSegmentCoverageSchema = z.strictObject({
  segmentId, status: z.enum(['linked', 'no_reliable_object', 'gap', 'unknown']), reason: text,
  entityRefs: z.array(KnowledgeCoverageEntityRefSchema).max(256).default([]),
}).superRefine((decision, ctx) => {
  if ((decision.status === 'linked') !== (decision.entityRefs.length > 0)) ctx.addIssue({ code: 'custom', message: 'Only linked coverage requires exact entity references.' });
  const keys = decision.entityRefs.map(ref => canonicalJson([ref.analysisId, ref.entityRevisionId, ref.entityId]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate coverage entity.' });
});
export const KnowledgeCoverageReviewDecisionSchema = z.strictObject({
  projectionRevisionId: segmentId.nullable(), decisions: z.array(KnowledgeSegmentCoverageSchema).min(1).max(4096), reason: text,
}).superRefine((decision, ctx) => {
  if (new Set(decision.decisions.map(value => value.segmentId)).size !== decision.decisions.length) ctx.addIssue({ code: 'custom', message: 'Duplicate coverage segment.' });
});
export const KnowledgeUseDecisionSchema = z.strictObject({
  taskRef: text.max(256), query: text.max(512), segmentIds: z.array(segmentId).min(1).max(256),
  signal: z.enum(['provided', 'read', 'reported_use', 'observed_help', 'controlled_effect']), reason: text,
  issueKind: z.enum(['content_missing', 'association_wrong', 'source_unavailable', 'other']).optional(),
  evidenceRefs: z.array(text).max(64).default([]), evidence: z.array(KnowledgeBodyEvidenceSchema).max(64).default([]),
}).superRefine((usage, ctx) => {
  if (new Set(usage.segmentIds).size !== usage.segmentIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate used segment.' });
  if (['observed_help', 'controlled_effect'].includes(usage.signal) && !usage.evidenceRefs.length && !usage.evidence.length) ctx.addIssue({ code: 'custom', message: 'Benefit signals require task/comparison references or exact inline evidence.' });
});
const writeIdentity = {
  requestId: id, bodyRef: KnowledgeBodyRefSchema, sources: KnowledgeReviewSourcesSchema,
  expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expectedHeadEventId: id.nullable(),
  supersedesEventIds: z.array(id).max(256).default([]),
};
export const KnowledgeContentReviewInputSchema = KnowledgeContentReviewDecisionSchema.safeExtend(writeIdentity);
export const KnowledgeCoverageReviewInputSchema = KnowledgeCoverageReviewDecisionSchema.safeExtend(writeIdentity);
export const KnowledgeUseInputSchema = KnowledgeUseDecisionSchema.safeExtend(writeIdentity);
export const KnowledgeReviewWriteSchema = z.discriminatedUnion('eventKind', [
  KnowledgeContentReviewInputSchema.safeExtend({ eventKind: z.literal('content_review') }),
  KnowledgeCoverageReviewInputSchema.safeExtend({ eventKind: z.literal('association_coverage') }),
  KnowledgeUseInputSchema.safeExtend({ eventKind: z.literal('task_use') }),
]);
const eventIdentity = {
  eventId: id, parentEventId: id.nullable(), bodyRef: KnowledgeBodyRefSchema, sources: KnowledgeReviewSourcesSchema,
  actor: KnowledgeReviewActorSchema, at: z.iso.datetime({ offset: true }), supersedesEventIds: z.array(id).max(256),
};
export const KnowledgeReviewEventSchema = z.discriminatedUnion('eventKind', [
  KnowledgeContentReviewDecisionSchema.safeExtend({ ...eventIdentity, eventKind: z.literal('content_review') }),
  KnowledgeCoverageReviewDecisionSchema.safeExtend({ ...eventIdentity, eventKind: z.literal('association_coverage') }),
  KnowledgeUseDecisionSchema.safeExtend({ ...eventIdentity, eventKind: z.literal('task_use') }),
]);
export const KnowledgeReviewReceiptSchema = z.strictObject({
  requestId: id, commandDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), committedGeneration: z.number().int().positive(), eventId: id,
});
export const KnowledgeReviewEnvelopeSchema = z.strictObject({
  storeKind: z.literal('knowledge-review-history'), schemaVersion: z.literal(1), namespace: segmentId, knowledgeId: segmentId,
  generation: z.number().int().positive(), writeHeadEventId: id,
  events: z.array(KnowledgeReviewEventSchema).min(1).max(4096), receipts: z.array(KnowledgeReviewReceiptSchema).min(1).max(4096),
});
export type KnowledgeReviewWrite = z.infer<typeof KnowledgeReviewWriteSchema>;
export type KnowledgeReviewEvent = z.infer<typeof KnowledgeReviewEventSchema>;
export type KnowledgeReviewEnvelope = z.infer<typeof KnowledgeReviewEnvelopeSchema>;
export type KnowledgeReviewReceipt = z.infer<typeof KnowledgeReviewReceiptSchema>;
export type KnowledgeContentReviewInput = z.input<typeof KnowledgeContentReviewInputSchema>;
export type KnowledgeCoverageReviewInput = z.input<typeof KnowledgeCoverageReviewInputSchema>;
export type KnowledgeUseInput = z.input<typeof KnowledgeUseInputSchema>;
export interface KnowledgeReviewStore {
  read(knowledgeId: string): KnowledgeReviewEnvelope | undefined;
  /** The callback revalidates exact bodies, projections and evidence under the workspace lock. */
  write(command: KnowledgeReviewWrite, actor: KnowledgeActor, at: string, validate: () => void): KnowledgeReviewReceipt;
}
export function sameReviewBody(a: KnowledgeReviewEvent['bodyRef'], b: KnowledgeReviewEvent['bodyRef']): boolean {
  return a.knowledgeId === b.knowledgeId && a.revisionId === b.revisionId && a.bodyDigest === b.bodyDigest;
}
export function knowledgeReviewSources(body: Pick<KnowledgeRevision, 'content'>): KnowledgeReviewSourceRef[] {
  return [...new Map(body.content.segments.flatMap(segment => segment.evidence).map(evidence => [canonicalJson(evidence.source), evidence.source])).values()];
}
/** Explicit supersession removes opinions; timestamps and actor kinds never rank truth. */
export function selectKnowledgeReviews(history: KnowledgeReviewEnvelope | undefined, body: Pick<KnowledgeRevision, 'knowledgeId' | 'revisionId' | 'bodyDigest' | 'content'>, projectionRevisionId: string | null = null) {
  if (history && history.knowledgeId !== body.knowledgeId) throw new Error('Knowledge review selection identity conflict.');
  const matching = history?.events.filter(event => sameReviewBody(event.bodyRef, body)) ?? [];
  const superseded = new Set(matching.flatMap(event => event.supersedesEventIds));
  const active = matching.filter(event => !superseded.has(event.eventId));
  const content = active.filter((event): event is Extract<KnowledgeReviewEvent, { eventKind: 'content_review' }> => event.eventKind === 'content_review');
  const coverage = active.filter((event): event is Extract<KnowledgeReviewEvent, { eventKind: 'association_coverage' }> => event.eventKind === 'association_coverage' && event.projectionRevisionId === projectionRevisionId);
  return {
    content: { status: content.some(event => event.status === 'needs_revision') ? 'needs_revision' as const : content.length ? 'reviewed_with_limits' as const : 'not_reviewed' as const, events: content },
    coverage: { status: coverage.length ? 'recorded' as const : 'not_reviewed' as const, projectionRevisionId, events: coverage,
      decisions: body.content.segments.map(segment => {
        const opinions = coverage.flatMap(event => event.decisions.filter(decision => decision.segmentId === segment.segmentId).map(decision => ({ eventId: event.eventId, ...decision })));
        const states = new Set(opinions.map(opinion => opinion.status));
        const status = states.has('gap') ? 'gap' as const : !states.size || states.has('unknown') || states.size > 1 ? 'unknown' as const : opinions[0].status;
        return { segmentId: segment.segmentId, status, opinions };
      }) },
    usage: active.filter((event): event is Extract<KnowledgeReviewEvent, { eventKind: 'task_use' }> => event.eventKind === 'task_use'),
  };
}
