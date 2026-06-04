import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUniqueVariantNames, resolveArtifacts, variantIdentity, parseVariantCwd } from '../../src/inputs/skill-loader.js';
import { resolveVariantSpecs } from '../../src/cli/lib/parse-run-config/variant-resolution.js';
import { prepareEvaluationRun } from '../../src/eval-workflows/evaluation-preparation.js';
import type { Artifact } from '../../src/types/eval.js';

const skill = (name: string, over: Partial<Artifact> = {}): Artifact => ({
  name,
  kind: 'skill',
  source: 'file-path',
  content: 'x',
  ...over,
});

describe('ensureUniqueVariantNames', () => {
  it('leaves already-unique names untouched', () => {
    const arts = [skill('greeter', { locator: '/a/greeter.md' }), skill('helper', { locator: '/a/helper.md' })];
    ensureUniqueVariantNames(arts);
    assert.deepEqual(arts.map((a) => a.name), ['greeter', 'helper']);
  });

  it('disambiguates same-basename file variants by parent dir', () => {
    const arts = [
      skill('greeter', { locator: '/repo/v1/greeter.md' }),
      skill('greeter', { locator: '/repo/v2/greeter.md' }),
    ];
    ensureUniqueVariantNames(arts);
    assert.deepEqual(arts.map((a) => a.name), ['v1/greeter', 'v2/greeter']);
  });

  it('disambiguates SKILL.md dir skills by the dir above the skill root', () => {
    const arts = [
      skill('greeter', { locator: '/repo/v1/greeter/SKILL.md', skillRoot: '/repo/v1/greeter' }),
      skill('greeter', { locator: '/repo/v2/greeter/SKILL.md', skillRoot: '/repo/v2/greeter' }),
    ];
    ensureUniqueVariantNames(arts);
    assert.deepEqual(arts.map((a) => a.name), ['v1/greeter', 'v2/greeter']);
  });

  it('walks further up the path when the immediate parent also collides', () => {
    const arts = [
      skill('greeter', { locator: '/repo/a/v1/greeter.md' }),
      skill('greeter', { locator: '/repo/b/v1/greeter.md' }),
    ];
    ensureUniqueVariantNames(arts);
    assert.deepEqual(arts.map((a) => a.name), ['a/v1/greeter', 'b/v1/greeter']);
  });

  it('falls back to a numeric suffix when no path is available (e.g. baseline)', () => {
    const arts = [
      skill('x', { kind: 'baseline', source: 'baseline', content: null }),
      skill('x', { kind: 'baseline', source: 'baseline', content: null }),
    ];
    ensureUniqueVariantNames(arts);
    const names = arts.map((a) => a.name);
    assert.equal(new Set(names).size, 2, `expected unique names, got ${names.join(',')}`);
    assert.ok(names.includes('x') && names.includes('x#2'), names.join(','));
  });
});

describe('resolveArtifacts — same-basename variants in different dirs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-variant-'));
    for (const v of ['v1', 'v2']) {
      mkdirSync(join(root, v), { recursive: true });
      writeFileSync(join(root, v, 'greeter.md'), `# greeter ${v}\n`);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('does not collapse two same-named skills into one (regression)', () => {
    const arts = resolveArtifacts(root, [join(root, 'v1', 'greeter.md'), join(root, 'v2', 'greeter.md')]);
    assert.equal(arts.length, 2);
    const names = arts.map((a) => a.name);
    assert.equal(new Set(names).size, 2, `variant names must stay distinct, got ${names.join(',')}`);
    assert.deepEqual(names, ['v1/greeter', 'v2/greeter']);
    // 内容确实是两份不同的 skill,没有被覆盖
    assert.notEqual(arts[0].content, arts[1].content);
  });

  it('rejects an empty variant expr instead of silently loading skillDir/SKILL.md', () => {
    writeFileSync(join(root, 'SKILL.md'), '# top-level skill\n');
    assert.throws(() => resolveArtifacts(root, [{ expr: '', cwd: '/some/cwd' }]), /不能为空/);
  });
});

