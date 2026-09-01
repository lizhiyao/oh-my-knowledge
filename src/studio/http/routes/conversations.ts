import type { ConversationCatalog } from '../../../observability/conversation/catalog.js';
import { buildKnowledgeDebuggerViewModel } from '../../../observability/conversation/knowledge-debugger.js';
import {
  buildConversationActivitySnapshot,
  buildConversationDetailActivitySnapshot,
  renderConversationDetailPage,
  renderConversationIndexPage,
} from '../../presentation/conversation-renderer.js';
import { renderKnowledgeDebuggerPage } from '../../presentation/knowledge-debugger-renderer.js';
import { getErrorMessage } from '../errors.js';
import type {
  LiveStreamRegistry,
  StudioRouteHandler,
} from './contracts.js';

interface ConversationRoutesOptions {
  readonly catalog: ConversationCatalog;
  readonly liveStreams: LiveStreamRegistry;
}

export function createConversationRoutes({
  catalog,
  liveStreams,
}: ConversationRoutesOptions): StudioRouteHandler {
  return async ({ request, response, path, lang }): Promise<boolean> => {
    if (path === '/api/conversations/activity') {
      const snapshot = buildConversationActivitySnapshot(
        await catalog.listConversations(),
      );
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(snapshot));
      return true;
    }

    const conversationActivityMatch = path.match(/^\/api\/conversations\/([^/]+)\/activity$/);
    if (conversationActivityMatch) {
      let threadId = '';
      try { threadId = decodeURIComponent(conversationActivityMatch[1]); } catch { /* invalid path */ }
      const conversation = threadId ? await catalog.getConversation(threadId) : undefined;
      if (!conversation) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'conversation_not_found' }));
        return true;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(buildConversationDetailActivitySnapshot(conversation)));
      return true;
    }

    if (path === '/conversations') {
      const html = renderConversationIndexPage(await catalog.listConversations(), lang);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(html);
      return true;
    }

    const conversationTaskLiveMatch = path.match(/^\/api\/conversations\/([^/]+)\/tasks\/([^/]+)\/live$/);
    if (conversationTaskLiveMatch) {
      let threadId = '';
      let turnId = '';
      try {
        threadId = decodeURIComponent(conversationTaskLiveMatch[1]);
        turnId = decodeURIComponent(conversationTaskLiveMatch[2]);
      } catch { /* invalid path */ }
      const initial = threadId && turnId
        ? await catalog.loadTaskTrajectory(threadId, turnId)
        : undefined;
      if (!initial) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'task_trajectory_not_found' }));
        return true;
      }
      if (!catalog.observeTaskTrajectory) {
        response.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'live_task_trajectory_unavailable' }));
        return true;
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
            error: (cause) => {
              if (!closed && !response.destroyed && !response.writableEnded) {
                response.write('event: trajectory-error\n');
                response.write(`data: ${JSON.stringify({ error: getErrorMessage(cause) })}\n\n`);
              }
              close();
            },
          },
          { signal: lifecycle.signal },
        );
        if (closed) unsubscribe();
      } catch (cause) {
        if (!closed && !response.destroyed && !response.writableEnded) {
          response.write('event: trajectory-error\n');
          response.write(`data: ${JSON.stringify({ error: getErrorMessage(cause) })}\n\n`);
        }
        close();
      }
      return true;
    }

    const conversationTaskMatch = path.match(/^\/conversations\/([^/]+)\/tasks\/([^/]+)$/);
    if (conversationTaskMatch) {
      let threadId = '';
      let turnId = '';
      try {
        threadId = decodeURIComponent(conversationTaskMatch[1]);
        turnId = decodeURIComponent(conversationTaskMatch[2]);
      } catch { /* invalid path */ }
      const trajectory = threadId && turnId
        ? await catalog.loadTaskTrajectory(threadId, turnId)
        : undefined;
      if (!trajectory) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(lang === 'en' ? 'task trajectory not found' : '任务轨迹不存在');
        return true;
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
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(html);
      return true;
    }

    const conversationTaskSourceMatch = path.match(/^\/api\/conversations\/([^/]+)\/tasks\/([^/]+)\/source-records$/);
    if (conversationTaskSourceMatch) {
      let threadId = '';
      let turnId = '';
      try {
        threadId = decodeURIComponent(conversationTaskSourceMatch[1]);
        turnId = decodeURIComponent(conversationTaskSourceMatch[2]);
      } catch { /* invalid path */ }
      const trajectory = threadId && turnId
        ? await catalog.loadTaskTrajectory(threadId, turnId)
        : undefined;
      if (!trajectory) {
        response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'task_trajectory_not_found' }));
        return true;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(trajectory.sourceRecords));
      return true;
    }

    const conversationDetailMatch = path.match(/^\/conversations\/([^/]+)$/);
    if (conversationDetailMatch) {
      let threadId = '';
      try { threadId = decodeURIComponent(conversationDetailMatch[1]); } catch { /* invalid path */ }
      const conversation = threadId ? await catalog.getConversation(threadId) : undefined;
      if (!conversation) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(lang === 'en' ? 'conversation not found' : '对话不存在');
        return true;
      }
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(renderConversationDetailPage(conversation, lang));
      return true;
    }

    // Studio 默认呈现机器上的主对话；/conversations 保留为同义入口。
    if (path === '/') {
      const html = renderConversationIndexPage(await catalog.listConversations(), lang);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(html);
      return true;
    }

    return false;
  };
}
