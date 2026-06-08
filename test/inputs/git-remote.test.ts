/**
 * 远端 git 源单测。用本地 git 仓库当「远端」(file 路径 URL,git fetch 本地支持),
 * 验证 fetch→pin SHA→复用 classify/materialize 的链路,以及 fail-closed 错误。
 * URL 全程结构化、不经任何字符串切分,scp 形式 git@host:path 的 `@`/`:` 不会被误切。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isPlausibleGitUrl, fetchRemoteGitRef, SourceResolveError, resolveArtifacts } from '../../src/inputs/skill-loader.js';
import { resolveRemoteGitSource } from '../../src/inputs/source-resolver.js';
import { resolveVariantSpecs } from '../../src/cli/lib/parse-run-config/variant-resolution.js';
import { hashArtifactSource } from '../../src/inputs/content-hash.js';

const git = (repo: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

describe('git-remote', () => {
  let repo: string;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'omk-remote-src-'));
    mkdirSync(join(repo, 'skills', 'review', 'references'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'review', 'SKILL.md'), '# review\n');
    writeFileSync(join(repo, 'skills', 'review', 'references', 'rules.md'), 'rule v1\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'v1']);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    for (const c of cleanups.splice(0)) c();
  });

  it('isPlausibleGitUrl:接受协议 URL / scp 形式 / 绝对路径,拒裸串', () => {
    assert.ok(isPlausibleGitUrl('https://github.com/o/r.git'));
    assert.ok(isPlausibleGitUrl('ssh://git@host/o/r.git'));
    assert.ok(isPlausibleGitUrl('git@github.com:o/r.git'), 'scp 形式(含 @ 与 :)合法');
    assert.ok(isPlausibleGitUrl('/abs/path/repo'));
    assert.ok(!isPlausibleGitUrl('o/r'));
    assert.ok(!isPlausibleGitUrl(''));
  });

  it('fetchRemoteGitRef:本地仓库当远端,pin 出实际 SHA', () => {
    const co = fetchRemoteGitRef(repo, 'HEAD');
    cleanups.push(co.cleanup);
    assert.match(co.ref, /^[0-9a-f]{40}$/, 'ref 应是 pin 出的 40 hex SHA');
    assert.ok(existsSync(co.repoRoot), '临时 bare 仓库存在');
    const expectSha = git(repo, ['rev-parse', 'HEAD']).trim();
    assert.equal(co.ref, expectSha, 'pin 的 SHA == 源仓库 HEAD');
  });

  it('resolveRemoteGitSource:物化整树 + url/ref/locator 结构化,与本地整树哈同值(可绑)', () => {
    const src = resolveRemoteGitSource(repo, 'HEAD', 'skills/review');
    cleanups.push(src.cleanup);
    assert.equal(src.sourceKind, 'git');
    assert.equal(src.isDirectorySkill, true);
    assert.equal(src.name, 'review');
    assert.equal(src.url, repo, 'url 结构化携带');
    assert.match(src.ref!, /^[0-9a-f]{40}$/, 'ref pin SHA');
    assert.ok(src.locator.startsWith(`git+${repo}@`), 'locator 是 git+<url>@<sha>:<spec> 身份串');
    // 副本含 references 资产,且整树哈 == 直接哈源仓库本地 checkout(绑定口径)
    assert.equal(readFileSync(join(src.localRoot, 'references', 'rules.md'), 'utf-8'), 'rule v1\n');
    assert.equal(hashArtifactSource(src.localRoot, true), hashArtifactSource(join(repo, 'skills', 'review'), true), '远端物化整树哈 == 本地真源整树哈');
  });

  it('远端取不到 ref → remote_fetch_failed(fail-closed)', () => {
    assert.throws(
      () => fetchRemoteGitRef(repo, 'no-such-ref-xyz'),
      (e: unknown) => e instanceof SourceResolveError && (e as SourceResolveError).messageKey === 'cli.install.remote_fetch_failed',
    );
  });

  it('非法 URL → invalid_remote_url', () => {
    assert.throws(
      () => fetchRemoteGitRef('not-a-url', 'HEAD'),
      (e: unknown) => e instanceof SourceResolveError && (e as SourceResolveError).messageKey === 'cli.install.invalid_remote_url',
    );
  });

  it('远端 ref 存在但 skill spec 不存在 → remote_skill_not_found', () => {
    assert.throws(
      () => resolveRemoteGitSource(repo, 'HEAD', 'skills/nonexistent'),
      (e: unknown) => e instanceof SourceResolveError && (e as SourceResolveError).messageKey === 'cli.install.remote_skill_not_found',
    );
  });

  it('eval resolveArtifacts 远端结构化:execRoot 锚副本、整树指纹绑定、cwd 不被 URL 串台', () => {
    const arts = resolveArtifacts(repo, [
      { git: { url: repo, ref: 'HEAD', spec: 'skills/review' }, cwd: '/tmp/proj-x', name: 'review-remote' },
    ]);
    const a = arts[0];
    assert.equal(a.name, 'review-remote');
    assert.equal(a.source, 'git');
    assert.ok(a.execRoot, '远端 dir-skill 有 execRoot(隔离副本)');
    assert.equal(a.cwd, '/tmp/proj-x', 'cwd 结构化保留,未被 URL 的 @ / : 干扰');
    assert.ok(a.locator.startsWith(`git+${repo}@`), 'locator 身份串 git+<url>@<sha>:<spec>');
    assert.equal(readFileSync(join(a.execRoot!, 'references', 'rules.md'), 'utf-8'), 'rule v1\n');
    assert.equal(a.contentHash, hashArtifactSource(join(repo, 'skills', 'review'), true), '整树指纹与真源同值(可绑)');
  });

  it('resolveVariantSpecs(config) 保留 spec.git 到下游(config→spec 不丢远端字段)', () => {
    const cfg = {
      samples: 's.json',
      variants: [
        { name: 'remote', role: 'treatment', git: { url: repo, spec: 'skills/review' } },
        { name: 'base', role: 'control', artifact: 'baseline' },
      ],
    } as unknown as Parameters<typeof resolveVariantSpecs>[1];
    const specs = resolveVariantSpecs({}, cfg, repo);
    const remote = specs.find((s) => s.name === 'remote')!;
    assert.deepEqual(remote.git, { url: repo, spec: 'skills/review' });
  });

  it('CLI --control 传远端 URL(协议 / scp 形式)fail-closed,指向 eval.yaml', () => {
    for (const url of ['https://github.com/o/r.git', 'git@github.com:o/r.git']) {
      assert.throws(
        () => resolveVariantSpecs({ control: url }, null, repo),
        /eval\.yaml/,
        `远端 URL ${url} 应被 CLI 拒并指向 eval.yaml`,
      );
    }
  });
});
