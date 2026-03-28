import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_MODEL = 'sonnet';
export const JUDGE_MODEL = 'haiku';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Create an executor by name.
 * Executors wrap CLI tools or APIs into a unified interface.
 *
 * Built-in executors:
 *   - claude: Claude CLI (`claude -p`)
 *   - openai: OpenAI CLI (`openai api chat.completions.create`)
 *   - gemini: Gemini CLI (`gemini` via stdin pipe)
 *   - anthropic-api: Anthropic Messages API (direct HTTP, requires ANTHROPIC_API_KEY)
 *   - openai-api: OpenAI Chat API (direct HTTP, requires OPENAI_API_KEY)
 *
 * Custom executor:
 *   Any other value is treated as a shell command.
 *   Input: JSON via stdin  { model, system, prompt }
 *   Output: JSON via stdout { output, inputTokens?, outputTokens?, costUSD? }
 */
export function createExecutor(name = 'claude') {
  switch (name) {
    case 'claude':
      return claudeExecutor;
    case 'openai':
      return openaiExecutor;
    case 'gemini':
      return geminiExecutor;
    case 'anthropic-api':
      return anthropicApiExecutor;
    case 'openai-api':
      return openaiApiExecutor;
    default:
      return createScriptExecutor(name);
  }
}

// ---------------------------------------------------------------------------
// Claude CLI executor
// ---------------------------------------------------------------------------

