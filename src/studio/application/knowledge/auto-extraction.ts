import { z } from 'zod';
import { ExtractionGenerationPolicySchema } from '../../../observability/application.js';
import { knowledgeWorkspaceRefreshToken, type ConversationAutoExtraction } from '../../../observability/application.js';
const text = z.string().trim().min(1).max(4096);
const request = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('preview'), threadId: text }),
  z.strictObject({ operation: z.literal('status'), workspace: text, threadId: text }),
  z.strictObject({ operation: z.literal('stop'), workspace: text, threadId: text }),
  z.strictObject({ operation: z.literal('enable'), workspace: text, threadId: text, token: text,
    executor: text, model: text, maxCalls: z.number().int().min(1).max(20), policy: ExtractionGenerationPolicySchema.optional() }),
]);
export function executeAutoExtractionAction(input: unknown, service: ConversationAutoExtraction, signal?: AbortSignal) {
  const value = request.parse(input);
  switch (value.operation) {
    case 'preview': return service.preview(value.threadId, signal);
    case 'status': return service.status(value.workspace, value.threadId);
    case 'stop': return service.stop(value.workspace, value.threadId);
    case 'enable': return service.enable(value.workspace, value.threadId, value, signal);
  }
}

/** HTTP-only presentation metadata; the action result and persistent contracts stay unchanged. */
export function autoExtractionStatusEtag(workspace: string, threadId: string, state: unknown) {
  return knowledgeWorkspaceRefreshToken(workspace, threadId, state);
}
