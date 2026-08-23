import type { ExecResult, ExecutorFn, ExecutorInput } from '../../types/index.js';
import { materializeForCliConfigDir } from '../../eval-core/mocks-runtime.js';
import {
  executorResultValidationError,
  normalizeExecResultToolIdentities,
} from '../../shared/executor-result.js';
import { resolveScriptCommand } from './command.js';
import { DEFAULT_TIMEOUT_MS } from '../core/limits.js';
import {
  interruptedExecResult,
  timeoutExecResult,
} from '../core/runtime.js';
import { spawnWithSigintPropagation, type SpawnHelperError } from '../core/subprocess.js';

// script executor 由用户自定义,omk 无法保证它实现 skill 隔离。
// 任何 allowedSkills(包括 [])下都 stderr 一次性 warn,不阻塞执行,
// 让用户知道 strict-baseline / 显式 allowedSkills 在 script executor 下静默无效。
let scriptIsolationWarned = false;

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
    ? value
    : 0;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function scriptProtocolMetricsError(protocol: Record<string, unknown>): string | undefined {
  const integerFields = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'numTurns',
  ];
  for (const field of integerFields) {
    if (protocol[field] !== undefined && nonNegativeInteger(protocol[field]) !== protocol[field]) {
      return `"${field}" must be a non-negative safe integer`;
    }
  }
  for (const field of ['durationApiMs', 'costUSD']) {
    if (protocol[field] !== undefined && nonNegativeNumber(protocol[field]) !== protocol[field]) {
      return `"${field}" must be a non-negative finite number`;
    }
  }
  return undefined;
}

function scriptProtocolReportsTokenUsage(protocol: Record<string, unknown>): boolean {
  return [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
  ].every((field) => protocol[field] !== undefined);
}

function scriptProtocolTraceFields(protocol: Record<string, unknown>): Partial<ExecResult> {
  return {
    ...(protocol.turns !== undefined && {
      turns: protocol.turns as ExecResult['turns'],
    }),
    ...(protocol.toolCalls !== undefined && {
      toolCalls: protocol.toolCalls as ExecResult['toolCalls'],
    }),
    ...(protocol.fullNumTurns !== undefined && {
      fullNumTurns: protocol.fullNumTurns as number,
    }),
    ...(protocol.numSubAgents !== undefined && {
      numSubAgents: protocol.numSubAgents as number,
    }),
  };
}

function invalidScriptProtocolResult(
  message: string,
  durationMs: number,
  mockStats?: ExecResult['mockStats'],
): ExecResult {
  return {
    ok: false,
    error: `script executor returned malformed protocol JSON: ${message}`,
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
    ...(mockStats && { mockStats }),
  };
}

function validateScriptProtocolResult(
  result: ExecResult,
  mockStats?: ExecResult['mockStats'],
): ExecResult {
  const validationError = executorResultValidationError(result);
  if (validationError) {
    return invalidScriptProtocolResult(
      validationError,
      result.durationMs,
      mockStats,
    );
  }
  return normalizeExecResultToolIdentities(result);
}

