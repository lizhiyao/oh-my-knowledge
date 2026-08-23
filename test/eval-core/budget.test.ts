import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { executeTasks } from '../../src/eval-core/evaluation-execution.js';
import { DEFAULT_ISOLATED_CWD_DIR } from '../../src/eval-core/default-dirs.js';
import { withCapturedStderr } from '../helpers/stderr.js';
import type { Artifact, ExecutorFn, Sample, Task, VariantResult } from '../../src/types/index.js';

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

async function withoutRetryBackoff<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe('executeTasks —  budget tracker', () => {
  it('缓存开启时拒绝没有 identity 的匿名 executor', async () => {
    await assert.rejects(
      executeTasks({
        tasks: [],
        executor: makeExecutor(0),
        judgeModels: [{ executor: 'claude', model: 'j' }],
        judgeExecutors: { claude: judgeNoop },
        model: 'm',
        noJudge: true,
        samplesPath: './x.json',
        concurrency: 1,
        noCache: false,
        verbose: false,
      }),
      /requires executorName when cache is enabled/,
    );
  });

  it('把恢复成功项的历史成本计入累计总成本且不重复执行', async () => {
    const resumed: VariantResult = {
      ok: true,
      durationMs: 10,
      durationApiMs: 9,
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      execCostUSD: 0.2,
      judgeCostUSD: 0.1,
      costUSD: 0.3,
      numTurns: 1,
      outputPreview: 'ok',
    };
    let calls = 0;
    const executor: ExecutorFn = async () => {
      calls++;
      return makeExecutor(1)({
        model: 'm',
        prompt: 'unused',
      });
    };
    const resumedTask = task('resumed');
    const outcome = await executeTasks({
      tasks: [resumedTask],
      executor,
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm',
      noJudge: true,
      samplesPath: './x.json',
      concurrency: 1,
      noCache: true,
      verbose: false,
      existingResults: { resumed: { v1: resumed } },
    });
    assert.equal(calls, 0);
    assert.equal(outcome.skipped, 1);
    assert.equal(outcome.totalCostUSD, 0.3);
  });

  it('aborts remaining tasks when totalUSD cap is exceeded', async () => {
    const tasks = ['s1', 's2', 's3', 's4', 's5'].map(task);
    const exec = makeExecutor(0.4); // each task costs $0.4
    const { result: r, stderr } = await withCapturedStderr(() => executeTasks({
      tasks, executor: exec,
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm', noJudge: true,
      samplesPath: './x.json', concurrency: 1, noCache: true, verbose: false,
      budget: { totalUSD: 1 }, // budget exhausted after 3 tasks
    }));
    assert.match(stderr, /budget exhausted/);
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
      tasks, executor: exec,
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm', noJudge: true,
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
      tasks, executor: exec,
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm', noJudge: true,
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

  it('charges every retry attempt and stops retrying after a cost cap is crossed', async () => {
    let calls = 0;
    const executor: ExecutorFn = async () => {
      calls += 1;
      return {
        ok: false,
        output: null,
        durationMs: 1,
        durationApiMs: 1,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0.2,
        stopReason: 'error',
        numTurns: 1,
        error: 'retryable',
      };
    };
    const outcome = await withoutRetryBackoff(() => executeTasks({
      tasks: [task('retry-cost')],
      executor,
      executorName: 'custom-executor',
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm',
      noJudge: true,
      samplesPath: './x.json',
      concurrency: 1,
      noCache: true,
      verbose: false,
      retry: 3,
      budget: { perSampleUSD: 0.3 },
    }));
    const result = outcome.results['retry-cost'].v1;
    assert.equal(calls, 2);
    assert.equal(result.attemptCount, 2);
    assert.equal(result.execCostUSD, 0.4);
    assert.equal(result.costUSD, 0.4);
    assert.equal(outcome.totalCostUSD, 0.4);
    assert.match(result.error ?? '', /per-sample cost/);
  });

  it('keeps the successful retry output while charging all attempts', async () => {
    let calls = 0;
    const executor: ExecutorFn = async () => {
      calls += 1;
      return {
        ok: calls === 2,
        output: calls === 2 ? 'recovered' : null,
        durationMs: calls,
        durationApiMs: calls,
        inputTokens: calls,
        outputTokens: calls === 2 ? 1 : 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: calls === 1 ? 0.2 : 0.3,
        stopReason: calls === 2 ? 'end_turn' : 'error',
        numTurns: 1,
        ...(calls === 1 ? { error: 'retryable' } : {}),
      };
    };
    const outcome = await withoutRetryBackoff(() => executeTasks({
      tasks: [task('retry-success')],
      executor,
      executorName: 'custom-executor',
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm',
      noJudge: true,
      samplesPath: './x.json',
      concurrency: 1,
      noCache: true,
      verbose: false,
      retry: 1,
    }));
    const result = outcome.results['retry-success'].v1;
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.equal(result.outputPreview, 'recovered');
    assert.equal(result.attemptCount, 2);
    assert.equal(result.execCostUSD, 0.5);
    assert.equal(result.costUSD, 0.5);
    assert.equal(outcome.totalCostUSD, 0.5);
  });

  it('never resets accumulated retry cost to zero on numeric overflow', async () => {
    let calls = 0;
    const executor: ExecutorFn = async () => {
      calls += 1;
      return {
        ok: false,
        output: null,
        durationMs: 1,
        durationApiMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: Number.MAX_SAFE_INTEGER,
        stopReason: 'error',
        numTurns: 1,
        error: 'retryable',
      };
    };
    const outcome = await withoutRetryBackoff(() => executeTasks({
      tasks: [task('retry-overflow')],
      executor,
      executorName: 'custom-executor',
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm',
      noJudge: true,
      samplesPath: './x.json',
      concurrency: 1,
      noCache: true,
      verbose: false,
      retry: 1,
    }));
    const result = outcome.results['retry-overflow'].v1;
    assert.equal(calls, 2);
    assert.equal(result.execCostUSD, Number.MAX_SAFE_INTEGER);
    assert.equal(result.costReportedByExecutor, false);
    assert.equal(outcome.totalCostUSD, Number.MAX_SAFE_INTEGER);
  });

  it('flags per-sample latency overrun', async () => {
    const tasks = [task('slow')];
    const exec = makeExecutor(0.001, 100); // 100 ms exec
    const r = await executeTasks({
      tasks, executor: exec,
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm', noJudge: true,
      samplesPath: './x.json', concurrency: 1, noCache: true, verbose: false,
      budget: { perSampleMs: 30 }, // 30 ms cap → 100ms exec must trip it
    });
    const v = r.results.slow.v1;
    assert.equal(v.ok, false);
    assert.match(v.error ?? '', /per-sample latency/);
  });

  it('includes diagnostic latency in per-sample timing and budget', async () => {
    const diagnosticSample: Sample = {
      ...sample('diagnostic-slow'),
      assertions: [{ type: 'contains', value: 'required text' }],
    };
    const diagnosticTask: Task = {
      ...task(diagnosticSample.sample_id),
      assertions: diagnosticSample.assertions ?? null,
      _sample: diagnosticSample,
    };
    const diagnosticExecutor: ExecutorFn = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        output: JSON.stringify({
          summary: 'missing text',
          expected: 'include required text',
          actual: 'omitted it',
          rootCause: ['llm_misread'],
          suggestion: { skill: '', sample: '', none: '' },
        }),
        durationMs: 50,
        durationApiMs: 50,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        stopReason: 'end_turn',
        numTurns: 1,
      };
    };
    const outcome = await executeTasks({
      tasks: [diagnosticTask],
      executor: makeExecutor(0, 1),
      executorName: 'custom-executor',
      judgeModels: [{ executor: 'diagnostic', model: 'j' }],
      judgeExecutors: { diagnostic: diagnosticExecutor },
      model: 'm',
      noJudge: true,
      samplesPath: './x.json',
      concurrency: 1,
      noCache: true,
      verbose: false,
      budget: { perSampleMs: 30 },
    });
    const result = outcome.results['diagnostic-slow'].v1;
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /per-sample latency/);
    assert.ok((result.timing?.diagnosticMs ?? 0) >= 40);
    assert.equal(
      result.timing?.totalMs,
      (result.timing?.execMs ?? 0)
        + (result.timing?.gradeMs ?? 0)
        + (result.timing?.diagnosticMs ?? 0),
    );
  });

  it('omitting budget keeps legacy behavior (everything runs)', async () => {
    const tasks = ['s1', 's2', 's3'].map(task);
    const exec = makeExecutor(0.5);
    const r = await executeTasks({
      tasks, executor: exec,
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm', noJudge: true,
      samplesPath: './x.json', concurrency: 1, noCache: true, verbose: false,
    });
    assert.equal(r.budgetExhausted, false);
    assert.equal(r.skipped, 0);
    assert.equal(Object.keys(r.results).length, 3);
  });
});

