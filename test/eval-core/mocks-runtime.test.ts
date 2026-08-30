import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import {
  isMockHit,
  resolveMockReturn,
  buildSdkHookCallback,
  materializeForCliConfigDir,
  _testMakeTempConfigDir,
} from '../../src/eval-core/mocks-runtime.js';
import type { Mock } from '../../src/types/eval.js';

describe('isMockHit', () => {
  it('matches by tool name only when no match clause', () => {
    const m: Mock = { tool: 'Read', return: 'x' };
    assert.equal(isMockHit(m, 'Read', { file_path: '/a' }), true);
    assert.equal(isMockHit(m, 'Bash', { command: 'ls' }), false);
  });

  it('maps runtime-native tool names to the source-neutral mock identity', () => {
    assert.equal(
      isMockHit({ tool: 'Bash', return: 'x' }, 'exec_command', { cmd: 'ls' }),
      true,
    );
    assert.equal(
      isMockHit({ tool: 'Edit', return: 'x' }, 'apply_patch', { patch: '...' }),
      true,
    );
    assert.equal(
      isMockHit({ tool: 'Read', return: 'x' }, 'file_read', { path: 'a.ts' }),
      true,
    );
  });

  it('matches file_path with ~ expansion', () => {
    const m: Mock = { tool: 'Read', match: { file_path: '~/.foo' }, return: 'x' };
    const home = process.env.HOME!;
    assert.equal(isMockHit(m, 'Read', { file_path: `${home}/.foo` }), true);
    assert.equal(isMockHit(m, 'Read', { file_path: '/wrong/path' }), false);
  });

  it('matches file_path_endswith — exact, absolute, and ~ all hit', () => {
    const m: Mock = { tool: 'Read', match: { file_path_endswith: 'tasks/foo/state.json' }, return: 'x' };
    // exact relative
    assert.equal(isMockHit(m, 'Read', { file_path: 'tasks/foo/state.json' }), true);
    // absolute path containing the suffix
    assert.equal(isMockHit(m, 'Read', { file_path: '/Users/anon/proj/tasks/foo/state.json' }), true);
    // ~ prefix should expand
    assert.equal(isMockHit(m, 'Read', { file_path: '~/proj/tasks/foo/state.json' }), true);
  });

  it('file_path_endswith requires path-separator boundary (state.json !== bad-state.json)', () => {
    const m: Mock = { tool: 'Read', match: { file_path_endswith: 'state.json' }, return: 'x' };
    // 完全相等 OK
    assert.equal(isMockHit(m, 'Read', { file_path: 'state.json' }), true);
    // /state.json 边界 OK
    assert.equal(isMockHit(m, 'Read', { file_path: '/abs/state.json' }), true);
    // bad-state.json 不应该命中(没有路径分隔符边界)
    assert.equal(isMockHit(m, 'Read', { file_path: 'bad-state.json' }), false);
    assert.equal(isMockHit(m, 'Read', { file_path: '/abs/bad-state.json' }), false);
  });

  it('file_path_endswith accepts Windows backslash boundary', () => {
    const m: Mock = { tool: 'Read', match: { file_path_endswith: 'tasks/state.json' }, return: 'x' };
    assert.equal(isMockHit(m, 'Read', { file_path: 'C:\\proj\\tasks/state.json' }), true);
  });

  it('file_path_endswith returns false when input.file_path missing or non-string', () => {
    const m: Mock = { tool: 'Read', match: { file_path_endswith: 'state.json' }, return: 'x' };
    assert.equal(isMockHit(m, 'Read', {}), false);
    assert.equal(isMockHit(m, 'Read', { file_path: 123 }), false);
  });

  it('file_path + file_path_endswith are AND (both must pass when both given)', () => {
    const m: Mock = {
      tool: 'Read',
      match: { file_path: 'a/b.json', file_path_endswith: 'b.json' },
      return: 'x',
    };
    // 严格相等 + 后缀都命中
    assert.equal(isMockHit(m, 'Read', { file_path: 'a/b.json' }), true);
    // 后缀对、严格不对 → fail(因为 file_path 严格等于 'a/b.json')
    assert.equal(isMockHit(m, 'Read', { file_path: '/abs/a/b.json' }), false);
  });

  it('matches command_glob with *', () => {
    const m: Mock = { tool: 'Bash', match: { command_glob: 'mcporter call *--tool find_drm_value*' }, return: 'x' };
    assert.equal(isMockHit(m, 'Bash', { command: 'mcporter call --stdio foo --tool find_drm_value --args {}' }), true);
    assert.equal(isMockHit(m, 'Bash', { command: 'mcporter call --tool other_tool' }), false);
    assert.equal(isMockHit(m, 'Bash', { command: 'echo hi' }), false);
  });

  it('command_glob `*` matches across newlines (multiline bash with `\\` continuations)', () => {
    // 实测发现:LLM 经常用反斜杠 + 换行写多行命令(SOP 样板就是这么写的),
    // 没有 dotAll 标志的话 `*` 只在单行内匹配,导致整套 mock 全 miss。
    const m: Mock = { tool: 'Bash', match: { command_glob: '*integration-tool iteration create*--platform integration-tool*' }, return: 'ok' };
    const multiline = 'integration-tool iteration create \\\n  --platform integration-tool \\\n  --name "支付迭代" \\\n  --apps "payment"';
    assert.equal(isMockHit(m, 'Bash', { command: multiline }), true);
  });

  it('matches url_glob', () => {
    const m: Mock = { tool: 'WebFetch', match: { url_glob: 'https://internal.example.com/*' }, return: 'x' };
    assert.equal(isMockHit(m, 'WebFetch', { url: 'https://internal.example.com/api/foo' }), true);
    assert.equal(isMockHit(m, 'WebFetch', { url: 'https://other.com/foo' }), false);
  });

  it('matches input subset (deep)', () => {
    const m: Mock = { tool: 'Bash', match: { input: { command: 'git push origin master' } }, return: 'ok' };
    assert.equal(isMockHit(m, 'Bash', { command: 'git push origin master', timeout: 30 }), true);
    assert.equal(isMockHit(m, 'Bash', { command: 'git push other' }), false);
  });

  // 修 PR #95 review P2-3:之前 match.input 含数组字段会走引用比较永远 miss
  it('matches input subset 含数组字段(deep equal 而非 === 引用比较)', () => {
    const m: Mock = { tool: 'X', match: { input: { args: ['a', 'b', 'c'] } }, return: 'ok' };
    assert.equal(isMockHit(m, 'X', { args: ['a', 'b', 'c'] }), true);
    assert.equal(isMockHit(m, 'X', { args: ['a', 'b'] }), false);
    assert.equal(isMockHit(m, 'X', { args: ['a', 'b', 'd'] }), false);
    assert.equal(isMockHit(m, 'X', { args: 'a' }), false); // 不是数组
  });

  it('matches input subset 含嵌套数组(数组里套 object)', () => {
    const m: Mock = { tool: 'X', match: { input: { items: [{ name: 'a' }, { name: 'b' }] } }, return: 'ok' };
    assert.equal(isMockHit(m, 'X', { items: [{ name: 'a' }, { name: 'b' }] }), true);
    assert.equal(isMockHit(m, 'X', { items: [{ name: 'a' }, { name: 'c' }] }), false);
  });

  it('tool: "*" matches any tool name', () => {
    const m: Mock = { tool: '*', match: { command_glob: '*grep*' }, return: 'found' };
    assert.equal(isMockHit(m, 'Bash', { command: 'grep -r foo .' }), true);
    assert.equal(isMockHit(m, 'Grep', { command: 'grep -r foo .' }), true);
    assert.equal(isMockHit(m, 'Read', { command: 'grep -r foo .' }), true);
  });

  it('tool: "*" without match clause matches everything', () => {
    const m: Mock = { tool: '*', return: 'catch-all' };
    assert.equal(isMockHit(m, 'Read', { file_path: '/a' }), true);
    assert.equal(isMockHit(m, 'Bash', { command: 'ls' }), true);
    assert.equal(isMockHit(m, 'WebFetch', { url: 'https://x.com' }), true);
  });

  it('input_contains matches substring in simple string field', () => {
    const m: Mock = { tool: 'Bash', match: { input_contains: 'FinTradeBuySpi' }, return: 'ok' };
    assert.equal(isMockHit(m, 'Bash', { command: 'grep -r FinTradeBuySpi src/' }), true);
    assert.equal(isMockHit(m, 'Bash', { command: 'echo hello' }), false);
  });

  it('input_contains is case-insensitive', () => {
    const m: Mock = { tool: 'Bash', match: { input_contains: 'fintradebuyspi' }, return: 'ok' };
    assert.equal(isMockHit(m, 'Bash', { command: 'grep -r FinTradeBuySpi src/' }), true);
    assert.equal(isMockHit(m, 'Bash', { command: 'FINTRADEBUYSPI' }), true);
  });

  it('input_contains scans nested object values recursively', () => {
    const m: Mock = { tool: 'Read', match: { input_contains: 'target' }, return: 'ok' };
    assert.equal(isMockHit(m, 'Read', { file_path: '/path/target.ts', options: { encoding: 'utf8' } }), true);
    assert.equal(isMockHit(m, 'Read', { nested: { deep: { value: 'has target here' } } }), true);
    assert.equal(isMockHit(m, 'Read', { file_path: '/other.ts' }), false);
  });

  it('input_contains scans array values', () => {
    const m: Mock = { tool: 'X', match: { input_contains: 'needle' }, return: 'ok' };
    assert.equal(isMockHit(m, 'X', { args: ['a', 'needle-in-haystack', 'c'] }), true);
    assert.equal(isMockHit(m, 'X', { args: ['a', 'b', 'c'] }), false);
  });

  it('input_contains does not match non-string values', () => {
    const m: Mock = { tool: 'X', match: { input_contains: '42' }, return: 'ok' };
    assert.equal(isMockHit(m, 'X', { count: 42 }), false);
    assert.equal(isMockHit(m, 'X', { count: '42' }), true);
  });

  it('tool: "*" + input_contains: intent-level mock matches any tool with keyword', () => {
    const m: Mock = { tool: '*', match: { input_contains: 'FinTradeBuySpi' }, return: 'found it' };
    assert.equal(isMockHit(m, 'Bash', { command: 'grep -r FinTradeBuySpi src/' }), true);
    assert.equal(isMockHit(m, 'Grep', { pattern: 'FinTradeBuySpi', path: 'src/' }), true);
    assert.equal(isMockHit(m, 'Read', { file_path: '/src/FinTradeBuySpi.java' }), true);
    assert.equal(isMockHit(m, 'Bash', { command: 'echo hello' }), false);
  });

  it('input_contains ANDs with other match fields', () => {
    const m: Mock = { tool: 'Bash', match: { input_contains: 'deploy', command_glob: 'kubectl *' }, return: 'ok' };
    assert.equal(isMockHit(m, 'Bash', { command: 'kubectl apply -f deploy.yaml' }), true);
    assert.equal(isMockHit(m, 'Bash', { command: 'kubectl get pods' }), false);
    assert.equal(isMockHit(m, 'Bash', { command: 'helm deploy release' }), false);
  });
});

