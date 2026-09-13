import type { CoreStudioCatalog } from '../../view-models/core-runs.js';
import { JSON_HEADERS } from '../errors.js';

export interface CoreStudioRouteRequest {
  readonly method?: string;
  readonly url?: string;
}

export interface CoreStudioRouteResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CoreStudioRouteHandlerOptions {
  readonly catalog: CoreStudioCatalog;
  readonly apiBasePath: string;
}

export type CoreStudioRouteHandler = (
  request: CoreStudioRouteRequest,
) => Promise<CoreStudioRouteResponse | undefined>;

function normalizeBasePath(value: string, name: string): string {
  if (
    !value.startsWith('/')
    || value === '/'
    || value.endsWith('/')
    || value.includes('//')
    || value.includes('?')
    || value.includes('#')
    || /[\s\\]/u.test(value)
  ) {
    throw new TypeError(`${name} must be an absolute, non-root path without a trailing slash, query, or fragment`);
  }
  return value;
}

function splitRequestUrl(value: string): { path: string } {
  const fragmentIndex = value.indexOf('#');
  const withoutFragment = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf('?');
  return { path: queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex) };
}

interface ApiPathMatch {
  readonly matched: boolean;
  readonly runId?: string;
}

function matchApiPath(path: string, basePath: string): ApiPathMatch {
  const prefix = `${basePath}/`;
  if (!path.startsWith(prefix)) return { matched: false };
  const encoded = path.slice(prefix.length);
  if (!encoded || encoded.includes('/')) return { matched: true };
  try {
    return { matched: true, runId: decodeURIComponent(encoded) };
  } catch {
    return { matched: true };
  }
}

function json(status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): CoreStudioRouteResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({ ...JSON_HEADERS, ...extraHeaders }),
    body: JSON.stringify(body),
  });
}

/**
 * `/measure` 的 HTML 面由 `web/app/measure/**`（React）渲染；这里只保留机器可读的 JSON 资源，
 * 让嵌入宿主不必启 UI 也能取到同一份投影。
 */
export function createCoreStudioRouteHandler(
  options: CoreStudioRouteHandlerOptions,
): CoreStudioRouteHandler {
  const apiBasePath = normalizeBasePath(options.apiBasePath, 'apiBasePath');

  return async (request) => {
    const { path } = splitRequestUrl(request.url ?? '/');
    const apiRun = matchApiPath(path, apiBasePath);
    const isMatched = path === apiBasePath || apiRun.matched;
    if (!isMatched) return undefined;

    if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    }

    try {
      if (path === apiBasePath) {
        return json(200, await options.catalog.list());
      }
      // `isMatched` 已经把请求限定成「基路径」或「其下一层子路径」，这里只剩后者。
      if (apiRun.runId === undefined) return json(404, { error: 'core_run_not_found' });
      const detail = await options.catalog.get(apiRun.runId);
      return detail === undefined
        ? json(404, { error: 'core_run_not_found' })
        : json(200, detail);
    } catch {
      return json(503, { error: 'core_studio_source_unavailable' });
    }
  };
}
