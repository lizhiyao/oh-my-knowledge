import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTasks, buildTasksFromEvaluands } from '../lib/task-planner.js';
import type { EvaluandSpec, Sample } from '../lib/types.js';

const makeSample = (id: string, prompt: string, context?: string): Sample => ({
  sample_id: id,
  prompt,
  ...(context ? { context } : {}),
});

describe('buildTasks', () => {
  it('为每个 sample × variant 创建任务', () => {
    const samples = [makeSample('s1', 'p1'), makeSample('s2', 'p2')];
    const skills: Record<string, string | null> = { baseline: null, v1: 'skill content' };
    const tasks = buildTasks(samples, ['baseline', 'v1'], skills);
    assert.equal(tasks.length, 4);
    assert.equal(tasks[0].sample_id, 's1');
    assert.equal(tasks[0].variant, 'baseline');
    assert.equal(tasks[1].sample_id, 's1');
    assert.equal(tasks[1].variant, 'v1');
  });

  it('baseline variant 的 skillContent 为 null', () => {
    const samples = [makeSample('s1', 'p1')];
    const tasks = buildTasks(samples, ['baseline', 'v1'], { baseline: null, v1: 'content' });
    const baseline = tasks.find((t) => t.variant === 'baseline')!;
    assert.equal(baseline.skillContent, null);
    assert.equal(baseline.evaluand.kind, 'baseline');
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(buildTasks([], ['baseline'], { baseline: null }), []);
    assert.deepEqual(buildTasks([makeSample('s1', 'p')], [], {}), []);
  });
});

describe('buildTasksFromEvaluands', () => {
  it('使用 evaluand specs 创建任务', () => {
    const samples = [makeSample('s1', 'hello')];
    const evaluands: EvaluandSpec[] = [
      { name: 'test', kind: 'skill', source: 'variant-name', content: 'my skill' },
    ];
    const tasks = buildTasksFromEvaluands(samples, evaluands);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].evaluand.kind, 'skill');
    assert.equal(tasks[0].skillContent, 'my skill');
  });

  it('有 context 时拼接到 prompt', () => {
    const samples = [makeSample('s1', 'review this', 'code here')];
    const evaluands: EvaluandSpec[] = [
      { name: 'v1', kind: 'skill', source: 'variant-name', content: null },
    ];
    const tasks = buildTasksFromEvaluands(samples, evaluands);
    assert.ok(tasks[0].prompt.includes('review this'));
    assert.ok(tasks[0].prompt.includes('code here'));
    assert.ok(tasks[0].prompt.includes('```'));
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(buildTasksFromEvaluands([], []), []);
  });
});