describe('resolveMockReturn', () => {
  it('returns string return as-is', () => {
    assert.equal(resolveMockReturn({ tool: 'Read', return: 'hello' }, 0), 'hello');
  });

  it('JSON.stringify object return', () => {
    const out = resolveMockReturn({ tool: 'Bash', return: { stdout: 'ok', exit: 0 } }, 0);
    assert.deepEqual(JSON.parse(out), { stdout: 'ok', exit: 0 });
  });

  it('return_seq picks by hitCount', () => {
    const m: Mock = { tool: 'Bash', return_seq: ['first', 'second', 'third'] };
    assert.equal(resolveMockReturn(m, 0), 'first');
    assert.equal(resolveMockReturn(m, 1), 'second');
    assert.equal(resolveMockReturn(m, 2), 'third');
  });

  it('return_seq fallback to return when hitCount overflows', () => {
    const m: Mock = { tool: 'Bash', return_seq: ['a'], return: 'fallback' };
    assert.equal(resolveMockReturn(m, 5), 'fallback');
  });

  it('return_file reads from baseDir', () => {
    const dir = _testMakeTempConfigDir();
    const fpath = join(dir, 'fixture.json');
    writeFileSync(fpath, '{"x":1}');
    try {
      const m: Mock = { tool: 'Read', return_file: 'fixture.json' };
      assert.equal(resolveMockReturn(m, 0, dir), '{"x":1}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('return_file missing → error string', () => {
    const m: Mock = { tool: 'Read', return_file: '/nonexistent/x.json' };
    const out = resolveMockReturn(m, 0);
    assert.match(out, /omk-mock-error.*not found/);
  });
});

describe('buildSdkHookCallback', () => {
  it('returns continue:true when no mocks', async () => {
    const h = buildSdkHookCallback(undefined);
    const r = await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} });
    assert.equal((r as { continue?: boolean }).continue, true);
    assert.equal(h.stats.misses, 1);
  });

  it('returns deny + permissionDecisionReason on hit', async () => {
    const mocks: Mock[] = [{ tool: 'Read', match: { file_path: '/foo' }, return: 'mocked-content' }];
    const h = buildSdkHookCallback(mocks);
    const r = await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/foo' } });
    const out = r as { decision?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.equal(out.decision, 'block');
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    // reason 现在被 wrap 成最小化的"显式 mock 注入"措辞,避免 LLM 误判为"被拒绝/失败"。
    // 措辞短是为了不拖慢多步评测(每步都要读这段)。
    const reason = out.hookSpecificOutput?.permissionDecisionReason || '';
    assert.match(reason, /\[mock\]/);
    assert.match(reason, /treat as successful/);
    assert.match(reason, /mocked-content/);
    assert.equal(h.stats.hits, 1);
  });

  it('strict mode denies unmocked calls', async () => {
    const h = buildSdkHookCallback([], undefined, true);
    const r = await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/foo' } });
    const out = r as { decision?: string; hookSpecificOutput?: { permissionDecisionReason?: string } };
    assert.equal(out.decision, 'block');
    assert.match(out.hookSpecificOutput?.permissionDecisionReason || '', /strict.*unmocked/);
  });

  it('non-strict allows unmocked calls', async () => {
    const h = buildSdkHookCallback([], undefined, false);
    const r = await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/foo' } });
    assert.equal((r as { continue?: boolean }).continue, true);
  });

  it('return_seq advances per hit', async () => {
    const mocks: Mock[] = [{ tool: 'Bash', match: { command_glob: 'echo *' }, return_seq: ['one', 'two', 'three'] }];
    const h = buildSdkHookCallback(mocks);
    const call = (cmd: string) => h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } });

    const r1 = (await call('echo a')) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
    const r2 = (await call('echo b')) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
    const r3 = (await call('echo c')) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
    // wrap 后只验证内容包含原始字符串,前后带说明文字。
    assert.match(r1.hookSpecificOutput?.permissionDecisionReason || '', /one/);
    assert.match(r2.hookSpecificOutput?.permissionDecisionReason || '', /two/);
    assert.match(r3.hookSpecificOutput?.permissionDecisionReason || '', /three/);
  });
});

