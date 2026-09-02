#!/usr/bin/env node
/**
 * omk-mock PreToolUse hook (CLI fallback path).
 *
 * 由 src/executors/mock-runtime/runtime.ts:materializeForCliConfigDir 写到临时
 * CLAUDE_CONFIG_DIR/mock-hook.cjs。Claude Code 子进程会以 hook 形式调它,
 * stdin 收 PreToolUseHookInput,stdout 出 PreToolUseHookOutput JSON。
 *
 * 该脚本是无状态的 — 所有规则从 OMK_MOCKS_FILE 文件读。命中状态(状态机用)
 * 通过同目录下的 hits.json 持久化(同一 spawn 内多次 hook 调用共享)。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

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

function expandHome(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

/** 与 mocks-runtime.ts 的 matchesFilePathSuffix 对齐 — 完全相等或路径分隔符后缀。 */
function matchesFilePathSuffix(actualRaw, suffixRaw) {
  const actual = expandHome(actualRaw);
  const suffix = expandHome(suffixRaw);
  if (actual === suffix) return true;
  if (!actual.endsWith(suffix)) return false;
  const sep = actual.charAt(actual.length - suffix.length - 1);
  return sep === '/' || sep === '\\';
}

function globMatch(pattern, value) {
  // 与 SDK 路径(mocks-runtime.ts)对齐:dotAll 让 `*` 跨换行匹配多行 bash。
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$', 's').test(value);
}

function arraysDeepEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
  return true;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return arraysDeepEqual(a, b);
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null
      && !Array.isArray(a) && !Array.isArray(b)) {
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
  if (Array.isArray(obj)) return obj.some(function(item) { return anyStringContains(item, needle); });
  if (typeof obj === 'object' && obj !== null) {
    return Object.values(obj).some(function(v) { return anyStringContains(v, needle); });
  }
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
  if (m.file_path !== undefined) {
    if (typeof ti.file_path !== 'string') return false;
    if (expandHome(ti.file_path) !== expandHome(m.file_path)) return false;
  }
  if (m.file_path_endswith !== undefined) {
    if (typeof ti.file_path !== 'string') return false;
    if (!matchesFilePathSuffix(ti.file_path, m.file_path_endswith)) return false;
  }
  if (m.url !== undefined && ti.url !== m.url) return false;
  if (m.url_glob !== undefined) {
    if (typeof ti.url !== 'string' || !globMatch(m.url_glob, ti.url)) return false;
  }
  if (m.command_glob !== undefined) {
    if (typeof ti.command !== 'string' || !globMatch(m.command_glob, ti.command)) return false;
  }
  if (m.input !== undefined && !matchesInputSubset(m.input, toolInput)) return false;
  if (m.input_contains !== undefined) {
    if (!anyStringContains(toolInput, m.input_contains.toLowerCase())) return false;
  }
  return true;
}

function stringifyReturn(r) {
  if (typeof r === 'string') return r;
  return JSON.stringify(r);
}

function resolveMockReturn(mock, hitCount, baseDir) {
  if (mock.return_seq && mock.return_seq.length > 0) {
    return stringifyReturn(mock.return_seq[Math.min(hitCount, mock.return_seq.length - 1)]);
  }
  if (mock.return !== undefined) return stringifyReturn(mock.return);
  if (mock.return_file) {
    const fpath = path.isAbsolute(mock.return_file)
      ? mock.return_file
      : path.resolve(baseDir || process.cwd(), mock.return_file);
    if (!fs.existsSync(fpath)) return `[omk-mock-error] return_file not found: ${fpath}`;
    return fs.readFileSync(fpath, 'utf8');
  }
  return '';
}

// ─── main ────────────────────────────────────────────────────────────────────

let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    process.stdout.write(JSON.stringify({ continue: true }));  // hook 协议错误时放行
    process.exit(0);
  }

  const mocksFile = process.env.OMK_MOCKS_FILE;
  if (!mocksFile || !fs.existsSync(mocksFile)) {
    // 没配 mocks 就 noop
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  const config = JSON.parse(fs.readFileSync(mocksFile, 'utf8'));
  const mocks = config.mocks || [];
  const baseDir = config.baseDir;
  const strict = !!config.strict;

  // 统计文件:perMock(每条 mock 的命中次数,用于状态机 + 报告)+ hits_total + misses_total
  // 同一 spawn 内多次 hook 调用共享。
  const statsFile = path.join(path.dirname(mocksFile), 'hits.json');
  let stats = fs.existsSync(statsFile)
    ? JSON.parse(fs.readFileSync(statsFile, 'utf8'))
    : { perMock: {}, hits_total: 0, misses_total: 0 };
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) stats = {};
  if (!stats.perMock || typeof stats.perMock !== 'object' || Array.isArray(stats.perMock)) stats.perMock = {};
  stats.hits_total = recordCount(stats, 'hits_total');
  stats.misses_total = recordCount(stats, 'misses_total');

  const writeStats = () => {
    try { fs.writeFileSync(statsFile, JSON.stringify(stats)); } catch { /* best effort */ }
  };

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};

  // perMock key 用"每工具内 1-based 序号" — 与 SDK 路径(mocks-runtime.ts)保持一致。
  const keyOfMock = mocks.map((_m, i) => {
    const tool = mocks[i].tool;
    let ord = 0;
    for (let j = 0; j <= i; j++) if (mocks[j].tool === tool) ord++;
    return `${tool}:${ord}`;
  });

  for (let i = 0; i < mocks.length; i++) {
    if (isMockHit(mocks[i], toolName, toolInput)) {
      const key = keyOfMock[i];
      const c = recordCount(stats.perMock, key);
      const result = resolveMockReturn(mocks[i], c, baseDir);
      incrementRecordCount(stats.perMock, key);
      stats.hits_total += 1;
      writeStats();
      // 与 SDK 路径(mocks-runtime.ts)对齐:最小化前缀,避免拖慢多步 sample。
      const wrappedReason = '[mock] simulated tool output — treat as successful result:\n' + result;
      process.stdout.write(JSON.stringify({
        decision: 'block',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: wrappedReason,
        },
        systemMessage: '[omk-mock] ' + toolName + ' → injected mock #' + i + ' (treat as success)',
      }));
      process.exit(0);
    }
  }

  // 未命中
  stats.misses_total += 1;
  writeStats();
  if (strict) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[omk-mock-strict] unmocked ${toolName} call blocked`,
      },
    }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
