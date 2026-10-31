import { z } from 'zod';
import { KnowledgeBodyRefSchema } from '../contracts.js';
import { KnowledgeRelationError, KnowledgeRelationProposeInputSchema, KnowledgeRelationReviewInputSchema, KnowledgeRelationWithdrawInputSchema } from '../relations.js';
import type { KnowledgeRelationsApplication } from './relations.js';
import { knowledgeFailureCode } from './operations.js';

export const knowledgeRelationOperationSchemas = {
  relations: z.strictObject({ operation: z.literal('relations'), bodyRef: KnowledgeBodyRefSchema }),
  relation: z.strictObject({ operation: z.literal('relation'), relationId: z.uuid(), relationRevisionId: z.uuid().optional() }),
  'propose-relation': KnowledgeRelationProposeInputSchema.safeExtend({ operation: z.literal('propose-relation') }),
  'review-relation': KnowledgeRelationReviewInputSchema.safeExtend({ operation: z.literal('review-relation') }),
  'withdraw-relation': KnowledgeRelationWithdrawInputSchema.safeExtend({ operation: z.literal('withdraw-relation') }),
};
export const KnowledgeRelationOperationSchema = z.discriminatedUnion('operation', [
  knowledgeRelationOperationSchemas.relations, knowledgeRelationOperationSchemas.relation,
  knowledgeRelationOperationSchemas['propose-relation'], knowledgeRelationOperationSchemas['review-relation'], knowledgeRelationOperationSchemas['withdraw-relation'],
]);
export type KnowledgeRelationOperation = z.input<typeof KnowledgeRelationOperationSchema>;

/** One zero-model dispatch path for actual host-attributed relation operations. */
export function executeKnowledgeRelationOperation(app: KnowledgeRelationsApplication, input: KnowledgeRelationOperation) {
  const request = KnowledgeRelationOperationSchema.parse(input);
  switch (request.operation) {
    case 'relations': return app.list(request.bodyRef);
    case 'relation': return app.relation(request.relationId, request.relationRevisionId);
    case 'propose-relation': { const { operation, ...fields } = request; void operation; return app.propose(fields); }
    case 'review-relation': { const { operation, ...fields } = request; void operation; return app.review(fields); }
    case 'withdraw-relation': { const { operation, ...fields } = request; void operation; return app.withdraw(fields); }
  }
}

export function knowledgeRelationFailureCode(cause: unknown) {
  if (cause instanceof KnowledgeRelationError) return `knowledge_relation_${cause.code}` as const;
  if (cause instanceof z.ZodError) return 'knowledge_relation_invalid' as const;
  return knowledgeFailureCode(cause);
}
