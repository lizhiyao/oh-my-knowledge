import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-ci-quick-')); roots.push(root);
  for (const path of ['scripts/ci', 'test', 'node_modules/vitest']) mkdirSync(join(root, path), { recursive: true });
  for (const name of ['quick.mjs', 'test.mjs']) cpSync(resolve('scripts/ci', name), join(root, 'scripts/ci', name));
  writeFileSync(join(root, 'test/a.test.ts'), '');
  writeFileSync(join(root, 'test/b.test.tsx'), '');
  writeFileSync(join(root, 'owned.txt'), 'original');
  writeFileSync(join(root, 'outside.test.ts'), '');
  writeFileSync(join(root, 'yarn.mjs'), `#!/usr/bin/env node
    import { appendFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const args = process.argv.slice(2);
    appendFileSync('commands.jsonl', JSON.stringify(args) + '\\n');
    if (args[0] === process.env.QUICK_FAIL_STAGE) process.exit(7);
    if (process.env.QUICK_SIGNAL === '1') process.kill(process.pid, 'SIGTERM');
    if (args[0] === 'test') {
      const result = spawnSync(process.execPath, ['scripts/ci/test.mjs', ...args.slice(1)], {stdio: 'inherit'});
      process.exit(result.status ?? 1);
    }
  `);
  chmodSync(join(root, 'yarn.mjs'), 0o755);
  writeFileSync(join(root, 'node_modules/vitest/vitest.mjs'), `
    import { writeFileSync } from 'node:fs';
    if (process.env.QUICK_MUTATE === '1') writeFileSync('owned.txt', 'changed');
  `);
  const git = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(git.status, 0, git.stderr);
  return {
    root,
    // The boundary under test is the script's process exit, argument forwarding,
    // and invocation of the real hermetic wrapper, without running nested suites.
    run(args: string[], env: NodeJS.ProcessEnv = {}) {
      return spawnSync(process.execPath, ['scripts/ci/quick.mjs', ...args], {
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, npm_execpath: join(root, 'yarn.mjs'), ...env },
      });
    },
    commands(): string[][] {
      const path = join(root, 'commands.jsonl');
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    },
  };
}

describe('ci:quick', () => {
  it('拒绝空选择、目录、缺失文件和改变测试范围的选项，且不执行检查', () => {
    const f = fixture();
    for (const args of [[], ['test'], ['outside.test.ts'], ['test/missing.test.ts'], ['--passWithNoTests'], ['test/a.test.ts', '--exclude=test/a.test.ts']]) {
      const result = f.run(args);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /用法/);
    }
    assert.deepEqual(f.commands(), []);
    assert.equal(f.run(['--help']).status, 0);
  });

  it('透传明确的 TS／TSX 文件并去重，保留测试隔离入口', () => {
    const f = fixture();
    const result = f.run(['test/a.test.ts', './test/b.test.tsx', 'test/a.test.ts']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.commands(), [['lint'], ['typecheck'], ['test', 'test/a.test.ts', 'test/b.test.tsx']]);
    assert.match(result.stdout, /不代表完整 CI 通过/);
  });

  it('静态检查或测试失败时返回原退出码，不继续后续阶段', () => {
    for (const [stage, count] of [['lint', 1], ['typecheck', 2], ['test', 3]] as const) {
      const f = fixture();
      const result = f.run(['test/a.test.ts'], { QUICK_FAIL_STAGE: stage });
      assert.equal(result.status, 7, result.stderr);
      assert.equal(f.commands().length, count);
    }
    const interrupted = fixture();
    assert.equal(interrupted.run(['test/a.test.ts'], { QUICK_SIGNAL: '1' }).status, 1);
    assert.equal(interrupted.commands().length, 1);
  });

  it('测试本身成功但污染仓库时仍失败', () => {
    const f = fixture();
    const result = f.run(['test/a.test.ts'], { QUICK_MUTATE: '1' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Tests modified repository-owned content/);
    assert.match(result.stderr, /owned.txt/);
  });
});
