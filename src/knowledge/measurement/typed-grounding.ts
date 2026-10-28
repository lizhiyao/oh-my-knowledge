// Frozen typed measurement DTO only; not canonical body data or a current KnowledgeStore reader.
// Preserves existing measurement prompt/wire shapes; no lifecycle or persistence adapter here.
import { z } from 'zod';
import { EntityMentionSchema, EvidenceSelectionSchema } from './typed-contracts.js';

const id = z.string().min(1).max(256);
export const GroundingSchema = z.strictObject({
  revisionId: id,
  mentions: z.array(EntityMentionSchema).min(1).max(512),
  citations: z.array(z.strictObject({ evidenceLinkId: id, selection: EvidenceSelectionSchema })).min(1).max(512),
  sourceBindings: z.array(z.strictObject({ snapshotId: z.string().uuid(), sourceVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/), evidenceRefs: z.array(id).min(1) })).min(1),
  reuseRationale: z.string().min(1).max(4096),
  identityUncertainties: z.array(z.string().min(1).max(4096)).max(64),
  entityAnalysisRef: z.strictObject({ analysisId: z.string().uuid(), revisionId: z.string().uuid() }).optional(),
});
export type KnowledgeGrounding = z.infer<typeof GroundingSchema>;
