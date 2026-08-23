import { Command } from '@oclif/core';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { runCommand, type CommandRunError } from './run-command.js';

describe('runCommand', () => {
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
});
