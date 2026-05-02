import { dirname, resolve } from 'node:path';
import { DEFAULT_OUTPUT_DIR, generateRunId, getCliVersion, getGitInfo, persistReport } from '../eval-core/evaluation-reporting.js';
import { buildEvaluationRequest, createEvaluationRun, createSucceededJob, finalizeEvaluationRun } from '../eval-core/evaluation-job.js';
import { getExecutorRuntimeFingerprint } from '../executors/runtime-fingerprint.js';
import { createFileJobStore, DEFAULT_JOBS_DIR } from '../server/job-store.js';
import { resolveArtifacts } from '../inputs/skill-loader.js';
import type {
  Artifact,
  BatchEvaluationReport,
  BatchEvaluationItem,
  EvaluationReport,
  ExecutorRuntimeFingerprint,
  JobStore,
  ProgressCallback,
  VariantSummary,
} from '../types/index.js';

interface RunSingleEvaluationOptions {
  samplesPath: string;
  skillDir: string;
  artifacts: Artifact[];
  model: string;
  judgeModel: string;
  outputDir: string | null;
  noJudge: boolean;
  concurrency: number;
  timeoutMs?: number;
  noCache: boolean;
  executorName: string;
  judgeExecutorName?: string;
  jobStore: null;
  persistJob: false;
  onProgress: ProgressCallback | null;
  skipConnectivity: boolean;
  lang?: 'zh' | 'en';
  mcpConfig?: string;
  verbose: boolean;
  runId?: string;
  /** Forwarded to grade(); each sample x dimension is judged N times. Default 1. */
  judgeRepeat?: number;
  /** Forwarded to pipeline; >= 2 entries triggers multi-judge ensemble mode. */
  judgeModels?: import('../types/index.js').JudgeConfig[];
  /** length-debias toggle. Default true. */
  lengthDebias?: boolean;
}

interface CompletedBatchSkillRun {
  name: string;
  skillPath: string;
  samplesPath: string;
  report: EvaluationReport;
  filePath: string | null;
}

function commonRuntime(runtimes: Record<string, ExecutorRuntimeFingerprint>): ExecutorRuntimeFingerprint | undefined {
  const values = Object.values(runtimes);
  if (values.length === 0) return undefined;
  const first = values[0];
  return values.every((runtime) => runtime.fingerprint === first.fingerprint) ? first : undefined;
}

