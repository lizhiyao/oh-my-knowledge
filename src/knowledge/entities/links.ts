import { z } from 'zod';
import { KnowledgeActorSchema } from '../contracts.js';
import { LibraryWriteSchema, type LibraryStore } from '../library/contracts.js';
import { canonicalJson } from '../store.js';

const id = z.string().uuid();
const text = z.string().trim().min(1).max(4096);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const human = KnowledgeActorSchema.refine(actor => actor.actorKind === 'human', 'Entity links require an explicit human decision.');
export type EntityLinkHash = (value: unknown) => string;
export const EntityLinkEndpointSchema = z.strictObject({
  analysisId: id, entityId: id, entityRevisionId: id, generation: z.number().int().positive(),
  snapshotId: id, sourceVersion: digest, owner: z.strictObject({ objectId: id, generation: z.number().int().positive(), headRevisionId: id }).nullable(), mentionIds: z.array(id).min(1).max(64),
}).refine(value => new Set(value.mentionIds).size === value.mentionIds.length, 'Duplicate entity-link mention.');
export type EntityLinkEndpoint = z.infer<typeof EntityLinkEndpointSchema>;
type SourceIdentity = Pick<EntityLinkEndpoint, 'analysisId' | 'entityId' | 'entityRevisionId' | 'snapshotId' | 'sourceVersion'>;
export function entityLinkPairKey(left: SourceIdentity, right: SourceIdentity, hash: EntityLinkHash): string {
  return hash([left, right].map(({ analysisId, entityId, entityRevisionId, snapshotId, sourceVersion }) => canonicalJson({ analysisId, entityId, entityRevisionId, snapshotId, sourceVersion })).sort());
}
export const EntityLinkSuggestionSchema = z.strictObject({
  responseKind: z.literal('entity-link-suggestion'), schemaVersion: z.literal(1),
  leftEntityId: id, rightEntityId: id,
  assessment: z.enum(['same_object', 'different_objects', 'insufficient_evidence']),
  leftMentionIds: z.array(id).min(1).max(64), rightMentionIds: z.array(id).min(1).max(64), rationale: text,
});
const evidence = z.strictObject({
  executor: text, model: text, promptVersion: z.string().regex(/^entity-link-proposal-v[1-9]\d*$/), promptHash: digest,
  rawOutput: z.string().refine(value => new TextEncoder().encode(value).byteLength <= 512 * 1024, 'Entity-link response capacity exceeded.'),
  durationMs: z.number().finite().nonnegative(), inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(), costUSD: z.number().finite().nonnegative().optional(),
});
export const EntityLinkCaptureSchema = z.strictObject({
  reviewId: id, requestId: id, left: EntityLinkEndpointSchema, right: EntityLinkEndpointSchema,
  inputDigest: digest, evidence,
}).refine(value => value.left.analysisId !== value.right.analysisId, 'Select two different source windows.');
export type EntityLinkCapture = z.infer<typeof EntityLinkCaptureSchema>;
const event = { eventId: id, requestId: id, commandDigest: digest, at: z.iso.datetime({ offset: true }).max(64), actor: human };
const receipt = z.strictObject({ requestId: id, commandDigest: digest, committedGeneration: z.number().int().positive(), revisionId: id });
export const EntityLinkEventSchema = z.discriminatedUnion('eventKind', [
  z.strictObject({ ...event, eventKind: z.literal('recorded') }),
  z.strictObject({ ...event, eventKind: z.literal('reviewed'), decision: z.enum(['accept', 'reject']), reason: text,
    objectLabel: text.max(256).nullable(), applicationIntent: LibraryWriteSchema.nullable() }),
  z.strictObject({ ...event, eventKind: z.literal('applied'), receipt }),
  z.strictObject({ ...event, eventKind: z.literal('conflict'), conflictCode: z.enum(['entity_changed', 'source_unavailable', 'identity_unresolved', 'owner_conflict', 'library_changed', 'library_capacity', 'pair_already_reviewed']) }),
]);
export type EntityLinkEvent = z.infer<typeof EntityLinkEventSchema>;
export const EntityLinkReviewSchema = z.strictObject({
  storeKind: z.literal('entity-link-review-history'), schemaVersion: z.literal(1),
  capture: EntityLinkCaptureSchema, pairKey: digest, duplicateOf: id.nullable(), retrievalPolicy: z.literal('entity-link-retrieval/v1'),
  suggestion: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('admitted'), value: EntityLinkSuggestionSchema }),
    z.strictObject({ status: z.literal('invalid'), errorCode: z.literal('invalid_response') }),
  ]),
  generation: z.number().int().positive(), writeHeadEventId: id,
  events: z.array(EntityLinkEventSchema).min(1).max(8),
});
export type EntityLinkReview = z.infer<typeof EntityLinkReviewSchema>;
export function entityLinkAdmission(capture: EntityLinkCapture): EntityLinkReview['suggestion'] {
  try {
    const value = EntityLinkSuggestionSchema.parse(JSON.parse(capture.evidence.rawOutput));
    for (const side of ['left', 'right'] as const) {
      const mentions = value[`${side}MentionIds`];
      if (value[`${side}EntityId`] !== capture[side].entityId || new Set(mentions).size !== mentions.length
        || mentions.some(id => !capture[side].mentionIds.includes(id))) throw new Error('Entity-link evidence mismatch.');
    }
    return { status: 'admitted', value };
  } catch { return { status: 'invalid', errorCode: 'invalid_response' }; }
}
export function validateEntityLinkReview(input: EntityLinkReview, hash: EntityLinkHash): EntityLinkReview {
  const review = EntityLinkReviewSchema.parse(input);
  if (review.generation !== review.events.length || review.writeHeadEventId !== review.events.at(-1)!.eventId
    || review.duplicateOf === review.capture.reviewId
    || review.pairKey !== entityLinkPairKey(review.capture.left, review.capture.right, hash)
    || canonicalJson(review.suggestion) !== canonicalJson(entityLinkAdmission(review.capture))) throw new Error('Invalid entity-link history.');
  const [first, decision, applied] = review.events;
  if (first.eventKind !== 'recorded' || first.requestId !== review.capture.requestId || first.commandDigest !== hash({ capture: review.capture, duplicateOf: review.duplicateOf })
    || new Set(review.events.map(event => event.eventId)).size !== review.events.length
    || new Set(review.events.map(event => event.requestId)).size !== review.events.length || review.events.length > 3) throw new Error('Invalid entity-link event identities.');
  if (!decision) return review;
  if (decision.eventKind !== 'reviewed' || (decision.decision === 'reject' && (decision.objectLabel || decision.applicationIntent || applied))) throw new Error('Invalid entity-link decision.');
  if (decision.commandDigest !== hash({ reviewId: review.capture.reviewId, requestId: decision.requestId,
    decision: decision.decision, reason: decision.reason, objectLabel: decision.objectLabel, actor: decision.actor })) throw new Error('Entity-link decision digest mismatch.');
  if (decision.decision === 'accept') {
    if (review.duplicateOf && (decision.applicationIntent || applied?.eventKind !== 'conflict' || applied.conflictCode !== 'pair_already_reviewed')) throw new Error('Duplicate entity-link capture cannot be applied.');
    if (review.suggestion.status !== 'admitted' || (!decision.applicationIntent && applied?.eventKind !== 'conflict')) throw new Error('Invalid entity-link application intent.');
    if (decision.applicationIntent && (canonicalJson(decision.actor) !== canonicalJson(decision.applicationIntent.revision.revisedBy)
      || decision.applicationIntent.revision.reason !== decision.reason)) throw new Error('Entity-link application author mismatch.');
    const intent = decision.applicationIntent;
    if (intent) {
      if (decision.objectLabel && intent.revision.draft.label !== decision.objectLabel) throw new Error('Entity-link organization label mismatch.');
      const endpoints = [review.capture.left, review.capture.right];
      const owners = endpoints.flatMap(endpoint => endpoint.owner ? [endpoint.owner] : []);
      if ((!owners.length && intent.revision.draft.members.length !== 2) || owners.length > 1 || (owners[0] ? intent.objectId !== owners[0].objectId
        || intent.expectedGeneration !== owners[0].generation || intent.expectedHeadRevisionId !== owners[0].headRevisionId
        : intent.expectedGeneration !== 0 || intent.expectedHeadRevisionId !== null)) throw new Error('Entity-link intent owner mismatch.');
      for (const endpoint of endpoints) {
        const member = intent.revision.draft.members.find(member => member.analysisId === endpoint.analysisId && member.entityId === endpoint.entityId);
        if (!member || member.entityRevisionId !== endpoint.entityRevisionId || canonicalJson(member.mentionIds) !== canonicalJson(endpoint.mentionIds)
          || member.rationale !== decision.reason) throw new Error('Entity-link intent endpoint mismatch.');
      }
    }
  }
  if (applied) {
    if (!['applied', 'conflict'].includes(applied.eventKind) || canonicalJson(applied.actor) !== canonicalJson(decision.actor)) throw new Error('Invalid entity-link application event.');
    if (applied.eventKind === 'conflict' && applied.commandDigest !== hash({ conflictCode: applied.conflictCode, decisionRequestId: decision.requestId })) throw new Error('Entity-link conflict digest mismatch.');
    if (applied.eventKind === 'applied') {
      const intent = decision.applicationIntent;
      if (applied.commandDigest !== hash(applied.receipt) || !intent || applied.requestId !== intent.requestId || applied.receipt.requestId !== intent.requestId
        || applied.receipt.revisionId !== intent.revision.revisionId || applied.receipt.committedGeneration !== intent.expectedGeneration + 1
        || applied.receipt.commandDigest !== hash(intent)) throw new Error('Entity-link receipt mismatch.');
    }
  }
  return review;
}
export class EntityLinkConflictError extends Error {
  constructor(readonly conflictCode: Extract<EntityLinkEvent, { eventKind: 'conflict' }>['conflictCode']) { super(`Entity-link ${conflictCode} conflict.`); }
}
export interface EntityLinkTransaction {
  library: LibraryStore;
  list(): EntityLinkReview[];
  read(reviewId: string): EntityLinkReview;
  create(review: EntityLinkReview): void;
  append(reviewId: string, expectedGeneration: number, events: EntityLinkEvent[]): EntityLinkReview;
}
export interface EntityLinkStore {
  list(): EntityLinkReview[];
  read(reviewId: string): EntityLinkReview;
  /** Review transitions and library publication share one workspace lock. */
  transaction<T>(operation: (transaction: EntityLinkTransaction) => T): T;
}
