import { describe, it, expect } from 'vitest';
import { CliExit } from '../../src/cli/cli-exit.js';
import { execute as exportReport } from '../../src/cli/commands/export.js';
import { execute as improve } from '../../src/cli/commands/improve.js';
import { parseArgsStrictOrExit } from '../../src/cli/parse-strict.js';
import { parseJudgeModelsArgOrExit } from '../../src/cli/parse-run-config.js';

/**
 * CliExit 收口让 execute() 在单测里可以被 try/catch 捕获,不再 kill 整个
 * 测试进程。这层验证「不该跑业务逻辑直接退出」的几条核心 path。
 */
describe('CliExit dispatch', () => {
  it('export 命令缺 reportId 时 throw CliExit(1)，不 kill 进程', async () => {
    const err = await exportReport([]).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CliExit);
    expect((err as CliExit).code).toBe(1);
  });

  it('improve 命令缺参数时 throw CliExit(1)', async () => {
    const err = await improve([]).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(CliExit);
    expect((err as CliExit).code).toBe(1);
  });

  it('parseArgsStrictOrExit 收到未知 option 时 throw CliExit(2)', () => {
    expect(() =>
      parseArgsStrictOrExit({
        args: ['--bogus-flag'],
        options: { known: { type: 'string' } },
      }),
    ).toThrowError(CliExit);
  });

  // parseJudgeModelsArgOrExit 也要走 CliExit，否则 eval / improve 子命令单测里
  // 仍会被 process.exit kill。
  it('parseJudgeModelsArgOrExit 收到非法 --judge-models 时 throw CliExit(2)', () => {
    let caught: unknown = null;
    try {
      parseJudgeModelsArgOrExit('claude');  // 缺 ':',应触发 parse 错误
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliExit);
    expect((caught as CliExit).code).toBe(2);
  });
});
