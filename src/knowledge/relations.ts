import { z } from 'zod';
import { KnowledgeBodyEvidenceSchema, KnowledgeBodyRefSchema, type KnowledgeActor } from './contracts.js';
import { KnowledgeReviewActorSchema } from './reviews.js';

const id = z.string().uuid();
const text = z.string().trim().min(1).max(4096);
const segmentId = z.string().min(1).max(256).refine(value => !!value.trim());
const uniqueIds = z.array(id).max(256).refine(values => new Set(values).size === values.length, 'Duplicate event reference.');
export class KnowledgeRelationError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'unavailable', message: string) { super(message); this.name = 'KnowledgeRelationError'; }
}
export const KnowledgeRelationEndpointSchema = z.strictObject({
  bodyRef: KnowledgeBodyRefSchema,
  segmentIds: z.array(segmentId).min(1).max(4096).refine(values => new Set(values).size === values.length, 'Duplicate relation segment.').optional(),
});
export const KnowledgeRelationEvidenceSchema = KnowledgeBodyEvidenceSchema.extend({
  side: z.enum(['from', 'to']),
  bodySelection: z.strictObject({ segmentId, start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) })
    .refine(value => value.end > value.start, 'Invalid relation body range.'),
});
export const KnowledgeRelationProposalSchema = z.strictObject({
  parentRelationRevisionId: id.nullable(), relationType: z.enum(['supplements', 'conflicts_with']),
  from: KnowledgeRelationEndpointSchema, to: KnowledgeRelationEndpointSchema,
  question: text, conditions: z.array(text).min(1).max(64),
  comparisonScope: z.strictObject({ status: z.enum(['same', 'different', 'unknown']), subject: text, modality: text, time: text, version: text, reason: text }),
  basis: z.enum(['source_assertion', 'inference']), reason: text, limitations: z.array(text).max(64),
  evidence: z.array(KnowledgeRelationEvidenceSchema).min(2).max(256),
}).superRefine((value, ctx) => {
  if (value.from.bodyRef.knowledgeId === value.to.bodyRef.knowledgeId) ctx.addIssue({ code: 'custom', message: 'Relations require two different knowledge identities.' });
  if (value.relationType === 'conflicts_with' && value.comparisonScope.status === 'different') ctx.addIssue({ code: 'custom', message: 'Different applicability cannot form a conflict relation.' });
  if (!value.evidence.some(e => e.side === 'from') || !value.evidence.some(e => e.side === 'to')) ctx.addIssue({ code: 'custom', message: 'Both relation endpoints require body and source evidence.' });
});
const writeIdentity = { relationId: id, requestId: id, expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), expectedHeadEventId: id.nullable() };
export const KnowledgeRelationProposeInputSchema = KnowledgeRelationProposalSchema.safeExtend(writeIdentity);
export const KnowledgeRelationReviewInputSchema = z.strictObject({
  ...writeIdentity, relationRevisionId: id, choice: z.enum(['accept', 'reject']), reason: text, limitations: z.array(text).max(64),
  checkedEvidenceIndices: z.array(z.number().int().nonnegative()).max(256).refine(values => new Set(values).size === values.length, 'Duplicate checked evidence.'),
  supersedesReviewEventIds: uniqueIds,
});
export const KnowledgeRelationWithdrawInputSchema = z.strictObject({ ...writeIdentity, relationRevisionId: id, reason: text, limitations: z.array(text).max(64) });
export const KnowledgeRelationWriteSchema = z.discriminatedUnion('eventKind', [
  KnowledgeRelationProposeInputSchema.safeExtend({ eventKind: z.literal('relation_proposed') }),
  KnowledgeRelationReviewInputSchema.extend({ eventKind: z.literal('relation_reviewed') }),
  KnowledgeRelationWithdrawInputSchema.extend({ eventKind: z.literal('relation_withdrawn') }),
]);
const eventIdentity = { eventId: id, parentEventId: id.nullable(), actor: KnowledgeReviewActorSchema, at: z.iso.datetime({ offset: true }) };
const omitWriteIdentity = { relationId: true, requestId: true, expectedGeneration: true, expectedHeadEventId: true } as const;
export const KnowledgeRelationEventSchema = z.discriminatedUnion('eventKind', [
  KnowledgeRelationProposalSchema.safeExtend({ ...eventIdentity, eventKind: z.literal('relation_proposed') }),
  KnowledgeRelationReviewInputSchema.omit(omitWriteIdentity).extend({ ...eventIdentity, eventKind: z.literal('relation_reviewed') }),
  KnowledgeRelationWithdrawInputSchema.omit(omitWriteIdentity).extend({ ...eventIdentity, eventKind: z.literal('relation_withdrawn') }),
]);
export const KnowledgeRelationReceiptSchema = z.strictObject({ requestId: id, commandDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), committedGeneration: z.number().int().positive(), eventId: id });
export const KnowledgeRelationEnvelopeSchema = z.strictObject({
  storeKind: z.literal('knowledge-relation-history'), schemaVersion: z.literal(1), namespace: segmentId, relationId: id,
  generation: z.number().int().positive(), writeHeadEventId: id,
  events: z.array(KnowledgeRelationEventSchema).min(1).max(4096), receipts: z.array(KnowledgeRelationReceiptSchema).min(1).max(4096),
});
export type KnowledgeRelationEndpoint = z.infer<typeof KnowledgeRelationEndpointSchema>;
export type KnowledgeRelationEvidence = z.infer<typeof KnowledgeRelationEvidenceSchema>;
export type KnowledgeRelationProposal = z.infer<typeof KnowledgeRelationProposalSchema>;
export type KnowledgeRelationProposeInput = z.input<typeof KnowledgeRelationProposeInputSchema>;
export type KnowledgeRelationReviewInput = z.input<typeof KnowledgeRelationReviewInputSchema>;
export type KnowledgeRelationWithdrawInput = z.input<typeof KnowledgeRelationWithdrawInputSchema>;
export type KnowledgeRelationWrite = z.infer<typeof KnowledgeRelationWriteSchema>;
export type KnowledgeRelationEvent = z.infer<typeof KnowledgeRelationEventSchema>;
export type KnowledgeRelationProposedEvent = Extract<KnowledgeRelationEvent, { eventKind: 'relation_proposed' }>;
export type KnowledgeRelationEnvelope = z.infer<typeof KnowledgeRelationEnvelopeSchema>;
export type KnowledgeRelationReceipt = z.infer<typeof KnowledgeRelationReceiptSchema>;
export interface KnowledgeRelationGap { relationId?: string; reason: 'corrupt' | 'unsupported' | 'capacity' | 'invalid_entry' }
export interface KnowledgeRelationInventory { histories: KnowledgeRelationEnvelope[]; unavailable: KnowledgeRelationGap[]; completeness: 'complete' | 'partial' }
export interface KnowledgeRelationStore {
  read(relationId: string): KnowledgeRelationEnvelope | undefined;
  inventory(knowledgeIds?: ReadonlySet<string>): KnowledgeRelationInventory;
  /** Called only for a new request, under the shared workspace lock after receipt/CAS/history checks. */
  write(command: KnowledgeRelationWrite, actor: KnowledgeActor, at: string, validate: () => void): KnowledgeRelationReceipt;
}
