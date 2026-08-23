/**
 * oclif 路由验收 + evolve command 生命周期测试。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import EvolveCommand from '../../src/cli/commands/evolve.js';
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


describe('oclif evolve', () => {
  it('--help 默认 zh', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'evolve', '--help']);
    assert.ok(stdout.includes('自动迭代改进 skill'), `stdout missing zh:\n${stdout}`);
    assert.ok(stdout.includes('--rounds'), 'stdout missing --rounds flag');
    assert.ok(stdout.includes('--target'), 'stdout missing --target flag');
    assert.ok(stdout.includes('--improve-model'), 'stdout missing --improve-model flag');
    assert.ok(stdout.includes('--no-significance-gate'), 'stdout missing --no-significance-gate flag');
    assert.ok(stdout.includes('--test-ratio'), 'stdout missing --test-ratio flag');
    assert.ok(stdout.includes('--edit-budget'), 'stdout missing --edit-budget flag');
  });

  it('非法 --significance-alpha → exit 2', async () => {
    try {
      await runCommand(EvolveCommand, ['skills/demo/SKILL.md', '--significance-alpha', '2']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
    }
  });

  it('--test-ratio 不配 --holdout-ratio → exit 2', async () => {
    try {
      await runCommand(EvolveCommand, ['skills/demo/SKILL.md', '--test-ratio', '0.2']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--test-ratio[\s\S]*--holdout-ratio/, `stderr missing guard message:\n${e.stderr}`);
    }
  });

  it('--help --lang en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'evolve', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('Auto-iterate skill improvement'), 'stdout should contain en description');
  });

  it('非法 --rounds → exit 2 + 中文 parser 错误', async () => {
    try {
      await runCommand(EvolveCommand, ['skills/demo/SKILL.md', '--rounds', 'nope']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--rounds(?=[\s\S]*整数)(?=[\s\S]*1)/, `stderr missing zh parser error:\n${e.stderr}`);
    }
  });

  it('非法 --effort --lang en → exit 2 + English parser error', async () => {
    try {
      await execFileAsync('node', [CLI, 'evolve', 'skills/demo/SKILL.md', '--effort', 'turbo', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--effort[\s\S]*low[\s\S]*medium[\s\S]*high[\s\S]*xhigh[\s\S]*max/, `stderr missing en parser error:\n${e.stderr}`);
    }
  });

  it('缺 skillPath positional → exit 2(oclif required-args)', async () => {
    try {
      await runCommand(EvolveCommand, []);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
    }
  });
});
