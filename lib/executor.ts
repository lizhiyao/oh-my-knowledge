import { execFile, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { ExecResult, ExecutorInput, ExecutorFn, TurnInfo, ToolCallInfo } from './types.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_MODEL = 'sonnet';
export const JUDGE_MODEL = 'haiku';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeCliResponse {
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: TokenUsage;
  total_cost_usd?: number;
  result?: string;
  stop_reason?: string;
  num_turns?: number;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAiResponse {
  usage?: OpenAiUsage;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

interface GeminiResponse {
  response?: string;
  stats?: { inputTokens?: number; outputTokens?: number };
}

interface AnthropicResponse {
  usage?: TokenUsage;
  content?: Array<{ text?: string }>;
  stop_reason?: string;
  error?: { message?: string };
}

interface ClaudeSdkQueryOptions {
  model?: string;
  systemPrompt?: string;
  cwd: string;
  permissionMode: 'bypassPermissions';
  allowDangerouslySkipPermissions: true;
  abortController: AbortController;
  env: NodeJS.ProcessEnv;
}

interface ClaudeSdkQueryInput {
  prompt: string;
  options: ClaudeSdkQueryOptions;
}

interface ClaudeSdkBaseMessage {
  type: string;
  // Fields present on assistant messages
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  // Fields present on tool_result messages
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

interface ClaudeSdkResultMessage extends ClaudeSdkBaseMessage {
  type: 'result';
  result?: string;
  usage?: TokenUsage;
  total_cost_usd?: number;
  duration_api_ms?: number;
  duration_ms?: number;
  num_turns?: number;
  subtype?: string;
  errors?: string[];
}

interface ClaudeSdkModule {
  query: (opts: ClaudeSdkQueryInput) => AsyncIterable<ClaudeSdkBaseMessage>;
}

interface ExecutorErrorLike {
  message?: string;
  name?: string;
  killed?: boolean;
  stdout?: string;
}

function asErrorLike(err: unknown): ExecutorErrorLike {
  return typeof err === 'object' && err !== null ? err as ExecutorErrorLike : {};
}

function errorMessage(err: unknown, fallback: string = 'unknown error'): string {
  const details = asErrorLike(err);
  return details.message || fallback;
}

function parseJson<T>(content: string): T {
  return JSON.parse(content) as T;
}

function isClaudeSdkResultMessage(message: ClaudeSdkBaseMessage): message is ClaudeSdkResultMessage {
  return message.type === 'result';
}

/**
 * Extract structured turns and tool calls from claude-sdk message stream.
 *
 * claude-sdk message types:
 *   - type:"assistant" + message.content[{type:"tool_use"}] → agent calls a tool
 *   - type:"assistant" + message.content[{type:"text"}]     → agent text response
 *   - type:"user"      + message.content[{type:"tool_result"}] → tool execution result
 *   - type:"result"    → final result (skipped)
 *   - type:"system"/"rate_limit_event" → metadata (skipped)
 */
export function extractAgentTrace(messages: ClaudeSdkBaseMessage[], timestamps?: number[]): { turns: TurnInfo[]; toolCalls: ToolCallInfo[] } {
  const turns: TurnInfo[] = [];
  const toolCalls: ToolCallInfo[] = [];
  const pendingToolUse = new Map<string, { tool: string; input: unknown }>();
  let lastTurnTs = timestamps?.[0] || 0;

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    const msgTs = timestamps?.[msgIdx] || 0;
    if (msg.type === 'result' || msg.type === 'system' || msg.type === 'rate_limit_event') continue;

    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    // Assistant message — may contain text and/or tool_use blocks
    if (msg.type === 'assistant') {
      const textParts: string[] = [];
      const turnToolCalls: ToolCallInfo[] = [];

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'tool_use' && block.name) {
          pendingToolUse.set(block.id || '', { tool: block.name, input: block.input });
          turnToolCalls.push({ tool: block.name, input: block.input, output: null, success: true });
        }
        // skip "thinking" blocks
      }

      if (textParts.length > 0 || turnToolCalls.length > 0) {
        const dur = msgTs && lastTurnTs ? msgTs - lastTurnTs : undefined;
        turns.push({
          role: 'assistant',
          content: textParts.join('\n'),
          ...(turnToolCalls.length > 0 && { toolCalls: turnToolCalls }),
          ...(dur != null && dur > 0 && { durationMs: dur }),
        });
        if (msgTs) lastTurnTs = msgTs;
      }
    }

    // User message with tool_result — this is the tool execution output
    if (msg.type === 'user') {
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const toolUseId = (block as unknown as { tool_use_id?: string }).tool_use_id || '';
        const pending = pendingToolUse.get(toolUseId);
        const isError = (block as unknown as { is_error?: boolean }).is_error || false;

        // Extract text from tool result content
        const resultContent = (block as unknown as { content?: string | Array<{ type: string; text?: string }> }).content;
        const outputText = typeof resultContent === 'string'
          ? resultContent
          : Array.isArray(resultContent)
            ? resultContent.map((c) => c.text || '').join('')
            : '';

        const tc: ToolCallInfo = {
          tool: pending?.tool || 'unknown',
          input: pending?.input || null,
          output: outputText.slice(0, 500),
          success: !isError,
        };
        toolCalls.push(tc);

        // Update placeholder in last assistant turn
        if (pending) {
          for (let i = turns.length - 1; i >= 0; i--) {
            const turn = turns[i];
            if (turn.role === 'assistant' && turn.toolCalls) {
              const placeholder = turn.toolCalls.find((t) => t.tool === pending.tool && t.output === null);
              if (placeholder) {
                placeholder.output = tc.output;
                placeholder.success = !isError;
                break;
              }
            }
          }
        }

        const toolDur = msgTs && lastTurnTs ? msgTs - lastTurnTs : undefined;
        turns.push({
          role: 'tool',
          content: outputText.slice(0, 500),
          ...(toolDur != null && toolDur > 0 && { durationMs: toolDur }),
        });
        if (msgTs) lastTurnTs = msgTs;
        pendingToolUse.delete(toolUseId);
      }
    }
  }

  return { turns, toolCalls };
}

