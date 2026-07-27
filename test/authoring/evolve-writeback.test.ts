/**
 * evolveSkill 的 writeBackToSource 守卫（--snapshot-only 落点）端到端锁定：writeBackToSource=false 时
 * 绝不写回源文件 absSkillPath、=true（默认）时写回。走最省的 stopOnAssertionsPass 早返路径（baseline 断言
 * 全过即停），不进改进循环、不真打 LLM。该路径写回的内容 == baseline 原内容，内容层面观察不到差异，故用
 * 透传 spy 观察「writeFileSync 是否打到 absSkillPath」这一守卫的唯一可观测效果。runEvaluation 被 mock 成
 * 返回一份「断言全过」的 baseline 报告。
 */
import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildVariantResult, buildVariantSummary } from '../../src/eval-core/schema.js';
import { parseReportDocument } from '../../src/eval-core/report-document.js';
import type { ExecResult, GradeResult } from '../../src/types/index.js';

const { writeSpy } = vi.hoisted(() => ({ writeSpy: vi.fn() }));

// node:fs 透传 spy:只包 writeFileSync 记调用，其余原样（readFileSync / mkdirSync / renameSync … 不变）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      writeSpy(...args);
      return actual.writeFileSync(...args);
    },
  };
});

const VARIANT = 'V';
function passingBaselineReport() {
  const execution: ExecResult = {
    ok: true,
    output: 'done',
    durationMs: 1,
    durationApiMs: 1,
    inputTokens: 1, outputTokens: 1,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0,
    stopReason: 'end_turn',
    numTurns: 1,
  };
  const grade: GradeResult = {
    compositeScore: 5,
    layeredScores: { factScore: 5 },
    assertions: {
      passed: 1,
      total: 1,
      score: 5,
      details: [{ type: 'contains', value: 'done', weight: 1, passed: true }],
    },
  };
  const variants = Array.from({ length: 3 }, () => buildVariantResult(execution, grade));
  const results = variants.map((variant, index) => ({
    sample_id: `s${index}`,
    variants: { [VARIANT]: variant },
  }));
  const summary = { [VARIANT]: buildVariantSummary(variants) };
  const report = {
    kind: 'evaluation', id: 'r', meta: {
      variants: [VARIANT], model: 'm', judgeModels: [{ executor: 'c', model: 'j' }], executor: 'c',
      sampleCount: 3, taskCount: 3, totalCostUSD: 0, timestamp: '2026-06-10T00:00:00Z',
      cliVersion: 't', nodeVersion: 't', artifactHashes: { [VARIANT]: 'h' },
    },
    summary, results,
  };
  assert.ok(parseReportDocument(report, 'r', 'r'), 'baseline fixture 必须满足持久化报告契约');
  return report;
}

vi.mock('../../src/eval-workflows/run-evaluation.js', () => ({
  runEvaluation: vi.fn(async () => ({ report: passingBaselineReport() })),
}));

const { evolveSkill } = await import('../../src/authoring/evolver.js');

describe('evolveSkill writeBackToSource 守卫', () => {
  let proj: string;
  let home: string;
  let skillPath: string;
  let samplesPath: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const ORIGINAL = '# original skill\n\nbaseline content.\n';

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'omk-evo-wb-'));
    home = mkdtempSync(join(tmpdir(), 'omk-evo-home-'));
    skillPath = join(proj, 'skill.md');
    writeFileSync(skillPath, ORIGINAL);
    samplesPath = join(proj, 'samples.json');
    writeFileSync(samplesPath, JSON.stringify(
      Array.from({ length: 3 }, (_, index) => ({
        sample_id: `s${index}`,
        prompt: `do x ${index}`,
        assertions: [],
      })),
    ));
    savedHome = process.env.HOME; savedProfile = process.env.USERPROFILE;
    process.env.HOME = home; process.env.USERPROFILE = home; // persistReport 落到临时 HOME,不污染真实目录
    writeSpy.mockClear(); // 清掉上面 fixture 的写,只记 evolveSkill 内部的 writeFileSync
  });
  afterEach(() => {
    process.env.HOME = savedHome; process.env.USERPROFILE = savedProfile;
    rmSync(proj, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const opts = (over: Record<string, unknown>) => ({
    skillPath, samplesPath, rounds: 1, stopOnAssertionsPass: true, skipDoctor: true,
    skipConnectivity: true, judgeModels: [{ executor: 'c', model: 'j' }], ...over,
  });
  const wroteSource = (): boolean => writeSpy.mock.calls.some((c) => resolve(String(c[0])) === resolve(skillPath));

  it('writeBackToSource=false（--snapshot-only）→ 绝不写回源文件，但候选快照仍落盘', async () => {
    await evolveSkill(opts({ writeBackToSource: false }) as Parameters<typeof evolveSkill>[0]);
    assert.equal(wroteSource(), false, '源文件 absSkillPath 不应被 writeFileSync');
    assert.equal(readFileSync(skillPath, 'utf-8'), ORIGINAL, '源内容原封不动');
    // 候选快照 evolve/<skill>.r0.md 仍应写（守卫只挡源写，不挡快照写）。
    assert.ok(writeSpy.mock.calls.some((c) => /[/\\]evolve[/\\].*\.r0\.md$/.test(String(c[0]))), 'r0 快照仍落盘');
  });

  it('writeBackToSource=true（默认）→ 写回源文件', async () => {
    await evolveSkill(opts({}) as Parameters<typeof evolveSkill>[0]);
    assert.equal(wroteSource(), true, '默认应写回 absSkillPath');
  });
});
