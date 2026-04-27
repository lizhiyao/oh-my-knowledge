import type { ExecResult, ExecutorInput } from '../types/index.js';
import { AnthropicResponse, asErrorLike, DEFAULT_TIMEOUT_MS, errorMessage } from './shared.js';

export async function anthropicApiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const reqBody: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: 'user'; content: string }>;
    system?: string;
  } = {
    model: model || 'claude-sonnet-4-5-20250514',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  };
  if (system) reqBody.system = system;

  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json() as AnthropicResponse;
    const durationMs = Date.now() - start;

    if (!res.ok) {
      return { ok: false, error: data.error?.message || `API error ${res.status}`, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, output: null, stopReason: 'error', numTurns: 0 };
    }

    const usage = data.usage || {};
    return {
      ok: true, output: data.content?.map((c) => c.text || '').join('') || '', durationMs, durationApiMs: 0,
      inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0, cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      costUSD: 0, stopReason: data.stop_reason || 'end_turn', numTurns: 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    const stopReason = details.name === 'TimeoutError' ? 'timeout' : 'error';
    const error = details.name === 'TimeoutError' ? `API request timed out after ${timeoutMs / 1000}s` : errorMessage(err);
    return { ok: false, error, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, output: null, stopReason, numTurns: 0 };
  }
}
