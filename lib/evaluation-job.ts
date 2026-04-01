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
      finishedAt: startedAt,
      status: 'succeeded',
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
