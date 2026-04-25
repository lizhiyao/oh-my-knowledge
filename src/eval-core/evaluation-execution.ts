import { createCache, cacheKey } from './cache.js';
import { buildVariantResult } from './schema.js';
import { grade } from '../grading/index.js';
import { checkFacts } from './fact-checker.js';
import type { FactCheckResult } from './fact-checker.js';
import { resolveExecutionStrategy } from './execution-strategy.js';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type {
  ExecResult,
  ExecutorFn,
  ExecutorCache,
  GradeResult,
  ProgressCallback,
  Task,
  VariantResult,
} from '../types.js';

export interface ExecuteTasksOptions {
  tasks: Task[];
  executor: ExecutorFn;
  judgeExecutor: ExecutorFn;
  model: string;
  judgeModel: string;
  noJudge: boolean;
  samplesPath: string;
  concurrency: number;
  timeoutMs?: number;
  noCache: boolean;
  verbose: boolean;
  onProgress?: ProgressCallback | null;
  /** Max retries per task on failure (default 0 = no retry) */
  retry?: number;
  /** Pre-loaded results to skip (for --resume) */
  existingResults?: Record<string, Record<string, VariantResult>>;
  /** Number of times to call the LLM judge per (sample × dimension); default 1. */
  judgeRepeat?: number;
  /** Multi-judge ensemble configs (≥ 2 entries triggers ensemble mode). */
  judgeModels?: import('../types.js').JudgeConfig[];
  /** Pre-built executor map for ensemble: executor name → ExecutorFn. */
  judgeExecutors?: Record<string, ExecutorFn>;
  /** v0.21 length-debias toggle. Default true; CLI's --no-debias-length sets it false. */
  lengthDebias?: boolean;
  /** v0.22 — hard budget caps. When totalUSD is exceeded mid-run, remaining
   *  tasks are skipped and the partial result set is returned with
   *  budgetExhausted: true. Per-sample caps don't abort but mark offending
   *  tasks as failed. */
  budget?: import('../types.js').EvalBudget;
}

