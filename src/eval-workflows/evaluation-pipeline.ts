import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeResults } from '../analysis/report-diagnostics.js';
import { computeReportCoverage } from '../analysis/coverage-analyzer.js';
import { computeReportGapRates } from '../analysis/gap-analyzer.js';
import { aggregateReport, applyBlindMode, DEFAULT_OUTPUT_DIR, generateRunId, persistReport } from '../eval-core/evaluation-reporting.js';
import { executeTasks, preflight, preflightAllJudges } from '../eval-core/evaluation-execution.js';
import type { DependencyRequirements } from '../eval-core/dependency-checker.js';
import {
  createFileJobStore,
  DEFAULT_JOBS_DIR,
} from '../server/job-store.js';
import { stopAllServers } from '../inputs/mcp-resolver.js';
import {
  buildEvaluationRequest,
  createFailedJob,
  createEvaluationRun,
  createQueuedJob,
  createSucceededJob,
  finalizeEvaluationRun,
  markJobRunning,
  failEvaluationRun,
} from '../eval-core/evaluation-job.js';
import type {
  Artifact,
  EvaluationJob,
  EvaluationRequest,
  EvaluationRun,
  ExecutorFn,
  JobStore,
  ProgressCallback,
  Report,
  Sample,
  Task,
  VariantResult,
} from '../types/index.js';
import type { Lang } from '../types/shared.js';
import { tEvalWorkflowMessage } from './messages.js';

type EvaluationResults = Record<string, Record<string, VariantResult>>;

interface EvaluationRunState {
  request: EvaluationRequest;
  runId: string;
  jobId: string;
  createdAt: string;
  startedAt: string;
  initialRun: EvaluationRun;
  runningJob: EvaluationJob;
  resolvedJobStore: JobStore | null;
}

async function initializeEvaluationRunState({
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
  runId,
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
}: {
  samplesPath: string;
  skillDir: string;
  artifacts: Artifact[];
  model: string;
  judgeModel: string;
  noJudge: boolean;
  executorName: string;
  judgeExecutorName: string;
  concurrency: number;
  timeoutMs?: number;
  noCache: boolean;
  blind: boolean;
  project?: string;
  owner?: string;
  tags?: string[];
  runId: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  repeat?: number;
  batch?: boolean;
  judgeRepeat?: number;
  judgeModels?: import('../types/index.js').JudgeConfig[];
  bootstrap?: boolean;
  bootstrapSamples?: number;
  lengthDebias?: boolean;
  budget?: import('../types/index.js').EvalBudget;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}): Promise<EvaluationRunState> {
  const effectiveJudges: import('../types/index.js').JudgeConfig[] = judgeModels && judgeModels.length > 0
    ? judgeModels
    : [{ executor: judgeExecutorName, model: judgeModel }];
  const request = buildEvaluationRequest({
    samplesPath,
    skillDir,
    artifacts,
    model,
    executor: executorName,
    noJudge,
    concurrency,
    timeoutMs,
    noCache,
    dryRun: false,
    blind,
    project,
    owner,
    tags,
    repeat,
    batch,
    judgeRepeat,
    judgeModels: effectiveJudges,
    bootstrap,
    bootstrapSamples,
    lengthDebias,
    budget,
    effort,
  });
  const createdAt = new Date().toISOString();
  const { run: initialRun, startedAt } = createEvaluationRun(runId, createdAt);
  const jobId = `job-${runId}`;
  const resolvedJobStore = persistJob ? (jobStore ?? createFileJobStore(DEFAULT_JOBS_DIR)) : null;
  const queuedJob = createQueuedJob({ jobId, request, createdAt });
  if (resolvedJobStore) await resolvedJobStore.save(jobId, queuedJob);
  const runningJob = markJobRunning(queuedJob, runId, startedAt);
  if (resolvedJobStore) await resolvedJobStore.save(jobId, runningJob);
  return { request, runId, jobId, createdAt, startedAt, initialRun, runningJob, resolvedJobStore };
}

