import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { llmJudgeRepeat, getJudgePromptHash, llmJudgeEnsemble, computeJudgeAgreement, judgeId } from '../src/grading/judge.js';
import { grade } from '../src/grading/index.js';
import type { ExecResult, ExecutorFn, JudgeConfig, Sample } from '../src/types/index.js';

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

  it('single rubric: judge CoT reasoning is preserved on GradeResult.llmReasoning', async () => {
    const executor = makeStubJudgeExecutor([4]);
    const sample: Sample = { sample_id: 's', prompt: 'p', rubric: 'r' };
    const result = await grade({
      output: 'o', sample, executor, judgeModel: 'haiku',
    });
    // The stub returns reasoning="stub reasoning" — without the schema fix
    // this would be silently dropped between grade() and the report.
    assert.equal(result.llmReasoning, 'stub reasoning');
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

describe('judgeId', () => {
  it('formats executor:model', () => {
    assert.equal(judgeId({ executor: 'claude', model: 'opus' }), 'claude:opus');
    assert.equal(judgeId({ executor: 'openai', model: 'gpt-4o' }), 'openai:gpt-4o');
  });
});

describe('computeJudgeAgreement', () => {
  it('two judges with identical scores → meanAbsDiff=0, pearson=1 (when variance present)', () => {
    const a = computeJudgeAgreement([[3, 4, 5], [3, 4, 5]]);
    assert.equal(a.meanAbsDiff, 0);
    assert.equal(a.pearson, 1);
    assert.equal(a.pairCount, 1);
  });

  it('two judges with different scores → meanAbsDiff > 0', () => {
    const a = computeJudgeAgreement([[3, 4, 5], [4, 4, 4]]);
    // |3-4| + |4-4| + |5-4| = 2, divided by 3 ≈ 0.667
    assert.ok(Math.abs(a.meanAbsDiff - 0.667) < 0.01);
    assert.equal(a.pairCount, 1);
  });

  it('three judges → 3 pairs averaged', () => {
    const a = computeJudgeAgreement([[3, 4, 5], [3, 4, 5], [3, 4, 5]]);
    assert.equal(a.pairCount, 3);
    assert.equal(a.meanAbsDiff, 0);
  });

  it('constant scores → pearson undefined (returns omitted), MAD still computed', () => {
    const a = computeJudgeAgreement([[3, 3, 3], [3, 3, 3]]);
    assert.equal(a.pearson, undefined); // pearson is undefined when variance=0
    assert.equal(a.meanAbsDiff, 0);
  });

  it('single judge (n<2) → pairCount=0', () => {
    const a = computeJudgeAgreement([[3, 4, 5]]);
    assert.equal(a.pairCount, 0);
  });
});

describe('llmJudgeEnsemble', () => {
  it('two judges agree perfectly → consensus = mean, MAD = 0', async () => {
    const claude = makeStubJudgeExecutor([4]);
    const openai = makeStubJudgeExecutor([4]);
    const executors: Record<string, ExecutorFn> = { claude, openai };
    const judges: JudgeConfig[] = [
      { executor: 'claude', model: 'opus' },
      { executor: 'openai', model: 'gpt-4o' },
    ];
    const r = await llmJudgeEnsemble(
      { output: 'o', rubric: 'r', prompt: 'p', executor: claude, model: 'opus' },
      judges,
      (name) => executors[name],
      1,
    );
    assert.equal(r.score, 4);
    assert.equal(r.ensemble?.length, 2);
    assert.equal(r.agreement?.meanAbsDiff, 0);
    // Verify per-judge identifier format
    assert.equal(r.ensemble![0].judge, 'claude:opus');
    assert.equal(r.ensemble![1].judge, 'openai:gpt-4o');
  });

  it('two judges disagree (3 vs 5) → consensus = 4, MAD = 2', async () => {
    const claude = makeStubJudgeExecutor([3]);
    const openai = makeStubJudgeExecutor([5]);
    const executors: Record<string, ExecutorFn> = { claude, openai };
    const judges: JudgeConfig[] = [
      { executor: 'claude', model: 'opus' },
      { executor: 'openai', model: 'gpt-4o' },
    ];
    const r = await llmJudgeEnsemble(
      { output: 'o', rubric: 'r', prompt: 'p', executor: claude, model: 'opus' },
      judges,
      (name) => executors[name],
      1,
    );
    assert.equal(r.score, 4);  // (3+5)/2
    assert.equal(r.agreement?.meanAbsDiff, 2);
    assert.equal(r.ensemble![0].score, 3);
    assert.equal(r.ensemble![1].score, 5);
  });

  it('ensemble + judge-repeat: each judge has its own scoreStddev', async () => {
    const claude = makeStubJudgeExecutor([3, 4, 5]);  // mean 4, stddev 1
    const openai = makeStubJudgeExecutor([4, 4, 4]);  // mean 4, stddev 0
    const executors: Record<string, ExecutorFn> = { claude, openai };
    const judges: JudgeConfig[] = [
      { executor: 'claude', model: 'opus' },
      { executor: 'openai', model: 'gpt-4o' },
    ];
    const r = await llmJudgeEnsemble(
      { output: 'o', rubric: 'r', prompt: 'p', executor: claude, model: 'opus' },
      judges,
      (name) => executors[name],
      3,
    );
    assert.equal(r.score, 4);  // both judges mean 4
    assert.equal(r.ensemble![0].scoreStddev, 1);  // claude variable
    assert.equal(r.ensemble![1].scoreStddev, 0);  // openai constant
    assert.equal(r.agreement?.meanAbsDiff, 0);  // mean scores agree
  });

  it('single judge in array → falls back to llmJudgeRepeat (degenerate ensemble)', async () => {
    const claude = makeStubJudgeExecutor([4]);
    const executors: Record<string, ExecutorFn> = { claude };
    const judges: JudgeConfig[] = [{ executor: 'claude', model: 'opus' }];
    const r = await llmJudgeEnsemble(
      { output: 'o', rubric: 'r', prompt: 'p', executor: claude, model: 'opus' },
      judges,
      (name) => executors[name],
      1,
    );
    assert.equal(r.score, 4);
    // Single judge falls through to non-ensemble path so no ensemble field
    assert.equal(r.ensemble, undefined);
    assert.equal(r.agreement, undefined);
  });

  it('ensemble cost = sum of all judge calls', async () => {
    const claude = makeStubJudgeExecutor([4]);
    const openai = makeStubJudgeExecutor([4]);
    const executors: Record<string, ExecutorFn> = { claude, openai };
    const judges: JudgeConfig[] = [
      { executor: 'claude', model: 'opus' },
      { executor: 'openai', model: 'gpt-4o' },
    ];
    const r = await llmJudgeEnsemble(
      { output: 'o', rubric: 'r', prompt: 'p', executor: claude, model: 'opus' },
      judges,
      (name) => executors[name],
      1,
    );
    // Each stub call costs 0.001, 2 judges × 1 repeat = 0.002
    assert.ok(r.judgeCostUSD !== undefined && Math.abs(r.judgeCostUSD - 0.002) < 1e-9);
  });
});

describe('grade with ensemble (judgeModels >= 2)', () => {
  it('single rubric + ensemble → llmEnsemble + llmAgreement populated', async () => {
    const claude = makeStubJudgeExecutor([3]);
    const openai = makeStubJudgeExecutor([5]);
    const executors: Record<string, ExecutorFn> = { claude, openai };
    const sample: Sample = { sample_id: 's', prompt: 'p', rubric: 'r' };
    const result = await grade({
      output: 'o',
      sample,
      executor: claude,  // legacy single executor (still required by grade signature)
      judgeModel: 'opus',
      judgeModels: [
        { executor: 'claude', model: 'opus' },
        { executor: 'openai', model: 'gpt-4o' },
      ],
      judgeExecutors: executors,
    });
    assert.equal(result.llmScore, 4);  // consensus (3+5)/2
    assert.equal(result.llmEnsemble?.length, 2);
    assert.equal(result.llmAgreement?.meanAbsDiff, 2);
  });

  it('multi-dim + ensemble → each dim has its own ensemble/agreement', async () => {
    // 2 dims × 2 judges = 4 calls
    const claude = makeStubJudgeExecutor([4, 5]);  // dim1=4, dim2=5
    const openai = makeStubJudgeExecutor([3, 4]);  // dim1=3, dim2=4
    const executors: Record<string, ExecutorFn> = { claude, openai };
    const sample: Sample = {
      sample_id: 's', prompt: 'p',
      dimensions: { correctness: 'r1', clarity: 'r2' },
    };
    const result = await grade({
      output: 'o',
      sample,
      executor: claude,
      judgeModel: 'opus',
      judgeModels: [
        { executor: 'claude', model: 'opus' },
        { executor: 'openai', model: 'gpt-4o' },
      ],
      judgeExecutors: executors,
    });
    assert.ok(result.dimensions);
    const correctness = result.dimensions!.correctness;
    const clarity = result.dimensions!.clarity;
    assert.equal(correctness.ensemble?.length, 2);
    assert.equal(clarity.ensemble?.length, 2);
    assert.equal(correctness.score, 3.5);  // (4+3)/2
    assert.equal(clarity.score, 4.5);  // (5+4)/2
  });
});
