import { z } from 'zod';
import { EntityMentionSchema, KnowledgeActorSchema, type KnowledgeActor } from '../contracts.js';
import { entityIdentityShape } from './identity.js';

const text = z.string().trim().min(1).max(4096);
const uuid = z.string().uuid();
const sourceVersion = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const AnalyzedEntitySchema = z.strictObject({
  entityId: uuid, label: text, description: text, qualifiers: z.array(text).max(32),
  identityStatus: z.enum(['proposed', 'unresolved']),
  possibleEntityIds: z.array(uuid).max(32), uncertainties: z.array(text).max(32),
  ...entityIdentityShape(uuid),
}).superRefine((entity, context) => {
  if (entity.identityStatus === 'unresolved' && !entity.uncertainties.length) {
    context.addIssue({ code: 'custom', path: ['uncertainties'], message: 'Unresolved identity needs a reason.' });
  }
  if (entity.identityStatus === 'proposed' && entity.possibleEntityIds.length) {
    context.addIssue({ code: 'custom', path: ['possibleEntityIds'], message: 'Possible targets belong to unresolved identities.' });
  }
});
export type AnalyzedEntity = z.infer<typeof AnalyzedEntitySchema>;
export const EntityAnalysisDraftSchema = z.strictObject({
  entities: z.array(AnalyzedEntitySchema).max(256),
  mentions: z.array(EntityMentionSchema.extend({ mentionId: uuid, entityId: uuid })).max(512),
  limitations: z.array(text).max(64),
});
export type EntityAnalysisDraft = z.infer<typeof EntityAnalysisDraftSchema>;
export const EntityAnalysisRevisionSchema = EntityAnalysisDraftSchema.extend({
  revisionId: uuid, parentRevisionId: uuid.optional(),
  revisedAt: z.iso.datetime({ offset: true }), revisedBy: KnowledgeActorSchema, revisionReason: text,
});
export type EntityAnalysisRevision = z.infer<typeof EntityAnalysisRevisionSchema>;
export const EntityAnalysisEnvelopeSchema = z.strictObject({
  storeKind: z.literal('entity-analysis-history'), schemaVersion: z.literal(2),
  analysisId: uuid, snapshotId: uuid, sourceVersion,
  generation: z.number().int().positive(), writeHeadRevisionId: uuid,
  revisions: z.array(EntityAnalysisRevisionSchema).min(1).max(1024),
  receipts: z.array(z.strictObject({
    requestId: uuid, commandDigest: z.string().min(1), committedGeneration: z.number().int().positive(), revisionId: uuid,
  })).min(1).max(1024),
});
export type EntityAnalysisEnvelope = z.infer<typeof EntityAnalysisEnvelopeSchema>;
export const EntityAnalysisWriteSchema = z.strictObject({
  requestId: uuid, analysisId: uuid, snapshotId: uuid, sourceVersion,
  expectedGeneration: z.number().int().nonnegative(), expectedHeadRevisionId: uuid.nullable(),
  revision: EntityAnalysisRevisionSchema,
});
export type EntityAnalysisWrite = z.infer<typeof EntityAnalysisWriteSchema>;
export interface EntityAnalysisStore {
  /** A corrupt analysis is reported separately; other saved analyses remain discoverable. */
  list(): { histories: EntityAnalysisEnvelope[]; unavailable: number };
  read(analysisId: string): EntityAnalysisEnvelope;
  write(command: EntityAnalysisWrite, actor: KnowledgeActor): EntityAnalysisEnvelope['receipts'][number];
}
