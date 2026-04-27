import type { ExecResult, ExecutorInput } from '../types.js';
import { asErrorLike, DEFAULT_TIMEOUT_MS, errorMessage, OpenAiResponse } from './shared.js';

export async function openAiApiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');

  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o', messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json() as OpenAiResponse;
    const durationMs = Date.now() - start;

    if (!res.ok) {
      return { ok: false, error: data.error?.message || `API error ${res.status}`, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, output: null, stopReason: 'error', numTurns: 0 };
    }

    const usage = data.usage || {};
    return {
      ok: true, output: data.choices?.[0]?.message?.content || '', durationMs, durationApiMs: 0,
      inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0,
      cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || 0, cacheCreationTokens: 0,
      costUSD: 0, stopReason: data.choices?.[0]?.finish_reason || 'unknown', numTurns: 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    const stopReason = details.name === 'TimeoutError' ? 'timeout' : 'error';
    const error = details.name === 'TimeoutError' ? `API request timed out after ${timeoutMs / 1000}s` : errorMessage(err);
    return { ok: false, error, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, output: null, stopReason, numTurns: 0 };
  }
}
