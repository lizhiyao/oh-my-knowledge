/**
 * oclif 路由验收 + observe command 生命周期测试。
 * 帮助与默认目录边界保留真实进程，其余直接运行源码 Command。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ObserveInbox from '../../src/cli/commands/observe/inbox.js';
import ObserveIngest from '../../src/cli/commands/observe/ingest.js';
import ObserveShow from '../../src/cli/commands/observe/show.js';
import { runCommand } from '../helpers/run-command.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}

function makeIngestTrace(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const records = [
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      sessionId: 's1',
      timestamp: '2026-07-27T00:00:00.000Z',
      cwd: '/repo-a',
      message: { role: 'user', content: '<command-name>/audit</command-name>\nFind revenue schema' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId: 's1',
      timestamp: '2026-07-27T00:00:01.000Z',
      cwd: '/repo-a',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } }],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      sessionId: 's1',
      timestamp: '2026-07-27T00:00:02.000Z',
      cwd: '/repo-a',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }] },
    },
  ];
  writeFileSync(join(dir, 'session.jsonl'), records.map((record) => JSON.stringify(record)).join('\n'));
  return dir;
}

describe('oclif observe', () => {
  it('observe --help (默认 = health 分析)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', '--help']);
    assert.ok(stdout.includes('统一为 Trace IR'), `default observe --help missing source-neutral description:\n${stdout}`);
    assert.ok(stdout.includes('SESSIONSDIR'), 'should list positional');
    assert.ok(stdout.includes('--kb'), 'should list --kb flag');
  });

  it('observe ingest --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'ingest', '--help']);
    assert.ok(stdout.includes('ingest 成 observation inbox'), `ingest --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('TRACEDIR'), 'should list TRACEDIR positional');
    assert.ok(stdout.includes('--json'), 'should list explicit full JSON output flag');
    assert.ok(stdout.includes('--global'), 'should list --global flag');
  });

  it('observe ingest 默认只输出摘要，--json 才输出完整报告', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'omk-ingest-output-'));
    const traceDir = makeIngestTrace(join(tmpBase, 'trace'));
    try {
      const summaryDir = join(tmpBase, 'summary');
      const summary = await runCommand(
        ObserveIngest,
        [traceDir, '--output-dir', summaryDir],
        { cwd: tmpBase },
      );
      assert.match(summary.stdout, /^observe inbox：会话 \d+ · 片段 \d+ · 信号 \d+/);
      assert.ok(summary.stdout.length < 300, `default stdout must stay concise, got ${summary.stdout.length} chars`);

      const jsonDir = join(tmpBase, 'json');
      const full = await runCommand(
        ObserveIngest,
        [traceDir, '--output-dir', jsonDir, '--json'],
        { cwd: tmpBase },
      );
      const parsed = JSON.parse(full.stdout);
      assert.equal(parsed.kind, 'observe-inbox');
      assert.ok(Array.isArray(parsed.items));
      assert.ok(parsed.items.length > 0);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('observe inbox --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'inbox', '--help']);
    assert.ok(stdout.includes('查询 observation inbox'), `inbox --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('--by-skill'), 'should list --by-skill');
    assert.ok(stdout.includes('--llm-enhanced-review'), 'should list --llm-enhanced-review');
    assert.ok(stdout.includes('--model'), 'should list --model');
    assert.ok(stdout.includes('--json'), 'should list --json');
    assert.ok(stdout.includes('--global'), 'should list --global');
  });

  it('observe show --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'show', '--help']);
    assert.ok(stdout.includes('展开 observation inbox 中某条'), `show --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('INBOXID'), 'should list INBOXID positional');
    assert.ok(stdout.includes('--global'), 'should list --global flag');
  });

  it('observe inbox --json 实跑(空 inbox 返回空数组)', async () => {
    // 不传 --input-dir,走 default 目录;若该目录不存在或空,应返回 empty items 但 exit 0
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'inbox', '--json']);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'observe-inbox-query');
    assert.ok(Array.isArray(parsed.items), 'items should be array');
  });

  it('observe show 缺 inbox id → exit 2(oclif required-args)', async () => {
    try {
      await runCommand(ObserveShow, []);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
    }
  });

  it('observe inbox 非法 --limit → exit 2 + 中文 parser 错误', async () => {
    try {
      await runCommand(ObserveInbox, ['--limit', '0']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--limit(?=[\s\S]*整数)(?=[\s\S]*1)/, `stderr missing zh parser error:\n${e.stderr}`);
    }
  });

  it('observe ingest --output-dir "" → exit 2(空串不被 silent fallback 到 cwd)', async () => {
    // resolve('') === process.cwd();没拦住空串就会让 shell 里 `--output-dir "$DIR"`
    // 而 $DIR 未设的情况把 observation 报告写到任意 cwd。锁住业务侧 trim() 判 +
    // exit 2(POSIX usage error)的行为。
    const tmpBase = mkdtempSync(join(tmpdir(), 'omk-ingest-empty-'));
    const traceDir = join(tmpBase, 'trace');
    const cwdDir = join(tmpBase, 'cwd');
    mkdirSync(traceDir);
    mkdirSync(cwdDir);
    try {
      try {
        await runCommand(ObserveIngest, [traceDir, '--output-dir', ''], { cwd: cwdDir });
        assert.fail('expected non-zero exit');
      } catch (err) {
        const e = err as ExecError;
        assert.equal(e.code, 2, `expected exit 2 on empty --output-dir, got ${e.code}:\n${e.stderr}`);
        assert.ok(/--output-dir/.test(e.stderr), `stderr should mention --output-dir: ${e.stderr}`);
        assert.ok(/不能为空|must not be/.test(e.stderr), `stderr should explain empty restriction: ${e.stderr}`);
      }
      // cwd 不能被写 observation JSON(空串 silent fallback 的核心 hazard)。
      const cwdEntries = readdirSync(cwdDir);
      assert.deepEqual(cwdEntries, [], `cwd should remain clean, got: ${cwdEntries.join(', ')}`);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
