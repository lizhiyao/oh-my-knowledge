/**
 * `omk eval init`(项目脚手架收敛后命名)验收 + `omk init` 别名行为:两者落盘一致,仅 `omk init` 在 stderr
 * 打「建议改用 omk eval init」收敛提示,`omk eval init` 不打。提示走 stderr,不污染 stdout。
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
const CLI = join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

describe('oclif eval init', () => {
  it('--help:命令被发现且用法显示 omk eval init', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', 'init', '--help']);
    assert.ok(stdout.includes('初始化 omk 项目脚手架'), `missing zh description:\n${stdout}`);
    assert.ok(/omk eval init/.test(stdout), `usage should show "omk eval init":\n${stdout}`);
  });

  it('happy path:落 skills/ + eval-samples.json,且 stderr 无收敛提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-eval-init-'));
    try {
      const target = join(dir, 'project');
      const { stdout, stderr } = await execFileAsync('node', [CLI, 'eval', 'init', target]);
      assert.ok(stdout.includes('已初始化测评项目'), `missing scaffolded msg:\n${stdout}`);
      assert.ok(existsSync(join(target, 'skills', 'code-review-v1', 'SKILL.md')), 'SKILL.md not created');
      assert.ok(existsSync(join(target, 'eval-samples.json')), 'eval-samples.json not created');
      assert.ok(!/omk eval init/.test(stderr), `eval init 不应打收敛提示, got stderr:\n${stderr}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('omk init 别名:落盘一致,但 stderr 打「建议改用 omk eval init」收敛提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-init-alias-'));
    try {
      const target = join(dir, 'project');
      const { stdout, stderr } = await execFileAsync('node', [CLI, 'init', target]);
      assert.ok(existsSync(join(target, 'eval-samples.json')), 'alias should scaffold identically');
      assert.ok(!stdout.includes('建议改用'), '收敛提示应在 stderr 而非 stdout（不污染管道）');
      assert.ok(/omk eval init/.test(stderr) && /建议改用/.test(stderr), `omk init 应在 stderr 提示收敛, got:\n${stderr}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
