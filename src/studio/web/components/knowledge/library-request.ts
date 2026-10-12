import { KNOWLEDGE_LIBRARY_PATH, KNOWLEDGE_ENTITIES_PATH } from '../../../http/page-paths';

export async function requestLibrary<T>(workspace: string, operation: string, fields: object = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/knowledge/library', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, operation, ...fields }), signal });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'knowledge_request_failed'); return data as T;
}
export async function requestLibraryEntity<T>(workspace: string, operation: string, fields: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/knowledge/candidates', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace, operation, ...fields }), signal });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'knowledge_request_failed'); return data as T;
}
export function libraryUrl(workspace: string, objectId: string, revision?: string) {
  return `${KNOWLEDGE_LIBRARY_PATH}?${new URLSearchParams({ workspace, object: objectId, ...(revision ? { revision } : {}) })}`;
}
export function libraryEntityUrl(workspace: string, ref: { analysisId: string; entityId: string; entityRevisionId: string }) {
  return `${KNOWLEDGE_ENTITIES_PATH}?${new URLSearchParams({ workspace, analysis: ref.analysisId, entity: ref.entityId, revision: ref.entityRevisionId })}`;
}
