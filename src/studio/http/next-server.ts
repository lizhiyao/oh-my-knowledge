import { carrierMeasureCatalog } from '../application/measure/carrier-measurement.js';
import { globalLayout } from '../../evidence/storage/layout.js';
import { createKnowledgeQuery } from '../application/knowledge/knowledge-query.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportServerOptions, ReportServer } from './contracts.js';
import { createReportServer } from './report-server.js';
import { nextAgentsContext, nextHealthContext, nextInboxContext, nextMeasureRunContext, nextMeasureRunsContext, nextObserveContext, nextKnowledgeContext, nextPageFaultContext } from './next-context.js';
import { CORE_STUDIO_SOURCE_UNAVAILABLE, STUDIO_SOURCE_UNAVAILABLE, TEXT_HEADERS } from './errors.js';
import {
  createCodexConversationCatalog,
} from '../../observability/application.js';
import { isMeasurePath, loadMeasurePage, type MeasurePage } from './pages/measure-page.js';
import { isObservePath, loadObservePage, type ObservePage } from './pages/observe-page.js';

import { isKnowledgeContentPath, isKnowledgePath, loadKnowledgePage, type KnowledgePage } from './pages/knowledge-page.js';
import { isHealthPath, loadHealthPage, type HealthPage } from './pages/health-page.js';
import { isInboxPath, loadInboxPage, type InboxPage } from './pages/inbox-page.js';
import { isAgentsPath, loadAgentsPage, type AgentsPage } from './pages/agents-page.js';
import { studioHostLanguage } from './language.js';
import { projectPageFault } from './page-fault.js';
import type { StudioPageFault } from '../view-models/page-fault.js';

