import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ExecResult, ExecutorInput } from '../types/index.js';
import { extractAgentTrace, isClaudeSdkResultMessage } from './claude-sdk-trace.js';
import type { ClaudeSdkBaseMessage, ClaudeSdkModule, ClaudeSdkResultMessage } from './shared.js';
import { asErrorLike, buildExecEnv, DEFAULT_TIMEOUT_MS, errorMessage } from './shared.js';
import { buildSdkHookCallback } from '../eval-core/mocks-runtime.js';

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
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

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

    const resultMsgs: ClaudeSdkResultMessage[] = [];
    for await (const msg of stream) {
      messages.push(msg);
      messageTimestamps.push(Date.now());
      if (isClaudeSdkResultMessage(msg)) resultMsgs.push(msg as ClaudeSdkResultMessage);
    }

    clearTimeout(timer);

    if (verbose) {
      try {
        const debugDir = join(tmpdir(), 'omk-debug');
        try { mkdirSync(debugDir, { recursive: true }); } catch { }
        const debugFile = join(debugDir, `claude-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeFileSync(debugFile, JSON.stringify(messages, null, 2));
        process.stderr.write(`[omk] debug output → ${debugFile} (${messages.length} messages)\n`);
      } catch { }
    }

    if (resultMsgs.length === 0) {
      const durationMs = Date.now() - start;
      process.stderr.write(`[omk] claude-sdk executor: no result message received (${messages.length} messages)\n`);
      return {
        ok: false, error: 'no result message received',
        durationMs, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
        ...(mockStatsOf() && { mockStats: mockStatsOf()! }),
      };
    }

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
      // Prefer modelUsage (includes subAgent tokens) over usage (main process only)
      const modelUsage = (r as unknown as Record<string, unknown>).modelUsage as Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> | undefined;
      if (modelUsage) {
        for (const mu of Object.values(modelUsage)) {
          totalInputTokens += mu.inputTokens || 0;
          totalOutputTokens += mu.outputTokens || 0;
          totalCacheReadTokens += mu.cacheReadInputTokens || 0;
          totalCacheCreationTokens += mu.cacheCreationInputTokens || 0;
        }
      } else {
        totalInputTokens += r.usage?.input_tokens || 0;
        totalOutputTokens += r.usage?.output_tokens || 0;
        totalCacheReadTokens += r.usage?.cache_read_input_tokens || 0;
        totalCacheCreationTokens += r.usage?.cache_creation_input_tokens || 0;
      }
      totalCostUSD += r.total_cost_usd || 0;
      totalDurationApiMs += r.duration_api_ms || 0;
      totalNumTurns += r.num_turns || 0;
      lastSubtype = r.subtype || lastSubtype;
    }

    const durationMs = resultMsgs[resultMsgs.length - 1].duration_ms || (Date.now() - start);
    const trace = extractAgentTrace(messages, messageTimestamps);

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
        fullNumTurns: trace.fullNumTurns,
        numSubAgents: trace.numSubAgents,
        ...(trace.turns.length > 0 && { turns: trace.turns }),
        ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
        ...(mockStatsOf() && { mockStats: mockStatsOf()! }),
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
      fullNumTurns: trace.fullNumTurns,
      numSubAgents: trace.numSubAgents,
      ...(trace.turns.length > 0 && { turns: trace.turns }),
      ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
      ...(mockStatsOf() && { mockStats: mockStatsOf()! }),
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
      ...(mockStatsOf() && { mockStats: mockStatsOf()! }),
    };
  }
}
