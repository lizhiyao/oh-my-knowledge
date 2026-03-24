import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_MODEL = 'sonnet';
export const JUDGE_MODEL = 'haiku';

/**
 * Create an executor by name.
 * Executors wrap CLI tools (claude, codex, etc.) into a unified interface.
 */
export function createExecutor(name = 'claude') {
  switch (name) {
    case 'claude':
      return claudeExecutor;
    default:
      throw new Error(`Unknown executor: ${name}. Available: claude`);
  }
}

/**
 * Claude CLI executor.
 * Calls `claude -p` with JSON output format.
 *
 * @param {object} opts
 * @param {string} opts.model - Model name (e.g., 'sonnet', 'haiku')
 * @param {string} [opts.system] - System prompt (skill content)
 * @param {string} opts.prompt - User prompt
 * @returns {Promise<{ok, output, durationMs, inputTokens, outputTokens, costUSD, ...}>}
 */
async function claudeExecutor({ model, system, prompt }) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', model];
  if (system) args.push('--system-prompt', system);

  const proxyUrl = process.env.CCV_PROXY_URL || undefined;
  const env = proxyUrl
    ? { ...process.env, ANTHROPIC_BASE_URL: proxyUrl }
    : { ...process.env };

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('claude', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      env,
    });
    const durationMs = Date.now() - start;
    const data = JSON.parse(stdout);
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
  } catch (err) {
    const durationMs = Date.now() - start;
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch {}
    return {
      ok: false,
      error: parsed?.result || err.message || 'unknown error',
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
