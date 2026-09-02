import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOMAIN_ROOT = resolve('src/knowledge-artifacts');
const RETIRED_TOP_LEVEL_DIRECTORIES = [
  'authoring',
  'doctor',
  'managed',
  'skill-definition',
] as const;

describe('knowledge-artifacts 领域布局', () => {
  it('以生命周期子域表达稳定所有权', () => {
    const entries = readdirSync(DOMAIN_ROOT, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual(['authoring', 'doctor', 'governance', 'skills', 'sources']);
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual(['contracts.ts']);
  });

  it('不保留旧源码、测试或构建顶层兼容目录', () => {
    const remaining = RETIRED_TOP_LEVEL_DIRECTORIES.flatMap((directory) => [
      `src/${directory}`,
      `test/${directory}`,
      ...(existsSync(resolve('dist')) ? [`dist/${directory}`] : []),
    ]).filter((path) => existsSync(resolve(path)));
    expect(remaining).toEqual([]);
  });
});
