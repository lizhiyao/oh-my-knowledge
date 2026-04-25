import { resolve } from 'node:path';
import { DEFAULT_OUTPUT_DIR, generateRunId, persistReport } from '../eval-core/evaluation-reporting.js';
import { buildEvaluationRequest, createEvaluationRun, createSucceededJob, finalizeEvaluationRun } from '../eval-core/evaluation-job.js';
import { createFileJobStore, DEFAULT_JOBS_DIR } from '../server/job-store.js';
import { resolveArtifacts } from '../inputs/skill-loader.js';
import type { Artifact, JobStore, ProgressCallback, Report, VarianceData, VariantResult, VariantSummary } from '../types.js';

interface RunSingleEvaluationOptions {
  samplesPath: string;
  skillDir: string;
  artifacts: Artifact[];
  model: string;
  judgeModel: string;
  outputDir: null;
  noJudge: boolean;
  concurrency: number;
  timeoutMs?: number;
  executorName: string;
  judgeExecutorName?: string;
  jobStore: null;
  persistJob: false;
  onProgress: ProgressCallback | null;
  skipPreflight: boolean;
  mcpConfig?: string;
  verbose: boolean;
  /** Forwarded to grade(); each sample × dimension is judged N times. Default 1. */
  judgeRepeat?: number;
  /** Forwarded to pipeline; ≥ 2 entries triggers multi-judge ensemble mode. */
  judgeModels?: import('../types.js').JudgeConfig[];
  /** v0.21 Phase 3a length-debias toggle. Default true. */
  lengthDebias?: boolean;
}

export interface EachSkillResult {
  name: string;
  artifactHash: string;
  samplesPath: string;
  sampleCount: number;
  summary: Record<string, VariantSummary>;
  /** repeat > 1 时由 runMultiple 聚合,承载三层独立 variance + t 检验 */
  variance?: VarianceData;
  results: Array<{
    sample_id: string;
    variants: {
      baseline: VariantResult;
      skill: VariantResult;
    };
  }>;
}

function buildEachOverview(skillResults: EachSkillResult[], totalCostUSD: number) {
  return {
    totalArtifacts: skillResults.length,
    totalSamples: skillResults.reduce((sum, skill) => sum + skill.sampleCount, 0),
    totalCostUSD: Number(totalCostUSD.toFixed(6)),
    artifacts: skillResults.map((skill) => {
      const baselineSummary = skill.summary.baseline;
      const artifactSummary = skill.summary.skill;
      const baselineScore = baselineSummary?.avgCompositeScore ?? baselineSummary?.avgLlmScore ?? null;
      const artifactScore = artifactSummary?.avgCompositeScore ?? artifactSummary?.avgLlmScore ?? null;
      if (typeof baselineScore !== 'number' || typeof artifactScore !== 'number' || baselineScore <= 0) {
        return { name: skill.name, baselineScore, artifactScore, improvement: '-' };
      }
      const delta = ((artifactScore - baselineScore) / baselineScore * 100).toFixed(0);
      const improvement = artifactScore >= baselineScore ? `+${delta}%` : `${delta}%`;
      return { name: skill.name, baselineScore, artifactScore, improvement };
    }),
  };
}

export function buildEachReport({
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
  dryRun,
  concurrency,
  timeoutMs,
  totalCostUSD,
  repeat,
}: {
  skillDir: string;
  skillEntries: Array<{ name: string; skillPath: string; samplesPath: string }>;
  skillResults: EachSkillResult[];
  model: string;
  judgeModel: string;
  noJudge: boolean;
  executorName: string;
  judgeExecutorName?: string;
  project?: string;
  owner?: string;
  tags?: string[];
  dryRun: boolean;
  concurrency: number;
  timeoutMs?: number;
  totalCostUSD: number;
  repeat?: number;
}) {
  const runId = generateRunId(['each']);
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
    judgeModel: noJudge ? null : judgeModel,
    executor: executorName,
    judgeExecutor: judgeExecutorName || executorName,
    noJudge,
    concurrency,
    timeoutMs,
    noCache: false,
    dryRun,
    blind: false,
    project,
    owner,
    tags,
    repeat,
    each: true,
  });
  const createdAt = new Date().toISOString();
  const { run: initialRun, startedAt } = createEvaluationRun(runId, createdAt);
  const finishedAt = new Date().toISOString();
  const run = finalizeEvaluationRun(initialRun, finishedAt);
  const job = createSucceededJob({
    jobId: `job-${runId}`,
    runId,
    reportId: runId,
    request,
    createdAt,
    startedAt,
    finishedAt,
  });
  const totalSampleCount = skillResults.reduce((sum, skill) => sum + skill.sampleCount, 0);

  return {
    report: {
      id: runId,
      each: true,
      meta: {
        variants: skillEntries.map((entry) => entry.name),
        model,
        judgeModel: noJudge ? null : judgeModel,
        executor: executorName,
        sampleCount: totalSampleCount,
        taskCount: totalSampleCount * 2,
        totalCostUSD: Number(totalCostUSD.toFixed(6)),
        timestamp: new Date().toISOString(),
        cliVersion: '',
        nodeVersion: process.version,
        artifactHashes: Object.fromEntries(
          skillResults.map((skill) => [skill.name, skill.artifactHash || 'no-skill']),
        ),
        request,
        run,
        job,
      },
      summary: {},
      results: [],
      overview: buildEachOverview(skillResults, totalCostUSD),
      artifacts: skillResults,
    } satisfies Report,
    job,
  };
}

