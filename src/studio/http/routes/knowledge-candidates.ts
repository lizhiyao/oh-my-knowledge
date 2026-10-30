import type { KnowledgeActor } from '../../../knowledge/contracts.js';
import type { LocalSourceScope } from '../../../knowledge/application/local-source-host.js';
import { createLocalKnowledgeApplication } from '../../../knowledge/application/local.js';
import { executeSourcePickerAction } from '../../application/knowledge/source-picker.js';
import type { ConversationCatalog } from '../../../observability/application.js';
import type { ConversationAutoExtraction } from '../../../knowledge/application/auto-extraction.js';
import { autoExtractionStatusEtag, executeAutoExtractionAction } from '../../application/knowledge/auto-extraction.js';
import { knowledgeFailureCode } from '../../../knowledge/application/operations.js';
import { executeKnowledgeCandidateAction } from '../../application/knowledge/knowledge-candidates.js';
import { executeKnowledgeLibraryAction } from '../../application/knowledge/knowledge-library.js';
import { JSON_HEADERS } from '../errors.js';
import { readJsonObjectBody } from '../request-errors.js';
import { createStudioRouter } from './router.js';
import type { LiveStreamRegistry } from './contracts.js';

export function createKnowledgeCandidateRoutes(liveStreams: LiveStreamRegistry, catalog?: ConversationCatalog, automation?: ConversationAutoExtraction, sourceScope?: LocalSourceScope, reviewActor?: KnowledgeActor) {
  return createStudioRouter(['candidates', 'sources', 'auto-extraction', 'library'].map(resource => ({
    pattern: `/api/knowledge/${resource}`, method: 'POST', mutation: true,
    async handler({ request, response }) {
      const input = await readJsonObjectBody(request);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      response.once('close', cancel); liveStreams.add(cancel);
      try {
        if (resource === 'auto-extraction' && !automation) throw new Error('Automation service unavailable.');
        const result = resource === 'sources' ? await executeSourcePickerAction(input, sourceScope, controller.signal) : resource === 'library' ? executeKnowledgeLibraryAction(input)
          : resource === 'auto-extraction' && automation
            ? await executeAutoExtractionAction(input, automation, controller.signal)
            : await executeKnowledgeCandidateAction(input, controller.signal, root => createLocalKnowledgeApplication(root, { sourceScope, reviewActor }), catalog);
        if (!response.destroyed) {
          const status = resource === 'auto-extraction' && input.operation === 'status';
          const etag = status && typeof input.workspace === 'string' && typeof input.threadId === 'string'
            ? autoExtractionStatusEtag(input.workspace, input.threadId, result) : undefined;
          response.writeHead(200, { ...JSON_HEADERS, ...(status ? { 'Cache-Control': 'no-store' } : {}), ...(etag ? { ETag: etag } : {}) });
          response.end(JSON.stringify(result));
        }
      } catch (error) {
        if (response.destroyed) return;
        const code = knowledgeFailureCode(error);
        response.writeHead(['knowledge_conflict', 'knowledge_storage_unsupported', 'knowledge_workspace_busy'].includes(code) ? 409 : 400, JSON_HEADERS);
        response.end(JSON.stringify({ error: code }));
      } finally { response.off('close', cancel); liveStreams.delete(cancel); }
    },
  })));
}