describe('materializeForCliConfigDir', () => {
  let createdDirs: string[] = [];
  beforeEach(() => { createdDirs = []; });
  afterEach(() => {
    for (const d of createdDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns null when no mocks', () => {
    assert.equal(materializeForCliConfigDir(undefined), null);
    assert.equal(materializeForCliConfigDir([]), null);
  });

  it('writes settings.json + mock-hook.cjs + mocks.json + provides cleanup', () => {
    const mocks: Mock[] = [{ tool: 'Read', match: { file_path: '/a' }, return: 'x' }];
    const handle = materializeForCliConfigDir(mocks)!;
    const dir = dirname(handle.settingsFile);
    createdDirs.push(dir);

    assert.ok(dir.includes('omk-mocks-'));
    assert.ok(existsSync(handle.settingsFile));
    assert.ok(existsSync(join(dir, 'mock-hook.cjs')));
    assert.ok(existsSync(join(dir, 'mocks.json')));
    assert.equal(handle.env.OMK_MOCKS_FILE, join(dir, 'mocks.json'));

    const settings = JSON.parse(readFileSync(handle.settingsFile, 'utf8'));
    assert.ok(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command?.includes('mock-hook.cjs'));

    handle.cleanup();
    assert.equal(existsSync(dir), false);
    createdDirs = [];  // already removed
  });

  it('materialized CLI hook maps runtime-native names to source-neutral mocks', () => {
    const handle = materializeForCliConfigDir([
      { tool: 'Bash', return: 'shell fixture' },
      { tool: 'github.fetch_file', return: 'mcp fixture' },
    ])!;
    const dir = dirname(handle.settingsFile);
    createdDirs.push(dir);
    const hookScript = join(dir, 'mock-hook.cjs');
    const invoke = (toolName: string) => spawnSync(
      process.execPath,
      [hookScript],
      {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
          tool_input: {},
        }),
        encoding: 'utf8',
        env: { ...process.env, ...handle.env },
      },
    );

    const bash = invoke('exec_command');
    assert.equal(bash.status, 0, bash.stderr);
    assert.match(
      JSON.parse(bash.stdout).hookSpecificOutput.permissionDecisionReason,
      /shell fixture/,
    );

    const mcp = invoke('mcp__github__fetch_file');
    assert.equal(mcp.status, 0, mcp.stderr);
    assert.match(
      JSON.parse(mcp.stdout).hookSpecificOutput.permissionDecisionReason,
      /mcp fixture/,
    );
    assert.deepEqual(handle.readStats().perMock, {
      'Bash:1': 1,
      'github.fetch_file:1': 1,
    });
  });

  it('cleanup is idempotent (safe to call twice)', () => {
    const handle = materializeForCliConfigDir([{ tool: 'Read', return: 'x' }])!;
    createdDirs.push(dirname(handle.settingsFile));
    handle.cleanup();
    handle.cleanup();  // no throw
    createdDirs = [];
  });

  it('readStats returns zeros when hook never ran', () => {
    const handle = materializeForCliConfigDir([{ tool: 'Read', return: 'x' }])!;
    createdDirs.push(dirname(handle.settingsFile));
    const stats = handle.readStats();
    assert.deepEqual(stats, { hits: 0, misses: 0, perMock: {} });
  });

  it('readStats parses written hits.json', () => {
    const handle = materializeForCliConfigDir([{ tool: 'Read', return: 'x' }])!;
    const dir = dirname(handle.settingsFile);
    createdDirs.push(dir);
    writeFileSync(
      join(dir, 'hits.json'),
      JSON.stringify({ perMock: { 'Read:1': 3 }, hits_total: 3, misses_total: 1 }),
    );
    const stats = handle.readStats();
    assert.deepEqual(stats, { hits: 3, misses: 1, perMock: { 'Read:1': 3 } });
  });

  it('writes one-shot MCP config for mcp tool mocks', () => {
    const handle = materializeForCliConfigDir([
      { tool: 'mcp__clawdbot-dingtalk__message', return: '{"ok":true}' },
    ])!;
    const dir = dirname(handle.settingsFile);
    createdDirs.push(dir);

    assert.equal(handle.mcpConfigFile, join(dir, 'mcp.json'));
    assert.ok(existsSync(join(dir, 'fake-mcp-server.cjs')));
    const cfg = JSON.parse(readFileSync(handle.mcpConfigFile!, 'utf8'));
    assert.equal(cfg.mcpServers['clawdbot-dingtalk'].command, 'node');
    assert.deepEqual(cfg.mcpServers['clawdbot-dingtalk'].env, { OMK_MOCKS_FILE: join(dir, 'mocks.json') });
  });

  it('pins hook and fake MCP launchers to an explicit Node executable', () => {
    const nodeExecutable = join('/runtime with spaces', 'node');
    const handle = materializeForCliConfigDir(
      [{ tool: 'mcp__search__query', return: 'ok' }],
      undefined,
      false,
      nodeExecutable,
    )!;
    const dir = dirname(handle.settingsFile);
    createdDirs.push(dir);
    const settings = JSON.parse(readFileSync(handle.settingsFile, 'utf8'));
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /runtime with spaces/);
    const mcp = JSON.parse(readFileSync(handle.mcpConfigFile!, 'utf8'));
    assert.equal(mcp.mcpServers.search.command, nodeExecutable);
  });

  it('strict flag persists into mocks.json', () => {
    const handle = materializeForCliConfigDir([{ tool: 'Read', return: 'x' }], undefined, true)!;
    const dir = dirname(handle.settingsFile);
    createdDirs.push(dir);
    const cfg = JSON.parse(readFileSync(join(dir, 'mocks.json'), 'utf8'));
    assert.equal(cfg.strict, true);
  });
});

