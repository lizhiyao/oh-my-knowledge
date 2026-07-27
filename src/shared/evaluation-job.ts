import { isRfc3339Timestamp } from './timestamp.js';
import type {
  Artifact,
  EvalBudget,
  EvaluationJob,
  EvaluationRequest,
  EvaluationRun,
} from '../types/index.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function isOptionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || isRfc3339Timestamp(value);
}

function isOptionalBudget(value: unknown): value is EvalBudget | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return [
    value.totalUSD,
    value.perSampleUSD,
    value.perSampleMs,
  ].every((metric) =>
    metric === undefined
    || (
      typeof metric === 'number'
      && Number.isFinite(metric)
      && metric >= 0
      && metric <= Number.MAX_SAFE_INTEGER
    )
  );
}

function isArtifact(value: unknown): value is Artifact {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string'
    && value.name.length > 0
    && (
      value.kind === 'baseline'
      || value.kind === 'skill'
      || value.kind === 'prompt'
      || value.kind === 'agent'
      || value.kind === 'workflow'
    )
    && (
      value.source === 'baseline'
      || value.source === 'variant-name'
      || value.source === 'file-path'
      || value.source === 'git'
      || value.source === 'inline'
      || value.source === 'custom'
    )
    && (value.content === null || typeof value.content === 'string')
    && [
      value.contentHash,
      value.locator,
      value.ref,
      value.resolvedCommit,
      value.cwd,
      value.skillRoot,
      value.execRoot,
    ].every(isOptionalString)
    && (
      value.experimentRole === undefined
      || value.experimentRole === 'control'
      || value.experimentRole === 'treatment'
    )
    && (
      value.allowedSkills === undefined
      || (
        Array.isArray(value.allowedSkills)
        && value.allowedSkills.every(
          (skill) => typeof skill === 'string' && skill.length > 0,
        )
        && new Set(value.allowedSkills).size === value.allowedSkills.length
      )
    )
    && (value.metadata === undefined || isRecord(value.metadata));
}

export function isSafeEvaluationJobId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value);
}

export function isValidEvaluationRequest(value: unknown): value is EvaluationRequest {
  if (!isRecord(value)) return false;
  return typeof value.samplesPath === 'string'
    && typeof value.skillDir === 'string'
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isArtifact)
    && new Set(value.artifacts.map((artifact) => artifact.name)).size === value.artifacts.length
    && typeof value.model === 'string'
    && value.model.trim().length > 0
    && typeof value.executor === 'string'
    && value.executor.trim().length > 0
    && typeof value.noJudge === 'boolean'
    && Number.isSafeInteger(value.concurrency)
    && (value.concurrency as number) > 0
    && typeof value.noCache === 'boolean'
    && typeof value.dryRun === 'boolean'
    && Array.isArray(value.judgeModels)
    && value.judgeModels.length > 0
    && value.judgeModels.every((judge) =>
      isRecord(judge)
      && typeof judge.executor === 'string'
      && judge.executor.trim().length > 0
      && typeof judge.model === 'string'
      && judge.model.trim().length > 0
    )
    && isOptionalString(value.project)
    && isOptionalString(value.owner)
    && (
      value.tags === undefined
      || (
        Array.isArray(value.tags)
        && value.tags.every((tag) => typeof tag === 'string')
      )
    )
    && isOptionalPositiveInteger(value.timeoutMs)
    && isOptionalPositiveInteger(value.repeat)
    && (
      value.holdoutRatio === undefined
      || (
        typeof value.holdoutRatio === 'number'
        && Number.isFinite(value.holdoutRatio)
        && value.holdoutRatio > 0
        && value.holdoutRatio < 1
      )
    )
    && isOptionalBoolean(value.batch)
    && isOptionalPositiveInteger(value.judgeRepeat)
    && isOptionalBoolean(value.bootstrap)
    && isOptionalPositiveInteger(value.bootstrapSamples)
    && isOptionalBoolean(value.lengthDebias)
    && isOptionalBudget(value.budget)
    && isOptionalBoolean(value.strictBaseline)
    && (
      value.retry === undefined
      || (Number.isSafeInteger(value.retry) && (value.retry as number) >= 0)
    )
    && isOptionalBoolean(value.noDiagnostic)
    && (
      value.effort === undefined
      || value.effort === 'low'
      || value.effort === 'medium'
      || value.effort === 'high'
      || value.effort === 'xhigh'
      || value.effort === 'max'
    );
}