async function runWithConcurrency<T>(tasks: T[], concurrency: number, fn: (task: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      await fn(tasks[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
}

function makeErrorResult(error: unknown): ExecResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    output: null,
    durationMs: 0,
    durationApiMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    stopReason: 'error',
    numTurns: 0,
    error: message,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeTasks({
  tasks,
  executor,
  judgeExecutor,
  model,
  judgeModel,
  noJudge,
  samplesPath,
  concurrency,
  timeoutMs,
  noCache,
  verbose,
  onProgress,
  retry = 0,
  existingResults,
  judgeRepeat = 1,
  judgeModels,
  judgeExecutors,
  lengthDebias = true,
  budget,
}: ExecuteTasksOptions): Promise<{ results: Record<string, Record<string, VariantResult>>; totalCostUSD: number; skipped: number; budgetExhausted: boolean }> {
  const results: Record<string, Record<string, VariantResult>> = {};
  let started = 0;
  let completed = 0;
  let skipped = 0;
  let totalCostUSD = 0;
  let budgetExhausted = false;

  // Seed results from previous run (--resume)
  if (existingResults) {
    for (const [sampleId, variants] of Object.entries(existingResults)) {
      results[sampleId] = { ...variants };
    }
  }

  const cacheDir = join(homedir(), '.oh-my-knowledge', 'cache');
  const cache: ExecutorCache | null = noCache ? null : createCache(cacheDir);

  async function executeTask(task: Task): Promise<void> {
    // Skip if already have a successful result (--resume)
    if (existingResults?.[task.sample_id]?.[task.variant]?.ok) {
      skipped++;
      started++;
      completed++;
      onProgress?.({ phase: 'done', completed, total: tasks.length, sample_id: task.sample_id, variant: task.variant, skipped: true });
      return;
    }

    // v0.22 budget abort: if a previous task tripped the total-USD cap, skip
    // remaining tasks. The partial report is still persisted so the user sees
    // what completed before the run stopped.
    if (budgetExhausted) {
      skipped++;
      started++;
      completed++;
      onProgress?.({ phase: 'done', completed, total: tasks.length, sample_id: task.sample_id, variant: task.variant, skipped: true });
      return;
    }

    started++;
    const idx = started;
    const total = tasks.length;
    onProgress?.({ phase: 'start', completed: idx, total, sample_id: task.sample_id, variant: task.variant });

    const executionPlan = resolveExecutionStrategy(task, model, timeoutMs, verbose);

    let execResult: ExecResult;
    const key = cacheKey(model, executionPlan.cacheSystem, executionPlan.input.prompt, executionPlan.input.cwd);
    const cached = cache?.get(key);
    const execStart = Date.now();
    if (cached) {
      execResult = { ...cached, cached: true };
    } else {
      // Execute with retry on failure
      const maxAttempts = 1 + Math.max(0, retry);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          execResult = await executor(executionPlan.input);
        } catch (err) {
          execResult = makeErrorResult(err);
        }
        if (execResult!.ok || attempt === maxAttempts) break;
        // Exponential backoff before retry
        const backoffMs = Math.min(2 ** (attempt - 1) * 1000, 30000);
        onProgress?.({ phase: 'retry', completed: idx, total, sample_id: task.sample_id, variant: task.variant, attempt, maxAttempts });
        await sleep(backoffMs);
      }
      if (cache && execResult!.ok) cache.set(key, execResult!);
    }
    const execMs = Date.now() - execStart;
    totalCostUSD += execResult!.costUSD;

    if (verbose && onProgress) {
      onProgress({
        phase: 'exec_done',
        strategy: executionPlan.strategy,
        completed: idx,
        total,
        sample_id: task.sample_id,
        variant: task.variant,
        durationMs: execResult!.durationMs,
        inputTokens: execResult!.inputTokens,
        outputTokens: execResult!.outputTokens,
        costUSD: execResult!.costUSD,
        outputPreview: execResult!.output ? execResult!.output.slice(0, 200) : null,
      });
    }

    let gradeResult: GradeResult | null = null;
    let gradeMs = 0;
    if (execResult!.ok) {
      const hasGradingCriteria = task.rubric || task.assertions?.length || (task.dimensions && Object.keys(task.dimensions).length);
      if (hasGradingCriteria) {
        if (verbose && onProgress) {
          onProgress({
            phase: 'grading',
            strategy: executionPlan.strategy,
            completed: idx,
            total,
            sample_id: task.sample_id,
            variant: task.variant,
          });
        }
        const gradeStart = Date.now();
        try {
          gradeResult = await grade({
            output: execResult!.output!,
            sample: task._sample,
            executor: judgeExecutor,
            judgeModel,
            allowLlmJudge: !noJudge,
            execMetrics: {
              costUSD: execResult!.costUSD,
              durationMs: execResult!.durationMs,
              numTurns: execResult!.numTurns,
              toolCalls: execResult!.toolCalls,
              turns: execResult!.turns,
            },
            samplesDir: dirname(resolve(samplesPath)),
            judgeRepeat,
            judgeModels,
            judgeExecutors,
            lengthDebias,
          });
        } catch (err) {
          gradeResult = { compositeScore: 0 };
          const msg = err instanceof Error ? err.message : String(err);
          onProgress?.({ phase: 'error', completed: idx, total, sample_id: task.sample_id, variant: task.variant, error: `评分失败: ${msg}` });
        }
        gradeMs = Date.now() - gradeStart;
        if (gradeResult.judgeCostUSD) totalCostUSD += gradeResult.judgeCostUSD;
      }
    }

    completed++;
    onProgress?.({
      phase: 'done',
      strategy: executionPlan.strategy,
      completed,
      total,
      sample_id: task.sample_id,
      variant: task.variant,
      durationMs: execResult!.durationMs,
      inputTokens: execResult!.inputTokens,
      outputTokens: execResult!.outputTokens,
      costUSD: execResult!.costUSD,
      score: gradeResult?.compositeScore,
    });

    let factCheck: FactCheckResult | undefined;
    if (execResult!.ok && execResult!.output && task.cwd) {
      factCheck = checkFacts(execResult!.output, resolve(task.cwd));
    }

    if (!results[task.sample_id]) results[task.sample_id] = {};
    const variantResult = buildVariantResult(execResult!, gradeResult, { execMs, gradeMs, factCheck });

    // v0.22 per-sample budget enforcement. If a sample's cost or latency
    // exceeds the per-sample cap, the result is kept (so the user can see
    // what happened) but flagged as a budget overrun. The run continues.
    if (budget?.perSampleUSD != null && variantResult.costUSD > budget.perSampleUSD) {
      variantResult.ok = false;
      variantResult.error = `budget overrun: per-sample cost $${variantResult.costUSD.toFixed(4)} > cap $${budget.perSampleUSD.toFixed(4)}`;
    }
    if (budget?.perSampleMs != null && (execMs + (gradeMs ?? 0)) > budget.perSampleMs) {
      variantResult.ok = false;
      variantResult.error = `budget overrun: per-sample latency ${execMs + (gradeMs ?? 0)}ms > cap ${budget.perSampleMs}ms`;
    }
    results[task.sample_id][task.variant] = variantResult;

    // v0.22 total-USD budget enforcement. Once the global cap is exceeded,
    // flip the abort flag so subsequent tasks short-circuit. The current task
    // is kept (already paid for it).
    if (budget?.totalUSD != null && totalCostUSD > budget.totalUSD && !budgetExhausted) {
      budgetExhausted = true;
      process.stderr.write(`\n⚠ budget exhausted: cumulative cost $${totalCostUSD.toFixed(4)} exceeded cap $${budget.totalUSD.toFixed(4)}; remaining ${tasks.length - started} tasks will be skipped.\n`);
    }
  }

  try {
    await runWithConcurrency(tasks, concurrency, executeTask);
  } finally {
    if (cache) cache.save();
  }

  return { results, totalCostUSD, skipped, budgetExhausted };
}

export async function preflight(executor: ExecutorFn, model: string, timeoutMs: number = 15000): Promise<void> {
  const result = await executor({
    model,
    system: '',
    prompt: 'hi',
    cwd: process.cwd(),
    timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`预检失败 [${model}]: ${result.error}`);
  }
}