describe('renderEnvironmentSection (task-planner)', () => {
  it('returns null when no environment field', async () => {
    const { renderEnvironmentSection } = await import('../../src/eval-core/task-planner.js');
    assert.equal(renderEnvironmentSection(undefined), null);
    assert.equal(renderEnvironmentSection({}), null);
  });

  it('renders cli_available', async () => {
    const { renderEnvironmentSection } = await import('../../src/eval-core/task-planner.js');
    const out = renderEnvironmentSection({ cli_available: ['node', 'git'] });
    assert.ok(out!.includes('题设声明可用的 CLI'));
    assert.ok(out!.includes('`node`'));
    assert.ok(out!.includes('`git`'));
    assert.ok(out!.includes('不会自动创建文件或修改 runtime 环境'));
  });

  it('renders files_available + notes', async () => {
    const { renderEnvironmentSection } = await import('../../src/eval-core/task-planner.js');
    const out = renderEnvironmentSection({
      files_available: ['~/.req-tool-api.json', '$SKILL_DIR/scripts/x.js'],
      notes: 'DevAPI 凭证有效',
    });
    assert.ok(out!.includes('~/.req-tool-api.json'));
    assert.ok(out!.includes('$SKILL_DIR/scripts/x.js'));
    assert.ok(out!.includes('DevAPI 凭证有效'));
  });
});

