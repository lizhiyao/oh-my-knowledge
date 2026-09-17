/**
 * cli-process helper 的控制组：证明 runCli / runCliFailing 不是空转。
 * 自包含 fixture 脚本（不依赖 dist），每条用例钉住一处关键判断——
 * helper 里断码逻辑被改掉时，至少一条必须变红：
 * - runCli 的 `code !== 0` 被吞      → 第 2 条红
 * - runCliFailing 的 exit-0 分支被吞 → 第 4 条红
 * - runCliFailing 的码比较被吞       → 第 5 条红
 * - options.entry 被忽略             → 全部红（fixture 与 CLI 行为无关）
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { CliProcessError, runCli, runCliFailing } from './cli-process.js';

let fixtureDir = '';
let entry = '';

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'omk-cli-process-test-'));
  entry = join(fixtureDir, 'exit.js');
  writeFileSync(entry, [
    'const code = Number(process.argv[2]);',
    "process.stdout.write('fixture-stdout');",
    "process.stderr.write('fixture-stderr');",
    'process.exit(code);',
    '',
  ].join('\n'));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('cli-process helper 控制组', () => {
  it('runCli 对 exit 0 的进程 resolve stdout/stderr', async () => {
    const output = await runCli(['0'], { entry });
    assert.deepEqual(output, { stdout: 'fixture-stdout', stderr: 'fixture-stderr' });
  });

  it('runCli 对非零退出 reject CliProcessError，带 code/stdout/stderr', async () => {
    const error = await runCli(['7'], { entry }).then(
      () => assert.fail('exit 7 must reject'),
      (err: unknown) => err,
    );
    assert.ok(error instanceof CliProcessError);
    assert.equal(error.code, 7);
    assert.equal(error.stdout, 'fixture-stdout');
    assert.equal(error.stderr, 'fixture-stderr');
  });

  it('runCliFailing 在进程以 expectedCode 退出时 resolve', async () => {
    const output = await runCliFailing(['3'], 3, { entry });
    assert.deepEqual(output, { stdout: 'fixture-stdout', stderr: 'fixture-stderr' });
  });

  it('runCliFailing 在进程 exit 0 时 reject（进程成功即用例失败）', async () => {
    await assert.rejects(() => runCliFailing(['0'], 1, { entry }), CliProcessError);
  });

  it('runCliFailing 在退出码与 expectedCode 不符时 reject', async () => {
    const error = await runCliFailing(['5'], 2, { entry }).then(
      () => assert.fail('exit 5 ≠ expected 2 must reject'),
      (err: unknown) => err,
    );
    assert.ok(error instanceof CliProcessError);
    assert.equal(error.code, 5);
  });
});
