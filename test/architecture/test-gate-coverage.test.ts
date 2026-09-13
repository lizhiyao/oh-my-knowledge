/**
 * 门禁自守：vitest 的 include 必须覆盖 test/ 下真实存在的每种测试文件扩展名。
 *
 * 收件箱收口（#839）时 React 页面的测试是 .tsx，而 include 只写了 .ts，
 * 文件被静默跳过、CI 仍然全绿。这里把「磁盘上的测试扩展名 ⊆ include 声明的扩展名」
 * 变成断言，并要求每条 include 覆盖整棵 test/ 树，避免同一类假绿换个形式再来。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEST_DIR = join(REPO_ROOT, 'test');
const SKIPPED_DIRS = new Set(['node_modules', '__snapshots__']);
const TEST_FILE = /\.test\.([A-Za-z]+)$/;

function collectTestExtensions(dir: string, out: Set<string> = new Set()): Set<string> {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collectTestExtensions(path, out);
    else {
      const match = TEST_FILE.exec(entry);
      if (match) out.add(match[1]);
    }
  }
  return out;
}

function declaredIncludePatterns(): string[] {
  const source = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf-8');
  const declaration = /include:\s*\[([^\]]*)\]/.exec(source);
  expect(declaration, 'vitest.config.ts 必须显式声明 test.include').not.toBeNull();
  return [...declaration![1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function declaredExtensions(patterns: string[]): Set<string> {
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const group of pattern.matchAll(/\{([^}]*)\}/g)) {
      for (const extension of group[1].split(',')) out.add(extension.trim());
    }
    const single = TEST_FILE.exec(pattern);
    if (single) out.add(single[1]);
  }
  return out;
}

describe('测试门禁覆盖面自守', () => {
  it('include 覆盖 test/ 下每种测试文件扩展名', () => {
    const patterns = declaredIncludePatterns();
    const onDisk = collectTestExtensions(TEST_DIR);
    // 任一侧为空都会让断言变成假绿。
    expect(patterns.length).toBeGreaterThan(0);
    expect(onDisk.size).toBeGreaterThan(0);
    // React 页面测试是这条守门的起因，必须在场，否则上面的包含关系无意义。
    expect(onDisk.has('tsx')).toBe(true);

    const declared = declaredExtensions(patterns);
    const uncovered = [...onDisk].filter((extension) => !declared.has(extension)).sort();
    expect(uncovered, `这些测试扩展名不会被 vitest 收集：${uncovered.join('、')}`).toEqual([]);
  });

  it('include 覆盖整棵 test/ 树而不是某个子目录', () => {
    const patterns = declaredIncludePatterns();
    expect(patterns.every((pattern) => pattern.startsWith('test/') && pattern.includes('**'))).toBe(true);
  });
});