describe('CLI dry-run — --control / --treatment same-basename in different dirs', () => {
  let root: string;
  let samplesPath: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-variant-cli-'));
    for (const v of ['v1', 'v2']) {
      mkdirSync(join(root, v), { recursive: true });
      writeFileSync(join(root, v, 'greeter.md'), `# greeter ${v}\n`);
    }
    samplesPath = join(root, 'samples.json');
    writeFileSync(samplesPath, JSON.stringify([{ sample_id: 's1', prompt: '你好' }]));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolveVariantSpecs does not flag two different paths as a duplicate variant', () => {
    const specs = resolveVariantSpecs(
      { control: join(root, 'v1', 'greeter.md'), treatment: join(root, 'v2', 'greeter.md') },
      null,
      root,
    );
    assert.equal(specs.length, 2);
    assert.deepEqual(specs.map((s) => s.role), ['control', 'treatment']);
  });

  it('resolveVariantSpecs still rejects the same expr in control and treatment', () => {
    const same = join(root, 'v1', 'greeter.md');
    assert.throws(() => resolveVariantSpecs({ control: same, treatment: same }, null, root), /重复出现/);
  });

  it('rejects the same physical skill written two different ways (./x.md vs x.md)', () => {
    const abs = join(root, 'v1', 'greeter.md');
    // 用相对写法构造同一份 skill 的另一种写法:control 绝对、treatment 相对(从 root 出发)
    const rel = `${root}/./v1/greeter.md`;
    assert.throws(() => resolveVariantSpecs({ control: abs, treatment: rel }, null, root), /重复出现/);
  });

  it('rejects a dir-skill vs its SKILL.md (same skill root)', () => {
    const skillDir = join(root, 'dirskill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# dir skill\n');
    assert.throws(
      () => resolveVariantSpecs({ control: skillDir, treatment: join(skillDir, 'SKILL.md') }, null, root),
      /重复出现/,
    );
  });

  it('rejects the removed name@cwd CLI syntax with a migration error', () => {
    const skill = join(root, 'v1', 'greeter.md');
    assert.throws(
      () => resolveVariantSpecs({ control: `${skill}@${root}/v1` }, null, root),
      /语法已移除|--control-cwd/,
    );
  });

  it('rejects a bare skill name vs its path form pointing at the same file (skillDir base)', () => {
    // skillDir 下放一个 greeter.md;`greeter`(裸名,按 skillDir 解析)与 `<skillDir>/greeter.md`
    // (路径)指向同一物理文件 → 必须判为重复,否则会变成同一份 skill 自比。
    writeFileSync(join(root, 'greeter.md'), '# top greeter\n');
    assert.throws(
      () => resolveVariantSpecs({ control: 'greeter', treatment: join(root, 'greeter.md') }, null, root),
      /重复出现/,
    );
  });

  it('prepareEvaluationRun assigns distinct names AND a role to each variant (regression)', async () => {
    const variantSpecs = resolveVariantSpecs(
      { control: join(root, 'v1', 'greeter.md'), treatment: join(root, 'v2', 'greeter.md') },
      null,
      root,
    );
    const prepared = await prepareEvaluationRun({ samplesPath, skillDir: root, variantSpecs, dryRun: true });
    assert.equal(prepared.artifacts.length, 2);
    assert.deepEqual(prepared.variantNames, ['v1/greeter', 'v2/greeter']);
    // 两个 artifact 都拿到了 experimentRole(否则 buildVariantConfig 会抛 “缺少 experimentRole”)
    assert.deepEqual(prepared.artifacts.map((a) => a.experimentRole), ['control', 'treatment']);
    // spec.name 已同步成消歧后的唯一名,与 report / variantNames 一致
    assert.deepEqual(variantSpecs.map((s) => s.name), ['v1/greeter', 'v2/greeter']);
  });

  it('keeps an eval.yaml-style explicit name + allowedSkills wired to the right artifact', async () => {
    // 模拟 eval.yaml:variant 名(control-v1)与 artifact 路径短名(greeter)不同,且声明 allowedSkills:[]。
    // variantAllowedSkills 按 config 名建索引,resolveArtifacts 按 artifact 短名查会漏绑 —— 这里验证 index 分支把它补回来。
    const variantSpecs = [{ name: 'control-v1', role: 'control' as const, expr: join(root, 'v1', 'greeter.md') }];
    const prepared = await prepareEvaluationRun({
      samplesPath,
      skillDir: root,
      variantSpecs,
      dryRun: true,
      variantAllowedSkills: { 'control-v1': [] },
    });
    assert.equal(prepared.artifacts.length, 1);
    // allowedSkills 必须落到 artifact 上(=[] 表示隔离),不能是 undefined(=SDK 默认 discovery)
    assert.deepEqual(prepared.artifacts[0].allowedSkills, []);
    assert.equal(prepared.artifacts[0].experimentRole, 'control');
  });
});

