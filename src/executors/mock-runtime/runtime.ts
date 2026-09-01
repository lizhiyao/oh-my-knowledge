/**
 * Mock runtime — Sample.mocks 落地的核心逻辑。
 *
 * 两条路径:
 *   1) `buildSdkHookCallback(mocks, baseDir)`
 *      → 给 claude-sdk executor 用,返回 in-process PreToolUse HookCallback。
 *      纯内存,零 IO,零 spawn 开销。
 *
 *   2) `materializeForCliConfigDir(mocks, baseDir)`
 *      → 给 claude-cli executor 用,mktemp 一个临时 CLAUDE_CONFIG_DIR,
 *      在里面写 settings.json + on-disk hook 脚本 + mocks.json,返回 cleanup。
 *      claude 子进程退出后(成功/失败/超时/SIGINT),cleanup 必删整个临时目录。
 *
 * 共用核心:`matchMock(mocks, toolName, toolInput, callCounter)` 命中规则评估。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mock, MockReturn } from '../../types/eval.js';
import { incrementRecordCount, setOwnRecordValue } from '../../shared/record-count.js';
import { toolIdentityMatches } from '../../shared/tool-identity.js';

// ─── Match logic ────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

/** file_path 后缀匹配:actual 完全等于 suffix,或 actual 在 path-separator 后以 suffix 结尾。
 *  避免 'state.json' 误匹配 'bad-state.json'。两端都先 expandHome。
 *  例:suffix='tasks/foo/state.json' 命中 'tasks/foo/state.json' / '/abs/x/tasks/foo/state.json' /
 *      'C:\\proj\\tasks\\foo\\state.json' (Windows backslash 也接受)。 */
function matchesFilePathSuffix(actualRaw: string, suffixRaw: string): boolean {
  const actual = expandHome(actualRaw);
  const suffix = expandHome(suffixRaw);
  if (actual === suffix) return true;
  if (!actual.endsWith(suffix)) return false;
  const boundaryIdx = actual.length - suffix.length - 1;
  const sep = actual.charAt(boundaryIdx);
  return sep === '/' || sep === '\\';
}

/** glob 匹配(只支持 `*` 通配,不支持 `**` / `?` / `[...]`,够用且无依赖)。
 *  使用 dotAll 标志(`s`),让 `*` 也能跨换行匹配 — LLM 经常用反斜杠续行写多行 bash,
 *  不带 `s` 时单行 glob 会全部漏掉(integration-tool-deploy eval 上首次发现这个坑)。 */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$', 's');
  return re.test(value);
}

/** deep equal 子集匹配:expected 的每个 key/value 在 actual 中存在且相等(actual 可有更多字段)。 */
/** 数组 deep-equal:长度相等 + 每个元素递归比较(支持嵌套数组 / object)。 */
function arraysDeepEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!deepEqual(a[i], b[i])) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return arraysDeepEqual(a, b);
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null
      && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

function matchesInputSubset(expected: Record<string, unknown>, actual: unknown): boolean {
  if (typeof actual !== 'object' || actual === null) return false;
  const a = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    if (Array.isArray(v)) {
      // 数组 deep-equal,不要靠 === 引用比较 — 不同 sample 实例的同样数组永远不会等
      if (!Array.isArray(a[k]) || !arraysDeepEqual(v, a[k] as unknown[])) return false;
    } else if (typeof v === 'object' && v !== null) {
      if (!matchesInputSubset(v as Record<string, unknown>, a[k])) return false;
    } else if (a[k] !== v) {
      return false;
    }
  }
  return true;
}

function anyStringContains(obj: unknown, needle: string): boolean {
  if (typeof obj === 'string') return obj.toLowerCase().includes(needle);
  if (Array.isArray(obj)) return obj.some((item) => anyStringContains(item, needle));
  if (typeof obj === 'object' && obj !== null)
    return Object.values(obj as Record<string, unknown>).some((v) => anyStringContains(v, needle));
  return false;
}

