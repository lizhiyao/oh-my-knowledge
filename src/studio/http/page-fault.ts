import type { StudioPageFault } from '../view-models/page-fault.js';
import { HEALTH_INDEX_PATH, KNOWLEDGE_INDEX_PATH, MEASURE_INDEX_PATH, OBSERVE_INBOX_PATH, OBSERVE_INDEX_PATH } from './page-paths.js';

/** Only mounted lists and the original request can become recovery destinations. */
export function projectPageFault(
  faultCode: StudioPageFault['faultCode'],
  returnTo: StudioPageFault['returnTo'],
  requestUrl: string,
  hasNavigation: boolean,
): StudioPageFault {
  const statusCode = faultCode === 'missing from/to query params' ? 400
    : faultCode === 'studio_source_unavailable' || faultCode === 'core_studio_source_unavailable' ? 503 : 404;
  const url = new URL(requestUrl, 'http://studio.invalid');
  // The preview host mounts only Measure, even when a caller supplies a workspace query.
  const destination = hasNavigation ? returnTo : 'measure';
  // Health reports live under Observe URLs but belong to Knowledge navigation.
  const section = destination === 'measure' ? 'measure'
    : destination === 'knowledge' || destination === 'health' ? 'knowledge' : 'observe';
  const paths = { observe: OBSERVE_INDEX_PATH, inbox: OBSERVE_INBOX_PATH, health: HEALTH_INDEX_PATH,
    measure: MEASURE_INDEX_PATH, knowledge: KNOWLEDGE_INDEX_PATH };
  const back = new URL(paths[destination], 'http://studio.invalid');
  const workspace = url.searchParams.get('workspace');
  if (hasNavigation && workspace) back.searchParams.set('workspace', workspace);
  return {
    faultCode, statusCode, section, returnTo: destination,
    returnHref: `${back.pathname}${back.search}`,
    ...(statusCode !== 400 ? { retryHref: `${url.pathname}${url.search}` } : {}),
  };
}
