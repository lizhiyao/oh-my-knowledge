import { resolve } from 'node:path';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from '../executor.js';
import { DEFAULT_OUTPUT_DIR } from '../evaluation-reporting.js';
import type { ProgressCallback } from '../evaluation-execution.js';
import { discoverEachSkills } from '../skill-loader.js';
import { executeEachEvaluationRuns } from './each-evaluation-workflow.js';
import {
  buildDryRunEachArtifacts,
  buildDryRunTaskReport,
  prepareEvaluationRun,
} from './evaluation-preparation.js';
import { executeEvaluationPipeline } from './evaluation-pipeline.js';
import { executeVarianceWorkflow } from './variance-workflow.js';

import type {
  Report,
  Artifact,
  ExecutorFn,
  JobStore,
} from '../types.js';

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

export type { RunMultipleOptions } from './variance-workflow.js';

export async function runMultiple({ repeat = 1, onRepeatProgress, ...config }: import('./variance-workflow.js').RunMultipleOptions) {
  return executeVarianceWorkflow({
    repeat,
    onRepeatProgress,
    config,
    runEvaluation: async (options) => {
      const result = await runEvaluation(options);
      return { report: result.report as Report, filePath: result.filePath };
    },
  });
}