/** 单条 mock 是否命中给定 tool 调用。 */
export function isMockHit(mock: Mock, toolName: string, toolInput: unknown): boolean {
  if (mock.tool !== '*' && !toolIdentityMatches(mock.tool, toolName)) return false;
  const m = mock.match;
  if (!m) return true;
  const ti = (toolInput || {}) as Record<string, unknown>;

  if (m.file_path !== undefined) {
    if (typeof ti.file_path !== 'string') return false;
    if (expandHome(ti.file_path) !== expandHome(m.file_path)) return false;
  }
  if (m.file_path_endswith !== undefined) {
    if (typeof ti.file_path !== 'string') return false;
    if (!matchesFilePathSuffix(ti.file_path, m.file_path_endswith)) return false;
  }
  if (m.url !== undefined) {
    if (ti.url !== m.url) return false;
  }
  if (m.url_glob !== undefined) {
    if (typeof ti.url !== 'string' || !globMatch(m.url_glob, ti.url)) return false;
  }
  if (m.command_glob !== undefined) {
    if (typeof ti.command !== 'string' || !globMatch(m.command_glob, ti.command)) return false;
  }
  if (m.input !== undefined) {
    if (!matchesInputSubset(m.input, toolInput)) return false;
  }
  if (m.input_contains !== undefined) {
    if (!anyStringContains(toolInput, m.input_contains.toLowerCase())) return false;
  }
  return true;
}

// ─── Return resolution ──────────────────────────────────────────────────────

/** 把 mock 的 return / return_file / return_seq 解析成可序列化字符串(LLM 看到的 tool_result)。 */
export function resolveMockReturn(
  mock: Mock,
  hitCount: number,
  baseDir?: string,
): string {
  // return_seq 优先,按 hit 序号取(超出长度 fallback 到 return / return_file)
  if (mock.return_seq && hitCount < mock.return_seq.length) {
    return stringifyReturn(mock.return_seq[hitCount]);
  }
  if (mock.return !== undefined) {
    return stringifyReturn(mock.return);
  }
  if (mock.return_file) {
    const fpath = isAbsolute(mock.return_file)
      ? mock.return_file
      : resolve(baseDir || process.cwd(), mock.return_file);
    if (!existsSync(fpath)) {
      return `[omk-mock-error] return_file not found: ${fpath}`;
    }
    return readFileSync(fpath, 'utf8');
  }
  return '';  // 没配 return,给空串(LLM 收到空 tool_result)
}

function stringifyReturn(r: MockReturn): string {
  if (typeof r === 'string') return r;
  // Bash 风格对象:exit !=0 时格式化成 LLM 能理解的"失败"输出
  // 这里统一序列化成 JSON,LLM 能从结构化字段读到 stdout/stderr/exit
  return JSON.stringify(r);
}

// ─── SDK hook factory(in-process)─────────────────────────────────────────

/** SDK PreToolUse hook input(精简版,只用我们关心的字段)。 */
interface SdkHookInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
}

/** SDK PreToolUse hook output:`block` 决策 + permissionDecisionReason 当 mock content。 */
interface SdkHookOutput {
  continue?: boolean;
  decision?: 'block' | 'approve';
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'deny' | 'allow' | 'ask';
    permissionDecisionReason?: string;
  };
  systemMessage?: string;
}

export interface SdkHookHandle {
  /** 给 SDK options.hooks.PreToolUse 用的 callback。 */
  callback: (input: SdkHookInput) => Promise<SdkHookOutput>;
  /** 拦截命中统计(诊断用)。 */
  stats: { hits: number; misses: number; perMock: Record<string, number> };
}

/**
 * 把 mocks 转成 SDK in-process PreToolUse hook callback。
 *
 * 命中策略:strict 模式下不命中的工具调用直接 deny(防意外真调)。
 * 默认非 strict:不命中放行(原生工具继续真跑)— 适合"部分 mock,部分真跑"场景。
 *
 * @param mocks  Sample.mocks 数组
 * @param baseDir  解析 mock.return_file 的相对路径锚点
 * @param strict  true → 不命中 deny;false → 不命中放行(default)
 */
