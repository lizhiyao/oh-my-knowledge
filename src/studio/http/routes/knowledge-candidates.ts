import type { ConversationCatalog } from '../../../observability/application.js';
import { KnowledgeStorageStateError } from '../../../observability/application.js';
import { executeKnowledgeCandidateAction } from '../../application/knowledge/knowledge-candidates.js';
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
        const code = error instanceof KnowledgeStorageStateError ? error.stateCode
          : /conflict/i.test(message) ? 'knowledge_conflict'
          : message === 'Knowledge tags invalid.' ? 'knowledge_tags_invalid'
          : /capacity|exceeds/i.test(message) ? 'knowledge_capacity_exceeded'
          : 'knowledge_request_failed';
        response.writeHead(['knowledge_conflict', 'knowledge_storage_unsupported', 'knowledge_workspace_busy'].includes(code) ? 409 : 400, JSON_HEADERS);
        response.end(JSON.stringify({ error: code }));
      } finally { response.off('close', cancel); liveStreams.delete(cancel); }
    },
  }]);
}
