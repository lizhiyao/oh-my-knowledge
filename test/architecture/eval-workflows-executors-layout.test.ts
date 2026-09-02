import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('eval-workflows 与 executors 领域布局', () => {
  it('保留输入、评分类适配与执行前检查的稳定子域', () => {
    expect(existsSync(resolve('src/eval-workflows/inputs'))).toBe(true);
    expect(existsSync(resolve('src/eval-workflows/grading'))).toBe(true);
    expect(
      readdirSync(resolve('src/executors/preflight')).sort(),
    ).toEqual(['contracts.ts', 'dependencies.ts']);
  });

  it('不恢复迁移前的 src、test 或 dist 顶层目录', () => {
    for (const path of [
      'src/inputs',
      'src/grading',
      'src/preflight',
      'test/inputs',
      'test/grading',
      'test/preflight',
      'dist/inputs',
      'dist/grading',
      'dist/preflight',
    ]) {
      expect(existsSync(resolve(path)), path).toBe(false);
    }
  });
});