describe('buildTasksFromArtifacts — environment injection', () => {
  it('prepends environment section to user prompt', async () => {
    const { buildTasksFromArtifacts } = await import('../../src/eval-core/task-planner.js');
    const tasks = buildTasksFromArtifacts(
      [{
        sample_id: 's1',
        prompt: '查询Daily标签的工作项',
        environment: { cli_available: ['node'] },
      }],
      [{ name: 'baseline', kind: 'baseline', source: 'baseline', content: null }],
    );
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].prompt.includes('题设环境声明'));
    assert.ok(tasks[0].prompt.includes('`node`'));
    assert.ok(tasks[0].prompt.endsWith('查询Daily标签的工作项'));
  });

  it('plain prompt (no env) unchanged', async () => {
    const { buildTasksFromArtifacts } = await import('../../src/eval-core/task-planner.js');
    const tasks = buildTasksFromArtifacts(
      [{ sample_id: 's1', prompt: 'hello' }],
      [{ name: 'baseline', kind: 'baseline', source: 'baseline', content: null }],
    );
    assert.equal(tasks[0].prompt, 'hello');
  });
});

describe('SDK hook stats — perMock key format', () => {
  it('perMock key uses Tool:N (per-tool 1-based) format', async () => {
    const mocks: Mock[] = [
      { tool: 'Read', match: { file_path: '/a' }, return: 'A' },
      { tool: 'Bash', match: { command_glob: 'echo *' }, return: 'B' },
    ];
    const h = buildSdkHookCallback(mocks);
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    assert.equal(h.stats.hits, 3);
    assert.equal(h.stats.misses, 0);
    // Read 在 mocks 里是该工具的第 1 条 → "Read:1"; Bash 同 → "Bash:1"
    assert.deepEqual(h.stats.perMock, { 'Read:1': 2, 'Bash:1': 1 });
  });

  it('multiple mocks of same tool get monotonically increasing per-tool index', async () => {
    const mocks: Mock[] = [
      { tool: 'Bash', match: { command_glob: 'a*' }, return: 'A' },
      { tool: 'Read', match: { file_path: '/x' }, return: 'X' },
      { tool: 'Bash', match: { command_glob: 'b*' }, return: 'B' },
      { tool: 'Bash', match: { command_glob: 'c*' }, return: 'C' },
    ];
    const h = buildSdkHookCallback(mocks);
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'a 1' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'b 2' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'c 3' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } });
    // 1st Bash→Bash:1, 2nd Bash→Bash:2, 3rd Bash→Bash:3, 1st Read→Read:1
    assert.deepEqual(h.stats.perMock, { 'Bash:1': 1, 'Bash:2': 1, 'Bash:3': 1, 'Read:1': 1 });
  });

  it('perMock key uses *:N for wildcard mocks', async () => {
    const mocks: Mock[] = [
      { tool: '*', match: { input_contains: 'foo' }, return: 'A' },
      { tool: 'Read', match: { file_path: '/x' }, return: 'B' },
      { tool: '*', match: { input_contains: 'bar' }, return: 'C' },
    ];
    const h = buildSdkHookCallback(mocks);
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo foo' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'bar' } });
    assert.deepEqual(h.stats.perMock, { '*:1': 1, 'Read:1': 1, '*:2': 1 });
  });

  it('miss increments stats.misses', async () => {
    const mocks: Mock[] = [{ tool: 'Read', match: { file_path: '/a' }, return: 'A' }];
    const h = buildSdkHookCallback(mocks);
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/other' } });
    assert.equal(h.stats.hits, 0);
    assert.equal(h.stats.misses, 2);
  });
});
