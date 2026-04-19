import { resolve } from 'node:path';
import { DEFAULT_OUTPUT_DIR, persistReport } from '../eval-core/evaluation-reporting.js';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from '../executors/index.js';
import { discoverEachSkills } from '../inputs/skill-loader.js';
import { confidenceInterval, tTest, effectSize } from '../eval-core/statistics.js';
import { executeEachEvaluationRuns } from './each-evaluation-workflow.js';
import {
  buildDryRunEachArtifacts,
  buildDryRunTaskReport,
  prepareEvaluationRun,
} from './evaluation-preparation.js';
import { executeEvaluationPipeline } from './evaluation-pipeline.js';

import type {
  Artifact,
  ExecutorFn,
  JobStore,
  ProgressCallback,
  Report,
  VarianceComparison,
  VarianceComparisonMetric,
  VarianceData,
  VarianceMetric,
  VariantSpec,
  VariantSummary,
  VariantVariance,
} from '../types.js';

export interface SkillProgressInfo {
  phase: string;
  skill: string;
  current: number;
  total: number;
}

interface CommonEvaluationOptions {
  model?: string;
  judgeModel?: string;
  outputDir?: string | null;
  project?: string;
  owner?: string;
  tags?: string[];
  noJudge?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  executorName?: string;
  judgeExecutorName?: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  onProgress?: ProgressCallback | null;
  skipPreflight?: boolean;
  mcpConfig?: string;
  verbose?: boolean;
}

export interface RunEvaluationOptions extends CommonEvaluationOptions {
  samplesPath: string;
  skillDir: string;
  variantSpecs?: VariantSpec[];
  artifacts?: Artifact[];
  dryRun?: boolean;
  blind?: boolean;
  noCache?: boolean;
  retry?: number;
  resume?: string;
}

export interface RunEachEvaluationOptions extends CommonEvaluationOptions {
  skillDir: string;
  dryRun?: boolean;
  onSkillProgress?: ((info: SkillProgressInfo) => void) | null;
}

export interface RunMultipleOptions extends RunEvaluationOptions {
  repeat?: number;
  onRepeatProgress?: ((info: { run: number; total: number }) => void) | null;
}

