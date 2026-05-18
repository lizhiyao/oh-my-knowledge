/**
 * oclif 路径 studio 命令验收。
 * studio 是 server 长跑,不实际启 server,只测 --help 双语 + flag 校验。
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


describe('oclif studio', () => {
  it('--help 默认 zh', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'studio', '--help']);
    assert.ok(stdout.includes('启动 omk Studio'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('--port'), 'stdout missing --port flag');
    assert.ok(stdout.includes('--no-open'), 'stdout missing --no-open flag');
    assert.ok(stdout.includes('--dev'), 'stdout missing --dev flag');
  });

  it('--help --lang en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'studio', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('Start omk Studio'), 'stdout should contain en description');
  });

  it('unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'studio', '--bogus']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
    }
  });

  it('非法 --port → exit 2 + 中文 parser 错误', async () => {
    try {
      await execFileAsync('node', [CLI, 'studio', '--port', '70000']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--port(?=[\s\S]*整数)(?=[\s\S]*0)(?=[\s\S]*65535)/, `stderr missing zh parser error:\n${e.stderr}`);
    }
  });
});
