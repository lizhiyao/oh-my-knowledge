import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { discoverBatchSkills, resolveArtifacts } from '../../../src/eval-workflows/inputs/skill-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, '..', '..', 'fixtures', 'code-review', 'skills');
const MULTI_SKILL_DIR = join(__dirname, '..', '..', 'fixtures', 'multi-skills', 'skills');

describe('discoverBatchSkills canonical sample layout', () => {
  it('只发现带 .omk/eval-samples.{json,yaml} 的目录 skill', () => {
    const entries = discoverBatchSkills(MULTI_SKILL_DIR);
    assert.deepEqual(entries.map((entry) => entry.name), ['classifier', 'summarizer', 'translator']);
    assert.ok(entries.every((entry) => /[/\\]\.omk[/\\]eval-samples\.json$/.test(entry.samplesPath)));
  });

  it('不再把扁平 skill sidecar 当成 batch 私有用例', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-flat-batch-'));
    try {
      writeFileSync(join(root, 'review.md'), '# review\n');
      writeFileSync(join(root, 'review.eval-samples.json'), '{}\n');
      assert.deepEqual(discoverBatchSkills(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveArtifacts', () => {
  it('baseline 产生 kind 为 baseline 的 artifact', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['baseline']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'baseline');
    assert.equal(artifacts[0].kind, 'baseline');
    assert.equal(artifacts[0].source, 'baseline');
    assert.equal(artifacts[0].content, null);
  });

  it('文件 variant 产生带 content 的 artifact', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['v1']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'v1');
    assert.equal(artifacts[0].kind, 'skill');
    assert.equal(typeof artifacts[0].content, 'string');
    assert.ok((artifacts[0].content as string).length > 0);
  });

  it('baseline + 文件 variant 组合', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['baseline', 'v1', 'v2']);
    assert.equal(artifacts.length, 3);
    assert.equal(artifacts[0].kind, 'baseline');
    assert.equal(artifacts[1].kind, 'skill');
    assert.equal(artifacts[2].kind, 'skill');
  });

  it('baseline@cwd 不再受支持', () => {
    assert.throws(
      () => resolveArtifacts(SKILL_DIR, [{ expr: 'baseline', cwd: '/tmp/project-a' }]),
      /baseline cannot be bound to a cwd/,
    );
  });

  it('unknown expr + cwd 作为 cwd-only baseline artifact', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, [{ expr: 'project-env', cwd: '/tmp/project-b' }]);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'project-env');
    assert.equal(artifacts[0].kind, 'baseline');
    assert.equal(artifacts[0].content, null);
    assert.equal(artifacts[0].cwd, '/tmp/project-b');
  });

  it('file-skill 不设 skillRoot(cwd 走默认,即用户项目目录)', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['v1']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].skillRoot, undefined);
  });

  it('directory-skill 把 skillRoot 设到 SKILL.md 所在目录', () => {
    const artifacts = resolveArtifacts(MULTI_SKILL_DIR, ['classifier']);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].name, 'classifier');
    assert.equal(artifacts[0].kind, 'skill');
    assert.equal(artifacts[0].skillRoot, join(MULTI_SKILL_DIR, 'classifier'));
  });

  it('显式 cwd 覆盖，但 skillRoot 仍作为 artifact 来源元数据保留', () => {
    const artifacts = resolveArtifacts(MULTI_SKILL_DIR, [{ expr: 'classifier', cwd: '/tmp/override' }]);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].cwd, '/tmp/override');
    assert.equal(artifacts[0].skillRoot, join(MULTI_SKILL_DIR, 'classifier'));
  });

  it('file-path 指向 SKILL.md 同 directory-skill 处理:设 skillRoot 为该目录', () => {
    const skillMd = join(MULTI_SKILL_DIR, 'classifier', 'SKILL.md');
    const artifacts = resolveArtifacts(SKILL_DIR, [skillMd]);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].source, 'file-path');
    assert.equal(artifacts[0].skillRoot, dirname(skillMd));
  });

  it('materialize 默认 true 设 execRoot;materialize:false(doctor/loadSkills)只算指纹不落副本', () => {
    const skillMd = join(MULTI_SKILL_DIR, 'classifier', 'SKILL.md');
    const withCopy = resolveArtifacts(SKILL_DIR, [skillMd])[0];
    assert.ok(withCopy.execRoot, 'eval 默认 materialize → 有 execRoot(隔离副本)');
    assert.ok(withCopy.contentHash, '有整树指纹');
    assert.equal(withCopy.skillRoot, dirname(skillMd), 'skillRoot 始终是真源');

    const noCopy = resolveArtifacts(SKILL_DIR, [skillMd], { materialize: false })[0];
    assert.equal(noCopy.execRoot, undefined, 'materialize:false 不设 execRoot');
    assert.equal(noCopy.contentHash, withCopy.contentHash, '指纹仍算且与落副本同值');
    assert.equal(noCopy.skillRoot, dirname(skillMd), 'skillRoot 仍是真源');
  });

  it('file-path 指向单文件 .md 不设 skillRoot', () => {
    const v1Path = join(SKILL_DIR, 'v1.md');
    const artifacts = resolveArtifacts(MULTI_SKILL_DIR, [v1Path]);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].source, 'file-path');
    assert.equal(artifacts[0].skillRoot, undefined);
  });
});

