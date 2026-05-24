/**
 * evaluation pipeline orchestrator —— 单次 evaluation run 的「执行+收尾」编排。
 *
 * 主入口 `executeEvaluationPipeline` 把以下几段串成线性时序:
 *   1. `initializeEvaluationRunState` 建 run / job 元数据并写 jobStore
 *   2. resolve judge models + executor map(必须先于 preflight,见函数内注释)
 *   3. `preflight` + `preflightAllJudges` LLM 连通性
 *   4. `emitPowerWarnings` + `emitIsolationWarnings` 结构性 / 隔离性预警
 *   5. `executeTasks` 真正跑用例
 *   6. `finalizeSuccessfulRun` + `finalizeEvaluationReport` 收尾 + 后置分析
 *   7. `persistReport` + `persistSuccessfulJob` 落盘
 *   失败路径走 `persistFailedJob`, finally 关 MCP server。
 *
 * 4 块被拆出去的 helper 都在 `./evaluation-pipeline/` 目录下,与本文件 1:1 协作:
 *   - run-state.ts: EvaluationRunState 生命周期(init / finalizeSuccess / persistSuccess / persistFailed)
 *   - test-set-hash.ts: 测试集水印 hash(spec §7.1)
 *   - preflight-warnings.ts: power + isolation 预警
 *   - report-finalize.ts: report 后置分析装配
 *
 * 兼容 re-export: `buildPowerWarnings` / `buildIsolationWarnings` /
 * `_computeTestSetHashForTest` 保留在本模块的 export surface,避免 test 与
 * `run-evaluation.ts:275` 动态 import 路径改动。
 */

import { aggregateReport, DEFAULT_OUTPUT_DIR, generateRunId, persistReport } from '../eval-core/evaluation-reporting.js';
import { executeTasks, preflight, preflightAllJudges } from '../eval-core/evaluation-execution.js';
import type { DependencyRequirements } from '../eval-core/dependency-checker.js';
import { stopAllServers } from '../inputs/mcp-resolver.js';
import type {
  Artifact,
  ExecutorFn,
  JobStore,
  ProgressCallback,
  Report,
  Sample,
  Task,
} from '../types/index.js';
import type { Lang } from '../types/shared.js';
import {
  finalizeSuccessfulRun,
  initializeEvaluationRunState,
  persistFailedJob,
  persistSuccessfulJob,
} from './evaluation-pipeline/run-state.js';
import { finalizeEvaluationReport } from './evaluation-pipeline/report-finalize.js';
import { emitIsolationWarnings, emitPowerWarnings } from './evaluation-pipeline/preflight-warnings.js';

// 兼容 re-export:测试与 run-evaluation.ts 动态 import 仍打 evaluation-pipeline.js
export { buildPowerWarnings, buildIsolationWarnings } from './evaluation-pipeline/preflight-warnings.js';
export { _computeTestSetHashForTest } from './evaluation-pipeline/test-set-hash.js';

export interface EvaluationPipelineOptions {
  samplesPath: string;
  /** Sample bundle 根目录。loadSamples 输出,缺省时 fallback dirname(samplesPath)。 */
  samplesBaseDir?: string;
  /** Sample bundle 内合并的源文件绝对路径列表。目录模式下用于 computeTestSetHash 遍历。 */
  samplesSourceFiles?: string[];
  skillDir: string;
  samples: Sample[];
  tasks: Task[];
  artifacts: Artifact[];
  model: string;
  judgeModel: string;
  noJudge: boolean;
  executorName: string;
  judgeExecutorName: string;
  executor: ExecutorFn;
  judgeExecutor: ExecutorFn;
  outputDir?: string | null;
  project?: string;
  owner?: string;
  tags?: string[];
  blind?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  noCache?: boolean;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  onProgress?: ProgressCallback | null;
  skipConnectivity?: boolean;
  verbose?: boolean;
  retry?: number;
  existingResults?: Record<string, Record<string, VariantResult>>;
  requires?: DependencyRequirements;
  layeredStats?: boolean;
  /** 透传到 meta.request.repeat */
  repeat?: number;
  /** 透传到 meta.request.batch */
  batch?: boolean;
  /** 透传到 meta.request.judgeRepeat 与 grade()，每条 sample × dimension judge N 次 */
  judgeRepeat?: number;
  /** Multi-judge ensemble configs (≥ 2 entries triggers ensemble mode). */
  judgeModels?: import('../types/index.js').JudgeConfig[];
  /** --bootstrap. */
  bootstrap?: boolean;
  /** --bootstrap-samples N. Default 1000. */
  bootstrapSamples?: number;
  /** v0.21 length-debias toggle. Default true; --no-debias-length flips to false. */
  lengthDebias?: boolean;
  /** hard budget caps. */
  budget?: import('../types/index.js').EvalBudget;
  /** strict-baseline default state (only used to decide whether to emit
   *  isolation-disabled pre-flight warnings). True/undefined = default behavior
   *  (no warning); false = user explicitly disabled, warn if ~/.claude/skills/ has content. */
  strictBaseline?: boolean;
  /** Explicit persisted run id. Used by batch workflows that need stable child ids. */
  runId?: string;
  /** CLI output language for warnings emitted by the pipeline. */
  lang?: Lang;
  /** Reasoning effort 透传到 executor。默认 'low'(由 RunConfig 兜底)。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 关闭 diagnostic。Default false。 */
  noDiagnostic?: boolean;
}

type VariantResult = import('../types/index.js').VariantResult;

