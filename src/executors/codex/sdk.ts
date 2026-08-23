import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Codex, CodexOptions, ThreadEvent } from '@openai/codex-sdk';
import type { ExecResult, ExecutorInput } from '../../types/index.js';
import {
  buildCodexResult,
  normalizeCodexProtocolEvent,
  type CodexEvent,
} from './protocol.js';
import { DEFAULT_TIMEOUT_MS } from '../defaults.js';
import {
  asErrorLike,
  buildExecEnv,
  errorMessage,
  interruptedExecResult,
  timeoutExecResult,
} from '../runtime.js';
import { registerSigintSubscriber } from '../subprocess.js';
import { isolateCodexCwd } from './cli.js';

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

// Construct-validity invariant: codex-cli passes `--ephemeral`(no session
// persistence)+ `--ignore-user-config`(skip $CODEX_HOME/config.toml)so eval
// runs are independent of the user's local codex profile. @openai/codex-sdk's
// ThreadOptions does NOT expose either flag, so without intervention codex-sdk
// runs would leak `~/.codex/config.toml`(custom model_reasoning_effort,
// instructions, tool config)into the eval and pollute `~/.codex/sessions/`
// across runs.
//
// Mitigation: redirect $CODEX_HOME to a fresh tmp dir for every codex-sdk run.
// auth.json is copied from the real CODEX_HOME so token refreshes cannot mutate
// the user's credential file through a symlink; config.toml + sessions/ stay
// isolated and the tmp dir is removed after the SDK child exits.
//
// The SDK still does not expose codex CLI's `--ignore-rules`. Project
// execpolicy is therefore part of codex-sdk's runtime context; use codex-cli
// when that final isolation boundary matters.
export async function getIsolatedCodexHome(): Promise<string> {
  const tmpHome = await mkdtemp(join(tmpdir(), 'omk-codex-sdk-'));
  const realHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const realAuth = join(realHome, 'auth.json');
  if (existsSync(realAuth)) {
    try {
      await copyFile(realAuth, join(tmpHome, 'auth.json'));
    } catch (err) {
      process.stderr.write(`[codex-sdk] CODEX_HOME isolation: auth.json copy failed (${(err as Error).message}); SDK will use bare tmp home and may fail to authenticate\n`);
    }
  }
  return tmpHome;
}

// exported for test isolation
export function __resetCodexSdkStateForTest(): void {
  CodexCtor = null;
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
  return normalizeCodexProtocolEvent(event) ?? {};
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
  let abortReason: 'timeout' | 'interrupted' | undefined;
  const abort = (reason: NonNullable<typeof abortReason>): void => {
    if (abortReason) return;
    abortReason = reason;
    abortController.abort();
  };
  const timer = setTimeout(() => {
    abort('timeout');
  }, timeoutMs);

  // SIGINT propagation: PR #33 helper only tracks child process refs registered
  // via spawnWithSigintPropagation; @openai/codex-sdk does its own spawn()
  // internally and the SDK child is not in that registry. Hook the
  // AbortController to SIGINT so the SDK kills its child via the standard
  // abortSignal pipeline (SDK passes `signal: args.signal` to spawn). Without
  // this, Ctrl+C in a nested host orphans the codex SDK child until DEFAULT
  // timeout elapses, regressing PR #33's nested-host fix.
  const unregisterSigint = registerSigintSubscriber(() => abort('interrupted'));

  const events: CodexEvent[] = [];
  let isolatedCodexHome: string | undefined;

  try {
    isolatedCodexHome = await getIsolatedCodexHome();
    env.CODEX_HOME = isolatedCodexHome;
    const codex = await createCodexSdkClient(env);
    const thread = codex.startThread(buildCodexSdkThreadOptions({ model, cwd }));
    const streamed = await thread.runStreamed(finalPrompt, { signal: abortController.signal });

    for await (const event of streamed.events) {
      events.push(normalizeSdkEvent(event));
    }

    return buildCodexResult({
      events,
      wallClockDurationMs: Date.now() - start,
      source: 'codex-sdk',
    });
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const details = asErrorLike(err);
    if (abortReason === 'interrupted') {
      return { ...interruptedExecResult(durationMs), costReportedByExecutor: false };
    }
    if (abortReason === 'timeout') {
      return { ...timeoutExecResult(timeoutMs, durationMs), costReportedByExecutor: false };
    }

    return buildCodexResult({
      events,
      wallClockDurationMs: durationMs,
      source: 'codex-sdk',
      forcedError: details.name === 'AbortError'
        ? 'codex-sdk execution aborted'
        : errorMessage(err),
    });
  } finally {
    clearTimeout(timer);
    unregisterSigint();
    if (isolatedCodexHome) {
      try {
        await rm(isolatedCodexHome, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
      } catch (err) {
        process.stderr.write(
          `[codex-sdk] unable to remove isolated CODEX_HOME ${isolatedCodexHome}: ${errorMessage(err)}\n`,
        );
      }
    }
  }
}
