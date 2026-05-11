import { createCache, cacheKey } from './cache.js';
import { buildVariantResult } from './schema.js';
import { safeSliceForJson } from '../util/safe-slice.js';
import { grade } from '../grading/index.js';
import { checkFacts } from './fact-checker.js';
import type { FactCheckResult } from './fact-checker.js';
import { resolveExecutionStrategy } from './execution-strategy.js';
import { getExecutorRuntimeFingerprint } from '../executors/runtime-fingerprint.js';
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
} from '../types/index.js';

export interface ExecuteTasksOptions {
  tasks: Task[];
  executor: ExecutorFn;
  /** Executor name (e.g. 'claude' / 'codex' / 'openai-api'). Used in cache key
   *  to prevent cross-executor pollution when same model name is used. */
  executorName?: string;
  model: string;
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
  /** Unified judge config — always non-empty. `length === 1` runs single-judge
   *  quick path; `length >= 2` runs ensemble + agreement metrics. */
  judgeModels: import('../types/index.js').JudgeConfig[];
  /** Pre-built executor map covering every executor referenced in `judgeModels`.
   *  Pipeline must populate this before calling executeTasks. */
  judgeExecutors: Record<string, ExecutorFn>;
  /** v0.21 length-debias toggle. Default true; CLI's --no-debias-length sets it false. */
  lengthDebias?: boolean;
  /** hard budget caps. When totalUSD is exceeded mid-run, remaining
   *  tasks are skipped and the partial result set is returned with
   *  budgetExhausted: true. Per-sample caps don't abort but mark offending
   *  tasks as failed. */
  budget?: import('../types/index.js').EvalBudget;
  /** Reasoning effort for executor LLM。透传到 ExecutorInput.effort,
   *  默认 'low'(在 parseRunConfig 兜底)。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 关闭 diagnostic LLM call。Default false。失败用例(任意 assertion fail)
   *  默认会跑 diagnostic 给"哪错了 + 怎么改 skill"建议。跟 noJudge 完全独立。 */
  noDiagnostic?: boolean;
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
  executorName,
  model,
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
  effort,
  noDiagnostic = false,
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

    //  budget abort: if a previous task tripped the total-USD cap, skip
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

    const executionPlan = resolveExecutionStrategy(task, model, timeoutMs, verbose, effort);
    const effectiveExecutorName = executorName || 'claude';
    const executorRuntime = getExecutorRuntimeFingerprint(effectiveExecutorName, model, {
      skillDir: executionPlan.input.skillDir,
    });

    let execResult: ExecResult;
    // include allowedSkills in cache key so isolation-on / isolation-off runs
    // don't share cache entries, and include runtime fingerprint so a binary/SDK bump
    // cannot replay old-runtime outputs under new-runtime report metadata.
    // 同时把 mocks + mocksStrict 进 key:改 mock 配置必须重跑,不能命中老 cache。
    const key = cacheKey(
      model,
      executionPlan.cacheSystem,
      executionPlan.input.prompt,
      executionPlan.input.cwd,
      task.artifact.allowedSkills,
      effectiveExecutorName,
      executorRuntime.fingerprint,
      executionPlan.input.mocks,
      executionPlan.input.mocksStrict,
      effort,
    );
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
        outputPreview: execResult!.output ? safeSliceForJson(execResult!.output, 200, '') : null,
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
            judgeModels,
            judgeExecutors,
            allowLlmJudge: !noJudge,
            execMetrics: {
              costUSD: execResult!.costUSD,
              durationMs: execResult!.durationMs,
              numTurns: execResult!.numTurns,
              toolCalls: execResult!.toolCalls,
              turns: execResult!.turns,
              mockStats: execResult!.mockStats,
            },
            samplesDir: dirname(resolve(samplesPath)),
            judgeRepeat,
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

    let factCheck: FactCheckResult | undefined;
    if (execResult!.ok && execResult!.output && task.cwd) {
      factCheck = checkFacts(execResult!.output, resolve(task.cwd));
    }

    if (!results[task.sample_id]) results[task.sample_id] = {};
    const variantResult = buildVariantResult(execResult!, gradeResult, { execMs, gradeMs, factCheck });

