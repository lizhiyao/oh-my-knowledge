import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { validateLengthDebias } from '../../src/grading/debias-validate.js';
import type { ExecutorFn, Report, Sample } from '../../src/types.js';

/**
 * Mock executor that returns a fixed JSON judge response. We use it to
 * deterministically simulate "v2 prompt scores higher than v3 prompt" so the
 * verdict logic can be exercised end-to-end without real API calls.
 */
function makeMockJudge(scoreFn: (judgePrompt: string) => number): ExecutorFn {
  return async ({ prompt }) => {
    const score = scoreFn(prompt);
    return {
      ok: true,
      output: JSON.stringify({ score, reason: 'mock', reasoning: 'mock' }),
      durationMs: 1,
      durationApiMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0.0001,
      stopReason: 'end_turn',
      numTurns: 1,
    };
  };
}

const sample = (id: string, prompt: string, rubric: string): Sample => ({
  sample_id: id,
  prompt,
  rubric,
});

const buildReport = (
  variant: string,
  rows: Array<{ sample_id: string; output: string; llmScore: number }>,
  debiasMode: Array<'length' | 'position'> = ['length'],
): Report => ({
  id: 'r1',
  meta: {
    variants: [variant],
    model: 'test-model',
    judgeModel: 'test-judge',
    executor: 'claude',
    sampleCount: rows.length,
    taskCount: rows.length,
    totalCostUSD: 0,
    timestamp: '2026-04-25T00:00:00Z',
    cliVersion: 'test',
    nodeVersion: 'test',
    artifactHashes: { [variant]: 'abc' },
    debiasMode,
  },
  summary: {},
  results: rows.map((r) => ({
    sample_id: r.sample_id,
    variants: {
      [variant]: {
        ok: true, durationMs: 0, durationApiMs: 0, inputTokens: 0, outputTokens: 0,
        totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        execCostUSD: 0, judgeCostUSD: 0, costUSD: 0, numTurns: 0,
        llmScore: r.llmScore,
        fullOutput: r.output,
        outputPreview: null,
      },
    },
  })),
});

describe('validateLengthDebias', () => {
  it('detects a strong shift when alternate prompt scores systematically higher', () => {
    // Original ran with debias-on (v3-cot-length). Alternate is v2-cot.
    // Mock judge returns 5 for v2-cot prompts (those don't contain the debias section)
    // and 3 for v3-cot-length prompts. Original llmScores are 3 (matching v3).
    const samples: Sample[] = [
      sample('s1', 'p1', 'rubric 1'),
      sample('s2', 'p2', 'rubric 2'),
      sample('s3', 'p3', 'rubric 3'),
      sample('s4', 'p4', 'rubric 4'),
      sample('s5', 'p5', 'rubric 5'),
    ];
    const report = buildReport('v1', samples.map((s) => ({
      sample_id: s.sample_id, output: 'output', llmScore: 3,
    })));
    const judgeExecutor = makeMockJudge((prompt) => prompt.includes('长度不是质量信号') ? 3 : 5);
    return validateLengthDebias({
      report, samples, judgeExecutor, judgeModel: 'test-judge', bootstrapSamples: 500, seed: 1,
    }).then((result) => {
      assert.equal(result.pairs.length, 5);
      assert.equal(result.meanOriginal, 3);
      assert.equal(result.meanAlternate, 5);
      assert.equal(result.diffCI.estimate, 2);
      assert.equal(result.diffCI.significant, true);
      assert.equal(result.verdict.level, 'strong');
    });
  });

  it('reports "未检测到" when alternate prompt yields the same scores', async () => {
    const samples: Sample[] = [
      sample('s1', 'p', 'r'), sample('s2', 'p', 'r'),
      sample('s3', 'p', 'r'), sample('s4', 'p', 'r'),
    ];
    const report = buildReport('v1', samples.map((s) => ({
      sample_id: s.sample_id, output: 'o', llmScore: 4,
    })));
    const judgeExecutor = makeMockJudge(() => 4);
    const result = await validateLengthDebias({
      report, samples, judgeExecutor, judgeModel: 'test-judge', bootstrapSamples: 500, seed: 7,
    });
    assert.equal(result.diffCI.significant, false);
    assert.equal(result.verdict.level, 'none');
  });

  it('flags missing samples when the report references unknown sample_ids', async () => {
    const samples: Sample[] = [sample('present', 'p', 'r')];
    const report = buildReport('v1', [
      { sample_id: 'present', output: 'o', llmScore: 4 },
      { sample_id: 'absent_from_samples', output: 'o', llmScore: 3 },
    ]);
    const judgeExecutor = makeMockJudge(() => 4);
    const result = await validateLengthDebias({
      report, samples, judgeExecutor, judgeModel: 'test-judge', bootstrapSamples: 200, seed: 1,
    });
    assert.deepEqual(result.missing, ['absent_from_samples']);
  });

  it('skips samples without judge scores (assertion-only)', async () => {
    const samples: Sample[] = [sample('s1', 'p', 'r'), sample('s2', 'p', 'r')];
    const report = buildReport('v1', [
      { sample_id: 's1', output: 'o', llmScore: 4 },
      { sample_id: 's2', output: 'o', llmScore: 0 },
    ]);
    const judgeExecutor = makeMockJudge(() => 5);
    const result = await validateLengthDebias({
      report, samples, judgeExecutor, judgeModel: 'test-judge', bootstrapSamples: 200, seed: 1,
    });
    assert.deepEqual(result.unscored, ['s2']);
    assert.equal(result.pairs.length, 1);
  });

  it('infers original lengthDebias from report.meta.debiasMode', async () => {
    const samples: Sample[] = [sample('s1', 'p', 'r')];
    const report = buildReport('v1',
      [{ sample_id: 's1', output: 'o', llmScore: 4 }],
      [], // no length in debiasMode → original was debias-off
    );
    const judgeExecutor = makeMockJudge(() => 4);
    const result = await validateLengthDebias({
      report, samples, judgeExecutor, judgeModel: 'test-judge', bootstrapSamples: 200, seed: 1,
    });
    assert.equal(result.originalLengthDebias, false);
  });

  it('throws when report has no variants', async () => {
    const samples: Sample[] = [sample('s1', 'p', 'r')];
    const report = buildReport('v1', [{ sample_id: 's1', output: 'o', llmScore: 4 }]);
    report.meta.variants = [];
    const judgeExecutor = makeMockJudge(() => 4);
    await assert.rejects(() => validateLengthDebias({
      report, samples, judgeExecutor, judgeModel: 'test-judge',
    }));
  });
});
