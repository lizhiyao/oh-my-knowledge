import { execFile, spawn, type ChildProcess } from 'node:child_process';
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

// SIGINT-killed child(用户在 host 按 Ctrl+C,parent 收到 SIGINT 后广播 SIGTERM 给 children)
// 跟 timeout-killed 区分:stopReason='interrupted',跟 'timeout' / 'error' 都不一样,
// caller / renderer 可以据此显示不同的语义("用户中断" vs "超时" vs "执行错误")。
export function interruptedExecResult(durationMs: number): ExecResult {
  return {
    ok: false,
    error: 'execution interrupted (SIGINT)',
    durationMs,
    durationApiMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    output: null,
    stopReason: 'interrupted',
    numTurns: 0,
  };
}

// ===========================================================================
// SIGINT propagation:统一让 spawn 出来的 child 在 parent 收到 SIGINT 时被 kill,
// 避免 host CLI(codex / claude code)Ctrl+C 后内层子进程成为 orphan。
// ===========================================================================
//
// 设计要点:
// - 单一进程级 process.on('SIGINT', ...) listener,惰性首次 spawn 时安装一次(零 leak)
// - 模块级 Set<ChildProcess> registry,child 退出 / 出错时立即 delete
// - SIGTERM 先发(child 一般会做 telemetry flush),500ms grace,然后 SIGKILL fallback
// - handler 用具名 function + process.removeListener(self),不动 host 自己的 listener;
//   然后 process.kill(pid, 'SIGINT') re-raise 让 default action / host listener 接管
// - shuttingDown flag:第一次 SIGINT 进 handler 后置 true,第二次按 Ctrl+C 走 default action
//   立即退出(软关 → 硬关两段式)
// - 同时支持 timeout 跟 abortSignal 两条 kill 路径,跟 SIGINT 共用 grace 逻辑

const activeChildren = new Set<ChildProcess>();
let sigintListenerInstalled = false;
let shuttingDown = false;
const SIGTERM_GRACE_MS = 500;

function broadcastShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of activeChildren) {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* */ }
    }, SIGTERM_GRACE_MS).unref();
  }
  // 卸载自己,re-raise SIGINT 让 host listener / default action(exit code 130)接管
  process.removeListener('SIGINT', sigintHandler);
  process.kill(process.pid, 'SIGINT');
}

function sigintHandler(): void {
  broadcastShutdown();
}

function ensureSigintListener(): void {
  if (sigintListenerInstalled) return;
  sigintListenerInstalled = true;
  process.on('SIGINT', sigintHandler);
}

// test-only:重置模块级状态,让 vitest 之间互不污染
export function __resetSigintRegistryForTest(): void {
  activeChildren.clear();
  if (sigintListenerInstalled) {
    process.removeListener('SIGINT', sigintHandler);
    sigintListenerInstalled = false;
  }
  shuttingDown = false;
}

export interface SpawnHelperResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killedByTimeout: boolean;
  killedBySignal: NodeJS.Signals | null;
}

export interface SpawnHelperError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  killedByTimeout?: boolean;
  killedBySignal?: NodeJS.Signals | null;
}

export interface SpawnHelperOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** kill child after this many ms; reject with killedByTimeout=true */
  timeoutMs?: number;
  /** stdout overflow threshold; reject when累计超限 */
  maxBuffer?: number;
  /** external abort signal; abort() 走跟 SIGINT 同一 grace 路径 */
  abortSignal?: AbortSignal;
}

/**
 * spawn child + 注册到全局 SIGINT registry。返回 { child, done } 让 caller 自己
 * 操作 stdin(写入 / 关闭),通过 done 等结果。
 *
 * 适用:claude / codex / gemini / script CLI 子进程。HTTP executor(*-api)用 fetch +
 * AbortSignal.timeout,自带 abort,不走这个。claude-sdk in-process 也不走。
 */
