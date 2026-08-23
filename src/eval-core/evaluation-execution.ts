import { createCache, cacheKey } from './cache.js';
import { buildVariantResult } from './schema.js';
import { safeSliceForJson } from '../util/safe-slice.js';
import { grade } from '../grading/index.js';
import { checkFacts } from './fact-checker.js';
import type { FactCheckEvidence, FactCheckResult } from './fact-checker.js';
import { resolveExecutionStrategy } from './execution-strategy.js';
import { DEFAULT_CACHE_DIR, DEFAULT_ISOLATED_CWD_DIR } from './default-dirs.js';
import { resolveExecutorRuntimeFingerprint } from '../executors/runtime-fingerprint.js';
import { isRegisteredExecutorName } from '../executors/registry.js';
import {
  ownRecordValue,
  setOwnRecordValue,
} from '../shared/record-count.js';
import {
  executorResultValidationError,
  normalizeExecResultToolIdentities,
} from '../shared/executor-result.js';
import { hashSampleExecutionDependencies } from './sample-fingerprint.js';
import { resolveDiagnosticTarget } from '../grading/diagnostic.js';
import { dirname, join, resolve } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  /** Sample bundle 根目录 — 单文件模式 = dirname(samplesPath),目录模式 = 目录自身。
   *  传给 grade 当 samplesDir(custom assertion fn 相对路径锚点),也用作 mocksBaseDir 兜底。
   *  缺省时仍 fallback dirname(resolve(samplesPath)),不破单文件老用法。 */
  samplesBaseDir?: string;
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
    tokenUsageReportedByExecutor: false,
    costUSD: 0,
    costReportedByExecutor: false,
    stopReason: 'error',
    numTurns: 0,
    error: message,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWithAttemptIsolation(
  executor: ExecutorFn,
  input: Parameters<ExecutorFn>[0],
  isolatedCwd: boolean,
): Promise<ExecResult> {
  if (!isolatedCwd) return executor(input);
  await mkdir(DEFAULT_ISOLATED_CWD_DIR, { recursive: true });
  const runtimeCwd = await mkdtemp(join(DEFAULT_ISOLATED_CWD_DIR, 'attempt-'));
  try {
    return await executor({ ...input, cwd: runtimeCwd });
  } finally {
    try {
      await rm(runtimeCwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[omk] 无法清理 baseline 隔离目录 ${runtimeCwd}：${message}\n`);
    }
  }
}

export async function executeTasks({
  tasks,
  executor,
  executorName,
  model,
  noJudge,
  samplesPath,
  samplesBaseDir,
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
  if (!executorName && !noCache) {
    throw new Error(
      'executeTasks requires executorName when cache is enabled; '
      + 'an anonymous executor cannot have a safe cross-run cache identity',
    );
  }
  const effectiveExecutorName = executorName ?? 'custom-executor';

  // Seed results from previous run (--resume)
  if (existingResults) {
    for (const [sampleId, variants] of Object.entries(existingResults)) {
      setOwnRecordValue(results, sampleId, { ...variants });
      for (const result of Object.values(variants)) {
        if (result.ok) totalCostUSD += result.costUSD;
      }
    }
  }

  const cacheDir = DEFAULT_CACHE_DIR;
  const cache: ExecutorCache | null = noCache ? null : createCache(cacheDir);

  async function executeTask(task: Task): Promise<void> {
    // Skip if already have a successful result (--resume)
    if (
      ownRecordValue(
        ownRecordValue(existingResults ?? {}, task.sample_id) ?? {},
        task.variant,
      )?.ok
    ) {
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

    const executionPlan = resolveExecutionStrategy(task, model, timeoutMs, verbose, effort, samplesBaseDir);
    const executorRuntime = resolveExecutorRuntimeFingerprint(effectiveExecutorName, model, {
      skillDir: executionPlan.input.skillDir,
    }, executor);

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
      // artifact 内容指纹进 key:本地 dir-skill 改 references/ 资产只动 contentHash,system 不变,
      // 不进 key 会命中旧输出贴到新 artifactHashes(静默污染)。
      task.artifact.contentHash,
      hashSampleExecutionDependencies(task._sample, samplesBaseDir),
    );
    const cached = cache?.get(key);
    const execStart = Date.now();
    if (cached) {
      execResult = { ...cached, cached: true };
    } else {
      // Execute with retry on failure
      const maxAttempts = 1 + Math.max(0, retry);
      let attemptCostUSD = 0;
      let attemptCostReported = true;
      let attemptCount = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          execResult = await executeWithAttemptIsolation(
            executor,
            executionPlan.input,
            executionPlan.isolatedCwd === true,
          );
        } catch (err) {
          execResult = makeErrorResult(err);
        }
        const validationError = executorResultValidationError(execResult);
        if (validationError) {
          execResult = makeErrorResult(`executor returned invalid result: ${validationError}`);
        } else {
          execResult = normalizeExecResultToolIdentities(execResult);
        }
        attemptCount += 1;
        const nextAttemptCost = attemptCostUSD + execResult!.costUSD;
        if (
          Number.isFinite(nextAttemptCost)
          && nextAttemptCost >= 0
          && nextAttemptCost <= Number.MAX_SAFE_INTEGER
        ) {
          attemptCostUSD = nextAttemptCost;
        } else {
          // Never turn overflow into a free execution. Saturation keeps persisted
          // numbers valid and remains a conservative lower bound; the completeness
          // flag tells reports that the exact amount is unavailable.
          attemptCostUSD = Number.MAX_SAFE_INTEGER;
          attemptCostReported = false;
        }
        if (execResult!.costReportedByExecutor === false) attemptCostReported = false;
        const retryWouldExceedBudget = (
          budget?.perSampleUSD != null
          && attemptCostUSD > budget.perSampleUSD
        ) || (
          budget?.totalUSD != null
          && totalCostUSD + attemptCostUSD > budget.totalUSD
        );
        if (execResult!.ok || attempt === maxAttempts || retryWouldExceedBudget) break;
        // Exponential backoff before retry
        const backoffMs = Math.min(2 ** (attempt - 1) * 1000, 30000);
        onProgress?.({ phase: 'retry', completed: idx, total, sample_id: task.sample_id, variant: task.variant, attempt, maxAttempts });
        await sleep(backoffMs);
      }
      execResult = {
        ...execResult!,
        costUSD: attemptCostUSD,
        ...(attemptCostReported ? {} : { costReportedByExecutor: false }),
        ...(attemptCount > 1 ? { attemptCount } : {}),
      };
      if (cache && execResult!.ok) cache.set(key, execResult!);
    }
    const execMs = Date.now() - execStart;
    totalCostUSD = Math.min(
      Number.MAX_SAFE_INTEGER,
      totalCostUSD + execResult!.costUSD,
    );

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
            // 优先用 samplesBaseDir(sample bundle 根目录);未传时 fallback 老路径,
            // 保证单文件 samples 老用法不破。samplesBaseDir 在目录模式下指向目录自身,
            // 让 custom assertion fn 相对路径正确锚到 .omk/。
            samplesDir: samplesBaseDir ?? dirname(resolve(samplesPath)),
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
    if (execResult!.ok && execResult!.output) {
      const sharedEvidence: FactCheckEvidence = {
        ...(task._sample.context && { context: task._sample.context }),
        ...(task._sample.environment?.files_available?.length && {
          declaredFiles: task._sample.environment.files_available,
        }),
        // Resolve exactly like the executor's cwd. samplesBaseDir is for bundle
        // assets such as mocks, not for changing Sample.cwd path semantics.
        ...(task._sample.cwd && { cwd: resolve(task._sample.cwd) }),
      };
      factCheck = checkFacts(execResult!.output, sharedEvidence);
    }

    const sampleResults = ownRecordValue(results, task.sample_id)
      ?? setOwnRecordValue(results, task.sample_id, {});
    const variantResult = buildVariantResult(execResult!, gradeResult, { execMs, gradeMs, factCheck });

    // Diagnostic — 与 judge 完全独立的"哪错了 + skill 怎么改"诊断。
    // 触发条件:noDiagnostic=false + 至少 1 条 assertion fail + sample 跑成功(有 fullOutput)。
    //
    // executor / model 选择跟报告契约共用 resolveDiagnosticTarget:
    // 跟随首位 judge；没有 judge 配置时才跟随主执行器。不得暗中偏爱某个 provider。
    const failedDetails = (gradeResult?.assertions?.details || []).filter((d) => !d.passed);
    const shouldDiagnose = !noDiagnostic && execResult!.ok && failedDetails.length > 0;
    if (shouldDiagnose) {
      const diagnosticStart = Date.now();
      try {
        const { runDiagnostic } = await import('../grading/diagnostic.js');
        const diagnosticTarget = resolveDiagnosticTarget(
          judgeModels,
          effectiveExecutorName,
          model,
        );
        const diagExecutor = diagnosticTarget.executor === effectiveExecutorName
          ? executor
          : ownRecordValue(judgeExecutors, diagnosticTarget.executor);
        if (!diagExecutor) {
          throw new Error(
            `diagnostic executor "${diagnosticTarget.executor}" is not registered`,
          );
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
          model: diagnosticTarget.model,
        });
        variantResult.diagnostic = diagnostic;
        if (diagnostic.costReportedByExecutor === false) {
          variantResult.judgeCostReportedByExecutor = false;
        }
        // diagnostic 成本三层对齐(reviewer PR#95 CR 2026-05-11 P2):
        //   - meta.totalCostUSD 累加(下面 totalCostUSD += 这一行)
        //   - variant summary 的 totalCostUSD / totalDiagnosticCostUSD 由 buildVariantSummary
        //     sum 各 entry 的 costUSD / diagnosticCostUSD 得出 — 所以 entry 上必须也加回去
        //   - 下面 line 341-343 的 budget.perSampleUSD 用 variantResult.costUSD 比上限,
        //     diagnostic 必须算进 per-sample 的 cap 检查里(不然 cap 在 diagnostic 拉爆样本时漏判)
        // 这三件要么都做要么都不做,任何一处漏就回到 reviewer 提到的"成本口径分裂"。
        if (typeof diagnostic.costUSD === 'number' && diagnostic.costUSD > 0) {
          variantResult.diagnosticCostUSD = diagnostic.costUSD;
          variantResult.costUSD = (variantResult.costUSD || 0) + diagnostic.costUSD;
          totalCostUSD += diagnostic.costUSD;
        }
      } catch (err) {
        variantResult.judgeCostReportedByExecutor = false;
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
      } finally {
        const diagnosticMs = Date.now() - diagnosticStart;
        variantResult.timing = {
          execMs,
          gradeMs,
          diagnosticMs,
          totalMs: execMs + gradeMs + diagnosticMs,
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
    const sampleDurationMs = variantResult.timing?.totalMs ?? execMs + gradeMs;
    if (budget?.perSampleMs != null && sampleDurationMs > budget.perSampleMs) {
      variantResult.ok = false;
      variantResult.error = `budget overrun: per-sample latency ${sampleDurationMs}ms > cap ${budget.perSampleMs}ms`;
    }
    setOwnRecordValue(sampleResults, task.variant, variantResult);

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

export function preflightRuntimeLabel(executorName: string, model: string): string {
  return isRegisteredExecutorName(executorName) ? `${executorName}:${model}` : `custom:${model}`;
}

export async function preflight(executor: ExecutorFn, model: string, timeoutMs: number = 180000, label?: string): Promise<void> {
  const result = await executor({
    model,
    system: '',
    prompt: 'hi',
    cwd: process.cwd(),
    timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`preflight failed [${label ?? model}]: ${result.error}`);
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
    const exec = ownRecordValue(judgeExecutors, jc.executor);
    if (!exec) {
      throw new Error(`preflight: no executor registered for "${jc.executor}" (judge "${key}"); pipeline must populate judgeExecutors before preflight`);
    }
    await preflight(exec, jc.model, timeoutMs, preflightRuntimeLabel(jc.executor, jc.model));
  }
}
