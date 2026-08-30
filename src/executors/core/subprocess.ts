import { spawn, type ChildProcess } from 'node:child_process';
import { MAX_BUFFER } from './limits.js';

// ===========================================================================
// SIGINT propagation：统一让 spawn 出来的 child 在 parent 收到 SIGINT 时被 kill，
// 避免 host CLI（codex / claude code）Ctrl+C 后内层子进程成为 orphan。
// ===========================================================================
//
// 设计要点：
// - 单一进程级 process.on('SIGINT', ...) listener，惰性首次 spawn 时安装一次（零 leak）
// - 模块级 Set<ChildProcess> registry，child 退出 / 出错时立即 delete
// - SIGTERM 先发（child 一般会做 telemetry flush），500ms grace，然后 SIGKILL fallback
// - handler 用具名 function + process.removeListener(self)，不动 host 自己的 listener；
//   然后 process.kill(pid, 'SIGINT') re-raise 让 default action / host listener 接管
// - shuttingDown flag：第一次 SIGINT 进 handler 后置 true，第二次按 Ctrl+C 走 default action
//   立即退出（软关 → 硬关两段式）
// - 同时支持 timeout 跟 abortSignal 两条 kill 路径，跟 SIGINT 共用 grace 逻辑

const activeChildren = new Set<ChildProcess>();
const sigintSubscribers = new Set<() => void>();
let sigintListenerInstalled = false;
let shuttingDown = false;
const SIGTERM_GRACE_MS = 500;

function broadcastShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const subscriber of sigintSubscribers) {
    try { subscriber(); } catch { /* cancellation handlers must not block shutdown */ }
  }
  for (const child of activeChildren) {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* */ }
    }, SIGTERM_GRACE_MS).unref();
  }
  // 卸载自己，re-raise SIGINT 让 host listener / default action（exit code 130）接管
  process.removeListener('SIGINT', sigintHandler);
  sigintListenerInstalled = false;
  process.kill(process.pid, 'SIGINT');
  // A host may intentionally intercept the re-raised signal. In that case the
  // process remains usable and a later child/SDK registration must reinstall
  // a functional coordinator instead of inheriting a permanently latched flag.
  setImmediate(() => {
    shuttingDown = false;
  }).unref();
}

function sigintHandler(): void {
  broadcastShutdown();
}

function ensureSigintListener(): void {
  if (sigintListenerInstalled) return;
  sigintListenerInstalled = true;
  process.on('SIGINT', sigintHandler);
}

/**
 * Register an in-process runtime (for example an SDK-owned child) with the
 * same SIGINT coordinator used by spawned executors.
 */
export function registerSigintSubscriber(subscriber: () => void): () => void {
  ensureSigintListener();
  sigintSubscribers.add(subscriber);
  return () => {
    sigintSubscribers.delete(subscriber);
  };
}

// test-only：重置模块级状态，让 vitest 之间互不污染
export function __resetSigintRegistryForTest(): void {
  activeChildren.clear();
  sigintSubscribers.clear();
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
  failureKind?: 'spawn' | 'buffer-limit' | 'timeout' | 'abort' | 'nonzero-exit';
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
  /** per-stream stdout/stderr byte limit; reject when either stream exceeds it */
  maxBuffer?: number;
  /** external abort signal; abort() 走跟 SIGINT 同一 grace 路径 */
  abortSignal?: AbortSignal;
}

/**
 * spawn child + 注册到全局 SIGINT registry。返回 { child, done } 让 caller 自己
 * 操作 stdin（写入 / 关闭），通过 done 等结果。
 *
 * 适用：claude / codex / script CLI 子进程。HTTP executor（*-api）用 fetch +
 * AbortSignal.timeout，自带 abort，不走这个。claude-sdk in-process 也不走。
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
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let bufferOverflowStream: 'stdout' | 'stderr' | null = null;
  let killedByTimeout = false;
  let killedBySignalReason: NodeJS.Signals | null = null;
  let graceTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  function killWithGrace(reason: 'timeout' | 'abort' | 'buffer'): void {
    // 优先级：abort 跟 timeout 互不覆盖（谁先设谁赢）；buffer 不重写已有 reason
    if (reason === 'timeout' && !killedBySignalReason) killedByTimeout = true;
    if (reason === 'abort' && !killedByTimeout) killedBySignalReason = 'SIGTERM';
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    if (graceTimer) return;
    // 即使 child trap SIGTERM 不退出，500ms 后强 SIGKILL 兜底
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
    if (abortSignal.aborted) {
      // Defer until `done` has installed the child close/error listeners below.
      queueMicrotask(abortListener);
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    if (bufferOverflowStream) return;
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > maxBuffer) {
      bufferOverflowStream = 'stdout';
      killWithGrace('buffer');
      return;
    }
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (bufferOverflowStream) return;
    stderrBytes += chunk.byteLength;
    if (stderrBytes > maxBuffer) {
      bufferOverflowStream = 'stderr';
      killWithGrace('buffer');
      return;
    }
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
      e.failureKind = 'spawn';
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
      // Buffer overflow is authoritative: truncated output is not valid evidence,
      // even if the child catches SIGTERM and later exits 0.
      if (bufferOverflowStream) {
        const e = Object.assign(
          new Error(`${bufferOverflowStream} maxBuffer (${maxBuffer} bytes) exceeded`),
          result,
          { failureKind: 'buffer-limit' as const },
        ) as SpawnHelperError;
        reject(e);
        return;
      }
      // Deadline / cancellation are caller-side facts. A child may catch
      // SIGTERM, flush partial output and exit 0, but that cannot retroactively
      // turn an over-budget or cancelled evaluation into a successful sample.
      if (killedByTimeout) {
        const tSec = timeoutMs ? (timeoutMs / 1000).toFixed(0) : '?';
        const e = Object.assign(
          new Error(`execution timed out after ${tSec}s`),
          result,
          { failureKind: 'timeout' as const },
        ) as SpawnHelperError;
        reject(e);
        return;
      }
      if (killedSig) {
        const e = Object.assign(
          new Error(`execution interrupted by signal ${killedSig}`),
          result,
          { failureKind: 'abort' as const },
        ) as SpawnHelperError;
        reject(e);
        return;
      }
      if (code === 0) {
        resolve(result);
        return;
      }
      if (code !== null) {
        const e = Object.assign(
          new Error(`${command} exited with code ${code}`),
          result,
          { failureKind: 'nonzero-exit' as const },
        ) as SpawnHelperError;
        reject(e);
        return;
      }
      // code === null && signal === null：罕见，fallback resolve
      resolve(result);
    });
  });

  return { child, done };
}