export function spawnWithSigintPropagation(
  command: string,
  args: string[],
  options: SpawnHelperOptions = {},
): { child: ChildProcess; done: Promise<SpawnHelperResult> } {
  const { cwd, env, timeoutMs, maxBuffer = MAX_BUFFER, abortSignal } = options;
  ensureSigintListener();

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(cwd && { cwd }),
    ...(env && { env }),
  });

  activeChildren.add(child);

  let stdout = '';
  let stderr = '';
  let bufferOverflow = false;
  let killedByTimeout = false;
  let killedBySignalReason: NodeJS.Signals | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  function killWithGrace(reason: 'timeout' | 'abort' | 'buffer'): void {
    // 优先级:abort 跟 timeout 互不覆盖(谁先设谁赢);buffer 不重写已有 reason
    if (reason === 'timeout' && !killedBySignalReason) killedByTimeout = true;
    if (reason === 'abort' && !killedByTimeout) killedBySignalReason = 'SIGTERM';
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    if (graceTimer) return;
    // 即使 child trap SIGTERM 不退出,500ms 后强 SIGKILL 兜底
    graceTimer = setTimeout(() => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* */ }
    }, SIGTERM_GRACE_MS);
    graceTimer.unref();
  }

  if (timeoutMs && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => killWithGrace('timeout'), timeoutMs);
    timeoutTimer.unref();
  }

  let abortListener: (() => void) | null = null;
  if (abortSignal) {
    abortListener = (): void => killWithGrace('abort');
    abortSignal.addEventListener('abort', abortListener, { once: true });
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.length > maxBuffer && !bufferOverflow) {
      bufferOverflow = true;
      // 走 killWithGrace 保证 SIGTERM trap child 也会被 500ms 后 SIGKILL 兜底
      killWithGrace('buffer');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  function cleanup(): void {
    activeChildren.delete(child);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (abortListener && abortSignal) abortSignal.removeEventListener('abort', abortListener);
  }

  const done = new Promise<SpawnHelperResult>((resolve, reject) => {
    child.on('error', (err: Error) => {
      cleanup();
      const e = err as SpawnHelperError;
      e.stdout = stdout;
      e.stderr = stderr;
      reject(e);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const killedSig: NodeJS.Signals | null = killedBySignalReason
        || (signal && !killedByTimeout ? signal : null);
      const result: SpawnHelperResult = {
        stdout, stderr, code, signal,
        killedByTimeout,
        killedBySignal: killedSig,
      };
      // bufferOverflow 优先 — 数据已截断不可信,即使 child 后来 exit 0 也不能用
      if (bufferOverflow) {
        const e = Object.assign(new Error(`stdout maxBuffer (${maxBuffer}) exceeded`), result) as SpawnHelperError;
        reject(e);
        return;
      }
      // **code === 0 时 child 是干净完成的**:即使我们前面发了 SIGTERM(timeout / abort),
      // child 可能 trap 信号并 graceful exit 0 完成数据写入。这种情况 stdout 是完整的,
      // 不应该当 timeout / signal 错误 reject。优先级:exit 0 > 任何 kill reason。
      if (code === 0) {
        resolve(result);
        return;
      }
      if (killedByTimeout) {
        const tSec = timeoutMs ? (timeoutMs / 1000).toFixed(0) : '?';
        const e = Object.assign(new Error(`execution timed out after ${tSec}s`), result) as SpawnHelperError;
        reject(e);
        return;
      }
      if (killedSig) {
        const e = Object.assign(new Error(`execution interrupted by signal ${killedSig}`), result) as SpawnHelperError;
        reject(e);
        return;
      }
      if (code !== null) {
        const e = Object.assign(new Error(`${command} exited with code ${code}`), result) as SpawnHelperError;
        reject(e);
        return;
      }
      // code === null && signal === null:罕见,fallback resolve
      resolve(result);
    });
  });

  return { child, done };
}