describe('resolveArtifacts skill isolation', () => {
  it('default(strictBaseline=true): baseline-kind artifact 自动 allowedSkills=[]', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['baseline', 'v1']);
    const baseline = artifacts.find((a) => a.name === 'baseline')!;
    const v1 = artifacts.find((a) => a.name === 'v1')!;
    assert.deepEqual(baseline.allowedSkills, []);
    assert.equal(v1.allowedSkills, undefined, 'treatment 不被自动隔离,保持 undefined');
  });

  it('strictBaseline=false: baseline-kind 不被自动设,allowedSkills 保持 undefined', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, ['baseline', 'v1'], { strictBaseline: false });
    const baseline = artifacts.find((a) => a.name === 'baseline')!;
    assert.equal(baseline.allowedSkills, undefined);
  });

  it('cwd-only expr 也被认作 baseline-kind,strict-baseline 自动隔离', () => {
    const artifacts = resolveArtifacts(SKILL_DIR, [{ expr: 'project-env', cwd: '/tmp/proj' }]);
    assert.deepEqual(artifacts[0].allowedSkills, [],
      'kind:baseline 包括 cwd-only custom variant,strict-baseline 一并隔离');
  });
});

// eval 的 git 解析与 install 共用 classifyGitSkillRef —— 这里锁住 eval 层的归类不再被重新内联走偏。
describe('resolveArtifacts git 输入校验(与 install 共用 parseGitInput)', () => {
  // parseGitInput 在任何 git 调用前先拒,故无需真 repo。
  it('空 ref(git::review)被拒:绝不当 git index 量本地暂存区(不可复取)', () => {
    assert.throws(() => resolveArtifacts(SKILL_DIR, ['git::review']), /无效的 git variant/);
  });
  it('空 spec(git:HEAD:)被拒:不退化去探 .md / SKILL.md', () => {
    assert.throws(() => resolveArtifacts(SKILL_DIR, ['git:HEAD:']), /无效的 git variant/);
  });
});

