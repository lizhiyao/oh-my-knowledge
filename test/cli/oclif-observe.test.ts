/**
 * oclif 路径 observe + 3 sub 命令验收。
 * 关键验证:oclif 默认命令 + 子命令文件目录共存(observe.ts + observe/{ingest,inbox,show}.ts)。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'src', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}


describe('oclif observe', () => {
  it('observe --help (默认 = health 分析)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', '--help']);
    assert.ok(stdout.includes('分析 sessions 目录'), `default observe --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('SESSIONSDIR'), 'should list positional');
    assert.ok(stdout.includes('--kb'), 'should list --kb flag');
  });

  it('observe ingest --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'ingest', '--help']);
    assert.ok(stdout.includes('ingest 成 observation inbox'), `ingest --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('TRACEDIR'), 'should list TRACEDIR positional');
  });

  it('observe inbox --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'inbox', '--help']);
    assert.ok(stdout.includes('查询 observation inbox'), `inbox --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('--by-skill'), 'should list --by-skill');
    assert.ok(stdout.includes('--soft-standard-extract'), 'should list --soft-standard-extract');
    assert.ok(stdout.includes('--model'), 'should list --model');
    assert.ok(stdout.includes('--json'), 'should list --json');
  });

  it('observe show --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'show', '--help']);
    assert.ok(stdout.includes('展开 observation inbox 中某条'), `show --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('INBOXID'), 'should list INBOXID positional');
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
      await execFileAsync('node', [CLI, 'observe', 'show']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
    }
  });

  it('observe unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'observe', '--bogus']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
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
        await execFileAsync('node', [CLI, 'observe', 'ingest', traceDir, '--output-dir', ''], { cwd: cwdDir });
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