function finalizeSuccessfulRun(state: EvaluationRunState) {
  const finishedAt = new Date().toISOString();
  const run = finalizeEvaluationRun(state.initialRun, finishedAt);
  const job = createSucceededJob({
    jobId: state.jobId,
    runId: state.runId,
    reportId: state.runId,
    request: state.request,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    finishedAt,
  });
  return { run, job };
}

async function persistSuccessfulJob(state: EvaluationRunState, job: EvaluationJob): Promise<void> {
  if (state.resolvedJobStore) {
    await state.resolvedJobStore.save(state.jobId, job);
  }
}

async function persistFailedJob(state: EvaluationRunState, err: unknown): Promise<void> {
  const finishedAt = new Date().toISOString();
  const failedJob = createFailedJob({
    job: { ...state.runningJob, runId: state.runId, startedAt: state.startedAt, finishedAt: undefined },
    error: err instanceof Error ? err.message : String(err),
    finishedAt,
  });
  void failEvaluationRun(state.initialRun, finishedAt);
  if (state.resolvedJobStore) {
    await state.resolvedJobStore.save(state.jobId, failedJob);
  }
}

/**
 * Compute the mandatory test set watermark hash (spec §7.1).
 *
 * - 单文件 / sourceFiles 单元素:hash 该文件内容
 * - 多文件(目录模式):按文件名排序后,把每个文件 basename + sha256 拼成 manifest,
 *   对 manifest 再 sha256,前 12 hex chars。这样:
 *     1) 加 / 删 sample 文件 → hash 变
 *     2) 任一文件内容改 → hash 变
 *     3) 同样文件不同顺序 → hash 不变(排序后稳定)
 *
 * 之前对目录 readFileSync() 抛 EISDIR → 返回 null,gap report 水印丢失。
 */
export function _computeTestSetHashForTest(samplesPath: string, sourceFiles?: string[]): string | null {
  return computeTestSetHash(samplesPath, sourceFiles);
}

