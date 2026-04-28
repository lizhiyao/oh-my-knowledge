import type { ExecResult, ExecutorInput } from '../types/index.js';
import { extractAgentTrace, isClaudeSdkResultMessage } from './claude-sdk-trace.js';
import type { ClaudeSdkBaseMessage, ClaudeSdkResultMessage } from './shared.js';
import {
  asErrorLike,
  buildExecEnv,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  execFileAsync,
  MAX_BUFFER,
  timeoutExecResult,
} from './shared.js';

// v0.22 — claude CLI 没有 --skills flag(实测 claude --help 只有 --disable-slash-commands /
// --bare),degraded mode 处理 allowedSkills:
//   undefined           → 不传任何 flag(原行为,SDK 全发现)
//   []                  → --disable-slash-commands(关闭所有 slash commands,粒度更粗但可堵住
//                          ~/.claude/skills/ + ~/.claude/commands/),首次 stderr warn
//   [...] (length > 0)  → throw,提示用 claude-sdk executor 走精准白名单
let cliPartialAllowlistWarned = false;

function applySkillIsolationToCliArgs(args: string[], allowedSkills: string[] | undefined): void {
  if (allowedSkills === undefined) return;
  if (allowedSkills.length > 0) {
    throw new Error(
      `claude-cli executor 不支持 partial skill 白名单(allowedSkills=${JSON.stringify(allowedSkills)})。\n`
      + `  仅支持 [](映射为 --disable-slash-commands)或 undefined(默认)。\n`
      + `  精确隔离请改用 --executor claude-sdk(SDK skills option pass-through)。`,
    );
  }
  // 完全隔离 → --disable-slash-commands(也会关掉 slash command 类的 skill)
  args.push('--disable-slash-commands');
  if (!cliPartialAllowlistWarned) {
    cliPartialAllowlistWarned = true;
    process.stderr.write(
      `[omk] claude-cli executor: allowedSkills=[] 映射为 --disable-slash-commands(粒度比 claude-sdk 粗,会一并禁用所有 slash commands)。如需精确隔离请用 --executor claude-sdk。\n`,
    );
  }
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

export async function claudeCliExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills }: ExecutorInput): Promise<ExecResult> {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model];
  if (system) args.push('--system-prompt', system);
  applySkillIsolationToCliArgs(args, allowedSkills);

  const env = buildExecEnv(skillDir);

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync('claude', args, {
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      env,
      ...(cwd && { cwd }),
    });
    const durationMs = Date.now() - start;
    const messages = parseStreamJson(stdout);

    // 提取 result 消息
    const resultMsgs = messages.filter(isClaudeSdkResultMessage) as ClaudeSdkResultMessage[];
    if (resultMsgs.length === 0) {
      return {
        ok: false, error: 'no result message in stream-json output',
        durationMs, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
      };
    }

    const last = resultMsgs[resultMsgs.length - 1];
    const usage = last.usage || {};

    // 提取 trace
    const trace = extractAgentTrace(messages);

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
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    if (details.killed) return timeoutExecResult(timeoutMs, durationMs);

    // 尝试从 stdout 解析 stream-json（即使进程退出码非 0 也可能有 result）
    const messages = parseStreamJson(details.stdout || '');
    const resultMsgs = messages.filter(isClaudeSdkResultMessage) as ClaudeSdkResultMessage[];
    if (resultMsgs.length > 0) {
      const last = resultMsgs[resultMsgs.length - 1];
      const usage = last.usage || {};
      const trace = extractAgentTrace(messages);
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
      };
    }

    return {
      ok: false,
      error: errorMessage(err),
      durationMs, durationApiMs: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
    };
  }
}
