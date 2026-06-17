import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVariantConfig, resolveExecutionStrategy } from '../../src/eval-core/execution-strategy.js';
import { DEFAULT_ISOLATED_CWD_DIR } from '../../src/eval-core/default-dirs.js';
import type { Artifact, Task } from '../../src/types/index.js';

function mockTask(kind: string, content: string | null = 'skill content'): Task {
  return {
    sample_id: 's1',
    variant: 'test',
    artifact: { name: 'test', kind: kind as Task['artifact']['kind'], source: 'custom', content },
    prompt: 'user prompt',
    rubric: null,
    assertions: null,
    dimensions: null,
    artifactContent: content,
    cwd: null,
    _sample: { sample_id: 's1', prompt: 'user prompt' },
  };
}

describe('resolveExecutionStrategy', () => {
  it('baseline: strategy 为 baseline，system 为 null', () => {
    const plan = resolveExecutionStrategy(mockTask('baseline', null), 'sonnet');
    assert.equal(plan.strategy, 'baseline');
    assert.equal(plan.input.system, null);
    assert.equal(plan.input.prompt, 'user prompt');
  });

  it('skill: strategy 为 system-prompt，system 为 artifact.content', () => {
    const plan = resolveExecutionStrategy(mockTask('skill', 'my skill'), 'sonnet');
    assert.equal(plan.strategy, 'system-prompt');
    assert.equal(plan.input.system, 'my skill');
  });

  it('prompt: strategy 为 user-prompt，content 前置到 prompt', () => {
    const plan = resolveExecutionStrategy(mockTask('prompt', 'prefix'), 'sonnet');
    assert.equal(plan.strategy, 'user-prompt');
    assert.equal(plan.input.system, null);
    assert.ok(plan.input.prompt.startsWith('prefix'));
    assert.ok(plan.input.prompt.includes('user prompt'));
  });

  it('agent: strategy 为 agent-session', () => {
    const plan = resolveExecutionStrategy(mockTask('agent', 'agent sys'), 'sonnet');
    assert.equal(plan.strategy, 'agent-session');
    assert.equal(plan.input.system, 'agent sys');
  });

  it('workflow: strategy 为 workflow-session', () => {
    const plan = resolveExecutionStrategy(mockTask('workflow', 'wf sys'), 'sonnet');
    assert.equal(plan.strategy, 'workflow-session');
    assert.equal(plan.input.system, 'wf sys');
  });

  it('传入 model、timeoutMs、verbose 参数', () => {
    const plan = resolveExecutionStrategy(mockTask('baseline', null), 'haiku', 30000, true);
    assert.equal(plan.input.model, 'haiku');
    assert.equal(plan.input.timeoutMs, 30000);
    assert.equal(plan.input.verbose, true);
  });

  // Skill isolation pass-through.
  it('allowedSkills 从 artifact 透到 ExecutorInput(strict baseline []）', () => {
    const t = mockTask('baseline', null);
    t.artifact.allowedSkills = [];
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.deepEqual(plan.input.allowedSkills, []);
  });

  it('allowedSkills=[](严格隔离声明)透传', () => {
    const t = mockTask('skill', 'sys');
    t.artifact.allowedSkills = [];
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.deepEqual(plan.input.allowedSkills, []);
  });

  it('allowedSkills undefined 时不注入 ExecutorInput.allowedSkills', () => {
    const t = mockTask('skill', 'sys');
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.equal(plan.input.allowedSkills, undefined);
  });

  // strict-baseline cwd 沙箱:baseline 跑在 isolated empty dir,避免
  // 通过 Glob/Read 工具走 cwd 路径绕过 SDK skill isolation 直接读 skills/symlink。
  it('strict baseline (kind=baseline + allowedSkills=[]) + 没显式 cwd → effectiveCwd 是 isolated dir', () => {
    const t = mockTask('baseline', null);
    t.artifact.allowedSkills = [];
    t.cwd = null;
    const plan = resolveExecutionStrategy(t, 'sonnet');
    // isolated cwd 落在 state/isolated-cwd 下(从 OMK_HOME 派生,可被 env 整体重定向,不硬编码真实 home)。
    assert.ok(plan.input.cwd?.startsWith(DEFAULT_ISOLATED_CWD_DIR),
      `cwd should be isolated under ${DEFAULT_ISOLATED_CWD_DIR}, got: ${plan.input.cwd}`);
  });

  it('strict baseline 但用户显式给 cwd → 不动用户 cwd(用户自己负责)', () => {
    const t = mockTask('baseline', null);
    t.artifact.allowedSkills = [];
    t.cwd = '/tmp/user-explicit';
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.equal(plan.input.cwd, '/tmp/user-explicit');
  });

  it('non-strict baseline (allowedSkills undefined) → 不强制 isolated cwd(原行为)', () => {
    const t = mockTask('baseline', null);
    t.cwd = null;
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.equal(plan.input.cwd, null, '默认行为下 cwd 仍是用户传入的 null');
  });

  it('treatment (kind=skill) + allowedSkills=[] → 不动 cwd(隔离仅对 baseline-kind)', () => {
    const t = mockTask('skill', 'sys');
    t.artifact.allowedSkills = [];
    t.cwd = '/some/skill/root';
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.equal(plan.input.cwd, '/some/skill/root');
  });

  // P2-1 source-aware:samplesBaseDir 优先级 > skillDir > cwd 当 mocksBaseDir 兜底
  it('mocksBaseDir 优先用 samplesBaseDir(sample bundle 根),让 return_file 锚到 .omk/', () => {
    const t = mockTask('skill', 'sys');
    t._sample.mocks = [{ tool: 'Read', return: 'x' }];
    t.cwd = '/some/cwd';
    t.artifact.locator = '/skill-root/SKILL.md';
    // samplesBaseDir 传入 .omk/ 目录,应该胜过 skillDir / cwd
    const plan = resolveExecutionStrategy(t, 'sonnet', undefined, undefined, undefined, '/skill-root/.omk');
    assert.equal(plan.input.mocksBaseDir, '/skill-root/.omk');
  });

  it('mocksBaseDir 没 samplesBaseDir 时 fallback skillDir(老行为)', () => {
    const t = mockTask('skill', 'sys');
    t._sample.mocks = [{ tool: 'Read', return: 'x' }];
    t.cwd = '/some/cwd';
    t.artifact.locator = '/skill-root/SKILL.md';
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.equal(plan.input.mocksBaseDir, '/skill-root');
  });
});

