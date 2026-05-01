import type { Codex, CodexOptions, ThreadEvent } from '@openai/codex-sdk';
import type { ExecResult, ExecutorInput } from '../types/index.js';
import { extractCodexTrace, isCodexResultEvent } from './codex-cli-trace.js';
import type { CodexEvent } from './shared.js';
import {
  asErrorLike,
  buildExecEnv,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  timeoutExecResult,
} from './shared.js';
import {
  extractCodexFinalOutput,
  extractCodexStopReason,
  extractCodexUsage,
  isolateCodexCwd,
  sumCodexElapsed,
} from './codex-cli.js';

type CodexSdkModule = typeof import('@openai/codex-sdk');

let CodexCtor: CodexSdkModule['Codex'] | null = null;
let hasWarnedSystem = false;
let hasWarnedCost = false;

async function getCodexCtor(): Promise<CodexSdkModule['Codex']> {
  if (!CodexCtor) {
    const sdk = await import('@openai/codex-sdk') as CodexSdkModule;
    CodexCtor = sdk.Codex;
  }
  return CodexCtor;
}

export function buildCodexSdkThreadOptions({ model, cwd }: { model: string; cwd?: string | null }): {
  model?: string;
  sandboxMode: 'read-only';
  workingDirectory?: string;
  skipGitRepoCheck: true;
  approvalPolicy: 'never';
} {
  return {
    ...(model && { model }),
    sandboxMode: 'read-only',
    ...(cwd && { workingDirectory: cwd }),
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
  };
}

export function buildCodexSdkClientOptions(env: NodeJS.ProcessEnv): CodexOptions {
  return {
    // Leave codexPathOverride unset: the SDK should use its bundled @openai/codex
    // binary, matching the SDK executor contract instead of delegating to PATH.
    env: env as Record<string, string>,
  };
}

export async function createCodexSdkClient(env: NodeJS.ProcessEnv): Promise<Codex> {
  const CodexClient = await getCodexCtor();
  return new CodexClient(buildCodexSdkClientOptions(env));
}

function normalizeSdkEvent(event: ThreadEvent): CodexEvent {
  return event as CodexEvent;
}

export async function codexSdkExecutor({ model, system, prompt, cwd, skillDir, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, verbose }: ExecutorInput): Promise<ExecResult> {
  isolateCodexCwd(allowedSkills, cwd, 'codex-sdk');

  const finalPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  if (system && verbose && !hasWarnedSystem) {
    process.stderr.write('[codex-sdk] system prompt prepended (codex CLI/SDK lacks a system-prompt option)\n');
    hasWarnedSystem = true;
  }
  if (verbose && !hasWarnedCost) {
    process.stderr.write('[codex-sdk] cost not reported by binary; costReportedByExecutor=false (renderer shows 「—」 instead of $0.0000)\n');
    hasWarnedCost = true;
  }

  const env = buildExecEnv(skillDir);

  const start = Date.now();
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const events: CodexEvent[] = [];

  try {
    const codex = await createCodexSdkClient(env);
    const thread = codex.startThread(buildCodexSdkThreadOptions({ model, cwd }));
    const streamed = await thread.runStreamed(finalPrompt, { signal: abortController.signal });

    for await (const event of streamed.events) {
      events.push(normalizeSdkEvent(event));
    }
    clearTimeout(timer);

    const durationMs = Date.now() - start;
    const resultEvents = events.filter(isCodexResultEvent);
    if (resultEvents.length === 0) {
      return {
        ok: false,
        error: 'no turn.completed/turn.failed event in codex-sdk output',
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
      durationMs: sumCodexElapsed(resultEvents, durationMs),
      durationApiMs: 0,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cached,
      cacheCreationTokens: 0,
      costUSD: 0,
      costReportedByExecutor: false,
      output: finalOutput,
      stopReason,
      ...(!ok && { error: last.error?.message || 'codex-sdk turn.failed' }),
      numTurns: resultEvents.length,
      fullNumTurns: trace.fullNumTurns,
      numSubAgents: trace.numSubAgents,
      ...(trace.turns.length > 0 && { turns: trace.turns }),
      ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    const isAbort = details.name === 'AbortError' || abortController.signal.aborted;
    if (isAbort) return { ...timeoutExecResult(timeoutMs, durationMs), costReportedByExecutor: false };

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
