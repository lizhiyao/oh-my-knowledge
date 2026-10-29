/** One-off migration parser. Current readers never import this module. */
import { z } from 'zod';
import { KnowledgeAssociationEnvelopeSchema, KnowledgeAssociationRevisionSchema, validateKnowledgeAssociationHistory,
  type KnowledgeAssociationRevision } from '../associations.js';

const id = z.string().min(1).max(256), endpoint = z.strictObject({ entityId: id });
const legacyRevision = KnowledgeAssociationRevisionSchema.omit({ catalogRefs: true, segmentEntityRefs: true, typedRelations: true }).extend({
  entityAnalysisRef: z.strictObject({ analysisId: z.string().uuid(), revisionId: z.string().uuid() }).optional(),
  segmentEntityRefs: z.array(z.strictObject({ segmentId: id, entityId: id, mentionIds: z.array(id).min(1) })),
  typedRelations: z.array(KnowledgeAssociationRevisionSchema.shape.typedRelations.unwrap().element.omit({ subject: true, object: true }).extend({
    subject: endpoint, object: endpoint.optional(),
  })).optional(),
});
const legacyEnvelope = KnowledgeAssociationEnvelopeSchema.extend({ schemaVersion: z.literal(1), revisions: z.array(legacyRevision).min(1) });
export type LegacyAssociationEnvelope = z.infer<typeof legacyEnvelope>;

export function qualifyLegacyAssociation(revision: z.infer<typeof legacyRevision>): Omit<KnowledgeAssociationRevision, 'revisionId' | 'parentRevisionId' | 'revisedAt' | 'revisedBy' | 'revisionReason'> {
  const { entityAnalysisRef: ref, segmentEntityRefs, typedRelations } = revision;
  if (!ref && (segmentEntityRefs.length || typedRelations?.length)) throw new Error('Legacy relations lack an exact catalog.');
  const catalog = ref ? { analysisId: ref.analysisId, entityRevisionId: ref.revisionId } : undefined;
  return { bodyRef: revision.bodyRef, status: revision.status, issues: revision.issues, reviewStatus: 'pending', catalogRefs: catalog ? [catalog] : [],
    segmentEntityRefs: segmentEntityRefs.map(item => ({ ...item, ...catalog! })),
    ...(typedRelations ? { typedRelations: typedRelations.map(({ subject, object, ...item }) => ({ ...item,
      subject: { ...subject, ...catalog! }, ...(object ? { object: { ...object, ...catalog! } } : {}),
    })) } : {}),
  };
}
export function parseLegacyAssociationEnvelope(input: unknown): LegacyAssociationEnvelope {
  const history = legacyEnvelope.parse(input);
  // Check original lineage, receipts and review targets without a runtime v1 reader.
  validateKnowledgeAssociationHistory({ ...history, schemaVersion: 2,
    revisions: history.revisions.map(revision => ({ ...qualifyLegacyAssociation(revision), revisionId: revision.revisionId,
      ...(revision.parentRevisionId ? { parentRevisionId: revision.parentRevisionId } : {}),
      revisedAt: revision.revisedAt, revisedBy: revision.revisedBy, revisionReason: revision.revisionReason })),
  });
  return history;
}
