/**
 * oclif 路径 doctor 命令验收。
 * 跟 test/cli.test.ts L341-357 的 legacy doctor 测试对照,验证迁移后行为对得齐:
 * - --help 双语切换
 * - happy path 同 legacy stderr 关键字
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCommandHelp } from '../helpers/run-command.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}


describe('oclif doctor', () => {
  it('--help 默认 zh 含中文 description', async () => {
    const stdout = await renderCommandHelp('doctor');
    assert.ok(stdout.includes('体检 omk 工作目录'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('USAGE'), 'stdout missing USAGE block');
    assert.ok(stdout.includes('--repeat'), 'stdout missing --repeat flag');
    assert.ok(stdout.includes('--static-only'), 'stdout must list --static-only flag');
  });

  it('--help --lang en 切到英文 description', async () => {
    const stdout = await renderCommandHelp('doctor', 'en');
    assert.ok(stdout.includes('Preflight health checks'), `stdout missing en description:\n${stdout}`);
    assert.ok(!stdout.includes('体检 omk 工作目录'), 'stdout should not contain zh in --lang en mode');
  });

  it('OMK_LANG=en env 同效切到英文', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help'], { env: { ...process.env, OMK_LANG: 'en' } });
    assert.ok(stdout.includes('Preflight health checks'), 'OMK_LANG=en should switch help to en');
  });

  it('非法采样参数 → exit code 2, 不进入 LLM 体检', async () => {
    try {
      await execFileAsync('node', [CLI, 'doctor', '--repeat', 'abc', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.match(e.stderr, /--repeat[\s\S]*integer[\s\S]*1[\s\S]*10/, `stderr missing parser range:\n${e.stderr}`);
    }
  });
  it('flushes a large failed JSON report to a slow pipe before exiting through oclif', async () => {
    // Real process boundary: in-process console capture cannot detect truncated pipe writes.
    const root = await mkdtemp(join(tmpdir(), 'omk-doctor-pipe-'));
    try {
      for (let i = 0; i < 80; i++) {
        const skill = join(root, 'skills', `broken-${i}`);
        await mkdir(skill, { recursive: true });
        await writeFile(join(skill, 'SKILL.md'), '---\nname: [\n---\n# Broken\n');
      }
      const child = spawn(process.execPath, [CLI, 'doctor', '--static-only', '--json'], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: root, OMK_HOME: join(root, 'home'), OMK_SKIP_UPDATE_CHECK: '1' },
      });
      let stdout = '';
      let stderr = '';
      // Pause between chunks to force backpressure instead of eagerly draining the pipe.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 25);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const result = { stdout, stderr, code };
      assert.equal(result.code, 1);
      assert.ok(result.stdout.length > 65_536);
      const report = JSON.parse(result.stdout);
      assert.equal(report.outcome, 'failed');
      assert.equal(report.skills.length, 80);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
