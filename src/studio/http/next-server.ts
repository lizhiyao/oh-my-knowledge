import { createKnowledgeQuery } from '../application/knowledge-query.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportServerOptions, ReportServer } from './contracts.js';
import { createReportServer } from './report-server.js';
import { nextCatalogContext, nextObserveContext, nextKnowledgeContext } from './next-context.js';
import type { CoreStudioCatalog } from '../core-runs/contracts.js';
import { createCodexConversationCatalog } from '../../observability/conversation/catalog.js';
import { loadObservePage, type ObservePage } from './observe-page.js';

import { loadKnowledgePage, type KnowledgePage } from './knowledge-page.js';

/** Next owns migrated pages; existing API/SSE capabilities keep their domain adapters. */
export function createNextStudioServer(options: ReportServerOptions = {}): ReportServer {
  let app: { prepare(): Promise<void>; close(): Promise<void>; getRequestHandler(): (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void> } | undefined;
  const knowledgeQuery = options.knowledgeQuery ?? createKnowledgeQuery(options);
  const conversationCatalog = options.conversationCatalog ?? createCodexConversationCatalog();
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
      const observe = path === '/observe' || path.startsWith('/observe/conversations/');
      const knowledge = path === '/knowledge' || path.startsWith('/knowledge/skills/');
      if (!measure && !observe && !knowledge && !path.startsWith('/_next/')) return false;
      if ((measure || observe || knowledge) && (request.method ?? 'GET') !== 'GET') {
        response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('method_not_allowed'); return true;
      }
      let knowledgePage: KnowledgePage | undefined;
      if (knowledge) {
        try { knowledgePage = loadKnowledgePage(knowledgeQuery, path, new URL(request.url ?? '/', 'http://localhost').searchParams.get('lang') === 'en' ? 'en' : 'zh'); }
        catch {
          response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('studio_source_unavailable'); return true;
        }
        if (!knowledgePage) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('skill_not_found'); return true;
        }
      }
      let observePage: ObservePage | undefined;
      if (observe) {
        try { observePage = await loadObservePage(conversationCatalog, path, new URL(request.url ?? '/', 'http://localhost').searchParams.get('lang') === 'en' ? 'en' : 'zh'); }
        catch {
          response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('studio_source_unavailable'); return true;
        }
        if (!observePage) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
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
            if (!detail) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('core_run_not_found'); return true; }
            const source = catalog;
            catalog = { ...catalog, get: async (id) => id === runId ? detail : source.get(id) };
          }
        } catch {
          response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end('core_studio_source_unavailable'); return true;
        }
      }
      if (!app) throw new Error('Studio UI is not started');
      request.headers['x-omk-studio-lang'] = new URL(request.url ?? '/', 'http://localhost').searchParams.get('lang') === 'en' ? 'en' : 'zh';
      const handler = app.getRequestHandler();
      if (knowledgePage) await nextKnowledgeContext.run(knowledgePage, () => handler(request, response));
      else if (observePage) await nextObserveContext.run(observePage, () => handler(request, response));
      else if (catalog) await nextCatalogContext.run(catalog as CoreStudioCatalog, () => handler(request, response));
      else await handler(request, response);
      return true;
    },
    async close() { const current = app; app = undefined; await current?.close(); },
  });
}