export function createScriptExecutor(command: string): ExecutorFn {
  const baseCwd = process.cwd();
  const resolved = resolveScriptCommand(command, baseCwd);
  const cmd = resolved.command;
  const args = resolved.args;

  return async function scriptExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, mocks, mocksBaseDir, mocksStrict }: ExecutorInput): Promise<ExecResult> {
    if (allowedSkills !== undefined && !scriptIsolationWarned) {
      scriptIsolationWarned = true;
      process.stderr.write(
        `[omk] script executor 不参与 skill isolation:allowedSkills=${JSON.stringify(allowedSkills)} 在自定义 executor "${command}" 下无效。\n`
        + '  如需 baseline 真正隔离，请用 --executor codex。\n',
      );
    }
    const input = JSON.stringify({ model, system: system || '', prompt });
    const start = Date.now();

    // mock 注入:复用 claude-cli 的物化逻辑(临时目录 + on-disk hook + mocks.json),把
    // settings / mcp-config / mocks 文件路径通过 env 暴露给脚本。脚本若包的是 Claude Code
    // 兼容 CLI,自行把 OMK_MOCK_SETTINGS_FILE 透传成 `--settings`(或把其中的 hook 打包成
    // `--plugin-dir` 插件)即可复用 omk 的 PreToolUse mock hook;不支持的脚本忽略这些 env
    // 即可(向后兼容)。env 是局部对象、不改 process.env,并发多 eval 各 spawn 独立快照、
    // 互不串台;临时目录由 mkdtemp 唯一命名,finally 里 cleanup 删除。
    const mockHandle = mocks && mocks.length > 0
      ? materializeForCliConfigDir(mocks, mocksBaseDir, !!mocksStrict)
      : null;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (mockHandle) {
      Object.assign(env, mockHandle.env);                       // OMK_MOCKS_FILE
      env.OMK_MOCK_SETTINGS_FILE = mockHandle.settingsFile;
      if (mockHandle.mcpConfigFile) env.OMK_MOCK_MCP_CONFIG_FILE = mockHandle.mcpConfigFile;
    }
    // 与 claude-cli / claude-sdk 对齐:每条返回路径(成功/解析失败/超时/中断/错误)都回填
    // mockStats,出错样本也能看到 mock 命中统计。readStats 内部已对缺文件/坏 JSON 兜底,
    // 这里再包一层 try/catch 防御(不让取统计反而把成功结果带崩)。必须在 finally cleanup
    // 删临时目录之前读 —— return 表达式先求值,再走 finally,顺序正确。
    const captureMockStats = (): ExecResult['mockStats'] | undefined => {
      if (!mockHandle) return undefined;
      try { return mockHandle.readStats(); } catch { return undefined; }
    };

    const { child, done } = spawnWithSigintPropagation(cmd, args, {
      env,
      timeoutMs,
      ...(cwd && { cwd }),
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);

    try {
      const r = await done;
      const durationMs = Date.now() - start;
      const ms = captureMockStats();
      let protocol: Record<string, unknown> | undefined;
      try {
        const data: unknown = JSON.parse(r.stdout);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const candidate = data as Record<string, unknown>;
          if (Object.hasOwn(candidate, 'ok') || Object.hasOwn(candidate, 'output')) {
            protocol = candidate;
          }
        }
      } catch {
        // Non-JSON stdout is the executor's plain model output.
      }

      if (protocol) {
        const metricsError = scriptProtocolMetricsError(protocol);
        if (metricsError) {
          return invalidScriptProtocolResult(metricsError, durationMs, ms);
        }
        const costReported = protocol.costUSD !== undefined;
        const tokenUsageReported = scriptProtocolReportsTokenUsage(protocol);
        if (protocol.ok !== undefined && typeof protocol.ok !== 'boolean') {
          return invalidScriptProtocolResult('"ok" must be boolean', durationMs, ms);
        }
        if (
          protocol.output !== undefined
          && protocol.output !== null
          && typeof protocol.output !== 'string'
        ) {
          return invalidScriptProtocolResult(
            '"output" must be string or null',
            durationMs,
            ms,
          );
        }
        if (protocol.error !== undefined && typeof protocol.error !== 'string') {
          return invalidScriptProtocolResult(
            '"error" must be string when present',
            durationMs,
            ms,
          );
        }
        const traceFields = scriptProtocolTraceFields(protocol);
        if (protocol.ok === false) {
          return validateScriptProtocolResult({
            ok: false,
            error: typeof protocol.error === 'string' && protocol.error
              ? protocol.error
              : 'script executor reported failure',
            output: typeof protocol.output === 'string' ? protocol.output : null,
            durationMs,
            durationApiMs: nonNegativeNumber(protocol.durationApiMs),
            inputTokens: nonNegativeInteger(protocol.inputTokens),
            outputTokens: nonNegativeInteger(protocol.outputTokens),
            cacheReadTokens: nonNegativeInteger(protocol.cacheReadTokens),
            cacheCreationTokens: nonNegativeInteger(protocol.cacheCreationTokens),
            ...(!tokenUsageReported && { tokenUsageReportedByExecutor: false }),
            costUSD: nonNegativeNumber(protocol.costUSD),
            ...(!costReported && { costReportedByExecutor: false }),
            stopReason: typeof protocol.stopReason === 'string' ? protocol.stopReason : 'error',
            numTurns: nonNegativeInteger(protocol.numTurns),
            ...traceFields,
            ...(ms && { mockStats: ms }),
          }, ms);
        }
        if (typeof protocol.output !== 'string') {
          return invalidScriptProtocolResult('"output" must be string', durationMs, ms);
        }
        if (!protocol.output.trim()) {
          return {
            ok: false,
            error: 'script executor completed without model output',
            output: null,
            durationMs,
            durationApiMs: nonNegativeNumber(protocol.durationApiMs),
            inputTokens: nonNegativeInteger(protocol.inputTokens),
            outputTokens: nonNegativeInteger(protocol.outputTokens),
            cacheReadTokens: nonNegativeInteger(protocol.cacheReadTokens),
            cacheCreationTokens: nonNegativeInteger(protocol.cacheCreationTokens),
            ...(!tokenUsageReported && { tokenUsageReportedByExecutor: false }),
            costUSD: nonNegativeNumber(protocol.costUSD),
            ...(!costReported && { costReportedByExecutor: false }),
            stopReason: 'error',
            numTurns: protocol.numTurns === undefined ? 1 : nonNegativeInteger(protocol.numTurns),
            ...(ms && { mockStats: ms }),
          };
        }
        return validateScriptProtocolResult({
          ok: true, output: protocol.output, durationMs,
          durationApiMs: nonNegativeNumber(protocol.durationApiMs),
          inputTokens: nonNegativeInteger(protocol.inputTokens),
          outputTokens: nonNegativeInteger(protocol.outputTokens),
          cacheReadTokens: nonNegativeInteger(protocol.cacheReadTokens),
          cacheCreationTokens: nonNegativeInteger(protocol.cacheCreationTokens),
          ...(!tokenUsageReported && { tokenUsageReportedByExecutor: false }),
          costUSD: nonNegativeNumber(protocol.costUSD),
          ...(!costReported && { costReportedByExecutor: false }),
          stopReason: typeof protocol.stopReason === 'string' ? protocol.stopReason : 'end',
          numTurns: protocol.numTurns === undefined ? 1 : nonNegativeInteger(protocol.numTurns),
          ...traceFields,
          ...(ms && { mockStats: ms }),
        }, ms);
      }

      const output = r.stdout.trim();
      if (!output) {
        return {
          ok: false,
          error: 'script executor completed without model output',
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
          numTurns: 1,
          ...(ms && { mockStats: ms }),
        };
      }
      return {
        ok: true, output, durationMs, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        tokenUsageReportedByExecutor: false,
        costUSD: 0, costReportedByExecutor: false,
        stopReason: 'end', numTurns: 1,
        ...(ms && { mockStats: ms }),
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const ms = captureMockStats();
      const details = err as SpawnHelperError;
      if (details.killedByTimeout) return { ...timeoutExecResult(timeoutMs, durationMs), ...(ms && { mockStats: ms }) };
      if (details.killedBySignal) return { ...interruptedExecResult(durationMs), ...(ms && { mockStats: ms }) };
      const stderr = (details.stderr || '').trim();
      return {
        ok: false,
        error: stderr || details.message || `executor exited with code ${details.code ?? '?'}`,
        durationMs, durationApiMs: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        tokenUsageReportedByExecutor: false,
        costUSD: 0, costReportedByExecutor: false, output: null, stopReason: 'error', numTurns: 0,
        ...(ms && { mockStats: ms }),
      };
    } finally {
      mockHandle?.cleanup();
    }
  };
}
