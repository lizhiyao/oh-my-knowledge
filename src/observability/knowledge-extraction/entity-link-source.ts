import type { KnowledgeApplication } from './application.js';
import { EntityLinkConflictError, type EntityLinkEndpoint } from '../../knowledge/entities/links.js';
import { validateEvidenceSelection } from '../../knowledge/validation.js';

/** Called inside the workspace transaction immediately before organization publication. */
export function currentEntityLinkSource(knowledge: KnowledgeApplication, endpoint: EntityLinkEndpoint) {
  let detail: ReturnType<KnowledgeApplication['entityDetail']>;
  try { detail = knowledge.entityDetail(endpoint.analysisId, endpoint.entityId, endpoint.entityRevisionId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      || (error instanceof Error && ['Entity analysis revision is missing.', 'Entity is absent from the selected revision.'].includes(error.message))) {
      throw new EntityLinkConflictError('entity_changed');
    }
    throw error;
  }
  if (detail.history.writeHeadRevisionId !== endpoint.entityRevisionId || detail.history.generation !== endpoint.generation
    || detail.history.snapshotId !== endpoint.snapshotId || detail.history.sourceVersion !== endpoint.sourceVersion) throw new EntityLinkConflictError('entity_changed');
  if (detail.source.status !== 'available') throw new EntityLinkConflictError('source_unavailable');
  if (endpoint.mentionIds.some(id => {
    const mention = detail.revision.mentions.find(value => value.mentionId === id && value.entityId === endpoint.entityId);
    return !mention || validateEvidenceSelection(mention.selection, detail.source.status === 'available' ? detail.source.window.excerpts : []).length;
  })) throw new EntityLinkConflictError('entity_changed');
  return detail;
}
