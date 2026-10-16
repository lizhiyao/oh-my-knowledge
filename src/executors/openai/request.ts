import type { ExecutorInput } from '../contracts/ports.js';
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
  const { model, system, prompt, outputFormat, maxOutputTokens } = input;
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const responseFormat = outputFormat?.mode === 'json-schema'
    ? { type: 'json_schema', json_schema: { name: outputFormat.name, schema: outputFormat.schema, strict: true } }
    : outputFormat?.mode === 'json-object' ? { type: 'json_object' } : undefined;
  return { endpoint: resolveOpenAiEndpoint(environment.OPENAI_BASE_URL, 'chat/completions'),
    body: JSON.stringify({ model: model || 'gpt-4o', messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(maxOutputTokens === undefined ? {} : { max_completion_tokens: maxOutputTokens }),
      ...(constraints === 'single-completion/v1' ? { n: 1, stream: false } : {}),
    }) };
}
