import type { ConversationCatalog } from '../../../observability/conversation/catalog.js';
import { buildKnowledgeDebuggerViewModel } from '../../../observability/conversation/knowledge-debugger.js';
import {
  renderConversationDetailPage,
  renderConversationIndexPage,
} from '../../presentation/conversation-renderer.js';
import { renderKnowledgeDebuggerPage } from '../../presentation/knowledge-debugger-renderer.js';
import { buildConversationActivitySnapshot, buildConversationDetailActivitySnapshot } from '../../application/conversation-activity.js';
import { STUDIO_SOURCE_UNAVAILABLE, HTML_HEADERS, JSON_HEADERS, TEXT_HEADERS, writeJsonError } from '../errors.js';
import type {
  LiveStreamRegistry,
  StudioRouteContext,
} from './contracts.js';
import { createStudioRouter, type StudioRouteDefinition } from './router.js';

interface ConversationRoutesOptions {
  readonly catalog: ConversationCatalog;
  readonly liveStreams: LiveStreamRegistry;
}

export function createConversationRoutes({
  catalog,
  liveStreams,
}: ConversationRoutesOptions): (context: StudioRouteContext) => Promise<boolean> {
  const routes: StudioRouteDefinition<StudioRouteContext>[] = [
    {
      pattern: '/api/conversations/activity',
      async handler({ request, response }) {
        void request;
        const snapshot = buildConversationActivitySnapshot(
          await catalog.listConversations(),
        );
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(snapshot));
      },
    },
    {
      pattern: '/api/conversations/:thread/activity',
      async handler({ response, params }) {
        const conversation = params.thread ? await catalog.getConversation(params.thread) : undefined;
        if (!conversation) {
          writeJsonError(response, 404, 'conversation_not_found');
          return;
        }
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(buildConversationDetailActivitySnapshot(conversation)));
      },
    },
    {
      pattern: '/observe',
      async handler({ response, lang }) {
        const html = renderConversationIndexPage(await catalog.listConversations(), lang);
        response.writeHead(200, HTML_HEADERS);
        response.end(html);
      },
    },
    {
      pattern: '/api/conversations/:thread/tasks/:turn/live',
      async handler({ request, response, params }) {
        const threadId = params.thread;
        const turnId = params.turn;
        const initial = threadId && turnId
          ? await catalog.loadTaskTrajectory(threadId, turnId)
          : undefined;
        if (!initial) {
          writeJsonError(response, 404, 'task_trajectory_not_found');
          return;
        }
        if (!catalog.observeTaskTrajectory) {
          writeJsonError(response, 501, 'live_task_trajectory_unavailable');
          return;
        }

        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();

        let closed = false;
        let unsubscribe: (() => void) | undefined;
        const lifecycle = new AbortController();
        const heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
        }, 15_000);
        heartbeat.unref?.();
        const close = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          lifecycle.abort();
          unsubscribe?.();
          liveStreams.delete(close);
          if (!response.destroyed && !response.writableEnded) response.end();
        };
        liveStreams.add(close);
        request.once('close', close);
        response.once('close', close);

        try {
          unsubscribe = await catalog.observeTaskTrajectory(
            threadId,
            turnId,
            {
              next: (trajectory) => {
                if (closed || response.destroyed || response.writableEnded) return;
                response.write(`id: ${trajectory.revision}\n`);
                response.write('event: trajectory\n');
                response.write(`data: ${JSON.stringify({
                  revision: trajectory.revision,
                  status: trajectory.status,
                  liveObservable: trajectory.liveObservable,
                })}\n\n`);
              },
              complete: close,
              error: () => {
                if (!closed && !response.destroyed && !response.writableEnded) {
                  response.write('event: trajectory-error\n');
                  response.write(`data: ${JSON.stringify({ error: STUDIO_SOURCE_UNAVAILABLE })}\n\n`);
                }
                close();
              },
            },
            { signal: lifecycle.signal },
          );
          if (closed) unsubscribe();
        } catch {
          if (!closed && !response.destroyed && !response.writableEnded) {
            response.write('event: trajectory-error\n');
            response.write(`data: ${JSON.stringify({ error: STUDIO_SOURCE_UNAVAILABLE })}\n\n`);
          }
          close();
        }
      },
    },
    {
      pattern: '/observe/conversations/:thread/tasks/:turn',
      async handler({ response, params, lang }) {
        const threadId = params.thread;
        const turnId = params.turn;
        const trajectory = threadId && turnId
          ? await catalog.loadTaskTrajectory(threadId, turnId)
          : undefined;
        if (!trajectory) {
          response.writeHead(404, TEXT_HEADERS);
          response.end(lang === 'en' ? 'task trajectory not found' : '任务轨迹不存在');
          return;
        }
        const sourceRecords = {
          ...trajectory.sourceRecords,
          records: [],
        };
        const html = renderKnowledgeDebuggerPage(
          buildKnowledgeDebuggerViewModel(
            trajectory.session,
            turnId,
            trajectory.ingestion,
            sourceRecords,
          ),
          lang,
          {
            sourceRecordsEndpoint: `/api/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turnId)}/source-records`,
            ...(trajectory.liveObservable && catalog.observeTaskTrajectory ? {
              live: {
                endpoint: `/api/conversations/${encodeURIComponent(threadId)}/tasks/${encodeURIComponent(turnId)}/live`,
                revision: trajectory.revision,
              },
            } : {}),
          },
        );
        response.writeHead(200, HTML_HEADERS);
        response.end(html);
      },
    },
    {
      pattern: '/api/conversations/:thread/tasks/:turn/source-records',
      async handler({ response, params }) {
        const threadId = params.thread;
        const turnId = params.turn;
        const trajectory = threadId && turnId
          ? await catalog.loadTaskTrajectory(threadId, turnId)
          : undefined;
        if (!trajectory) {
          writeJsonError(response, 404, 'task_trajectory_not_found');
          return;
        }
        response.writeHead(200, JSON_HEADERS);
        response.end(JSON.stringify(trajectory.sourceRecords));
      },
    },
    {
      pattern: '/observe/conversations/:thread',
      async handler({ response, params, lang }) {
        const conversation = params.thread ? await catalog.getConversation(params.thread) : undefined;
        if (!conversation) {
          response.writeHead(404, TEXT_HEADERS);
          response.end(lang === 'en' ? 'conversation not found' : '对话不存在');
          return;
        }
        response.writeHead(200, HTML_HEADERS);
        response.end(renderConversationDetailPage(conversation, lang));
      },
    },
    {
      // Studio 根入口进入观测工作台，保留语言等查询参数。
      pattern: '/',
      method: 'ANY',
      handler({ response, url }) {
        response.writeHead(302, { Location: `/observe${url.search}` });
        response.end();
      },
    },
  ];

  return createStudioRouter(routes);
}
