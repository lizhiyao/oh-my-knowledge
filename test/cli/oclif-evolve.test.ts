/**
 * oclif 路径 evolve 命令验收。
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


describe('oclif evolve', () => {
  it('--help 默认 zh', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'evolve', '--help']);
    assert.ok(stdout.includes('自动迭代改进 skill'), `stdout missing zh:\n${stdout}`);
    assert.ok(stdout.includes('--rounds'), 'stdout missing --rounds flag');
    assert.ok(stdout.includes('--target'), 'stdout missing --target flag');
    assert.ok(stdout.includes('--improve-model'), 'stdout missing --improve-model flag');
  });

  it('--help --lang en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'evolve', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('Auto-iterate skill improvement'), 'stdout should contain en description');
  });

  it('unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'evolve', '--bogus']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
    }
  });

  it('缺 skillPath positional → exit 2(oclif required-args)', async () => {
    try {
      await execFileAsync('node', [CLI, 'evolve']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
    }
  });
});
