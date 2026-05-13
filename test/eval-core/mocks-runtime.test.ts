import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
    assert.ok(out!.includes('已安装 CLI'));
    assert.ok(out!.includes('`node`'));
    assert.ok(out!.includes('`git`'));
    assert.ok(out!.includes('不要做环境检查'));
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
    assert.ok(tasks[0].prompt.includes('评测环境前置'));
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

  it('miss increments stats.misses', async () => {
    const mocks: Mock[] = [{ tool: 'Read', match: { file_path: '/a' }, return: 'A' }];
    const h = buildSdkHookCallback(mocks);
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await h.callback({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/other' } });
    assert.equal(h.stats.hits, 0);
    assert.equal(h.stats.misses, 2);
  });
});
