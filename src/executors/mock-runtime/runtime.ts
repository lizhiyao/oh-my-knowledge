/** Custom script mock manifests and optional fake MCP servers. */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mock } from '../contracts/mock.js';
import { setOwnRecordValue } from '../../shared/record-count.js';

export interface ScriptMockHandle {
  /** Private materialization root, exposed so strict hosts can verify cleanup. */
  rootDir: string;
  /** 自定义脚本可消费的临时 MCP 配置。 */
  mcpConfigFile?: string;
  /** 子进程要看到的额外 env(目前只 OMK_MOCKS_FILE)。 */
  env: Record<string, string>;
  /** 读脚本或 fake MCP server 在临时目录写的命中统计(给 ExecResult.mockStats 用)。
   *  必须在 cleanup 之前调,cleanup 后文件就没了。 */
  readStats: () => { hits: number; misses: number; perMock: Record<string, number> };
  /** 必须在 spawn 完成后(无论 success/error/timeout)调用。 */
  cleanup: () => void;
}

/** 物化自定义脚本使用的 mock manifest 与可选 MCP 配置。 */
export function materializeForScript(
  mocks: Mock[] | undefined,
  baseDir?: string,
  strict = false,
  nodeExecutable = 'node',
): ScriptMockHandle | null {
  if (!mocks || mocks.length === 0) return null;

  const configDir = mkdtempSync(join(tmpdir(), 'omk-mocks-'));
  try {
    const mocksFile = join(configDir, 'mocks.json');
    const mcpServerScript = join(configDir, 'fake-mcp-server.cjs');
    const mcpConfigFile = join(configDir, 'mcp.json');

    writeFileSync(mocksFile, JSON.stringify({ mocks, baseDir, strict }, null, 2));

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
const os = require('os');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');
const readline = require('readline');
const serverName = process.argv[2];
const mocksFile = process.env.OMK_MOCKS_FILE;
const rl = readline.createInterface({ input: process.stdin });

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function recordCount(record, key) {
  const value = Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid mock counter');
  return value;
}
function incrementRecordCount(record, key, amount = 1) {
  const next = recordCount(record, key) + amount;
  if (!Number.isSafeInteger(next)) throw new Error('mock counter exceeded its range');
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
  if (m.file_path !== undefined && (typeof ti.file_path !== 'string' || expandHome(ti.file_path) !== expandHome(m.file_path))) return false;
  if (m.file_path_endswith !== undefined && (typeof ti.file_path !== 'string' || !matchesFilePathSuffix(ti.file_path, m.file_path_endswith))) return false;
  if (m.input !== undefined && !matchesInputSubset(m.input, toolInput)) return false;
  if (m.input_contains !== undefined && !anyStringContains(toolInput, String(m.input_contains).toLowerCase())) return false;
  if (m.command_glob !== undefined && (typeof ti.command !== 'string' || !globMatch(m.command_glob, ti.command))) return false;
  if (m.url !== undefined && ti.url !== m.url) return false;
  if (m.url_glob !== undefined && (typeof ti.url !== 'string' || !globMatch(m.url_glob, ti.url))) return false;
  return true;
}
function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}
function matchesFilePathSuffix(actual, suffix) {
  const value = expandHome(actual);
  const expected = expandHome(suffix);
  if (value === expected) return true;
  if (!value.endsWith(expected)) return false;
  const separator = value.charCodeAt(value.length - expected.length - 1);
  return separator === 47 || separator === 92;
}
function stringifyReturn(r) { return typeof r === 'string' ? r : JSON.stringify(r); }
function resolveMockReturn(mock, hitCount, baseDir) {
  if (mock.return_seq && mock.return_seq.length > 0) {
    return stringifyReturn(mock.return_seq[Math.min(hitCount, mock.return_seq.length - 1)]);
  }
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
const lockSleep = new Int32Array(new SharedArrayBuffer(4));
// This state lives only for one invocation. Never recover a possibly live holder;
// a crashed holder fails later calls within 5s, and invocation cleanup removes it.
function recordCall(mockKey) {
  if (!mocksFile) throw new Error('mock manifest is unavailable');
  const statsFile = path.join(path.dirname(mocksFile), 'hits.json');
  const lockDir = statsFile + '.lock';
  const deadline = performance.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lockDir); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) throw new Error('shared mock state is locked');
      Atomics.wait(lockSleep, 0, 0, 10);
    }
  }
  const temporary = statsFile + '.' + randomUUID() + '.tmp';
  try {
    const stats = fs.existsSync(statsFile)
      ? JSON.parse(fs.readFileSync(statsFile, 'utf8'))
      : { perMock: {}, hits_total: 0, misses_total: 0 };
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)
        || !stats.perMock || typeof stats.perMock !== 'object' || Array.isArray(stats.perMock)) {
      throw new Error('shared mock state is invalid');
    }
    const previous = mockKey === undefined ? 0 : recordCount(stats.perMock, mockKey);
    if (mockKey === undefined) {
      incrementRecordCount(stats, 'misses_total');
    } else {
      incrementRecordCount(stats.perMock, mockKey);
      incrementRecordCount(stats, 'hits_total');
    }
    fs.writeFileSync(temporary, JSON.stringify(stats), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, statsFile);
    return previous;
  } finally {
    try {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } finally {
      fs.rmdirSync(lockDir);
    }
  }
}
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
      const key = m.tool + ':' + ord.get(m.tool);
      const count = recordCall(key);
      return resolveMockReturn(m, count, baseDir);
    }
  }
  recordCall();
  if (cfg.strict) return '[omk-mock-strict] unmocked ' + fullName + ' call blocked';
  return '';
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'omk-fake-' + serverName, version: '0.0.2' } } });
  } else if (msg.method === 'notifications/initialized') {
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: listTools() } });
  } else if (msg.method === 'tools/call') {
    try {
      const result = callTool(msg.params && msg.params.name, msg.params && msg.params.arguments);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } });
    } catch {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Mock execution failed; shared state or fixture is unavailable.' } });
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: {} });
  }
});
`;
}
