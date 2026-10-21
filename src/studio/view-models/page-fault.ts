/** Page failures are decided before Next streams; no raw source error enters this projection. */
export interface StudioPageFault {
  faultCode: 'studio_source_unavailable' | 'core_studio_source_unavailable' | 'core_run_not_found'
    | 'skill_not_found' | 'doctor_run_not_found' | 'conversation_or_task_not_found'
    | 'analysis not found' | 'missing from/to query params';
  statusCode: 400 | 404 | 503;
  section: 'observe' | 'measure' | 'knowledge';
  returnTo: 'observe' | 'inbox' | 'health' | 'measure' | 'knowledge';
  returnHref: string;
  retryHref?: string;
}
