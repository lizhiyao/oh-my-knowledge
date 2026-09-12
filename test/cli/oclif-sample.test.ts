import { createWorkflowSampleSetDocument } from '../../src/eval-workflows/inputs/schemas/sample-set.js';
/**
 * oclif 路由验收 + sample command 生命周期测试。
 * 验证 sample 三模式入口都能正确分流到生产 execute():
 * - 缺 positional + 非 batch / from-traces → exit 2 + 中文 hint
 * - --batch 走不存在的 skill-dir → exit 1
 */
import { describe, it, vi, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import SampleCommand from '../../src/cli/commands/sample.js';
import { renderCommandHelp, runCommand } from '../helpers/run-command.js';

const generateSamples = vi.hoisted(() => vi.fn());
vi.mock('../../src/eval-workflows/sample-generation/generator.js', () => ({ generateSamples }));

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}


describe('oclif sample', () => {
  it('命令参数接入共享生成用例并保存到 skill 私有样本路径', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-sample-command-'));
    try {
      writeFileSync(join(root, 'SKILL.md'), '# Example');
      const samples = [{ sample_id: 'one', input: { inputKind: 'text' as const, text: 'Review' } }];
      generateSamples.mockReset();
      generateSamples.mockResolvedValue({ samples, costUSD: 0 });
      await runCommand(SampleCommand, [root, '--executor', 'claude', '--model', 'fixture', '--count', '1', '--focus', 'errors', '--no-mock'], { cwd: root });
      expect(generateSamples).toHaveBeenCalledWith(expect.objectContaining({
        skillContent: '# Example', model: 'fixture', executorName: 'claude', count: 1, focus: 'errors', noMock: true,
      }));
      expect(JSON.parse(readFileSync(join(root, '.omk', 'eval-samples.json'), 'utf8')).samples).toEqual(createWorkflowSampleSetDocument(samples).samples);
    } finally {
      rmSync(root, { recursive: true, force: true });
      generateSamples.mockReset();
    }
  });

  it('追加前拒绝损坏样本，不调用生成器', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-sample-preflight-'));
    try {
      mkdirSync(join(root, '.omk'));
      writeFileSync(join(root, 'SKILL.md'), '# Example');
      const file = join(root, '.omk', 'eval-samples.json');
      writeFileSync(file, '{broken');
      generateSamples.mockClear();
      await assert.rejects(() => runCommand(SampleCommand, [root, '--append', '--executor', 'claude', '--model', 'fixture'], { cwd: root }));
      expect(generateSamples).not.toHaveBeenCalled();
      assert.equal(readFileSync(file, 'utf8'), '{broken');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [''], ['   '], ['skill.md', '--batch'], ['skill.md', '--from-traces'],
    ['--observations-dir', 'inbox'], ['skill.md', '--model', ''],
    ['--batch', '--skill-dir', ''], ['--from-traces', '--observations-dir', ''],
  ])('拒绝无效输入 %j，生成器不执行', async (...argv) => {
    generateSamples.mockClear();
    await expect(runCommand(SampleCommand, argv)).rejects.toMatchObject({ code: 2 });
    expect(generateSamples).not.toHaveBeenCalled();
  });

  it('--help 默认 zh', async () => {
    const stdout = await renderCommandHelp('sample');
    assert.ok(stdout.includes('为指定 skill 生成评测用例'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('--batch'), 'stdout missing --batch flag');
    assert.ok(!stdout.includes('--fix'), 'removed --fix flag must stay absent');
    assert.ok(stdout.includes('--skill'), 'stdout missing --skill flag');
  });

  it('--help --lang en 切英文', async () => {
    const stdout = await renderCommandHelp('sample', 'en');
    assert.ok(stdout.includes('Generate eval samples'), 'stdout should contain en description');
    assert.ok(stdout.includes('specified skill'), 'stdout should describe --skill in English');
  });

  it('缺 positional + 非 batch + 非 from-traces → exit 2 (生产 execute 透传)', async () => {
    try {
      await execFileAsync('node', [CLI, 'sample', '--lang', 'zh']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.ok(
        e.stderr.includes('请指定 skill 文件路径'),
        `stderr missing zh hint:\n${e.stderr}`,
      );
    }
  });

  it('--append 与 --batch 互斥 → exit 2 + 中文提示', async () => {
    try {
      await runCommand(SampleCommand, ['--batch', '--append']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.ok(
        e.stderr.includes('--append') && e.stderr.includes('单 skill'),
        `stderr missing append-single-only hint:\n${e.stderr}`,
      );
    }
  });

  it('--skill 仅支持 --from-traces → exit 2 + 中文提示', async () => {
    try {
      await runCommand(SampleCommand, ['skills/demo/SKILL.md', '--skill', 'audit']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.ok(
        e.stderr.includes('--skill') && e.stderr.includes('--from-traces'),
        `stderr missing skill-from-traces-only hint:\n${e.stderr}`,
      );
    }
  });

  it('非法 --count --lang en → exit 2 + English parser error', async () => {
    try {
      await execFileAsync('node', [CLI, 'sample', 'skills/demo/SKILL.md', '--count', 'abc', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--count[\s\S]*integer[\s\S]*1/, `stderr missing en parser error:\n${e.stderr}`);
    }
  });

  it('--batch + 不存在的 skill-dir → exit 1', async () => {
    try {
      await runCommand(SampleCommand, ['--batch', '--skill-dir', '/tmp/omk-nonexistent-skill-dir-xyz']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1, got ${e.code}:\n${e.stderr}`);
    }
  });
});
