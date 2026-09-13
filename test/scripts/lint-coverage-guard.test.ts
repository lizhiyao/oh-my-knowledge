/**
 * 门禁覆盖守卫：`yarn lint` 的 glob 必须覆盖 src 与 test 下的全部 ts/tsx 文件。
 *
 * 起因：`lint` 曾把 test 侧的 glob 写死成只匹配 .ts，React 测试（.tsx）只被 pre-commit hook 的宽
 * glob 兜住，换机器或跳过 hook 时「未使用变量」这类问题会在 CI 静默通过 —— 与 vitest include 盲区同一失效机制。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'vitest';

const PROJECT_ROOT = join(__dirname, '..', '..');
const LINT = (JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>).lint;

function sourcesUnder(dir: string): string[] {
  const root = join(PROJECT_ROOT, dir);
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

describe('yarn lint 的文件覆盖', () => {
  it('React 测试确实在门禁里：glob 同时覆盖 src 与 test 的 ts 和 tsx', () => {
    // 仓库里确有 .tsx 测试，守卫不能是空断言。
    assert.ok(sourcesUnder('test').some((file) => file.endsWith('.tsx')), 'test/ 下存在 .tsx 测试');
    for (const pattern of ["'src/**/*.{ts,tsx}'", "'test/**/*.{ts,tsx}'"]) {
      assert.ok(LINT.includes(pattern), `lint 脚本缺少 ${pattern}：${LINT}`);
    }
  });

  it('不接受只匹配 .ts 的窄 glob 回归', () => {
    assert.equal(/'(?:src|test)\/\*\*\/\*\.ts'/.test(LINT), false, `发现只覆盖 .ts 的 glob：${LINT}`);
  });
});
