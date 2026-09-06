/**
 * 锁住 gitShowFile / gitShowBytes / gitLsTreeBlobs 的 `--` 隔断:用户可控 ref(经 managed locator
 * `git:<ref>:<spec>` 一路流到这三个 helper)若以 `-` 开头,绝不能被 git 当 option 解析 —— 必须 fail-closed
 * (返回 null / [])。同时正向断言普通 ref 仍能取到内容,防 `--` 写错把正常解析也打断。
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitShowFile, gitShowBytes, gitLsTreeBlobs } from '../../../src/knowledge-artifacts/sources/artifact-resolution.js';

const git = (repo: string, args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'pipe' }); };

describe('git helpers `--` dash-ref fail-closed', () => {
  let repo: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'omk-dashref-')));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    mkdirSync(join(repo, 'skills', 'review'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'review', 'SKILL.md'), '# review\n');
    writeFileSync(join(repo, 'skills', 'review', 'r.md'), 'asset\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it('普通 ref:三个 helper 都能正常取到内容（确认 `--` 没打断正常解析）', () => {
    assert.equal(gitShowFile('HEAD', 'skills/review/SKILL.md', repo), '# review'); // gitShowFile 内部 .trim()
    assert.ok((gitShowBytes('HEAD', 'skills/review/SKILL.md', repo) as Buffer).equals(Buffer.from('# review\n')));
    const blobs = gitLsTreeBlobs('HEAD', 'skills/review', repo);
    assert.ok(blobs.some((b) => b.path.endsWith('SKILL.md')) && blobs.some((b) => b.path.endsWith('r.md')));
  });

  it('以 `-` 开头的恶意 ref:fail-closed,绝不被当 git option 解析', () => {
    // 没有 `--` 隔断时 `-evil` 会被 git 当作未知开关 → 行为不可控;有 `--` 则当 tree-ish 解析、必失败。
    assert.equal(gitShowFile('-evil', 'skills/review/SKILL.md', repo), null);
    assert.equal(gitShowFile('--upload-pack=touch x', 'skills/review/SKILL.md', repo), null);
    assert.equal(gitShowBytes('-evil', 'skills/review/SKILL.md', repo), null);
    assert.deepEqual(gitLsTreeBlobs('-evil', 'skills/review', repo), []);
  });
});
