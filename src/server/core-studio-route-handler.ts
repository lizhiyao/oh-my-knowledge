import type { CoreStudioCatalog } from '../eval-workflows/studio-catalog/index.js';
import {
  coreStudioMethodNotAllowedMessage,
  coreStudioSourceUnavailableMessage,
  renderCoreRunDetail,
  renderCoreRunList,
  renderCoreStudioError,
  type CoreStudioRenderRoutes,
} from '../renderer/core-run-renderer.js';
import type { Lang } from '../shared/language.js';

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
  readonly htmlBasePath: string;
  readonly apiBasePath: string;
  readonly defaultLang?: Lang;
}

export type CoreStudioRouteHandler = (
  request: CoreStudioRouteRequest,
) => Promise<CoreStudioRouteResponse | undefined>;

const HTML_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
});

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
});

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

function splitRequestUrl(value: string): { path: string; search: URLSearchParams } {
  const fragmentIndex = value.indexOf('#');
  const withoutFragment = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf('?');
  return queryIndex < 0
    ? { path: withoutFragment, search: new URLSearchParams() }
    : {
        path: withoutFragment.slice(0, queryIndex),
        search: new URLSearchParams(withoutFragment.slice(queryIndex + 1)),
      };
}

interface RunPathMatch {
  readonly matched: boolean;
  readonly runId?: string;
}

function matchRunPath(path: string, basePath: string): RunPathMatch {
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

function html(status: number, body: string, extraHeaders: Readonly<Record<string, string>> = {}): CoreStudioRouteResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({ ...HTML_HEADERS, ...extraHeaders }),
    body,
  });
}

export function createCoreStudioRouteHandler(
  options: CoreStudioRouteHandlerOptions,
): CoreStudioRouteHandler {
  const htmlBasePath = normalizeBasePath(options.htmlBasePath, 'htmlBasePath');
  const apiBasePath = normalizeBasePath(options.apiBasePath, 'apiBasePath');
  if (
    htmlBasePath === apiBasePath
    || htmlBasePath.startsWith(`${apiBasePath}/`)
    || apiBasePath.startsWith(`${htmlBasePath}/`)
  ) {
    throw new TypeError('htmlBasePath and apiBasePath must not overlap');
  }
  const routes: CoreStudioRenderRoutes = Object.freeze({
    listPath: htmlBasePath,
    detailPath: (runId: string) => `${htmlBasePath}/${encodeURIComponent(runId)}`,
  });
  const defaultLang = options.defaultLang ?? 'zh';

  return async (request) => {
    const { path, search } = splitRequestUrl(request.url ?? '/');
    const htmlRun = matchRunPath(path, htmlBasePath);
    const apiRun = matchRunPath(path, apiBasePath);
    const isMatched = path === htmlBasePath || path === apiBasePath || htmlRun.matched || apiRun.matched;
    if (!isMatched) return undefined;

    const requestedLang = search.get('lang');
    const lang: Lang = requestedLang === 'en' || requestedLang === 'zh'
      ? requestedLang
      : defaultLang;
    if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
      return path === apiBasePath || apiRun.matched
        ? json(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
        : html(405, renderCoreStudioError(coreStudioMethodNotAllowedMessage(lang), routes, lang), { Allow: 'GET' });
    }

    try {
      if (path === htmlBasePath) {
        return html(200, renderCoreRunList(await options.catalog.list(), routes, lang));
      }
      if (path === apiBasePath) {
        return json(200, await options.catalog.list());
      }
      if (htmlRun.matched) {
        if (htmlRun.runId === undefined) {
          return html(404, renderCoreStudioError(lang === 'en' ? 'Run not found.' : '运行记录不存在。', routes, lang));
        }
        const detail = await options.catalog.get(htmlRun.runId);
        return detail === undefined
          ? html(404, renderCoreStudioError(lang === 'en' ? 'Run not found.' : '运行记录不存在。', routes, lang))
          : html(200, renderCoreRunDetail(detail, routes, lang));
      }
      if (apiRun.matched) {
        if (apiRun.runId === undefined) return json(404, { error: 'core_run_not_found' });
        const detail = await options.catalog.get(apiRun.runId);
        return detail === undefined
          ? json(404, { error: 'core_run_not_found' })
          : json(200, detail);
      }
      return undefined;
    } catch {
      return path === apiBasePath || apiRun.matched
        ? json(503, { error: 'core_studio_source_unavailable' })
        : html(503, renderCoreStudioError(coreStudioSourceUnavailableMessage(lang), routes, lang));
    }
  };
}
