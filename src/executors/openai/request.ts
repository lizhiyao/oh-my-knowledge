import type { ExecutorInput } from '../contracts/ports.js';
import { serializeOpenAiChatBody } from '../contracts/openai-chat.js';
import { resolveOpenAiEndpoint } from '../core/http.js';

export const OPENAI_CHAT_REQUEST_VERSION = 'openai-chat-request/v1' as const;
export interface OpenAiRequestEvidence { endpoint: string; body: string }
/** Internal opt-in capture policy; ordinary executor calls retain their existing request bytes. */
export interface OpenAiDispatchPolicy {
  requestConstraints: 'single-completion/v1';
  redirect: 'error';
  beforeDispatch(request: Readonly<OpenAiRequestEvidence>): void;
}
/** The actual production request builder, shared with preflight. Never includes credentials. */
export function buildOpenAiChatRequest(input: ExecutorInput, environment: NodeJS.ProcessEnv,
  constraints?: OpenAiDispatchPolicy['requestConstraints']): OpenAiRequestEvidence {
  return { endpoint: resolveOpenAiEndpoint(environment.OPENAI_BASE_URL, 'chat/completions'),
    body: serializeOpenAiChatBody(input, constraints) };
}
