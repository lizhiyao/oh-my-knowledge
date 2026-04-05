import { resolve } from 'node:path';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from '../executor.js';
import { confidenceInterval, tTest } from '../statistics.js';
import { discoverEachSkills } from '../skill-loader.js';
import { DEFAULT_OUTPUT_DIR } from '../evaluation-core.js';
import { executeEvaluationPipeline } from './evaluation-pipeline.js';
import {
  buildDryRunEachArtifacts,
  buildDryRunTaskReport,
  executeEachEvaluationRuns,
  prepareEvaluationRun,
} from './evaluation-workflows.js';

import type {
  Report,
  Artifact,
  VarianceData,
  ExecutorFn,
  JobStore,
} from '../types.js';
import type { ProgressCallback } from '../evaluation-core.js';

interface DryRunTask {
  sample_id: string;
  variant: string;
  artifactKind: Artifact['kind'];
  artifactSource: Artifact['source'];
  executionStrategy: string;
  experimentType: string;
  cwd: string | null;
  promptPreview: string;
  hasRubric: boolean;
  hasAssertions: boolean;
  hasDimensions: boolean;
  hasSystem: boolean;
}

interface DryRunBase {
  dryRun: true;
  model: string;
  judgeModel: string;
  executor: string;
  skillDir: string;
  totalTasks: number;
}

export interface DryRunReport extends DryRunBase {
  variants: string[];
  samplesPath: string;
  tasks: DryRunTask[];
}

export interface RunEvaluationOptions {
  samplesPath: string;
  skillDir: string;
  variants?: string[];
  artifacts?: Artifact[];
  model?: string;
  judgeModel?: string;
  outputDir?: string | null;
  project?: string;
  owner?: string;
  tags?: string[];
  noJudge?: boolean;
  dryRun?: boolean;
  blind?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  noCache?: boolean;
  executorName?: string;
  judgeExecutorName?: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  onProgress?: ProgressCallback | null;
  skipPreflight?: boolean;
  mcpConfig?: string;
  verbose?: boolean;
}

export async function runEvaluation({
  samplesPath,
  skillDir,
  variants = ['v1', 'v2'],
  artifacts,
  model = DEFAULT_MODEL,
  judgeModel = JUDGE_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  project,
  owner,
  tags,
  noJudge = false,
  dryRun = false,
  blind = false,
  concurrency = 1,
  timeoutMs,
  noCache = false,
  executorName = 'claude',
  judgeExecutorName,
  jobStore = null,
  persistJob = true,
  onProgress = null,
  skipPreflight = false,
  mcpConfig,
  verbose = false,
}: RunEvaluationOptions): Promise<{ report: Report | DryRunReport; filePath: string | null }> {
  const { samples, artifacts: resolvedArtifacts, tasks, variantNames } = await prepareEvaluationRun({
    samplesPath,
    skillDir,
    variants,
    artifacts,
    dryRun,
    mcpConfig,
  });

  if (dryRun) {
    return {
      report: buildDryRunTaskReport({
        model,
        judgeModel,
        executorName,
        samplesPath,
        skillDir,
        tasks,
        variantNames,
      }),
      filePath: null,
    };
  }

  const executor: ExecutorFn = createExecutor(executorName);
  const judgeExecutor: ExecutorFn = createExecutor(judgeExecutorName || executorName);
  return executeEvaluationPipeline({
    samplesPath,
    skillDir,
    samples,
    tasks,
    artifacts: resolvedArtifacts,
    model,
    judgeModel,
    noJudge,
    executorName,
    judgeExecutorName: judgeExecutorName || executorName,
    executor,
    judgeExecutor,
    outputDir,
    project,
    owner,
    tags,
    blind,
    concurrency,
    timeoutMs,
    noCache,
    jobStore,
    persistJob,
    onProgress,
    skipPreflight,
    verbose,
  });
}

interface DryRunEachSkill {
  name: string;
  samplesPath: string;
  sampleCount: number;
  taskCount: number;
}

export interface DryRunEachReport extends DryRunBase {
  each: true;
  totalArtifacts: number;
  artifacts: DryRunEachSkill[];
}

