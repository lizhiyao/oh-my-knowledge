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
  const tmp = mkdtempSync(join(tmpdir(), 'eval-doctor-broken-'));
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

/** Batch 模式:skills/<name>.md + skills/<name>.eval-samples.json 配对。
 *  broken.md 内容过短, healthy.md 正常。--batch 自动发现两者, doctor 应卡 broken。 */
function setupBatchMixedSkillDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'eval-batch-doctor-'));
  const skillDir = join(tmp, 'skills');
  mkdirSync(skillDir);
  // broken: 内容过短, doctor skill_readable 必 fail
  writeFileSync(join(skillDir, 'broken.md'), 'hi');
  writeFileSync(join(skillDir, 'broken.eval-samples.json'), JSON.stringify({
    samples: [{ sample_id: 'b1', prompt: 'test prompt for broken' }],
  }));
  // healthy: batch 至少有一个 entry; 单独跑会 pass
  writeFileSync(join(skillDir, 'healthy.md'), '你是一个版本健康的 skill, 内容足够长以通过 skill_readable rule。');
  writeFileSync(join(skillDir, 'healthy.eval-samples.json'), JSON.stringify({
    samples: [{ sample_id: 'h1', prompt: 'test prompt for healthy' }],
  }));
  return tmp;
}

describe('omk eval doctor preflight embedding', () => {
  it('eval --dry-run aborts when doctor detects broken skill', async () => {
    const broken = setupBrokenSkillDir();
    try {
      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'eval',
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

  it('eval applies the same doctor gate as the old CI path', async () => {
    const broken = setupBrokenSkillDir();
    try {
      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'eval',
          '--samples', join(broken, 'eval-samples.json'),
          '--skill-dir', join(broken, 'skills'),
          '--control', 'v1',
          '--treatment', 'v2',
          '--dry-run',
        ], { cwd: broken }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'), `eval should gate on doctor: ${e.stderr.slice(0, 500)}`);
          return true;
        },
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('eval --dry-run on healthy example skills passes doctor and proceeds', async () => {
    // example skills are healthy; --dry-run skips LLM connectivity (separate from doctor)
    const { stdout, stderr } = await execFileAsync('node', [
      CLI, 'eval',
      '--samples', EXAMPLE_SAMPLES,
      '--skill-dir', EXAMPLE_SKILLS_DIR,
      '--control', 'v1',
      '--treatment', 'v2',
      '--dry-run',
    ]);
    // Should NOT fail with doctor
    assert.ok(!stderr.includes('doctor failed:'), `stderr should not have doctor failure: ${stderr.slice(0, 500)}`);
    assert.ok(stdout.includes('Eval dry-run'));
  });

  it('--skip-connectivity does not bypass doctor', async () => {
    // doctor 是强制门禁, 没有 skip flag — broken skill 一定 abort,
    // --skip-connectivity 只跳 LLM 连通性, 不影响 doctor。
    const broken = setupBrokenSkillDir();
    try {
      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'eval',
          '--samples', join(broken, 'eval-samples.json'),
          '--skill-dir', join(broken, 'skills'),
          '--control', 'v1',
          '--treatment', 'v2',
          '--dry-run',
          '--skip-connectivity',
        ], { cwd: broken }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'), `doctor should still gate: ${e.stderr.slice(0, 400)}`);
          return true;
        },
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('eval --batch --dry-run aborts when any batch entry fails doctor', async () => {
    // batch dry-run 必须和 single dry-run 一样走 doctor 强制门禁。
    // 不走的话, broken skill 在 batch 模式 dry-run 阶段会静默通过, 与"doctor 强制 + dry-run 也覆盖"的语义不一致。
    const tmp = setupBatchMixedSkillDir();
    try {
      await assert.rejects(
        () => execFileAsync('node', [
          CLI, 'eval',
          '--skill-dir', join(tmp, 'skills'),
          '--batch',
          '--dry-run',
        ], { cwd: tmp }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'), `batch dry-run should gate on doctor: ${e.stderr.slice(0, 500)}`);
          assert.ok(e.stderr.includes('skill=broken'), `error should name the failing skill: ${e.stderr.slice(0, 500)}`);
          return true;
        },
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
        CLI, 'eval',
        '--samples', join(tmp, 'eval-samples.json'),
        '--skill-dir', skillDir,
        '--control', 'v1',
        '--treatment', 'v2',
        '--dry-run',
      ], { cwd: tmp });

      // doctor 应该只检查 v1 + v2 (健康), 完全忽略 draft.md
      assert.ok(!stderr.includes('doctor failed:'), `expected no doctor failure when draft.md is unrelated to this run; stderr: ${stderr.slice(0, 400)}`);
      assert.ok(stdout.includes('Eval dry-run'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
