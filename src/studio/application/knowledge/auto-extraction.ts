import { z } from 'zod';
import { AutoExtractionConsentSchema } from '../../../knowledge/application/auto-extraction.js';
import { knowledgeWorkspaceRefreshToken } from '../../../knowledge/application/local.js';
import { type ConversationAutoExtraction } from '../../../knowledge/application/auto-extraction.js';
const text = z.string().trim().min(1).max(4096);
const request = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('preview'), threadId: text }),
  z.strictObject({ operation: z.literal('status'), workspace: text, threadId: text }),
  z.strictObject({ operation: z.literal('stop'), workspace: text, threadId: text }),
  AutoExtractionConsentSchema.extend({ operation: z.literal('enable'), workspace: text, threadId: text }),
]);
export function executeAutoExtractionAction(input: unknown, service: ConversationAutoExtraction, signal?: AbortSignal) {
  const value = request.parse(input);
  switch (value.operation) {
    case 'preview': return service.preview(value.threadId, signal);
    case 'status': return service.status(value.workspace, value.threadId);
    case 'stop': return service.stop(value.workspace, value.threadId);
    case 'enable': return service.enable(value.workspace, value.threadId, { workflowId: value.workflowId, token: value.token, executor: value.executor, model: value.model, maxCalls: value.maxCalls }, signal);
  }
}

/** HTTP-only presentation metadata; the action result and persistent contracts stay unchanged. */
export function autoExtractionStatusEtag(workspace: string, threadId: string, state: unknown) {
  return knowledgeWorkspaceRefreshToken(workspace, threadId, state);
}
