import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { analyzeResults } from '../analysis/report-diagnostics.js';
import { computeReportCoverage } from '../analysis/coverage-analyzer.js';
import { computeReportGapRates } from '../analysis/gap-analyzer.js';
import { aggregateReport, applyBlindMode, DEFAULT_OUTPUT_DIR, generateRunId, persistReport } from '../eval-core/evaluation-reporting.js';
import { executeTasks, preflight } from '../eval-core/evaluation-execution.js';
import { preflightDependencies, formatDependencyErrors } from '../eval-core/dependency-checker.js';
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
  each,
  judgeRepeat,
  judgeModels,
  bootstrap,
  bootstrapSamples,
  lengthDebias,
  budget,
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
  each?: boolean;
  judgeRepeat?: number;
  judgeModels?: import('../types/index.js').JudgeConfig[];
  bootstrap?: boolean;
  bootstrapSamples?: number;
  lengthDebias?: boolean;
  budget?: import('../types/index.js').EvalBudget;
}): Promise<EvaluationRunState> {
  const request = buildEvaluationRequest({
    samplesPath,
    skillDir,
    artifacts,
    model,
    judgeModel: noJudge ? null : judgeModel,
    executor: executorName,
    judgeExecutor: judgeExecutorName,
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
    each,
    judgeRepeat,
    judgeModels,
    bootstrap,
    bootstrapSamples,
    lengthDebias,
    budget,
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
 * Compute the mandatory test set watermark hash (spec §7.1). Returns the first
 * 12 hex chars of SHA-256 over the samples file contents, or null if the file
 * can't be read.
 */
function computeTestSetHash(samplesPath: string): string | null {
  if (!samplesPath || !existsSync(samplesPath)) return null;
  try {
    const content = readFileSync(samplesPath, 'utf-8');
    return createHash('sha256').update(content).digest('hex').slice(0, 12);
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
 * Real power claims happen post-hoc via `bench verdict` UNDERPOWERED state +
 * saturation curves. This is the upfront "you might be wasting the run"
 * heads-up, not a gate.
 */
export function buildPowerWarnings(sampleCount: number, repeat: number): string[] {
  const warnings: string[] = [];
  if (sampleCount < 5) {
    warnings.push(
      `⚠ N=${sampleCount} < 5 (exploration-only): any conclusion is unreliable, CI will be uselessly wide. Decisions need ≥20 cases.`,
    );
  } else if (sampleCount < 20) {
    warnings.push(
      `⚠ N=${sampleCount} < 20 (large-effect-only, Cohen's d > 0.8): medium effects (d ≈ 0.5) hard to detect. For confident decisions consider ≥20 cases.`,
    );
  }
  if (repeat < 2) {
    warnings.push(
      `⚠ --repeat=1: single-run cannot measure stability (CV will be marked "not measured"). Use --repeat 3+ to detect within-variant variance.`,
    );
  }
  return warnings;
}

function emitPowerWarnings(sampleCount: number, repeat: number): void {
  for (const w of buildPowerWarnings(sampleCount, repeat)) {
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
  samples,
}: {
  report: Report;
  results: EvaluationResults;
  artifacts: Artifact[];
  variantNames: string[];
  blind: boolean;
  samplesPath: string;
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
    const testSetHash = computeTestSetHash(samplesPath);
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
  skipPreflight?: boolean;
  verbose?: boolean;
  retry?: number;
  existingResults?: Record<string, Record<string, VariantResult>>;
  requires?: DependencyRequirements;
  layeredStats?: boolean;
  /** 透传到 meta.request.repeat */
  repeat?: number;
  /** 透传到 meta.request.each */
  each?: boolean;
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
}

export async function executeEvaluationPipeline({
  samplesPath,
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
  skipPreflight = false,
  verbose = false,
  retry = 0,
  existingResults,
  requires,
  layeredStats = false,
  repeat,
  each,
  judgeRepeat,
  judgeModels,
  bootstrap,
  bootstrapSamples,
  lengthDebias = true,
  budget,
  strictBaseline,
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
    runId: generateRunId(variantNames),
    jobStore,
    persistJob,
    repeat,
    each,
    judgeRepeat,
    judgeModels,
    bootstrap,
    bootstrapSamples,
    lengthDebias,
    budget,
  });

  try {
    if (!skipPreflight) {
      if (onProgress) onProgress({ phase: 'preflight', jobId: runState.jobId });
      await preflight(executor, model);
      if (!noJudge) await preflight(judgeExecutor, judgeModel);

      // Dependency check: auto-extract from skill contents + merge explicit requires
      const skillContents = artifacts.map((a) => a.content).filter((c): c is string => typeof c === 'string');
      const cwd = artifacts.find((a) => a.cwd)?.cwd || skillDir || process.cwd();
      const depResult = await preflightDependencies(skillContents, samples, cwd, requires, artifacts);
      if (!depResult.ok) {
        throw new Error(formatDependencyErrors(depResult.missing));
      }
    }

    // Structural power warnings — print to stderr after preflight passes, before
    // tasks start. These are *not* MDE / power-analysis predictions (we don't have
    // σ before the run); they're hard-floor + experience-based thresholds. Verdict
    // gate (computeVerdict) handles real power claims post-hoc.
    emitPowerWarnings(samples.length, repeat ?? 1);
    // Isolation pre-flight warning (--no-strict-baseline + ~/.claude/skills/ non-empty)
    emitIsolationWarnings(artifacts, strictBaseline);

    // Pre-build a per-executor map for ensemble judges. Each unique executor name
    // gets one ExecutorFn, shared across all judges using that executor. The default
    // judge's executor is also included so single-judge fallbacks have it available.
    let judgeExecutors: Record<string, ExecutorFn> | undefined;
    if (judgeModels && judgeModels.length >= 2) {
      const { createExecutor } = await import('../executors/index.js');
      judgeExecutors = {};
      const seen = new Set<string>();
      for (const jc of judgeModels) {
        if (!seen.has(jc.executor)) {
          seen.add(jc.executor);
          judgeExecutors[jc.executor] = createExecutor(jc.executor);
        }
      }
    }

    const { results, totalCostUSD, skipped, budgetExhausted } = await executeTasks({
      tasks,
      executor,
      executorName,
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
      retry,
      existingResults,
      judgeRepeat,
      judgeModels,
      judgeExecutors,
      lengthDebias,
      budget,
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
