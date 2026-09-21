import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
// @ts-expect-error CI bootstrap runs as plain Node before dependency installation.
import { classifyPaths, detectScope } from '../../scripts/ci/scope.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('CI change scope', () => {
  it.each([
    [['AGENTS.md'], 'rules'],
    [['CONTRIBUTING.md', 'CLAUDE.md', 'CODE_REVIEW.md', '.github/PULL_REQUEST_TEMPLATE.md'], 'rules'],
    // 双语孪生文件与原本同意图：改文不改行为。
    [['CONTRIBUTING.zh.md'], 'rules'],
    [['AGENTS.en.md', 'CODE_REVIEW.en.md', 'schemas/README.zh.md'], 'rules'],
    [['CONTRIBUTING.zh.md', 'src/cli/lib/i18n.ts'], 'full'],
    // 模块级维护文档与根规则文件同档；与源码混排时仍按最强门禁。
    [['src/studio/README.md'], 'rules'],
    [['src/studio/README.md', 'src/observability/README.md'], 'rules'],
    [['src/studio/README.md', 'AGENTS.md'], 'rules'],
    [['src/studio/README.md', 'src/studio/web/components/knowledge/knowledge.tsx'], 'full'],
    [['src/studio/README.md', 'docs/guides/a.md'], 'docs'],
    // 边界：只认模块目录下的 README.md，不认裸 `src/README.md`、非 README 的 Markdown 与站点配置。
    [['src/README.md'], 'full'],
    [['src/studio/README.markdown'], 'full'],
    [['docs/guides/a.md', 'docs/zh/guides/a.md'], 'docs'],
    [['AGENTS.md', 'README.zh.md'], 'docs'],
    [['docs/guides/a.md', 'src/a.ts'], 'full'],
    [['src/observability/prompts/a.prompt.md'], 'full'],
    [['.agents/skills/omk/SKILL.md'], 'full'],
    [['examples/skill/SKILL.md'], 'full'],
    [['docs/reference/cli.md'], 'full'],
    [['docs/zh/specs/cli-evaluation-input-compilation.md'], 'full'],
    [['docs/.vitepress/config.ts'], 'full'],
    [['docs/.vitepress/README.md'], 'full'],
    [['docs/public/logo.svg'], 'full'],
    [['.github/workflows/ci.yml'], 'full'],
    [['scripts/ci/scope.mjs'], 'full'],
    [['package.json', 'yarn.lock'], 'full'],
    [['unrecognized.md'], 'full'],
    [[], 'full'],
  ])('classifies %j as %s', (paths, expected) => { expect(classifyPaths(paths)).toBe(expected); });

  it('uses the whole commit range, handles unusual names and cannot hide source deletion in a rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-ci-scope-')); roots.push(root);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'AGENTS.md'), 'original\n'); writeFileSync(join(root, 'src/a.md'), 'runtime\n');
    git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'AGENTS.md'), 'changed\n');
    git('add', '.'); git('commit', '-qm', 'rules'); const rules = git('rev-parse', 'HEAD');
    expect(detectScope(base, rules, root)).toBe('rules');
    renameSync(join(root, 'src/a.md'), join(root, 'docs/name\nwith space.md'));
    git('add', '-A'); git('commit', '-qm', 'rename');
    expect(detectScope(base, git('rev-parse', 'HEAD'), root)).toBe('full');
    expect(detectScope(rules, rules, root)).toBe('full');
    expect(detectScope('0'.repeat(40), rules, root)).toBe('full');
    expect(detectScope('a'.repeat(40), rules, root)).toBe('full');
    expect(detectScope('--help', rules, root)).toBe('full');
  });
});

const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  on: Record<string, unknown>;
  jobs: Record<string, { needs?: string[] | string; if?: string; name?: string; steps: { run?: string; env?: Record<string, string> }[] }>;
};

