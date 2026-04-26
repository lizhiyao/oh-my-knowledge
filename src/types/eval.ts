import type { JudgeConfig } from './judge.js';

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
  /** v0.21 Phase 5a — when true, the assertion's pass/fail is inverted. Works
   *  with any type, including legacy `not_contains` (which becomes a redundant
   *  but still supported double-negation). */
  not?: boolean;
  /** v0.21 Phase 5a — only used by type='assert-set'. 'any' = at least one
   *  child must pass; 'all' = every child must pass. Children may be any
   *  assertion type, including nested assert-sets. */
  mode?: 'any' | 'all';
  children?: Assertion[];
  /** v0.21 Phase 5b — for rouge_n_min: which n-gram order (default 1). */
  n?: number;
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
  // run-time 属性:variant 在当次实验中扮演的角色(由 CLI --control/--treatment 或 eval.yaml 注入)
  // 不是 artifact 文件的固有属性;同一 artifact 在不同 run 可以扮演不同角色
  experimentRole?: ExperimentRole;
  metadata?: Record<string, unknown>;
}

export type ExperimentType = 'baseline' | 'runtime-context-only' | 'artifact-injection';

export type ExperimentRole = 'control' | 'treatment';

export type ExecutionStrategyKind =
  | 'baseline'
  | 'system-prompt'
  | 'user-prompt'
  | 'agent-session'
  | 'workflow-session';

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

export interface VariantSpec {
  name: string;           // variant 显示名,从 expr 提取(parseVariantCwd 后的 name 部分)
  role: ExperimentRole;
  expr: string;           // 原始 CLI / config 表达式(含 @cwd、git: 等前缀)
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
  /** v0.22 — hard budget caps. When any limit is hit during a run, remaining
   *  tasks are aborted and the partial report is persisted. CLI flags
   *  `--budget-usd` / `--budget-per-sample-usd` / `--budget-per-sample-ms`
   *  override the config values. */
  budget?: EvalBudget;
}

export interface EvalBudget {
  /** Stop the run if cumulative (exec + judge) cost exceeds this many USD. */
  totalUSD?: number;
  /** Per-sample cost ceiling. Tasks exceeding this fail individually but the run continues. */
  perSampleUSD?: number;
  /** Per-sample wall-clock latency ceiling in milliseconds. */
  perSampleMs?: number;
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
  /** --judge-models executor:model,executor:model,... — multi-judge ensemble.
   *  当传入 ≥ 2 个 judge 时, 每条 sample × dimension 由所有 judge 各自打分, 输出
   *  inter-judge agreement (Pearson correlation + mean absolute difference) — 反驳
   *  "Claude judge Claude 同模态偏差" 的硬证据. 与 judgeRepeat 可组合. */
  judgeModels?: JudgeConfig[];
  /** --bootstrap; true 时 aggregateReport 加跑 bootstrap mean/diff CI, 写入 VariantSummary.
   *  与原 t-interval 共存 (ReportMeta.evaluationFramework='both'), renderer 优先 bootstrap. */
  bootstrap?: boolean;
  /** --bootstrap-samples N; bootstrap 重采样次数, 默认 1000. > 10000 时 stderr 警告. */
  bootstrapSamples?: number;
  /** v0.21 Phase 3a length-debias toggle. Default true (judge prompt v3-cot-length).
   *  CLI flag --no-debias-length flips to false (legacy v2-cot prompt). The active
   *  value is reflected in ReportMeta.judgePromptHash and ReportMeta.debiasMode. */
  lengthDebias?: boolean;
  /** v0.22 — hard budget caps. See EvalBudget. */
  budget?: EvalBudget;
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
