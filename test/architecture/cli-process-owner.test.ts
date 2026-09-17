/**
 * CLI 真子进程 harness 的单一 owner 守门。
 *
 * #950 之前，16 个测试文件各自 `promisify(execFile)` 手搓子进程 harness，
 * 同一份错误形状声明了 16 遍并漂移成 `code?: number`／`code: number` 两种，
 * 配套 `as ExecError` 无检查强转对 lint、类型检查和测试全绿都不可见。
 * 唯一 owner 是 test/helpers/cli-process.ts；新用例一律走 runCli／runCliFailing。
 * 口径同 studio-page-paths.test.ts 的「不得绕过 owner 用字面量」。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TEST_DIR = join(REPO_ROOT, 'test');
const SKIPPED_DIRS = new Set(['node_modules', '__snapshots__', '.next']);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listSourceFiles(path, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(path);
  }
  return out;
}

describe('CLI 子进程 harness 单一 owner 守门', () => {
  it('test/ 下不得再出现手搓的 promisify(execFile)', () => {
    const files = listSourceFiles(TEST_DIR);
    // 扫描退化守卫：必须真的扫到测试源码，否则下面的断言是假绿。
    expect(files.length).toBeGreaterThan(400);

    const self = fileURLToPath(import.meta.url);
    const offenders = files
      .filter((file) => file !== self)
      .filter((file) => readFileSync(file, 'utf8').includes('promisify(execFile)'))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'));
    expect(
      offenders,
      `这些文件手搓了子进程 harness，改用 test/helpers/cli-process.ts 的 runCli／runCliFailing：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
