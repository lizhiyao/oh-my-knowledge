import { createFileJobStore, DEFAULT_JOBS_DIR } from '../infrastructure/index.js';
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
  EvaluationJob,
  EvaluationRequest,
  EvaluationRun,
  JobStore,
} from '../types.js';

interface BuildEvaluationRequestOptions {
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
}

export interface EvaluationRunState {
  request: EvaluationRequest;
  runId: string;
  jobId: string;
  createdAt: string;
  startedAt: string;
  initialRun: EvaluationRun;
  runningJob: EvaluationJob;
  resolvedJobStore: JobStore | null;
}

export async function initializeEvaluationRunState({
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
}: BuildEvaluationRequestOptions & {
  runId: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
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

export function finalizeSuccessfulEvaluationRun(state: EvaluationRunState) {
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
  return { finishedAt, run, job };
}

export async function persistSuccessfulEvaluationJob(state: EvaluationRunState, job: EvaluationJob): Promise<void> {
  if (state.resolvedJobStore) {
    await state.resolvedJobStore.save(state.jobId, job);
  }
}

export async function persistFailedEvaluationJob(state: EvaluationRunState, err: unknown): Promise<void> {
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
