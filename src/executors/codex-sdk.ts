import { existsSync } from 'node:fs';
import { mkdtemp, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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
let codexHomePromise: Promise<string> | null = null;
let hasWarnedSystem = false;
let hasWarnedCost = false;

async function getCodexCtor(): Promise<CodexSdkModule['Codex']> {
  if (!CodexCtor) {
    const sdk = await import('@openai/codex-sdk') as CodexSdkModule;
    CodexCtor = sdk.Codex;
  }
  return CodexCtor;
}

// Construct-validity invariant: codex-cli passes `--ephemeral`(no session
// persistence)+ `--ignore-user-config`(skip $CODEX_HOME/config.toml)so eval
// runs are independent of the user's local codex profile. @openai/codex-sdk's
// ThreadOptions does NOT expose either flag, so without intervention codex-sdk
// runs would leak `~/.codex/config.toml`(custom model_reasoning_effort,
// instructions, tool config)into the eval and pollute `~/.codex/sessions/`
// across runs.
//
// Mitigation: redirect $CODEX_HOME to a per-process tmp dir for codex-sdk only.
// auth.json is symlinked from the real CODEX_HOME so the SDK can still
// authenticate; config.toml + sessions/ stay isolated. Tmp dir stays alive for
// the OS to rotate(no explicit cleanup, matches DEFAULT_TIMEOUT_MS scope).
//
// Best-effort on Windows where symlink may need elevated privileges; on
// failure, the codex-sdk executor still runs but lands in the user's real
// CODEX_HOME with a stderr warning.
export async function getIsolatedCodexHome(): Promise<string> {
  if (!codexHomePromise) {
    codexHomePromise = (async () => {
      const tmpHome = await mkdtemp(join(tmpdir(), 'omk-codex-sdk-'));
      const realHome = process.env.CODEX_HOME || join(homedir(), '.codex');
      const realAuth = join(realHome, 'auth.json');
      if (existsSync(realAuth)) {
        try {
          await symlink(realAuth, join(tmpHome, 'auth.json'));
        } catch (err) {
          process.stderr.write(`[codex-sdk] CODEX_HOME isolation: auth.json symlink failed (${(err as Error).message}); SDK will use bare tmp home and may fail to authenticate\n`);
        }
      }
      return tmpHome;
    })();
  }
  return codexHomePromise;
}

// exported for test isolation
export function __resetCodexSdkStateForTest(): void {
  CodexCtor = null;
  codexHomePromise = null;
  hasWarnedSystem = false;
  hasWarnedCost = false;
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

  // SIGINT propagation: PR #33 helper only tracks child process refs registered
  // via spawnWithSigintPropagation; @openai/codex-sdk does its own spawn()
  // internally and the SDK child is not in that registry. Hook the
  // AbortController to SIGINT so the SDK kills its child via the standard
  // abortSignal pipeline (SDK passes `signal: args.signal` to spawn). Without
  // this, Ctrl+C in a nested host orphans the codex SDK child until DEFAULT
  // timeout elapses, regressing PR #33's nested-host fix.
  const sigintListener = (): void => abortController.abort();
  process.on('SIGINT', sigintListener);

  const events: CodexEvent[] = [];

  try {
    env.CODEX_HOME = await getIsolatedCodexHome();
    const codex = await createCodexSdkClient(env);
    const thread = codex.startThread(buildCodexSdkThreadOptions({ model, cwd }));
    const streamed = await thread.runStreamed(finalPrompt, { signal: abortController.signal });

    for await (const event of streamed.events) {
      events.push(normalizeSdkEvent(event));
    }

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
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', sigintListener);
  }
}