describe('variantIdentity', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omk-vid-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('folds ./x.md and x.md (relative spellings) to the same identity', () => {
    const f = join(root, 'x.md');
    writeFileSync(f, '# x\n');
    assert.equal(variantIdentity(f), variantIdentity(`${root}/./x.md`));
  });

  it('folds a dir-skill and its SKILL.md to the same identity', () => {
    const d = join(root, 'skill');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), '# s\n');
    assert.equal(variantIdentity(d), variantIdentity(join(d, 'SKILL.md')));
  });

  it('keeps different basenames in different dirs distinct', () => {
    assert.notEqual(variantIdentity('/repo/v1/greeter.md'), variantIdentity('/repo/v2/greeter.md'));
  });

  it('treats the same skill with different cwd as different identities', () => {
    const f = join(root, 'x.md');
    writeFileSync(f, '# x\n');
    assert.notEqual(variantIdentity(`${f}@${root}/a`), variantIdentity(`${f}@${root}/b`));
  });

  it('leaves baseline and git refs as stable opaque identities', () => {
    assert.equal(variantIdentity('baseline'), 'baseline');
    assert.equal(variantIdentity('git:HEAD:greeter'), 'git:HEAD:greeter');
  });

  it('folds a symlinked path to the same physical identity (resolve alone would miss it)', () => {
    const real = join(root, 'realdir');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'SKILL.md'), '# s\n');
    const link = join(root, 'linkdir');
    symlinkSync(real, link, 'dir');
    // 软链目录、真实目录、真实目录的 SKILL.md —— 同一物理文件,必须同 identity
    assert.equal(variantIdentity(link), variantIdentity(real));
    assert.equal(variantIdentity(link), variantIdentity(join(real, 'SKILL.md')));
  });

  it('folds absolute vs realpath-equivalent file to the same identity', () => {
    const f = join(root, 'g.md');
    writeFileSync(f, '# g\n');
    // realpathSync 解掉 /tmp→/private/tmp 这类软链前缀,二者指向同一 inode → 同 identity
    assert.equal(variantIdentity(f), variantIdentity(realpathSync(f)));
  });
});

