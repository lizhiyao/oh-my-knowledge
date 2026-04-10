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
  metadata?: Record<string, unknown>;
}

export type ExperimentType = 'baseline' | 'runtime-context-only' | 'artifact-injection';

export interface VariantConfig {
  variant: string;
  artifactKind: ArtifactKind;
  artifactSource: Artifact['source'];
  executionStrategy: ExecutionStrategyKind;
  experimentType: ExperimentType;
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
}

export interface LayeredScores {
  factScore?: number;       // 事实性得分：事实类断言通过率 → 1-5
  behaviorScore?: number;   // 行为合规得分：行为类断言通过率 → 1-5
  qualityScore?: number;    // 质量得分：LLM judge 平均分 → 1-5
}

export interface GradeResult {
  compositeScore: number;
  layeredScores?: LayeredScores;
  assertions?: AssertionResults;
  llmScore?: number;
  llmReason?: string;
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
  avgQualityScore?: number;
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
  variantConfigs?: VariantConfig[];
  request?: EvaluationRequest;
  run?: EvaluationRun;
  job?: EvaluationJob;
  gitInfo?: GitInfo | null;
  blind?: boolean;
  blindMap?: Record<string, string>;
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
}

export interface VarianceData {
  runs: number;
  perVariant: Record<string, { scores: number[]; mean: number; lower: number; upper: number; stddev: number }>;
  comparisons: Array<{ a: string; b: string; tStatistic: number; df: number; significant: boolean }>;
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
