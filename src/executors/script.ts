import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { ExecResult, ExecutorFn, ExecutorInput } from '../types/index.js';
import { materializeForCliConfigDir } from '../eval-core/mocks-runtime.js';
import {
  DEFAULT_TIMEOUT_MS,
  interruptedExecResult,
  spawnWithSigintPropagation,
  timeoutExecResult,
  type SpawnHelperError,
} from './shared.js';

// script executor 由用户自定义,omk 无法保证它实现 skill 隔离。
// 任何 allowedSkills(包括 [])下都 stderr 一次性 warn,不阻塞执行,
// 让用户知道 strict-baseline / 显式 allowedSkills 在 script executor 下静默无效。
let scriptIsolationWarned = false;

function resolvesBareFileArgs(commandPath: string): boolean {
  const name = basename(commandPath).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  return new Set(['node', 'python', 'python2', 'python3', 'bash', 'sh', 'zsh', 'ruby', 'perl', 'php', 'bun', 'deno'])
    .has(name);
}

function resolveExecutorPath(part: string, baseCwd: string, options: { resolveBare?: boolean } = {}): string {
  if (isAbsolute(part)) return part;
  if (part.startsWith('-')) return part;
  const pathLike = part.includes('/') || part.startsWith('.');
  if (!pathLike && !options.resolveBare) return part;
  const candidate = resolve(baseCwd, part);
  return existsSync(candidate) ? candidate : part;
}

export function createScriptExecutor(command: string): ExecutorFn {
  const baseCwd = process.cwd();
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [command];
  const cmd = resolveExecutorPath(parts[0].replace(/^["']|["']$/g, ''), baseCwd);
  const resolveBareArgs = resolvesBareFileArgs(cmd);
  const args = parts.slice(1)
    .map((a) => a.replace(/^["']|["']$/g, ''))
    .map((a) => resolveExecutorPath(a, baseCwd, { resolveBare: resolveBareArgs }));

  return async function scriptExecutor({ model, system, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS, allowedSkills, mocks, mocksBaseDir, mocksStrict }: ExecutorInput): Promise<ExecResult> {
    if (allowedSkills !== undefined && !scriptIsolationWarned) {
      scriptIsolationWarned = true;
      process.stderr.write(
        `[omk] script executor 不参与 skill isolation:allowedSkills=${JSON.stringify(allowedSkills)} 在自定义 executor "${command}" 下无效。\n`
        + `  如需 baseline 真正隔离,请用 --executor claude-sdk(或 claude-cli degraded mode)。\n`,
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
    child.stdin?.write(input);
    child.stdin?.end();

    try {
      const r = await done;
      const durationMs = Date.now() - start;
      const ms = captureMockStats();
      try {
        const data = JSON.parse(r.stdout);
        return {
          ok: true, output: data.output || '', durationMs,
          durationApiMs: data.durationApiMs || 0,
          inputTokens: data.inputTokens || 0, outputTokens: data.outputTokens || 0,
          cacheReadTokens: data.cacheReadTokens || 0, cacheCreationTokens: data.cacheCreationTokens || 0,
          costUSD: data.costUSD || 0, stopReason: data.stopReason || 'end', numTurns: data.numTurns || 1,
          ...(ms && { mockStats: ms }),
        };
      } catch {
        return {
          ok: true, output: r.stdout.trim(), durationMs, durationApiMs: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          costUSD: 0, stopReason: 'end', numTurns: 1,
          ...(ms && { mockStats: ms }),
        };
      }
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
        costUSD: 0, output: null, stopReason: 'error', numTurns: 0,
        ...(ms && { mockStats: ms }),
      };
    } finally {
      mockHandle?.cleanup();
    }
  };
}
