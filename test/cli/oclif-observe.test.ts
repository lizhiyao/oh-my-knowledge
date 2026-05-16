/**
 * oclif 路径 observe + 3 sub 命令验收(OMK_CLI_NEXT=1)。
 * 关键验证:oclif 默认命令 + 子命令文件目录共存(observe.ts + observe/{ingest,inbox,show}.ts)。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const OCLIF_ENV = { ...process.env, OMK_CLI_NEXT: '1' };

describe('oclif observe (OMK_CLI_NEXT=1)', () => {
  it('observe --help (默认 = health 分析)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('分析 sessions 目录'), `default observe --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('SESSIONSDIR'), 'should list positional');
    assert.ok(stdout.includes('--kb'), 'should list --kb flag');
  });

  it('observe ingest --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'ingest', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('ingest 成 observation inbox'), `ingest --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('TRACEDIR'), 'should list TRACEDIR positional');
  });

  it('observe inbox --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'inbox', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('查询 observation inbox'), `inbox --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('--by-skill'), 'should list --by-skill');
    assert.ok(stdout.includes('--json'), 'should list --json');
  });

  it('observe show --help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'show', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('展开 observation inbox 中某条'), `show --help missing zh:\n${stdout}`);
    assert.ok(stdout.includes('INBOXID'), 'should list INBOXID positional');
  });

  it('observe inbox --json 实跑(空 inbox 返回空数组)', async () => {
    // 不传 --input-dir,走 default 目录;若该目录不存在或空,应返回 empty items 但 exit 0
    const { stdout } = await execFileAsync('node', [CLI, 'observe', 'inbox', '--json'], { env: OCLIF_ENV });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'observe-inbox-query');
    assert.ok(Array.isArray(parsed.items), 'items should be array');
  });

  it('observe show 缺 inbox id → exit 1', async () => {
    try {
      await execFileAsync('node', [CLI, 'observe', 'show'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1, got ${e.code}:\n${e.stderr}`);
    }
  });

  it('observe unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'observe', '--bogus'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
    }
  });
});
