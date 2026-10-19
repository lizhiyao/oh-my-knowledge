import type { ExecutorInput } from './ports.js';

/** Exact production body serialization, without endpoint, environment or transport effects. */
export function serializeOpenAiChatBody(input: Pick<ExecutorInput, 'model' | 'system' | 'prompt' | 'outputFormat' | 'maxOutputTokens'>,
  constraints?: 'single-completion/v1'): string {
  const { model, system, prompt, outputFormat, maxOutputTokens } = input;
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const responseFormat = outputFormat?.mode === 'json-schema'
    ? { type: 'json_schema', json_schema: { name: outputFormat.name, schema: outputFormat.schema, strict: true } }
    : outputFormat?.mode === 'json-object' ? { type: 'json_object' } : undefined;
  return JSON.stringify({ model: model || 'gpt-4o', messages,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(maxOutputTokens === undefined ? {} : { max_completion_tokens: maxOutputTokens }),
    ...(constraints === 'single-completion/v1' ? { n: 1, stream: false } : {}),
  });
}
