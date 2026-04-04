import type { Artifact, EvaluationErrorCategory, EvaluationJob, EvaluationRequest, EvaluationRun } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

export function buildEvaluationRequest({
  samplesPath,
  skillDir,
  artifacts,
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
  project,
  owner,
  tags,
}: {
  samplesPath: string;
  skillDir: string;
  artifacts: Artifact[];
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
  project?: string;
  owner?: string;
  tags?: string[];
}): EvaluationRequest {
  return {
    samplesPath,
    skillDir,
    artifacts,
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
    project,
    owner,
    tags,
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
    updatedAt: createdAt,
    request,
  };
}

export function markJobRunning(job: EvaluationJob, runId: string, startedAt: string = nowIso()): EvaluationJob {
  return {
    ...job,
    status: 'running',
    runId,
    startedAt,
    updatedAt: startedAt,
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
    updatedAt: finishedAt,
    request,
    runId,
    resultReportId: reportId,
  };
}

export function classifyEvaluationError(error: string): EvaluationErrorCategory {
  const normalized = error.toLowerCase();
  if (
    normalized.includes('missing required field')
    || normalized.includes('invalid samples file')
    || normalized.includes('skill not found')
    || normalized.includes('samples file')
    || normalized.includes('未发现任何 skill')
  ) {
    return 'user';
  }
  if (
    normalized.includes('judge')
    || normalized.includes('semantic_similarity')
    || normalized.includes('failed to parse judge response')
  ) {
    return 'judge';
  }
  if (
    normalized.includes('timed out')
    || normalized.includes('api request timed out')
    || normalized.includes('execution timed out')
    || normalized.includes('mcp')
    || normalized.includes('network')
  ) {
    return 'executor';
  }
  return 'system';
}

export function createFailedJob({
  job,
  error,
  errorCategory = classifyEvaluationError(error),
  finishedAt = nowIso(),
}: {
  job: EvaluationJob;
  error: string;
  errorCategory?: EvaluationErrorCategory;
  finishedAt?: string;
}): EvaluationJob {
  return {
    ...job,
    status: 'failed',
    finishedAt,
    updatedAt: finishedAt,
    error,
    errorCategory,
  };
}
