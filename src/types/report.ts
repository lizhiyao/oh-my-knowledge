import type { ExecutorRuntimeFingerprint, ToolCallInfo, TurnInfo } from './executor.js';
import type { AssertionResults, DimensionResult, EnsembleJudgeResult, JudgeAgreement, JudgeConfig, JudgeRuntimeEntry, LayeredScores } from './judge.js';
import type { EvalBudget, EvaluationJob, EvaluationRequest, EvaluationRun, VariantConfig } from './eval.js';

export interface VariantResult {
  ok: boolean;
  durationMs: number;
  durationApiMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  execCostUSD: number;
  judgeCostUSD: number;
  /** Diagnostic 自身花费(USD)。仅在 failed-assertion 触发 diagnostic 且 executor 报告了 cost 时有值。
   *  Diagnostic 一般跑在 judge executor 上(claude:haiku 标配),所以 cost-reported 语义随
   *  `judgeCostReportedByExecutor`,不再单独引一个 flag。
   *  v0.30 新增,旧报告无此字段 — 老 costUSD 仍等于 execCostUSD + judgeCostUSD,新 costUSD
   *  含 diagnostic,跨版本汇总时按字段是否存在判断。 */
  diagnosticCostUSD?: number;
  /** sample 一行的真实总花费 = execCostUSD + judgeCostUSD + (diagnosticCostUSD ?? 0)。
   *  budget.perSampleUSD 的 cap 也是基于这个总值检查 — 任一子项把样本顶上限都算 overrun。 */
  costUSD: number;
  /** Whether `execCostUSD` came from a real cost number reported by the executor.
   *  Mirrors `ExecResult.costReportedByExecutor`. False ⇒ `execCostUSD` is a 0
   *  placeholder, renderer should show 「未报告」 instead of $0.0000. Default
   *  undefined ⇒ reported (preserves backward-compat for old reports). */
  costReportedByExecutor?: boolean;
  /** Whether `judgeCostUSD`(以及随之的 `diagnosticCostUSD`,因为它们走同一类 judge executor)
   *  came from a real cost number reported by the underlying executor.
   *  False ⇒ at least one judge / diagnostic call was made through an executor that doesn't
   *  report cost (currently codex). Default undefined ⇒ reported. */
  judgeCostReportedByExecutor?: boolean;
  numTurns: number;
  fullNumTurns?: number;
  numSubAgents?: number;
  assistantTurns?: number;
  toolTurns?: number;
  numToolCalls?: number;
  numToolFailures?: number;
  toolSuccessRate?: number;
  toolNames?: string[];
  /** per-sample tool call distribution (tool name → call count).
   *  Same shape as VariantSummary.toolDistribution but at sample granularity.
   *  Aggregating these gives true call-count totals; aggregating toolNames
   *  (deduped) only gives "samples-that-used-this-tool" counts. */
  toolDistribution?: Record<string, number>;
  traceCoverage?: number;
  error?: string;
  compositeScore?: number;
  layeredScores?: LayeredScores;
  assertions?: AssertionResults;
  llmScore?: number;
  llmReason?: string;
  /** Single-rubric mode: judge's chain-of-thought reasoning (first call when judgeRepeat > 1). */
  llmReasoning?: string;
  /** Single-rubric mode + judgeRepeat > 1: stddev across N judge calls. */
  llmScoreStddev?: number;
  /** Single-rubric mode + judgeRepeat > 1: raw scores from each call. */
  llmScoreSamples?: number[];
  /** Single-rubric mode + judgeRepeat > 1: how many of N calls failed. */
  llmScoreFailures?: number;
  /** Single-rubric mode + judgeModels.length >= 2: per-judge ensemble results. */
  llmEnsemble?: EnsembleJudgeResult[];
  /** Single-rubric mode + judgeModels.length >= 2: inter-judge agreement metrics. */
  llmAgreement?: JudgeAgreement;
  dimensions?: Record<string, DimensionResult>;
  factCheck?: { verifiedCount: number; totalCount: number; verifiedRate: number; claims: Array<{ type: string; value: string; verified: boolean; evidence?: string }> };
  outputPreview: string | null;
  fullOutput?: string;
  /** Functional-test 视角的诊断。与 Judge 评价(llmReason / llmReasoning)彻底独立:
   *  judge 答"打几分",diagnostic 答"哪错了 + 怎么改"。
   *  仅在至少有 1 条 failed assertion 时填充,且不受 --no-judge 影响(--no-diagnostic 控制)。 */
  diagnostic?: import('./judge.js').DiagnosticResult;
  turns?: TurnInfo[];
  toolCalls?: ToolCallInfo[];
  /** Sample.mocks 命中统计(从 ExecResult.mockStats 透传)。仅当 sample 配了 mocks 时有值。 */
  mockStats?: {
    hits: number;
    misses: number;
    perMock: Record<string, number>;
  };
  timing?: { execMs: number; gradeMs: number; totalMs: number };
}