/** Next owns every Studio page; JSON APIs and SSE keep their domain adapters. */
export function createNextStudioServer(options: ReportServerOptions = {}): ReportServer {
  let app: { prepare(): Promise<void>; close(): Promise<void>; getRequestHandler(): (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void> } | undefined;
  const knowledgeQuery = options.knowledgeQuery ?? createKnowledgeQuery(options);
  const conversationCatalog = options.conversationCatalog ?? createCodexConversationCatalog();
  // 页面组开关与 report-server 侧同源：裁掉的路径不接管，落回 HTTP adapter 得到 404，语义与独立宿主一致。
  const inboxRoutes = (options.studioPages ?? true) && (options.observationInbox ?? true);
  const pageRoutes = options.studioPages ?? true;
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
      // A browser cannot opt itself into the private fault rewrite (including on assets).
      delete request.headers['x-omk-studio-page-fault'];
      const path = (request.url ?? '/').split('?')[0];
      // 地址识别由各装载器给出，宿主只按开关决定接不接管这一组。measure 刻意不受 studioPages 影响：
      // 评测预览宿主（`cli/lib/core-report-service.ts`）传的正是 studioPages: false，而它要服务的就是 /measure。
      const measure = isMeasurePath(path);
      const inbox = inboxRoutes && isInboxPath(path);
      const observe = pageRoutes && (inbox || isObservePath(path));
      const knowledge = pageRoutes && isKnowledgePath(path);
      const content = pageRoutes && isKnowledgeContentPath(path);
      const health = pageRoutes && isHealthPath(path);
      const agents = pageRoutes && isAgentsPath(path);
      if (!measure && !observe && !knowledge && !content && !health && !agents && !path.startsWith('/_next/')) return false;
      if ((measure || observe || knowledge || content || health || agents) && (request.method ?? 'GET') !== 'GET') {
        response.writeHead(405, { ...TEXT_HEADERS, Allow: 'GET' });
        response.end('method_not_allowed'); return true;
      }
      // 语言不进地址：渲染语言只看本机设置（经 x-omk-studio-lang 注入），地址里的 lang 参数既不生效也不清理。
      // 一次请求只读一次：装载器与注入头用同一个值，设置文件在请求中途被改也不会半新半旧。
      const searchParams = new URL(request.url ?? '/', 'http://localhost').searchParams;
      const studioLanguage = studioHostLanguage();
      request.headers['x-omk-studio-lang'] = studioLanguage;
      // A Measure-only preview has no mounted sibling routes.
      request.headers['x-omk-studio-navigation'] = pageRoutes ? 'full' : 'none';
      // Next unconditionally redirects these separators before any rewrite. Reject malformed
      // page requests at the protocol boundary instead: no source read, no redirect or URL change.
      if ((measure || observe || knowledge || content || health || agents) && /[\\]|\/\//.test(path)) {
        response.writeHead(404, TEXT_HEADERS);
        response.end(measure ? 'core_run_not_found' : health ? 'analysis not found'
          : knowledge || content ? 'skill_not_found' : 'conversation_or_task_not_found');
        return true;
      }
      async function renderFault(code: StudioPageFault['faultCode'], returnTo: StudioPageFault['returnTo']): Promise<true> {
        if (!app) throw new Error('Studio UI is not started');
        const page = projectPageFault(code, returnTo, request.url ?? '/', pageRoutes);
        response.statusCode = page.statusCode;
        response.setHeader('Cache-Control', 'no-store');
        request.headers['x-omk-studio-page-fault'] = '1';
        await nextPageFaultContext.run(page, () => app!.getRequestHandler()(request, response));
        return true;
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
            return renderFault('missing from/to query params', 'health');
          }
          if (loaded.status === 'analysis_not_found') {
            return renderFault('analysis not found', 'health');
          }
          healthPage = loaded.page;
        } catch {
          return renderFault(STUDIO_SOURCE_UNAVAILABLE, 'health');
        }
      }
      let knowledgePage: KnowledgePage | undefined;
      if (knowledge) {
        try { knowledgePage = loadKnowledgePage(knowledgeQuery, path, studioLanguage, searchParams.get('doctorRun')); }
        catch {
          return renderFault(STUDIO_SOURCE_UNAVAILABLE, 'knowledge');
        }
        if (!knowledgePage) {
          return renderFault('skill_not_found', 'knowledge');
        }
        const doctorRun = searchParams.get('doctorRun');
        // 显式点名的轮次不存在时不静默回落到当前那次：那会让 URL 与所见证据不一致，
        // 而同一宿主对 skill_not_found 一律 404。
        if (knowledgePage.pageKind === 'detail' && doctorRun
          && doctorRun !== knowledgePage.row.doctor?.reportId
          && !knowledgePage.doctorRuns.some((run) => run.reportId === doctorRun)) {
          return renderFault('doctor_run_not_found', 'knowledge');
        }
      }
      let inboxPage: InboxPage | undefined;
      if (inbox) {
        try { inboxPage = loadInboxPage(options.observationsDir, searchParams.get('skill') ?? undefined); }
        catch {
          return renderFault(STUDIO_SOURCE_UNAVAILABLE, 'inbox');
        }
      }
      let observePage: ObservePage | undefined;
      if (observe && !inbox) {
        try { observePage = await loadObservePage(conversationCatalog, path, studioLanguage); }
        catch {
          return renderFault(STUDIO_SOURCE_UNAVAILABLE, 'observe');
        }
        if (!observePage) {
          return renderFault('conversation_or_task_not_found', 'observe');
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
          const workspace = pageRoutes ? searchParams.get('workspace') : null;
          const catalog = workspace ? carrierMeasureCatalog(workspace, options.coreStudioCatalog) : options.coreStudioCatalog;
          if (!catalog) throw new Error('unavailable');
          measurePage = await loadMeasurePage(catalog, path, workspace ?? undefined);
        } catch {
          return renderFault(CORE_STUDIO_SOURCE_UNAVAILABLE, 'measure');
        }
        if (!measurePage) {
          return renderFault('core_run_not_found', 'measure');
        }
      }
      if (!app) throw new Error('Studio UI is not started');
      const handler = app.getRequestHandler();
      if (inboxPage) await nextInboxContext.run(inboxPage, () => handler(request, response));
      else if (healthPage) await nextHealthContext.run(healthPage, () => handler(request, response));
      else if (knowledgePage) await nextKnowledgeContext.run(knowledgePage, () => handler(request, response));
      else if (observePage) await nextObserveContext.run(observePage, () => handler(request, response));
      else if (agentsPage) await nextAgentsContext.run(agentsPage, () => handler(request, response));
      else if (measurePage) await (measurePage.pageKind === 'index'
        ? nextMeasureRunsContext.run(measurePage.runs, () => handler(request, response))
        : nextMeasureRunContext.run(measurePage.detail, () => nextMeasureRunsContext.run(measurePage.runs, () => handler(request, response))));
      else await handler(request, response);
      return true;
    },
    async close() { const current = app; app = undefined; await current?.close(); },
  });
}