describe('buildVariantConfig skill isolation', () => {
  function mkArtifact(name: string, kind: Artifact['kind'], allowedSkills?: string[]): Artifact {
    return {
      name,
      kind,
      source: kind === 'baseline' ? 'baseline' : 'custom',
      content: kind === 'baseline' ? null : 'sys',
      experimentRole: kind === 'baseline' ? 'control' : 'treatment',
      ...(allowedSkills !== undefined && { allowedSkills }),
    };
  }

  it('artifact.allowedSkills=[] 时 VariantConfig.allowedSkills=[](写入 report.meta)', () => {
    const cfg = buildVariantConfig(mkArtifact('baseline', 'baseline', []));
    assert.deepEqual(cfg.allowedSkills, []);
  });

  it('artifact.allowedSkills=[] 透传到 VariantConfig', () => {
    const cfg = buildVariantConfig(mkArtifact('skill-clean', 'baseline', []));
    assert.deepEqual(cfg.allowedSkills, []);
  });

  it('artifact.allowedSkills 未声明时 VariantConfig.allowedSkills 缺失(undefined)', () => {
    const cfg = buildVariantConfig(mkArtifact('skillA', 'skill'));
    assert.equal(cfg.allowedSkills, undefined);
  });
});

describe('buildVariantConfig 还原坐标透传(#234/#236)', () => {
  // 这段是 resolveArtifacts(写 artifact.resolvedCommit)→ evidence(读 variantConfig.resolvedCommit)之间的胶水。
  // resolvedCommit 是可选字段,漏拷会让 typecheck 与两端单测都照样绿、整条还原坐标链却断 —— 必须显式锁住。
  const gitArtifact = (over: Partial<Artifact>): Artifact => ({
    name: 'review', kind: 'skill', source: 'git', content: 'sys', experimentRole: 'treatment', ...over,
  });

  it('artifact.resolvedCommit 透传到 VariantConfig(evidence 据此记每版还原坐标)', () => {
    const cfg = buildVariantConfig(gitArtifact({ resolvedCommit: 'abc1234567890deffeed' }));
    assert.equal(cfg.resolvedCommit, 'abc1234567890deffeed');
  });

  it('artifact 无 resolvedCommit(远端 / file / baseline)→ VariantConfig 不带该字段', () => {
    assert.equal(buildVariantConfig(gitArtifact({})).resolvedCommit, undefined);
  });
});