export interface VariantSummary {
  totalSamples: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  avgDurationMs: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgTotalTokens: number;
  /** sum(ok-sample 的 costUSD)。等于 totalExecCostUSD + totalJudgeCostUSD + totalDiagnosticCostUSD。
   *  注意:仅含执行成功且未被 per-sample budget 标 overrun 的 sample,跟 meta.totalCostUSD(全量
   *  累计,含失败 sample)语义不同 — 那是历史 ok-filter 行为,跟 v0.30 的 diagnostic 引入无关。 */
  totalCostUSD: number;
  totalExecCostUSD: number;
  totalJudgeCostUSD: number;
  /** sum(ok-sample 的 diagnosticCostUSD)。0 / 缺位 ⇒ 没有 sample 触发 diagnostic。
   *  跟 totalJudgeCostUSD 一样吃 `judgeCostReported === false` 那一行的"未报告"语义,因为
   *  diagnostic executor 默认就是 judge executor。 */
  totalDiagnosticCostUSD?: number;
  avgCostPerSample: number;
  /** Whether every sample had its exec cost reported by the executor.
   *  - undefined / true : 所有样本 exec cost 都报告了 (默认,向后兼容)
   *  - false            : 至少一个样本 exec cost 未报告(混合执行器 / 全部走 codex 等)
   *  renderer 据此显示「成本: —」 而不是 "$0.0000"。 */
  execCostReported?: boolean;
  /** Whether every sample's judge cost was reported. False ⇒ 任一 sample 的 judge call
   *  走了不报 cost 的 executor(如 codex 当 judge)。renderer 在显示 totalJudgeCost /
   *  detail 页 cost meta-tag 总值时同时考虑 exec + judge,任一 false 显示「—」。 */
  judgeCostReported?: boolean;
  avgNumTurns: number;
  avgFullNumTurns?: number;
  avgNumSubAgents?: number;
  avgAssistantTurns?: number;
  avgToolTurns?: number;
  avgToolCalls?: number;
  avgToolFailures?: number;
  toolSuccessRate?: number;
  toolDistribution?: Record<string, number>;
  traceCoverageRate?: number;
  avgFactScore?: number;
  avgFactVerifiedRate?: number;
  avgBehaviorScore?: number;
  avgJudgeScore?: number;
  avgCompositeScore?: number;
  minCompositeScore?: number;
  maxCompositeScore?: number;
  scoreStddev?: number;
  scoreCV?: number;
  avgAssertionScore?: number;
  avgLlmScore?: number;
  minLlmScore?: number;
  maxLlmScore?: number;
  /** Aggregate-level multi-judge agreement across this variant's samples (single rubric mode).
   *  sampleCount = how many samples had complete ensemble data. */
  judgeAgreement?: JudgeAgreement & { sampleCount: number };
  /** Judges seen in this variant's ensemble data (`{executor, model}`). Renderer joins as
   *  "executor:model" for display. */
  judgeModels?: JudgeConfig[];
  /** Bootstrap CI on this variant's compositeScore mean (when --bootstrap enabled).
   *  Distribution-free; preferred over t-interval for ordinal LLM scores. */
  bootstrapCI?: { low: number; high: number; estimate: number; samples: number };
}

/**
 * Pairwise variant comparison stats — used when comparing treatment vs control.
 * Independent from per-variant `bootstrapCI` (which is on each variant alone).
 */
export interface VariantPairComparison {
  /** Control variant name (the subtrahend). */
  control: string;
  /** Treatment variant name (the minuend). */
  treatment: string;
  /** Bootstrap CI on (treatment - control) mean diff. `significant` = 0 outside CI. */
  diffBootstrapCI?: { low: number; high: number; estimate: number; samples: number; significant: boolean };
}

export interface GitInfo {
  commit: string;
  commitShort: string;
  branch: string;
  dirty: boolean;
}

