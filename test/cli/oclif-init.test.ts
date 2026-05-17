/**
 * oclif 路径 init 命令验收。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
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


describe('oclif init', () => {
  it('--help 默认 zh', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'init', '--help']);
    assert.ok(stdout.includes('初始化 omk 项目脚手架'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('TARGETDIR'), 'stdout missing positional');
  });

  it('--help --lang en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'init', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('Scaffold an omk project'), 'stdout should contain en description');
  });

  it('unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'init', '--bogus']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
    }
  });

  it('happy path: 初始化指定目录,生成 skills/ + eval-samples.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-oclif-init-'));
    try {
      const target = join(dir, 'project');
      const { stdout } = await execFileAsync('node', [CLI, 'init', target]);
      assert.ok(stdout.includes('已初始化测评项目'), `stdout missing scaffolded msg:\n${stdout}`);
      assert.ok(existsSync(join(target, 'skills', 'code-review-v1', 'SKILL.md')), 'skills/code-review-v1/SKILL.md not created');
      assert.ok(existsSync(join(target, 'eval-samples.json')), 'eval-samples.json not created');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
