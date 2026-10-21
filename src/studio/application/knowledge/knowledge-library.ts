import { z } from 'zod';
import { createLocalKnowledgeLibrary } from '../../../knowledge/application/local.js';
import { LibrarySaveSchema } from '../../../knowledge/application/library.js';

const common = { workspace: z.string().trim().min(1) };
const requestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...common, operation: z.literal('knowledge') }),
  z.strictObject({ ...common, operation: z.literal('list'), query: z.string().trim().max(512).optional(),
    page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(100).optional() }),
  z.strictObject({ ...common, operation: z.literal('show'), id: z.string().uuid(), revision: z.string().uuid().optional() }),
  z.strictObject({ ...common, operation: z.literal('owners'), analysisId: z.string().uuid(), entityId: z.string().uuid() }),
  LibrarySaveSchema.extend({ ...common, operation: z.literal('save') }),
]);
export function executeKnowledgeLibraryAction(input: unknown) {
  const request = requestSchema.parse(input); const library = createLocalKnowledgeLibrary(request.workspace);
  switch (request.operation) {
    case 'knowledge': return library.knowledgeCatalog();
    case 'list': return library.catalog({ query: request.query, page: request.page, pageSize: request.pageSize });
    case 'show': return library.detail(request.id, request.revision);
    case 'owners': return library.owners(request.analysisId, request.entityId);
    case 'save': return library.save({ objectId: request.objectId, requestId: request.requestId, generation: request.generation,
      headRevisionId: request.headRevisionId, draft: request.draft, reason: request.reason, identityConfirmed: request.identityConfirmed });
  }
}