/** Persisted form of agreement metrics between gold dataset and the LLM judge.
 *  Lives on ReportMeta so the renderer can show a "人工锚点" section without
 *  re-loading the gold dataset. */
export interface ReportHumanAgreement {
  /** Krippendorff α (interval weights) — primary metric. */
  alpha: number;
  /** Bootstrap 95% CI on α. */
  alphaCI: { low: number; high: number; estimate: number; samples: number };
  /** Quadratic-weighted κ — secondary metric. */
  weightedKappa: number;
  /** Pearson r — tertiary, rank-order only. */
  pearson: number;
  /** Number of (gold, judge) pairs that contributed. */
  sampleCount: number;
  /** Variant whose judge scores were compared. */
  variant: string;
  /** Identifier of the gold annotator (model id, person, or team handle). */
  goldAnnotator: string;
  /** Free-form version string from the gold metadata. */
  goldVersion: string;
  /** Set when annotator id overlapped with judge model id. */
  contaminationWarning?: string;
  /** Sample_ids in the gold set that were absent from the report. */
  missingCount: number;
  /** Sample_ids present in the report but with no judge score (assertion-only etc). */
  unscoredCount: number;
}

export interface ReportMeta {
  variants: string[];
  model: string;
  executor: string;
  /** Reasoning effort 用于被评测的 executor LLM(不是 judge)。
   *  缺位 = 未指定 / 走 executor 默认(historic)。值 'low'/'medium'/'high'/'xhigh'/'max'。
   *  跨 effort 的 report 不可严格比较,renderer 在 meta-tag 显式标出。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  sampleCount: number;
  taskCount: number;
  totalCostUSD: number;
  /** False when `totalCostUSD` is only the sum reported by executors/judges that expose USD cost. */
  totalCostReported?: boolean;
  timestamp: string;
  cliVersion: string;
  nodeVersion: string;
  artifactHashes: Record<string, string>;
  /** v0.21 — Report JSON schema version. Reports without this field are treated as v0
   *  (legacy field semantics: pre-v0.21 `gapRate`/`weightedGapRate` map to `evalGapRate`/
   *  `evalWeightedGapRate` for eval-side reports). v0.21+ writes 1. */
  schemaVersion?: number;
  /** SHA256-12 of every sample's content (sample_id → hash). Same hash = same sample. */
  sampleHashes?: Record<string, string>;
  /** SHA256-12 of the LLM judge prompt template. Different hash = judge changed semantics. */
  judgePromptHash?: string;
  /** Runtime fingerprint for the executor that produced tested outputs.
   *  Legacy/common field. Prefer executorRuntimes for variant-level audit; this
   *  field is the common runtime when all variants match, otherwise a representative
   *  runtime for older consumers. */
  executorRuntime?: ExecutorRuntimeFingerprint;
  /** Runtime fingerprints for tested-output executors, keyed by variant name.
   *  This is the strict construct-validity source because variants can resolve
   *  different skillDir / PATH environments. */
  executorRuntimes?: Record<string, ExecutorRuntimeFingerprint>;
  /** Number of times each sample was judged. 1 = single judge (default). */
  judgeRepeat?: number;
  /** Unified judge configuration with embedded runtime fingerprints. Always non-empty.
   *  - length === 1: single judge.
   *  - length >= 2: ensemble; agreement metrics reported per-result.
   *  Each entry's `runtime` is undefined ⇔ judge did not run for this report (see `noJudge`).
   *  Replaces v0.24- `judgeModel` + `judgeRuntime` (single) and stringified
   *  `judgeModels: string[]` + parallel `judgeRuntimes: Record<string, fp>` (ensemble). */
  judgeModels: JudgeRuntimeEntry[];
  /** True ⇒ no judge actually ran (--no-judge); each `judgeModels[i].runtime` is undefined.
   *  Renderer / comparability use this to short-circuit judge-related rendering & checks. */
  noJudge?: boolean;
  /** Which CI framework was used for this report: 't-test' (legacy default),
   *  'bootstrap' (--bootstrap), or 'both' (some summaries have both). Reports
   *  with mismatched frameworks shouldn't be compared blindly on CI bounds. */
  evaluationFramework?: 't-test' | 'bootstrap' | 'both';
  /** Pairwise comparisons (treatment vs control) — populated when --bootstrap and
   *  multi-variant. Length = (variants.length - 1). */
  pairComparisons?: VariantPairComparison[];
  /** Which judge-bias debias modes were active for this run.
   *  Values: 'length' (substance-not-length prompt), 'position' (random ensemble
   *  order). Empty / absent means legacy default (no debias). The renderer shows
   *  this so readers can tell apples from oranges across reports. */
  debiasMode?: Array<'length' | 'position'>;
  /** set to true when the run was aborted by a budget tracker. The
   *  report is partial: only tasks completed before the abort are present. */
  budgetExhausted?: boolean;
  /** budget caps that were active for this run, copied from request.budget
   *  for ease of reading without dereferencing request. */
  budget?: EvalBudget;
  /** Human-gold agreement when --gold-dir was passed at run time. Compares the
   *  judge's llmScore against the gold annotations on matching sample_ids. See
   *  src/grading/human-gold.ts for the metric definitions. */
  humanAgreement?: ReportHumanAgreement;
  variantConfigs?: VariantConfig[];
  /** Skill isolation 快照(per-variant)。
   *  key = variant name;value = allowedSkills(undefined → null,SDK 默认全发现 / [] → 完全隔离 / [...] → 白名单)。
   *  跨报告对比 verdict / Δ 时,isolation 状态不一致会被 stderr warn 标"不可比"。
   *  字段缺失意味着报告产自  之前(默认全发现,construct validity 不保证)。 */
  skillIsolation?: Record<string, string[] | null>;
  request?: EvaluationRequest;
  run?: EvaluationRun;
  job?: EvaluationJob;
  gitInfo?: GitInfo | null;
  blind?: boolean;
  blindMap?: Record<string, string>;
  // When true, HTML report expands the three-layer independent significance breakdown
  // by default (CLI `--layered-stats`). When false / absent, the breakdown is collapsed
  // and readers click the <details> summary to expand.
  layeredStats?: boolean;
}

