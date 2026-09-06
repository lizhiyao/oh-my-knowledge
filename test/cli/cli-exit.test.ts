import { describe, it, expect } from 'vitest';
import { CliExit } from '../../src/cli/lib/cli-exit.js';
import { runEvolve } from '../../src/cli/commands/evolve.js';
import { parseJudgeModelsArgOrExit } from '../../src/cli/lib/parse-run-config/judge-models.js';

/**
 * CliExit 收口让业务 runX() 在单测里可以被 try/catch 捕获,不再 kill 整个
 * 测试进程。这层验证「不该跑业务逻辑直接退出」的几条核心 path。
 */
describe('CliExit dispatch', () => {
  it('evolve 命令缺 skill 路径时 throw CliExit(1)', async () => {
    const err = await runEvolve(
      { skillPath: '' },
      {
        lang: 'zh',
        rounds: '5',
        samples: 'eval-samples.json',
        model: 'sonnet',
        'judge-models': 'claude:haiku',
        'improve-model': 'sonnet',
        concurrency: '1',
        timeout: '120',
        executor: 'claude',
        'skip-doctor': false,
        'improve-mode': 'agent',
        'edit-budget': '0.2',
        'no-edit-budget': false,
        'no-reject-memory': false,
        'snapshot-only': false,
      },
      'zh',
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CliExit);
    expect((err as CliExit).code).toBe(1);
  });

  // parseJudgeModelsArgOrExit 也要走 CliExit，否则 eval / evolve 子命令单测里
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
