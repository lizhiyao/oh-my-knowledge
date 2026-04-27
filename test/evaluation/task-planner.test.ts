import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildTasks, buildTasksFromArtifacts } from '../../src/eval-core/task-planner.js';
import type { Artifact, Sample } from '../../src/types/index.js';

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

  it('baseline variant 的 artifactContent 为 null', () => {
    const samples = [makeSample('s1', 'p1')];
    const tasks = buildTasks(samples, ['baseline', 'v1'], { baseline: null, v1: 'content' });
    const baseline = tasks.find((t) => t.variant === 'baseline')!;
    assert.equal(baseline.artifactContent, null);
    assert.equal(baseline.artifact.kind, 'baseline');
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(buildTasks([], ['baseline'], { baseline: null }), []);
    assert.deepEqual(buildTasks([makeSample('s1', 'p')], [], {}), []);
  });
});

describe('buildTasksFromArtifacts', () => {
  it('使用 artifact specs 创建任务', () => {
    const samples = [makeSample('s1', 'hello')];
    const artifacts: Artifact[] = [
      { name: 'test', kind: 'skill', source: 'variant-name', content: 'my skill' },
    ];
    const tasks = buildTasksFromArtifacts(samples, artifacts);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].artifact.kind, 'skill');
    assert.equal(tasks[0].artifactContent, 'my skill');
  });

  it('有 context 时拼接到 prompt', () => {
    const samples = [makeSample('s1', 'review this', 'code here')];
    const artifacts: Artifact[] = [
      { name: 'v1', kind: 'skill', source: 'variant-name', content: null },
    ];
    const tasks = buildTasksFromArtifacts(samples, artifacts);
    assert.ok(tasks[0].prompt.includes('review this'));
    assert.ok(tasks[0].prompt.includes('code here'));
    assert.ok(tasks[0].prompt.includes('```'));
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(buildTasksFromArtifacts([], []), []);
  });

  it('cwd fallback 链:artifact.cwd > skillRoot > sample.cwd > null', () => {
    const samples = [makeSample('s1', 'p')];

    // 1. 仅 skillRoot:directory-skill 默认锚到 skill 根
    const onlySkillRoot: Artifact[] = [
      { name: 'k', kind: 'skill', source: 'variant-name', content: 'c', skillRoot: '/skill/root' },
    ];
    assert.equal(buildTasksFromArtifacts(samples, onlySkillRoot)[0].cwd, '/skill/root');

    // 2. artifact.cwd 优先于 skillRoot(用户显式 @cwd 覆盖默认)
    const cwdAndSkillRoot: Artifact[] = [
      { name: 'k', kind: 'skill', source: 'variant-name', content: 'c', cwd: '/explicit', skillRoot: '/skill/root' },
    ];
    assert.equal(buildTasksFromArtifacts(samples, cwdAndSkillRoot)[0].cwd, '/explicit');

    // 3. 都没有 → null(executor 走 process.cwd())
    const none: Artifact[] = [
      { name: 'k', kind: 'skill', source: 'variant-name', content: 'c' },
    ];
    assert.equal(buildTasksFromArtifacts(samples, none)[0].cwd, null);

    // 4. sample.cwd 兜底(file-skill 配 sample-级 cwd)
    const sampleWithCwd: Sample = { sample_id: 's2', prompt: 'p', cwd: '/sample/cwd' };
    assert.equal(buildTasksFromArtifacts([sampleWithCwd], none)[0].cwd, '/sample/cwd');
  });
});