export async function executeEvaluationPipeline({
  samplesPath,
  samplesBaseDir,
  samplesSourceFiles,
  skillDir,
  samples,
  tasks,
  artifacts,
  model,
  judgeModel,
  noJudge,
  executorName,
  judgeExecutorName,
  executor,
  judgeExecutor,
  outputDir = DEFAULT_OUTPUT_DIR,
  project,
  owner,
  tags,
  blind = false,
  concurrency = 1,
  timeoutMs,
  noCache = false,
  jobStore = null,
  persistJob = true,
  onProgress = null,
  skipConnectivity = false,
  verbose = false,
  retry = 0,
  existingResults,
  // requires 现在由 runEvaluation 上游传给 doctor 处理; eval-pipeline 不再用
  // 但保留接口字段,避免破 programmatic API (类型层面接收, 内部忽略)
  requires: _requires,
  layeredStats = false,
  repeat,
  batch,
  judgeRepeat,
  judgeModels,
  bootstrap,
  bootstrapSamples,
  lengthDebias = true,
  budget,
  strictBaseline,
  runId,
  lang = 'zh',
  effort,
  noDiagnostic,
}: EvaluationPipelineOptions): Promise<{ report: Report; filePath: string | null }> {
  const variantNames = artifacts.map((artifact) => artifact.name);
  const runState = await initializeEvaluationRunState({
    samplesPath,
    skillDir,
    artifacts,
    model,
    judgeModel,
    noJudge,
    executorName,
    judgeExecutorName,
    concurrency,
    timeoutMs,
    noCache,
    blind,
    project,
    owner,
    tags,
    runId: runId ?? generateRunId(variantNames),
    jobStore,
    persistJob,
    repeat,
    batch,
    judgeRepeat,
    judgeModels,
    bootstrap,
    bootstrapSamples,
    lengthDebias,
    budget,
    effort,
  });

  try {
    // 解析 judge config + 配套 executor map 一次,后续 preflight 与 executeTasks 共用。
    // production 路径 judgeModels 始终非空(RunConfig 必填);fallback 仅兼容 internal
    // legacy caller 还在传 single judgeModel + judgeExecutorName 的场景。
    //
    // executor map 必须先于 preflight build,否则 ensemble 中第二、第三个 judge 配错
    // (404 model / executor 不存在 / auth fail)只会在 grading 半途才暴露 — 那时已经
    // 浪费 task execution 成本 + 报告里也不会有 judgeAgreement。
    const resolvedJudgeModels = judgeModels && judgeModels.length > 0
      ? judgeModels
      : [{ executor: executorName, model: judgeModel }];
    let resolvedJudgeExecutors: Record<string, ExecutorFn>;
    if (judgeModels && judgeModels.length > 0) {
      const { createExecutor } = await import('../executors/index.js');
      resolvedJudgeExecutors = {};
      for (const jc of resolvedJudgeModels) {
        if (!resolvedJudgeExecutors[jc.executor]) {
          resolvedJudgeExecutors[jc.executor] = createExecutor(jc.executor);
        }
      }
    } else {
      resolvedJudgeExecutors = { [executorName]: judgeExecutor };
    }

    if (!skipConnectivity) {
      if (onProgress) onProgress({ phase: 'preflight', jobId: runState.jobId });
      // LLM 连通性: eval 唯一职责。doctor 在 runEvaluation 上游已跑,
      // 包含 dep / 结构 / 元数据 / 契约检查。这里只剩 executor + 所有 judge。
      await preflight(executor, model);
      if (!noJudge) {
        await preflightAllJudges(resolvedJudgeModels, resolvedJudgeExecutors);
      }
    }

    // Structural power warnings — print to stderr after preflight passes, before
    // tasks start. These are *not* MDE / power-analysis predictions (we don't have
    // σ before the run); they're hard-floor + experience-based thresholds. Verdict
    // gate (computeVerdict) handles real power claims post-hoc.
    emitPowerWarnings(samples.length, repeat ?? 1, lang);
    // Isolation pre-flight warning (--no-strict-baseline + ~/.claude/skills/ non-empty)
    emitIsolationWarnings(artifacts, strictBaseline);

    const { results, totalCostUSD, skipped, budgetExhausted } = await executeTasks({
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
      retry,
      existingResults,
      judgeRepeat,
      judgeModels: resolvedJudgeModels,
      judgeExecutors: resolvedJudgeExecutors,
      lengthDebias,
      budget,
      effort,
      noDiagnostic,
    });
    if (skipped > 0 && onProgress) {
      onProgress({ phase: 'done', completed: tasks.length, total: tasks.length, sample_id: '', variant: '', skipped: true });
    }

    const { run, job } = finalizeSuccessfulRun(runState);
    const report = finalizeEvaluationReport({
      report: aggregateReport({
        runId: runState.runId,
        variants: variantNames,
        model,
        judgeModel,
        noJudge,
        executorName,
        samples,
        tasks,
        results,
        totalCostUSD,
        artifacts,
        request: runState.request,
        run,
        job,
        layeredStats,
      }),
      results,
      artifacts,
      variantNames,
      blind,
      samplesPath,
      samplesSourceFiles,
      samples,
    });
    if (budgetExhausted) {
      report.meta.budgetExhausted = true;
    }
    if (budget) {
      report.meta.budget = budget;
    }
    const filePath = persistReport(report, outputDir);
    await persistSuccessfulJob(runState, job);
    return { report, filePath };
  } catch (err: unknown) {
    await persistFailedJob(runState, err);
    throw err;
  } finally {
    await stopAllServers();
  }
}