export async function executeEachEvaluationRuns({
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
  skipPreflight = false,
  mcpConfig,
  verbose = false,
  repeat,
  judgeRepeat,
  judgeModels,
  lengthDebias,
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
  skipPreflight?: boolean;
  mcpConfig?: string;
  verbose?: boolean;
  repeat?: number;
  judgeRepeat?: number;
  judgeModels?: import('../types.js').JudgeConfig[];
  lengthDebias?: boolean;
  runSingleEvaluation: (options: RunSingleEvaluationOptions) => Promise<{ report: Report; filePath: string | null }>;
}): Promise<{ report: Report; filePath: string | null }> {
  const skillResults: EachSkillResult[] = [];
  let totalCostUSD = 0;

  for (let i = 0; i < skillEntries.length; i++) {
    const entry = skillEntries[i];
    onSkillProgress?.({ phase: 'start', skill: entry.name, current: i + 1, total: skillEntries.length });

    // each mode 的实验结构固定为"baseline (control) vs skill (treatment)"。
    // 显式在 artifact 上填 experimentRole，下游 buildVariantConfig 直接读取。
    const skillArtifacts = resolveArtifacts(resolve(skillDir), ['baseline', entry.skillPath]).map((artifact) => {
      if (artifact.name === entry.skillPath) {
        return { ...artifact, name: 'skill', experimentRole: 'treatment' as const };
      }
      return { ...artifact, experimentRole: 'control' as const };
    });
    const { report } = await runSingleEvaluation({
      samplesPath: entry.samplesPath,
      skillDir,
      artifacts: skillArtifacts,
      model,
      judgeModel,
      outputDir: null,
      noJudge,
      concurrency,
      timeoutMs,
      executorName,
      judgeExecutorName,
      jobStore: null,
      persistJob: false,
      onProgress,
      skipPreflight: skipPreflight || i > 0,
      mcpConfig,
      verbose,
      judgeRepeat,
      judgeModels,
      lengthDebias,
    });

    skillResults.push({
      name: entry.name,
      artifactHash: report.meta.artifactHashes?.skill || '',
      samplesPath: entry.samplesPath,
      sampleCount: report.meta.sampleCount,
      summary: {
        baseline: report.summary.baseline || ({} as VariantSummary),
        skill: (report.summary.skill || {}) as VariantSummary,
      },
      // runMultiple 跑 N 次后会把 variance 挂到 report.variance,这里搬到 skill 维度
      ...(report.variance ? { variance: report.variance } : {}),
      results: report.results.map((result) => ({
        sample_id: result.sample_id,
        variants: {
          baseline: result.variants.baseline || result.variants['baseline'],
          skill: result.variants.skill,
        },
      })),
    });

    totalCostUSD += report.meta.totalCostUSD;
    onSkillProgress?.({ phase: 'done', skill: entry.name, current: i + 1, total: skillEntries.length });
  }

  const { report: combinedReport, job } = buildEachReport({
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
    dryRun: false,
    concurrency,
    timeoutMs,
    totalCostUSD,
    repeat,
  });
  const filePath = persistReport(combinedReport, outputDir);
  const resolvedJobStore = persistJob ? (jobStore ?? createFileJobStore(DEFAULT_JOBS_DIR)) : null;
  if (resolvedJobStore) await resolvedJobStore.save(job.jobId, job);
  return { report: combinedReport, filePath };
}
