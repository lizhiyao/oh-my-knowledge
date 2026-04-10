import type { ExecResult, ExecutorInput } from '../types.js';
import {
  asErrorLike,
  buildExecEnv,
  ClaudeCliResponse,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  execFileAsync,
  MAX_BUFFER,
  parseJson,
  timeoutExecResult,
} from './shared.js';

export async function claudeCliExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const args = ['-p', prompt, '--output-format', 'json', '--model', model];
  if (system) args.push('--system-prompt', system);

  const env = buildExecEnv(skillDir);

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('claude', args, {
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env,
      ...(cwd && { cwd }),
    });
    const durationMs = Date.now() - start;
    const data = parseJson<ClaudeCliResponse>(stdout);
    const usage = data.usage || {};
    return {
      ok: !data.is_error,
      durationMs: data.duration_ms || durationMs,
      durationApiMs: data.duration_api_ms || 0,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      costUSD: data.total_cost_usd || 0,
      output: data.result || '',
      stopReason: data.stop_reason || 'unknown',
      numTurns: data.num_turns || 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    if (details.killed) return timeoutExecResult(timeoutMs, durationMs);
    let parsed: ClaudeCliResponse | null = null;
    try { parsed = parseJson<ClaudeCliResponse>(details.stdout || ''); } catch {}
    return {
      ok: false,
      error: parsed?.result || errorMessage(err),
      durationMs,
      durationApiMs: 0,
      inputTokens: parsed?.usage?.input_tokens || 0,
      outputTokens: parsed?.usage?.output_tokens || 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: parsed?.total_cost_usd || 0,
      output: null,
      stopReason: 'error',
      numTurns: 0,
    };
  }
}
