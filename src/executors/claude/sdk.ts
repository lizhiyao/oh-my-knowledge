import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ExecResult, ExecutorInput } from '../../types/index.js';
import type { ClaudeSdkBaseMessage, ClaudeSdkModule } from './protocol.js';
import { DEFAULT_TIMEOUT_MS } from '../core/defaults.js';
import {
  asErrorLike,
  buildExecEnv,
  errorMessage,
  interruptedExecResult,
  timeoutExecResult,
} from '../core/runtime.js';
import { registerSigintSubscriber } from '../core/subprocess.js';
import { buildSdkHookCallback } from '../../eval-core/mocks-runtime.js';
import { buildClaudeResult } from './protocol.js';

export { normalizeClaudeSdkMeasurements } from './protocol.js';

let sdkQuery: ClaudeSdkModule['query'] | null = null;

/**
 * Map ExecutorInput.allowedSkills to SDK query options for skill isolation.
 *   undefined → {} (SDK default: full ~/.claude/skills/ discovery)
 *   []        → { skills: [], disallowedTools: ['Skill'] } (main session + subagent 双堵)
 *   [...]     → throw(非空 skill 白名单不再支持:它从不能真隔离 —— 主会话 skill 发现虽被
 *               `skills:[...]` 收窄,但子代理 Skill 工具与 cwd 文件系统两条 channel 封不住,
 *               会产出看着干净、实则被白名单外 skill 污染的报告。隔离只留两档:undefined
 *               (不隔离)与 [](全封死),与 claude-cli / codex-cli 一致;多 skill 组合实验
 *               请控制评测环境而非靠白名单。)
 *
 * Exported for unit tests to lock the option-shape contract.
 */
export function buildSdkIsolationOptions(allowedSkills: string[] | undefined): {
  skills?: string[];
  disallowedTools?: string[];
} {
  if (allowedSkills === undefined) return {};
  if (allowedSkills.length === 0) return { skills: allowedSkills, disallowedTools: ['Skill'] };
  throw new Error(
    `skill 白名单(allowedSkills=${JSON.stringify(allowedSkills)})不再支持:非空白名单无法真正隔离`
    + `(子代理 Skill 工具 + cwd 文件系统两条 channel 封不住)。仅支持 [](全封死)或 undefined(不隔离)。`,
  );
}

async function getSdkQuery(): Promise<ClaudeSdkModule['query']> {
  if (!sdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk') as ClaudeSdkModule;
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

export async function claudeSdkExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, verbose = false, allowedSkills, mocks, mocksBaseDir, mocksStrict, lean, effort }: ExecutorInput): Promise<ExecResult> {
  // 隔离选项在 timer / try 之前解析:非空 allowedSkills(不再支持的 skill 白名单)必须在这里
  // fail-fast 抛错,而不是被下面的 catch 吞成 ok:false 的 ExecResult(那会把配置错误伪装成
  // 每个 sample 执行失败、产出全失败报告,与 claude-cli / codex 的硬抛口径不一致)。lean 仍
  // 覆盖为硬堵,但 buildSdkIsolationOptions 先跑一遍,故 lean 也无法绕过非空校验。
  const baseIsolationOpts = buildSdkIsolationOptions(allowedSkills);
  const isolationOpts = lean ? { skills: [] as string[], disallowedTools: ['*'] } : baseIsolationOpts;
  const start = Date.now();
  const abortController = new AbortController();
  let abortReason: 'timeout' | 'interrupted' | undefined;
  const abort = (reason: NonNullable<typeof abortReason>): void => {
    if (abortReason) return;
    abortReason = reason;
    abortController.abort();
  };
  const timer = setTimeout(() => abort('timeout'), timeoutMs);
  const unregisterSigint = registerSigintSubscriber(() => abort('interrupted'));

  const env = buildExecEnv(skillDir);

  const messages: ClaudeSdkBaseMessage[] = [];
  const messageTimestamps: number[] = [];

  // mock 注入:in-process PreToolUse hook,无 spawn / 无文件 IO,跑完就消失。
  const hookHandle = mocks && mocks.length > 0
    ? buildSdkHookCallback(mocks, mocksBaseDir, !!mocksStrict)
    : null;
  const hooksOpts = hookHandle
    ? { hooks: { PreToolUse: [{ hooks: [hookHandle.callback] }] } as Record<string, unknown> }
    : {};
  const mockStatsOf = (): ExecResult['mockStats'] | undefined => hookHandle ? { ...hookHandle.stats } : undefined;

  try {
    const query = await getSdkQuery();
    // effort:lean 强制 'low'(生成路径不需要思考),否则透传调用方传入。
    // SDK 暴露 EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max',直接对应。
    const effectiveEffort = lean ? 'low' : effort;
    const effortOpts = effectiveEffort ? { effort: effectiveEffort } : {};
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
        ...isolationOpts,
        ...effortOpts,
        ...hooksOpts,
      },
    });

    for await (const msg of stream) {
      messages.push(msg);
      messageTimestamps.push(Date.now());
    }

    if (verbose) {
      try {
        const debugDir = join(tmpdir(), 'omk-debug');
        try { mkdirSync(debugDir, { recursive: true }); } catch { }
        const debugFile = join(debugDir, `claude-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeFileSync(debugFile, JSON.stringify(messages, null, 2));
        process.stderr.write(`[omk] debug output → ${debugFile} (${messages.length} messages)\n`);
      } catch { }
    }

    return {
      ...buildClaudeResult({
        messages,
        messageTimestamps,
        wallClockDurationMs: Date.now() - start,
        source: 'claude-sdk',
      }),
      ...(mockStatsOf() && { mockStats: mockStatsOf()! }),
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    const isAbort = details.name === 'AbortError';
    if (abortReason === 'interrupted') {
      return {
        ...interruptedExecResult(durationMs),
        ...(mockStatsOf() && { mockStats: mockStatsOf()! }),
      };
    }
    if (abortReason === 'timeout') {
      return {
        ...timeoutExecResult(timeoutMs, durationMs),
        ...(mockStatsOf() && { mockStats: mockStatsOf()! }),
      };
    }
    if (isAbort) {
      process.stderr.write('[omk] claude-sdk executor: execution aborted\n');
    } else {
      process.stderr.write(`[omk] claude-sdk executor error: ${errorMessage(err)}\n`);
    }
    return {
      ok: false,
      error: isAbort ? 'claude-sdk execution aborted' : errorMessage(err),
      durationMs, durationApiMs: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      tokenUsageReportedByExecutor: false,
      costUSD: 0, costReportedByExecutor: false, output: null,
      stopReason: 'error',
      numTurns: 0,
      ...(mockStatsOf() && { mockStats: mockStatsOf()! }),
    };
  } finally {
    clearTimeout(timer);
    unregisterSigint();
  }
}
