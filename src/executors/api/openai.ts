import type { ExecResult, ExecutorInput } from '../../types/index.js';
import { optionalTokenCount, splitInclusiveInputTokens } from '../../shared/token-usage.js';
import { DEFAULT_TIMEOUT_MS } from '../defaults.js';
import { readJsonResponse, responseBodyPreview } from './http.js';
import { asErrorLike, errorMessage } from '../runtime.js';

interface OpenAiResponse {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

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
    const { data, rawBody } = await readJsonResponse<OpenAiResponse>(res);
    const durationMs = Date.now() - start;

    if (!res.ok) {
      const bodyPreview = responseBodyPreview(rawBody);
      return { ok: false, error: data?.error?.message || `API error ${res.status}${bodyPreview ? `: ${bodyPreview}` : ''}`, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, output: null, stopReason: 'error', numTurns: 0 };
    }
    if (!data) {
      return { ok: false, error: 'OpenAI API returned an empty or non-JSON response', durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, output: null, stopReason: 'error', numTurns: 0 };
    }

    const usage = data.usage;
    const rawInputTokens = optionalTokenCount(usage?.prompt_tokens);
    const rawOutputTokens = optionalTokenCount(usage?.completion_tokens);
    const rawCacheReadTokens = usage?.prompt_tokens_details?.cached_tokens === undefined
      ? 0
      : optionalTokenCount(usage.prompt_tokens_details.cached_tokens);
    if (
      rawInputTokens === undefined
      || rawOutputTokens === undefined
      || rawCacheReadTokens === undefined
      || rawCacheReadTokens > rawInputTokens
    ) {
      return {
        ok: false,
        error: 'OpenAI response contained missing or invalid token usage',
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
    const normalizedInput = splitInclusiveInputTokens(
      rawInputTokens,
      rawCacheReadTokens,
    );
    const inputTokens = normalizedInput.inputTokens;
    const outputTokens = rawOutputTokens;
    const cacheReadTokens = normalizedInput.cacheReadTokens;
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      const refusal = choice?.message?.refusal?.trim();
      return {
        ok: false,
        error: refusal
          ? `OpenAI response refused the request: ${refusal}`
          : 'OpenAI response did not contain assistant text',
        durationMs,
        durationApiMs: 0,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens: 0,
        costUSD: 0,
        costReportedByExecutor: false,
        output: null,
        stopReason: 'error',
        numTurns: 1,
      };
    }
    return {
      ok: true, output: content, durationMs, durationApiMs: 0,
      // OpenAI reports cached tokens as a subset of prompt_tokens. Keep all
      // executor buckets mutually exclusive so totals and cross-runtime trends
      // do not count cache reads twice.
      inputTokens, outputTokens,
      cacheReadTokens, cacheCreationTokens: 0,
      costUSD: 0, costReportedByExecutor: false,
      stopReason: choice?.finish_reason || 'unknown', numTurns: 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    const stopReason = details.name === 'TimeoutError' ? 'timeout' : 'error';
    const error = details.name === 'TimeoutError' ? `API request timed out after ${timeoutMs / 1000}s` : errorMessage(err);
    return { ok: false, error, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, output: null, stopReason, numTurns: 0 };
  }
}