describe('resolveArtifacts git(与 install 共用归类)', () => {
  let repo: string;
  let prevCwd: string;

  afterEach(() => {
    if (prevCwd) process.chdir(prevCwd);
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  function mkRepo(): void {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'omk-eval-git-')));
    const sh = (args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
    sh(['init', '-q']);
    sh(['config', 'user.email', 't@t']);
    sh(['config', 'user.name', 't']);
    prevCwd = process.cwd();
  }

  it('裸 spec 歧义:eval 也文件优先(与 install 对齐,量的是 .md 文件而非 dir/SKILL.md)', () => {
    mkRepo();
    mkdirSync(join(repo, 'dual'), { recursive: true });
    writeFileSync(join(repo, 'dual.md'), '# dual file\n');
    writeFileSync(join(repo, 'dual', 'SKILL.md'), '# dual dir\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'dual'], { cwd: repo, stdio: 'ignore' });
    process.chdir(repo);
    const artifacts = resolveArtifacts(repo, ['git:HEAD:dual']);
    assert.equal(artifacts[0].source, 'git');
    assert.ok(artifacts[0].content?.includes('dual file'), 'eval 必须文件优先,量的是 dual.md');
    assert.ok(!artifacts[0].content?.includes('dual dir'), '绝不能量成 dual/SKILL.md');
  });

  it('名字以 .md 结尾的目录不被当文件 blob:回退到真 dir-skill,不把树清单量成内容', () => {
    mkRepo();
    mkdirSync(join(repo, 'foo.md'), { recursive: true }); // 目录,影子遮挡
    writeFileSync(join(repo, 'foo.md', 'note.txt'), 'shadow\n');
    mkdirSync(join(repo, 'foo'), { recursive: true });
    writeFileSync(join(repo, 'foo', 'SKILL.md'), '# real foo\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'shadow'], { cwd: repo, stdio: 'ignore' });
    process.chdir(repo);
    const artifacts = resolveArtifacts(repo, ['git:HEAD:foo']);
    assert.ok(artifacts[0].content?.includes('real foo'), '应回退到 foo/SKILL.md');
    assert.ok(!artifacts[0].content?.startsWith('tree '), '绝不能把 git 树清单当 skill 内容');
  });

  it('git dir-skill 忠实执行:整树指纹覆盖 references/ 资产,execRoot 锚隔离副本', () => {
    // git eval 物化整树到内容寻址隔离副本,executor cwd 锚 execRoot、agent 读得到 references/。
    // 资产是真实测量输入:改资产 → 整树指纹变(消除 over-claim 的反面);改 SKILL.md 也变。
    mkRepo();
    mkdirSync(join(repo, 'review', 'references'), { recursive: true });
    writeFileSync(join(repo, 'review', 'SKILL.md'), '# review v1\n');
    writeFileSync(join(repo, 'review', 'references', 'rules.md'), 'rule v1\n');
    const commit = (msg: string): void => {
      execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo, stdio: 'ignore' });
    };
    commit('v1');
    process.chdir(repo);
    const a1 = resolveArtifacts(repo, ['git:HEAD:review'])[0];
    const h1 = a1.contentHash;
    assert.ok(h1, 'git dir-skill 必须有 contentHash');
    assert.ok(a1.execRoot, 'git dir-skill 必须有 execRoot(隔离副本执行根)');
    // 副本含 references 资产,agent 经 cwd 读得到
    assert.equal(readFileSync(join(a1.execRoot!, 'references', 'rules.md'), 'utf-8'), 'rule v1\n');

    writeFileSync(join(repo, 'review', 'references', 'rules.md'), 'rule v2 changed\n'); // 改资产
    commit('asset change');
    const h2 = resolveArtifacts(repo, ['git:HEAD:review'])[0].contentHash;
    assert.notEqual(h2, h1, '改 references/ 资产必须改变 git 整树指纹(资产现在是真实测量输入)');

    writeFileSync(join(repo, 'review', 'SKILL.md'), '# review v2 changed\n'); // 改 SKILL.md
    commit('skill change');
    const h3 = resolveArtifacts(repo, ['git:HEAD:review'])[0].contentHash;
    assert.notEqual(h3, h2, '改 SKILL.md 也改变整树指纹');
  });

  it('resolvedCommit 精确记录 variant ref provenance，而非 cwd HEAD', () => {
    mkRepo();
    const sh = (args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
    const head = (): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    writeFileSync(join(repo, 'review.md'), '# review v1\n');
    sh(['add', '-A']); sh(['commit', '-q', '-m', 'v1']);
    const c1 = head();
    process.chdir(repo);
    assert.equal(resolveArtifacts(repo, ['git:HEAD:review'])[0].resolvedCommit, c1, 'HEAD ref → 当前 commit');

    // HEAD 前进到 c2;cwd 现在停在 c2。
    writeFileSync(join(repo, 'review.md'), '# review v2\n');
    sh(['add', '-A']); sh(['commit', '-q', '-m', 'v2']);
    const c2 = head();
    assert.notEqual(c1, c2);

    // 关键回归(reviewer P1):显式旧 SHA variant 物化的是旧版字节,resolvedCommit 必须钉 c1,绝不是 cwd HEAD(c2)。
    const old = resolveArtifacts(repo, [`git:${c1}:review`])[0];
    assert.ok(old.content?.includes('review v1'), '物化的是旧版内容');
    assert.equal(old.resolvedCommit, c1, '显式旧 SHA → 钉 c1,不是 cwd HEAD(c2)');
  });

  it('从仓库外调用:git 上下文锚定 skillDir 所属 repo,而非进程 cwd', () => {
    // 进程 cwd 停在 omk 仓库(测试运行目录),skillDir 指向另一个临时 repo,且**不 chdir 进去**。
    // 修复前 rev-parse 在进程 cwd 跑 → 拿 omk repo 的 root/HEAD → not_found 或评测错 repo 的同名内容。
    const ext = realpathSync(mkdtempSync(join(tmpdir(), 'omk-eval-extrepo-')));
    try {
      const sh = (args: string[]): void => { execFileSync('git', args, { cwd: ext, stdio: 'ignore' }); };
      sh(['init', '-q']);
      sh(['config', 'user.email', 't@t']);
      sh(['config', 'user.name', 't']);
      mkdirSync(join(ext, 'skills'), { recursive: true });
      writeFileSync(join(ext, 'skills', 'review.md'), '# external review skill\n');
      sh(['add', '-A']);
      sh(['commit', '-q', '-m', 'seed']);
      const artifacts = resolveArtifacts(join(ext, 'skills'), ['git:review']); // 注意:不 chdir
      assert.equal(artifacts[0].source, 'git');
      assert.ok(artifacts[0].content?.includes('external review skill'),
        'git 上下文必须锚定 skillDir 的 repo,读外部 repo 的 skills/review.md');
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it('skillDir 工作树已删(skill 只在 HEAD)+ 经软链路径:relDir 对称归一,不越界误报 not_found', () => {
    // 纯 git eval:skill 在 HEAD 但工作树已删除;skillDir 经软链传入。修复前 repoRoot 经 realpath、
    // fromPath 未归一,relative 在软链 ↔ 真实路径间算出 `../../..` 越界 relDir → classify 探到仓库外
    // → 误报 not_found。对称归一(realpath 最近存在祖先 + 拼回尾段)后应正常从 HEAD 读到内容。
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'omk-eval-ctxreal-')));
    const link = join(tmpdir(), `omk-eval-ctxlink-${process.pid}-${process.hrtime.bigint()}`);
    symlinkSync(real, link);
    try {
      const sh = (args: string[]): void => { execFileSync('git', args, { cwd: real, stdio: 'ignore' }); };
      sh(['init', '-q']);
      sh(['config', 'user.email', 't@t']);
      sh(['config', 'user.name', 't']);
      mkdirSync(join(real, 'skills', 'old'), { recursive: true });
      writeFileSync(join(real, 'skills', 'old', 'SKILL.md'), '# old skill in HEAD\n');
      sh(['add', '-A']);
      sh(['commit', '-q', '-m', 'seed']);
      rmSync(join(real, 'skills'), { recursive: true, force: true }); // 工作树删掉,只剩 HEAD
      // skillDir 经软链且不在磁盘 → 触发未归一分支
      const artifacts = resolveArtifacts(join(link, 'skills'), ['git:old']);
      assert.ok(artifacts[0].content?.includes('old skill in HEAD'),
        'relDir 对称归一后应从 HEAD 读到 skills/old/SKILL.md,不因软链算越界');
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });
});
