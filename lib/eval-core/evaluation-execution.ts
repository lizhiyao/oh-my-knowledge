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

interface ExecuteTasksOptions {
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
}: ExecuteTasksOptions): Promise<{ results: Record<string, Record<string, VariantResult>>; totalCostUSD: number }> {
  const results: Record<string, Record<string, VariantResult>> = {};
  let started = 0;
  let completed = 0;
  let totalCostUSD = 0;

  const cacheDir = join(homedir(), '.oh-my-knowledge', 'cache');
  const cache: ExecutorCache | null = noCache ? null : createCache(cacheDir);

  async function executeTask(task: Task): Promise<void> {
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
      execResult = await executor(executionPlan.input);
      if (cache && execResult.ok) cache.set(key, execResult);
    }
    const execMs = Date.now() - execStart;
    totalCostUSD += execResult.costUSD;

    if (verbose && onProgress) {
      onProgress({
        phase: 'exec_done',
        strategy: executionPlan.strategy,
        completed: idx,
        total,
        sample_id: task.sample_id,
        variant: task.variant,
        durationMs: execResult.durationMs,
        inputTokens: execResult.inputTokens,
        outputTokens: execResult.outputTokens,
        costUSD: execResult.costUSD,
        outputPreview: execResult.output ? execResult.output.slice(0, 200) : null,
      });
    }

    let gradeResult: GradeResult | null = null;
    let gradeMs = 0;
    if (execResult.ok && !noJudge) {
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
        gradeResult = await grade({
          output: execResult.output!,
          sample: task._sample,
          executor: judgeExecutor,
          judgeModel,
          execMetrics: {
            costUSD: execResult.costUSD,
            durationMs: execResult.durationMs,
            numTurns: execResult.numTurns,
            toolCalls: execResult.toolCalls,
            turns: execResult.turns,
          },
          samplesDir: dirname(resolve(samplesPath)),
        });
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
      durationMs: execResult.durationMs,
      inputTokens: execResult.inputTokens,
      outputTokens: execResult.outputTokens,
      costUSD: execResult.costUSD,
      score: gradeResult?.compositeScore,
    });

    let factCheck: FactCheckResult | undefined;
    if (execResult.ok && execResult.output && task.cwd) {
      factCheck = checkFacts(execResult.output, resolve(task.cwd));
    }

    if (!results[task.sample_id]) results[task.sample_id] = {};
    results[task.sample_id][task.variant] = buildVariantResult(execResult, gradeResult, { execMs, gradeMs, factCheck });
  }

  try {
    await runWithConcurrency(tasks, concurrency, executeTask);
  } finally {
    if (cache) cache.save();
  }

  return { results, totalCostUSD };
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
