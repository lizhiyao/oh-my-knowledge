import { KnowledgeActorSchema, type KnowledgeActor } from '../../../knowledge/contracts.js';
import { knowledgeFailureCode } from '../../../knowledge/application/operations.js';
import { executeKnowledgeReviewAction } from '../../application/knowledge/knowledge-reviews.js';
import { JSON_HEADERS } from '../errors.js';
import { readJsonObjectBody } from '../request-errors.js';
import { createStudioRouter } from './router.js';

/** Local UI attribution is explicit and independent of the process that started Studio. */
export function createKnowledgeReviewRoutes(actorInput: KnowledgeActor = { actorKind: 'human', actorId: 'local-user' }) {
  const actor = KnowledgeActorSchema.parse(actorInput);
  return createStudioRouter([{
    pattern: '/api/knowledge/reviews', method: 'POST', mutation: true,
    async handler({ request, response }) {
      const input = await readJsonObjectBody(request);
      try {
        const result = executeKnowledgeReviewAction(input, actor);
        if (response.destroyed) return;
        response.writeHead(200, { ...JSON_HEADERS, 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(result));
      } catch (error) {
        if (response.destroyed) return;
        const code = knowledgeFailureCode(error);
        response.writeHead(['knowledge_conflict', 'knowledge_storage_unsupported', 'knowledge_workspace_busy'].includes(code) ? 409 : code === 'knowledge_request_failed' ? 500 : 400,
          { ...JSON_HEADERS, 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: code }));
      }
    },
  }]);
}
