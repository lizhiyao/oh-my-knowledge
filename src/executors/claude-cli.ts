import type { ExecResult, ExecutorInput } from '../types/index.js';
import { extractAgentTrace, isClaudeSdkResultMessage } from './claude-sdk-trace.js';
import type { ClaudeSdkBaseMessage, ClaudeSdkResultMessage } from './shared.js';
import {
  buildExecEnv,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  interruptedExecResult,
  MAX_BUFFER,
  spawnWithSigintPropagation,
  timeoutExecResult,
  type SpawnHelperError,
} from './shared.js';
import { materializeForCliConfigDir } from '../eval-core/mocks-runtime.js';

// claude CLI 用 `--disable-slash-commands` (文档:"Disable all skills") +
// `--disallowedTools Skill` 实现与 SDK 等价的完全隔离。但 CLI 没有 partial whitelist
// 的 flag,所以 [name1, ...] 必须 throw。
//
//   undefined           → 不传任何 flag(原行为,全发现)
//   []                  → --disable-slash-commands + --disallowedTools Skill
//                         (main session skill discovery + subagent Skill 工具调用都堵)
//   [...] (length > 0)  → throw,提示用 claude-sdk executor 走精准白名单

function applySkillIsolationToCliArgs(args: string[], allowedSkills: string[] | undefined): void {
  if (allowedSkills === undefined) return;
  if (allowedSkills.length > 0) {
    throw new Error(
      `claude-cli executor 不支持 partial skill 白名单(allowedSkills=${JSON.stringify(allowedSkills)})。\n`
      + `  仅支持 [](映射为 --disable-slash-commands + --disallowedTools Skill)或 undefined(默认)。\n`
      + `  精确白名单请改用 --executor claude-sdk(SDK skills option pass-through)。`,
    );
  }
  // 完全隔离:双堵 main session skill 发现 + subagent Skill 工具
  args.push('--disable-slash-commands', '--disallowedTools', 'Skill');
}

function parseStreamJson(stdout: string): ClaudeSdkBaseMessage[] {
  const messages: ClaudeSdkBaseMessage[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as ClaudeSdkBaseMessage);
    } catch { /* skip non-JSON lines */ }
  }
  return messages;
}

export async function claudeCliExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, mocks, mocksBaseDir, mocksStrict, lean, effort }: ExecutorInput): Promise<ExecResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model,
    // 评测必须 bypass permission,否则 Bash / Edit / Write 等工具调用会卡在交互式确认。
    // sdk executor 用 options.permissionMode='bypassPermissions',cli 用此 flag 等价。
    '--permission-mode', 'bypassPermissions'];
  if (system) args.push('--system-prompt', system);
  // effort 决策:
  //   - lean=true(纯文本生成):默认 'low',但允许调用方显式覆盖(如 doctor 对大 skill 需要 'medium')。
  //   - 否则用调用方传入的 effort,或 sonnet 默认(不传 flag = claude CLI 自己定)。
  const effectiveEffort = lean ? (effort ?? 'low') : effort;
  if (lean) {
    args.push('--allowedTools', '', '--disable-slash-commands');
  }
  if (effectiveEffort) {
    args.push('--effort', effectiveEffort);
  }
  applySkillIsolationToCliArgs(args, allowedSkills);

  const env = buildExecEnv(skillDir);

  // mock 注入:mktemp 临时 settings.json,通过 `claude --settings <file>` 追加(不覆盖 ~/.claude/)
  // 这样 OAuth 登录态 / 用户主配置全部保留,只往里加 PreToolUse hook。
  // 跑完(成功/失败/超时/abort)cleanup 必删整个临时目录。
  const mockHandle = mocks && mocks.length > 0
    ? materializeForCliConfigDir(mocks, mocksBaseDir, !!mocksStrict)
    : null;
  if (mockHandle) {
    args.push('--settings', mockHandle.settingsFile);
    if (mockHandle.mcpConfigFile) {
      args.push('--mcp-config', mockHandle.mcpConfigFile, '--strict-mcp-config');
    }
    Object.assign(env, mockHandle.env);
  }
  const captureMockStats = (): ExecResult['mockStats'] | undefined => {
    if (!mockHandle) return undefined;
    try { return mockHandle.readStats(); } catch { return undefined; }
  };

  const start = Date.now();
  try {
    const { child, done } = spawnWithSigintPropagation('claude', args, {
      maxBuffer: MAX_BUFFER,
      timeoutMs,
      env,
      ...(cwd && { cwd }),
    });
    // claude binary 不读 stdin(prompt 走 -p flag),关掉避免 codex 那种 pipe 卡死风险
    child.stdin?.end();
    const { stdout } = await done;
    const durationMs = Date.now() - start;
    const messages = parseStreamJson(stdout);

    // 提取 result 消息
    const resultMsgs = messages.filter(isClaudeSdkResultMessage) as ClaudeSdkResultMessage[];
    if (resultMsgs.length === 0) {
      const ms = captureMockStats();
      return {
        ok: false, error: 'no result message in stream-json output',
        durationMs, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
        ...(ms && { mockStats: ms }),
      };
    }

    const last = resultMsgs[resultMsgs.length - 1];
    const usage = last.usage || {};

    // 提取 trace
    const trace = extractAgentTrace(messages);

    const ms = captureMockStats();
    return {
      ok: !last.errors?.length && last.subtype !== 'error',
      durationMs: last.duration_ms || durationMs,
      durationApiMs: last.duration_api_ms || 0,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      costUSD: last.total_cost_usd || 0,
      output: last.result || '',
      stopReason: last.subtype || 'unknown',
      numTurns: last.num_turns || 1,
      fullNumTurns: trace.fullNumTurns,
      numSubAgents: trace.numSubAgents,
      ...(trace.turns.length > 0 && { turns: trace.turns }),
      ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
      ...(ms && { mockStats: ms }),
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = err as SpawnHelperError;
    if (details.killedByTimeout) {
      const ms = captureMockStats();
      return { ...timeoutExecResult(timeoutMs, durationMs), ...(ms && { mockStats: ms }) };
    }
    if (details.killedBySignal) {
      const ms = captureMockStats();
      return { ...interruptedExecResult(durationMs), ...(ms && { mockStats: ms }) };
    }

    // 尝试从 stdout 解析 stream-json(即使进程退出码非 0 也可能有 result)
    const messages = parseStreamJson(details.stdout || '');
    const resultMsgs = messages.filter(isClaudeSdkResultMessage) as ClaudeSdkResultMessage[];
    if (resultMsgs.length > 0) {
      const last = resultMsgs[resultMsgs.length - 1];
      const usage = last.usage || {};
      const trace = extractAgentTrace(messages);
      const ms = captureMockStats();
      return {
        ok: false,
        error: last.errors?.join('; ') || last.result || errorMessage(err),
        durationMs: last.duration_ms || durationMs,
        durationApiMs: last.duration_api_ms || 0,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
        costUSD: last.total_cost_usd || 0,
        output: last.result || null,
        stopReason: 'error',
        numTurns: last.num_turns || 0,
        fullNumTurns: trace.fullNumTurns,
        numSubAgents: trace.numSubAgents,
        ...(trace.turns.length > 0 && { turns: trace.turns }),
        ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
        ...(ms && { mockStats: ms }),
      };
    }

    const ms = captureMockStats();
    return {
      ok: false,
      error: errorMessage(err),
      durationMs, durationApiMs: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
      ...(ms && { mockStats: ms }),
    };
  } finally {
    // mock 注入路径:无论 try 走哪条出口,cleanup 必删临时 CLAUDE_CONFIG_DIR
    mockHandle?.cleanup();
  }
}
