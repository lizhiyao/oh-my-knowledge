import type { ToolCallInfo, TurnInfo } from './executor.js';
import type { AssertionResults, DimensionResult, EnsembleJudgeResult, JudgeAgreement, LayeredScores } from './judge.js';
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
  costUSD: number;
  numTurns: number;
  fullNumTurns?: number;
  numSubAgents?: number;
  assistantTurns?: number;
  toolTurns?: number;
  numToolCalls?: number;
  numToolFailures?: number;
  toolSuccessRate?: number;
  toolNames?: string[];
  /** v0.22 — per-sample tool call distribution (tool name → call count).
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
  turns?: TurnInfo[];
  toolCalls?: ToolCallInfo[];
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
  totalCostUSD: number;
  totalExecCostUSD: number;
  totalJudgeCostUSD: number;
  avgCostPerSample: number;
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
  /** List of judge identifiers ("executor:model") seen in this variant's ensemble data. */
  judgeModels?: string[];
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
  judgeModel: string | null;
  executor: string;
  sampleCount: number;
  taskCount: number;
  totalCostUSD: number;
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
  /** Number of times each sample was judged. 1 = single judge (default). */
  judgeRepeat?: number;
  /** Multi-judge ensemble configuration: ["claude:opus", "openai:gpt-4o", ...].
   *  When length >= 2, every (sample × dimension) is scored by all judges and
   *  agreement metrics are reported per-result. */
  judgeModels?: string[];
  /** Which CI framework was used for this report: 't-test' (legacy default),
   *  'bootstrap' (--bootstrap), or 'both' (some summaries have both). Reports
   *  with mismatched frameworks shouldn't be compared blindly on CI bounds. */
  evaluationFramework?: 't-test' | 'bootstrap' | 'both';
  /** Pairwise comparisons (treatment vs control) — populated when --bootstrap and
   *  multi-variant. Length = (variants.length - 1). */
  pairComparisons?: VariantPairComparison[];
  /** v0.21 Phase 3 — which judge-bias debias modes were active for this run.
   *  Values: 'length' (substance-not-length prompt), 'position' (random ensemble
   *  order). Empty / absent means legacy default (no debias). The renderer shows
   *  this so readers can tell apples from oranges across reports. */
  debiasMode?: Array<'length' | 'position'>;
  /** v0.22 — set to true when the run was aborted by a budget tracker. The
   *  report is partial: only tasks completed before the abort are present. */
  budgetExhausted?: boolean;
  /** v0.22 — budget caps that were active for this run, copied from request.budget
   *  for ease of reading without dereferencing request. */
  budget?: EvalBudget;
  /** Human-gold agreement when --gold-dir was passed at run time. Compares the
   *  judge's llmScore against the gold annotations on matching sample_ids. See
   *  src/grading/human-gold.ts for the metric definitions. */
  humanAgreement?: ReportHumanAgreement;
  variantConfigs?: VariantConfig[];
  /** v0.22 — Skill isolation 快照(per-variant)。
   *  key = variant name;value = allowedSkills(undefined → null,SDK 默认全发现 / [] → 完全隔离 / [...] → 白名单)。
   *  跨报告对比 verdict / Δ 时,isolation 状态不一致会被 stderr warn 标"不可比"。
   *  字段缺失意味着报告产自 v0.22 之前(默认全发现,construct validity 不保证)。 */
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

export interface Report {
  id: string;
  meta: ReportMeta;
  summary: Record<string, VariantSummary>;
  results: ResultEntry[];
  analysis?: AnalysisResult;
  variance?: VarianceData;
  each?: boolean;
  overview?: {
    totalArtifacts: number;
    totalSamples: number;
    totalCostUSD: number;
    artifacts: Array<{
      name: string;
      baselineScore: number | null;
      artifactScore: number | null;
      improvement: string;
    }>;
  };
  artifacts?: Array<{
    name: string;
    sampleCount: number;
    artifactHash: string | null;
    summary: Record<string, VariantSummary>;
    /** --each --repeat N 时由 runMultiple 聚合的三层独立 variance + t 检验 */
    variance?: VarianceData;
    results: ResultEntry[];
  }>;
}

export interface Insight {
  type: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
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
  summary?: string;
  insights: Insight[];
  suggestions: string[];
  coverage?: Record<string, KnowledgeCoverage>;
  /** Per-variant knowledge gap reports. See docs/knowledge-gap-signal-spec.md */
  gapReports?: Record<string, GapReport>;
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

// Layer keys for the three-layer independent significance tests (v0.16 work item B / PR-2).
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
  /** v0.21 Phase 4 — saturation curve data. Populated only when repeat ≥ 2.
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