export interface ResultEntry {
  sample_id: string;
  variants: Record<string, VariantResult>;
}

/**
 * Per-sample 设计快照(测试契约),仅用于报告渲染 — 单测视角需要展示"用例长什么样、
 * 期望什么、用了哪些工具调用 mock"。Grading / judge 不参考这个字段。
 *
 * 内容是 Sample 的子集,只保留渲染需要的字段:
 *   - prompt / rubric: 用例内容本身
 *   - assertions: 期望(运行后的 pass/fail 结果在 VariantResult.assertions.details 里)
 *   - mocks: 工具调用模拟返回(LLM 调到匹配的 tool/参数时拿到这段假返回,而不是真去调外部系统)
 *   - capability / construct / difficulty: 元数据
 *   - context: 附加上下文(代码片段等)
 *
 * 旧 report 没有这个字段,renderer 据此 fallback(隐藏单测 tab 或提示"无设计快照")。
 */
export interface SampleSnapshot {
  sample_id: string;
  prompt: string;
  rubric?: string;
  context?: string;
  assertions?: import('./eval.js').Assertion[];
  mocks?: import('./eval.js').Mock[];
  capability?: string[];
  difficulty?: import('./eval.js').SampleDifficulty;
  construct?: string;
  provenance?: import('./eval.js').SampleProvenance;
  /** Diagnostic 用 — tripwire sample 不该建议改 skill。 */
  tripwire?: boolean;
}

export interface EvaluationReport {
  kind: 'evaluation';
  id: string;
  meta: ReportMeta;
  summary: Record<string, VariantSummary>;
  results: ResultEntry[];
  /** 用例设计快照,按 sample_id 索引。供单测视角(test view)渲染"用例契约 + 期望"用,
   *  不参与 grading。旧 report 缺位时单测 tab 显示降级提示。 */
  sampleSnapshots?: Record<string, SampleSnapshot>;
  analysis?: AnalysisResult;
  variance?: VarianceData;
}

export type Report = EvaluationReport;

export interface BatchEvaluationMeta {
  mode: 'skill';
  model: string;
  executor: string;
  skillDir: string;
  sampleCount: number;
  taskCount: number;
  totalArtifacts: number;
  totalCostUSD: number;
  /** False when `totalCostUSD` is only the sum reported by executors/judges that expose USD cost. */
  totalCostReported?: boolean;
  timestamp: string;
  cliVersion: string;
  nodeVersion: string;
  executorRuntime?: ExecutorRuntimeFingerprint;
  executorRuntimes?: Record<string, ExecutorRuntimeFingerprint>;
  /** See ReportMeta.judgeModels — same semantics for batch reports. */
  judgeModels: JudgeRuntimeEntry[];
  /** See ReportMeta.noJudge. */
  noJudge?: boolean;
  request?: EvaluationRequest;
  run?: EvaluationRun;
  job?: EvaluationJob;
  gitInfo?: GitInfo | null;
}