export function buildSdkHookCallback(
  mocks: Mock[] | undefined,
  baseDir?: string,
  strict = false,
): SdkHookHandle {
  const stats = { hits: 0, misses: 0, perMock: {} as Record<string, number> };
  const hitCounters = new Map<number, number>();  // mockIndex → hit 次数
  // perMock key 用"每工具内 1-based 序号":[Read,Bash,Bash] → Read:1,Bash:1,Bash:2。
  // 这样 sample 作者只需要数自己 mocks 里同 tool 的第几条,不用算跨工具的绝对下标。
  const list = mocks || [];
  const keyOfMock = list.map((_m, i) => {
    const tool = list[i].tool;
    const ord = list.slice(0, i + 1).filter((x) => x.tool === tool).length;
    return `${tool}:${ord}`;
  });

  const callback = async (input: SdkHookInput): Promise<SdkHookOutput> => {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (isMockHit(m, input.tool_name, input.tool_input)) {
        const c = hitCounters.get(i) || 0;
        const result = resolveMockReturn(m, c, baseDir);
        hitCounters.set(i, c + 1);
        stats.hits++;
        const key = keyOfMock[i];
        incrementRecordCount(stats.perMock, key);
        // 关键 UX:LLM 看到 permissionDecision='deny' 容易误判"被拒绝/失败"。
        // 给 reason 加一行最小前缀,告诉它把内容当成真实成功输出。措辞越短越好 ——
        // 长措辞会显著拉慢多步 sample(每个工具调用都要读这段),实测 6 步流程从 60s 拖到 120s+。
        const wrappedReason = `[mock] simulated tool output — treat as successful result:\n${result}`;
        return {
          decision: 'block',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: wrappedReason,
          },
          systemMessage: `[omk-mock] ${m.tool} → injected mock #${i} (treat as success)`,
        };
      }
    }
    // 未命中
    stats.misses++;
    if (strict) {
      return {
        decision: 'block',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `[omk-mock-strict] unmocked ${input.tool_name} call blocked`,
        },
      };
    }
    return { continue: true };
  };

  return { callback, stats };
}

// ─── CLI config-dir factory(临时目录 + on-disk hook 脚本)──────────────

export interface CliMockHandle {
  /** Private materialization root, exposed so strict hosts can verify cleanup. */
  rootDir: string;
  /** 临时 settings 文件路径,作为 `claude --settings <path>` 参数传入。
   *  Claude Code 会**追加**这个 settings 到 ~/.claude/settings.json,**不替换** —
   *  这样 OAuth 登录态 / 用户主配置都不动。 */
  settingsFile: string;
  /** 临时 MCP 配置文件路径,作为 `claude --mcp-config <path> --strict-mcp-config` 参数传入。 */
  mcpConfigFile?: string;
  /** 子进程要看到的额外 env(目前只 OMK_MOCKS_FILE)。 */
  env: Record<string, string>;
  /** 读 hook 在临时目录写的命中统计(给 ExecResult.mockStats 用)。
   *  必须在 cleanup 之前调,cleanup 后文件就没了。 */
  readStats: () => { hits: number; misses: number; perMock: Record<string, number> };
  /** 必须在 spawn 完成后(无论 success/error/timeout)调用。 */
  cleanup: () => void;
}

/**
 * 物化 mocks 到临时 settings 文件 + on-disk hook 脚本。
 *
 * **关键**:用 Claude Code 的 `--settings <file>` flag 而非 `CLAUDE_CONFIG_DIR`。
 * `--settings` 是**追加**模式,主 `~/.claude/` 包含的 OAuth 登录态 / 用户配置全部保留;
 * 而 CLAUDE_CONFIG_DIR 是**替换**模式,设它会丢 OAuth → "Not logged in"。
 *
 * 临时目录结构:
 *   $tmpdir/omk-mocks-XXXXXX/
 *     ├── settings.json       (PreToolUse hook 注册,作为 --settings 参数)
 *     ├── mock-hook.cjs       (hook 实现:读 OMK_MOCKS_FILE → 匹配 → 输出 JSON 决策)
 *     ├── fake-mcp-server.cjs (可选:给 mcp__server__tool mock 注册一次性 fake MCP)
 *     ├── mcp.json            (可选:作为 --mcp-config 参数)
 *     └── mocks.json          (mocks 序列化 + baseDir + strict)
 *
 * cleanup 必删整个目录。executor 用 try / finally 保证执行。
 *
 * @param nodeExecutable hook／fake MCP 使用的 Node launcher；Core adapter 传绝对路径
 */
