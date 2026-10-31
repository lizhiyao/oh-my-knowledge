import { KnowledgeActorSchema, type KnowledgeActor } from '../../../knowledge/contracts.js';
import { knowledgeRelationFailureCode } from '../../../knowledge/application/relation-operations.js';
import { executeKnowledgeRelationAction } from '../../application/knowledge/knowledge-relations.js';
import { JSON_HEADERS } from '../errors.js';
import { readJsonObjectBody } from '../request-errors.js';
import { createStudioRouter } from './router.js';

/** This local trusted host attributes relation opinions; the route does not dispatch a model. */
export function createKnowledgeRelationRoutes(actorInput: KnowledgeActor = { actorKind: 'human', actorId: 'local-user' }) {
  const actor = KnowledgeActorSchema.parse(actorInput);
  return createStudioRouter([{
    pattern: '/api/knowledge/relations', method: 'POST', mutation: true,
    async handler({ request, response }) {
      const input = await readJsonObjectBody(request);
      try {
        const result = executeKnowledgeRelationAction(input, actor);
        if (response.destroyed) return;
        response.writeHead(200, { ...JSON_HEADERS, 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(result));
      } catch (error) {
        if (response.destroyed) return;
        const code = knowledgeRelationFailureCode(error);
        const status = ['knowledge_conflict', 'knowledge_storage_unsupported', 'knowledge_workspace_busy', 'knowledge_relation_unavailable'].includes(code) ? 409
          : code === 'knowledge_relation_forbidden' ? 403 : code === 'knowledge_request_failed' ? 500 : 400;
        response.writeHead(status, { ...JSON_HEADERS, 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: code }));
      }
    },
  }]);
}
