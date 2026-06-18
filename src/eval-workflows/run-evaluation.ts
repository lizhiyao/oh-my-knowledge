import { resolve } from 'node:path';
import { DEFAULT_OUTPUT_DIR, persistReport } from '../eval-core/evaluation-reporting.js';
import { createExecutor, DEFAULT_MODEL, JUDGE_MODEL } from '../executors/index.js';
import { discoverBatchSkills } from '../inputs/skill-loader.js';
import { confidenceInterval, tTest, effectSize } from '../eval-core/statistics.js';
import { executeBatchEvaluationRuns, buildBatchVariantSpecs } from './batch-evaluation-workflow.js';
import {
  buildDryRunTaskReport,
  prepareEvaluationRun,
} from './evaluation-preparation.js';
import { executeEvaluationPipeline } from './evaluation-pipeline.js';

import type {
  Artifact,
  BatchEvaluationReport,
  EvaluationReport,
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
import { bootstrapMeanCI, DEFAULT_BOOTSTRAP_ALPHA, DEFAULT_BOOTSTRAP_SAMPLES } from '../eval-core/bootstrap.js';

export interface SkillProgressInfo {
  phase: string;
  skill: string;
  current: number;
  total: number;
}

interface CommonEvaluationOptions {
  model?: string;
  outputDir?: string | null;
  project?: string;
  owner?: string;
  tags?: string[];
  noJudge?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  executorName?: string;
  jobStore?: JobStore | null;
  persistJob?: boolean;
  onProgress?: ProgressCallback | null;
  /** 跳过 LLM 模型连通性检测。--resume 时自动 true(已经验过)。 */
  skipConnectivity?: boolean;
  /** 跳过 doctor 健康检查门禁(escape hatch, 默认 false)。
   *  开启后 doctor 整段不跑,失败也不阻断 eval — 评测环境用 mock/stub 提供
   *  依赖时绕开 doctor 的物理路径检查误报。开启意味着接受 garbage-in 风险。 */
  skipDoctor?: boolean;
  /** 用户语言, 透传给 doctor 报告渲染。 */
  lang?: 'zh' | 'en';
  mcpConfig?: string;
  verbose?: boolean;
  // When true, HTML report expands the three-layer independent significance
  // breakdown by default (CLI `--layered-stats`). Written to report.meta.layeredStats
  // and read by the renderer; does not affect data collection.
  layeredStats?: boolean;
  /** --repeat N. 1 表示单次(默认); > 1 时在 runMultiple 层聚合 variance。
   *  记入 report.meta.request.repeat 让 meta 如实反映用户输入。 */
  repeat?: number;
  /** --holdout-ratio R. 0 / 缺省 = 不切分(默认)。> 0 时 report-finalize 算 train/holdout
   *  子集综合分(report.analysis.holdout),供 verdict 过拟合门控读取。 */
  holdoutRatio?: number;
  /** --batch 模式标记, true 表示当前评测是 skill batch 流程。
   *  记入 report.meta.request.batch。 */
  batch?: boolean;
  /** --judge-repeat N. 每条 sample × dimension 调 LLM judge N 次, 输出 stddev (judge 自一致性).
   *  默认 1 (单次). 用于量化 LLM judge 在该 rubric 上的稳定性 — stddev 高 = 评分噪声大. */
  judgeRepeat?: number;
  /** Unified judge config. 1 entry = single judge, ≥ 2 = ensemble + inter-judge agreement.
   *  Optional at the API surface; runEvaluation defaults to `[{executor, model: 'haiku'}]`
   *  when omitted. RunConfig (parseRunConfig 出口) 保证非空。 */
  judgeModels?: import('../types/index.js').JudgeConfig[];
  /** --bootstrap. Distribution-free CI on each variant mean + pairwise diff. */
  bootstrap?: boolean;
  /** --bootstrap-samples N. Default 1000. */
  bootstrapSamples?: number;
  /** length-debias toggle. Default true (length-debias instruction on).
   *  CLI passes false when --no-debias-length is set. */
  lengthDebias?: boolean;
  /** hard budget caps. */
  budget?: import('../types/index.js').EvalBudget;
  noCache?: boolean;
  /** Reasoning effort for executor LLM。透传到 ExecutorInput.effort。
   *  默认 undefined → executor 内部走 claude CLI / SDK 自身默认(high);
   *  CLI parseRunConfig 兜底 'low' 后这里就拿到 'low'。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 关闭 diagnostic LLM call。Default false。跟 noJudge 完全独立。 */
  noDiagnostic?: boolean;
}

export interface RunEvaluationOptions extends CommonEvaluationOptions {
  samplesPath: string;
  skillDir: string;
  variantSpecs?: VariantSpec[];
  dryRun?: boolean;
  retry?: number;
  resume?: string;
  /** Explicit persisted run id. Used by batch workflows that need stable child ids. */
  runId?: string;
  /** strict-baseline default (CLI `--strict-baseline` default true).
   *  When undefined, treated as true. baseline-kind variants get allowedSkills=[].
   *  per-variant 显式隔离声明走 variantSpecs[].allowedSkills(eval.yaml 经 configVariantsToSpecs)。 */
  strictBaseline?: boolean;
}

export interface RunBatchEvaluationOptions extends CommonEvaluationOptions {
  skillDir: string;
  dryRun?: boolean;
  onSkillProgress?: ((info: SkillProgressInfo) => void) | null;
  /** strict-baseline default. batch mode 仍尊重此 flag。 */
  strictBaseline?: boolean;
  /** per-variant allowedSkills override (rare in batch mode but supported). */
  variantAllowedSkills?: Record<string, string[]>;
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
  judgeModels: import('../types/index.js').JudgeConfig[];
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
  model = DEFAULT_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  project,
  owner,
  tags,
  noJudge = false,
  dryRun = false,
  concurrency = 1,
  timeoutMs,
  noCache = false,
  executorName = 'claude',
  jobStore = null,
  persistJob = true,
  onProgress = null,
  skipConnectivity = false,
  skipDoctor = false,
  lang = 'zh',
  mcpConfig,
  verbose = false,
  retry = 0,
  resume,
  runId,
  layeredStats = false,
  repeat,
  holdoutRatio,
  batch,
  judgeRepeat,
  judgeModels,
  bootstrap,
  bootstrapSamples,
  lengthDebias,
  budget,
  strictBaseline,
  effort,
  noDiagnostic,
}: RunEvaluationOptions): Promise<{ report: Report | DryRunReport; filePath: string | null }> {
  // Unified judgeModels → derive single-judge fields for downstream pipeline / grading
  // (which still operate on string `judgeModel` + `judgeExecutorName` fields per call).
  const effectiveJudgeModels: import('../types/index.js').JudgeConfig[] = judgeModels && judgeModels.length > 0
    ? judgeModels
    : [{ executor: executorName, model: JUDGE_MODEL }];
  const judgeModel = effectiveJudgeModels[0].model;
  const judgeExecutorName = effectiveJudgeModels[0].executor;
  const { samples, artifacts: resolvedArtifacts, tasks, variantNames, requires, samplesBaseDir, samplesSourceFiles } = await prepareEvaluationRun({
    samplesPath,
    skillDir,
    variantSpecs,
    dryRun,
    mcpConfig,
    strictBaseline,
  });

  // doctor 强制门禁: skill 静态结构 + 元数据 + 依赖 + 用例契约。
  // 在 dryRun 分支之前跑, 让 dry-run 也得到 doctor 覆盖(保护 garbage-in 的 verdict)。
  // 默认强制启用; --skip-doctor 提供 escape hatch,典型场景是评测环境用 mock/stub
  // 提供依赖,doctor 的物理路径检查会误报。开启 escape hatch 意味着接受 garbage-in 风险。
  // LLM 连通性是另一回事, 由独立的 skipConnectivity 控制。
  //
  // 路径推断收口在 buildDoctorPreflightContext：doctor engine 不再自己猜 eval 的
  // artifact 形态 / cwd 优先级，任何 eval 路径语义边界变化只改 builder 一处。
  if (skipDoctor) {
    process.stderr.write(
      lang === 'zh'
        ? '\n⚠ --skip-doctor 已开启,doctor 健康检查整段跳过 — 依赖正确性由用户自己保证。\n'
        : '\n⚠ --skip-doctor enabled; doctor health check entirely bypassed — caller owns dependency correctness.\n'
    );
  } else {
    const { buildDoctorPreflightContext } = await import('../doctor/preflight.js');
    const doctorCtx = buildDoctorPreflightContext({
      artifacts: resolvedArtifacts,
      samples,
      requires,
      skillDir,
    });
    if (doctorCtx) {
      const { runDoctor } = await import('../doctor/index.js');
      const { renderDoctorReportText } = await import('../doctor/renderer.js');
      const { tEvalWorkflowMessage } = await import('./messages.js');
      const doctorReport = await runDoctor({
        artifacts: doctorCtx.doctorArtifacts,
        cwd: doctorCtx.dependencyCwd,
        dependencyCwd: doctorCtx.dependencyCwd,
        samples: doctorCtx.samples,
        requires: doctorCtx.requires,
        executorName,
        model,
        timeoutMs: timeoutMs ?? 8000,
        lang,
      });
      if (doctorReport.outcome === 'failed') {
        renderDoctorReportText(doctorReport, lang);
        throw new Error(`doctor failed: ${tEvalWorkflowMessage('doctor_gate_blocked', lang)}`);
      }
    }
  }

  // --resume 时自动跳过 LLM 连通性检测(原 run 已经验过, 重跑是浪费 LLM 调用)
  const effectiveSkipConnectivity = resume ? true : skipConnectivity;

  if (dryRun) {
    // Emit power warnings during dry-run too — this is exactly when users
    // preview the run, the right moment to flag "you might be wasting it".
    const { buildPowerWarnings, buildIsolationWarnings } = await import('./evaluation-pipeline.js');
    for (const w of buildPowerWarnings(samples.length, repeat ?? 1, lang)) {
      process.stderr.write(`${w}\n`);
    }
    for (const w of buildIsolationWarnings(resolvedArtifacts, strictBaseline)) {
      process.stderr.write(`${w}\n`);
    }
    return {
      report: buildDryRunTaskReport({
        model,
        judgeModels: effectiveJudgeModels,
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
    // 读侧走 overlay(本次 outputDir 优先 → 全局兜底):写默认翻项目后,--resume 一个存量 / 全局报告(升级前
    // 全部落全局)仍能 get 命中,不致整轮重跑。写仍是另起新报告到 outputDir,与读位置解耦,无 read/write 分叉。
    const { createOverlayReportStore } = await import('../server/report-store.js');
    const { globalReportsDir } = await import('../eval-core/measurement-dirs.js');
    const store = createOverlayReportStore(resolve(outputDir || DEFAULT_OUTPUT_DIR), globalReportsDir());
    const existing = await store.get(resume);
    if (existing?.kind === 'evaluation') {
      existingResults = {};
      for (const entry of existing.results || []) {
        existingResults[entry.sample_id] = entry.variants;
      }
      if (onProgress) {
        const count = Object.values(existingResults).reduce((sum, v) => sum + Object.values(v).filter((r) => r.ok).length, 0);
        process.stderr.write(`\n📂 resumed ${count} completed results from report ${resume}\n`);
      }
      // Skill isolation 一致性校验:resumed report 的 meta.skillIsolation
      // 跟当前 strict-baseline 状态不一致时 stderr warn 不阻塞,让用户判断
      // 是否要 --no-cache 强制重跑(避免混合污染 / 干净 entries)。
      const reportIsolation = existing.meta?.skillIsolation;
      const expectedIsolated = strictBaseline !== false; // default true
      if (!reportIsolation && expectedIsolated) {
        process.stderr.write(
          `\n⚠️  resumed report ${resume} 无 meta.skillIsolation 字段,baseline 可能被 ~/.claude/skills/ 污染。\n`
          + `   当前 --strict-baseline 默认开启,新 entries 会被隔离 → 与现有 entries 不可比。\n`
          + `   建议:加 --no-cache 强制重跑,或显式 --no-strict-baseline 接受混合数据(慎用)。\n`,
        );
      } else if (reportIsolation && !expectedIsolated) {
        process.stderr.write(
          `\n⚠️  resumed report ${resume} 已 strict-isolated(meta.skillIsolation 存在),但本次 --no-strict-baseline。\n`
          + `   新 entries 不隔离 → 与现有 entries 不可比。建议恢复默认 strict-baseline。\n`,
        );
      }
    } else if (existing?.kind === 'batch-evaluation') {
      process.stderr.write(`\n⚠️  report ${resume} is a BatchEvaluationReport; resume needs a child EvaluationReport, starting from scratch\n`);
    } else {
      process.stderr.write(`\n⚠️  report ${resume} not found, starting from scratch\n`);
    }
  }

  const executor: ExecutorFn = createExecutor(executorName);
  const judgeExecutor: ExecutorFn = createExecutor(judgeExecutorName || executorName);
  return executeEvaluationPipeline({
    samplesPath,
    samplesBaseDir,
    samplesSourceFiles,
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
    concurrency,
    timeoutMs,
    noCache,
    jobStore,
    persistJob,
    onProgress,
    skipConnectivity: effectiveSkipConnectivity,
    verbose,
    retry,
    existingResults,
    requires,
    layeredStats,
    repeat,
    holdoutRatio,
    batch,
    judgeRepeat,
    judgeModels,
    bootstrap,
    bootstrapSamples,
    lengthDebias,
    budget,
    strictBaseline,
    runId,
    lang,
    effort,
    noDiagnostic,
  });
}

interface DryRunBatchSkill {
  name: string;
  samplesPath: string;
  sampleCount: number;
  taskCount: number;
}

export interface DryRunBatchReport extends DryRunBase {
  batch: true;
  totalArtifacts: number;
  artifacts: DryRunBatchSkill[];
}

// Top-level (composite) extractor: feeds the legacy flat-field variance on
// VariantVariance / VarianceComparison. Composite lives here for backward
// compatibility with historical reports; layer-independent stats are attached
// via byLayer (see LAYER_EXTRACTORS).
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
function buildSaturationData(
  runs: Report[],
  bootstrapSamples = DEFAULT_BOOTSTRAP_SAMPLES,
  seed?: number,
): SaturationData | undefined {
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
      const ci = bootstrapMeanCI(acc[variant], DEFAULT_BOOTSTRAP_ALPHA, bootstrapSamples, seed);
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
      const r = findSaturationPoint(cumulative, 'bootstrap-ci-width', undefined, undefined, bootstrapSamples, seed);
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

export function buildVarianceData(
  runs: Report[],
  bootstrapSamples = DEFAULT_BOOTSTRAP_SAMPLES,
  seed?: number,
): VarianceData | null {
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

  const saturation = buildSaturationData(runs, bootstrapSamples, seed);
  return {
    runs: runs.length,
    perVariant,
    comparisons,
    ...(saturation ? { saturation } : {}),
  };
}

export async function runBatchEvaluation({
  skillDir,
  model = DEFAULT_MODEL,
  outputDir = DEFAULT_OUTPUT_DIR,
  project,
  owner,
  tags,
  noJudge = false,
  dryRun = false,
  concurrency = 1,
  timeoutMs,
  executorName = 'claude',
  jobStore = null,
  persistJob = true,
  onProgress = null,
  onSkillProgress = null,
  skipConnectivity = false,
  skipDoctor = false,
  lang = 'zh',
  mcpConfig,
  verbose = false,
  repeat,
  holdoutRatio,
  judgeRepeat,
  judgeModels,
  bootstrap,
  bootstrapSamples,
  lengthDebias,
  budget,
  noCache = false,
  strictBaseline,
  variantAllowedSkills,
}: RunBatchEvaluationOptions): Promise<{ report: BatchEvaluationReport | DryRunBatchReport; filePath: string | null }> {
  // Same unified judge derivation as runEvaluation (downstream pipeline / report build
  // still uses single judgeModel + judgeExecutorName per call).
  const effectiveJudgeModels: import('../types/index.js').JudgeConfig[] = judgeModels && judgeModels.length > 0
    ? judgeModels
    : [{ executor: executorName, model: JUDGE_MODEL }];
  const judgeModel = effectiveJudgeModels[0].model;
  const judgeExecutorName = effectiveJudgeModels[0].executor;
  const skillEntries = discoverBatchSkills(resolve(skillDir));
  if (skillEntries.length === 0) {
    throw new Error(`no skill with paired eval-samples found in: ${skillDir}`);
  }

  if (dryRun) {
    // batch dry-run 走 per-entry runEvaluation(dryRun: true) — doctor 嵌入
    // 自动复用 runEvaluation 内部的 builder + 单一逻辑,不再在 batch 这边
    // 旁路一套 doctor / 路径推断。entry 的 spec 构造(buildBatchVariantSpecs)与 batch
    // real-run(executeBatchEvaluationRuns)同一处,避免 dry-run / real-run 漂移。
    const dryArtifacts: DryRunBatchSkill[] = [];
    for (const entry of skillEntries) {
      const variantSpecs = buildBatchVariantSpecs(entry, variantAllowedSkills);
      let entryReport: DryRunReport;
      try {
        const result = await runEvaluation({
          samplesPath: entry.samplesPath,
          skillDir,
          variantSpecs,
          model,
          executorName,
          dryRun: true,
          noJudge,
          timeoutMs,
          lang,
          mcpConfig,
          strictBaseline,
          // 透传 user 显式输入的参数,让 dry-run power / isolation warning 与
          // 真实 run 一致(否则 batch dry-run 永远按 repeat=1 报警,误导用户)。
          repeat,
          judgeRepeat,
          judgeModels: effectiveJudgeModels,
          bootstrap,
          bootstrapSamples,
          lengthDebias,
          budget,
          noCache,
          verbose,
          concurrency,
          skipConnectivity,
          skipDoctor,
          // batch dry-run 关闭真实 run only 路径
          jobStore: null,
          persistJob: false,
          outputDir: null,
        });
        entryReport = result.report as DryRunReport;
      } catch (err) {
        // doctor abort 加 entry 名让 user / CI 定位是哪个 skill 卡住
        if (err instanceof Error && err.message.startsWith('doctor failed:')) {
          throw new Error(`${err.message} (skill=${entry.name})`);
        }
        throw err;
      }
      // batch 模式恒定 2 variants(baseline + treatment),sampleCount = totalTasks / variants.length
      dryArtifacts.push({
        name: entry.name,
        samplesPath: entry.samplesPath,
        sampleCount: entryReport.totalTasks / entryReport.variants.length,
        taskCount: entryReport.totalTasks,
      });
    }

    return {
      report: {
        dryRun: true,
        batch: true,
        model,
        judgeModels: effectiveJudgeModels,
        executor: executorName,
        skillDir,
        totalArtifacts: dryArtifacts.length,
        totalTasks: dryArtifacts.reduce((sum, a) => sum + a.taskCount, 0),
        artifacts: dryArtifacts,
      },
      filePath: null,
    };
  }
  return executeBatchEvaluationRuns({
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
    skipConnectivity,
    skipDoctor,
    lang,
    mcpConfig,
    verbose,
    repeat,
    judgeRepeat,
    judgeModels,
    bootstrap,
    bootstrapSamples,
    lengthDebias,
    budget,
    noCache,
    strictBaseline,
    variantAllowedSkills,
    runSingleEvaluation: async (options) => {
      // repeat > 1 时走 runMultiple 做 variance; batch=true 标记让 meta.request 如实反映。
      // holdoutRatio 显式转发(executeBatchEvaluationRuns 不一定把它塞进 options),否则
      // batch 子报告 meta.request.holdoutRatio 丢失、过拟合门控对 batch 静默失效。
      if (repeat && repeat > 1) {
        const multi = await runMultiple({ ...options, repeat, holdoutRatio, batch: true, judgeRepeat, judgeModels, bootstrap, bootstrapSamples, lengthDebias, budget });
        return { report: multi.report as EvaluationReport, filePath: multi.filePath };
      }
      const result = await runEvaluation({ ...options, batch: true, holdoutRatio, judgeRepeat, judgeModels, bootstrap, bootstrapSamples, lengthDebias, budget });
      return { report: result.report as EvaluationReport, filePath: result.filePath };
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
  const aggregated = buildVarianceData(runs, config.bootstrapSamples ?? DEFAULT_BOOTSTRAP_SAMPLES);
  let filePath: string | null = null;
  if (aggregated) {
    report.variance = aggregated;
    // pipeline 内部在 variance 赋值前已写入报告，需要重新写一次以包含方差数据
    filePath = persistReport(report, savedOutputDir || DEFAULT_OUTPUT_DIR);
  }

  return { report, aggregated, filePath };
}
