/**
 * oclif Command 调 legacy execute() 的 adapter helper。
 *
 * 14 个 oclif Command run() 之前都重复:
 *
 *   await this.parse(X);
 *   const argv = this.argv;
 *   const { execute } = await import('../../commands/y.js');
 *   const { CliExit } = await import('../../cli-exit.js');
 *   try {
 *     await execute(argv);
 *   } catch (err) {
 *     if (err instanceof CliExit) {
 *       if (err.code === 0) return;
 *       this.exit(err.code);
 *     }
 *     throw err;
 *   }
 *
 * 抽 runLegacyCommand 统一 CliExit → this.exit(code) 转译,Command 缩到 3-5 行。
 */
import type { Command } from '@oclif/core';
import { CliExit } from '../cli-exit.js';

export async function runLegacyCommand(
  oclifCmd: Command,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof CliExit) {
      if (err.code === 0) return;
      oclifCmd.exit(err.code);
      return;
    }
    throw err;
  }
}
