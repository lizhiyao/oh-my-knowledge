import { UserSettingsStore } from '../../evidence/storage/user-settings.js';
import { globalLayout } from '../../evidence/storage/layout.js';
import { createKnowledgeQuery } from '../application/knowledge/knowledge-query.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportServerOptions, ReportServer } from './contracts.js';
import { createReportServer } from './report-server.js';
import { nextAgentsContext, nextHealthContext, nextInboxContext, nextManagedContext, nextMeasureRunContext, nextMeasureRunsContext, nextObserveContext, nextKnowledgeContext } from './next-context.js';
import { CORE_STUDIO_SOURCE_UNAVAILABLE, STUDIO_SOURCE_UNAVAILABLE, TEXT_HEADERS } from './errors.js';
import {
  createCodexConversationCatalog,
  DEFAULT_OBSERVATIONS_DIR,
} from '../../observability/application.js';
import { isMeasurePath, loadMeasurePage, type MeasurePage } from './pages/measure-page.js';
import { isObservePath, loadObservePage, type ObservePage } from './pages/observe-page.js';

import { isKnowledgeCandidatesPath, isKnowledgePath, loadKnowledgePage, type KnowledgePage } from './pages/knowledge-page.js';
import { isHealthPath, loadHealthPage, type HealthPage } from './pages/health-page.js';
import { isInboxPath, loadInboxPage, type InboxPage } from './pages/inbox-page.js';
import { isManagedPath, loadManagedPage, type ManagedPage } from './pages/managed-page.js';
import { isAgentsPath, loadAgentsPage, type AgentsPage } from './pages/agents-page.js';
import { resolveManagedRootOption } from './managed-root.js';

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
  // Agent 清单与采集报告按机器级全局存放（`omk agents` 的默认落点），不随项目 cwd 分叉。
  const agentsDir = options.agentsDir ?? globalLayout().observeAgentsDir;
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
      // 地址识别由各装载器给出，宿主只按开关决定接不接管这一组。measure 刻意不受 studioPages 影响：
      // 评测预览宿主（`cli/lib/core-report-service.ts`）传的正是 studioPages: false，而它要服务的就是 /measure。
      const measure = isMeasurePath(path);
      const inbox = inboxRoutes && isInboxPath(path);
      const observe = pageRoutes && (inbox || isObservePath(path));
      const knowledge = pageRoutes && isKnowledgePath(path);
      const candidates = pageRoutes && isKnowledgeCandidatesPath(path);
      const managed = pageRoutes && isManagedPath(path);
      const health = pageRoutes && isHealthPath(path);
      const agents = pageRoutes && isAgentsPath(path);
      if (!measure && !observe && !knowledge && !candidates && !managed && !health && !agents && !path.startsWith('/_next/')) return false;
      if ((measure || observe || knowledge || candidates || managed || health || agents) && (request.method ?? 'GET') !== 'GET') {
        response.writeHead(405, { ...TEXT_HEADERS, Allow: 'GET' });
        response.end('method_not_allowed'); return true;
      }
      // 语言不进地址：渲染语言只看本机设置（经 x-omk-studio-lang 注入），地址里的 lang 参数既不生效也不清理。
      // 一次请求只读一次：装载器与注入头用同一个值，设置文件在请求中途被改也不会半新半旧。
      const searchParams = new URL(request.url ?? '/', 'http://localhost').searchParams;
      const studioLanguage = preferredLanguage();
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
        try { knowledgePage = loadKnowledgePage(knowledgeQuery, path, studioLanguage, searchParams.get('doctorRun')); }
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
        try { observePage = await loadObservePage(conversationCatalog, path, studioLanguage); }
        catch {
          response.writeHead(503, TEXT_HEADERS);
          response.end(STUDIO_SOURCE_UNAVAILABLE); return true;
        }
        if (!observePage) {
          response.writeHead(404, TEXT_HEADERS);
          response.end('conversation_or_task_not_found'); return true;
        }
      }
      let agentsPage: AgentsPage | undefined;
      // 与其它页面组不同：缺文件与坏文件在投影里就是两种可呈现的状态，不抛错也不降级成 503——
      // 「还没跑过 omk agents」不是数据源故障，页面要给出下一步命令而不是纯文本错误。
      if (agents) agentsPage = loadAgentsPage(agentsDir);
      let measurePage: MeasurePage | undefined;
      // 装载在 Next 开始流式输出之前完成，所以数据源故障仍是宿主的 503、缺页仍是宿主的 404；
      // 页面只拿装载好的事实，不再自己判第二次「记录不存在」（#902 §三）。
      if (measure) {
        try {
          if (!options.coreStudioCatalog) throw new Error('unavailable');
          measurePage = await loadMeasurePage(options.coreStudioCatalog, path);
        } catch {
          response.writeHead(503, TEXT_HEADERS);
          response.end(CORE_STUDIO_SOURCE_UNAVAILABLE); return true;
        }
        if (!measurePage) {
          response.writeHead(404, TEXT_HEADERS);
          response.end('core_run_not_found'); return true;
        }
      }
      if (!app) throw new Error('Studio UI is not started');
      request.headers['x-omk-studio-lang'] = studioLanguage;
      // 一级导航与页面组同源：裁掉兄弟路由的宿主不提供导航，否则链接指向自己没挂的页面。
      request.headers['x-omk-studio-navigation'] = pageRoutes ? 'full' : 'none';
      const handler = app.getRequestHandler();
      if (inboxPage) await nextInboxContext.run(inboxPage, () => handler(request, response));
      else if (healthPage) await nextHealthContext.run(healthPage, () => handler(request, response));
      else if (knowledgePage) await nextKnowledgeContext.run(knowledgePage, () => handler(request, response));
      else if (managedPage) await nextManagedContext.run(managedPage, () => handler(request, response));
      else if (observePage) await nextObserveContext.run(observePage, () => handler(request, response));
      else if (agentsPage) await nextAgentsContext.run(agentsPage, () => handler(request, response));
      else if (measurePage) await (measurePage.pageKind === 'index'
        ? nextMeasureRunsContext.run(measurePage.runs, () => handler(request, response))
        : nextMeasureRunContext.run(measurePage.detail, () => handler(request, response)));
      else await handler(request, response);
      return true;
    },
    async close() { const current = app; app = undefined; await current?.close(); },
  });
}
