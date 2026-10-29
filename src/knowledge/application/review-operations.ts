import { z } from 'zod';
import { KnowledgeBodyRefSchema } from '../contracts.js';
import { KnowledgeContentReviewInputSchema, KnowledgeCoverageReviewInputSchema, KnowledgeUseInputSchema } from '../reviews.js';
import type { KnowledgeReviewApplication } from './review.js';

export const knowledgeReviewOperationSchemas = {
  'review-status': z.strictObject({ operation: z.literal('review-status'), bodyRef: KnowledgeBodyRefSchema, projectionRevisionId: z.string().min(1).max(256).nullable().optional() }),
  'review-content': KnowledgeContentReviewInputSchema.safeExtend({ operation: z.literal('review-content') }),
  'review-coverage': KnowledgeCoverageReviewInputSchema.safeExtend({ operation: z.literal('review-coverage') }),
  'record-use': KnowledgeUseInputSchema.safeExtend({ operation: z.literal('record-use') }),
};
export const KnowledgeReviewOperationSchema = z.discriminatedUnion('operation', [
  knowledgeReviewOperationSchemas['review-status'], knowledgeReviewOperationSchemas['review-content'], knowledgeReviewOperationSchemas['review-coverage'], knowledgeReviewOperationSchemas['record-use'],
]);
export type KnowledgeReviewOperation = z.input<typeof KnowledgeReviewOperationSchema>;
export function executeKnowledgeReviewOperation(app: KnowledgeReviewApplication, input: KnowledgeReviewOperation) {
  const request = KnowledgeReviewOperationSchema.parse(input);
  switch (request.operation) {
    case 'review-status': return app.status(request.bodyRef, 'projectionRevisionId' in request ? request.projectionRevisionId : undefined);
    case 'review-content': { const { operation, ...fields } = request; void operation; return app.reviewContent(fields); }
    case 'review-coverage': { const { operation, ...fields } = request; void operation; return app.reviewCoverage(fields); }
    case 'record-use': { const { operation, ...fields } = request; void operation; return app.recordUse(fields); }
  }
}