export function isValidEvaluationRun(
  value: unknown,
  expectedRunId?: string,
): value is EvaluationRun {
  if (
    !isRecord(value)
    || typeof value.runId !== 'string'
    || value.runId.length === 0
    || (expectedRunId !== undefined && value.runId !== expectedRunId)
    || !isRfc3339Timestamp(value.startedAt)
    || !isOptionalTimestamp(value.finishedAt)
    || (
      value.status !== 'running'
      && value.status !== 'succeeded'
      && value.status !== 'failed'
      && value.status !== 'cancelled'
    )
  ) return false;
  if (value.status === 'running') return value.finishedAt === undefined;
  return value.finishedAt !== undefined
    && Date.parse(value.finishedAt) >= Date.parse(value.startedAt);
}

function jobStateIsConsistent(job: EvaluationJob): boolean {
  if (job.status === 'queued') {
    return job.startedAt === undefined
      && job.finishedAt === undefined
      && job.runId === undefined
      && job.resultReportId === undefined
      && job.error === undefined
      && job.errorCategory === undefined;
  }
  if (job.status === 'running') {
    return job.startedAt !== undefined
      && job.finishedAt === undefined
      && typeof job.runId === 'string'
      && job.runId.length > 0
      && job.resultReportId === undefined
      && job.error === undefined
      && job.errorCategory === undefined;
  }
  if (job.status === 'succeeded') {
    return job.startedAt !== undefined
      && job.finishedAt !== undefined
      && typeof job.runId === 'string'
      && job.runId.length > 0
      && typeof job.resultReportId === 'string'
      && job.resultReportId.length > 0
      && job.error === undefined
      && job.errorCategory === undefined;
  }
  if (job.status === 'failed') {
    return job.finishedAt !== undefined
      && typeof job.error === 'string'
      && job.error.length > 0
      && job.errorCategory !== undefined
      && job.resultReportId === undefined;
  }
  return job.finishedAt !== undefined && job.resultReportId === undefined;
}

export function isValidEvaluationJob(
  value: unknown,
  expectedJobId?: string,
): value is EvaluationJob {
  if (
    !isRecord(value)
    || !isSafeEvaluationJobId(value.jobId)
    || (expectedJobId !== undefined && value.jobId !== expectedJobId)
    || (
      value.status !== 'queued'
      && value.status !== 'running'
      && value.status !== 'succeeded'
      && value.status !== 'failed'
      && value.status !== 'cancelled'
    )
    || !isRfc3339Timestamp(value.createdAt)
    || !isValidEvaluationRequest(value.request)
    || !isOptionalTimestamp(value.updatedAt)
    || !isOptionalTimestamp(value.startedAt)
    || !isOptionalTimestamp(value.finishedAt)
    || !isOptionalString(value.runId)
    || !isOptionalString(value.resultReportId)
    || !isOptionalString(value.error)
    || (
      value.errorCategory !== undefined
      && value.errorCategory !== 'user'
      && value.errorCategory !== 'executor'
      && value.errorCategory !== 'judge'
      && value.errorCategory !== 'system'
    )
  ) return false;

  const createdAtMs = Date.parse(value.createdAt);
  const startedAtMs = value.startedAt === undefined ? undefined : Date.parse(value.startedAt);
  const finishedAtMs = value.finishedAt === undefined ? undefined : Date.parse(value.finishedAt);
  const updatedAtMs = value.updatedAt === undefined ? undefined : Date.parse(value.updatedAt);
  if (
    (startedAtMs !== undefined && startedAtMs < createdAtMs)
    || (finishedAtMs !== undefined && finishedAtMs < createdAtMs)
    || (
      startedAtMs !== undefined
      && finishedAtMs !== undefined
      && finishedAtMs < startedAtMs
    )
    || (
      updatedAtMs !== undefined
      && updatedAtMs < Math.max(createdAtMs, startedAtMs ?? createdAtMs, finishedAtMs ?? createdAtMs)
    )
  ) return false;
  return jobStateIsConsistent(value as unknown as EvaluationJob);
}

export function evaluationRequestsEqual(
  left: EvaluationRequest,
  right: EvaluationRequest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
