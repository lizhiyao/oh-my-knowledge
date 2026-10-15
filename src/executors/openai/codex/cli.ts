import { buildCodexExecArguments } from './cli-arguments.js';
import type { ExecResult } from '../../contracts/result.js';
import type { ExecutorInput } from '../../contracts/ports.js';
import {
  buildCodexResult,
  normalizeCodexProtocolEvent,
  type CodexEvent,
} from './protocol.js';
import { DEFAULT_TIMEOUT_MS, MAX_BUFFER } from '../../core/limits.js';
import {
  buildExecEnv,
  errorMessage,
  interruptedExecResult,
  timeoutExecResult,
} from '../../core/runtime.js';
import { spawnWithSigintPropagation, type SpawnHelperError } from '../../core/subprocess.js';

export {
  extractCodexFinalOutput,
  extractCodexProtocolError,
  extractCodexStopReason,
  extractCodexUsage,
  sumCodexElapsed,
} from './protocol.js';

// An empty cwd cannot disable user, admin or bundled skills outside that workspace.
// Auxiliary calls may use runtime defaults; explicit isolation must fail closed.
export function assertCodexSkillDiscovery(allowedSkills: string[] | undefined, executorName = 'codex-cli'): void {
  if (allowedSkills === undefined) return;
  throw new Error(`${executorName} 不支持显式 allowedSkills 隔离；空工作目录不能禁用全局或内置 skills。`
    + '请省略该字段使用运行时默认上下文；严格 baseline 请使用可禁用发现的运行时（如 openai-api）。');
}

// codex 的 verbose 降级提示是 binary 能力快照(无 --system-prompt flag / 不报 cost),
// 不会逐次调用变化。executor 在 sample × variant × judge_repeat × dimension 多次被调,
// 每次都打两行会让 stderr 被同样文本刷屏(140-280 行)。模块级 flag 一个 process 只打一次。
let hasWarnedSystem = false;
let hasWarnedCost = false;

export interface CodexJsonlParseResult {
  events: CodexEvent[];
  malformedLineCount: number;
}

export function parseCodexJsonl(stdout: string): CodexJsonlParseResult {
  const events: CodexEvent[] = [];
  let malformedLineCount = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        malformedLineCount += 1;
        continue;
      }
      const event = normalizeCodexProtocolEvent(value);
      if (
        !event
        || typeof event.type !== 'string'
        || event.type.trim() === ''
        || (
          event.type.startsWith('item.')
          && (
            !event.item
            || typeof event.item.type !== 'string'
            || event.item.type.trim() === ''
          )
        )
      ) {
        malformedLineCount += 1;
        continue;
      }
      events.push(event);
    } catch {
      malformedLineCount += 1;
    }
  }
  return { events, malformedLineCount };
}

/** Invocation policy for non-Trial callers such as generation and judge calls. */
export function buildCodexArgs({ model, cwd, prompt, effort }: Pick<ExecutorInput, 'model' | 'cwd' | 'prompt' | 'effort'>): string[] {
  return buildCodexExecArguments({
    ...(model ? { model } : {}),
    ...(cwd ? { workingDirectory: cwd } : {}),
    prompt,
    sandbox: 'read-only',
    strictConfig: false,
    ...(effort === undefined ? {} : { effort }),
  });
}

// codex 看到 stdin 是 pipe 就当作 `<stdin>` 块读,会卡到 timeout。spawn 后立刻
// child.stdin.end() 发 EOF。SIGINT 传播 / timeout / maxBuffer / kill 由 helper 统一处理。
function runCodexExec(args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; timeout: number; maxBuffer: number; abortSignal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  const { child, done } = spawnWithSigintPropagation('codex', args, {
    env: options.env,
    cwd: options.cwd,
    timeoutMs: options.timeout,
    maxBuffer: options.maxBuffer,
    abortSignal: options.abortSignal,
  });
  child.stdin?.end();
  return done.then((r) => ({ stdout: r.stdout, stderr: r.stderr }));
}

export async function codexCliExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, verbose, abortSignal, effort }: ExecutorInput, environment: NodeJS.ProcessEnv = process.env): Promise<ExecResult> {
  assertCodexSkillDiscovery(allowedSkills);

  // codex CLI 没有 --system-prompt flag。降级:把 system 拼到 prompt 头部,
  // verbose 输出降级提示。reproducibility 略受影响,但语义大致等价。
  const finalPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  if (system && verbose && !hasWarnedSystem) {
    process.stderr.write('[codex] system prompt prepended (codex CLI lacks --system-prompt flag)\n');
    hasWarnedSystem = true;
  }
  if (verbose && !hasWarnedCost) {
    process.stderr.write('[codex] cost not reported by binary; costReportedByExecutor=false (renderer shows 「—」 instead of $0.0000)\n');
    hasWarnedCost = true;
  }

  const args = buildCodexArgs({ model, cwd, prompt: finalPrompt, effort });
  const env = buildExecEnv(skillDir, environment);

  const start = Date.now();
  try {
    const { stdout } = await runCodexExec(args, {
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env,
      abortSignal,
      ...(cwd && { cwd }),
    });
    const durationMs = Date.now() - start;
    const parsed = parseCodexJsonl(stdout);
    return buildCodexResult({
      events: parsed.events,
      wallClockDurationMs: durationMs,
      source: 'codex --json',
      malformedLineCount: parsed.malformedLineCount,
    });
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = err as SpawnHelperError;
    if (details.failureKind !== 'buffer-limit' && details.killedByTimeout) return { ...timeoutExecResult(timeoutMs, durationMs), costReportedByExecutor: false };
    if (details.failureKind !== 'buffer-limit' && details.killedBySignal) return { ...interruptedExecResult(durationMs), costReportedByExecutor: false };

    // 失败路径仍保留已完成的事件、用量与 trace，但不能反转为成功。
    const parsed = parseCodexJsonl(details.stdout || '');
    return buildCodexResult({
      events: parsed.events,
      wallClockDurationMs: durationMs,
      source: 'codex --json',
      malformedLineCount: parsed.malformedLineCount,
      forcedError: details.failureKind === 'buffer-limit' ? details.message : details.stderr?.trim() || errorMessage(err),
    });
  }
}
