import type { ExecResult, ExecutorFailure, ExecutorFailureKind } from '../contracts/result.js';
import type { ExecutorInput } from '../contracts/ports.js';
import { optionalTokenCount, splitInclusiveInputTokens } from '../contracts/token-usage.js';
import { DEFAULT_TIMEOUT_MS } from '../core/limits.js';
import { ApiResponseCapacityError, readJsonResponse, responseBodyPreview } from '../core/http.js';
import { asErrorLike, errorMessage } from '../core/runtime.js';
import { createExecutorDiagnosticRedactor } from '../core/diagnostics.js';
import { assertExecutorInputCapabilities } from '../core/capabilities.js';
import { buildOpenAiChatRequest, type OpenAiDispatchPolicy } from './request.js';

export const OPENAI_CHAT_COMPLETIONS_ADAPTER_VERSION = 'openai-chat-completions/v3' as const;

interface OpenAiResponse {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string;
  }>;
  error?: { message?: string; code?: string; param?: string };
}

function reportedUsage(usage: OpenAiResponse['usage']): Pick<ExecResult,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'tokenUsageReportedByExecutor'> {
  const input = optionalTokenCount(usage?.prompt_tokens);
  const output = optionalTokenCount(usage?.completion_tokens);
  const cached = usage?.prompt_tokens_details?.cached_tokens === undefined ? 0
    : optionalTokenCount(usage.prompt_tokens_details.cached_tokens);
  if (input === undefined || output === undefined || cached === undefined || cached > input) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: false };
  }
  return { ...splitInclusiveInputTokens(input, cached), outputTokens: output };
}

function httpFailure(response: Response, error: OpenAiResponse['error']): ExecutorFailure {
  let failureKind: ExecutorFailureKind = response.status === 401 ? 'authentication'
    : response.status === 403 ? 'permission'
    : response.status === 408 ? 'timeout'
    : response.status === 429 ? 'rate_limit'
    : response.status >= 500 ? 'server_error' : 'invalid_request';
  if (response.status === 400 && ['unsupported_parameter', 'unsupported_value'].includes(error?.code ?? '')
    && ['response_format', 'response_format.type', 'response_format.json_schema'].includes(error?.param ?? '')) {
    failureKind = 'unsupported_output';
  }
  const retryAfter = response.headers.get('retry-after');
  const delay = retryAfter === null ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
    ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  return { failureKind, httpStatus: response.status,
    ...(Number.isFinite(delay) && delay >= 0 && delay <= 2_147_483_647 ? { retryAfterMs: Math.ceil(delay) } : {}) };
}

