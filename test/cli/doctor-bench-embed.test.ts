import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'src', 'cli', 'index.js');
const EXAMPLE_SAMPLES = join(PROJECT_ROOT, 'examples', 'code-review', 'eval-samples.json');
const EXAMPLE_SKILLS_DIR = join(PROJECT_ROOT, 'examples', 'code-review', 'skills');

interface ExecError extends Error {
  code: number;
  stdout: string;
  stderr: string;
}

/** 准备一个 broken skill 目录(skill 内容过短,会被 doctor 的 skill_readable 卡掉) */
function setupBrokenSkillDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'bench-doctor-broken-'));
  const skillDir = join(tmp, 'skills');
  mkdirSync(skillDir);
  writeFileSync(join(skillDir, 'v1.md'), 'hi'); // 2 chars, fails skill_readable (min 10)
  writeFileSync(join(skillDir, 'v2.md'), 'hi'); // need at least 2 variants for control/treatment
  // 写 minimal samples
  writeFileSync(join(tmp, 'eval-samples.json'), JSON.stringify({
    samples: [{ sample_id: 's1', prompt: 'test prompt' }],
  }));
  return tmp;
}

describe('bench run / gate doctor preflight embedding', () => {
  it('bench run --dry-run aborts when doctor detects broken skill', async () => {
    const broken = setupBrokenSkillDir();
    try {
      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'bench', 'run',
          '--samples', join(broken, 'eval-samples.json'),
          '--skill-dir', join(broken, 'skills'),
          '--control', 'v1',
          '--treatment', 'v2',
          '--dry-run',
        ], { cwd: broken }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'), `stderr should include 'doctor failed:': ${e.stderr.slice(0, 500)}`);
          return true;
        },
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('bench run --skip-doctor bypasses doctor preflight', async () => {
    const broken = setupBrokenSkillDir();
    try {
      // --skip-doctor + --dry-run 应该跑过 doctor 阻断, 进入 dry-run 输出
      const { stderr } = await execFileAsync('node', [
        CLI, 'bench', 'run',
        '--samples', join(broken, 'eval-samples.json'),
        '--skill-dir', join(broken, 'skills'),
        '--control', 'v1',
        '--treatment', 'v2',
        '--dry-run',
        '--skip-doctor',
      ], { cwd: broken });
      assert.ok(stderr.includes('--skip-doctor'), `stderr should mention skip-doctor warning: ${stderr.slice(0, 300)}`);
      assert.ok(!stderr.includes('doctor failed:'));
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('bench gate aborts when doctor detects broken skill', async () => {
    const broken = setupBrokenSkillDir();
    try {
      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'bench', 'gate',
          '--samples', join(broken, 'eval-samples.json'),
          '--skill-dir', join(broken, 'skills'),
          '--control', 'v1',
          '--treatment', 'v2',
          '--dry-run',
        ], { cwd: broken }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'), `bench gate should also gate on doctor: ${e.stderr.slice(0, 500)}`);
          return true;
        },
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('bench run --dry-run on healthy example skills passes doctor and proceeds', async () => {
    // example skills are healthy; --dry-run skips smoke (LLM)
    const { stdout, stderr } = await execFileAsync('node', [
      CLI, 'bench', 'run',
      '--samples', EXAMPLE_SAMPLES,
      '--skill-dir', EXAMPLE_SKILLS_DIR,
      '--control', 'v1',
      '--treatment', 'v2',
      '--dry-run',
    ]);
    // Should NOT fail with doctor
    assert.ok(!stderr.includes('doctor failed:'), `stderr should not have doctor failure: ${stderr.slice(0, 500)}`);
    // dry-run output should be present
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.dryRun, true);
  });

  it('doctor preflight only checks variants used in this run, not unrelated drafts in the same skill-dir', async () => {
    // 准备目录: v1.md 和 v2.md 健康, draft.md 内容过短(会被 doctor fail).
    // 本次评测只用 --control v1 --treatment v2, 不应被 draft.md 阻断。
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-preflight-converge-'));
    try {
      const skillDir = join(tmp, 'skills');
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, 'v1.md'), '你是一个版本 1 的代码审查助手,做基础检查。');
      writeFileSync(join(skillDir, 'v2.md'), '你是一个版本 2 的代码审查助手,加了安全检查。');
      writeFileSync(join(skillDir, 'draft.md'), 'hi');  // < 10 字符,本来会 fail
      writeFileSync(join(tmp, 'eval-samples.json'), JSON.stringify({
        samples: [{ sample_id: 's1', prompt: 'review' }],
      }));

      const { stdout, stderr } = await execFileAsync('node', [
        CLI, 'bench', 'run',
        '--samples', join(tmp, 'eval-samples.json'),
        '--skill-dir', skillDir,
        '--control', 'v1',
        '--treatment', 'v2',
        '--dry-run',
      ], { cwd: tmp });

      // doctor 应该只检查 v1 + v2 (健康), 完全忽略 draft.md
      assert.ok(!stderr.includes('doctor failed:'), `expected no doctor failure when draft.md is unrelated to this run; stderr: ${stderr.slice(0, 400)}`);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.dryRun, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
