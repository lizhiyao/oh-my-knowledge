import { aggregateReport } from '../domain/index.js';
import { DEFAULT_OUTPUT_DIR, generateRunId, persistReport } from '../infrastructure/index.js';
import { executeTasks, preflight, stopAllServers } from '../runtime/index.js';
import { finalizeEvaluationReport } from './evaluation-report.js';
import {
  finalizeSuccessfulEvaluationRun,
  initializeEvaluationRunState,
  persistFailedEvaluationJob,
  persistSuccessfulEvaluationJob,
} from './evaluation-run-state.js';
import type {
  Artifact,
  ExecutorFn,
  JobStore,
  ProgressCallback,
  Report,
  Sample,
  Task,
} from '../types.js';

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
  });

  try {
    if (!skipPreflight) {
      if (onProgress) onProgress({ phase: 'preflight', jobId: runState.jobId });
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

    const { run, job } = finalizeSuccessfulEvaluationRun(runState);
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
      }),
      results,
      artifacts,
      variantNames,
      blind,
      samplesPath,
    });
    const filePath = persistReport(report, outputDir);
    await persistSuccessfulEvaluationJob(runState, job);
    return { report, filePath };
  } catch (err: unknown) {
    await persistFailedEvaluationJob(runState, err);
    throw err;
  } finally {
    await stopAllServers();
  }
}