describe('executeTasks — strict baseline physical isolation', () => {
  it('uses a fresh empty cwd for every task and removes it after execution', async () => {
    const strictArtifact: Artifact = {
      ...artifact,
      allowedSkills: [],
    };
    const strictTasks = ['iso-1', 'iso-2'].map((id): Task => ({
      ...task(id),
      artifact: strictArtifact,
    }));
    const observedCwds: string[] = [];
    const executor: ExecutorFn = async (input) => {
      assert.ok(input.cwd);
      assert.equal(input.cwd.startsWith(DEFAULT_ISOLATED_CWD_DIR), true);
      assert.deepEqual(readdirSync(input.cwd), []);
      observedCwds.push(input.cwd);
      writeFileSync(`${input.cwd}/attempt-state`, input.prompt);
      return {
        ok: true,
        output: 'ok',
        durationMs: 1,
        durationApiMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        stopReason: 'end_turn',
        numTurns: 1,
      };
    };

    await executeTasks({
      tasks: strictTasks,
      executor,
      judgeModels: [{ executor: 'claude', model: 'j' }],
      judgeExecutors: { claude: judgeNoop },
      model: 'm',
      noJudge: true,
      samplesPath: './x.json',
      concurrency: 2,
      noCache: true,
      verbose: false,
    });

    assert.equal(observedCwds.length, 2);
    assert.notEqual(observedCwds[0], observedCwds[1]);
    assert.equal(observedCwds.every((cwd) => !existsSync(cwd)), true);
  });
});
