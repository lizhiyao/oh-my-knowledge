import type { ExecResult } from '../contracts/result.js';
import type { ExecutorInput } from '../contracts/ports.js';
import { optionalTokenCount } from '../core/token-usage.js';
import { DEFAULT_TIMEOUT_MS } from '../core/limits.js';
import { readJsonResponse, responseBodyPreview } from '../core/http.js';
import { asErrorLike, errorMessage } from '../core/runtime.js';

interface AnthropicResponse {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  error?: { message?: string };
}

export async function anthropicApiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS, abortSignal }: ExecutorInput): Promise<ExecResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const reqBody: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: 'user'; content: string }>;
    system?: string;
  } = {
    model: model || 'claude-sonnet-4-5',
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
      signal: abortSignal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)]),
    });
    const { data, rawBody } = await readJsonResponse<AnthropicResponse>(res);
    const durationMs = Date.now() - start;

    if (!res.ok) {
      const bodyPreview = responseBodyPreview(rawBody);
      return { ok: false, error: data?.error?.message || `API error ${res.status}${bodyPreview ? `: ${bodyPreview}` : ''}`, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, output: null, stopReason: 'error', numTurns: 0 };
    }
    if (!data) {
      return { ok: false, error: 'Anthropic API returned an empty or non-JSON response', durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, output: null, stopReason: 'error', numTurns: 0 };
    }

    const usage = data.usage;
    const inputTokens = optionalTokenCount(usage?.input_tokens);
    const outputTokens = optionalTokenCount(usage?.output_tokens);
    const cacheReadTokens = usage?.cache_read_input_tokens === undefined
      ? 0
      : optionalTokenCount(usage.cache_read_input_tokens);
    const cacheCreationTokens = usage?.cache_creation_input_tokens === undefined
      ? 0
      : optionalTokenCount(usage.cache_creation_input_tokens);
    if (
      inputTokens === undefined
      || outputTokens === undefined
      || cacheReadTokens === undefined
      || cacheCreationTokens === undefined
    ) {
      return {
        ok: false,
        error: 'Anthropic response contained missing or invalid token usage',
        durationMs,
        durationApiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        tokenUsageReportedByExecutor: false,
        costUSD: 0,
        costReportedByExecutor: false,
        output: null,
        stopReason: 'error',
        numTurns: 1,
      };
    }
    const output = data.content
      ?.filter((block) => block.type === undefined || block.type === 'text')
      .map((block) => block.text || '')
      .join('') ?? '';
    if (!output.trim()) {
      return {
        ok: false,
        error: 'Anthropic response did not contain assistant text',
        durationMs,
        durationApiMs: 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUSD: 0,
        costReportedByExecutor: false,
        output: null,
        stopReason: 'error',
        numTurns: 1,
      };
    }
    return {
      ok: true, output, durationMs, durationApiMs: 0,
      inputTokens, outputTokens,
      cacheReadTokens, cacheCreationTokens,
      costUSD: 0, costReportedByExecutor: false,
      stopReason: data.stop_reason || 'end_turn', numTurns: 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    const stopReason = details.name === 'TimeoutError' ? 'timeout' : 'error';
    const error = details.name === 'TimeoutError' ? `API request timed out after ${timeoutMs / 1000}s` : errorMessage(err);
    return { ok: false, error, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, output: null, stopReason, numTurns: 0 };
  }
}
