import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { ExecResult } from '../types/index.js';

export const execFileAsync = promisify(execFile);

export const DEFAULT_MODEL = 'sonnet';
export const JUDGE_MODEL = 'haiku';
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_BUFFER = 10 * 1024 * 1024;

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeCliResponse {
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: TokenUsage;
  total_cost_usd?: number;
  result?: string;
  stop_reason?: string;
  num_turns?: number;
}

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface OpenAiResponse {
  usage?: OpenAiUsage;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

export interface GeminiResponse {
  response?: string;
  stats?: { inputTokens?: number; outputTokens?: number };
}

export interface AnthropicResponse {
  usage?: TokenUsage;
  content?: Array<{ text?: string }>;
  stop_reason?: string;
  error?: { message?: string };
}

export interface ClaudeSdkQueryOptions {
  model?: string;
  systemPrompt?: string;
  cwd: string;
  permissionMode: 'bypassPermissions';
  allowDangerouslySkipPermissions: true;
  abortController: AbortController;
  env: NodeJS.ProcessEnv;
}

export interface ClaudeSdkQueryInput {
  prompt: string;
  options: ClaudeSdkQueryOptions;
}

export interface ClaudeSdkBaseMessage {
  type: string;
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
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ClaudeSdkResultMessage extends ClaudeSdkBaseMessage {
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

export interface ClaudeSdkModule {
  query: (opts: ClaudeSdkQueryInput) => AsyncIterable<ClaudeSdkBaseMessage>;
}

// Codex CLI `codex exec --json` 事件流 schema(基于 codex 0.125 实测)。
// 实测事件举例:
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"...","aggregated_output":"","exit_code":null,"status":"in_progress"}}
//   {"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
//   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{...}}
// schema 没有官方稳定文档,字段缺失静默 skip 不 throw。未来 codex schema 漂移时 fixture 测试会先红。
export interface CodexEvent {
  type?: string;
  turn_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  elapsed_ms?: number;
  stop_reason?: string;
  // item.* 事件把所有 item 数据嵌套在 item 字段下。
  // item.type 是真正的 item 类型(agent_message / command_execution / file_read / ...)
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    path?: string;
    content?: string;
    query?: string;
    results?: unknown[];
    changes?: Array<{ path?: string; kind?: string }>;
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: unknown;
    message?: string;
  };
  error?: { message?: string };
  ts?: number;
}

export interface ExecutorErrorLike {
  message?: string;
  name?: string;
  killed?: boolean;
  stdout?: string;
}

export function asErrorLike(err: unknown): ExecutorErrorLike {
  return typeof err === 'object' && err !== null ? err as ExecutorErrorLike : {};
}

export function errorMessage(err: unknown, fallback: string = 'unknown error'): string {
  const details = asErrorLike(err);
  return details.message || fallback;
}

export function parseJson<T>(content: string): T {
  return JSON.parse(content) as T;
}

export function buildExecEnv(skillDir?: string | null): NodeJS.ProcessEnv {
  const proxyUrl = process.env.CCV_PROXY_URL || undefined;
  const env: NodeJS.ProcessEnv = proxyUrl
    ? { ...process.env, ANTHROPIC_BASE_URL: proxyUrl }
    : { ...process.env };

  if (skillDir) {
    const nodeBin = join(skillDir, 'node_modules', '.bin');
    if (existsSync(nodeBin)) {
      env.PATH = `${nodeBin}${env.PATH ? delimiter + env.PATH : ''}`;
    }
  }

  return env;
}

export function timeoutExecResult(timeoutMs: number, durationMs: number): ExecResult {
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
