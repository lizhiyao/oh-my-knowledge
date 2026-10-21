import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_FILE = /\.test\.(?:ts|tsx)$/;
const SKIPPED_DIRS = new Set(['node_modules', '__snapshots__', '.next']);

function testFiles(root, directory = join(root, 'test')) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_DIRS.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(root, path);
    return entry.isFile() && TEST_FILE.test(entry.name)
      ? [relative(root, path).split(sep).join('/')]
      : [];
  }).sort();
}

/** Standalone quality gate: its execution never depends on a Vitest shard list. */
export function checkTestShardCoverage(root = REPO_ROOT) {
  const onDisk = testFiles(root);
  const actual = new Set(onDisk);
  const covered = new Set();
  const duplicates = new Set();
  const unknown = new Set();
  for (const index of [1, 2, 3, 4]) {
    const lines = readFileSync(join(root, `test/shards/source-${index}.txt`), 'utf8').split('\n');
    for (const line of lines) {
      const path = line.trim();
      if (path === '' || path.startsWith('#')) continue;
      if (covered.has(path)) duplicates.add(path);
      if (!actual.has(path)) unknown.add(path);
      covered.add(path);
    }
  }
  const missing = onDisk.filter((path) => !covered.has(path));
  const issues = [
    ...(onDisk.length === 0 ? ['没有发现测试文件，不能证明 CI 分片覆盖。'] : []),
    ...(missing.length ? [`未进入 CI 分片：\n  ${missing.join('\n  ')}`] : []),
    ...(duplicates.size ? [`重复进入 CI 分片：\n  ${[...duplicates].sort().join('\n  ')}`] : []),
    ...(unknown.size ? [`CI 分片引用不存在的测试：\n  ${[...unknown].sort().join('\n  ')}`] : []),
  ];
  if (issues.length) throw new Error(issues.join('\n'));
  return onDisk.length;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`[test-coverage] ${checkTestShardCoverage()} 个测试文件均由一个 CI 分片覆盖。`);
  } catch (error) {
    console.error(`[test-coverage] ${error.message}`);
    process.exitCode = 1;
  }
}
