import { Command } from '@oclif/core';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'vitest';
import { runCommand, type CommandRunError } from './run-command.js';

describe('runCommand', () => {
  it('未指定 cwd 时使用并清理临时项目目录', async () => {
    class CwdCommand extends Command {
      async run(): Promise<void> {
        await this.parse(CwdCommand);
        this.log(process.cwd());
      }
    }

    const commandCwd = (await runCommand(CwdCommand, [])).stdout.trim();
    assert.notEqual(commandCwd, process.cwd());
    assert.equal(existsSync(commandCwd), false, 'temporary command cwd should be removed after the run');
  });

  it('执行完整 Oclif init → run → finally 生命周期', async () => {
    const events: string[] = [];
    class LifecycleCommand extends Command {
      protected async init(): Promise<void> {
        events.push('init');
        await super.init();
      }

      async run(): Promise<void> {
        await this.parse(LifecycleCommand);
        events.push('run');
        this.log('ok');
      }

      protected async finally(): Promise<void> {
        events.push('finally');
      }
    }

    const output = await runCommand(LifecycleCommand, []);
    assert.deepEqual(events, ['init', 'run', 'finally']);
    assert.equal(output.stdout, 'ok\n');
  });

  it('保留 Oclif exit code，并恢复测试进程的 exitCode', async () => {
    class ExitCommand extends Command {
      async run(): Promise<void> {
        this.exit(2);
      }
    }

    const previousExitCode = process.exitCode;
    await assert.rejects(
      () => runCommand(ExitCommand, []),
      (error: unknown) => (error as CommandRunError).code === 2,
    );
    assert.equal(process.exitCode, previousExitCode);
  });

  it('把 env 当作覆盖项合并，并在结束后恢复进程环境', async () => {
    class EnvCommand extends Command {
      async run(): Promise<void> {
        await this.parse(EnvCommand);
        this.log(`${process.env.PATH ? 'path' : 'missing'}:${process.env.OMK_RUN_COMMAND_TEST}`);
      }
    }

    const previous = process.env.OMK_RUN_COMMAND_TEST;
    const output = await runCommand(EnvCommand, [], {
      env: { OMK_RUN_COMMAND_TEST: 'override' },
    });
    assert.equal(output.stdout, 'path:override\n');
    assert.equal(process.env.OMK_RUN_COMMAND_TEST, previous);
  });

  it('只设置 command 实例 id，不修改 Command class 的静态状态', async () => {
    class IdCommand extends Command {
      async run(): Promise<void> {
        await this.parse(IdCommand);
        this.log(this.id ?? 'missing');
      }
    }

    assert.equal(Object.hasOwn(IdCommand, 'id'), false);
    assert.equal((await runCommand(IdCommand, [])).stdout, 'idcommand\n');
    assert.equal((await runCommand(IdCommand, [])).stdout, 'idcommand\n');
    assert.equal(Object.hasOwn(IdCommand, 'id'), false);
  });
});
