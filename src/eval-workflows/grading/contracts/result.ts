/** Per-judge ensemble entry: which judge gave what score (mean over judge-repeat if N>1). */
export interface EnsembleJudgeResult {
  /** "executor:model" identifier — e.g. "claude:opus" or "openai-api:gpt-4o". */
  judge: string;
  /** Mean score from this judge over judge-repeat calls (or single score if repeat=1). */
  score: number;
  /** Stddev across judge-repeat calls from this judge (0 if repeat=1). */
  scoreStddev?: number;
  /** Raw scores per call (length = judgeRepeat). */
  scoreSamples?: number[];
  /** How many of judgeRepeat calls failed (returned score=0). */
  judgeFailureCount?: number;
  /** First-call CoT reasoning from this judge. */
  reasoning?: string;
  /** Cost in USD across all calls from this judge. */
  costUSD?: number;
  /** False = 该 judge 的 executor 不报 cost(如 codex)→ costUSD 是占位 0。 */
  costReportedByExecutor?: boolean;
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

export interface DimensionResult {
  score: number;
  reason: string;
  judgeCostUSD?: number;
  /** False = judge executor 不报 cost(如 codex)→ judgeCostUSD 是占位 0。缺位 / true 当真值。 */
  judgeCostReportedByExecutor?: boolean;
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
