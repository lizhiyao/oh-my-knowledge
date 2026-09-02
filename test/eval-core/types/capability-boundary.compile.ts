import type {
  AnalysisRunOptions,
  DecisionOptions,
  EvaluationReportRunOptions,
} from '../../../src/eval-core/analysis/index.js';
import type {
  ExecutionRunOptions,
  ExecutorTrialContext,
} from '../../../src/eval-core/execution/index.js';
import type {
  EvaluationRunOptions,
} from '../../../src/eval-core/evaluation/index.js';
import type {
  ExecutionBundle,
  PreparedEvaluationStageSession,
  SealedRunPlan,
} from '../../../src/eval-core/index.js';
import type { RunPlan } from '../../../src/eval-core/contracts/index.js';

declare const executorContext: ExecutorTrialContext;
declare const budgetSource: NonNullable<ExecutionRunOptions['budgetSource']>;

// @ts-expect-error Executor 只能看到执行输入，不能获得 Gold。
void executorContext.expected;

// @ts-expect-error Executor 不能获得只供评测阶段使用的上下文。
void executorContext.evaluationContext;

// @ts-expect-error 宿主只能转交 opaque budget capability，不能直接改写账本。
void budgetSource.reserve;

declare const wirePlan: RunPlan;
declare const wireExecution: ExecutionBundle;

// @ts-expect-error 可序列化 RunPlan 不是 prepare() 签发的 sealed capability。
const forgedPlan: SealedRunPlan = wirePlan;
void forgedPlan;

declare const stageSession: PreparedEvaluationStageSession;
// @ts-expect-error 裸 ExecutionBundle 不是 plan-aware admission 签发的 source capability。
stageSession.evaluate({ execution: wireExecution });

stageSession.evaluate({
  // @ts-expect-error 即使伪造 Bundle 与 verification 字段，也缺少 Core 私有 source brand。
  execution: {
    bundle: wireExecution,
    planVerification: {
      provenanceTrustStatus: 'indeterminate',
      cacheReceiptStatus: 'indeterminate',
      invocationBudgetStatus: 'indeterminate',
      providerCostBudgetStatus: 'indeterminate',
      minimumTargetInvocations: 0,
      maximumTargetInvocations: 0,
      unverifiedCacheRecordDigests: [],
    },
  },
});

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
