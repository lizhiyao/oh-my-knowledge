import { KnowledgeStorageStateError } from '../../../observability/application.js';
import { executeArtifactAuthoring } from '../../application/knowledge/artifact-authoring.js';
import { JSON_HEADERS } from '../errors.js';
import { readJsonObjectBody, RequestBodyError } from '../request-errors.js';
import { createStudioRouter } from './router.js';

export function createArtifactAuthoringRoutes() {
  return createStudioRouter([{ pattern: '/api/knowledge/artifacts', method: 'POST', mutation: true,
    async handler({ request, response, lang }) {
      const controller = new AbortController(); const cancel = () => controller.abort(); response.once('close', cancel);
      try {
        const input = await readJsonObjectBody(request, 3 * 1024 * 1024);
        const result = executeArtifactAuthoring(input, lang, controller.signal);
        if (!response.destroyed) { response.writeHead(200, JSON_HEADERS); response.end(JSON.stringify(result)); }
      } catch (cause) {
        if (cause instanceof RequestBodyError) throw cause;
        if (response.destroyed) return;
        const message = cause instanceof Error ? cause.message : '';
        const error = cause instanceof KnowledgeStorageStateError ? cause.stateCode : message === 'carrier_knowledge_region_conflict' ? message : message === 'carrier_source_contains_destination' ? 'carrier_source_contains_destination' : message === 'carrier_invalid_skill' ? 'carrier_invalid_skill' : message.includes('conflict') ? 'carrier_conflict' : message.includes('capacity') ? 'carrier_capacity_exceeded' : 'carrier_request_failed';
        response.writeHead((error.includes('conflict') || error === 'knowledge_workspace_busy' || error === 'knowledge_storage_unsupported') ? 409 : 400, JSON_HEADERS); response.end(JSON.stringify({ error }));
      } finally { response.off('close', cancel); }
    },
  }]);
}
