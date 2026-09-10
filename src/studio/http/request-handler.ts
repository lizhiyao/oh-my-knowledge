import { existsSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCodexConversationCatalog } from '../../observability/conversation/catalog.js';
import { DEFAULT_OBSERVATIONS_DIR } from '../../observability/inbox/index.js';
import { ObservationReviewStateValidationError } from '../../observability/inbox/review-state.js';
import type { Lang } from '../../shared/language.js';
import { createKnowledgeQuery } from '../application/knowledge-query.js';
import { createCoreStudioRouteHandler } from './routes/core-runs.js';
import { DEFAULT_LANG } from '../presentation/layout.js';
import type { ReportServerOptions } from './contracts.js';
import { getErrorMessage, JSON_HEADERS, STUDIO_SOURCE_UNAVAILABLE, TEXT_HEADERS, writeJsonError } from './errors.js';
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
  knowledgeQuery,
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
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const conversationRoutes = createConversationRoutes({
    catalog: conversationCatalog ?? createCodexConversationCatalog(),
    liveStreams: liveStreamClosers,
  });
  const query = knowledgeQuery ?? createKnowledgeQuery({ analysesDir, doctorsDir, observationsDir, includeObserveCards, includeDoctorCards });
  const knowledgeRoutes = createKnowledgeRoutes({
    query,
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
        htmlBasePath: '/measure',
        apiBasePath: '/api/reports',
        defaultLang: DEFAULT_LANG,
        studioNavigation: true,
      });

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
        response.writeHead(404, TEXT_HEADERS);
        response.end('Not Found');
        return;
      }
      const langParam = url.searchParams.get('lang');
      const lang: Lang = langParam === 'en' ? 'en' : langParam === 'zh' ? 'zh' : DEFAULT_LANG;

      if (coreStudioRoute !== undefined) {
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

      const { analysesDir, doctorsDir } = query.directories();
      const routeContext = {
        request,
        response,
        url,
        path,
        lang,
      };

      if (path === '/health') {
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify({ ok: true, service: 'omk' }));
        return;
      }

      if (path === '/api/shutdown' && request.method === 'POST') {
        assertTrustedMutationRequest(request);
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify({ ok: true }));
        shutdownTimer ??= setTimeout(() => {
          shutdownTimer = undefined;
          requestShutdown();
        }, 100);
        return;
      }

      if (knowledgeRoutes({ ...routeContext, analysesDir, doctorsDir })) return;
      if (await conversationRoutes(routeContext)) return;
      if (await observationRoutes({ ...routeContext, analysesDir, doctorsDir })) return;

      response.writeHead(404, TEXT_HEADERS);
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
          : 503;
      const code = error instanceof RequestBodyError
        ? error.code
        : error instanceof ObservationReviewStateValidationError
          ? 'invalid_review_state'
          : STUDIO_SOURCE_UNAVAILABLE;
      writeJsonError(response, statusCode, code);
    }
  }

  function close(): void {
    if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
    for (const closeStream of [...liveStreamClosers]) closeStream();
  }

  return { prepare, handle: handleRequest, close };
}
