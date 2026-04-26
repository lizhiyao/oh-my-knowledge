/** Single judge configuration: which executor to call and which model alias to pass. */
export interface JudgeConfig {
  /** Executor name (claude / openai / gemini / anthropic-api / openai-api / shell command). */
  executor: string;
  /** Model alias passed to the executor (e.g. "opus", "haiku", "gpt-4o", "gemini-2.0-pro"). */
  model: string;
}

/** Per-judge ensemble entry: which judge gave what score (mean over judge-repeat if N>1). */
export interface EnsembleJudgeResult {
  /** "executor:model" identifier — e.g. "claude:opus" or "openai:gpt-4o". */
  judge: string;
  /** Mean score from this judge over judge-repeat calls (or single score if repeat=1). */
  score: number;
  /** Stddev across judge-repeat calls for this judge (0 if repeat=1). */
  scoreStddev?: number;
  /** Raw scores per call (length = judgeRepeat). */
  scoreSamples?: number[];
  /** How many of judgeRepeat calls failed (returned score=0). */
  judgeFailureCount?: number;
  /** First-call CoT reasoning from this judge. */
  reasoning?: string;
  /** Cost in USD across all calls from this judge. */
  costUSD?: number;
}

/** Inter-judge agreement metrics across an ensemble. Both metrics are pairwise-averaged. */
export interface JudgeAgreement {
  /** Pairwise Pearson correlation, averaged. 1 = judges fully agree on rank order; 0 = no
   *  correlation; -1 = anti-correlated. Note: only defined when at least one judge has
   *  variance (constant-score judges produce undefined Pearson). */
  pearson?: number;
  /** Pairwise mean absolute difference of scores. 0 = identical scores. On a 1-5 scale
   *  values < 0.5 are tight agreement, > 1.5 is large disagreement. */
  meanAbsDiff: number;
  /** Number of judge pairs the metrics were computed over (= n*(n-1)/2). */
  pairCount: number;
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
  /** Multi-judge ensemble: per-judge results when judgeModels.length >= 2. */
  ensemble?: EnsembleJudgeResult[];
  /** Multi-judge ensemble: inter-judge agreement metrics. */
  agreement?: JudgeAgreement;
}

export interface LayeredScores {
  factScore?: number;       // 事实层得分:事实类断言通过率 → 1-5(客观可验证)
  behaviorScore?: number;   // 行为层得分:行为类断言通过率 → 1-5(客观可验证)
  judgeScore?: number;      // LLM 评价得分:LLM judge 基于 rubric 的平均分 → 1-5(主观)
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
  /** Multi-judge ensemble (single rubric): per-judge results when judgeModels.length >= 2. */
  llmEnsemble?: EnsembleJudgeResult[];
  /** Multi-judge ensemble (single rubric): inter-judge agreement metrics. */
  llmAgreement?: JudgeAgreement;
  dimensions?: Record<string, DimensionResult>;
  judgeCostUSD?: number;
}