export function materializeForCliConfigDir(
  mocks: Mock[] | undefined,
  baseDir?: string,
  strict = false,
  nodeExecutable = 'node',
): CliMockHandle | null {
  if (!mocks || mocks.length === 0) return null;

  const configDir = mkdtempSync(join(tmpdir(), 'omk-mocks-'));
  try {
    const mocksFile = join(configDir, 'mocks.json');
    const settingsFile = join(configDir, 'settings.json');
    const hookScript = join(configDir, 'mock-hook.cjs');
    const mcpServerScript = join(configDir, 'fake-mcp-server.cjs');
    const mcpConfigFile = join(configDir, 'mcp.json');

    const hookSource = readMockHookTemplate();
    writeFileSync(hookScript, hookSource, 'utf8');

    writeFileSync(mocksFile, JSON.stringify({ mocks, baseDir, strict }, null, 2));

    const shellQuote = (value: string): string => process.platform === 'win32'
      ? `"${value.replaceAll('"', '""')}"`
      : `'${value.replaceAll("'", "'\\''")}'`;
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [
              {
                type: 'command',
                command: `${shellQuote(nodeExecutable)} ${shellQuote(hookScript)}`,
              },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    const fakeMcpServers = collectFakeMcpServers(mocks);
    const hasFakeMcp = fakeMcpServers.size > 0;
    if (hasFakeMcp) {
      writeFileSync(mcpServerScript, fakeMcpServerSource(), 'utf8');
      const mcpServers: Record<
        string,
        { command: string; args: string[]; env: Record<string, string> }
      > = {};
      for (const serverName of fakeMcpServers.keys()) {
        setOwnRecordValue(mcpServers, serverName, {
          command: nodeExecutable,
          args: [mcpServerScript, serverName],
          env: { OMK_MOCKS_FILE: mocksFile },
        });
      }
      writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers }, null, 2));
    }

    const statsFile = join(configDir, 'hits.json');
    const readStats = (): { hits: number; misses: number; perMock: Record<string, number> } => {
      if (!existsSync(statsFile)) {
        return { hits: 0, misses: 0, perMock: {} };
      }
      try {
        const raw = JSON.parse(readFileSync(statsFile, 'utf8'));
        return {
          hits: raw.hits_total || 0,
          misses: raw.misses_total || 0,
          perMock: raw.perMock || {},
        };
      } catch {
        return { hits: 0, misses: 0, perMock: {} };
      }
    };

    const cleanup = () => {
      try {
        rmSync(configDir, { recursive: true, force: true });
      } catch { /* swallow — best effort */ }
    };

    return {
      rootDir: configDir,
      settingsFile,
      ...(hasFakeMcp && { mcpConfigFile }),
      env: { OMK_MOCKS_FILE: mocksFile },
      readStats,
      cleanup,
    };
  } catch (error) {
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* preserve cause */ }
    throw error;
  }
}

