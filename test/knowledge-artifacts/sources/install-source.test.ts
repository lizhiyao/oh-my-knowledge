/**
 * source-resolver 的 git 物化单测:真实临时 git 仓库。
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveInstallSource, SourceResolveError } from '../../../src/knowledge-artifacts/sources/install-source.js';

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

describe('source-resolver git', () => {
  let repo: string;
  let prevCwd: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'omk-src-git-')));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    mkdirSync(join(repo, 'skills', 'review', 'references'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'review', 'SKILL.md'), '# review\n');
    writeFileSync(join(repo, 'skills', 'review', 'references', 'cmd.md'), 'asset\n');
    mkdirSync(join(repo, 'skills', 'review', '.omk'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'review', '.omk', 'eval-samples.json'), '[]\n');
    writeFileSync(join(repo, 'notes.md'), '# notes\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
    prevCwd = process.cwd();
    process.chdir(repo);
  });

  afterAll(() => {
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

  it('显式 .md / SKILL.md spec 与本地路径安装对称', () => {
    // 显式文件名
    const f = resolveInstallSource('git:HEAD:notes.md');
    try {
      assert.equal(f.isDirectorySkill, false);
      assert.equal(f.name, 'notes');
    } finally {
      f.cleanup();
    }
    // 显式 SKILL.md → 目录-skill,name 取父目录
    const d = resolveInstallSource('git:HEAD:skills/review/SKILL.md');
    try {
      assert.equal(d.isDirectorySkill, true);
      assert.equal(d.name, 'review');
      assert.equal(d.locator, 'git:HEAD:skills/review/SKILL.md');
      assert.ok(existsSync(join(d.localRoot, 'references', 'cmd.md')), '应物化整树');
    } finally {
      d.cleanup();
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

  it('空 ref(git::x)被拒,绝不当 git index 解析', () => {
    assert.throws(
      () => resolveInstallSource('git::skills/review'),
      (e: unknown) => e instanceof SourceResolveError && e.messageKey === 'cli.install.git_skill_not_found',
    );
  });

  it('空 spec(git:HEAD:)被拒,不退化去探 .md / SKILL.md', () => {
    assert.throws(
      () => resolveInstallSource('git:HEAD:'),
      (e: unknown) => e instanceof SourceResolveError && e.messageKey === 'cli.install.git_skill_not_found',
    );
  });

  it('裸 spec 歧义:文件优先(与 eval 解析顺序一致,防 evidence 静默剥离)', () => {
    writeFileSync(join(repo, 'skills', 'dual.md'), '# dual file\n');
    mkdirSync(join(repo, 'skills', 'dual'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'dual', 'SKILL.md'), '# dual dir\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'dual']);
    const src = resolveInstallSource('git:HEAD:skills/dual');
    try {
      assert.equal(src.isDirectorySkill, false, '同时存在 .md 与 dir/SKILL.md 时应选文件,与 eval 一致');
      assert.equal(src.name, 'dual');
    } finally {
      src.cleanup();
    }
  });

  it('物化保留可执行位', () => {
    const exe = join(repo, 'skills', 'review', 'references', 'run.sh');
    writeFileSync(exe, '#!/bin/sh\necho hi\n');
    chmodSync(exe, 0o755);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'exe']);
    const src = resolveInstallSource('git:HEAD:skills/review');
    try {
      const mode = statSync(join(src.localRoot, 'references', 'run.sh')).mode;
      assert.equal(mode & 0o100, 0o100, '可执行位应随物化保留');
    } finally {
      src.cleanup();
    }
  });

  it('文件名含换行也能物化(ls-tree -z 不 quote)', () => {
    const nl = String.fromCharCode(10);
    const fname = `line${nl}break.md`;
    writeFileSync(join(repo, 'skills', 'review', 'references', fname), 'nl\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'nl']);
    const src = resolveInstallSource('git:HEAD:skills/review');
    try {
      assert.ok(existsSync(join(src.localRoot, 'references', fname)), '含换行文件名应被物化、不被丢');
    } finally {
      src.cleanup();
    }
  });

  it('git 树里的软链被跳过,不物化(与本地分发一致)', () => {
    symlinkSync('SKILL.md', join(repo, 'skills', 'review', 'link.md'));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'link']);
    const src = resolveInstallSource('git:HEAD:skills/review');
    try {
      assert.ok(!existsSync(join(src.localRoot, 'link.md')), '软链不该被物化');
      assert.ok(existsSync(join(src.localRoot, 'SKILL.md')), '正常文件仍物化');
    } finally {
      src.cleanup();
    }
  });

  it('名字以 .md 结尾的目录不被误当文件 blob(cat-file blob 拒 tree,不物化树清单)', () => {
    // git show <ref>:<目录> 退出码 0 且打印树清单文本(`tree HEAD:...\n\nSKILL.md`)。若探测用 show,
    // 裸 spec `skills/foo` 先探 `skills/foo.md`,而 foo.md 恰是目录时 → 被误判为 file-skill、物化树清单
    // 当 skill 正文,真正的 foo/SKILL.md 被跳过。cat-file blob 对 tree 非零退出,探测落空、回退到 dir。
    mkdirSync(join(repo, 'skills', 'foo.md'), { recursive: true }); // 一个名字以 .md 结尾的目录,影子遮挡
    writeFileSync(join(repo, 'skills', 'foo.md', 'note.txt'), 'shadow\n');
    mkdirSync(join(repo, 'skills', 'foo'), { recursive: true }); // 真正的 dir-skill
    writeFileSync(join(repo, 'skills', 'foo', 'SKILL.md'), '# real foo skill\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'shadow']);
    const src = resolveInstallSource('git:HEAD:skills/foo');
    try {
      assert.equal(src.isDirectorySkill, true, 'foo.md 是目录、非 blob,应回退到真正的 foo/SKILL.md(dir-skill)');
      assert.equal(src.name, 'foo');
      const body = readFileSync(join(src.localRoot, 'SKILL.md'), 'utf-8');
      assert.ok(body.includes('real foo skill'), '应物化真正的 SKILL.md,而非 git 树清单文本');
      assert.ok(!body.startsWith('tree '), '绝不能把 `tree HEAD:...` 清单当 skill 正文');
    } finally {
      src.cleanup();
    }
  });

  it('恶意 git tree 含 `..` 子树 → fail closed,不逃逸临时目录写盘', () => {
    // git mktree 手工造一棵 skill 子树:含真 SKILL.md + 名为 `..` 的子树 → ls-tree -r 吐 `../evil.txt`,
    // join(temp, '../evil.txt') 会写到 temp 父级(tmpdir)。必须抛错且不留逃逸残留。
    const ho = (content: string): string =>
      execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, encoding: 'utf-8', input: content }).trim();
    const mktree = (spec: string): string =>
      execFileSync('git', ['mktree'], { cwd: repo, encoding: 'utf-8', input: spec }).trim();
    const tab = String.fromCharCode(9);
    const nl = String.fromCharCode(10);
    // 唯一 marker 名:逃逸落点是 tmpdir()/<markerName>(temp 父级),固定名会被他机残留/并发误炸。
    const markerName = `omk-escape-${process.pid}-${process.hrtime.bigint()}.txt`;
    const evil = ho('pwned' + nl);
    const skillmd = ho('# mal skill' + nl);
    const dotdot = mktree(`100644 blob ${evil}${tab}${markerName}${nl}`);
    const skillTree = mktree(`040000 tree ${dotdot}${tab}..${nl}100644 blob ${skillmd}${tab}SKILL.md${nl}`);
    const rootTree = mktree(`040000 tree ${skillTree}${tab}skill${nl}`);
    const commit = execFileSync('git', ['commit-tree', rootTree, '-m', 'mal'], { cwd: repo, encoding: 'utf-8', input: '' }).trim();
    git(repo, ['update-ref', 'refs/heads/mal', commit]);
    const escaped = join(tmpdir(), markerName); // temp = mkdtemp(tmpdir()/omk-install-git-*),父级即 tmpdir
    try {
      assert.ok(!existsSync(escaped), '前置:逃逸落点应不存在');
      assert.throws(
        () => resolveInstallSource('git:mal:skill'),
        (e: unknown) => e instanceof SourceResolveError && e.messageKey === 'cli.install.git_unsafe_path',
      );
      assert.ok(!existsSync(escaped), '越界路径绝不能写出临时目录');
    } finally {
      rmSync(escaped, { force: true }); // 万一回归(写出了),也不留脏
    }
  });

  it('从仓库子目录执行也能物化(ls-tree --full-tree,不受 cwd 前缀限制)', () => {
    const prev = process.cwd();
    process.chdir(join(repo, 'skills', 'review'));
    try {
      const src = resolveInstallSource('git:HEAD:SKILL.md');
      try {
        assert.equal(src.isDirectorySkill, true);
        assert.equal(src.name, 'review');
        assert.ok(existsSync(join(src.localRoot, 'SKILL.md')), '子目录执行也应物化到 SKILL.md');
        assert.ok(existsSync(join(src.localRoot, 'references', 'cmd.md')), '资产也应物化');
      } finally {
        src.cleanup();
      }
    } finally {
      process.chdir(prev);
    }
  });
});

describe('source-resolver git repo-root SKILL.md', () => {
  it('git:HEAD:SKILL.md(根 SKILL.md)物化整根树、非空,不静默产空 skill', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'omk-src-root-')));
    const prev = process.cwd();
    try {
      git(root, ['init', '-q']);
      git(root, ['config', 'user.email', 't@t']);
      git(root, ['config', 'user.name', 't']);
      writeFileSync(join(root, 'SKILL.md'), '# root\n');
      mkdirSync(join(root, 'references'), { recursive: true });
      writeFileSync(join(root, 'references', 'a.md'), 'x\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'init']);
      process.chdir(root);
      const src = resolveInstallSource('git:HEAD:SKILL.md');
      try {
        assert.equal(src.isDirectorySkill, true);
        assert.ok(existsSync(join(src.localRoot, 'SKILL.md')), '根 SKILL.md 应被物化(非空)');
        assert.ok(existsSync(join(src.localRoot, 'references', 'a.md')), '根树资产应被物化');
      } finally {
        src.cleanup();
      }
    } finally {
      process.chdir(prev);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('source-resolver file', () => {
  it('目录-skill 的 SKILL.md 是软链 → 报错指向真源,不静默分发空壳', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'omk-src-symlink-')));
    try {
      const real = join(dir, 'real-skill.md');
      writeFileSync(real, '# real\n');
      const skillDir = join(dir, 'review');
      mkdirSync(skillDir, { recursive: true });
      symlinkSync(real, join(skillDir, 'SKILL.md'));
      assert.throws(
        () => resolveInstallSource(skillDir),
        (e: unknown) => e instanceof SourceResolveError && e.messageKey === 'cli.install.skillmd_is_symlink',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
