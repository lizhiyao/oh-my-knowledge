/**
 * source-resolver 的 git 物化单测:真实临时 git 仓库。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveInstallSource, SourceResolveError } from '../../src/inputs/source-resolver.js';

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

describe('source-resolver git', () => {
  let repo: string;
  let prevCwd: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'omk-src-git-')));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    mkdirSync(join(repo, 'skills', 'review', 'references'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'review', 'SKILL.md'), '# review\n');
    writeFileSync(join(repo, 'skills', 'review', 'references', 'cmd.md'), 'asset\n');
    mkdirSync(join(repo, 'skills', 'review', '.omk'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'review', '.omk', 'samples.json'), '[]\n');
    writeFileSync(join(repo, 'notes.md'), '# notes\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    prevCwd = process.cwd();
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('物化目录-skill 到临时目录,含资产、排除 .omk', () => {
    const src = resolveInstallSource('git:HEAD:skills/review');
    try {
      assert.equal(src.sourceKind, 'git');
      assert.equal(src.name, 'review');
      assert.equal(src.isDirectorySkill, true);
      assert.equal(src.ref, 'HEAD');
      assert.equal(src.locator, 'git:HEAD:skills/review');
      assert.ok(existsSync(join(src.localRoot, 'SKILL.md')), 'SKILL.md 应被物化');
      assert.ok(existsSync(join(src.localRoot, 'references', 'cmd.md')), '资产应被物化');
      assert.ok(!existsSync(join(src.localRoot, '.omk')), '.omk 评测数据不该被物化');
    } finally {
      src.cleanup();
    }
  });

  it('物化文件-skill 为单个 .md', () => {
    const src = resolveInstallSource('git:HEAD:notes');
    try {
      assert.equal(src.isDirectorySkill, false);
      assert.equal(src.name, 'notes');
      assert.ok(existsSync(src.localRoot));
      assert.ok(src.localRoot.endsWith('notes.md'));
    } finally {
      src.cleanup();
    }
  });

  it('具体 commit SHA 也能解析', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const src = resolveInstallSource(`git:${sha}:skills/review`);
    try {
      assert.equal(src.ref, sha);
      assert.ok(existsSync(join(src.localRoot, 'SKILL.md')));
    } finally {
      src.cleanup();
    }
  });

  it('cleanup 删除临时目录', () => {
    const src = resolveInstallSource('git:HEAD:skills/review');
    const root = src.localRoot;
    assert.ok(existsSync(root));
    src.cleanup();
    assert.ok(!existsSync(root), 'cleanup 后临时目录应被删');
  });

  it('skill 在该 ref 不存在 → SourceResolveError(git_skill_not_found)', () => {
    assert.throws(
      () => resolveInstallSource('git:HEAD:nope'),
      (e: unknown) => e instanceof SourceResolveError && e.messageKey === 'cli.install.git_skill_not_found',
    );
  });

  it('ref 不存在 → SourceResolveError', () => {
    assert.throws(
      () => resolveInstallSource('git:doesnotexist:skills/review'),
      (e: unknown) => e instanceof SourceResolveError,
    );
  });
});

describe('source-resolver git outside repo', () => {
  it('非 git 仓库 → not_a_git_repo', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'omk-src-nogit-')));
    const prev = process.cwd();
    process.chdir(dir);
    try {
      assert.throws(
        () => resolveInstallSource('git:HEAD:review'),
        (e: unknown) => e instanceof SourceResolveError && e.messageKey === 'cli.install.not_a_git_repo',
      );
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