    // Diagnostic — 与 judge 完全独立的"哪错了 + skill 怎么改"诊断。
    // 触发条件:noDiagnostic=false + 至少 1 条 assertion fail + sample 跑成功(有 fullOutput)。
    //
    // executor / model 选择:
    //   - 优先用 judgeExecutors['claude'](已初始化好) + 'haiku' 模型 — 最便宜的标配。
    //   - 用户没配 claude judge(只配了 openai / gemini 等)时,沿用第一个 judge 的
    //     executor + 它对应的 model 名。硬写 'haiku' 会导致非 claude executor 拒绝
    //     (model not found),诊断整段挂掉。
    //   - 实在没有 judge executor 配置时回退主 executor(虽然不是 lean 也能跑)。
    const failedDetails = (gradeResult?.assertions?.details || []).filter((d) => !d.passed);
    const shouldDiagnose = !noDiagnostic && execResult!.ok && failedDetails.length > 0;
    if (shouldDiagnose) {
      try {
        const { runDiagnostic } = await import('../grading/diagnostic.js');
        const claudeJudgeName = Object.keys(judgeExecutors).find((name) => name === 'claude');
        const firstJudgeName = Object.keys(judgeExecutors)[0];
        const diagExecutorName = claudeJudgeName || firstJudgeName;
        const diagExecutor = diagExecutorName ? judgeExecutors[diagExecutorName] : executor;
        // 模型选择:claude executor 走 'haiku' 标配;非 claude executor 沿用它在
        // judgeModels 里配的 model(用户已经验证可用)。
        let diagModel = 'haiku';
        if (diagExecutorName && diagExecutorName !== 'claude') {
          const judgeEntry = judgeModels.find((j) => j.executor === diagExecutorName);
          if (judgeEntry) diagModel = judgeEntry.model;
        }
        const diagnostic = await runDiagnostic({
          sample: task._sample,
          skillContent: task.artifact.content || null,
          skillName: task.artifact.name || task.variant,
          toolCalls: execResult!.toolCalls,
          turns: execResult!.turns,
          fullOutput: execResult!.output || undefined,
          assertionDetails: gradeResult?.assertions?.details || [],
          executor: diagExecutor,
          model: diagModel,
        });
        variantResult.diagnostic = diagnostic;
        if (diagnostic.costUSD) totalCostUSD += diagnostic.costUSD;
      } catch (err) {
        // diagnostic 失败不影响主评测,降级成 minimal 错误对象
        const msg = err instanceof Error ? err.message : String(err);
        variantResult.diagnostic = {
          ok: false,
          error: msg,
          summary: '',
          expected: '',
          actual: '',
          rootCause: [],
          suggestion: { skill: '', sample: '', none: '' },
        };
      }
    }

    //  per-sample budget enforcement. If a sample's cost or latency
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

    completed++;
    onProgress?.({
      phase: 'done',
      strategy: executionPlan.strategy,
      completed,
      total,
      sample_id: task.sample_id,
      variant: task.variant,
      durationMs: variantResult.durationMs,
      inputTokens: variantResult.inputTokens,
      outputTokens: variantResult.outputTokens,
      costUSD: variantResult.execCostUSD,
      score: gradeResult?.compositeScore,
      ok: variantResult.ok,
      error: variantResult.error,
    });

    //  total-USD budget enforcement. Once the global cap is exceeded,
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

export async function preflight(executor: ExecutorFn, model: string, timeoutMs: number = 180000): Promise<void> {
  const result = await executor({
    model,
    system: '',
    prompt: 'hi',
    cwd: process.cwd(),
    timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`preflight failed [${model}]: ${result.error}`);
  }
}

/**
 * Preflight every unique `(executor, model)` judge in `judgeModels`. Used by the
 * eval pipeline to fail fast when any ensemble member is misconfigured (404 model,
 * missing binary, auth failure) — without this, judge #2/#3 errors would only surface
 * mid-grading, after the run had already incurred task-execution cost and produced
 * partial reports without `judgeAgreement`.
 *
 * - Dedupes by normalized `executor:model` key — repeated entries probe once.
 * - Fails fast on the first failing judge; does NOT continue probing.
 * - Throws when an entry's executor is not present in `judgeExecutors` map (the
 *   pipeline must build the map covering every judge before calling this).
 */
export async function preflightAllJudges(
  judgeModels: import('../types/index.js').JudgeConfig[],
  judgeExecutors: Record<string, ExecutorFn>,
  timeoutMs?: number,
): Promise<void> {
  const seen = new Set<string>();
  for (const jc of judgeModels) {
    const key = `${jc.executor}:${jc.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const exec = judgeExecutors[jc.executor];
    if (!exec) {
      throw new Error(`preflight: no executor registered for "${jc.executor}" (judge "${key}"); pipeline must populate judgeExecutors before preflight`);
    }
    await preflight(exec, jc.model, timeoutMs);
  }
}
