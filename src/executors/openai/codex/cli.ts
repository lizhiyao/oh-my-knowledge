import type { ExecResult, ExecutorInput } from '../../../types/index.js';
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

// codex CLI(0.125)隔离能力对比 claude-cli:
//   Claude:三条 channel(SDK skills auto-discovery / subagent Skill 工具 /
//          cwd 文件系统),`--disable-slash-commands` + `--disallowedTools Skill`
//          堵前两条,cwd 切空目录堵第三条
//   Codex:CLI / SDK 的项目指令、skills 与可能的子线程都以 cwd 工作区为
//          发现边界；`-C/--cd` 是可验证的隔离控制面。因此把 cwd 切到
//          隔离空目录，统一阻断 AGENTS.md / .agents/skills/ 自动加载。
//
//   undefined         → 不传 -C(原行为,看 cwd 里有什么 codex 自己决定)
//   []                → 必须提供 cwd 非空(否则 throw),caller 应传一个
//                       isolated 空目录(如 ~/.oh-my-knowledge/state/isolated-cwd/)
//   [...] (length>0)  → throw,非空白名单已移除(无法真正隔离)
export function isolateCodexCwd(allowedSkills: string[] | undefined, cwd: string | null | undefined, executorName = 'codex-cli'): void {
  if (allowedSkills === undefined) return;
  if (allowedSkills.length > 0) {
    throw new Error(
      `skill 白名单(allowedSkills=${JSON.stringify(allowedSkills)})不再支持:非空白名单无法真正隔离。\n`
      + `  仅支持 [](强制 cwd 隔离,需提供 cwd 非空,全封死)或 undefined(不隔离)。`,
    );
  }
  // allowedSkills === [] 时必须有 cwd；工作区隔离是 Codex 的控制面。
  if (!cwd) {
    throw new Error(
      `${executorName} executor allowedSkills=[] 需要提供 cwd 非空（工作区隔离）。\n`
      + '  主线程与可能的子线程都会继承工作区上下文；必须用隔离 cwd 阻断 AGENTS.md / .agents/skills/ 自动加载。\n'
      + '  caller 应传一个 isolated 空目录(如 ~/.oh-my-knowledge/state/isolated-cwd/)。',
    );
  }
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

// exported for arg-shape regression tests
export function buildCodexArgs({ model, cwd, prompt }: { model: string; cwd?: string | null; prompt: string }): string[] {
  // codex exec [OPTIONS] [PROMPT];prompt 走 positional(execFile 不走 shell,自动 escape)
  // approval_policy 走 -c config override:codex CLI 0.125 起去掉了 `--ask-for-approval` flag,
  // 但 approval_policy 这个 config key 仍在,通过 -c 透传不依赖 flag 表面 schema。
  const args: string[] = [
    'exec',
    '--json',
    '--ephemeral',                      // 不持久化 session 文件
    '--ignore-user-config',             // 不读 $CODEX_HOME/config.toml
    '--ignore-rules',                   // 不让用户 / 项目 execpolicy 改写工具行为
    '--skip-git-repo-check',            // 允许 isolated cwd 不是 git 仓库
    '--sandbox', 'read-only',           // 评测场景不需要写文件
    '-c', 'approval_policy="never"',    // non-interactive 必须;TOML 字符串需要 quote
  ];
  if (model) args.push('--model', model);
  if (cwd) args.push('-C', cwd);
  // `--` end-of-options 分隔符:prompt 必须放在 `--` 之后。system prompt 被 prepend 时,
  // skill 内容常以 YAML frontmatter `---` 开头,codex(clap)会把以 `-`/`--` 开头的位置参数
  // 当未知 flag → exit 2(unexpected argument),72ms 秒退、不跑 agent。`--` 之后一律当
  // positional,不再按 flag 解析(codex 自身的报错 tip 即建议此法)。bug:整个 skill eval 全失败。
  args.push('--', prompt);
  return args;
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

export async function codexCliExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, verbose, abortSignal }: ExecutorInput): Promise<ExecResult> {
  isolateCodexCwd(allowedSkills, cwd);

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

  const args = buildCodexArgs({ model, cwd, prompt: finalPrompt });
  const env = buildExecEnv(skillDir);

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
    if (details.killedByTimeout) return { ...timeoutExecResult(timeoutMs, durationMs), costReportedByExecutor: false };
    if (details.killedBySignal) return { ...interruptedExecResult(durationMs), costReportedByExecutor: false };

    // 失败路径仍保留已完成的事件、用量与 trace，但不能反转为成功。
    const parsed = parseCodexJsonl(details.stdout || '');
    return buildCodexResult({
      events: parsed.events,
      wallClockDurationMs: durationMs,
      source: 'codex --json',
      malformedLineCount: parsed.malformedLineCount,
      forcedError: details.stderr?.trim() || errorMessage(err),
    });
  }
}
