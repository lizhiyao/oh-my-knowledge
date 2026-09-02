import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import EvalCommand from '../../src/cli/commands/eval/index.js';
import { runCommand } from '../helpers/run-command.js';

const PROJECT_ROOT = process.cwd();
const EXAMPLE_SAMPLES = join(PROJECT_ROOT, 'test', 'fixtures', 'code-review', 'eval-samples.json');
const EXAMPLE_SKILLS_DIR = join(PROJECT_ROOT, 'test', 'fixtures', 'code-review', 'skills');
const CUSTOM_EXECUTOR = join(
  PROJECT_ROOT,
  'test',
  'fixtures',
  'custom-executor',
  'core-fixture-executor.sh',
);

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
    schemaVersion: 'omk.eval-sample-set/v1',
    samples: [{
      sample_id: 's1',
      prompt: 'test prompt',
      assertions: [{ type: 'contains', value: 'test' }],
    }],
  }));
  return tmp;
}

/** Batch 模式：每个目录 skill 使用 `.omk/eval-samples.json` 私有用例。
 * broken 内容过短，healthy 正常。--batch 自动发现两者，doctor 应卡 broken。 */
function setupBatchMixedSkillDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'eval-batch-doctor-'));
  const skillDir = join(tmp, 'skills');
  mkdirSync(skillDir);
  // broken：内容过短，doctor skill_readable 必 fail
  mkdirSync(join(skillDir, 'broken', '.omk'), { recursive: true });
  writeFileSync(join(skillDir, 'broken', 'SKILL.md'), 'hi');
  writeFileSync(join(skillDir, 'broken', '.omk', 'eval-samples.json'), JSON.stringify({
    schemaVersion: 'omk.eval-sample-set/v1',
    samples: [{
      sample_id: 'b1',
      prompt: 'test prompt for broken',
      assertions: [{ type: 'contains', value: 'test' }],
    }],
  }));
  // healthy：batch 至少有一个 entry；单独跑会 pass
  mkdirSync(join(skillDir, 'healthy', '.omk'), { recursive: true });
  writeFileSync(join(skillDir, 'healthy', 'SKILL.md'), '你是一个版本健康的 skill, 内容足够长以通过 skill_readable rule。');
  writeFileSync(join(skillDir, 'healthy', '.omk', 'eval-samples.json'), JSON.stringify({
    schemaVersion: 'omk.eval-sample-set/v1',
    samples: [{
      sample_id: 'h1',
      prompt: 'test prompt for healthy',
      assertions: [{ type: 'contains', value: 'test' }],
    }],
  }));
  return tmp;
}

