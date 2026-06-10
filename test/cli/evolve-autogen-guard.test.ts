import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvolve } from '../../src/cli/commands/evolve.js';
import { CliExit } from '../../src/cli/lib/cli-exit.js';
import type { EvolveFlags } from '../../src/cli/lib/cmd-flags.js';

/**
 * evolve 一键化最关键的安全行为:用例源「存在但解析失败」= 损坏文件,绝不用 LLM
 * 生成内容覆盖它,而是退 1 让用户先修。守卫在任何生成 / LLM 调用之前 return,故本测
 * 全程不触网、不打模型。这条以前没有 runEvolve 级测试,只锁了 sampleSourceExists helper。
 */
function mkFlags(over: Partial<EvolveFlags>): EvolveFlags {
  return {
    lang: 'zh', rounds: '5', samples: 'eval-samples.json', model: 'sonnet',
    'judge-models': 'claude:haiku', 'improve-model': 'sonnet', concurrency: '1',
    timeout: '120', executor: 'claude', 'skip-connectivity': false,
    'no-diagnostic': false, 'skip-doctor': false, 'stop-on-assertions-pass': false,
    'auto-fix-samples': false, 'sample-fix-max-attempts': '2', 'reuse-latest-eval': false,
    'improve-mode': 'agent', 'holdout-ratio': '0', 'no-significance-gate': false,
    'significance-alpha': '0.05', 'test-ratio': '0', 'edit-budget': '0.2',
    'no-edit-budget': false, 'no-reject-memory': false,
    ...over,
  } as EvolveFlags;
}

describe('runEvolve 损坏用例文件守卫', () => {
  let dir: string;
  let skill: string;
  let badSamples: string;
  const BROKEN = '{ broken json, not parseable';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omk-evolve-guard-'));
    skill = join(dir, 'skill.md');
    writeFileSync(skill, '# review skill\n\ndo the thing.\n');
    badSamples = join(dir, 'eval-samples.json');
    writeFileSync(badSamples, BROKEN);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('用例源存在但解析失败 → 退 1,且绝不覆盖原文件', async () => {
    const err = await runEvolve(
      { skillPath: skill },
      mkFlags({ samples: badSamples }),
      'zh',
    ).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(CliExit);
    expect((err as CliExit).code).toBe(1);
    // 守卫必须在生成前退出 —— 损坏文件内容原样保留,没被 LLM 产物覆盖。
    expect(readFileSync(badSamples, 'utf-8')).toBe(BROKEN);
  });
});
