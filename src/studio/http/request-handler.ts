import { existsSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  projectDoctorsDir,
  projectObserveHealthDir,
  resolveDoctorsDir,
  resolveObserveHealthDir,
} from '../../measurement-artifacts/directories.js';
import { createCodexConversationCatalog } from '../../observability/conversation-catalog.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../../observability/inbox/index.js';
import { ObservationReviewStateValidationError } from '../../observability/inbox/review-state.js';
import type { Lang } from '../../shared/language.js';
import { createCoreStudioRouteHandler } from '../core-runs/index.js';
import { DEFAULT_LANG } from '../presentation/layout.js';
import type { ReportServerOptions } from './contracts.js';
import { getErrorMessage } from './errors.js';
import {
  assertTrustedMutationRequest,
  RequestBodyError,
} from './request-errors.js';
import { createConversationRoutes } from './routes/conversations.js';
import { createKnowledgeRoutes } from './routes/knowledge.js';
import { createObservationRoutes } from './routes/observations.js';

type RequestHandlerOptions = Omit<ReportServerOptions, 'port' | 'host'> & {
  requestShutdown(): void;
};

export interface StudioRequestHandler {
  prepare(): void;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): void;
}

export function createStudioRequestHandler({
  requestShutdown,
  analysesDir,
  doctorsDir,
  observationsDir = DEFAULT_OBSERVATIONS_DIR,
  managedDir,
  conversationCatalog,
  coreStudioCatalog,
  includeObserveCards = false,
  includeDoctorCards = false,
}: RequestHandlerOptions): StudioRequestHandler {
  const liveStreamClosers = new Set<() => void>();
  const conversationRoutes = createConversationRoutes({
    catalog: conversationCatalog ?? createCodexConversationCatalog(),
    liveStreams: liveStreamClosers,
  });
  const knowledgeRoutes = createKnowledgeRoutes({
    observationsDir,
    managedDir,
    includeObserveCards,
    includeDoctorCards,
  });
  const observationRoutes = createObservationRoutes({
    observationsDir,
    includeObserveCards,
    includeDoctorCards,
  });
  const coreStudioRoute = coreStudioCatalog === undefined
    ? undefined
    : createCoreStudioRouteHandler({
        catalog: coreStudioCatalog,
        htmlBasePath: '/reports',
        apiBasePath: '/api/reports',
        defaultLang: DEFAULT_LANG,
      });

  // observe-health 与 doctors 都按请求解析，确保长会话中项目第一次产生产物后，
  // Studio 下一次请求就能从全局回退目录切换到项目目录。
  const resolveAnalysesDir: () => string =
    typeof analysesDir === 'function'
      ? analysesDir
      : analysesDir !== undefined
        ? (): string => analysesDir
        : (): string => resolveObserveHealthDir(projectObserveHealthDir());
  const resolveDoctorsRoot: () => string =
    typeof doctorsDir === 'function'
      ? doctorsDir
      : doctorsDir !== undefined
        ? (): string => doctorsDir
        : (): string => resolveDoctorsDir(projectDoctorsDir());

  function prepare(): void {
    if (!existsSync(observationsDir)) mkdirSync(observationsDir, { recursive: true });
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const path = url.pathname;
      try {
        decodeURIComponent(path);
      } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
        return;
      }
      const langParam = url.searchParams.get('lang');
      const lang: Lang = langParam === 'en' ? 'en' : langParam === 'zh' ? 'zh' : DEFAULT_LANG;

      if (coreStudioRoute !== undefined) {
        if (path === '/') {
          response.writeHead(302, { Location: `/reports${url.search}` });
          response.end();
          return;
        }
        const coreResponse = await coreStudioRoute({
          method: request.method,
          url: request.url,
        });
        if (coreResponse !== undefined) {
          response.writeHead(coreResponse.status, coreResponse.headers);
          response.end(coreResponse.body);
          return;
        }
      }

      const analysesDir = resolveAnalysesDir();
      const doctorsDir = resolveDoctorsRoot();
      const routeContext = {
        request,
        response,
        url,
        path,
        lang,
      };

      if (path === '/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true, service: 'omk' }));
        return;
      }

      if (path === '/api/shutdown' && request.method === 'POST') {
        assertTrustedMutationRequest(request);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        setTimeout(() => {
          for (const close of [...liveStreamClosers]) close();
          requestShutdown();
        }, 100);
        return;
      }

      if (knowledgeRoutes({ ...routeContext, analysesDir, doctorsDir })) return;
      if (await conversationRoutes(routeContext)) return;
      if (await observationRoutes({ ...routeContext, analysesDir, doctorsDir })) return;

      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not Found');
    } catch (error: unknown) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(getErrorMessage(error)));
        return;
      }
      const statusCode = error instanceof RequestBodyError
        ? error.statusCode
        : error instanceof ObservationReviewStateValidationError
          ? 400
          : 500;
      response.writeHead(statusCode, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: getErrorMessage(error) }));
    }
  }

  function close(): void {
    for (const closeStream of [...liveStreamClosers]) closeStream();
  }

  return { prepare, handle: handleRequest, close };
}