describe('omk eval doctor preflight embedding', () => {
  it('eval --dry-run aborts when doctor detects broken skill', async () => {
    const broken = setupBrokenSkillDir();
    try {
      await assert.rejects(
        () => runCommand(EvalCommand, [
          '--samples', join(broken, 'eval-samples.json'),
          '--skill-dir', join(broken, 'skills'),
          '--control', 'v1',
          '--treatment', 'v2',
          '--executor', CUSTOM_EXECUTOR,
          '--no-judge',
          '--dry-run',
        ], { cwd: broken }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'), `stderr should include 'doctor failed:': ${e.stderr.slice(0, 500)}`);
          assert.ok(e.stderr.includes('发布前 doctor 门禁未通过'), `stderr should explain the pre-ship gate: ${e.stderr.slice(0, 800)}`);
          assert.ok(e.stderr.includes('修复清单'), `stderr should include a repair checklist: ${e.stderr.slice(0, 800)}`);
          assert.ok(e.stderr.includes('omk doctor --gate'), `stderr should explain how to verify doctor fixes: ${e.stderr.slice(0, 800)}`);
          assert.ok(e.stderr.includes('继续比较分数会是 garbage-in'), `stderr should explain why eval stopped: ${e.stderr.slice(0, 800)}`);
          assert.ok(e.stderr.includes('重跑 `omk eval`'), `stderr should tell users what to do next: ${e.stderr.slice(0, 800)}`);
          assert.ok(e.stderr.includes('--skip-doctor'), `stderr should mention the explicit escape hatch: ${e.stderr.slice(0, 800)}`);
          return true;
        },
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('eval doctor gate is actionable in English too', async () => {
    const broken = setupBrokenSkillDir();
    try {
      await assert.rejects(
        () => runCommand(EvalCommand, [
          '--samples', join(broken, 'eval-samples.json'),
          '--skill-dir', join(broken, 'skills'),
          '--control', 'v1',
          '--treatment', 'v2',
          '--executor', CUSTOM_EXECUTOR,
          '--no-judge',
          '--dry-run',
          '--lang', 'en',
        ], { cwd: broken }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('pre-ship doctor gate failed'), `stderr should explain the pre-ship gate: ${e.stderr.slice(0, 800)}`);
          assert.ok(e.stderr.includes('re-run `omk eval`'), `stderr should tell users what to do next: ${e.stderr.slice(0, 800)}`);
          assert.ok(e.stderr.includes('garbage-in'), `stderr should explain why eval stopped: ${e.stderr.slice(0, 800)}`);
          assert.ok(e.stderr.includes('--skip-doctor'), `stderr should mention the explicit escape hatch: ${e.stderr.slice(0, 800)}`);
          return true;
        },
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('eval --dry-run on healthy example skills passes doctor and proceeds', async () => {
    // example skills are healthy; --dry-run skips LLM connectivity (separate from doctor)
    const { stdout, stderr } = await runCommand(EvalCommand, [
      '--samples', EXAMPLE_SAMPLES,
      '--skill-dir', EXAMPLE_SKILLS_DIR,
      '--control', 'v1',
      '--treatment', 'v2',
      '--executor', CUSTOM_EXECUTOR,
      '--no-judge',
      '--dry-run',
      '--lang', 'zh',
    ]);
    // Should NOT fail with doctor
    assert.ok(!stderr.includes('doctor failed:'), `stderr should not have doctor failure: ${stderr.slice(0, 500)}`);
    assert.equal(JSON.parse(stdout).projectionKind, 'core-cli-dry-run');
  });

  it('--skip-connectivity does not bypass doctor', async () => {
    // --skip-connectivity 只跳 LLM 连通性，不影响 doctor gate；
    // 真要绕开 doctor 必须显式用 --skip-doctor。
    const broken = setupBrokenSkillDir();
    try {
      await assert.rejects(
        () => runCommand(EvalCommand, [
          '--samples', join(broken, 'eval-samples.json'),
          '--skill-dir', join(broken, 'skills'),
          '--control', 'v1',
          '--treatment', 'v2',
          '--executor', CUSTOM_EXECUTOR,
          '--no-judge',
          '--dry-run',
          '--skip-connectivity',
        ], { cwd: broken }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'), `doctor should still gate: ${e.stderr.slice(0, 400)}`);
          assert.ok(e.stderr.includes('发布前 doctor 门禁未通过'), `doctor gate should stay actionable: ${e.stderr.slice(0, 800)}`);
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
        () => runCommand(EvalCommand, [
          '--skill-dir', join(tmp, 'skills'),
          '--batch',
          '--dry-run',
          '--executor', CUSTOM_EXECUTOR,
          '--no-judge',
        ], { cwd: tmp }),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'), `batch dry-run should gate on doctor: ${e.stderr.slice(0, 500)}`);
          assert.ok(e.stderr.includes('Core Batch：broken') && e.stderr.includes('[broken]'),
            `error should name the failing skill: ${e.stderr.slice(0, 500)}`);
          assert.ok(e.stderr.includes('发布前 doctor 门禁未通过'), `batch error should keep the actionable gate text: ${e.stderr.slice(0, 800)}`);
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
        schemaVersion: 'omk.eval-sample-set/v1',
        samples: [{
          sample_id: 's1',
          prompt: 'review',
          assertions: [{ type: 'contains', value: 'review' }],
        }],
      }));

      const { stdout, stderr } = await runCommand(EvalCommand, [
        '--samples', join(tmp, 'eval-samples.json'),
        '--skill-dir', skillDir,
        '--control', 'v1',
        '--treatment', 'v2',
        '--executor', CUSTOM_EXECUTOR,
        '--no-judge',
        '--dry-run',
        '--lang', 'zh',
      ], { cwd: tmp });

      // doctor 应该只检查 v1 + v2 (健康), 完全忽略 draft.md
      assert.ok(!stderr.includes('doctor failed:'), `expected no doctor failure when draft.md is unrelated to this run; stderr: ${stderr.slice(0, 400)}`);
      assert.equal(JSON.parse(stdout).projectionKind, 'core-cli-dry-run');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
