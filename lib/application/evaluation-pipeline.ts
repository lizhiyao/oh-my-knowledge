import { analyzeResults } from '../analyzer.js';
import { computeReportCoverage } from '../coverage-analyzer.js';
import { createFileJobStore, DEFAULT_JOBS_DIR } from '../job-store.js';
import { stopAllServers } from '../mcp-resolver.js';
import {
  aggregateReport,
  applyBlindMode,
  executeTasks,
  generateRunId,
  persistReport,
  preflight,
  DEFAULT_OUTPUT_DIR,
} from '../evaluation-core.js';
import {
  buildEvaluationRequest,
  createFailedJob,
  createEvaluationRun,
  createQueuedJob,
  createSucceededJob,
  finalizeEvaluationRun,
  markJobRunning,
  failEvaluationRun,
} from '../evaluation-job.js';
import type {
  Artifact,
  ExecutorFn,
  JobStore,
  Report,
  Sample,
  Task,
} from '../types.js';
import type { ProgressCallback } from '../evaluation-core.js';

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
}: EvaluationPipelineOptions): Promise<{ report: Report; filePath: string | null }> {
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
  });

  const variantNames = artifacts.map((artifact) => artifact.name);
  const runId = generateRunId(variantNames);
  const createdAt = new Date().toISOString();
  const { run: initialRun, startedAt } = createEvaluationRun(runId, createdAt);
  const jobId = `job-${runId}`;
  const resolvedJobStore = persistJob ? (jobStore ?? createFileJobStore(DEFAULT_JOBS_DIR)) : null;
  const queuedJob = createQueuedJob({ jobId, request, createdAt });
  if (resolvedJobStore) await resolvedJobStore.save(jobId, queuedJob);
  const runningJob = markJobRunning(queuedJob, runId, startedAt);
  if (resolvedJobStore) await resolvedJobStore.save(jobId, runningJob);

  try {
    if (!skipPreflight) {
      if (onProgress) onProgress({ phase: 'preflight', jobId });
      await preflight(executor, model);
      if (!noJudge) await preflight(judgeExecutor, judgeModel);
    }

    const { results, totalCostUSD } = await executeTasks({
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
    });

    const finishedAt = new Date().toISOString();
    const run = finalizeEvaluationRun(initialRun, finishedAt);
    const job = createSucceededJob({
      jobId,
      runId,
      reportId: runId,
      request,
      createdAt,
      startedAt,
      finishedAt,
    });
    const report = aggregateReport({
      runId,
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
      request,
      run,
      job,
    });

    report.analysis = analyzeResults(report);

    const hasToolData = Object.values(results).some((r) => Object.values(r).some((vr) => vr.toolCalls && vr.toolCalls.length > 0));
    if (hasToolData) {
      const artifactContents = Object.fromEntries(artifacts.map((a) => [a.name, a.content]));
      const artifactCwds = Object.fromEntries(artifacts.map((a) => [a.name, a.cwd || null]));
      const coverage = computeReportCoverage(report, artifactContents, artifactCwds);
      if (Object.keys(coverage).length > 0) {
        report.analysis!.coverage = coverage;
      }
    }

    if (blind) {
      applyBlindMode(report, variantNames, `${variantNames.join(',')}:${samplesPath}`);
    }

    await stopAllServers();

    const filePath = persistReport(report, outputDir);
    if (resolvedJobStore) await resolvedJobStore.save(jobId, job);
    return { report, filePath };
  } catch (err: unknown) {
    const finishedAt = new Date().toISOString();
    const failedJob = createFailedJob({
      job: { ...runningJob, runId, startedAt, finishedAt: undefined },
      error: err instanceof Error ? err.message : String(err),
      finishedAt,
    });
    void failEvaluationRun(initialRun, finishedAt);
    if (resolvedJobStore) await resolvedJobStore.save(jobId, failedJob);
    await stopAllServers();
    throw err;
  }
}
