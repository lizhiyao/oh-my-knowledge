import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { llmJudgeRepeat, getJudgePromptHash } from '../src/grading/judge.js';
import { grade } from '../src/grading/index.js';
import type { ExecResult, ExecutorFn, Sample } from '../src/types.js';

/**
 * Build an executor that returns a different score on each call, cycled from `scores`.
 * Lets us simulate judge instability.
 */
function makeStubJudgeExecutor(scores: number[]): ExecutorFn {
  let i = 0;
  return async () => {
    const s = scores[i % scores.length];
    i++;
    return {
      ok: true,
      output: JSON.stringify({ reasoning: 'stub reasoning', score: s, reason: `score ${s}` }),
      durationMs: 10,
      durationApiMs: 10,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD: 0.001,
      stopReason: 'end_turn',
      numTurns: 1,
    } satisfies ExecResult;
  };
}

describe('getJudgePromptHash', () => {
  it('returns a 12-char hex hash', () => {
    const h = getJudgePromptHash();
    assert.match(h, /^[0-9a-f]{12}$/);
  });

  it('is stable across calls (same template → same hash)', () => {
    const a = getJudgePromptHash();
    const b = getJudgePromptHash();
    assert.equal(a, b);
  });
});

describe('llmJudgeRepeat', () => {
  it('repeat=1: equivalent to single judge, scoreSamples=[score], stddev=0', async () => {
    const executor = makeStubJudgeExecutor([4]);
    const r = await llmJudgeRepeat({
      output: 'some output', rubric: 'some rubric', prompt: 'task', executor, model: 'haiku',
    }, 1);
    assert.equal(r.score, 4);
    assert.deepEqual(r.scoreSamples, [4]);
    assert.equal(r.scoreStddev, 0);
  });

  it('repeat=3 with same score every call → stddev=0, mean=score', async () => {
    const executor = makeStubJudgeExecutor([4, 4, 4]);
    const r = await llmJudgeRepeat({
      output: 'o', rubric: 'r', prompt: 'p', executor, model: 'haiku',
    }, 3);
    assert.equal(r.score, 4);
    assert.deepEqual(r.scoreSamples, [4, 4, 4]);
    assert.equal(r.scoreStddev, 0);
  });

  it('repeat=3 with mixed scores → stddev > 0, mean reflects average', async () => {
    const executor = makeStubJudgeExecutor([3, 5, 4]);
    const r = await llmJudgeRepeat({
      output: 'o', rubric: 'r', prompt: 'p', executor, model: 'haiku',
    }, 3);
    assert.equal(r.score, 4);  // (3+5+4)/3 = 4.00
    assert.deepEqual(r.scoreSamples, [3, 5, 4]);
    assert.ok(r.scoreStddev !== undefined && r.scoreStddev > 0, 'stddev should be > 0 when scores vary');
    // sample stddev of [3,5,4] = sqrt(sum((x - 4)^2) / (n-1)) = sqrt(2/2) = 1
    assert.equal(r.scoreStddev, 1);
  });

  it('repeat=3: judgeCostUSD is summed across all calls', async () => {
    const executor = makeStubJudgeExecutor([3, 4, 5]);
    const r = await llmJudgeRepeat({
      output: 'o', rubric: 'r', prompt: 'p', executor, model: 'haiku',
    }, 3);
    // each stub call costs 0.001, so 3 calls = 0.003
    assert.ok(r.judgeCostUSD !== undefined && Math.abs(r.judgeCostUSD - 0.003) < 1e-9);
  });

  it('captures CoT reasoning from the first call', async () => {
    const executor = makeStubJudgeExecutor([4, 5, 4]);
    const r = await llmJudgeRepeat({
      output: 'o', rubric: 'r', prompt: 'p', executor, model: 'haiku',
    }, 3);
    assert.equal(r.reasoning, 'stub reasoning');
  });

  it('judgeFailureCount=0 when all N calls succeed', async () => {
    const executor = makeStubJudgeExecutor([4, 5, 3]);
    const r = await llmJudgeRepeat({
      output: 'o', rubric: 'r', prompt: 'p', executor, model: 'haiku',
    }, 3);
    assert.equal(r.judgeFailureCount, 0);
  });

  it('judgeFailureCount counts score=0 calls; stddev only over successful samples', async () => {
    // 3 calls: [0, 0, 4] — 2 failures, 1 success. mean over success = 4, stddev = 0
    // (only one successful sample). judgeFailureCount = 2 disambiguates.
    const executor = makeStubJudgeExecutor([0, 0, 4]);
    const r = await llmJudgeRepeat({
      output: 'o', rubric: 'r', prompt: 'p', executor, model: 'haiku',
    }, 3);
    assert.equal(r.judgeFailureCount, 2);
    assert.equal(r.scoreSamples?.length, 3);
    assert.deepEqual(r.scoreSamples, [0, 0, 4]);
    // mean and stddev should reflect only the successful sample
    assert.equal(r.score, 4);
    assert.equal(r.scoreStddev, 0);
  });

  it('library accepts repeat=0 / negative defensively (clamped to 1)', async () => {
    const executor = makeStubJudgeExecutor([4]);
    const r = await llmJudgeRepeat({
      output: 'o', rubric: 'r', prompt: 'p', executor, model: 'haiku',
    }, 0);
    assert.equal(r.score, 4);
    assert.deepEqual(r.scoreSamples, [4]);
  });
});

describe('grade with judgeRepeat', () => {
  it('single rubric, judgeRepeat=3 → llmScoreSamples + llmScoreStddev populated', async () => {
    const executor = makeStubJudgeExecutor([3, 5, 4]);
    const sample: Sample = {
      sample_id: 's1',
      prompt: 'do thing',
      rubric: 'is it good?',
    };
    const result = await grade({
      output: 'an output',
      sample,
      executor,
      judgeModel: 'haiku',
      judgeRepeat: 3,
    });
    assert.deepEqual(result.llmScoreSamples, [3, 5, 4]);
    assert.equal(result.llmScoreStddev, 1);
    assert.equal(result.llmScore, 4);  // mean of [3,5,4]
  });

  it('single rubric, judgeRepeat=1 (default) → llmScoreSamples / Stddev not set', async () => {
    const executor = makeStubJudgeExecutor([4]);
    const sample: Sample = {
      sample_id: 's2',
      prompt: 'task',
      rubric: 'rubric',
    };
    const result = await grade({
      output: 'output',
      sample,
      executor,
      judgeModel: 'haiku',
    });
    assert.equal(result.llmScore, 4);
    assert.equal(result.llmScoreSamples, undefined);
    assert.equal(result.llmScoreStddev, undefined);
  });

  it('multi-dimensional, judgeRepeat=2 → each dim has scoreSamples + scoreStddev', async () => {
    // Two dimensions × 2 repeats = 4 calls
    const executor = makeStubJudgeExecutor([3, 5, 2, 4]);
    const sample: Sample = {
      sample_id: 's3',
      prompt: 'task',
      dimensions: { correctness: 'is it correct?', clarity: 'is it clear?' },
    };
    const result = await grade({
      output: 'output',
      sample,
      executor,
      judgeModel: 'haiku',
      judgeRepeat: 2,
    });
    assert.ok(result.dimensions);
    const dims = Object.values(result.dimensions);
    assert.equal(dims.length, 2);
    for (const dim of dims) {
      assert.equal(dim.scoreSamples?.length, 2);
      assert.ok(dim.scoreStddev !== undefined && dim.scoreStddev >= 0);
    }
  });
});