/** Exactly one request. Callers own fallback, retry policy and cumulative budgets. */
export async function openAiApiExecutor(input: ExecutorInput, environment: NodeJS.ProcessEnv = process.env, dispatchPolicy?: OpenAiDispatchPolicy): Promise<ExecResult> {
  assertExecutorInputCapabilities('openai-api', input);
  const { timeoutMs = DEFAULT_TIMEOUT_MS, abortSignal, outputFormat } = input;
  const apiKey = environment.OPENAI_API_KEY;
  const redact = createExecutorDiagnosticRedactor(environment);
  const start = Date.now();
  const failed = (failure: ExecutorFailure, error: string, data?: OpenAiResponse): ExecResult => {
    const content = data?.choices?.[0]?.message?.content;
    const refusal = data?.choices?.[0]?.message?.refusal;
    return {
      ok: false, error: responseBodyPreview(redact(error), 1024), failure,
      output: typeof content === 'string' ? content : typeof refusal === 'string' ? refusal : null,
      ...(typeof refusal === 'string' ? { refusal } : {}),
      durationMs: Date.now() - start, durationApiMs: 0,
      ...reportedUsage(data?.usage), costUSD: 0, costReportedByExecutor: false,
      stopReason: failure.failureKind === 'timeout' ? 'timeout' : failure.failureKind === 'cancelled' ? 'interrupted'
        : typeof data?.choices?.[0]?.finish_reason === 'string' ? data.choices[0].finish_reason || 'error' : 'error',
      numTurns: data ? 1 : 0,
    };
  };
  if (abortSignal?.aborted) return failed({ failureKind: 'cancelled' }, 'OpenAI API request was cancelled');
  if (!apiKey) return failed({ failureKind: 'authentication' }, 'OPENAI_API_KEY environment variable is not set');
  let phase: 'configuration' | 'transport' | 'response' = 'configuration';
  let requestSignal: AbortSignal | undefined;
  let timeoutSignal: AbortSignal | undefined;
  let response: Response | undefined;
  try {
    const request = buildOpenAiChatRequest(input, environment, dispatchPolicy?.requestConstraints);
    const { endpoint, body } = request;
    timeoutSignal = AbortSignal.timeout(timeoutMs);
    requestSignal = abortSignal === undefined ? timeoutSignal : AbortSignal.any([abortSignal, timeoutSignal]);
    dispatchPolicy?.beforeDispatch(Object.freeze(request));
    phase = 'transport';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body,
      signal: requestSignal,
      ...(dispatchPolicy ? { redirect: dispatchPolicy.redirect } : {}),
    });
    response = res;
    phase = 'response';
    const { data, rawBody } = await readJsonResponse<OpenAiResponse>(res);
    if (!res.ok) {
      // Redact before shortening: truncating a credential first would leak its prefix.
      const preview = responseBodyPreview(redact(rawBody));
      return failed(httpFailure(res, data?.error), typeof data?.error?.message === 'string'
        ? data.error.message : `API error ${res.status}${preview ? `: ${preview}` : ''}`, data ?? undefined);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return failed({ failureKind: 'invalid_response' }, 'OpenAI API returned an empty or non-JSON response');
    }
    const choice = data.choices?.[0];
    const refusal = typeof choice?.message?.refusal === 'string' ? choice.message.refusal.trim() : '';
    if (refusal) return failed({ failureKind: 'refusal' }, `OpenAI response refused the request: ${refusal}`, data);
    if (choice?.finish_reason === 'content_filter') {
      return failed({ failureKind: 'content_filter' }, 'OpenAI response was interrupted by the content filter', data);
    }
    if (choice?.finish_reason === 'length') {
      return failed({ failureKind: 'truncation' }, 'OpenAI response was truncated at the output limit', data);
    }
    const toolCalls = choice?.message?.tool_calls;
    if (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call'
      || (toolCalls != null && (!Array.isArray(toolCalls) || toolCalls.length > 0)) || choice?.message?.function_call != null) {
      return failed({ failureKind: 'invalid_response' }, 'OpenAI text response unexpectedly requested a tool', data);
    }
    if (outputFormat && outputFormat.mode !== 'prompt-json' && choice?.finish_reason !== 'stop') {
      return failed({ failureKind: 'invalid_response' }, 'OpenAI structured response did not report complete generation', data);
    }
    const usage = reportedUsage(data.usage);
    if (usage.tokenUsageReportedByExecutor === false) {
      return failed({ failureKind: 'invalid_response' }, 'OpenAI response contained missing or invalid token usage', data);
    }
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return failed({ failureKind: 'invalid_response' }, 'OpenAI response did not contain assistant text', data);
    }
    return {
      ok: true, output: content, durationMs: Date.now() - start, durationApiMs: 0, ...usage,
      costUSD: 0, costReportedByExecutor: false,
      stopReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason || 'unknown' : 'unknown', numTurns: 1,
    };
  } catch (err: unknown) {
    const details = asErrorLike(err);
    if (requestSignal?.aborted && abortSignal?.aborted && requestSignal.reason === abortSignal.reason) {
      return failed({ failureKind: 'cancelled' }, 'OpenAI API request was cancelled');
    }
    // A broken error body cannot turn known auth/config failures into retryable transport errors.
    if (response && !response.ok && !(err instanceof ApiResponseCapacityError)) {
      return failed(httpFailure(response, undefined), errorMessage(err));
    }
    if ((timeoutSignal?.aborted && requestSignal?.reason === timeoutSignal.reason) || details.name === 'TimeoutError') {
      return failed({ failureKind: 'timeout' }, `API request timed out after ${timeoutMs / 1000}s`);
    }
    const failureKind: ExecutorFailureKind = err instanceof ApiResponseCapacityError ? 'capacity'
      : phase === 'configuration' ? 'invalid_request' : 'network_error';
    return failed({ failureKind }, errorMessage(err));
  }
}
