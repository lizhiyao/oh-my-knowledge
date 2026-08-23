import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ExecResult, ExecutorInput } from '../types/index.js';
import { buildDshResult, type DshRunResult } from './dsh-protocol.js';
import { isolateCodexCwd } from './codex-cli.js';
import {
  buildExecEnv,
  DEFAULT_TIMEOUT_MS,
  errorMessage,
  interruptedExecResult,
  registerSigintSubscriber,
  timeoutExecResult,
} from './shared.js';

interface DshHarness {
  run(input: string): Promise<DshRunResult>;
  close(): Promise<void>;
}

interface DshSdkModule {
  DeepSeekHarness: new (options: unknown) => DshHarness;
}

const DSH_SDK_PACKAGE = '@deepseek-ai/dsh-sdk-client';

export interface DshLaunchConfig {
  command: string;
  args: string[];
  configPath: string;
  provider: string;
  maxTokens?: number;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseStringArray(value: string | undefined): string[] {
  if (!nonEmpty(value)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value as string) as unknown;
  } catch (err) {
    throw new Error(`OMK_DSH_ARGS 必须是 JSON 字符串数组：${errorMessage(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('OMK_DSH_ARGS 必须是 JSON 字符串数组，例如：["runtime.mjs","cordis.yml"]。');
  }
  return parsed;
}

function parseMaxTokens(value: string | undefined): number | undefined {
  if (!nonEmpty(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('OMK_DSH_MAX_TOKENS 必须是正整数。');
  }
  return parsed;
}

export function resolveDshLaunchConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): DshLaunchConfig {
  const rawConfigPath = nonEmpty(env.OMK_DSH_CONFIG);
  if (!rawConfigPath) {
    throw new Error(
      'dsh executor 需要 OMK_DSH_CONFIG 指向 runtime 使用的 Cordis 配置。'
      + '该配置必须消费 DSH_SYSTEM_PROMPT／DSH_CWD／DSH_SESSION_ROOT，并在严格评测中关闭 DSH skill 自动发现。',
    );
  }
  const configPath = isAbsolute(rawConfigPath) ? rawConfigPath : resolve(cwd, rawConfigPath);
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new Error(`OMK_DSH_CONFIG 指向的文件不存在：${configPath}`);
  }
  const maxTokens = parseMaxTokens(env.OMK_DSH_MAX_TOKENS);
  return {
    command: nonEmpty(env.OMK_DSH_COMMAND) ?? 'dsh-jsonrpc-agent',
    args: parseStringArray(env.OMK_DSH_ARGS),
    configPath,
    provider: nonEmpty(env.OMK_DSH_PROVIDER) ?? 'deepseek-official',
    ...(maxTokens !== undefined && { maxTokens }),
  };
}

export function buildDshRuntimeEnv(
  input: Pick<ExecutorInput, 'cwd' | 'model' | 'system' | 'skillDir'>,
  config: DshLaunchConfig,
  isolatedRoot: string,
): NodeJS.ProcessEnv {
  return {
    ...buildExecEnv(input.skillDir),
    DSH_HOME: join(isolatedRoot, 'home'),
    DSH_SESSION_ROOT: join(isolatedRoot, 'sessions'),
    DSH_CORDIS_CONFIG: config.configPath,
    DSH_CWD: input.cwd ?? process.cwd(),
    DSH_MODEL: input.model,
    DSH_SYSTEM_PROMPT: input.system ?? '',
  };
}

async function createHarness(
  input: ExecutorInput,
  config: DshLaunchConfig,
  isolatedRoot: string,
): Promise<DshHarness> {
  const sdk = await import(DSH_SDK_PACKAGE) as unknown as DshSdkModule;
  return new sdk.DeepSeekHarness({
    launch: {
      command: config.command,
      args: [...config.args, config.configPath],
      cwd: input.cwd ?? process.cwd(),
      env: buildDshRuntimeEnv(input, config, isolatedRoot),
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 500,
      disposeGraceMs: 1_000,
    },
    cwd: input.cwd ?? process.cwd(),
    provider: config.provider,
    model: input.model,
    ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
  });
}

export async function dshSdkExecutor(input: ExecutorInput): Promise<ExecResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = input;
  isolateCodexCwd(input.allowedSkills, input.cwd, 'dsh');
  const config = resolveDshLaunchConfig(process.env, input.cwd ?? process.cwd());
  const start = Date.now();
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'omk-dsh-sdk-'));
  let harness: DshHarness | undefined;
  let stop: 'timeout' | 'interrupted' | undefined;
  let closeTask: Promise<void> | undefined;
  const close = (reason: NonNullable<typeof stop>): void => {
    if (stop) return;
    stop = reason;
    if (harness) closeTask = harness.close();
  };
  const timer = setTimeout(() => close('timeout'), timeoutMs);
  timer.unref();
  const unregisterSigint = registerSigintSubscriber(() => close('interrupted'));

  try {
    harness = await createHarness(input, config, isolatedRoot);
    if (stop) closeTask = harness.close();
    const result = await harness.run(input.prompt);
    const durationMs = Date.now() - start;
    // A runtime can emit idle concurrently with the local deadline. The
    // caller-side timeout/interruption remains authoritative even if run()
    // happens to settle before close() tears the transport down.
    if (stop === 'timeout') return timeoutExecResult(timeoutMs, durationMs);
    if (stop === 'interrupted') return interruptedExecResult(durationMs);
    return buildDshResult(result, durationMs);
  } catch (err) {
    const durationMs = Date.now() - start;
    if (stop === 'timeout') return timeoutExecResult(timeoutMs, durationMs);
    if (stop === 'interrupted') return interruptedExecResult(durationMs);
    return {
      ok: false,
      output: null,
      durationMs,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokenUsageReportedByExecutor: false,
      costUSD: 0,
      costReportedByExecutor: false,
      stopReason: 'error',
      numTurns: 0,
      error: errorMessage(err, 'dsh execution failed'),
    };
  } finally {
    clearTimeout(timer);
    unregisterSigint();
    try {
      if (harness && !closeTask) closeTask = harness.close();
      await closeTask;
    } catch (err) {
      process.stderr.write(`[dsh] runtime 关闭失败：${errorMessage(err)}\n`);
    }
    try {
      await rm(isolatedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (err) {
      process.stderr.write(`[dsh] 临时隔离目录清理失败：${errorMessage(err)}\n`);
    }
  }
}
