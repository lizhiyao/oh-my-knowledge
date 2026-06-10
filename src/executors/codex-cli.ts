import type { ExecResult, ExecutorInput } from '../types/index.js';
import { extractCodexTrace, isCodexResultEvent } from './codex-cli-trace.js';
import type { CodexEvent } from './shared.js';
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

// codex CLI(0.125)隔离能力对比 claude-cli:
//   Claude:三条 channel(SDK skills auto-discovery / subagent Skill 工具 /
//          cwd 文件系统),`--disable-slash-commands` + `--disallowedTools Skill`
//          堵前两条,cwd 切空目录堵第三条
//   Codex:无 SDK 等价 channel(它就是 CLI 不是 SDK),无 subagent Skill 等价
//          (没有 Agent 工具),只剩 cwd 文件系统这一条 channel(`-C/--cd`)
//          → AGENTS.md / .agents/skills/ 自动加载只能靠 cwd 切到隔离空目录避免
//
//   undefined         → 不传 -C(原行为,看 cwd 里有什么 codex 自己决定)
//   []                → 必须提供 cwd 非空(否则 throw),caller 应传一个
//                       isolated 空目录(如 ~/.oh-my-knowledge/isolated-cwd/)
//   [...] (length>0)  → throw,codex CLI 没有 partial 白名单 flag
export function isolateCodexCwd(allowedSkills: string[] | undefined, cwd: string | null | undefined, executorName = 'codex-cli'): void {
  if (allowedSkills === undefined) return;
  if (allowedSkills.length > 0) {
    throw new Error(
      `${executorName} executor 不支持 partial skill 白名单(allowedSkills=${JSON.stringify(allowedSkills)})。\n`
      + `  仅支持 [](强制 cwd 隔离,需提供 cwd 非空)或 undefined(默认)。\n`
      + `  codex CLI 无 partial 白名单 flag,请改用其他 executor 或显式 cwd 隔离。`,
    );
  }
  // allowedSkills === [] 时必须有 cwd(channel 3 cwd 隔离是 codex 唯一 channel)
  if (!cwd) {
    throw new Error(
      `${executorName} executor allowedSkills=[] 需要提供 cwd 非空(channel 3 cwd 隔离)。\n`
      + '  codex 没有 SDK skill 自动发现 / subagent Skill 工具这两条 channel,\n'
      + '  cwd 文件系统隔离是它唯一能堵 AGENTS.md / .agents/skills/ 自动加载的途径。\n'
      + '  caller 应传一个 isolated 空目录(如 ~/.oh-my-knowledge/isolated-cwd/)。',
    );
  }
}

// codex 的 verbose 降级提示是 binary 能力快照(无 --system-prompt flag / 不报 cost),
// 不会逐次调用变化。executor 在 sample × variant × judge_repeat × dimension 多次被调,
// 每次都打两行会让 stderr 被同样文本刷屏(140-280 行)。模块级 flag 一个 process 只打一次。
let hasWarnedSystem = false;
let hasWarnedCost = false;

function parseCodexJsonl(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch { /* skip non-JSON lines */ }
  }
  return events;
}

export function extractCodexUsage(events: CodexEvent[]): { input: number; cached: number; output: number } {
  let input = 0;
  let cached = 0;
  let output = 0;
  for (const e of events) {
    if (!isCodexResultEvent(e) || !e.usage) continue;
    input += e.usage.input_tokens || 0;
    cached += e.usage.cached_input_tokens || 0;
    output += e.usage.output_tokens || 0;
  }
  return { input, cached, output };
}

// exported for unit tests
export function extractCodexFinalOutput(events: CodexEvent[]): string {
  // 抓 item.completed + item.type='agent_message' 的 text 全部拼起来。
  // codex 同 turn 内可能 emit 多条 agent_message(如 "step 1" / "step 2" / "final answer"),
  // 取最后一条会让 grader / assertion / LLM judge 只看到最后片段,跟 extractCodexTrace
  // 把多条拼到 turn.content 的语义不一致(test/executors/codex-cli-trace.test.ts:120-130 锁住)。
  // 一致化:final output 也拼,跟 trace UI 看到的内容对齐。
  const allTexts: string[] = [];
  for (const e of events) {
    if (e.type !== 'item.completed') continue;
    if (e.item?.type !== 'agent_message') continue;
    const txt = e.item.text;
    if (txt) allTexts.push(txt);
  }
  return allTexts.join('\n');
}

export function extractCodexStopReason(events: CodexEvent[]): string {
  const last = [...events].reverse().find((e) => isCodexResultEvent(e));
  if (!last) return 'unknown';
  if (last.type === 'turn.failed') return 'error';
  return last.stop_reason || 'end_turn';
}

