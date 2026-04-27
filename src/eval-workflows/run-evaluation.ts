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
  SaturationData,
  VarianceComparison,
  VarianceComparisonMetric,
  VarianceData,
  VarianceLayerKey,
  VarianceMetric,
  VariantSpec,
  VariantSummary,
  VariantVariance,
} from '../types/index.js';
import { findSaturationPoint } from '../analysis/saturation.js';
import { bootstrapMeanCI } from '../eval-core/bootstrap.js';

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
  // When true, HTML report expands the three-layer independent significance
  // breakdown by default (CLI `--layered-stats`). Written to report.meta.layeredStats
  // and read by the renderer; does not affect data collection.
  layeredStats?: boolean;
  /** --repeat N. 1 表示单次(默认); > 1 时在 runMultiple 层聚合 variance。
   *  记入 report.meta.request.repeat 让 meta 如实反映用户输入。 */
  repeat?: number;
  /** --each 模式标记, true 表示当前评测是 each 批量流程(每个 skill 独立对比 baseline)。
   *  记入 report.meta.request.each。 */
  each?: boolean;
  /** --judge-repeat N. 每条 sample × dimension 调 LLM judge N 次, 输出 stddev (judge 自一致性).
   *  默认 1 (单次). 用于量化 LLM judge 在该 rubric 上的稳定性 — stddev 高 = 评分噪声大. */
  judgeRepeat?: number;
  /** --judge-models executor:model,executor:model,... — multi-judge ensemble. ≥ 2 个
   *  judge 时每条 sample × dimension 由所有 judge 各自打分, 输出 inter-judge agreement. */
  judgeModels?: import('../types/index.js').JudgeConfig[];
  /** --bootstrap. Distribution-free CI on each variant mean + pairwise diff. */
  bootstrap?: boolean;
  /** --bootstrap-samples N. Default 1000. */
  bootstrapSamples?: number;
  /** v0.21 Phase 3a length-debias toggle. Default true (judge prompt v3-cot-length).
   *  CLI passes false when --no-debias-length is set. */
  lengthDebias?: boolean;
  /** v0.22 — hard budget caps. */
  budget?: import('../types/index.js').EvalBudget;
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
  layeredStats = false,
  repeat,
  each,
  judgeRepeat,
  judgeModels,
  bootstrap,
  bootstrapSamples,
  lengthDebias,
  budget,
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
    // Emit power warnings during dry-run too — this is exactly when users
    // preview the run, the right moment to flag "you might be wasting it".
    const { buildPowerWarnings } = await import('./evaluation-pipeline.js');
    for (const w of buildPowerWarnings(samples.length, repeat ?? 1)) {
      process.stderr.write(`${w}\n`);
    }
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
  let existingResults: Record<string, Record<string, import('../types/index.js').VariantResult>> | undefined;
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
        process.stderr.write(`\n📂 resumed ${count} completed results from report ${resume}\n`);
      }
    } else {
      process.stderr.write(`\n⚠️  report ${resume} not found, starting from scratch\n`);
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
    layeredStats,
    repeat,
    each,
    judgeRepeat,
    judgeModels,
    bootstrap,
    bootstrapSamples,
    lengthDebias,
    budget,
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

// Top-level (composite) extractor: feeds the legacy flat-field variance on
// VariantVariance / VarianceComparison. Composite lives here for backward
// compatibility with historical reports; layer-independent stats are attached
// via byLayer (see LAYER_EXTRACTORS) starting v0.16 work item B / PR-2.
const COMPOSITE_EXTRACTOR = (s: VariantSummary | undefined): number | undefined => s?.avgCompositeScore;

// Non-quality metric extractors tracked in byMetric (cost + efficiency).
const METRIC_EXTRACTORS: Record<'cost' | 'efficiency', (s: VariantSummary | undefined) => number | undefined> = {
  cost: (s) => s?.totalExecCostUSD,
  efficiency: (s) => s?.avgDurationMs,
};

// Three-layer extractors (PR-2): fact / behavior / judge each get their own
// independent variance + t-test + effect size. Lets "judge ↑ 0.8, fact ↑ 0.1"
// structural signals surface instead of getting diluted by the composite average.
// `judge` is the rubric-based LLM judge score (UI 中文: "LLM 评价").
const LAYER_EXTRACTORS: Record<VarianceLayerKey, (s: VariantSummary | undefined) => number | undefined> = {
  fact: (s) => s?.avgFactScore,
  behavior: (s) => s?.avgBehaviorScore,
  judge: (s) => s?.avgJudgeScore,
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

/**
 * Build saturation curve data from a sequence of runs.
 *
 * Each run contributes one checkpoint = "all samples up to and including this run".
 * For each variant we compute (mean, CI) at that cumulative N. When repeat ≥ 5
 * we additionally run findSaturationPoint to assess whether the curve has
 * flattened. Below that threshold the data is recorded for plotting but no
 * verdict is computed — the user still sees the curve, just without the auto
 * "saturated at N=X" claim.
 */
function buildSaturationData(runs: Report[]): SaturationData | undefined {
  if (runs.length < 2) return undefined;
  const variants = runs[0].meta.variants ?? [];
  if (variants.length === 0) return undefined;

  // Per-variant: cumulative composite scores after each repeat.
  const cumulativeByVariant: Record<string, number[][]> = {};
  const tracesByVariant: Record<string, Array<{ n: number; mean: number; ciLow: number; ciHigh: number }>> = {};

  const checkpointSampleCounts: number[] = [];
  const acc: Record<string, number[]> = Object.fromEntries(variants.map((v) => [v, []]));

  for (let runIdx = 0; runIdx < runs.length; runIdx++) {
    const run = runs[runIdx];
    for (const variant of variants) {
      const newScores: number[] = [];
      for (const entry of run.results ?? []) {
        const v = entry.variants?.[variant];
        if (!v || typeof v.compositeScore !== 'number' || v.compositeScore <= 0) continue;
        newScores.push(v.compositeScore);
      }
      acc[variant] = acc[variant].concat(newScores);
    }
    // Snapshot cumulative state for this checkpoint.
    const checkpointN = acc[variants[0]]?.length ?? 0;
    checkpointSampleCounts.push(checkpointN);
    for (const variant of variants) {
      if (!cumulativeByVariant[variant]) cumulativeByVariant[variant] = [];
      cumulativeByVariant[variant].push([...acc[variant]]);

      // Per-checkpoint trace: bootstrap CI on cumulative scores.
      const ci = bootstrapMeanCI(acc[variant], 0.05, 1000);
      if (!tracesByVariant[variant]) tracesByVariant[variant] = [];
      tracesByVariant[variant].push({
        n: acc[variant].length,
        mean: ci.estimate,
        ciLow: ci.low,
        ciHigh: ci.high,
      });
    }
  }

  const verdicts: SaturationData['verdicts'] = {};
  if (runs.length >= 5) {
    for (const variant of variants) {
      const cumulative = cumulativeByVariant[variant];
      if (!cumulative) continue;
      const r = findSaturationPoint(cumulative, 'bootstrap-ci-width');
      verdicts[variant] = {
        saturated: r.saturated,
        atN: r.atN,
        confidence: r.confidence,
        method: r.method,
        threshold: r.threshold,
        reason: r.reason,
      };
    }
  }

  return {
    checkpointSampleCounts,
    perVariant: tracesByVariant,
    ...(Object.keys(verdicts).length > 0 ? { verdicts } : {}),
  };
}

export function buildVarianceData(runs: Report[]): VarianceData | null {
  if (runs.length <= 1) {
    return null;
  }

  const variants = runs[0].meta.variants || [];
  const perVariant: Record<string, VariantVariance> = {};
  for (const variant of variants) {
    // Composite lives on the legacy flat fields.
    const composite = buildMetricStats(runs, variant, COMPOSITE_EXTRACTOR);
    if (!composite) continue;

    const byMetric: Partial<Record<'cost' | 'efficiency', VarianceMetric>> = {};
    const cost = buildMetricStats(runs, variant, METRIC_EXTRACTORS.cost);
    if (cost) byMetric.cost = cost;
    const efficiency = buildMetricStats(runs, variant, METRIC_EXTRACTORS.efficiency);
    if (efficiency) byMetric.efficiency = efficiency;

    // Three-layer independent stats (PR-2). Any layer with no data across runs is omitted.
    const byLayer: Partial<Record<VarianceLayerKey, VarianceMetric>> = {};
    for (const key of ['fact', 'behavior', 'judge'] as const) {
      const layerStats = buildMetricStats(runs, variant, LAYER_EXTRACTORS[key]);
      if (layerStats) byLayer[key] = layerStats;
    }

    perVariant[variant] = {
      ...composite,
      ...(Object.keys(byMetric).length > 0 ? { byMetric } : {}),
      ...(Object.keys(byLayer).length > 0 ? { byLayer } : {}),
    };
  }

  const comparisons: VarianceComparison[] = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const vA = perVariant[variants[i]];
      const vB = perVariant[variants[j]];
      if (!vA || !vB) continue;

      const compositeComp = buildComparisonMetric(vA.scores, vB.scores, vA.mean, vB.mean);

      const byMetricComp: Partial<Record<'cost' | 'efficiency', VarianceComparisonMetric>> = {};
      for (const key of ['cost', 'efficiency'] as const) {
        const mA = vA.byMetric?.[key];
        const mB = vB.byMetric?.[key];
        if (mA && mB) {
          byMetricComp[key] = buildComparisonMetric(mA.scores, mB.scores, mA.mean, mB.mean);
        }
      }

      // Three-layer comparison (PR-2). Each layer pair runs its own Welch's t + Cohen's d.
      const byLayerComp: Partial<Record<VarianceLayerKey, VarianceComparisonMetric>> = {};
      for (const key of ['fact', 'behavior', 'judge'] as const) {
        const lA = vA.byLayer?.[key];
        const lB = vB.byLayer?.[key];
        if (lA && lB) {
          byLayerComp[key] = buildComparisonMetric(lA.scores, lB.scores, lA.mean, lB.mean);
        }
      }

      comparisons.push({
        a: variants[i],
        b: variants[j],
        ...compositeComp,
        ...(Object.keys(byMetricComp).length > 0 ? { byMetric: byMetricComp } : {}),
        ...(Object.keys(byLayerComp).length > 0 ? { byLayer: byLayerComp } : {}),
      });
    }
  }

  const saturation = buildSaturationData(runs);
  return {
    runs: runs.length,
    perVariant,
    comparisons,
    ...(saturation ? { saturation } : {}),
  };
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
  repeat,
  judgeRepeat,
  judgeModels,
  lengthDebias,
}: RunEachEvaluationOptions): Promise<{ report: Report | DryRunEachReport; filePath: string | null }> {
  const skillEntries = discoverEachSkills(resolve(skillDir));
  if (skillEntries.length === 0) {
    throw new Error(`no skill with paired eval-samples found in: ${skillDir}`);
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
    repeat,
    judgeRepeat,
    judgeModels,
    lengthDebias,
    runSingleEvaluation: async (options) => {
      // repeat > 1 时走 runMultiple 做 variance; each=true 标记让 meta.request 如实反映
      if (repeat && repeat > 1) {
        const multi = await runMultiple({ ...options, repeat, each: true, judgeRepeat, judgeModels, lengthDebias });
        return { report: multi.report, filePath: multi.filePath };
      }
      const result = await runEvaluation({ ...options, each: true, judgeRepeat, judgeModels, lengthDebias });
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
