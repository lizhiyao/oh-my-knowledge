/**
 * git variant 的 runtime 环境与 baseline 对称 —— git artifact 的 content 经 SDK 注入、不落盘,
 * 其 locator 是 git spec 而非磁盘目录。回归:不得对它取 dirname 当 skillDir,否则 buildExecEnv
 * 会把 `<cwd>/node_modules/.bin` 误并进 PATH,污染 runtime fingerprint、与 baseline 不对称(Δ 污染)。
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveExecutionStrategy } from '../../src/eval-core/execution-strategy.js';
import { buildTasksFromArtifacts } from '../../src/eval-core/task-planner.js';
import { buildExecEnv } from '../../src/executors/core/runtime.js';
import type { Artifact } from '../../src/types/index.js';

function planSkillDir(artifact: Artifact): string | null | undefined {
  const tasks = buildTasksFromArtifacts([{ sample_id: 's1', prompt: 'hi' }], [artifact]);
  return resolveExecutionStrategy(tasks[0], 'claude-opus-4-8').input.skillDir;
}

describe('git variant runtime skillDir(防 node_modules 污染指纹)', () => {
  it('git artifact → skillDir=null,与 baseline 一致(不取 git spec 的 dirname)', () => {
    const git: Artifact = {
      name: 'git:HEAD:review', kind: 'skill', source: 'git', content: '# s',
      locator: 'review', ref: 'HEAD', experimentRole: 'treatment',
    };
    const baseline: Artifact = {
      name: 'baseline', kind: 'baseline', source: 'baseline', content: null,
      experimentRole: 'control',
    };
    assert.equal(planSkillDir(git), null, 'git 的 skillDir 必须为 null');
    assert.equal(planSkillDir(baseline), null, 'baseline 的 skillDir 为 null');
  });

  it('带路径的 git spec(skills/review)同样 → null,不退化成 skills', () => {
    const git: Artifact = {
      name: 'git:HEAD:skills/review', kind: 'skill', source: 'git', content: '# s',
      locator: 'skills/review', ref: 'HEAD', experimentRole: 'treatment',
    };
    assert.equal(planSkillDir(git), null);
  });

  it('file-path artifact 仍取其在盘目录(skill 自带 deps 是合法 runtime)', () => {
    const file: Artifact = {
      name: 'v1', kind: 'skill', source: 'file-path', content: '# s',
      locator: '/some/dir/v1/SKILL.md', experimentRole: 'treatment',
    };
    assert.equal(planSkillDir(file), '/some/dir/v1');
  });

  it('从带 ./node_modules/.bin 的 cwd 跑:git 与 baseline 的 PATH 不分叉', () => {
    // 重现污染条件:cwd 下存在 node_modules/.bin。修复前 git 的 skillDir=`.` 会让 buildExecEnv 命中并
    // 注入,baseline 不会 → 两者 PATH 分叉。修复后 git skillDir=null,两者 PATH 一致。
    const dir = mkdtempSync(join(tmpdir(), 'omk-git-rt-'));
    const prev = process.cwd();
    try {
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      process.chdir(dir);
      const gitPath = buildExecEnv(planSkillDir({
        name: 'git:HEAD:review', kind: 'skill', source: 'git', content: '# s',
        locator: 'review', ref: 'HEAD', experimentRole: 'treatment',
      })).PATH;
      const basePath = buildExecEnv(null).PATH;
      assert.equal(gitPath, basePath, 'git 与 baseline 的 PATH 必须一致,不被 cwd 的 node_modules 污染');
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