// codex 每个 turn.completed 携带本 turn 的 elapsed_ms(per-turn delta),
// 跟 extractCodexUsage 把 token 累加多 turn 是同一语义假设(events 是 per-turn delta,
// 不是 cumulative)。multi-turn 只取最后一条会漏算前面 turn 的耗时。fallback:
// 累加为 0 / 全部缺失时退到 wall-clock,避免 elapsed_ms===0 单 turn 抹平 duration。
// exported for unit tests
export function sumCodexElapsed(resultEvents: CodexEvent[], wallClock: number): number {
  const total = resultEvents.reduce((s, e) => s + (e.elapsed_ms ?? 0), 0);
  return total > 0 ? total : wallClock;
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
function runCodexExec(args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; timeout: number; maxBuffer: number }): Promise<{ stdout: string; stderr: string }> {
  const { child, done } = spawnWithSigintPropagation('codex', args, {
    env: options.env,
    cwd: options.cwd,
    timeoutMs: options.timeout,
    maxBuffer: options.maxBuffer,
  });
  child.stdin?.end();
  return done.then((r) => ({ stdout: r.stdout, stderr: r.stderr }));
}

export async function codexCliExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, verbose }: ExecutorInput): Promise<ExecResult> {
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
      ...(cwd && { cwd }),
    });
    const durationMs = Date.now() - start;
    const events = parseCodexJsonl(stdout);

    const resultEvents = events.filter(isCodexResultEvent);
    if (resultEvents.length === 0) {
      return {
        ok: false,
        error: 'no turn.completed/turn.failed event in codex --json output',
        durationMs,
        durationApiMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        costReportedByExecutor: false,
        output: null,
        stopReason: 'error',
        numTurns: 0,
      };
    }

    const last = resultEvents[resultEvents.length - 1];
    const usage = extractCodexUsage(events);
    const trace = extractCodexTrace(events);
    const stopReason = extractCodexStopReason(events);
    const finalOutput = extractCodexFinalOutput(events);
    const ok = last.type !== 'turn.failed' && !last.error;

    return {
      ok,
      // multi-turn 累加 elapsed_ms(per-turn delta);全 0 fallback wall-clock。详见 sumCodexElapsed
      durationMs: sumCodexElapsed(resultEvents, durationMs),
      durationApiMs: 0, // codex 不报 API duration
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cached,
      cacheCreationTokens: 0, // codex 不报 cache creation
      costUSD: 0,                       // 占位:codex 0.125 binary 不输出 cost
      costReportedByExecutor: false,    // renderer 据此显示「未报告」而非 $0.0000
      output: finalOutput,
      stopReason,
      // success path:ok=false(turn.failed)时透传 last.error.message 给 caller 看到
      // 失败原因。catch path 历史上已经透传(对称化)。
      ...(!ok && { error: last.error?.message || 'codex turn.failed' }),
      numTurns: resultEvents.length,
      fullNumTurns: trace.fullNumTurns,
      numSubAgents: trace.numSubAgents,
      ...(trace.turns.length > 0 && { turns: trace.turns }),
      ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = err as SpawnHelperError;
    if (details.killedByTimeout) return { ...timeoutExecResult(timeoutMs, durationMs), costReportedByExecutor: false };
    if (details.killedBySignal) return { ...interruptedExecResult(durationMs), costReportedByExecutor: false };

    // 尝试从 stdout parse 部分结果(同 claude-cli 防御性写法)
    const events = parseCodexJsonl(details.stdout || '');
    const resultEvents = events.filter(isCodexResultEvent);
    if (resultEvents.length > 0) {
      const last = resultEvents[resultEvents.length - 1];
      const usage = extractCodexUsage(events);
      const trace = extractCodexTrace(events);
      return {
        ok: false,
        error: last.error?.message || errorMessage(err),
        durationMs: sumCodexElapsed(resultEvents, durationMs),
        durationApiMs: 0,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cached,
        cacheCreationTokens: 0,
        costUSD: 0,
        costReportedByExecutor: false,
        output: extractCodexFinalOutput(events) || null,
        stopReason: 'error',
        numTurns: resultEvents.length,
        fullNumTurns: trace.fullNumTurns,
        numSubAgents: trace.numSubAgents,
        ...(trace.turns.length > 0 && { turns: trace.turns }),
        ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
      };
    }

    return {
      ok: false,
      error: errorMessage(err),
      durationMs,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0,
      costReportedByExecutor: false,
      output: null,
      stopReason: 'error',
      numTurns: 0,
    };
  }
}
