import { resolve } from 'node:path';
import { DEFAULT_OUTPUT_DIR, createFileJobStore, DEFAULT_JOBS_DIR, persistReport, resolveArtifacts } from '../infrastructure/index.js';
import { buildEachReport } from './each-evaluation-report.js';
import type { EachSkillResult } from './each-evaluation-report.js';
import type { Artifact, JobStore, ProgressCallback, Report, VariantSummary } from '../types.js';

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
  runSingleEvaluation: (options: RunSingleEvaluationOptions) => Promise<{ report: Report; filePath: string | null }>;
}): Promise<{ report: Report; filePath: string | null }> {
  const skillResults: EachSkillResult[] = [];
  let totalCostUSD = 0;

  for (let i = 0; i < skillEntries.length; i++) {
    const entry = skillEntries[i];
    onSkillProgress?.({ phase: 'start', skill: entry.name, current: i + 1, total: skillEntries.length });

    const skillArtifacts = resolveArtifacts(resolve(skillDir), ['baseline', entry.skillPath]).map((artifact) => (
      artifact.name === entry.skillPath ? { ...artifact, name: 'skill' } : artifact
    ));
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
  });
  const filePath = persistReport(combinedReport, outputDir);
  const resolvedJobStore = persistJob ? (jobStore ?? createFileJobStore(DEFAULT_JOBS_DIR)) : null;
  if (resolvedJobStore) await resolvedJobStore.save(job.jobId, job);
  return { report: combinedReport, filePath };
}
