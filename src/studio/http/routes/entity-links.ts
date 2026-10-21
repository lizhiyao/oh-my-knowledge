import { z } from 'zod';
import { createEntityLinkStudioService, EntityLinkStudioConfirmationError, EntityLinkStudioConflictError } from '../../application/knowledge/entity-links.js';
import type { ExecutorArchiveProducer } from '../../../executors/contracts/archive.js';
import { JSON_HEADERS } from '../errors.js';
import { readJsonObjectBody } from '../request-errors.js';
import { createStudioRouter } from './router.js';
import type { LiveStreamRegistry } from './contracts.js';

export function createEntityLinkRoutes(liveStreams: LiveStreamRegistry, producer: ExecutorArchiveProducer) {
  const service = createEntityLinkStudioService(producer);
  return createStudioRouter([{ pattern: '/api/knowledge/entity-links', method: 'POST', mutation: true,
    async handler({ request, response }) {
      const input = await readJsonObjectBody(request);
      const controller = new AbortController(), cancel = () => controller.abort();
      response.once('close', cancel); liveStreams.add(cancel);
      try {
        const result = await service.execute(input, controller.signal);
        if (!response.destroyed) { response.writeHead(200, JSON_HEADERS); response.end(JSON.stringify(result)); }
      } catch (error) {
        if (response.destroyed) return;
        if (error instanceof EntityLinkStudioConflictError) {
          response.writeHead(409, JSON_HEADERS); response.end(JSON.stringify({ error: error.message })); return;
        }
        const invalid = error instanceof z.ZodError, consent = error instanceof EntityLinkStudioConfirmationError;
        response.writeHead(invalid ? 400 : consent ? 409 : 503, JSON_HEADERS);
        response.end(JSON.stringify({ error: invalid ? 'entity_link_input_invalid' : consent ? 'entity_link_confirmation_invalid' : 'entity_link_outcome_unconfirmed' }));
      } finally { response.off('close', cancel); liveStreams.delete(cancel); }
    },
  }]);
}
