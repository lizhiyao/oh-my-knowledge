export interface ToolCallInfo {
  tool: string;
  input: unknown;
  output: unknown;
  success: boolean;
}

export interface TurnInfo {
  role: 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallInfo[];
  durationMs?: number;
}

export interface ExecResult {
  ok: boolean;
  output: string | null;
  durationMs: number;
  durationApiMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  stopReason: string;
  numTurns: number;
  fullNumTurns?: number;
  numSubAgents?: number;
  error?: string;
  cached?: boolean;
  turns?: TurnInfo[];
  toolCalls?: ToolCallInfo[];
}

export interface ExecutorInput {
  model: string;
  system?: string | null;
  prompt: string;
  cwd?: string | null;
  skillDir?: string | null;
  timeoutMs?: number;
  verbose?: boolean;
}

export type ExecutorFn = (input: ExecutorInput) => Promise<ExecResult>;

export interface Assertion {
  type: string;
  value?: string | number;
  values?: string[];
  pattern?: string;
  flags?: string;
  schema?: Record<string, unknown>;
  weight?: number;
  fn?: string;
  reference?: string;
  threshold?: number;
}

export interface Sample {
  sample_id: string;
  prompt: string;
  context?: string;
  cwd?: string;
  rubric?: string;
  assertions?: Assertion[];
  dimensions?: Record<string, string>;
  allowedTools?: string[];
  expectedTools?: string[];
  [key: string]: unknown;  // allow extra fields like mutated prompt/context from URL resolution
}

export type ArtifactKind = 'baseline' | 'skill' | 'prompt' | 'agent' | 'workflow';

export interface Artifact {
  name: string;
  kind: ArtifactKind;
  source: 'baseline' | 'variant-name' | 'file-path' | 'git' | 'inline' | 'custom';
  content: string | null;
  locator?: string;
  ref?: string;
  cwd?: string;
  // run-time 属性：variant 在当次实验中扮演的角色（由 CLI --control/--treatment 或 eval.yaml 注入）
  // 不是 artifact 文件的固有属性；同一 artifact 在不同 run 可以扮演不同角色
  experimentRole?: ExperimentRole;
  metadata?: Record<string, unknown>;
}

export type ExperimentType = 'baseline' | 'runtime-context-only' | 'artifact-injection';

export type ExperimentRole = 'control' | 'treatment';

export interface VariantConfig {
  variant: string;
  artifactKind: ArtifactKind;
  artifactSource: Artifact['source'];
  executionStrategy: ExecutionStrategyKind;
  experimentType: ExperimentType;
  experimentRole: ExperimentRole;
  hasArtifactContent: boolean;
  cwd: string | null;
  locator?: string;
  ref?: string;
}

export type ExecutionStrategyKind =
  | 'baseline'
  | 'system-prompt'
  | 'user-prompt'
  | 'agent-session'
  | 'workflow-session';

export interface VariantSpec {
  name: string;           // variant 显示名，从 expr 提取（parseVariantCwd 后的 name 部分）
  role: ExperimentRole;
  expr: string;           // 原始 CLI / config 表达式（含 @cwd、git: 等前缀）
}

export interface EvalConfigVariant {
  name: string;
  role: ExperimentRole;
  artifact: string;
  cwd?: string;
}

export interface EvalConfig {
  samples: string;
  executor?: string;
  model?: string;
  judgeModel?: string | null;
  judgeExecutor?: string | null;
  concurrency?: number;
  timeoutMs?: number;
  noCache?: boolean;
  blind?: boolean;
  mcpConfig?: string;
  variants: EvalConfigVariant[];
}

export interface EvaluationRequest {
  samplesPath: string;
  skillDir: string;
  artifacts: Artifact[];
  project?: string;
  owner?: string;
  tags?: string[];
  model: string;
  judgeModel: string | null;
  executor: string;
  judgeExecutor?: string | null;
  noJudge: boolean;
  concurrency: number;
  timeoutMs?: number;
  noCache: boolean;
  dryRun: boolean;
  blind: boolean;
  /** --repeat N; 1 表示单次跑,> 1 走 runMultiple 做 variance 分析 */
  repeat?: number;
  /** --each; 默认不传(=false),true 表示 each mode (每个 skill 独立对比 baseline) */
  each?: boolean;
  /** --judge-repeat N; 每条 sample × dimension 用 LLM judge 跑 N 次, 输出 stddev. 默认 1 (单次). */
  judgeRepeat?: number;
}

export type EvaluationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type EvaluationErrorCategory = 'user' | 'executor' | 'judge' | 'system';

export interface EvaluationRun {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: Extract<EvaluationJobStatus, 'running' | 'succeeded' | 'failed' | 'cancelled'>;
}

export interface EvaluationJob {
  jobId: string;
  status: EvaluationJobStatus;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  request: EvaluationRequest;
  runId?: string;
  resultReportId?: string;
  error?: string;
  errorCategory?: EvaluationErrorCategory;
}

export interface ProgressStart {
  phase: 'start';
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
}

export interface ProgressExecDone {
  phase: 'exec_done';
  strategy: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  outputPreview: string | null;
}

export interface ProgressGrading {
  phase: 'grading';
  strategy: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
}

