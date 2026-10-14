import { KNOWLEDGE_LIBRARY_PATH, KNOWLEDGE_ENTITIES_PATH } from '../../../http/page-paths';
import { requestKnowledge } from './request';

export async function requestLibrary<T>(workspace: string, operation: string, fields: object = {}, signal?: AbortSignal): Promise<T> {
  return requestKnowledge<T>('library', { workspace, operation, ...fields }, signal);
}
export async function requestLibraryEntity<T>(workspace: string, operation: string, fields: object, signal?: AbortSignal): Promise<T> {
  return requestKnowledge<T>('candidates', { workspace, operation, ...fields }, signal);
}
export function libraryUrl(workspace: string, objectId: string, revision?: string) {
  return `${KNOWLEDGE_LIBRARY_PATH}?${new URLSearchParams({ workspace, object: objectId, ...(revision ? { revision } : {}) })}`;
}
export function libraryEntityUrl(workspace: string, ref: { analysisId: string; entityId: string; entityRevisionId: string }) {
  return `${KNOWLEDGE_ENTITIES_PATH}?${new URLSearchParams({ workspace, analysis: ref.analysisId, entity: ref.entityId, revision: ref.entityRevisionId })}`;
}
