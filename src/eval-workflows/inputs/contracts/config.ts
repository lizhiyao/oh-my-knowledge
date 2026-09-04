import type { JudgeConfig } from '../../instruments/contracts/config.js';
import type { ExperimentRole } from '../../../knowledge-artifacts/contracts.js';
import type { RemoteGitRef } from './variant.js';

export interface EvalConfigVariant {
  name: string;
  role: ExperimentRole;
  // artifact(本地路径 / 裸名 / git:<ref>:<spec>)与 git(远端结构化)二选一。
  artifact?: string;
  git?: RemoteGitRef;
  cwd?: string;
  // 显式 skill 隔离声明。优先级高于 --strict-baseline default。
  //   写 [] 完全禁用 skill 发现;非空白名单已移除(validateEvalConfig reject);不写 = 默认行为。
  // 注:YAML `allowedSkills:` 不写值会被 parse 成 null,validateEvalConfig 会显式 reject;
  //     要写就显式写 `[]`。
  allowedSkills?: string[];
}

export interface EvalDecisionPowerConfig {
  minimumDetectableDifference: number;
  expectedDifferenceStandardDeviation: number;
  targetPower?: number;
  assumptionSource: string;
}

export interface EvalDecisionConfig {
  threshold?: number;
  trivialDifference?: number;
  minimumComparisonUnits?: number;
  power?: EvalDecisionPowerConfig;
}

export interface EvalConfig {
  samples: string;
  executor?: string;
  model?: string;
  /** Reasoning effort for the executor LLM. low/medium/high/xhigh/max。
   *  Default 'low'(parseRunConfig 兜底)。跨 effort 报告不可严格比较。 */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** 关闭 diagnostic LLM call。Default false。跟 noJudge 独立 — judge 答打分,
   *  diagnostic 答怎么改 skill。 */
  noDiagnostic?: boolean;
  /** 跳过 doctor 健康检查门禁。Default false。 评测环境用 mock/stub 提供依赖时,
   *  doctor 物理路径检查会误报中断 eval — 加这个 escape hatch。判分管道、verdict、
   *  judge prompt hash 不动,跨报告可比性不变。 */
  skipDoctor?: boolean;
  /** Judge configuration. 1 entry = single judge (no ensemble); ≥ 2 entries = ensemble
   *  with inter-judge agreement. Replaces v0.1 split `judgeModel` + `judgeExecutor` —
   *  unified as a single first-class concept (single judge is the degenerate case of
   *  an ensemble of size 1). When unset, defaults to `[{executor, model: 'haiku'}]` where
   *  executor follows the top-level `executor`. */
  judgeModels?: JudgeConfig[];
  concurrency?: number;
  timeoutMs?: number;
  noCache?: boolean;
  noJudge?: boolean;
  mcpConfig?: string;
  variants: EvalConfigVariant[];
  /** hard budget caps. When any limit is hit during a run, remaining
   *  tasks are aborted and the partial report is persisted. CLI flags
   *  `--budget-usd` / `--budget-per-sample-usd` / `--budget-per-sample-ms`
   *  override the config values. */
  budget?: EvalBudget;
  // ----- v0.2: experiment-design fields (CLI flag → eval.yaml parity) -----
  /** --repeat N. Multi-run variance analysis. */
  repeat?: number;
  /** --holdout-ratio R (0 < R < 1). Hold out a deterministic sample slice and
   *  report train vs holdout composite as a generalization / overfitting signal. */
  holdoutRatio?: number;
  /** --judge-repeat N. Each (sample × dimension) judged N times for self-consistency stddev. */
  judgeRepeat?: number;
  /** --bootstrap. Distribution-free CI per variant + pairwise diff. */
  bootstrap?: boolean;
  /** --bootstrap-samples. Default 1000. */
  bootstrapSamples?: number;
  /** --gold-dir. After-run automatic comparison against a human-anchor dataset. */
  goldDir?: string;
  /** --no-debias-length flips this to false. Default true (length-debias instruction on). */
  lengthDebias?: boolean;
  /** --no-strict-baseline flips this to false. Default true (baseline-kind allowedSkills=[]). */
  strictBaseline?: boolean;
  /** Release-decision thresholds and optional a priori sample-size assumptions. */
  decision?: EvalDecisionConfig;
}

export interface EvalBudget {
  /** Stop the run if cumulative (exec + judge) cost exceeds this many USD. */
  totalUSD?: number;
  /** Per-sample cost ceiling. Tasks exceeding this fail individually but the run continues. */
  perSampleUSD?: number;
  /** Per-sample wall-clock latency ceiling in milliseconds. */
  perSampleMs?: number;
}
