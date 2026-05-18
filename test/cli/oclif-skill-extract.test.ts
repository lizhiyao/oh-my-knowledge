/**
 * oclif 路径 skill-extract 命令验收。
 * 锁住 BaseCommand 约定 + enumStringParser 行为:--status 走 oclif 边界校验
 * 而不是业务层 console.error。
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

describe('oclif skill-extract', () => {
  it('--help 默认 zh', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'skill-extract', '--help']);
    assert.ok(stdout.includes('确认或否决 skill 软标准候选'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('--review'), 'stdout missing --review flag');
    assert.ok(stdout.includes('--status'), 'stdout missing --status flag');
  });

  it('--help --lang en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'skill-extract', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('Confirm or reject skill soft standard candidates'), 'stdout should contain en description');
  });

  it('缺 skillName positional → exit 2(oclif required-args)', async () => {
    try {
      await execFileAsync('node', [CLI, 'skill-extract', '--review', 'foo']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2 on missing skillName, got ${e.code}:\n${e.stderr}`);
    }
  });

  it('缺 --review → exit 2(oclif required-flag)', async () => {
    try {
      await execFileAsync('node', [CLI, 'skill-extract', 'demo-skill']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2 on missing --review, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /Missing required flag review/i, `stderr should report missing --review: ${e.stderr}`);
    }
  });

  it('非法 --status → exit 2 + 中文 parser 错误(走 enumStringParser)', async () => {
    try {
      await execFileAsync('node', [CLI, 'skill-extract', 'demo-skill', '--review', 'sid', '--status', 'maybe']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--status(?=[\s\S]*author_confirmed)(?=[\s\S]*之一)/, `stderr missing zh enum parser error:\n${e.stderr}`);
    }
  });

  it('非法 --status --lang en → English parser error', async () => {
    try {
      await execFileAsync('node', [CLI, 'skill-extract', 'demo-skill', '--review', 'sid', '--status', 'maybe', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
      assert.match(e.stderr, /--status[\s\S]*must be one of[\s\S]*author_confirmed/, `stderr missing en parser error:\n${e.stderr}`);
    }
  });
});