export interface SkillProgressInfo {
  phase: string;
  skill: string;
  current: number;
  total: number;
}

export interface RunEachEvaluationOptions {
  skillDir: string;
  model?: string;
  judgeModel?: string;
  outputDir?: string | null;
  project?: string;
  owner?: string;
  tags?: string[];
  noJudge?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  executorName?: string;
  judgeExecutorName?: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  onProgress?: ProgressCallback | null;
  onSkillProgress?: ((info: SkillProgressInfo) => void) | null;
  skipPreflight?: boolean;
  mcpConfig?: string;
  verbose?: boolean;
}

export async function runEachEvaluation({
  skillDir,
  model = DEFAULT_MODEL,
  judgeModel = JUDGE_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  project,
  owner,
  tags,
  noJudge = false,
  dryRun = false,
  concurrency = 1,
  timeoutMs,
  executorName = 'claude',
  judgeExecutorName,
  jobStore = null,
  persistJob = true,
  onProgress = null,
  onSkillProgress = null,
  skipPreflight = false,
  mcpConfig,
  verbose = false,
}: RunEachEvaluationOptions): Promise<{ report: Report | DryRunEachReport; filePath: string | null }> {
  const skillEntries = discoverEachSkills(resolve(skillDir));
  if (skillEntries.length === 0) {
    throw new Error(`未发现带配对 eval-samples 的 skill：${skillDir}`);
  }

  if (dryRun) {
    const { artifacts: dryArtifacts, totalTasks } = buildDryRunEachArtifacts(skillEntries);
    return {
      report: {
        dryRun: true,
        each: true,
        model,
        judgeModel,
        executor: executorName,
        skillDir,
        totalArtifacts: dryArtifacts.length,
        totalTasks,
        artifacts: dryArtifacts,
      },
      filePath: null,
    };
  }
  return executeEachEvaluationRuns({
    skillDir,
    skillEntries,
    model,
    judgeModel,
    outputDir,
    project,
    owner,
    tags,
    noJudge,
    concurrency,
    timeoutMs,
    executorName,
    judgeExecutorName,
    jobStore,
    persistJob,
    onProgress,
    onSkillProgress,
    skipPreflight,
    mcpConfig,
    verbose,
    runSingleEvaluation: async (options) => {
      const result = await runEvaluation(options);
      return { report: result.report as Report, filePath: result.filePath };
    },
  });
}

export interface RunMultipleOptions extends RunEvaluationOptions {
  repeat?: number;
  onRepeatProgress?: ((info: { run: number; total: number }) => void) | null;
}

export async function runMultiple({ repeat = 1, onRepeatProgress, ...config }: RunMultipleOptions): Promise<{ report: Report; aggregated: VarianceData | null; filePath: string | null }> {
  const runs: Report[] = [];
  const savedOutputDir = config.outputDir;
  for (let i = 0; i < repeat; i++) {
    if (onRepeatProgress) onRepeatProgress({ run: i + 1, total: repeat });
    // Only persist the last run's report; intermediate runs skip persistence and job tracking
    const isLast = i === repeat - 1;
    const { report } = await runEvaluation({
      ...config,
      outputDir: isLast ? savedOutputDir : null,
      persistJob: isLast,
    });
    runs.push(report as Report);
  }

  if (runs.length === 1) {
    return { report: runs[0], aggregated: null, filePath: null };
  }

  const variants = runs[0].meta.variants || [];
  const perVariant: Record<string, { scores: number[]; mean: number; lower: number; upper: number; stddev: number }> = {};
  for (const variant of variants) {
    const scores = runs.map((run) => run.summary?.[variant]?.avgCompositeScore).filter((score): score is number => typeof score === 'number');
    perVariant[variant] = { scores, ...confidenceInterval(scores) };
  }

  const comparisons: Array<{ a: string; b: string; tStatistic: number; df: number; significant: boolean }> = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      comparisons.push({
        a: variants[i],
        b: variants[j],
        ...tTest(perVariant[variants[i]].scores, perVariant[variants[j]].scores),
      });
    }
  }

  const report = runs[runs.length - 1];
  report.variance = { runs: repeat, perVariant, comparisons };

  return { report, aggregated: report.variance, filePath: null };
}
