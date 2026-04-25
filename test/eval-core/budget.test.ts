import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { executeTasks } from '../../src/eval-core/evaluation-execution.js';
import type { Artifact, ExecutorFn, Sample, Task } from '../../src/types.js';

const sample = (id: string): Sample => ({
  sample_id: id, prompt: `prompt for ${id}`,
});

const artifact: Artifact = { name: 'baseline', kind: 'baseline', source: 'baseline', content: null };

const task = (id: string): Task => ({
  sample_id: id, variant: 'v1', artifact,
  prompt: `prompt for ${id}`,
  rubric: null, assertions: null, dimensions: null, artifactContent: null, cwd: null,
  _sample: sample(id),
});

const judgeNoop: ExecutorFn = async () => ({
  ok: true, output: '', durationMs: 1, durationApiMs: 1,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUSD: 0, stopReason: 'end_turn', numTurns: 1,
});

const makeExecutor = (perCallCost: number, perCallMs = 10): ExecutorFn => async () => {
  // Actual sleep so wall-clock execMs matches the budget tracker's measurement.
  await new Promise<void>((r) => setTimeout(r, perCallMs));
  return {
    ok: true,
    output: 'ok',
    durationMs: perCallMs, durationApiMs: perCallMs,
    inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: perCallCost, stopReason: 'end_turn', numTurns: 1,
  };
};

describe('executeTasks — v0.22 budget tracker', () => {
  it('aborts remaining tasks when totalUSD cap is exceeded', async () => {
    const tasks = ['s1', 's2', 's3', 's4', 's5'].map(task);
    const exec = makeExecutor(0.4); // each task costs $0.4
    const r = await executeTasks({
      tasks, executor: exec, judgeExecutor: judgeNoop,
      model: 'm', judgeModel: 'j', noJudge: true,
      samplesPath: './x.json', concurrency: 1, noCache: true, verbose: false,
      budget: { totalUSD: 1 }, // budget exhausted after 3 tasks
    });
    assert.equal(r.budgetExhausted, true);
    // We don't pin the exact count — concurrency timing means the abort can
    // happen anywhere from task 3 onward — but we do require:
    //  (a) at least one task ran (totalCost > 0)
    //  (b) at least one task was skipped (skipped > 0)
    //  (c) total cost stays bounded (budget catches before runaway)
    assert.ok(r.totalCostUSD > 0, `expected some cost, got $${r.totalCostUSD}`);
    assert.ok(r.skipped > 0, 'expected at least one skipped task after abort');
    assert.ok(r.totalCostUSD < 5 * 0.4, 'budget should prevent all 5 tasks from running');
  });

  it('does not abort when totalUSD cap is not reached', async () => {
    const tasks = ['s1', 's2'].map(task);
    const exec = makeExecutor(0.1);
    const r = await executeTasks({
      tasks, executor: exec, judgeExecutor: judgeNoop,
      model: 'm', judgeModel: 'j', noJudge: true,
      samplesPath: './x.json', concurrency: 1, noCache: true, verbose: false,
      budget: { totalUSD: 5 },
    });
    assert.equal(r.budgetExhausted, false);
    assert.equal(r.skipped, 0);
  });

  it('flags per-sample USD overrun without aborting the run', async () => {
    const tasks = ['s1', 's2'].map(task);
    const exec = makeExecutor(0.5); // exceeds perSampleUSD cap of 0.3
    const r = await executeTasks({
      tasks, executor: exec, judgeExecutor: judgeNoop,
      model: 'm', judgeModel: 'j', noJudge: true,
      samplesPath: './x.json', concurrency: 1, noCache: true, verbose: false,
      budget: { perSampleUSD: 0.3 },
    });
    assert.equal(r.budgetExhausted, false);
    // Both samples ran but each is flagged.
    for (const s of ['s1', 's2']) {
      const v = r.results[s]?.v1;
      assert.ok(v, `expected result for ${s}`);
      assert.equal(v.ok, false, `${s} should be marked failed by per-sample overrun`);
      assert.match(v.error ?? '', /per-sample cost/, `${s} error: ${v.error}`);
    }
  });

  it('flags per-sample latency overrun', async () => {
    const tasks = [task('slow')];
    const exec = makeExecutor(0.001, 100); // 100 ms exec
    const r = await executeTasks({
      tasks, executor: exec, judgeExecutor: judgeNoop,
      model: 'm', judgeModel: 'j', noJudge: true,
      samplesPath: './x.json', concurrency: 1, noCache: true, verbose: false,
      budget: { perSampleMs: 30 }, // 30 ms cap → 100ms exec must trip it
    });
    const v = r.results.slow.v1;
    assert.equal(v.ok, false);
    assert.match(v.error ?? '', /per-sample latency/);
  });

  it('omitting budget keeps legacy behavior (everything runs)', async () => {
    const tasks = ['s1', 's2', 's3'].map(task);
    const exec = makeExecutor(0.5);
    const r = await executeTasks({
      tasks, executor: exec, judgeExecutor: judgeNoop,
      model: 'm', judgeModel: 'j', noJudge: true,
      samplesPath: './x.json', concurrency: 1, noCache: true, verbose: false,
    });
    assert.equal(r.budgetExhausted, false);
    assert.equal(r.skipped, 0);
    assert.equal(Object.keys(r.results).length, 3);
  });
});
