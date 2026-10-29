const rejectedCodes = new Set([
  'knowledge_conflict', 'knowledge_storage_unsupported', 'knowledge_workspace_busy', 'knowledge_tags_invalid', 'knowledge_capacity_exceeded', 'knowledge_citations_invalid',
  'carrier_conflict', 'carrier_knowledge_region_conflict', 'carrier_invalid_skill', 'carrier_source_contains_destination', 'carrier_capacity_exceeded',
  'request_body_too_large',
  'knowledge_study_input_invalid', 'knowledge_study_capacity_exceeded', 'knowledge_study_host_mismatch', 'knowledge_study_evidence_invalid',
]);
const responseCodes = new Set([...rejectedCodes, 'knowledge_study_busy', 'knowledge_study_unavailable', 'entity_link_input_invalid', 'entity_link_confirmation_invalid', 'entity_link_outcome_unconfirmed', 'entity_link_identity_unresolved', 'entity_link_kind_mismatch', 'knowledge_request_failed', 'carrier_request_failed', 'carrier_invalid_metadata']);

/** Generic server failures and unreadable acknowledgements do not prove a write was rejected. */
export class KnowledgeRequestError extends Error {
  readonly definiteRejection: boolean;
  constructor(code: string, readonly status: number) {
    super(code); this.name = 'KnowledgeRequestError';
    this.definiteRejection = status >= 400 && status < 500 && rejectedCodes.has(code);
  }
}

export async function requestKnowledge<T>(resource: 'candidates' | 'library' | 'artifacts' | 'auto-extraction' | 'entity-links' | 'study' | 'reviews',
  payload: object, signal?: AbortSignal, onResponse?: (metadata: { etag: string | null }) => void): Promise<T> {
  signal?.throwIfAborted();
  const response = await fetch(`/api/knowledge/${resource}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal });
  let data: unknown;
  try { data = await response.json(); }
  catch { signal?.throwIfAborted(); throw new KnowledgeRequestError('knowledge_response_unreadable', response.status); }
  signal?.throwIfAborted();
  if (!response.ok) {
    const code = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && responseCodes.has(data.error)
      ? data.error : 'knowledge_request_failed';
    throw new KnowledgeRequestError(code, response.status);
  }
  onResponse?.({ etag: response.headers.get('etag') });
  return data as T;
}