describe('required CI checks', () => {
  it('always emits both protected names and falls back to full jobs on missing classification', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'push', 'pull_request']);
    for (const job of ['quality', 'test_22_shard', 'test_24_shard']) {
      expect(workflow.jobs[job].needs).toBe('changes');
    }
    for (const job of ['quality', 'test_22_shard', 'test_24_shard']) {
      expect(workflow.jobs[job].if).toContain("needs.changes.result != 'success'");
      expect(workflow.jobs[job].if).toContain("needs.changes.outputs.scope != 'rules'");
      expect(workflow.jobs[job].if).toContain("needs.changes.outputs.scope != 'docs'");
    }
    // PR 非 dependabot 时 test_22_shard 跳过（PR 只跑 24）；main/release/dependabot 保留。
    expect(workflow.jobs.test_22_shard.if).toContain("github.event_name != 'pull_request'");
    expect(workflow.jobs.test_22_shard.if).toContain("dependencies");
    for (const version of ['22', '24']) {
      const job = workflow.jobs[`test_${version}`];
      expect(job.name).toBe(`test (${version})`);
      expect(job.if).toBe('${{ always() }}');
      expect(job.needs).toEqual(['changes', 'lightweight', 'quality', `test_${version}_shard`, 'test_macos']);
      expect(job.steps[0].env?.SHARD_RESULT).toContain(`needs.test_${version}_shard.result`);
      expect(job.steps[0].env?.MACOS_RESULT).toContain('needs.test_macos.result');
    }
  });

  for (const version of ['22', '24']) {
    it(`executes the Node ${version} required gate for success, failure, cancellation and unexpected skips`, () => {
      // Execute the actual workflow shell, rather than duplicating its gate logic in the test.
      const script = workflow.jobs[`test_${version}`].steps[0].run!;
      const run = (env: Record<string, string>) => spawnSync('bash', ['-e', '-c', script], {
        env: { PATH: process.env.PATH, CHANGE_RESULT: 'success', SCOPE: 'rules', LIGHT_RESULT: 'success',
          QUALITY_RESULT: 'skipped', SHARD_RESULT: 'skipped', MACOS_RESULT: 'skipped', IS_PR: 'false', IS_DEPENDABOT: 'false', ...env }, encoding: 'utf8',
      }).status;
      // PR 非 dependabot：test_22_shard 跳过，门禁接受 skipped。
      expect(run({ IS_PR: 'true', IS_DEPENDABOT: 'false', SHARD_RESULT: 'skipped' })).toBe(0);
      expect(run({ IS_PR: 'true', IS_DEPENDABOT: 'false', SHARD_RESULT: 'success' })).not.toBe(0);
      // PR dependabot 或非 PR：走原有门禁。
      for (const scope of ['rules', 'docs']) {
        expect(run({ SCOPE: scope })).toBe(0);
        for (const result of ['failure', 'cancelled', 'skipped', '']) {
          expect(run({ SCOPE: scope, LIGHT_RESULT: result })).not.toBe(0);
        }
        expect(run({ SCOPE: scope, SHARD_RESULT: 'failure' })).not.toBe(0);
        expect(run({ SCOPE: scope, MACOS_RESULT: 'failure' })).not.toBe(0);
      }
      for (const scope of ['full', '', 'unknown']) {
        expect(run({ SCOPE: scope, QUALITY_RESULT: 'success', SHARD_RESULT: 'success', MACOS_RESULT: 'success' })).toBe(0);
        for (const result of ['failure', 'cancelled', 'skipped', '']) {
          expect(run({ SCOPE: scope, QUALITY_RESULT: result, SHARD_RESULT: 'success', MACOS_RESULT: 'success' })).not.toBe(0);
          expect(run({ SCOPE: scope, QUALITY_RESULT: 'success', SHARD_RESULT: result, MACOS_RESULT: 'success' })).not.toBe(0);
          expect(run({ SCOPE: scope, QUALITY_RESULT: 'success', SHARD_RESULT: 'success', MACOS_RESULT: result })).not.toBe(0);
        }
      }
      expect(run({ CHANGE_RESULT: 'failure' })).not.toBe(0);
      expect(run({ CHANGE_RESULT: 'failure', QUALITY_RESULT: 'success', SHARD_RESULT: 'success', MACOS_RESULT: 'success' })).toBe(0);
    });
  }
});
