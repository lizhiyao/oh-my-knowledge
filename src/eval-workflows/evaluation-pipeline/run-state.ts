/**
 * evaluation pipeline 的运行状态生命周期。
 *
 * 把 `EvaluationRunState` + 4 个 helper(initialize / finalizeSuccessfulRun /
 * persistSuccessfulJob / persistFailedJob)从 evaluation-pipeline.ts 拆出来,
 * 让 orchestrator 主体回归「编排」单职责。这些 helper 之间是线性时序耦合
 * (init → preflight → executeTasks → finalize → persist),向上只被
 * `executeEvaluationPipeline` 调用,向下只依赖 `eval-core/evaluation-job` 与
 * `server/job-store` 的纯 job-store 抽象,与 task execution / report assembly
 * 解耦。
 *
 * 不再单独 export 给测试 —— job 生命周期通过 orchestrator 间接验证,无独立单测。
 */

import {
  buildEvaluationRequest,
  createFailedJob,
  createEvaluationRun,
  createQueuedJob,
  createSucceededJob,
  finalizeEvaluationRun,
  markJobRunning,
  failEvaluationRun,
} from '../../eval-core/evaluation-job.js';
import {
  createFileJobStore,
  DEFAULT_JOBS_DIR,
} from '../../server/job-store.js';
import type {
  Artifact,
  EvaluationJob,
  EvaluationRequest,
  EvaluationRun,
  JobStore,
} from '../../types/index.js';

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
  judgeModels?: import('../../types/index.js').JudgeConfig[];
  bootstrap?: boolean;
  bootstrapSamples?: number;
  lengthDebias?: boolean;
  budget?: import('../../types/index.js').EvalBudget;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}): Promise<EvaluationRunState> {
  const effectiveJudges: import('../../types/index.js').JudgeConfig[] = judgeModels && judgeModels.length > 0
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

export function finalizeSuccessfulRun(state: EvaluationRunState) {
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

export async function persistSuccessfulJob(state: EvaluationRunState, job: EvaluationJob): Promise<void> {
  if (state.resolvedJobStore) {
    await state.resolvedJobStore.save(state.jobId, job);
  }
}

export async function persistFailedJob(state: EvaluationRunState, err: unknown): Promise<void> {
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
