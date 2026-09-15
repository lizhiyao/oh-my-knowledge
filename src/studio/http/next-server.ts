import { UserSettingsStore } from '../../evidence/storage/user-settings.js';
import { createKnowledgeQuery } from '../application/knowledge/knowledge-query.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportServerOptions, ReportServer } from './contracts.js';
import { createReportServer } from './report-server.js';
import { nextCatalogContext, nextHealthContext, nextInboxContext, nextManagedContext, nextObserveContext, nextKnowledgeContext } from './next-context.js';
import { CORE_STUDIO_SOURCE_UNAVAILABLE, STUDIO_SOURCE_UNAVAILABLE, TEXT_HEADERS } from './errors.js';
import type { CoreStudioCatalog } from '../view-models/measure/core-runs.js';
import { createCodexConversationCatalog } from '../../observability/conversation/catalog.js';
import { loadObservePage, type ObservePage } from './pages/observe-page.js';

import { loadKnowledgePage, type KnowledgePage } from './pages/knowledge-page.js';
import { isHealthPath, loadHealthPage, type HealthPage } from './pages/health-page.js';
import { loadInboxPage, type InboxPage } from './pages/inbox-page.js';
import { isManagedPath, loadManagedPage, type ManagedPage } from './pages/managed-page.js';
import { resolveManagedRootOption } from './managed-root.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../../observability/inbox/index.js';

/** 语言只是偏好：设置文件读坏时退回内置默认，页面照常可用，错误留给 /api/settings 报告。 */
function preferredLanguage(): 'zh' | 'en' {
  try { return new UserSettingsStore().resolve().language; } catch { return 'zh'; }
}