let _sdkQuery: ClaudeSdkModule['query'] | null = null;
async function getSdkQuery(): Promise<ClaudeSdkModule['query']> {
  if (!_sdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk') as ClaudeSdkModule;
    _sdkQuery = sdk.query;
  }
  return _sdkQuery!;
}

/**
 * Create an executor by name.
 * Executors wrap CLI tools or APIs into a unified interface.
 *
 * Built-in executors:
 *   - claude: Claude CLI (`claude -p`)
 *   - claude-sdk: Claude Agent SDK (structured async generator, no stdout parsing)
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
export function createExecutor(name: string = 'claude'): ExecutorFn {
  switch (name) {
    case 'claude':
      return claudeExecutor;
    case 'claude-sdk':
      return claudeSdkExecutor;
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

async function claudeExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
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
    if (details.killed) {
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

// ---------------------------------------------------------------------------
// Claude Agent SDK executor
// Uses @anthropic-ai/claude-agent-sdk query() — structured async generator,
// no stdout parsing, immune to buffer truncation.
// ---------------------------------------------------------------------------

async function claudeSdkExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, verbose = false }: ExecutorInput): Promise<ExecResult> {
  const start = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  const proxyUrl = process.env.CCV_PROXY_URL;
  const env = proxyUrl
    ? { ...process.env, ANTHROPIC_BASE_URL: proxyUrl }
    : { ...process.env };

  const messages: ClaudeSdkBaseMessage[] = [];
  const messageTimestamps: number[] = [];

  try {
    const query = await getSdkQuery();
    const stream = query({
      prompt,
      options: {
        model,
        systemPrompt: system || undefined,
        cwd: cwd || process.cwd(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
        env,
      },
    });

    const resultMsgs: ClaudeSdkResultMessage[] = [];
    for await (const msg of stream) {
      messages.push(msg);
      messageTimestamps.push(Date.now());
      if (isClaudeSdkResultMessage(msg)) resultMsgs.push(msg);
    }

    clearTimeout(timer);

    // Debug log — only when verbose is enabled
    if (verbose) {
      try {
        const debugDir = join(tmpdir(), 'omk-debug');
        try { mkdirSync(debugDir, { recursive: true }); } catch {}
        const debugFile = join(debugDir, `claude-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeFileSync(debugFile, JSON.stringify(messages, null, 2));
        process.stderr.write(`[omk] debug output → ${debugFile} (${messages.length} messages)\n`);
      } catch {}
    }

    if (resultMsgs.length === 0) {
      const durationMs = Date.now() - start;
      process.stderr.write(`[omk] claude-sdk executor: no result message received (${messages.length} messages)\n`);
      return {
        ok: false, error: 'no result message received',
        durationMs, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
      };
    }

    // Merge multiple result messages — accumulate tokens, cost, and text
    let output = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCostUSD = 0;
    let totalDurationApiMs = 0;
    let totalNumTurns = 0;
    let lastSubtype = 'success';

    for (const r of resultMsgs) {
      output += r.result || '';
      totalInputTokens += r.usage?.input_tokens || 0;
      totalOutputTokens += r.usage?.output_tokens || 0;
      totalCacheReadTokens += r.usage?.cache_read_input_tokens || 0;
      totalCacheCreationTokens += r.usage?.cache_creation_input_tokens || 0;
      totalCostUSD += r.total_cost_usd || 0;
      totalDurationApiMs += r.duration_api_ms || 0;
      totalNumTurns += r.num_turns || 0;
      lastSubtype = r.subtype || lastSubtype;
    }

    const durationMs = resultMsgs[resultMsgs.length - 1].duration_ms || (Date.now() - start);

    // Extract agent trace from intermediate messages
    const trace = extractAgentTrace(messages, messageTimestamps);

    // Error subtypes: error_max_turns, error_during_execution, error_max_budget_usd, etc.
    if (lastSubtype !== 'success') {
      const lastErr = resultMsgs[resultMsgs.length - 1];
      const errMsg = lastErr.errors?.join('; ') || lastErr.subtype;
      process.stderr.write(`[omk] claude-sdk executor: ${lastErr.subtype}: ${errMsg}\n`);
      return {
        ok: false, error: errMsg,
        durationMs,
        durationApiMs: totalDurationApiMs,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadTokens: totalCacheReadTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        costUSD: totalCostUSD,
        output: null, stopReason: 'error', numTurns: totalNumTurns,
        ...(trace.turns.length > 0 && { turns: trace.turns }),
        ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
      };
    }

    return {
      ok: true,
      durationMs,
      durationApiMs: totalDurationApiMs,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      costUSD: totalCostUSD,
      output,
      stopReason: 'end',
      numTurns: totalNumTurns,
      ...(trace.turns.length > 0 && { turns: trace.turns }),
      ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    const isAbort = details.name === 'AbortError';
    if (isAbort) {
      process.stderr.write(`[omk] claude-sdk executor: timed out after ${timeoutMs / 1000}s\n`);
    } else {
      process.stderr.write(`[omk] claude-sdk executor error: ${errorMessage(err)}\n`);
    }
    return {
      ok: false,
      error: isAbort ? `execution timed out after ${timeoutMs / 1000}s` : errorMessage(err),
      durationMs, durationApiMs: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUSD: 0, output: null,
      stopReason: isAbort ? 'timeout' : 'error',
      numTurns: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI CLI executor
// Requires: `pip install openai` (provides `openai` CLI)
// Auth: OPENAI_API_KEY environment variable
// ---------------------------------------------------------------------------

async function openaiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
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
      costUSD: 0, // OpenAI CLI does not return cost
      output: content,
      stopReason: finishReason,
      numTurns: 1,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    if (details.killed) {
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

// ---------------------------------------------------------------------------
// Gemini CLI executor
// Requires: `npm i -g @google/gemini-cli` (provides `gemini` CLI)
// Auth: Google account login or GOOGLE_API_KEY environment variable
//
// Gemini CLI is primarily interactive. We pipe the prompt via stdin
// and collect stdout as the response.
// ---------------------------------------------------------------------------

async function geminiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;

  const start = Date.now();
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const args: string[] = [];
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
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });

      child.on('error', (err: Error) => reject(err));
      child.on('close', (code: number | null) => {
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
      const data = parseJson<GeminiResponse>(output);
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
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    return {
      ok: false,
      error: errorMessage(err),
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

export function createScriptExecutor(command: string): ExecutorFn {
  return async function scriptExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
    const input = JSON.stringify({ model, system: system || '', prompt });
    const start = Date.now();

    return new Promise<ExecResult>((resolve) => {
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
      child.stdout.on('data', (d: Buffer) => { stdout += d; });
      child.stderr.on('data', (d: Buffer) => { stderr += d; });

      child.on('error', (err: Error) => {
        resolve({
          ok: false, error: `executor command failed: ${err.message}`,
          durationMs: Date.now() - start, durationApiMs: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
        });
      });

      child.on('close', (code: number | null) => {
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

async function anthropicApiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 环境变量未设置');

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

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API executor (direct HTTP, no SDK)
// Auth: OPENAI_API_KEY environment variable
// ---------------------------------------------------------------------------

async function openaiApiExecutor({ model, system, prompt, timeoutMs = DEFAULT_TIMEOUT_MS }: ExecutorInput): Promise<ExecResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 环境变量未设置');

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
