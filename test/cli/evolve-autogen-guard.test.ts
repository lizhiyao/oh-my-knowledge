import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvolve } from '../../src/cli/commands/evolve.js';
import { createEvalSampleSetDocument } from '../../src/eval-workflows/inputs/schemas/sample-set.js';
import { CliExit } from '../../src/cli/lib/cli-exit.js';
import type { EvolveFlags } from '../../src/cli/commands/evolve.js';

const generateSamples = vi.hoisted(() => vi.fn());
vi.mock('../../src/knowledge-artifacts/authoring/generator.js', () => ({ generateSamples }));

/**
 * evolve 一键化最关键的安全行为:用例源「存在但解析失败」= 损坏文件,绝不用 LLM
 * 生成内容覆盖它,而是退 1 让用户先修。守卫在任何生成 / LLM 调用之前 return,故本测
 * 全程不触网、不打模型。这条以前没有 runEvolve 级测试,只锁了 sampleSourceExists helper。
 */
function mkFlags(over: Partial<EvolveFlags>): EvolveFlags {
  return {
    lang: 'zh', rounds: '5', samples: 'eval-samples.json', model: 'sonnet',
    'judge-models': 'claude:haiku', 'improve-model': 'sonnet', concurrency: '1',
    timeout: '120', executor: 'claude', 'skip-doctor': false,
    'improve-mode': 'agent', 'edit-budget': '0.2', 'no-edit-budget': false,
    'no-reject-memory': false, 'snapshot-only': false,
    ...over,
  } as EvolveFlags;
}

describe('runEvolve 损坏用例文件守卫', () => {
  let dir: string;
  let skill: string;
  let badSamples: string;
  const BROKEN = '{ broken json, not parseable';

  beforeEach(() => {
    generateSamples.mockReset();
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
  it('显式空样本不调用生成器，也不替换文档', async () => {
    const empty = JSON.stringify(createEvalSampleSetDocument([]));
    writeFileSync(badSamples, empty);
    await expect(runEvolve({ skillPath: skill }, mkFlags({ samples: badSamples }), 'en'))
      .rejects.toMatchObject({ code: 1 });
    expect(generateSamples).not.toHaveBeenCalled();
    expect(readFileSync(badSamples, 'utf8')).toBe(empty);
  });

  it('自动生成期间出现目标文件时保留外部内容', async () => {
    const skillDir = join(dir, 'isolated-skill');
    mkdirSync(join(skillDir, '.omk'), { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Review');
    const target = join(skillDir, '.omk', 'eval-samples.json');
    const sample = { sample_id: 'external', prompt: 'Review' };
    const external = JSON.stringify(createEvalSampleSetDocument([sample]));
    generateSamples.mockImplementation(async () => {
      writeFileSync(target, external);
      return { samples: [sample], costUSD: 0 };
    });
    await expect(runEvolve({ skillPath: skillDir }, mkFlags({ samples: undefined }), 'en'))
      .rejects.toMatchObject({ code: 1 });
    expect(generateSamples).toHaveBeenCalledOnce();
    expect(readFileSync(target, 'utf8')).toBe(external);
  });

});