function parseMcpToolName(toolName: string): { serverName: string; toolName: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.lastIndexOf('__');
  if (sep <= 0 || sep === rest.length - 2) return null;
  return { serverName: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
}

function collectFakeMcpServers(mocks: Mock[]): Map<string, Set<string>> {
  const servers = new Map<string, Set<string>>();
  for (const mock of mocks) {
    const parsed = parseMcpToolName(mock.tool);
    if (!parsed) continue;
    const tools = servers.get(parsed.serverName) ?? new Set<string>();
    tools.add(parsed.toolName);
    servers.set(parsed.serverName, tools);
  }
  return servers;
}

function fakeMcpServerSource(): string {
  return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const serverName = process.argv[2];
const mocksFile = process.env.OMK_MOCKS_FILE;
const rl = readline.createInterface({ input: process.stdin });

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function recordCount(record, key) {
  const value = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
function incrementRecordCount(record, key, amount = 1) {
  const next = recordCount(record, key) + amount;
  Object.defineProperty(record, key, {
    value: next,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return next;
}
function globMatch(pattern, value) {
  const escaped = pattern.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  return new RegExp('^' + escaped.replace(/\\*/g, '.*') + '$', 's').test(value);
}
function arraysDeepEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
  return true;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return arraysDeepEqual(a, b);
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}
function matchesInputSubset(expected, actual) {
  if (typeof actual !== 'object' || actual === null) return false;
  for (const k of Object.keys(expected)) {
    const v = expected[k];
    if (Array.isArray(v)) {
      if (!Array.isArray(actual[k]) || !arraysDeepEqual(v, actual[k])) return false;
    } else if (typeof v === 'object' && v !== null) {
      if (!matchesInputSubset(v, actual[k])) return false;
    } else if (actual[k] !== v) {
      return false;
    }
  }
  return true;
}
function anyStringContains(obj, needle) {
  if (typeof obj === 'string') return obj.toLowerCase().includes(needle);
  if (Array.isArray(obj)) return obj.some((item) => anyStringContains(item, needle));
  if (typeof obj === 'object' && obj !== null) return Object.values(obj).some((v) => anyStringContains(v, needle));
  return false;
}
const BUILTIN_TOOL_ALIASES = {
  bash: 'Bash',
  shell: 'Bash',
  exec_command: 'Bash',
  command_execution: 'Bash',
  read: 'Read',
  file_read: 'Read',
  grep: 'Grep',
  edit: 'Edit',
  apply_patch: 'Edit',
  file_change: 'Edit',
  write: 'Write',
  file_write: 'Write',
  view_image: 'ViewImage',
  viewimage: 'ViewImage',
  write_stdin: 'WriteStdin',
  writestdin: 'WriteStdin',
  web_search: 'WebSearch',
  websearch: 'WebSearch',
};
function canonicalToolName(name) {
  const sourceName = String(name);
  const builtin = BUILTIN_TOOL_ALIASES[sourceName.toLowerCase()];
  if (builtin) return builtin;
  const parts = sourceName.split('__').filter(Boolean);
  if (parts[0] === 'mcp' && parts.length > 2) {
    const providerParts = parts.slice(1, -1);
    if (providerParts[0] === 'codex_apps' && providerParts.length > 1) providerParts.shift();
    return providerParts.join('.') + '.' + parts[parts.length - 1];
  }
  return sourceName;
}
function toolIdentityMatches(expectedName, runtimeName) {
  return expectedName === runtimeName
    || canonicalToolName(expectedName) === canonicalToolName(runtimeName);
}
function isMockHit(mock, toolName, toolInput) {
  if (mock.tool !== '*' && !toolIdentityMatches(mock.tool, toolName)) return false;
  const m = mock.match;
  if (!m) return true;
  const ti = toolInput || {};
  if (m.input !== undefined && !matchesInputSubset(m.input, toolInput)) return false;
  if (m.input_contains !== undefined && !anyStringContains(toolInput, String(m.input_contains).toLowerCase())) return false;
  if (m.command_glob !== undefined && (typeof ti.command !== 'string' || !globMatch(m.command_glob, ti.command))) return false;
  if (m.url !== undefined && ti.url !== m.url) return false;
  if (m.url_glob !== undefined && (typeof ti.url !== 'string' || !globMatch(m.url_glob, ti.url))) return false;
  return true;
}
function stringifyReturn(r) { return typeof r === 'string' ? r : JSON.stringify(r); }
function resolveMockReturn(mock, hitCount, baseDir) {
  if (mock.return_seq && hitCount < mock.return_seq.length) return stringifyReturn(mock.return_seq[hitCount]);
  if (mock.return !== undefined) return stringifyReturn(mock.return);
  if (mock.return_file) {
    const fpath = path.isAbsolute(mock.return_file) ? mock.return_file : path.resolve(baseDir || process.cwd(), mock.return_file);
    if (!fs.existsSync(fpath)) return '[omk-mock-error] return_file not found: ' + fpath;
    return fs.readFileSync(fpath, 'utf8');
  }
  return '';
}
function loadConfig() {
  if (!mocksFile || !fs.existsSync(mocksFile)) return { mocks: [], strict: false };
  return JSON.parse(fs.readFileSync(mocksFile, 'utf8'));
}
function toolNameFromFullName(fullName) {
  const prefix = 'mcp__' + serverName + '__';
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : null;
}
function inferJsonSchema(value) {
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') return { type: 'number' };
  if (Array.isArray(value)) return { type: 'array' };
  if (typeof value === 'object' && value !== null) return { type: 'object', additionalProperties: true };
  return { type: 'string' };
}
function schemaForTool(name, mocks) {
  const properties = {};
  const required = [];
  for (const m of mocks) {
    if (toolNameFromFullName(m.tool) !== name) continue;
    const input = m.match && m.match.input;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) continue;
    for (const k of Object.keys(input)) {
      Object.defineProperty(properties, k, {
        value: inferJsonSchema(input[k]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (!required.includes(k)) required.push(k);
    }
  }
  if (name === 'message') {
    for (const k of ['action', 'channel', 'target', 'message']) {
      if (!properties[k]) properties[k] = { type: 'string' };
      if (!required.includes(k)) required.push(k);
    }
  }
  return { type: 'object', properties, required, additionalProperties: true };
}
function listTools() {
  const cfg = loadConfig();
  const names = new Set();
  const mocks = cfg.mocks || [];
  for (const m of mocks) {
    const n = toolNameFromFullName(m.tool);
    if (n) names.add(n);
  }
  return Array.from(names).map((name) => ({
    name,
    description: 'omk fake MCP tool for ' + serverName + '/' + name,
    inputSchema: schemaForTool(name, mocks),
  }));
}
function recordHit(mockKey) {
  if (!mocksFile) return;
  const statsFile = path.join(path.dirname(mocksFile), 'hits.json');
  let stats = { perMock: {}, hits_total: 0, misses_total: 0 };
  try { if (fs.existsSync(statsFile)) stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch {}
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) stats = {};
  if (!stats.perMock || typeof stats.perMock !== 'object' || Array.isArray(stats.perMock)) stats.perMock = {};
  incrementRecordCount(stats.perMock, mockKey);
  stats.hits_total = recordCount(stats, 'hits_total') + 1;
  fs.writeFileSync(statsFile, JSON.stringify(stats));
}
function recordMiss() {
  if (!mocksFile) return;
  const statsFile = path.join(path.dirname(mocksFile), 'hits.json');
  let stats = { perMock: {}, hits_total: 0, misses_total: 0 };
  try { if (fs.existsSync(statsFile)) stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch {}
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) stats = {};
  stats.misses_total = recordCount(stats, 'misses_total') + 1;
  fs.writeFileSync(statsFile, JSON.stringify(stats));
}
const hitCounters = new Map();
function callTool(name, args) {
  const cfg = loadConfig();
  const fullName = 'mcp__' + serverName + '__' + name;
  const mocks = cfg.mocks || [];
  const baseDir = cfg.baseDir;
  const ord = new Map();
  for (const m of mocks) ord.set(m.tool, 0);
  for (let i = 0; i < mocks.length; i++) {
    const m = mocks[i];
    ord.set(m.tool, (ord.get(m.tool) || 0) + 1);
    if (isMockHit(m, fullName, args || {})) {
      const key = fullName + ':' + ord.get(m.tool);
      recordHit(key);
      const c = hitCounters.get(i) || 0;
      const result = resolveMockReturn(m, c, baseDir);
      hitCounters.set(i, c + 1);
      return result;
    }
  }
  recordMiss();
  if (cfg.strict) return '[omk-mock-strict] unmocked ' + fullName + ' call blocked';
  return '';
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'omk-fake-' + serverName, version: '0.0.1' } } });
  } else if (msg.method === 'notifications/initialized') {
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: listTools() } });
  } else if (msg.method === 'tools/call') {
    const result = callTool(msg.params && msg.params.name, msg.params && msg.params.arguments);
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } });
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
`;
}

let _hookTemplate: string | null = null;
function readMockHookTemplate(): string {
  if (_hookTemplate) return _hookTemplate;
  // hook 跟本文件共置在 src/executors/mock-runtime/(开发模式)或
  // dist/executors/mock-runtime/(npm 安装模式),
  // build script 把 mock-hook.cjs 复制到 dist/。读 sibling 路径就行,不再依赖外层 assets/。
  const here = dirname(fileURLToPath(import.meta.url));
  const hookPath = resolve(here, 'mock-hook.cjs');
  if (!existsSync(hookPath)) {
    throw new Error(`omk-mock: mock-hook.cjs not found at ${hookPath}. ` +
      `如果是从源码运行,确认 src/executors/mock-runtime/mock-hook.cjs 存在;如果是 npm 安装,` +
      `package 漏发了 hook,提 issue 并附 omk 版本。`);
  }
  _hookTemplate = readFileSync(hookPath, 'utf8');
  return _hookTemplate;
}

// 测试用 export:供 packaging smoke test 验证 hook 能被解析
export const _readMockHookTemplateForTest = readMockHookTemplate;

// ─── 工具:在不影响主目录的前提下创建临时 dir(测试也要)─────────────

export function _testMakeTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omk-mocks-test-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}
