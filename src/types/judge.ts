import type { ExecutorRuntimeFingerprint } from './executor.js';

/** Single judge configuration: which executor to call and which model alias to pass. */
export interface JudgeConfig {
  /** Executor name (claude / openai / gemini / anthropic-api / openai-api / shell command). */
  executor: string;
  /** Model alias passed to the executor (e.g. "opus", "haiku", "gpt-4o", "gemini-2.0-pro"). */
  model: string;
}

/** Persisted judge entry on Report.meta.judgeModels: judge config + runtime fingerprint of
 *  the executor that actually performed the judging. runtime is undefined when the judge
 *  did not run (noJudge mode) — preserves the configured judge for audit even without
 *  execution. */
export interface JudgeRuntimeEntry {
  executor: string;
  model: string;
  /** Runtime fingerprint of the judge executor at run time. Undefined ⇒ judge did not run. */
  runtime?: ExecutorRuntimeFingerprint;
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

/**
 * Diagnostic 结果 — 与 Judge 评价彻底独立的诊断视角。
 *
 * 触发条件:sample 至少有 1 条 failed assertion(无论 --no-judge 是否开启)。
 * 输入:rubric / 期望的 assertions / skill 原文 / LLM 实际 trace+输出 / 失败的断言清单。
 * 目的:告诉 skill 作者"哪错了 + 怎么改",而不是"打几分"。
 *
 * rootCause 五选(可多选):
 *   skill_doc_unclear      文档本身缺 / 模糊
 *   skill_doc_missing      skill 没覆盖该场景
 *   llm_misread            skill 写了但 LLM 误读(可能要改 skill 措辞)
 *   sample_design          sample 设计有 bug(rubric / mock 跟 skill 矛盾)
 *   tripwire_intentional   sample 故意设计的反模式陷阱,LLM fail 是预期 — 不要建议改 skill
 */

/**
 * 单步工作流校验项 — 把 rubric / skill 规定的步骤拆出来,逐条对 LLM 实际 trace 勾选。
 * 让用户用看 checklist 的方式快速判断 LLM 走对了哪几步、哪一步出了问题,
 * 不用从 judge / diagnostic 的散文段落里自己拼工作流。
 */
export interface WorkflowCheck {
  /** 该步骤的中文描述,如"调 code-host auth status 拿 username"。 */
  step: string;
  /** LLM 是否完成该步骤。 */
  passed: boolean;
  /** 中文证据:passed=true 时引用 trace 中相应工具调用 / 输出片段;passed=false 时说明哪里偏离。 */
  evidence: string;
}

/**
 * 失败模式标签 — LLM 在该 sample 上"是怎么错的"的行为分类(可多选)。
 * 跟 rootCause 的区别:rootCause 答"是 skill 还是 LLM 的责任",failureMode 答"行为本身是什么类别的错"。
 *
 *   工作流跳步     没按 rubric/skill 规定的步骤顺序执行
 *   硬编码值       该用变量传递的字段写死成具体值
 *   幻觉输出       声称完成 / 给出实际不存在的结果(commit hash / 文件 / id 等)
 *   工具误用       选错工具 / 参数错 / 重复尝试同一失败动作
 *   环境拦截       mock-strict / 工具不可用导致 LLM 行为正确但仍 fail
 *   误读约束       skill 写清楚的约束被 LLM 漏掉 / 误读
 *   其他           兜底,不属于以上任何类
 */
export type FailureMode =
  | '工作流跳步'
  | '硬编码值'
  | '幻觉输出'
  | '工具误用'
  | '环境拦截'
  | '误读约束'
  | '其他';

export const FAILURE_MODES: readonly FailureMode[] = [
  '工作流跳步', '硬编码值', '幻觉输出', '工具误用', '环境拦截', '误读约束', '其他',
] as const;

export interface DiagnosticResult {
  /** 失败本质,1-2 句。 */
  summary: string;
  /** rubric / assertions 期望什么具体行为。 */
  expected: string;
  /** LLM 实际做了什么。 */
  actual: string;
  /** 失败归因(允许多个,空数组当 'unknown')。 */
  rootCause: Array<'skill_doc_unclear' | 'skill_doc_missing' | 'llm_misread' | 'sample_design' | 'tripwire_intentional'>;
  /**
   * rubric / skill 规定的步骤逐条勾选。空数组表示 LLM 没拆出可勾选的工作流(rubric 是开放式描述、
   * 或 sample 不是工作流型任务)。该字段是 v0.30 新增,旧报告无此字段(可选)。
   */
  workflowChecks?: WorkflowCheck[];
  /**
   * 失败模式标签(中文枚举,可多选)。空数组表示诊断不归类任何模式。
   * 该字段是 v0.30 新增,旧报告无此字段(可选)。
   */
  failureModes?: FailureMode[];
  /** 修改建议 — 三个角度都可以为空字符串(意味"该角度无需调整")。 */
  suggestion: {
    /** 改 skill 哪一节、加什么话(引用具体章节,带 patch 思路)。 */
    skill: string;
    /** sample 设计调整建议(如 mock match rule 太严 / rubric 跟 skill 不一致 / 等)。 */
    sample: string;
    /** "无需改动"的解释(如 tripwire 设计意图 + LLM 该 fail)。 */
    none: string;
  };
  /** Diagnostic 自身花费(USD)。 */
  costUSD?: number;
  /** Diagnostic 是否成功(LLM JSON parse 失败时为 false,fallback 显示原始文本)。 */
  ok: boolean;
  /** Diagnostic 失败时的错误信息(ok=false 时使用)。 */
  error?: string;
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
  /** False = async assertion 用的 judge executor 不报 cost(如 codex)→ judgeCostUSD 是占位 0。
   *  缺位 / true 当真值。renderer 据此跳过 $0.0000 显示。 */
  judgeCostReportedByExecutor?: boolean;
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
  /** False = 至少一处 judge call(dim / single rubric / async assertion)的 executor 不报 cost
   *  → judgeCostUSD 累计是 lower-bound 而非真值。缺位 / true 当真值。 */
  judgeCostReportedByExecutor?: boolean;
}