export interface BatchEvaluationItem {
  /** Skill name; also the treatment variant key inside the child EvaluationReport. */
  name: string;
  skillPath: string;
  samplesPath: string;
  reportId: string;
  reportPath: string | null;
  status: 'completed' | 'failed';
  sampleCount: number;
  totalCostUSD: number;
  artifactHash: string | null;
  summary: Record<string, VariantSummary>;
  /** --batch --repeat N 时由 child EvaluationReport 聚合的三层独立 variance + t 检验快照 */
  variance?: VarianceData;
}

export interface BatchEvaluationReport {
  kind: 'batch-evaluation';
  id: string;
  mode: 'skill';
  meta: BatchEvaluationMeta;
  items: BatchEvaluationItem[];
}

export type ReportDocument = EvaluationReport | BatchEvaluationReport;

export interface Insight {
  type: string;
  severity: 'error' | 'warning' | 'info';
  details: unknown;
}

export interface KnowledgeCoverageEntry {
  path: string;
  type: string;
  accessed: boolean;
  accessCount: number;
  lineCount?: number;
}

export interface KnowledgeCoverage {
  entries: KnowledgeCoverageEntry[];
  filesCovered: number;
  filesTotal: number;
  fileCoverageRate: number;
  uncoveredFiles: string[];
  grepPatternsUsed: number;
  overallRate: number;
}

export interface AnalysisResult {
  /** @deprecated Legacy display text. Renderers generate localized summaries from structured report data. */
  summary?: string;
  insights: Insight[];
  /** @deprecated Legacy display text. Renderers generate localized suggestions from structured insights. */
  suggestions?: string[];
  coverage?: Record<string, KnowledgeCoverage>;
  /** Per-variant knowledge gap reports. See docs/knowledge-gap-signal-spec.md */
  gapReports?: Record<string, GapReport>;
  /** Sample design science aggregate. Built from sample metadata
   *  (capability / difficulty / construct / provenance); persisted on report
   *  for studio to surface coverage gaps. See docs/sample-design-spec.md. */
  sampleQuality?: SampleQualityAggregate;
}

/** Aggregated sample design coverage stats. Built by
 *  `buildSampleQualityAggregate(samples)` from `Sample.capability` /
 *  `Sample.difficulty` / `Sample.construct` / `Sample.provenance` fields.
 *  Pure documentation aggregate — no field here participates in grading,
 *  judge, or verdict. */
export interface SampleQualityAggregate {
  /** capability name (case-insensitive, dash/camel normalized) → sample count. */
  capabilityCoverage: Record<string, number>;
  /** difficulty bucket → count. `unspecified` key for samples without difficulty. */
  difficultyDistribution: Record<'easy' | 'medium' | 'hard' | 'unspecified', number>;
  /** construct value (free-form, suggested necessity/quality/capability) → count. */
  constructDistribution: Record<string, number>;
  /** provenance → count. `unspecified` for samples without provenance. */
  provenanceBreakdown: Record<string, number>;
  /** Mean rubric character length across all samples (0 if no rubric). */
  avgRubricLength: number;
  /** How many samples declared each metadata field (helpful for "completeness"). */
  sampleCountWithCapability: number;
  sampleCountWithDifficulty: number;
  sampleCountWithConstruct: number;
  sampleCountWithProvenance: number;
}

// v0.2 hedging classifier 的二次判定结果。挂在 GapSignalRef.classifierVerdict 上,
// 仅 hedging 类型的 signal 会有此字段(其他类型的硬证据不需要二次判定)。
// classifier 失败降级时 confidence=0 reason 标记 "classifier failed"。
export interface HedgingVerdict {
  isUncertainty: boolean;
  confidence: number;
  reason: string;
}

