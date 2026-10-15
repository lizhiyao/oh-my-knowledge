import type { ExecResult } from '../contracts/result.js';
import type { ExecutorInput } from '../contracts/ports.js';
import { optionalTokenCount, splitInclusiveInputTokens } from '../contracts/token-usage.js';
import { DEFAULT_TIMEOUT_MS } from '../core/limits.js';
import { readJsonResponse, responseBodyPreview, resolveOpenAiEndpoint } from '../core/http.js';
import { asErrorLike, errorMessage } from '../core/runtime.js';
import { createExecutorDiagnosticRedactor } from '../core/diagnostics.js';

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

export async function openAiApiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS, abortSignal }: ExecutorInput, environment: NodeJS.ProcessEnv = process.env): Promise<ExecResult> {
  const apiKey = environment.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is not set');
  const redact = createExecutorDiagnosticRedactor(environment);

  const baseUrl = environment.OPENAI_BASE_URL;
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const start = Date.now();
  try {
    const res = await fetch(resolveOpenAiEndpoint(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'gpt-4o', messages }),
      signal: abortSignal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)]),
    });
    const { data, rawBody } = await readJsonResponse<OpenAiResponse>(res);
    const durationMs = Date.now() - start;

    if (!res.ok) {
      // Redact before shortening: truncating a credential first would leak its prefix.
      const bodyPreview = responseBodyPreview(redact(rawBody));
      const providerMessage = typeof data?.error?.message === 'string' ? redact(data.error.message) : undefined;
      return { ok: false, error: providerMessage || `API error ${res.status}${bodyPreview ? `: ${bodyPreview}` : ''}`, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, output: null, stopReason: 'error', numTurns: 0 };
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
      const refusal = typeof choice?.message?.refusal === 'string' ? redact(choice.message.refusal.trim()) : undefined;
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
      stopReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason || 'unknown' : 'unknown', numTurns: 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    const stopReason = details.name === 'TimeoutError' ? 'timeout' : 'error';
    const error = details.name === 'TimeoutError' ? `API request timed out after ${timeoutMs / 1000}s` : redact(errorMessage(err));
    return { ok: false, error, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false, costUSD: 0, costReportedByExecutor: false, output: null, stopReason, numTurns: 0 };
  }
}
