import type { ExecResult, ExecutorInput } from '../../../types/index.js';
import { materializeForCliConfigDir } from '../../../eval-core/mocks-runtime.js';
import { buildClaudeResult, parseClaudeStreamJson } from './protocol.js';
import { DEFAULT_TIMEOUT_MS, MAX_BUFFER } from '../../core/limits.js';
import {
  buildExecEnv,
  errorMessage,
  interruptedExecResult,
  timeoutExecResult,
} from '../../core/runtime.js';
import { spawnWithSigintPropagation, type SpawnHelperError } from '../../core/subprocess.js';

// claude CLI 用 `--disable-slash-commands` (文档:"Disable all skills") +
// `--disallowedTools Skill` 实现与 SDK 等价的完全隔离。非空 skill 白名单不再支持
// (它无法真正隔离,见 claude-sdk.ts buildSdkIsolationOptions),所以 [name1, ...] 必须 throw。
//
//   undefined           → 不传任何 flag(原行为,全发现)
//   []                  → --disable-slash-commands + --disallowedTools Skill
//                         (main session skill discovery + subagent Skill 工具调用都堵)
//   [...] (length > 0)  → throw,非空白名单已移除

function applySkillIsolationToCliArgs(args: string[], allowedSkills: string[] | undefined): void {
  if (allowedSkills === undefined) return;
  if (allowedSkills.length > 0) {
    throw new Error(
      `skill 白名单(allowedSkills=${JSON.stringify(allowedSkills)})不再支持:非空白名单无法真正隔离。\n`
      + `  仅支持 [](映射为 --disable-slash-commands + --disallowedTools Skill,全封死)或 undefined(不隔离)。`,
    );
  }
  // 完全隔离:双堵 main session skill 发现 + subagent Skill 工具
  args.push('--disable-slash-commands', '--disallowedTools', 'Skill');
}

export async function claudeCliExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, mocks, mocksBaseDir, mocksStrict, lean, effort }: ExecutorInput): Promise<ExecResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model,
    // 评测必须 bypass permission,否则 Bash / Edit / Write 等工具调用会卡在交互式确认。
    // sdk executor 用 options.permissionMode='bypassPermissions',cli 用此 flag 等价。
    '--permission-mode', 'bypassPermissions'];
  if (system) args.push('--system-prompt', system);
  // effort 决策:
  //   - lean=true(纯文本生成):默认 'low',但允许调用方显式覆盖(如 doctor 用 --effort 调高)。
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
    const parsed = parseClaudeStreamJson(stdout);
    const ms = captureMockStats();
    return {
      ...buildClaudeResult({
        messages: parsed.messages,
        malformedLineCount: parsed.malformedLineCount,
        wallClockDurationMs: durationMs,
        source: 'claude stream-json',
      }),
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

    const parsed = parseClaudeStreamJson(details.stdout || '');
    const ms = captureMockStats();
    return {
      ...buildClaudeResult({
        messages: parsed.messages,
        malformedLineCount: parsed.malformedLineCount,
        wallClockDurationMs: durationMs,
        source: 'claude stream-json',
        forcedError: details.stderr?.trim() || errorMessage(err),
      }),
      ...(ms && { mockStats: ms }),
    };
  } finally {
    // mock 注入路径:无论 try 走哪条出口,cleanup 必删临时 CLAUDE_CONFIG_DIR
    mockHandle?.cleanup();
  }
}
