import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ExecResult } from '../contracts/result.js';

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
    tokenUsageReportedByExecutor: false,
    costUSD: 0,
    costReportedByExecutor: false,
    output: null,
    stopReason: 'timeout',
    numTurns: 0,
  };
}

// SIGINT-killed child（用户在 host 按 Ctrl+C，parent 收到 SIGINT 后广播 SIGTERM 给 children）
// 跟 timeout-killed 区分：stopReason='interrupted'，跟 'timeout' / 'error' 都不一样，
// caller / renderer 可以据此显示不同的语义（"用户中断" vs "超时" vs "执行错误"）。
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
    tokenUsageReportedByExecutor: false,
    costUSD: 0,
    costReportedByExecutor: false,
    output: null,
    stopReason: 'interrupted',
    numTurns: 0,
  };
}