function safeRunIdPart(value: string): string {
  return value
    .replaceAll(/[\\/:]/g, '-')
    .replaceAll(/[^a-zA-Z0-9._@-]/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'skill';
}

function reportSummarySnapshot(report: EvaluationReport, treatmentVariant: string): Record<string, VariantSummary> {
  return {
    baseline: report.summary.baseline || ({} as VariantSummary),
    [treatmentVariant]: report.summary[treatmentVariant] || ({} as VariantSummary),
  };
}

function buildBatchItems(skillResults: CompletedBatchSkillRun[]): BatchEvaluationItem[] {
  return skillResults.map(({ name, skillPath, samplesPath, report, filePath }) => ({
    name,
    skillPath,
    samplesPath,
    reportId: report.id,
    reportPath: filePath,
    status: 'completed',
    sampleCount: report.meta.sampleCount,
    totalCostUSD: report.meta.totalCostUSD,
    artifactHash: report.meta.artifactHashes?.[name] || null,
    summary: reportSummarySnapshot(report, name),
    ...(report.variance ? { variance: report.variance } : {}),
  }));
}

function buildExecutorRuntimesBySkill({
  skillDir,
  skillResults,
  executorName,
  model,
}: {
  skillDir: string;
  skillResults: CompletedBatchSkillRun[];
  executorName: string;
  model: string;
}): Record<string, ExecutorRuntimeFingerprint> {
  const executorRuntimes: Record<string, ExecutorRuntimeFingerprint> = {};
  for (const skill of skillResults) {
    executorRuntimes[skill.name] =
      skill.report.meta.executorRuntimes?.[skill.name]
      ?? skill.report.meta.executorRuntime
      ?? getExecutorRuntimeFingerprint(executorName, model, {
        skillDir: skill.skillPath ? dirname(skill.skillPath) : skillDir,
      });
  }
  return executorRuntimes;
}

export function buildBatchEvaluationReport({
  batchRunId,
  skillDir,
  skillEntries,
  skillResults,
  model,
  judgeModel,
  noJudge,
  executorName,
  judgeExecutorName,
  project,
  owner,
  tags,
  concurrency,
  timeoutMs,
  totalCostUSD,
  repeat,
  judgeModels,
  noCache,
}: {
  batchRunId: string;
  skillDir: string;
  skillEntries: Array<{ name: string; skillPath: string; samplesPath: string }>;
  skillResults: CompletedBatchSkillRun[];
  model: string;
  judgeModel: string;
  noJudge: boolean;
  executorName: string;
  judgeExecutorName?: string;
  project?: string;
  owner?: string;
  tags?: string[];
  concurrency: number;
  timeoutMs?: number;
  totalCostUSD: number;
  repeat?: number;
  judgeModels?: import('../types/index.js').JudgeConfig[];
  noCache: boolean;
}): { report: BatchEvaluationReport; job: import('../types/index.js').EvaluationJob } {
  const effectiveBatchJudges = judgeModels && judgeModels.length > 0
    ? judgeModels
    : [{ executor: judgeExecutorName || executorName, model: judgeModel }];
  const request = buildEvaluationRequest({
    samplesPath: '',
    skillDir,
    artifacts: skillEntries.map((entry) => ({
      name: entry.name,
      kind: 'skill',
      source: 'file-path',
      content: null,
      locator: entry.skillPath,
    })),
    model,
    executor: executorName,
    noJudge,
    concurrency,
    timeoutMs,
    noCache,
    dryRun: false,
    blind: false,
    project,
    owner,
    tags,
    repeat,
    judgeModels: effectiveBatchJudges,
    batch: true,
  });
  const createdAt = new Date().toISOString();
  const { run: initialRun, startedAt } = createEvaluationRun(batchRunId, createdAt);
  const finishedAt = new Date().toISOString();
  const run = finalizeEvaluationRun(initialRun, finishedAt);
  const job = createSucceededJob({
    jobId: `job-${batchRunId}`,
    runId: batchRunId,
    reportId: batchRunId,
    request,
    createdAt,
    startedAt,
    finishedAt,
  });
  const sampleCount = skillResults.reduce((sum, skill) => sum + skill.report.meta.sampleCount, 0);
  const executorRuntimes = buildExecutorRuntimesBySkill({ skillDir, skillResults, executorName, model });
  const executorRuntime = commonRuntime(executorRuntimes)
    ?? Object.values(executorRuntimes)[0]
    ?? getExecutorRuntimeFingerprint(executorName, model, { skillDir });
  const totalCostReported = skillResults.every((skill) =>
    skill.report.meta.totalCostReported !== false
    && Object.values(skill.report.summary || {}).every((variant) =>
      variant.execCostReported !== false && variant.judgeCostReported !== false));

  const judgeModelsMeta: import('../types/index.js').JudgeRuntimeEntry[] = effectiveBatchJudges.map((jc) => ({
    executor: jc.executor,
    model: jc.model,
    ...(noJudge ? {} : { runtime: getExecutorRuntimeFingerprint(jc.executor, jc.model, { skillDir }) }),
  }));

  const report: BatchEvaluationReport = {
    kind: 'batch-evaluation',
    id: batchRunId,
    mode: 'skill',
    meta: {
      mode: 'skill',
      model,
      executor: executorName,
      skillDir,
      sampleCount,
      taskCount: sampleCount * 2,
      totalArtifacts: skillResults.length,
      totalCostUSD: Number(totalCostUSD.toFixed(6)),
      ...(totalCostReported ? {} : { totalCostReported: false }),
      timestamp: finishedAt,
      cliVersion: getCliVersion(),
      nodeVersion: process.version,
      executorRuntime,
      executorRuntimes,
      judgeModels: judgeModelsMeta,
      ...(noJudge ? { noJudge: true } : {}),
      request,
      run,
      job,
      gitInfo: getGitInfo(),
    },
    items: buildBatchItems(skillResults),
  };

  return { report, job };
}

export async function executeBatchEvaluationRuns({
  skillDir,
  skillEntries,
  model,
  judgeModel,
  outputDir = DEFAULT_OUTPUT_DIR,
  project,
  owner,
  tags,
  noJudge = false,
  concurrency = 1,
  timeoutMs,
  executorName,
  judgeExecutorName,
  jobStore = null,
  persistJob = true,
  onProgress = null,
  onSkillProgress = null,
  skipConnectivity = false,
  lang = 'zh',
  mcpConfig,
  verbose = false,
  repeat,
  judgeRepeat,
  judgeModels,
  lengthDebias,
  noCache = false,
  strictBaseline,
  variantAllowedSkills,
  runSingleEvaluation,
}: {
  skillDir: string;
  skillEntries: Array<{ name: string; skillPath: string; samplesPath: string }>;
  model: string;
  judgeModel: string;
  outputDir?: string | null;
  project?: string;
  owner?: string;
  tags?: string[];
  noJudge?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  executorName: string;
  judgeExecutorName?: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  onProgress?: ProgressCallback | null;
  onSkillProgress?: ((info: { phase: string; skill: string; current: number; total: number }) => void) | null;
  skipConnectivity?: boolean;
  lang?: 'zh' | 'en';
  mcpConfig?: string;
  verbose?: boolean;
  repeat?: number;
  judgeRepeat?: number;
  judgeModels?: import('../types/index.js').JudgeConfig[];
  lengthDebias?: boolean;
  noCache?: boolean;
  /** strict-baseline default. Forwarded to per-skill resolveArtifacts. */
  strictBaseline?: boolean;
  /** explicit per-variant allowedSkills override. */
  variantAllowedSkills?: Record<string, string[]>;
  runSingleEvaluation: (options: RunSingleEvaluationOptions) => Promise<{ report: EvaluationReport; filePath: string | null }>;
}): Promise<{ report: BatchEvaluationReport; filePath: string | null }> {
  const batchRunId = generateRunId(['batch']);
  const skillResults: CompletedBatchSkillRun[] = [];
  let totalCostUSD = 0;

  for (let i = 0; i < skillEntries.length; i++) {
    const entry = skillEntries[i];
    onSkillProgress?.({ phase: 'start', skill: entry.name, current: i + 1, total: skillEntries.length });

    // Batch mode 的实验结构固定为 baseline control vs 当前 skill treatment。
    const perSkillAllowedSkills = variantAllowedSkills?.[entry.name] !== undefined
      ? { ...variantAllowedSkills, [entry.skillPath]: variantAllowedSkills[entry.name] }
      : variantAllowedSkills;
    const skillArtifacts = resolveArtifacts(
      resolve(skillDir),
      ['baseline', entry.skillPath],
      { strictBaseline, variantAllowedSkills: perSkillAllowedSkills },
    ).map((artifact) => {
      if (artifact.name === entry.skillPath) {
        return { ...artifact, name: entry.name, experimentRole: 'treatment' as const };
      }
      return { ...artifact, experimentRole: 'control' as const };
    });
    const childRunId = `${batchRunId}-${String(i + 1).padStart(2, '0')}-${safeRunIdPart(entry.name)}`;
    const { report, filePath } = await runSingleEvaluation({
      samplesPath: entry.samplesPath,
      skillDir,
      artifacts: skillArtifacts,
      model,
      judgeModel,
      outputDir,
      noJudge,
      concurrency,
      timeoutMs,
      noCache,
      executorName,
      judgeExecutorName,
      jobStore: null,
      persistJob: false,
      onProgress,
      skipConnectivity: skipConnectivity || i > 0,
      lang,
      mcpConfig,
      verbose,
      runId: childRunId,
      judgeRepeat,
      judgeModels,
      lengthDebias,
    });

    skillResults.push({
      name: entry.name,
      skillPath: entry.skillPath,
      samplesPath: entry.samplesPath,
      report,
      filePath,
    });

    totalCostUSD += report.meta.totalCostUSD;
    onSkillProgress?.({ phase: 'done', skill: entry.name, current: i + 1, total: skillEntries.length });
  }

  const { report: batchReport, job } = buildBatchEvaluationReport({
    batchRunId,
    skillDir,
    skillEntries,
    skillResults,
    model,
    judgeModel,
    noJudge,
    executorName,
    judgeExecutorName,
    project,
    owner,
    tags,
    concurrency,
    timeoutMs,
    totalCostUSD,
    repeat,
    judgeModels,
    noCache,
  });
  const filePath = persistReport(batchReport, outputDir);
  const resolvedJobStore = persistJob ? (jobStore ?? createFileJobStore(DEFAULT_JOBS_DIR)) : null;
  if (resolvedJobStore) await resolvedJobStore.save(job.jobId, job);
  return { report: batchReport, filePath };
}