/** Next owns every Studio page; JSON APIs and SSE keep their domain adapters. */
export function createNextStudioServer(options: ReportServerOptions = {}): ReportServer {
  let app: { prepare(): Promise<void>; close(): Promise<void>; getRequestHandler(): (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void> } | undefined;
  const knowledgeQuery = options.knowledgeQuery ?? createKnowledgeQuery(options);
  const conversationCatalog = options.conversationCatalog ?? createCodexConversationCatalog();
  // 页面组开关与 report-server 侧同源：裁掉的路径不接管，落回 HTTP adapter 得到 404，语义与独立宿主一致。
  const inboxRoutes = (options.studioPages ?? true) && (options.observationInbox ?? true);
  const pageRoutes = options.studioPages ?? true;
  const resolveManagedRoot = resolveManagedRootOption(options.managedDir);
  return createReportServer({ ...options, conversationCatalog, knowledgeQuery }, {
    async prepare() {
      const dir = fileURLToPath(new URL('../web/', import.meta.url));
      if (!existsSync(join(dir, '.next', 'BUILD_ID'))) throw new Error('Studio UI build is missing. Run yarn build before starting Studio.');
      // Next is loaded only by Studio, not by unrelated CLI or Core entry points.
      const next = createRequire(import.meta.url)('next') as (config: { dev: boolean; dir: string }) => NonNullable<typeof app>;
      const prepared = next({ dev: false, dir });
      app = prepared;
      await prepared.prepare();
    },
    async handle(request, response) {
      const path = (request.url ?? '/').split('?')[0];
      const measure = path === '/measure' || path.startsWith('/measure/');
      const inbox = inboxRoutes && path === '/observe/inbox';
      const observe = pageRoutes && (inbox || path === '/observe' || path.startsWith('/observe/conversations/'));
      const knowledge = pageRoutes && (path === '/knowledge' || path.startsWith('/knowledge/skills/'));
      const candidates = pageRoutes && path === '/knowledge/candidates';
      const managed = pageRoutes && isManagedPath(path);
      const health = pageRoutes && isHealthPath(path);
      if (!measure && !observe && !knowledge && !candidates && !managed && !health && !path.startsWith('/_next/')) return false;
      if ((measure || observe || knowledge || candidates || managed || health) && (request.method ?? 'GET') !== 'GET') {
        response.writeHead(405, { ...TEXT_HEADERS, Allow: 'GET' });
        response.end('method_not_allowed'); return true;
      }
      const searchParams = new URL(request.url ?? '/', 'http://localhost').searchParams;
      if (!path.startsWith('/_next/') && !searchParams.has('lang') && preferredLanguage() === 'en') {
        searchParams.set('lang', 'en'); response.writeHead(302, { Location: `${path}?${searchParams}` }); response.end(); return true;
      }
      let healthPage: HealthPage | undefined;
      if (health) {
        try {
          const loaded = loadHealthPage(
            { analysesDir: knowledgeQuery.directories().analysesDir, includeObserveCards: options.includeObserveCards ?? false },
            path,
            searchParams,
          );
          if (loaded.status === 'missing_query_params') {
            response.writeHead(400, TEXT_HEADERS);
            response.end('missing from/to query params'); return true;
          }
          if (loaded.status === 'analysis_not_found') {
            response.writeHead(404, TEXT_HEADERS);
            response.end('analysis not found'); return true;
          }
          healthPage = loaded.page;
        } catch {
          response.writeHead(503, TEXT_HEADERS);
          response.end(STUDIO_SOURCE_UNAVAILABLE); return true;
        }
      }
      let knowledgePage: KnowledgePage | undefined;
      if (knowledge) {
        try { knowledgePage = loadKnowledgePage(knowledgeQuery, path, searchParams.get('lang') === 'en' ? 'en' : 'zh', searchParams.get('doctorRun')); }
        catch {
          response.writeHead(503, TEXT_HEADERS);
          response.end(STUDIO_SOURCE_UNAVAILABLE); return true;
        }
        if (!knowledgePage) {
          response.writeHead(404, TEXT_HEADERS);
          response.end('skill_not_found'); return true;
        }
        const doctorRun = searchParams.get('doctorRun');
        // 显式点名的轮次不存在时不静默回落到当前那次：那会让 URL 与所见证据不一致，
        // 而同一宿主对 managed_not_found／skill_not_found 一律 404。
        if (knowledgePage.pageKind === 'detail' && doctorRun
          && doctorRun !== knowledgePage.row.doctor?.reportId
          && !knowledgePage.doctorRuns.some((run) => run.reportId === doctorRun)) {
          response.writeHead(404, TEXT_HEADERS);
          response.end('doctor_run_not_found'); return true;
        }
      }
      let managedPage: ManagedPage | undefined;
      if (managed) {
        try {
          const loaded = loadManagedPage(resolveManagedRoot(), path);
          if (loaded.status === 'record_not_found') {
            response.writeHead(404, TEXT_HEADERS);
            response.end('managed_not_found'); return true;
          }
          managedPage = loaded.page;
        } catch {
          response.writeHead(503, TEXT_HEADERS);
          response.end(STUDIO_SOURCE_UNAVAILABLE); return true;
        }
      }
      let inboxPage: InboxPage | undefined;
      if (inbox) {
        try { inboxPage = loadInboxPage(options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR, searchParams.get('skill') ?? undefined); }
        catch {
          response.writeHead(503, TEXT_HEADERS);
          response.end(STUDIO_SOURCE_UNAVAILABLE); return true;
        }
      }
      let observePage: ObservePage | undefined;
      if (observe && !inbox) {
        try { observePage = await loadObservePage(conversationCatalog, path, searchParams.get('lang') === 'en' ? 'en' : 'zh'); }
        catch {
          response.writeHead(503, TEXT_HEADERS);
          response.end(STUDIO_SOURCE_UNAVAILABLE); return true;
        }
        if (!observePage) {
          response.writeHead(404, TEXT_HEADERS);
          response.end('conversation_or_task_not_found'); return true;
        }
      }
      let catalog = options.coreStudioCatalog;
      // Resolve before Next starts streaming, retaining the HTTP status contract.
      if (measure) {
        try {
          if (!catalog) throw new Error('unavailable');
          if (path === '/measure') {
            const runs = await catalog.list();
            catalog = { ...catalog, list: async () => runs };
          } else {
            const encoded = path.slice('/measure/'.length);
            let runId: string | undefined;
            try { runId = encoded && !encoded.includes('/') ? decodeURIComponent(encoded) : undefined; } catch { /* malformed identity is a missing route */ }
            const detail = runId === undefined ? undefined : await catalog.get(runId);
            if (!detail) { response.writeHead(404, TEXT_HEADERS); response.end('core_run_not_found'); return true; }
            const source = catalog;
            catalog = { ...catalog, get: async (id) => id === runId ? detail : source.get(id) };
          }
        } catch {
          response.writeHead(503, TEXT_HEADERS);
          response.end(CORE_STUDIO_SOURCE_UNAVAILABLE); return true;
        }
      }
      if (!app) throw new Error('Studio UI is not started');
      request.headers['x-omk-studio-lang'] = searchParams.get('lang') === 'en' ? 'en' : 'zh';
      // 一级导航与页面组同源：裁掉兄弟路由的宿主不提供导航，否则链接指向自己没挂的页面。
      request.headers['x-omk-studio-navigation'] = pageRoutes ? 'full' : 'none';
      // 语言切换要保留当前页的其余查询参数（如 ?doctorRun=），而 Next 侧 useSearchParams
      // 会把整棵子树降级为纯客户端渲染、SSR 里没有地址，所以路径由宿主按请求注入。
      const requestUrl = request.url ?? '/';
      const queryIndex = requestUrl.indexOf('?');
      request.headers['x-omk-studio-route'] = queryIndex < 0 ? requestUrl : `${requestUrl.slice(0, queryIndex)}?${requestUrl.slice(queryIndex + 1)}`;
      const handler = app.getRequestHandler();
      if (inboxPage) await nextInboxContext.run(inboxPage, () => handler(request, response));
      else if (healthPage) await nextHealthContext.run(healthPage, () => handler(request, response));
      else if (knowledgePage) await nextKnowledgeContext.run(knowledgePage, () => handler(request, response));
      else if (managedPage) await nextManagedContext.run(managedPage, () => handler(request, response));
      else if (observePage) await nextObserveContext.run(observePage, () => handler(request, response));
      else if (catalog) await nextCatalogContext.run(catalog as CoreStudioCatalog, () => handler(request, response));
      else await handler(request, response);
      return true;
    },
    async close() { const current = app; app = undefined; await current?.close(); },
  });
}
