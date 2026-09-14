import type { ConversationCatalog } from '../../../observability/conversation/catalog.js';
import { executeKnowledgeCandidateAction } from '../../application/knowledge-candidates.js';
import { JSON_HEADERS } from '../errors.js';
import { readJsonObjectBody } from '../request-errors.js';
import { createStudioRouter } from './router.js';
import type { LiveStreamRegistry } from './contracts.js';

export function createKnowledgeCandidateRoutes(liveStreams: LiveStreamRegistry, catalog?: ConversationCatalog) {
  return createStudioRouter([{
    pattern: '/api/knowledge/candidates', method: 'POST', mutation: true,
    async handler({ request, response }) {
      const input = await readJsonObjectBody(request);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      response.once('close', cancel); liveStreams.add(cancel);
      try {
        const result = await executeKnowledgeCandidateAction(input, controller.signal, undefined, catalog);
        if (!response.destroyed) { response.writeHead(200, JSON_HEADERS); response.end(JSON.stringify(result)); }
      } catch (error) {
        if (response.destroyed) return;
        const message = error instanceof Error ? error.message : '';
        const code = /conflict/i.test(message) ? 'knowledge_conflict'
          : /capacity|exceeds/i.test(message) ? 'knowledge_capacity_exceeded'
          : 'knowledge_request_failed';
        response.writeHead(code === 'knowledge_conflict' ? 409 : 400, JSON_HEADERS);
        response.end(JSON.stringify({ error: code }));
      } finally { response.off('close', cancel); liveStreams.delete(cancel); }
    },
  }]);
}