function computeTestSetHash(samplesPath: string, sourceFiles?: string[]): string | null {
  // 优先 sourceFiles(目录模式可靠),fallback samplesPath 兼容老调用
  const files = sourceFiles && sourceFiles.length > 0
    ? [...sourceFiles].sort()
    : (samplesPath && existsSync(samplesPath) ? [samplesPath] : []);
  if (files.length === 0) return null;
  try {
    if (files.length === 1) {
      return createHash('sha256').update(readFileSync(files[0], 'utf-8')).digest('hex').slice(0, 12);
    }
    const manifest = files.map((f) => {
      const base = f.split(/[/\\]/).pop() ?? f;
      const inner = createHash('sha256').update(readFileSync(f, 'utf-8')).digest('hex');
      return `${base}:${inner}`;
    }).join('\n');
    return createHash('sha256').update(manifest).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Compute structural power warnings (pure function, no I/O — for testing).
 *
 * Not MDE / power-analysis predictions (we don't have σ pre-run; predicting
 * "CI half-width ~ ±0.4" before any data exists is hand-wave). These are
 * **hard-floor + experience-based** thresholds:
 *   - n < 5: any conclusion unreliable, CI uselessly wide
 *   - 5 ≤ n < 20: only large effects (Cohen's d > 0.8) detectable
 *   - repeat=1: stability cannot be measured at all
 *
 * Real power claims happen post-hoc via `omk eval` UNDERPOWERED state +
 * saturation curves. This is the upfront "you might be wasting the run"
 * heads-up, not a gate.
 */
export function buildPowerWarnings(sampleCount: number, repeat: number, lang: Lang = 'zh'): string[] {
  const warnings: string[] = [];
  if (sampleCount < 5) {
    warnings.push(tEvalWorkflowMessage('power_warning_tiny_n', lang, { n: sampleCount }));
  } else if (sampleCount < 20) {
    warnings.push(tEvalWorkflowMessage('power_warning_small_n', lang, { n: sampleCount }));
  }
  if (repeat < 2) {
    warnings.push(tEvalWorkflowMessage('power_warning_repeat_one', lang));
  }
  return warnings;
}

function emitPowerWarnings(sampleCount: number, repeat: number, lang: Lang): void {
  for (const w of buildPowerWarnings(sampleCount, repeat, lang)) {
    process.stderr.write(`${w}\n`);
  }
}

/**
 * Pre-flight warning emitted when user explicitly opts out of strict-baseline
 * (--no-strict-baseline) AND there are baseline-kind variants AND ~/.claude/skills/
 * has content. baseline 会被 SDK 全发现污染 → verdict / Δ 不可信。
 *
 * 默认 strict 时(strictBaseline === true / undefined)不出 warn。
 *
 * Exported for tests.
 */
export function buildIsolationWarnings(
  artifacts: Artifact[],
  strictBaseline: boolean | undefined,
): string[] {
  // Only warn when user explicitly disabled isolation.
  if (strictBaseline !== false) return [];

  const hasBaselineKind = artifacts.some((a) => a.kind === 'baseline');
  if (!hasBaselineKind) return [];

  // Check ~/.claude/skills/ for content (avoid hard-coding home — read at runtime).
  const skillsDir = join(homedir(), '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];

  let skillCount = 0;
  try {
    skillCount = readdirSync(skillsDir).filter((entry) => !entry.startsWith('.')).length;
  } catch {
    return [];
  }
  if (skillCount === 0) return [];

  return [
    `⚠ baseline 隔离已关闭(--no-strict-baseline)。检测到 ~/.claude/skills/ 内有 ${skillCount} 个 skill, baseline variant 可能被 auto-discovery 污染。除非你确认要这种比较,建议恢复默认 strict 模式。`,
  ];
}

function emitIsolationWarnings(artifacts: Artifact[], strictBaseline: boolean | undefined): void {
  for (const w of buildIsolationWarnings(artifacts, strictBaseline)) {
    process.stderr.write(`${w}\n`);
  }
}

function finalizeEvaluationReport({
  report,
  results,
  artifacts,
  variantNames,
  blind,
  samplesPath,
  samplesSourceFiles,
  samples,
}: {
  report: Report;
  results: EvaluationResults;
  artifacts: Artifact[];
  variantNames: string[];
  blind: boolean;
  samplesPath: string;
  /** 目录模式下,bundle 内所有源文件;单文件模式下 [samplesPath]。computeTestSetHash 用。 */
  samplesSourceFiles?: string[];
  samples: Sample[];
}): Report {
  // pass samples so analyzeResults can populate analysis.sampleQuality
  // (capability/difficulty/construct/provenance coverage aggregate). Without
  // samples, analysis.sampleQuality is omitted (老报告读取仍可工作).
  report.analysis = analyzeResults(report, { samples });

  const hasToolData = Object.values(results).some((sampleResults) => (
    Object.values(sampleResults).some((variantResult) => variantResult.toolCalls && variantResult.toolCalls.length > 0)
  ));
  if (hasToolData) {
    const artifactContents = Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact.content]));
    const artifactCwds = Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact.cwd || null]));
    const coverage = computeReportCoverage(report, artifactContents, artifactCwds);
    if (Object.keys(coverage).length > 0) {
      report.analysis!.coverage = coverage;
    }
  }

  // Gap rate computation runs on every successful report regardless of whether
  // tool trace data is present — text-based signals (markers, hedging) still
  // apply. The samples-file SHA is the mandatory watermark required by spec §7.1.
  const gapReports = computeReportGapRates(report.results, variantNames);
  if (Object.keys(gapReports).length > 0) {
    const testSetHash = computeTestSetHash(samplesPath, samplesSourceFiles);
    for (const variant of variantNames) {
      const gr = gapReports[variant];
      if (!gr) continue;
      gr.testSetPath = samplesPath;
      gr.testSetHash = testSetHash;
    }
    report.analysis!.gapReports = gapReports;
  }

  if (blind) {
    applyBlindMode(report, variantNames, `${variantNames.join(',')}:${samplesPath}`);
  }

  return report;
}

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
