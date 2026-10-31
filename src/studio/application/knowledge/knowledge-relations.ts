import { z } from 'zod';
import type { KnowledgeActor } from '../../../knowledge/contracts.js';
import { createLocalKnowledgeRelations } from '../../../knowledge/application/local.js';
import { executeKnowledgeRelationOperation, knowledgeRelationOperationSchemas } from '../../../knowledge/application/relation-operations.js';

const common = { workspace: z.string().trim().min(1) };
const requestSchema = z.discriminatedUnion('operation', [
  knowledgeRelationOperationSchemas.relations.safeExtend(common), knowledgeRelationOperationSchemas.relation.safeExtend(common),
  knowledgeRelationOperationSchemas['propose-relation'].safeExtend(common), knowledgeRelationOperationSchemas['review-relation'].safeExtend(common),
  knowledgeRelationOperationSchemas['withdraw-relation'].safeExtend(common),
]);

/** Browser input never supplies the actual author or reviewer identity. */
export function executeKnowledgeRelationAction(input: unknown, actor: KnowledgeActor) {
  const { workspace, ...request } = requestSchema.parse(input);
  return executeKnowledgeRelationOperation(createLocalKnowledgeRelations(workspace, actor), request);
}