interface DryRunTask {
  sample_id: string;
  variant: string;
  artifactKind: Artifact['kind'];
  artifactSource: Artifact['source'];
  executionStrategy: string;
  experimentType: string;
  experimentRole: string;
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

export async function runEvaluation({
  samplesPath,
  skillDir,
  variantSpecs = [],
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
  retry = 0,
  resume,
}: RunEvaluationOptions): Promise<{ report: Report | DryRunReport; filePath: string | null }> {
  const { samples, artifacts: resolvedArtifacts, tasks, variantNames, requires } = await prepareEvaluationRun({
    samplesPath,
    skillDir,
    variantSpecs,
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

  // --resume: load existing report results to skip completed tasks
  let existingResults: Record<string, Record<string, import('../types.js').VariantResult>> | undefined;
  if (resume) {
    const { createFileStore } = await import('../server/report-store.js');
    const store = createFileStore(resolve(outputDir || DEFAULT_OUTPUT_DIR));
    const existing = await store.get(resume);
    if (existing) {
      existingResults = {};
      for (const entry of existing.results || []) {
        existingResults[entry.sample_id] = entry.variants;
      }
      if (onProgress) {
        const count = Object.values(existingResults).reduce((sum, v) => sum + Object.values(v).filter((r) => r.ok).length, 0);
        process.stderr.write(`\n📂 从报告 ${resume} 恢复了 ${count} 个已完成结果\n`);
      }
    } else {
      process.stderr.write(`\n⚠️  报告 ${resume} 未找到，将从头执行\n`);
    }
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
    retry,
    existingResults,
    requires,
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

// Per-metric score extractors. Each returns undefined when the summary field
// is missing so the scores array only contains valid numbers.
const METRIC_EXTRACTORS: Record<'quality' | 'cost' | 'efficiency', (s: VariantSummary | undefined) => number | undefined> = {
  quality: (s) => s?.avgCompositeScore,
  cost: (s) => s?.totalExecCostUSD,
  efficiency: (s) => s?.avgDurationMs,
};

function buildMetricStats(runs: Report[], variant: string, extractor: (s: VariantSummary | undefined) => number | undefined): VarianceMetric | null {
  const scores = runs
    .map((run) => extractor(run.summary?.[variant]))
    .filter((x): x is number => typeof x === 'number');
  if (scores.length === 0) return null;
  return { scores, ...confidenceInterval(scores) };
}

function buildComparisonMetric(scoresA: number[], scoresB: number[], meanA: number, meanB: number): VarianceComparisonMetric {
  const t = tTest(scoresA, scoresB);
  const es = effectSize(scoresA, scoresB);
  const meanDiff = Number((meanA - meanB).toFixed(4));
  return {
    meanDiff,
    tStatistic: t.tStatistic,
    df: t.df,
    significant: t.significant,
    effectSize: es,
  };
}

export function buildVarianceData(runs: Report[]): VarianceData | null {
  if (runs.length <= 1) {
    return null;
  }

  const variants = runs[0].meta.variants || [];
  const perVariant: Record<string, VariantVariance> = {};
  for (const variant of variants) {
    // Quality lives on the legacy flat fields.
    const quality = buildMetricStats(runs, variant, METRIC_EXTRACTORS.quality);
    if (!quality) continue;

    const byMetric: Partial<Record<'cost' | 'efficiency', VarianceMetric>> = {};
    const cost = buildMetricStats(runs, variant, METRIC_EXTRACTORS.cost);
    if (cost) byMetric.cost = cost;
    const efficiency = buildMetricStats(runs, variant, METRIC_EXTRACTORS.efficiency);
    if (efficiency) byMetric.efficiency = efficiency;

    perVariant[variant] = {
      ...quality,
      ...(Object.keys(byMetric).length > 0 ? { byMetric } : {}),
    };
  }

  const comparisons: VarianceComparison[] = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const vA = perVariant[variants[i]];
      const vB = perVariant[variants[j]];
      if (!vA || !vB) continue;

      const qualityComp = buildComparisonMetric(vA.scores, vB.scores, vA.mean, vB.mean);

      const byMetricComp: Partial<Record<'cost' | 'efficiency', VarianceComparisonMetric>> = {};
      for (const key of ['cost', 'efficiency'] as const) {
        const mA = vA.byMetric?.[key];
        const mB = vB.byMetric?.[key];
        if (mA && mB) {
          byMetricComp[key] = buildComparisonMetric(mA.scores, mB.scores, mA.mean, mB.mean);
        }
      }

      comparisons.push({
        a: variants[i],
        b: variants[j],
        ...qualityComp,
        ...(Object.keys(byMetricComp).length > 0 ? { byMetric: byMetricComp } : {}),
      });
    }
  }

  return { runs: runs.length, perVariant, comparisons };
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

export async function runMultiple({ repeat = 1, onRepeatProgress, ...config }: RunMultipleOptions) {
  const runs: Report[] = [];
  const savedOutputDir = config.outputDir;

  for (let i = 0; i < repeat; i++) {
    onRepeatProgress?.({ run: i + 1, total: repeat });
    const isLast = i === repeat - 1;
    const { report } = await runEvaluation({
      ...config,
      outputDir: isLast ? savedOutputDir : null,
      persistJob: isLast,
    });
    runs.push(report as Report);
  }

  const report = runs[runs.length - 1];
  const aggregated = buildVarianceData(runs);
  let filePath: string | null = null;
  if (aggregated) {
    report.variance = aggregated;
    // pipeline 内部在 variance 赋值前已写入报告，需要重新写一次以包含方差数据
    filePath = persistReport(report, savedOutputDir || DEFAULT_OUTPUT_DIR);
  }

  return { report, aggregated, filePath };
}