async function claudeExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', model];
  if (system) args.push('--system-prompt', system);

  const proxyUrl = process.env.CCV_PROXY_URL || undefined;
  const env = proxyUrl
    ? { ...process.env, ANTHROPIC_BASE_URL: proxyUrl }
    : { ...process.env };

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('claude', args, {
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env,
      ...(cwd && { cwd }),
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
    if (err.killed) {
      return {
        ok: false,
        error: `execution timed out after ${timeoutMs / 1000}s`,
        durationMs,
        durationApiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        output: null,
        stopReason: 'timeout',
        numTurns: 0,
      };
    }
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch { /* cleanup best-effort */ }
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

// ---------------------------------------------------------------------------
// OpenAI CLI executor
// Requires: `pip install openai` (provides `openai` CLI)
// Auth: OPENAI_API_KEY environment variable
// ---------------------------------------------------------------------------

async function openaiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = ['api', 'chat.completions.create',
    '-m', model || 'gpt-4o',
  ];
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
    const data = JSON.parse(stdout);
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
      costUSD: 0, // OpenAI CLI does not return cost
      output: content,
      stopReason: finishReason,
      numTurns: 1,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (err.killed) {
      return {
        ok: false,
        error: `execution timed out after ${timeoutMs / 1000}s`,
        durationMs,
        durationApiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        output: null,
        stopReason: 'timeout',
        numTurns: 0,
      };
    }
    let parsed = null;
    try { parsed = JSON.parse(err.stdout || ''); } catch { /* cleanup best-effort */ }
    return {
      ok: false,
      error: parsed?.error?.message || err.message || 'unknown error',
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

// ---------------------------------------------------------------------------
// Gemini CLI executor
// Requires: `npm i -g @google/gemini-cli` (provides `gemini` CLI)
// Auth: Google account login or GOOGLE_API_KEY environment variable
//
// Gemini CLI is primarily interactive. We pipe the prompt via stdin
// and collect stdout as the response.
// ---------------------------------------------------------------------------

async function geminiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;

  const start = Date.now();
  try {
    const output = await new Promise((resolve, reject) => {
      const args = [];
      if (model) {
        args.push('--model', model);
      }
      const child = spawn('gemini', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(stderr || `gemini exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });

      child.stdin.write(fullPrompt);
      child.stdin.end();
    });

    const durationMs = Date.now() - start;

    // Try to parse as JSON (gemini may return structured output)
    let text = output;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const data = JSON.parse(output);
      if (data.response) text = data.response;
      if (data.stats) {
        inputTokens = data.stats.inputTokens || 0;
        outputTokens = data.stats.outputTokens || 0;
      }
    } catch {
      // Plain text response — use as-is
      text = output.trim();
    }

    return {
      ok: true,
      durationMs,
      durationApiMs: 0,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      output: text,
      stopReason: 'end',
      numTurns: 1,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      ok: false,
      error: err.message || 'unknown error',
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

// ---------------------------------------------------------------------------
// Custom script executor
// Any shell command that reads JSON from stdin and writes JSON to stdout.
// Input:  { model, system, prompt }
// Output: { output, inputTokens?, outputTokens?, costUSD?, stopReason? }
// ---------------------------------------------------------------------------

function createScriptExecutor(command) {
  return async function scriptExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const input = JSON.stringify({ model, system: system || '', prompt });
    const start = Date.now();

    return new Promise((resolve) => {
      const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [command];
      const cmd = parts[0].replace(/^["']|["']$/g, '');
      const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ''));

      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: timeoutMs,
        ...(cwd && { cwd }),
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      child.on('error', (err) => {
        resolve({
          ok: false, error: `executor command failed: ${err.message}`,
          durationMs: Date.now() - start, durationApiMs: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
        });
      });

      child.on('close', (code) => {
        const durationMs = Date.now() - start;
        if (code !== 0) {
          resolve({
            ok: false, error: stderr.trim() || `executor exited with code ${code}`,
            durationMs, durationApiMs: 0,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
          });
          return;
        }
        try {
          const data = JSON.parse(stdout);
          resolve({
            ok: true, output: data.output || '', durationMs,
            durationApiMs: data.durationApiMs || 0,
            inputTokens: data.inputTokens || 0, outputTokens: data.outputTokens || 0,
            cacheReadTokens: data.cacheReadTokens || 0, cacheCreationTokens: data.cacheCreationTokens || 0,
            costUSD: data.costUSD || 0, stopReason: data.stopReason || 'end', numTurns: data.numTurns || 1,
          });
        } catch {
          resolve({
            ok: true, output: stdout.trim(), durationMs, durationApiMs: 0,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            costUSD: 0, stopReason: 'end', numTurns: 1,
          });
        }
      });

      child.stdin.write(input);
      child.stdin.end();
    });
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API executor (direct HTTP, no SDK)
// Auth: ANTHROPIC_API_KEY environment variable
// ---------------------------------------------------------------------------

async function anthropicApiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 环境变量未设置');

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const reqBody = {
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
    const data = await res.json();
    const durationMs = Date.now() - start;

    if (!res.ok) {
      return { ok: false, error: data.error?.message || `API error ${res.status}`, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, output: null, stopReason: 'error', numTurns: 0 };
    }

    const usage = data.usage || {};
    return {
      ok: true, output: data.content?.map((c) => c.text).join('') || '', durationMs, durationApiMs: 0,
      inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0, cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      costUSD: 0, stopReason: data.stop_reason || 'end_turn', numTurns: 1,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const stopReason = err.name === 'TimeoutError' ? 'timeout' : 'error';
    const error = err.name === 'TimeoutError' ? `API request timed out after ${timeoutMs / 1000}s` : (err.message || 'unknown error');
    return { ok: false, error, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, output: null, stopReason, numTurns: 0 };
  }
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API executor (direct HTTP, no SDK)
// Auth: OPENAI_API_KEY environment variable
// ---------------------------------------------------------------------------

async function openaiApiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 环境变量未设置');

  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
  const messages = [];
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
    const data = await res.json();
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
  } catch (err) {
    const durationMs = Date.now() - start;
    const stopReason = err.name === 'TimeoutError' ? 'timeout' : 'error';
    const error = err.name === 'TimeoutError' ? `API request timed out after ${timeoutMs / 1000}s` : (err.message || 'unknown error');
    return { ok: false, error, durationMs, durationApiMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, output: null, stopReason, numTurns: 0 };
  }
}
