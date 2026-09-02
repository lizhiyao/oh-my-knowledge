/**
 * oclif 路由验收 + init command 生命周期测试。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import InitCommand from '../../src/cli/commands/init.js';
import { renderCommandHelp, runCommand } from '../helpers/run-command.js';

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}


describe('oclif init', () => {
  it('--help 默认 zh', async () => {
    const stdout = await renderCommandHelp('init');
    assert.ok(stdout.includes('初始化一个 omk 项目'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('TARGETDIR'), 'stdout missing positional');
  });

  it('--help --lang en', async () => {
    const stdout = await renderCommandHelp('init', 'en');
    assert.ok(stdout.includes('Initialize an omk project'), 'stdout should contain en description');
  });

  it('happy path: 初始化指定目录,生成 skills/ + eval-samples.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-oclif-init-'));
    try {
      const target = join(dir, 'project');
      const { stdout } = await runCommand(InitCommand, ['project'], { cwd: dir });
      assert.ok(stdout.includes('已初始化 omk 项目'), `stdout missing scaffolded msg:\n${stdout}`);
      assert.ok(
        stdout.includes(`cd project && omk eval --control code-review-v1 --treatment code-review-v2`),
        `stdout should include a copy/paste command that enters the target dir first:\n${stdout}`,
      );
      assert.ok(stdout.includes('UNDERPOWERED'), `stdout should set first-run expectation:\n${stdout}`);
      assert.ok(stdout.includes('20 条以上'), `stdout should suggest growing the sample set before release decisions:\n${stdout}`);
      assert.ok(stdout.includes('看报告里的 verdict'), `stdout should tell users where to make the release decision:\n${stdout}`);
      assert.ok(stdout.includes('https://oh-my-knowledge.pages.dev/zh/reference/executors'), `stdout should link zh users to public zh executor docs:\n${stdout}`);
      assert.ok(!stdout.includes('https://oh-my-knowledge.pages.dev/reference/executors'), `stdout should not link zh users to the en executor docs:\n${stdout}`);
      assert.ok(!stdout.includes('docs/reference/executors.md'), `stdout should not point a fresh project at a missing local docs path:\n${stdout}`);
      assert.ok(stdout.includes('omk sample <skill-path>'), `stdout should route users with no samples back to sample generation:\n${stdout}`);
      assert.ok(existsSync(join(target, 'skills', 'code-review-v1', 'SKILL.md')), 'skills/code-review-v1/SKILL.md not created');
      assert.ok(existsSync(join(target, 'eval-samples.json')), 'eval-samples.json not created');
      // 预置 .omk/.gitignore：测量 bulk 不入库，governance/ 不被忽略（默认 track）。
      const gitignorePath = join(target, '.omk', '.gitignore');
      assert.ok(existsSync(gitignorePath), '.omk/.gitignore not created');
      const gi = readFileSync(gitignorePath, 'utf8');
      for (const d of ['/eval/', '/doctor/', '/observe/', '/backups/', '/state/']) {
        assert.ok(gi.includes(d), `.omk/.gitignore should ignore ${d}`);
      }
      assert.ok(!/^\/governance\/?$/m.test(gi), '.omk/.gitignore must not ignore governance/');
      assert.equal(
        existsSync(join(target, '.omk', 'layout.json')),
        false,
        'pure v2 layout must not write a redundant root marker',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('英文输出链接到英文 executor 文档', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-oclif-init-en-'));
    try {
      const { stdout } = await runCommand(InitCommand, ['project', '--lang', 'en'], { cwd: dir });
      assert.ok(stdout.includes('https://oh-my-knowledge.pages.dev/reference/executors'), `stdout should link en users to public en executor docs:\n${stdout}`);
      assert.ok(!stdout.includes('https://oh-my-knowledge.pages.dev/zh/reference/executors'), `stdout should not link en users to the zh executor docs:\n${stdout}`);
      assert.ok(!stdout.includes('docs/reference/executors.md'), `stdout should not point a fresh project at a missing local docs path:\n${stdout}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('指定当前目录外的目标目录时，下一步命令使用绝对 cd 路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-oclif-init-outside-'));
    try {
      const cwd = join(dir, 'cwd');
      const target = join(dir, 'project');
      await mkdir(cwd);
      const { stdout } = await runCommand(InitCommand, [target], { cwd });
      assert.ok(
        stdout.includes(`cd ${target} && omk eval --control code-review-v1 --treatment code-review-v2`),
        `stdout should avoid awkward ../ paths for targets outside cwd:\n${stdout}`,
      );
      assert.ok(!stdout.includes('..'), `stdout should not ask users to copy a parent-directory cd path:\n${stdout}`);
      assert.ok(existsSync(target), 'target dir should still be created');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('指定目录带空格时，下一步命令会 shell quote cd 目标', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-oclif-init-'));
    try {
      const target = join(dir, 'project with spaces');
      const { stdout } = await runCommand(InitCommand, ['project with spaces'], { cwd: dir });
      assert.ok(
        stdout.includes(`cd 'project with spaces' && omk eval --control code-review-v1 --treatment code-review-v2`),
        `stdout should quote the target dir in the copy/paste command:\n${stdout}`,
      );
      assert.ok(existsSync(target), 'target dir should still be created');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('init -- --weird 拒绝以 -- 开头的 positional(防 legacy 创建名为 --weird 的目录)', async () => {
    try {
      await runCommand(InitCommand, ['--', '--weird']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.notEqual(e.code, 0, `expected non-zero exit, got ${e.code}`);
      const out = e.stdout + e.stderr;
      assert.ok(/不能以 -- 开头/.test(out), `expected zh footgun msg, got:\n${out.slice(0, 200)}`);
      assert.ok(!existsSync('--weird'), '--weird directory must not be created');
    }
  });

  it('init -- --weird --lang en 拒绝且报英文', async () => {
    try {
      await runCommand(InitCommand, ['--', '--weird', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.notEqual(e.code, 0);
      const out = e.stdout + e.stderr;
      assert.ok(/cannot start with --/.test(out), `expected en footgun msg, got:\n${out.slice(0, 200)}`);
    }
  });
});
