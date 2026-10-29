import type { KnowledgeAssociationRevision } from '../associations.js';
import type { KnowledgeRevision } from '../contracts.js';
import type { EntityAnalysisEnvelope } from './contracts.js';

/** Resolve one declared catalog independently so a missing peer cannot erase healthy mappings. */
export function validateKnowledgeAssociationCatalogReferences(revision: KnowledgeAssociationRevision, body: KnowledgeRevision,
  analysis: EntityAnalysisEnvelope, entityRevisionId: string): void {
  const catalog = analysis.revisions.find(item => item.revisionId === entityRevisionId);
  if (!catalog) throw new Error('Unknown association entity revision.');
  if (!body.content.segments.some(segment => segment.evidence.some(evidence => evidence.source.snapshotId === analysis.snapshotId
    && evidence.source.sourceVersion === analysis.sourceVersion))) throw new Error('Association catalog source is outside its body.');
  for (const ref of revision.segmentEntityRefs.filter(ref => ref.analysisId === analysis.analysisId && ref.entityRevisionId === entityRevisionId)) {
    const segment = body.content.segments.find(item => item.segmentId === ref.segmentId);
    if (!catalog.entities.some(entity => entity.entityId === ref.entityId)
      || !segment?.evidence.some(evidence => evidence.source.snapshotId === analysis.snapshotId && evidence.source.sourceVersion === analysis.sourceVersion)
      || ref.mentionIds.some(id => !catalog.mentions.some(mention => mention.mentionId === id && mention.entityId === ref.entityId))) {
      throw new Error('Association entity catalog mismatch.');
    }
  }
}
