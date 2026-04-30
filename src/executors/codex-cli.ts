import type { ExecResult, ExecutorInput } from '../types/index.js';
import { extractCodexTrace, isCodexResultEvent } from './codex-cli-trace.js';
import type { CodexEvent } from './shared.js';
import {
  asErrorLike,
  buildExecEnv,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  execFileAsync,
  MAX_BUFFER,
  timeoutExecResult,
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
function isolateCodexCwd(allowedSkills: string[] | undefined, cwd: string | null | undefined): void {
  if (allowedSkills === undefined) return;
  if (allowedSkills.length > 0) {
    throw new Error(
      `codex-cli executor 不支持 partial skill 白名单(allowedSkills=${JSON.stringify(allowedSkills)})。\n`
      + `  仅支持 [](强制 cwd 隔离,需提供 cwd 非空)或 undefined(默认)。\n`
      + `  codex CLI 无 partial 白名单 flag,请改用其他 executor 或显式 cwd 隔离。`,
    );
  }
  // allowedSkills === [] 时必须有 cwd(channel 3 cwd 隔离是 codex 唯一 channel)
  if (!cwd) {
    throw new Error(
      'codex-cli executor allowedSkills=[] 需要提供 cwd 非空(channel 3 cwd 隔离)。\n'
      + '  codex 没有 SDK skill 自动发现 / subagent Skill 工具这两条 channel,\n'
      + '  cwd 文件系统隔离是它唯一能堵 AGENTS.md / .agents/skills/ 自动加载的途径。\n'
      + '  caller 应传一个 isolated 空目录(如 ~/.oh-my-knowledge/isolated-cwd/)。',
    );
  }
}

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

function extractCodexUsage(events: CodexEvent[]): { input: number; cached: number; output: number } {
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

function extractCodexFinalOutput(events: CodexEvent[]): string {
  // 优先取最后一个 assistant_message 的 text;否则把所有 assistant_message 拼起来
  let lastAssistantText = '';
  const allTexts: string[] = [];
  for (const e of events) {
    const isAssistantMsg = e.type === 'item.assistant_message' || e.item_type === 'assistant_message';
    if (!isAssistantMsg) continue;
    const payload = e.payload as { text?: string } | undefined;
    const txt = payload?.text || e.text || '';
    if (txt) {
      allTexts.push(txt);
      lastAssistantText = txt;
    }
  }
  return lastAssistantText || allTexts.join('\n');
}

function extractCodexStopReason(events: CodexEvent[]): string {
  const last = [...events].reverse().find((e) => isCodexResultEvent(e));
  if (!last) return 'unknown';
  if (last.type === 'turn.failed') return 'error';
  return last.stop_reason || 'end_turn';
}

function buildCodexArgs({ model, cwd, prompt }: { model: string; cwd?: string | null; prompt: string }): string[] {
  // codex exec [OPTIONS] [PROMPT];prompt 走 positional(execFile 不走 shell,自动 escape)
  const args: string[] = [
    'exec',
    '--json',
    '--ephemeral',                      // 不持久化 session 文件
    '--ignore-user-config',             // 不读 $CODEX_HOME/config.toml
    '--skip-git-repo-check',            // 允许 isolated cwd 不是 git 仓库
    '--sandbox', 'read-only',           // 评测场景不需要写文件
    '--ask-for-approval', 'never',      // non-interactive 必须
  ];
  if (model) args.push('--model', model);
  if (cwd) args.push('-C', cwd);
  args.push(prompt);
  return args;
}

export async function codexCliExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, verbose }: ExecutorInput): Promise<ExecResult> {
  isolateCodexCwd(allowedSkills, cwd);

  // codex CLI 没有 --system-prompt flag。降级:把 system 拼到 prompt 头部,
  // verbose 输出降级提示。reproducibility 略受影响,但语义大致等价。
  const finalPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  if (system && verbose) {
    process.stderr.write('[codex] system prompt prepended (codex CLI lacks --system-prompt flag)\n');
  }
  if (verbose) {
    process.stderr.write('[codex] cost not reported by binary; costUSD will be 0\n');
  }

  const args = buildCodexArgs({ model, cwd, prompt: finalPrompt });
  const env = buildExecEnv(skillDir);

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('codex', args, {
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
      // ?? 不 ||:elapsed_ms === 0(异常 turn)时不应 fallback 到 wall-clock duration
      durationMs: last.elapsed_ms ?? durationMs,
      durationApiMs: 0, // codex 不报 API duration
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cached,
      cacheCreationTokens: 0, // codex 不报 cache creation
      costUSD: 0, // codex 不报 USD cost
      output: finalOutput,
      stopReason,
      numTurns: resultEvents.length,
      fullNumTurns: trace.fullNumTurns,
      numSubAgents: trace.numSubAgents,
      ...(trace.turns.length > 0 && { turns: trace.turns }),
      ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    if (details.killed) return timeoutExecResult(timeoutMs, durationMs);

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
        durationMs: last.elapsed_ms ?? durationMs,
        durationApiMs: 0,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cached,
        cacheCreationTokens: 0,
        costUSD: 0,
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
      output: null,
      stopReason: 'error',
      numTurns: 0,
    };
  }
}