export interface ProgressDone {
  phase: 'done';
  strategy?: string;
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  score?: number;
  skipped?: boolean;
}

export interface ProgressRetry {
  phase: 'retry';
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  attempt: number;
  maxAttempts: number;
}

export interface ProgressError {
  phase: 'error';
  completed: number;
  total: number;
  sample_id: string;
  variant: string;
  error: string;
}

export interface ProgressPreflight {
  phase: 'preflight';
  jobId?: string;
}

export type ProgressInfo = ProgressStart | ProgressExecDone | ProgressGrading | ProgressDone | ProgressRetry | ProgressError | ProgressPreflight;
export type ProgressCallback = (info: ProgressInfo) => void;

export interface Task {
  sample_id: string;
  variant: string;
  artifact: Artifact;
  prompt: string;
  rubric: string | null;
  assertions: Assertion[] | null;
  dimensions: Record<string, string> | null;
  artifactContent: string | null;
  cwd: string | null;
  _sample: Sample;
}

export interface AssertionDetail {
  type: string;
  value: string | number;
  weight: number;
  passed: boolean;
  message?: string;
}

export interface AssertionResults {
  passed: number;
  total: number;
  score: number;
  details: AssertionDetail[];
  judgeCostUSD?: number;
}

export interface DimensionResult {
  score: number;
  reason: string;
  judgeCostUSD?: number;
  /** When judge-repeat > 1: scores from each judge run (length = repeat count). */
  scoreSamples?: number[];
  /** Standard deviation across scoreSamples (0 when repeat = 1). */
  scoreStddev?: number;
  /** Chain-of-thought reasoning produced by the judge before the final score. */
  reasoning?: string;
  /**
   * Number of judge calls that failed (returned score=0 / non-JSON / executor error).
   * Stddev = 0 + judgeFailureCount > 0 means "looks consistent but actually had failures",
   * NOT "judge agreed perfectly". Always check this before trusting low stddev.
   */
  judgeFailureCount?: number;
}

export interface LayeredScores {
  factScore?: number;       // 事实层得分：事实类断言通过率 → 1-5（客观可验证）
  behaviorScore?: number;   // 行为层得分：行为类断言通过率 → 1-5（客观可验证）
  judgeScore?: number;      // LLM 评价得分：LLM judge 基于 rubric 的平均分 → 1-5（主观）
}

export interface GradeResult {
  compositeScore: number;
  layeredScores?: LayeredScores;
  assertions?: AssertionResults;
  llmScore?: number;
  llmReason?: string;
  /** Single-rubric mode: judge's chain-of-thought reasoning (first call when judgeRepeat > 1). */
  llmReasoning?: string;
  /** When judge-repeat > 1 with single rubric: stddev across N judge calls. */
  llmScoreStddev?: number;
  /** When judge-repeat > 1 with single rubric: raw scores from each judge call. */
  llmScoreSamples?: number[];
  /** When judge-repeat > 1 with single rubric: how many of the N judge calls failed. */
  llmScoreFailures?: number;
  dimensions?: Record<string, DimensionResult>;
  judgeCostUSD?: number;
}

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
}

export interface GitInfo {
  commit: string;
  commitShort: string;
  branch: string;
  dirty: boolean;
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
  /** SHA256-12 of every sample's content (sample_id → hash). Same hash = same sample. */
  sampleHashes?: Record<string, string>;
  /** SHA256-12 of the LLM judge prompt template. Different hash = judge changed semantics. */
  judgePromptHash?: string;
  /** Number of times each sample was judged. 1 = single judge (default). */
  judgeRepeat?: number;
  variantConfigs?: VariantConfig[];
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
  // v0.2 严重度加权 gap rate:每个样本取其信号的最强权重,再按样本均值聚合。
  // `weightedGapRate ≤ gapRate`,差值反映"弱信号占比"——
  // 若 raw=30% 但 weighted=15% 意味着一半样本是软信号,该复核。
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
}

export interface McpFetchTool {
  name: string;
  urlParam?: string;
  urlTransform?: { regex: string; params: Record<string, string> };
  contentExtract?: string;
}

export interface McpServerDef {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  urlPatterns: string[];
  fetchTool: McpFetchTool;
}

export type McpServers = Record<string, McpServerDef>;

export interface ExecutorCache {
  get(key: string): ExecResult | null;
  set(key: string, value: ExecResult): void;
  save(): void;
  size(): number;
}

export interface ReportStore {
  list(): Promise<Report[]>;
  get(id: string): Promise<Report | null>;
  save(id: string, report: Report): Promise<void>;
  update(id: string, mutator: (report: Report) => void): Promise<Report | null>;
  remove(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  findByVariant(variantName: string): Promise<Report[]>;
  findByArtifactHash(hash: string): Promise<Report[]>;
}

export interface JobStore {
  list(): Promise<EvaluationJob[]>;
  get(id: string): Promise<EvaluationJob | null>;
  save(id: string, job: EvaluationJob): Promise<void>;
  update(id: string, mutator: (job: EvaluationJob) => EvaluationJob): Promise<EvaluationJob | null>;
  remove(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
}

// For renderer functions that accept partial report-like objects
export type Lang = 'zh' | 'en';
