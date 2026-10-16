import { z } from 'zod';
import { canonicalJson } from '../store.js';

const id = z.string().uuid();
const text = z.string().trim().min(1).max(4096);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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
export const EntityLinkConflictCodeSchema = z.enum(['entity_changed', 'source_unavailable', 'identity_unresolved', 'owner_conflict', 'library_changed', 'library_capacity', 'pair_already_reviewed']);
export class EntityLinkConflictError extends Error {
  constructor(readonly conflictCode: z.infer<typeof EntityLinkConflictCodeSchema>) { super(`Entity-link ${conflictCode} conflict.`); }
}