export interface GapSignalRef {
  sampleId: string;
  type: 'failed_search' | 'explicit_marker' | 'hedging' | 'repeated_failure';
  turn?: number;
  context: string;
  evidence?: Record<string, unknown>;
  // v0.2 严重度加权:信号可信度的权重。强证据(failed_search / repeated_failure)为 1.0,
  // 弱信号(explicit_marker / hedging,可能有假阳风险)为 0.5。
  // 聚合到 GapReport.weightedGapRate 时用来区分"硬盲区"和"可能噪声"。
  weight: number;
  // v0.2 hedging LLM-assisted 判定。仅 hedging 类型可能有此字段。
  // 缺失时表示该 signal 没经过 classifier(配置关闭 / 非 hedging 类型)。
  classifierVerdict?: HedgingVerdict;
}

export interface GapReport {
  variant: string;
  sampleCount: number;
  samplesWithGap: number;
  gapRate: number;
  // v0.2 严重度加权 gap rate:每个用例取其信号的最强权重,再按用例均值聚合。
  // `weightedGapRate ≤ gapRate`,差值反映"弱信号占比"——
  // 若 raw=30% 但 weighted=15% 意味着一半用例是软信号,该复核。
  weightedGapRate: number;
  testSetPath?: string | null;
  testSetHash?: string | null;
  signals: GapSignalRef[];
  byType: {
    failed_search: number;
    explicit_marker: number;
    hedging: number;
    repeated_failure: number;
  };
}

export interface VarianceEffectSize {
  cohensD: number;
  hedgesG: number;
  primary: 'd' | 'g' | 'none';
  magnitude: 'negligible' | 'small' | 'medium' | 'large' | 'none';
  pooledStddev: number;
  n1: number;
  n2: number;
}

export interface VarianceMetric {
  scores: number[];
  mean: number;
  lower: number;
  upper: number;
  stddev: number;
}

export interface VarianceComparisonMetric {
  meanDiff: number;
  tStatistic: number;
  df: number;
  significant: boolean;
  effectSize: VarianceEffectSize;
}

// Metric keys for non-quality dimensions tracked in byMetric.
// The top-level VariantVariance / VarianceComparison flat fields continue to
// carry composite-score variance for backward compatibility with historical reports.
export type VarianceMetricKey = 'cost' | 'efficiency';

// Layer keys for the three-layer independent significance tests.
// fact / behavior / judge are independent dimensions of the composite score:
// - fact: rule-verifiable factual claim assertions
// - behavior: rule-verifiable execution / tool-call compliance assertions
// - judge: subjective rubric-based LLM judge score (UI 中文: "LLM 评价")
// Running t-tests per layer prevents a mixed-signal change (e.g. judge ↑ 0.8,
// fact ↑ 0.1) from being diluted by the composite aggregate.
export type VarianceLayerKey = 'fact' | 'behavior' | 'judge';

export interface VariantVariance extends VarianceMetric {
  byMetric?: Partial<Record<VarianceMetricKey, VarianceMetric>>;
  byLayer?: Partial<Record<VarianceLayerKey, VarianceMetric>>;
}

export interface VarianceComparison extends VarianceComparisonMetric {
  a: string;
  b: string;
  byMetric?: Partial<Record<VarianceMetricKey, VarianceComparisonMetric>>;
  byLayer?: Partial<Record<VarianceLayerKey, VarianceComparisonMetric>>;
}

export interface VarianceData {
  runs: number;
  perVariant: Record<string, VariantVariance>;
  comparisons: VarianceComparison[];
  /** Saturation curve data. Populated only when repeat ≥ 2.
   *  Per-variant cumulative score arrays at each repeat checkpoint, plus the
   *  saturation verdict (only computed when repeat ≥ 5). */
  saturation?: SaturationData;
}

/** Per-variant saturation curve data + (optionally) verdict. */
export interface SaturationData {
  /** Cumulative checkpoint counts (sample-cumulative across runs). */
  checkpointSampleCounts: number[];
  /** Per-variant trace: at each checkpoint, mean and CI bounds.
   *  perVariant[variant][i] = { n, mean, ciLow, ciHigh } at checkpoint i. */
  perVariant: Record<string, Array<{ n: number; mean: number; ciLow: number; ciHigh: number }>>;
  /** Saturation verdict per variant. Only present when repeat ≥ 5. */
  verdicts?: Record<string, {
    saturated: boolean;
    atN: number | null;
    confidence: 'high' | 'medium' | 'low';
    method: 'slope' | 'bootstrap-ci-width' | 'plateau-height';
    threshold: number;
    reason: string;
  }>;
}
