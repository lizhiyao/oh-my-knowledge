import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('eval-workflows 与 executors 领域布局', () => {
  it('eval-workflows 根目录只保留已规划的稳定子域与共享入口', () => {
    const entries = readdirSync(resolve('src/eval-workflows'), { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual([
        'analysis',
        'artifact-store',
        'assertions',
        'gold',
        'input-compilation',
        'inputs',
        'instruments',
        'measurement',
        'orchestration',
        'projections',
        'resume-admission',
      ]);
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual(['AGENTS.md', 'evaluation-defaults.ts', 'messages.ts']);
  });

  it('runtime-adapter 的增长进入能力子域而不是继续堆入根目录', () => {
    const entries = readdirSync(resolve('src/eval-hosts/runtime-adapter'), {
      withFileTypes: true,
    });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual(['adapters', 'evaluators', 'resource-leases']);
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual([
        'assembly.ts',
        'builtins.ts',
        'composition.ts',
        'index.ts',
        'preflight.ts',
        'types.ts',
      ]);
  });

  it('executors 保留独立的执行前检查边界', () => {
    expect(
      readdirSync(resolve('src/executors/preflight')).sort(),
    ).toEqual(['contracts.ts', 'dependencies.ts']);
  });

  it('不恢复迁移前的 src、test 或 dist 顶层目录', () => {
    for (const path of [
      'src/inputs',
      'src/grading',
      'src/preflight',
      'src/eval-workflows/grading',
      'src/eval-workflows/downstream-projections',
      'test/inputs',
      'test/grading',
      'test/preflight',
      'dist/inputs',
      'dist/grading',
      'dist/preflight',
      'dist/eval-workflows/grading',
      'dist/eval-workflows/downstream-projections',
    ]) {
      expect(existsSync(resolve(path)), path).toBe(false);
    }
  });
});