describe('parseVariantCwd — protects git @{...} but still splits a trailing @cwd', () => {
  it('keeps a reflog/upstream git ref whole (no cwd)', () => {
    assert.deepEqual(parseVariantCwd('git:HEAD@{2}:greeter'), { name: 'git:HEAD@{2}:greeter' });
    assert.deepEqual(parseVariantCwd('git:main@{u}:greeter'), { name: 'git:main@{u}:greeter' });
    assert.equal(variantIdentity('git:HEAD@{2}:greeter'), 'git:HEAD@{2}:greeter');
  });

  it('still splits a trailing @cwd off a git artifact (eval.yaml git + cwd form)', () => {
    // configVariantsToSpecs 把 `artifact: git:my-skill` + `cwd: /proj` 合成 `git:my-skill@/proj`
    assert.deepEqual(parseVariantCwd('git:my-skill@/tmp/project'), { name: 'git:my-skill', cwd: '/tmp/project' });
    // reflog ref 内部的 @{...} 不切,末尾的 @cwd 仍切
    assert.deepEqual(parseVariantCwd('git:HEAD@{2}:greeter@/proj'), { name: 'git:HEAD@{2}:greeter', cwd: '/proj' });
  });

  it('still splits @cwd for non-git variants', () => {
    assert.deepEqual(parseVariantCwd('my-skill@/proj'), { name: 'my-skill', cwd: '/proj' });
  });
});

describe('resolveArtifacts — git artifact bound to a cwd (regression: @{...} guard must not eat @cwd)', () => {
  it('loads the git skill AND sets artifact.cwd from the trailing @cwd', () => {
    const gitRoot = realpathSync(mkdtempSync(join(tmpdir(), 'omk-gitcwd-')));
    const sh = (args: string[]): void => { execFileSync('git', args, { cwd: gitRoot, stdio: 'ignore' }); };
    const prevCwd = process.cwd();
    try {
      sh(['init']);
      sh(['config', 'user.email', 't@t.co']);
      sh(['config', 'user.name', 't']);
      writeFileSync(join(gitRoot, 'greeter.md'), '# git greeter\n');
      sh(['add', '.']);
      sh(['commit', '-m', 'seed']);
      process.chdir(gitRoot);
      // 结构化输入:expr 是纯 git 身份,cwd 单独携带(不再 git:...@cwd 编码进串)。
      const arts = resolveArtifacts(gitRoot, [{ expr: 'git:greeter', cwd: `${gitRoot}/proj` }]);
      assert.equal(arts.length, 1);
      assert.equal(arts[0].source, 'git');
      assert.equal(arts[0].content, '# git greeter');
      assert.equal(arts[0].cwd, `${gitRoot}/proj`, 'cwd carried structurally');
    } finally {
      process.chdir(prevCwd);
      rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});

describe('resolveVariantSpecs — --control-cwd / --treatment-cwd 结构化注入', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omk-cwdflag-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('injects control cwd structurally onto the spec', () => {
    const specs = resolveVariantSpecs({ control: 'baseline', treatment: 'skill-a', 'control-cwd': '/proj' }, null, root);
    assert.equal(specs.find((s) => s.role === 'control')!.cwd, '/proj');
    assert.equal(specs.find((s) => s.role === 'treatment')!.cwd, undefined);
  });

  it('index-aligns --treatment-cwd to --treatment', () => {
    const specs = resolveVariantSpecs({ treatment: 'a,b', 'treatment-cwd': '/pa,/pb' }, null, root);
    assert.deepEqual(specs.map((s) => s.cwd), ['/pa', '/pb']);
  });

  it('blank slot means that treatment has no cwd', () => {
    const specs = resolveVariantSpecs({ treatment: 'a,b,c', 'treatment-cwd': '/pa,,/pc' }, null, root);
    assert.deepEqual(specs.map((s) => s.cwd), ['/pa', undefined, '/pc']);
  });

  it('errors when --treatment-cwd length mismatches --treatment', () => {
    assert.throws(() => resolveVariantSpecs({ treatment: 'a,b', 'treatment-cwd': '/pa' }, null, root), /按序对齐|数量/);
  });

  it('errors when --treatment-cwd is given without --treatment', () => {
    assert.throws(() => resolveVariantSpecs({ 'treatment-cwd': '/pa' }, null, root), /需要配/);
  });

  it('errors when --control-cwd is given without --control', () => {
    assert.throws(() => resolveVariantSpecs({ treatment: 'a', 'control-cwd': '/p' }, null, root), /--control-cwd 需要配 --control/);
  });
});
