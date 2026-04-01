import type { EvaluandSpec, EvaluationJob, EvaluationRequest, EvaluationRun } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

export function buildEvaluationRequest({
  samplesPath,
  skillDir,
  evaluands,
  model,
  judgeModel,
  executor,
  judgeExecutor,
  noJudge,
  concurrency,
  timeoutMs,
  noCache,
  dryRun,
  blind,
}: {
  samplesPath: string;
  skillDir: string;
  evaluands: EvaluandSpec[];
  model: string;
  judgeModel: string | null;
  executor: string;
  judgeExecutor?: string | null;
  noJudge: boolean;
  concurrency: number;
  timeoutMs?: number;
  noCache: boolean;
  dryRun: boolean;
  blind: boolean;
}): EvaluationRequest {
  return {
    samplesPath,
    skillDir,
    evaluands,
    model,
    judgeModel,
    executor,
    judgeExecutor,
    noJudge,
    concurrency,
    timeoutMs,
    noCache,
    dryRun,
    blind,
  };
}

export function createEvaluationRun(runId: string, startedAt: string = nowIso()): { run: EvaluationRun; startedAt: string } {
  return {
    startedAt,
    run: {
      runId,
      startedAt,
      status: 'running',
    },
  };
}

export function finalizeEvaluationRun(run: EvaluationRun, finishedAt: string = nowIso()): EvaluationRun {
  return {
    ...run,
    finishedAt,
    status: 'succeeded',
  };
}

export function failEvaluationRun(run: EvaluationRun, finishedAt: string = nowIso()): EvaluationRun {
  return {
    ...run,
    finishedAt,
    status: 'failed',
  };
}

export function createQueuedJob({
  jobId,
  request,
  createdAt = nowIso(),
}: {
  jobId: string;
  request: EvaluationRequest;
  createdAt?: string;
}): EvaluationJob {
  return {
    jobId,
    status: 'queued',
    createdAt,
    request,
  };
}

export function markJobRunning(job: EvaluationJob, runId: string, startedAt: string = nowIso()): EvaluationJob {
  return {
    ...job,
    status: 'running',
    runId,
    startedAt,
  };
}

export function createSucceededJob({
  jobId,
  runId,
  reportId,
  request,
  createdAt,
  startedAt,
  finishedAt,
}: {
  jobId: string;
  runId: string;
  reportId: string;
  request: EvaluationRequest;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
}): EvaluationJob {
  return {
    jobId,
    status: 'succeeded',
    createdAt,
    startedAt,
    finishedAt,
    request,
    runId,
    resultReportId: reportId,
  };
}

export function createFailedJob({
  job,
  error,
  finishedAt = nowIso(),
}: {
  job: EvaluationJob;
  error: string;
  finishedAt?: string;
}): EvaluationJob {
  return {
    ...job,
    status: 'failed',
    finishedAt,
    error,
  };
}
