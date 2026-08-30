import type {
  AnalysisRunOptions,
  DecisionOptions,
  EvaluationReportRunOptions,
} from '../../../src/evaluation-core/analysis/index.js';
import type {
  ExecutionRunOptions,
  ExecutorTrialContext,
} from '../../../src/evaluation-core/execution/index.js';
import type {
  EvaluationRunOptions,
} from '../../../src/evaluation-core/evaluation/index.js';

declare const executorContext: ExecutorTrialContext;

// @ts-expect-error Executor 只能看到执行输入，不能获得 Gold。
void executorContext.expected;

// @ts-expect-error Executor 不能获得只供评测阶段使用的上下文。
void executorContext.evaluationContext;

type KeysOfUnion<Value> = Value extends unknown ? keyof Value : never;

type CoreRunOptions =
  | ExecutionRunOptions
  | EvaluationRunOptions
  | AnalysisRunOptions
  | DecisionOptions
  | EvaluationReportRunOptions;

type AllowedRunOptionKey =
  | 'runId'
  | 'bundleId'
  | 'reportId'
  | 'signal'
  | 'eventBufferCapacity'
  | 'annotations'
  | 'summaries'
  | 'budgetSource';

type AssertNever<Value extends never> = Value;

/**
 * RunOptions 只承载本次运行的身份、取消和物化参数；测量策略必须来自已密封计划。
 * 新增任何策略覆写字段都会让 `yarn typecheck` 失败。
 */
export type RunOptionsPolicyBoundary = AssertNever<Exclude<
  KeysOfUnion<CoreRunOptions>,
  AllowedRunOptionKey
>>;
