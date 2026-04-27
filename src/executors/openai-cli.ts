import type { ExecResult, ExecutorInput } from '../types/index.js';
import {
  asErrorLike,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  execFileAsync,
  MAX_BUFFER,
  OpenAiResponse,
  parseJson,
  timeoutExecResult,
} from './shared.js';

export async function openAiCliExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const args = ['api', 'chat.completions.create', '-m', model || 'gpt-4o'];
  if (system) {
    args.push('-g', 'system', system);
  }
  args.push('-g', 'user', prompt);

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('openai', args, {
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env: { ...process.env },
    });
    const durationMs = Date.now() - start;
    const data = parseJson<OpenAiResponse>(stdout);
    const usage = data.usage || {};
    const content = data.choices?.[0]?.message?.content || '';
    const finishReason = data.choices?.[0]?.finish_reason || 'unknown';
    return {
      ok: true,
      durationMs,
      durationApiMs: 0,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      output: content,
      stopReason: finishReason,
      numTurns: 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    if (details.killed) return timeoutExecResult(timeoutMs, durationMs);
    let parsed: OpenAiResponse | null = null;
    try { parsed = parseJson<OpenAiResponse>(details.stdout || ''); } catch {}
    return {
      ok: false,
      error: parsed?.error?.message || errorMessage(err),
      durationMs,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      output: null,
      stopReason: 'error',
      numTurns: 0,
    };
  }
}
