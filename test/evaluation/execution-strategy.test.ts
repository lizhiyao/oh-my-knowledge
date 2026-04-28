import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVariantConfig, resolveExecutionStrategy } from '../../src/eval-core/execution-strategy.js';
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

  // v0.22 — Skill isolation pass-through.
  it('allowedSkills 从 artifact 透到 ExecutorInput(strict baseline []）', () => {
    const t = mockTask('baseline', null);
    t.artifact.allowedSkills = [];
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.deepEqual(plan.input.allowedSkills, []);
  });

  it('allowedSkills 白名单透传', () => {
    const t = mockTask('skill', 'sys');
    t.artifact.allowedSkills = ['react', 'typescript'];
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.deepEqual(plan.input.allowedSkills, ['react', 'typescript']);
  });

  it('allowedSkills undefined 时不注入 ExecutorInput.allowedSkills', () => {
    const t = mockTask('skill', 'sys');
    const plan = resolveExecutionStrategy(t, 'sonnet');
    assert.equal(plan.input.allowedSkills, undefined);
  });
});

describe('buildVariantConfig skill isolation (v0.22)', () => {
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

  it('artifact.allowedSkills 白名单透传到 VariantConfig', () => {
    const cfg = buildVariantConfig(mkArtifact('wcc-clean', 'baseline', ['react']));
    assert.deepEqual(cfg.allowedSkills, ['react']);
  });

  it('artifact.allowedSkills 未声明时 VariantConfig.allowedSkills 缺失(undefined)', () => {
    const cfg = buildVariantConfig(mkArtifact('wcc', 'skill'));
    assert.equal(cfg.allowedSkills, undefined);
  });
});
