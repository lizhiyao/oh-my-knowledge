import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ExecResult, ExecutorFn, ExecutorInput } from '../types/index.js';
import {
  DEFAULT_TIMEOUT_MS,
  interruptedExecResult,
  spawnWithSigintPropagation,
  timeoutExecResult,
  type SpawnHelperError,
} from './shared.js';

// script executor 由用户自定义,omk 无法保证它实现 skill 隔离。
// 任何 allowedSkills(包括 [])下都 stderr 一次性 warn,不阻塞执行,
// 让用户知道 strict-baseline / 显式 allowedSkills 在 script executor 下静默无效。
let scriptIsolationWarned = false;

function resolveExecutorPath(part: string, baseCwd: string): string {
  if (isAbsolute(part)) return part;
  if (!part.includes('/') && !part.startsWith('.')) return part;
  const candidate = resolve(baseCwd, part);
  return existsSync(candidate) ? candidate : part;
}

export function createScriptExecutor(command: string): ExecutorFn {
  const baseCwd = process.cwd();
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [command];
  const cmd = resolveExecutorPath(parts[0].replace(/^["']|["']$/g, ''), baseCwd);
  const args = parts.slice(1)
    .map((a) => a.replace(/^["']|["']$/g, ''))
    .map((a) => resolveExecutorPath(a, baseCwd));

  return async function scriptExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills }: ExecutorInput): Promise<ExecResult> {
    if (allowedSkills !== undefined && !scriptIsolationWarned) {
      scriptIsolationWarned = true;
      process.stderr.write(
        `[omk] script executor 不参与 skill isolation:allowedSkills=${JSON.stringify(allowedSkills)} 在自定义 executor "${command}" 下无效。\n`
        + `  如需 baseline 真正隔离,请用 --executor claude-sdk(或 claude-cli degraded mode)。\n`,
      );
    }
    const input = JSON.stringify({ model, system: system || '', prompt });
    const start = Date.now();

    const { child, done } = spawnWithSigintPropagation(cmd, args, {
      env: { ...process.env },
      timeoutMs,
      ...(cwd && { cwd }),
    });
    child.stdin?.write(input);
    child.stdin?.end();

    try {
      const r = await done;
      const durationMs = Date.now() - start;
      try {
        const data = JSON.parse(r.stdout);
        return {
          ok: true, output: data.output || '', durationMs,
          durationApiMs: data.durationApiMs || 0,
          inputTokens: data.inputTokens || 0, outputTokens: data.outputTokens || 0,
          cacheReadTokens: data.cacheReadTokens || 0, cacheCreationTokens: data.cacheCreationTokens || 0,
          costUSD: data.costUSD || 0, stopReason: data.stopReason || 'end', numTurns: data.numTurns || 1,
        };
      } catch {
        return {
          ok: true, output: r.stdout.trim(), durationMs, durationApiMs: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          costUSD: 0, stopReason: 'end', numTurns: 1,
        };
      }
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const details = err as SpawnHelperError;
      if (details.killedByTimeout) return timeoutExecResult(timeoutMs, durationMs);
      if (details.killedBySignal) return interruptedExecResult(durationMs);
      const stderr = (details.stderr || '').trim();
      return {
        ok: false,
        error: stderr || details.message || `executor exited with code ${details.code ?? '?'}`,
        durationMs, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
      };
    }
  };
}
