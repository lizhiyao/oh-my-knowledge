import { z } from 'zod';
import type { KnowledgeActor } from '../../../knowledge/contracts.js';
import { createLocalKnowledgeReview } from '../../../knowledge/application/local.js';
import { executeKnowledgeReviewOperation, knowledgeReviewOperationSchemas } from '../../../knowledge/application/review-operations.js';

const common = { workspace: z.string().trim().min(1) };
const requestSchema = z.discriminatedUnion('operation', [
  knowledgeReviewOperationSchemas['review-status'].safeExtend(common),
  knowledgeReviewOperationSchemas['review-content'].safeExtend(common),
  knowledgeReviewOperationSchemas['review-coverage'].safeExtend(common),
  knowledgeReviewOperationSchemas['record-use'].safeExtend(common),
]);

/** Actor identity is supplied by the trusted Studio host, never by browser input. */
export function executeKnowledgeReviewAction(input: unknown, actor: KnowledgeActor) {
  const { workspace, ...request } = requestSchema.parse(input);
  return executeKnowledgeReviewOperation(createLocalKnowledgeReview(workspace, actor), request);
}
