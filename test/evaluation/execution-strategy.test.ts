import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionStrategy } from '../../src/eval-core/execution-strategy.js';
import type { Task } from '../../src/types.js';

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
});
