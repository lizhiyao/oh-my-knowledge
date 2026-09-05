# eval-runtime API 分层

`package.json#exports` 是受支持边界，API allowlist 会锁定下列全部 value 与 type。所有入口仅支持 ESM。

## `oh-my-knowledge`

这是普通用户的推荐入口，与 `oh-my-knowledge/eval-runtime` 暴露完全相同的 canonical Runtime façade：`evaluate`、`prepareEvaluation`、`checkExecutor`、稳定错误和公开模型 type。Core engine、builder、registration 与 adapter 不会进入包根。

## `oh-my-knowledge/eval-runtime`

面向应用开发者的 canonical API：

| Export | 用途 |
|---|---|
| `evaluate` | 运行一份显式的 solo、paired 或 independent-group 评测设计，包括多臂与多指标比较。 |
| `prepareEvaluation` | 在任何 Target 或 Evaluator 调用前，封存并检查最终 Definition、Policy、Plan、Runtime resolution、digest 和工作量估计。 |
| `checkExecutor` | 通过成功、失败、取消、清理和测量检查认证 Executor。 |
| `EvaluationConfigurationError` | 稳定的调用方配置错误；只包含公开 code，不保留被拒绝 payload。 |
| `EvaluationEventConsumptionError` | 稳定且脱敏的观察器／event stream 错误；可用时保留终态 `EvaluationResult`。 |

公开模型 type 包括 `Artifact`、`ArtifactKind`、`ArtifactSource`、`Variant`、`VariantExecution`、`RuntimeContext`、`WorkspaceDescriptor`、`WorkspaceInput`、`WorkspacePlan`、`WorkspaceProvider`、`WorkspaceOpenRequest`、`WorkspaceLease`、`WorkspaceAccess`、`Dataset`、`Sample`、`EvaluationExecutor`、`Executor`、`InvokeExecutor`、`SessionExecutor`、`ExecutorSessionContext`、`ExecutorSessionAttempt`、`ExecutorSession`、`ExecutorCapabilities`、`ExecutorInvocation`、`ExecutorResult`、`Evaluator`、`ExactMatchEvaluator`、`RetrievalEvaluator`、`RetrievalMetricIds`、`ToolTrajectoryEvaluator`、`ToolTrajectoryMatchMode`、`RubricJudgeEvaluator`、`RubricJudgeMember`、`RubricJudgeAggregation`、`CustomEvaluator`、`CustomEvaluatorInvocation`、`CustomEvaluatorResult`、`CustomEvaluatorBinding`、`CustomEvaluatorContent`、`Metric`、`Judge`、`Rubric`、`Experiment`、`SamplingDesign`、`AnalysisRequest`、`CohortFilter`、`Comparison`、`ComparisonFamilyMember`、`CompositeMetricComponent`、`CompositeAggregation`、`Decision`、`FamilyDecisionCriterion`、`Policy`、`StagePolicy`、`RetryPolicy`、`RetryBackoff`、`FailurePolicy`、`BudgetPolicy`、`BudgetScope`、`RunBudgetScope`、`AttemptBudgetScope`、`ProviderCostLimit`、`EvaluateInput`、`EvaluationRunOptions`、`EvaluationResult`、`PreparedEvaluation`、`PreparedEvaluationPlan`、`RuntimeCapabilityResolution`、`EvaluationWorkEstimate`、`EventObserver` 与 `Clock`。Executor 认证使用 `ExecutorCheckInput`、`ExecutorCheckResult` 与 `RuntimeConformanceCheck`。

`Policy` 使用相互独立的 execution／evaluation `StagePolicy`。每个 stage 分别封存 concurrency、timeout 与可选 `RetryPolicy`；retry error code 是宿主定义的稳定 identifier，`RetryBackoff` 是显式的 `none`／`fixed`／`exponential` 判别联合。`FailurePolicy` 同样使用判别联合，只有 `failure-threshold` 可以携带 `maxFailures`。`BudgetPolicy` 暴露 run、stage、coordinate 与 attempt scope，以及可审计的 invocation、active-duration、wall-clock 和 provider-cost limit。Provider-cost admission 固定为 bounded overshoot；`onUnreportedProviderCost` 选择失败关闭或不可验证处理。Façade 只负责把声明物化为 Core Measurement Policy；scheduler、timeout、retry、取消、预算计量和 failure-threshold 行为仍全部由 Core 实现。

`RuntimeContext` 只包含可重放的宿主自定义 JSON `values`。Variant 使用内容寻址的 `WorkspaceDescriptor` 选择逻辑 workspace，也可以使用包含一个 `default` 和 `bySampleId` override 的 `WorkspacePlan`；`null` 表示为该 sample 显式禁用默认 workspace。Executor 持有对应的 `WorkspaceProvider`：稳定的 `providerId`、`version` 和可选的测量相关 `fingerprintFacets` 进入 Runtime identity，credential、CAS locator、cache 与 base directory 则只保留在 provider closure 内；canonical 与 advanced JSON adapter 都会把 provider identity 强制组合到最终 Executor fingerprint。`prepareEvaluation()` 只封存 descriptor，不打开 lease。执行时 provider 必须验证请求的不可变 descriptor，并返回一份带绝对路径、trial 私有 `root` 的新 `WorkspaceLease`。同一 trial 的 retry 复用同一个 `WorkspaceAccess`，随后无论成功、失败、timeout 还是取消，Runtime 都会调用 `close()`。OMK 自身绝不会把物理 root 或 provider 私有状态加入 Definition、result 或 error；Executor 同样不应通过自己的 output 或 trace 返回 locator。Invoke 与 session Executor 只能看到 `{ descriptor, root }`，无法关闭其它组件持有的 lease。跨 trial 复用 lease object、复用仍活跃的物理 root，都会失败关闭；清理失败的 root 在当前进程中保持隔离。`open()` 与 `close()` 必须是有界的本地资源工作。Lease 提供的是测量隔离，不是安全 sandbox；不可信代码的 containment 仍由宿主负责。`checkExecutor()` 当前会拒绝带 workspace 的声明，因为通用 probe 还无法证明 materialization 与隔离；workspace conformance probe 完成前，应使用真实 Evaluation 验证。

```ts
const executor: Executor<string, undefined, string> = {
  executorId: 'acme.agent/v1',
  version: '1.0.0',
  schemas: { input: z.string(), output: z.string() },
  workspaceProvider: {
    providerId: 'acme.cas-workspace/v1',
    version: '1.0.0',
    async open({ descriptor, runId, trialId }) {
      const root = await materializeFreshOverlay(descriptor, { runId, trialId });
      return { root, close: () => removeOverlay(root) };
    },
  },
  async execute({ input, workspace, signal }) {
    return { output: await runAgent(input, { cwd: workspace?.root, signal }) };
  },
};

const variant: Variant<string, undefined, string> = {
  variantId: 'workspace-agent-v1',
  artifact: { name: 'workspace-agent-v1', kind: 'agent', source: 'inline', content: '...' },
  execution: { executor, workspace: workspaceDescriptor },
};
```

`Sample.executionContext` 是单条用例中仅供 Executor 使用的输入，`Sample.evaluationContext` 是仅供 Evaluator 使用的输入；这两个用例投影都不描述宿主运行环境。

`EvaluationExecutor` 是 Variant 接受的联合类型。`Executor` 及其显式别名 `InvokeExecutor` 运行单次无状态 `omk.invoke/v1` callback；省略 `protocol` 就是 invoke。`SessionExecutor` 必须声明 `protocol: 'session'`，并为每个 Core trial 打开一个隔离且新分配的 `ExecutorSession` object；跨 trial 或 Run 复用同一个 object 会被拒绝。`ExecutorSessionContext` 只暴露 Target 最小权限投影与稳定 `runId`／`trialId`，绝不包含 Gold 或 evaluation-only context。Retry 会在同一 session 上调用 `execute()`，并传入新的 `ExecutorSessionAttempt`，其中包含 `attemptId`、`attemptNumber` 与 Core `AbortSignal`。坐标派生的 `attemptId` 可能在另一个 Run 中重复，因此 provider 幂等键还必须用 `runId` 或等价的 provider session scope 限定命名空间。成功、失败、timeout 和取消最后都只调用一次 `close()`。`openSession()` 与 `close()` 必须是有界的本地生命周期工作；打开 session 属于资源获取，不是被计量的 provider attempt，因此计费或模型工作必须放在 `execute()`。Session 只在当前 Run 内临时存在，不是跨 Run conversation 或 memory store。

`EvaluationResult` 保留 Core `EvaluationRunResult` 的全部字段，并增加实际使用的 `runId`、`definition`、`policy` 与 `analysisResults`。最后一项只是按 `analysisId` 索引同一批 Core Analysis record 的只读视图，不是第二套分析实现。执行与评价 evidence 位于 `artifacts`，Decision 位于 `artifacts.decision`，公开 Report 位于 `report`。

`EvaluateInput` 只包含测量声明；`EvaluationRunOptions` 容纳单次运行的 `runId`、取消、进度观察、报告 annotation／summary、event buffer 容量与 clock。省略 `runId` 时由 Runtime 生成，并通过 `EvaluationResult.runId` 返回。`prepareEvaluation(input)` 会捕获全部可变声明、物化默认值、解析 Runtime capability，并在不调用 Target 或 Evaluator 的情况下封存 Core Plan。冻结的 `PreparedEvaluation` 暴露准确的 `definition`、`policy`、`plan`、完整运行契约 `planDigest`、`resolvedRuntimes` 与 `estimatedWork`；`run(options)` 直接执行同一份 sealed Plan，不重新读取 input 或重新编译。计划 coordinate 不包含 retry 与提前终止带来的变化，duration 和 provider cost 在执行前会明确保持不确定。

`SamplingDesign` 支持单 Variant 的 `solo` 质量画像、complete-block `paired` 比较和 fixed-quota `independent` 比较，也是 paired／independent 语义的唯一持有者。solo 设计可以声明 `clusterKey`，此时 Core 将完整 cluster 作为实验单位与重采样单位。一项 `Comparison` 声明一个 control、一个或多个 treatment 与参与分析的 Metric，不再包含重复的 sampling 判别字段。`evaluators` 可包含多个 exact-match、retrieval、tool-trajectory、Rubric 评委或 custom evaluator，但 evaluator ID 与 metric ID 必须分别唯一。

`RetrievalEvaluator` 是 source-neutral 的 binary-relevance top-k 预设。它从显式 output 或 trace JSON Pointer 读取不重复的有序文档 ID 数组，并只从 `Sample.expected` 读取非空、不重复的 relevant ID 集合。四个 `RetrievalMetricIds` 都是有界、higher-is-better 的 sample Metric：Recall@k 的分母是全部已知 relevant 文档数；Precision@k 的分母始终是 `k`，不足的返回位置按未命中处理；Reciprocal Rank@k 使用首个 relevant 文档的名次；nDCG@k 使用 binary gain 与 log2 discount。计算前先按 cutoff 截断 ranking。重复或非法 ID、空 relevant 集合会产出 invalid evidence，不会静默去重、clamp 或产生 `NaN`。对 Reciprocal Rank Metric 使用 summary `mean` 即得到 MRR。Cutoff、pointer、Metric ID 与算法身份都会封存到 Definition 和 Runtime fingerprint。

`ToolTrajectoryEvaluator` 会确定性比较完整 `omk.source-neutral-trace/v2` 中的 `ToolCallInfo.tool` 名称与只从 `Sample.expected` 投影的工具名。显式 `ToolTrajectoryMatchMode` 包含 `exact-order`、`same-tools`、`contains-in-order` 与 `contains-any-order`，直接描述 actual 与 expected 的关系，避免 subset／superset 观察方向歧义。匹配区分大小写，并保留重复调用的 multiplicity。所有调用状态都参与，因为该 Metric 测量 Agent 的调用决策，而不是工具是否成功。空 actual 轨迹合法；空 expected 只在 exact 模式合法，用来断言“不应调用工具”，contains 模式会拒绝恒真条件。非法 trace／Gold 产生 invalid evidence，无法解析的 pointer 保持 Core `not-evaluated` evidence；boolean observation 不会复制敏感轨迹。

`RubricJudgeEvaluator` 是一份显式评委 panel。`judges` 包含一个或多个 `RubricJudgeMember`；`replicateCount` 只重复该成员的测量，不会重新执行 Target。单个 panel 最多可展开为 1000 个 member × replicate 坐标。`RubricJudgeAggregation` 必须选择成员等权的 `mean`，或权重完整覆盖所有成员、均为正数且总和为 1 的 `weighted-mean`。目前唯一支持的缺失规则是 `require-complete`：任一计划成员或 replicate 不可用时，对应 Target × Sample × Trial 的 panel 读数不会进入分析，更不会用剩余评委补平均；原始成员与 replicate record 仍保留在 Evaluation Bundle 中。

`CustomEvaluator` 是 canonical API 中一次只产出一个 Metric 的 callback 扩展。它显式声明输入 `bindings`、可序列化 `parameters`、sample-scope `Metric`、schema parser 与测量相关 identity facets。Callback 只能收到 bindings 选中的值，无法读取完整 sample 或 execution record；返回值只能是一个 `score`、`missing`、`invalid` 或稳定 `failed`。并发、超时、预算、取消、evidence capture 与错误脱敏仍只由 Core 负责。该 callback 契约要求无状态、可安全并行且协作响应取消；需要有状态生命周期的宿主应使用 `/advanced`。单个 evaluator 不得产出多个 Metric，也不得自行声明 ensemble coordinate。

Numeric 与 boolean custom Metric 必须显式声明 `higher-is-better` 或 `lower-is-better` direction；categorical、text 与 ranking Metric 不得声明 scale 或 direction。Canonical `progress/v2` Decision 目前只接受 `higher-is-better`，因为把它的正向效应规则静默用于 lower-is-better 量表会反转 verdict。

`implementation.version`、schema `fingerprintFacets` 与 implementation `fingerprintFacets` 是必填 identity 声明。OMK 不会对 `Function#toString()` 做指纹；callback 代码、依赖、schema 或 provider 配置一旦改变测量行为，调用方必须更新至少一个 identity facet。Binding 与 value schema 只能校验，不能 coercion、补默认值或删除字段。`CustomEvaluatorContent` 为 evidence 或 invalid value 显式携带 classification；未声明的 source value 永远不会传入 callback。

`independent` 必须为每个 Variant 显式声明 allocation，以及全局和逐 stratum 的最小样本数。seed、可选 `stratumKey`、weight 与 minimum 会在任何 Executor 调用前封存；Core 把每个 sample 恰好分给一个 Variant，重复 trial 沿用同一分组，任何 minimum 无法满足时都在执行前失败。每项比较使用非配对 percentile Bootstrap estimator，绝不把独立组数据伪装成 paired data。

Analysis 必须显式声明并在执行前预注册。顶层 `analyses[]` 接受具名的 `summary`、`quality-interval`、`comparison-interval`、`comparison-family`、`composite-quality-interval` 与 `composite-comparison-interval`：summary 支持 numeric `mean`、boolean `rate` 和 numeric `quantile`；单项区间显式声明置信水平与重采样次数。Comparison family 至少声明两个全局具名 contrast 和一个整族置信水平。其 `bonferroni-percentile-bootstrap` 方法会在执行前把每项边际置信水平封存为 `1 - (1 - family level) / family size`，再产生一份由 Core 独立验证的 simultaneous-family table；该 family level 是标称目标，实际覆盖依赖边际 Bootstrap 区间达到其标称覆盖率。它不会伪造 p-value，也不会在看到结果后筛选 family member。每项请求可以应用一份封存的 Dataset cohort filter。Rubric panel 会先在成员内平均 replicate，再按声明聚合成员，最后在 sample 内归约重复 Target trial；paired 与 independent member 分别保持自身重采样单位。Metric direction 不会被用于静默翻转结果符号。Analysis `decision` 选择一个 interval；`comparison-family` decision 则选择外层 family，并为每个 member 提供一项原始 effect 单位的 `FamilyDecisionCriterion`。显式 `all` 规则只有在全部 simultaneous interval 满足 inclusive boundary 时才发布，已证明违反任一 criterion 时阻断，其余情况保持 not-decided。空 analysis 列表只保留类型化 evaluation evidence，不会虚构统计量或 composite verdict。

Composite request 使用 `compositeMetricId` 命名派生的 `[0, 1]` higher-is-better Metric，并显式声明至少两个 `CompositeMetricComponent` 与一份 `CompositeAggregation`。Component 的 source Metric ID 必须唯一，权重必须为正且严格求和为一；v1 唯一支持的聚合方式是 `{ method: 'weighted-mean', missing: 'require-complete' }`。它只接受 boolean Metric，以及声明了单调 direction 和完整边界的 numeric Metric；调用点不能覆盖 source Metric 已封存的 scale 或 direction。Runtime 会物化 derived Metric，并在 composite comparison 中把它加入选定的 Core Comparison；归一化、panel 聚合、实验单位内合成、缺失 component 排除、重采样、coverage 与 source-row lineage 仍只由 Core 负责。

```ts
const analysis: AnalysisRequest = {
  analysisId: 'overall-quality',
  analysisKind: 'composite-quality-interval',
  compositeMetricId: 'overall-quality',
  variantId: 'prompt-v2',
  components: [
    { metricId: 'correct', weight: 0.6 },
    { metricId: 'rubric-quality', weight: 0.4 },
  ],
  aggregation: { method: 'weighted-mean', missing: 'require-complete' },
  confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 1_000 },
};
```

该入口有意不暴露 Definition builder、Runtime registry、Core Target、生命周期 adapter 或 Rubric 手工 factory。`Artifact` 是被评测对象，`Variant` 将其绑定到 Executor、config 与 runtime context；control／treatment 角色只存在于显式 `Comparison` 中。

## `oh-my-knowledge/eval-runtime/advanced`

面向底层宿主装配与扩展的 SPI。普通应用应优先使用 `evaluate()`。

| Export | 用途 |
|---|---|
| `runEvaluation` | 运行已装配的 Core Definition、Runtime 与 Policy。 |
| `EvaluationEventConsumptionError` | `runEvaluation` 的事件消费错误。 |
| `createEvaluationRuntime` | 装配 Executor／Evaluator registration 与 Core built-in。 |
| `EvaluationRuntimeAssemblyError` | 稳定的 registration 或 resolution 错误。 |
| `createExactMatchDefinition` | 构造 exact-match 配对 Core Definition。 |
| `createPairedComparisonDefinition` | 构造单指标配对 Core Definition。 |
| `createMeasurementPolicy` | 物化 Core Policy 默认值，包括显式 EventWriter 投递模式。 |
| `createExactMatchEvaluator` | 创建内置 exact-match Evaluator port。 |
| `createInvokeExecutorIdentity` | 声明 `omk.invoke/v1` Executor identity。 |
| `createSessionExecutorIdentity` | 声明隔离的 `omk.session/v1` Executor identity。 |
| `createRuntimeIdentity` | 声明其它宿主 Runtime identity。 |
| `createJsonExecutorAdapter` | 将 typed JSON callback 适配到 Core Executor。 |
| `createJsonSessionExecutorAdapter` | 将 typed、per-trial JSON session lifecycle 适配到 Core Executor。 |
| `createRubricJudgeKit` | 派生匹配的 Rubric Definition、Metric、context 与 registration 片段。 |
| `createRubricJudgeEvaluationContext` | 组合多个 Rubric kit 的 criterion context。 |
| `createRubricJudgeRegistration` | 组合多个 Rubric kit binding。 |
| `runExecutorConformance` | 执行底层 Executor conformance probe。 |
| `assertExecutorConformance` | Conformance 失败时抛错。 |
| `RuntimeConformanceError` | 稳定的 conformance assertion error。 |
| `createNodeEvaluationClock` | 显式提供 Node.js Core clock。 |
| `EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID` | 内置 exact-match implementation ID。 |
| `createExactMatchEvaluatorIdentity` | 查看 exact-match Runtime identity。 |
| `INVOKE_JSON_INPUT_SCHEMA` | 默认 JSON input schema identity。 |
| `INVOKE_JSON_OUTPUT_SCHEMA` | 默认 JSON output schema identity。 |
| `INVOKE_JSON_TRACE_SCHEMA` | 默认 JSON trace schema identity。 |
| `SESSION_JSON_INPUT_SCHEMA` | 默认 session JSON input schema identity。 |
| `SESSION_JSON_OUTPUT_SCHEMA` | 默认 session JSON output schema identity。 |
| `SESSION_JSON_TRACE_SCHEMA` | 默认 session JSON trace schema identity。 |
| `createExecutorFnAdapter` | 兼容旧 `ExecutorFn`。 |
| `createSameProcessExecutorAdapter` | 实现进程内 Executor 生命周期 SPI。 |
| `createSameProcessEvaluatorAdapter` | 实现进程内 Evaluator 生命周期 SPI。 |
| `createRubricJudgeCriterion` | 构造底层 Rubric criterion。 |
| `createRubricJudgeInstrument` | 构造底层冻结 Rubric instrument。 |
| `createRubricJudgeRuntimeConfig` | 构造底层 Judge Runtime config。 |
| `createRubricJudgeEvaluatorDefinition` | 构造底层 Rubric Evaluator Definition。 |
| `createRubricJudgeMetricDefinition` | 构造底层 1～5 分 Metric。 |
| `createRubricJudgeEvaluatorIdentity` | 派生底层 Rubric Evaluator identity。 |
| `createRubricJudgeEvaluator` | 构造一个底层 Rubric Evaluator port。 |
| `createRubricJudgeEvaluatorRegistration` | 组合底层 Rubric binding。 |
| `rubricJudgeInstrumentId` | 派生内置 instrument ID。 |

Run 与装配 type 包括 `RunEvaluationInput`、`EvaluationEventObserver`、`CreateEvaluationRuntimeInput`、`EvaluationRuntimeSupportPorts` 与 `RuntimePortRegistration`。Builder type 包括 `ExactMatchDefinitionBuilderInput`、`ExactMatchTarget`、`PairedComparisonDefinitionBuilderInput`、`EvaluationRuntimeTarget`、`MeasurementPolicyBuilderInput`、`MeasurementStagePolicyInput`、`MeasurementRetryPolicyInput`、`MeasurementRetryBackoffInput`、`MeasurementFailurePolicyInput`、`MeasurementEventDeliveryInput` 与 `CreateExactMatchEvaluatorInput`。Identity 与 JSON adapter type 包括 `InvokeExecutorIdentityDeclaration`、`SessionExecutorIdentityDeclaration`、`RuntimeIdentityDeclaration`、`CreateJsonExecutorAdapterInput`、`CreateJsonSessionExecutorAdapterInput`、`JsonExecutorInvocation`、`JsonExecutorInvocationResult`、`JsonSessionExecutorContext`、`JsonSessionExecutorAttempt`、`JsonExecutorSession`、`RuntimeValueParser`、`WorkspaceDescriptor`、`WorkspaceInput`、`WorkspacePlan`、`WorkspaceProvider`、`WorkspaceOpenRequest`、`WorkspaceLease` 与 `WorkspaceAccess`。Judge type 包括 `OmkLlmJudgeEffort`、`OmkLlmJudgeInvocationPort`、`OmkLlmJudgeInvocationRequest`、`OmkLlmJudgeInvocationResult`、`CreateRubricJudgeKitInput`、`RubricJudgeKit`、`CreateRubricJudgeEvaluatorInput`、`RubricJudgeEvaluatorBinding` 与 `RubricJudgeEvaluatorDefinitionBuilderInput`。Conformance type 包括 `ExecutorConformanceProbeInput`、`ExecutorConformanceResult` 与 `RuntimeConformanceCheck`。旧 bridge 与生命周期 SPI type 包括 `CreateExecutorFnAdapterInput`、`ExecutorFn`、`ExecutorInput`、`ExecResult`、`ExecutorFnInputMapper`、`ExecutorFnResultMapper`、`CreateSameProcessExecutorAdapterInput`、`CreateSameProcessEvaluatorAdapterInput`、`SameProcessExecutorImplementation`、`SameProcessEvaluatorImplementation`、`SameProcessResourceLeaseAccess`、`SameProcessRunScope` 与 `SameProcessOperationScope`。

Advanced budget builder type 包括 `MeasurementBudgetPolicyInput`、`MeasurementBudgetScopeInput`、`MeasurementRunBudgetScopeInput`、`MeasurementAttemptBudgetScopeInput` 与 `MeasurementProviderCostLimitInput`。

## `oh-my-knowledge/eval-runtime/contracts`

面向 adapter 与 trace 作者的版本化 wire contract：

- Rubric identity 与 schema：`RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID`、`RUBRIC_JUDGE_BINDINGS`、`RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION`、`RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION`、`RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION`、`RUBRIC_JUDGE_INSTRUMENT_SCHEMA`、`RUBRIC_JUDGE_CONTEXT_SCHEMA` 与 `RUBRIC_JUDGE_EVIDENCE_SCHEMA`。
- Rubric type：`RubricJudgeInstrument`、`RubricJudgeRuntimeConfig`、`RubricJudgeConfig`、`RubricJudgeCriterion` 与 `RubricJudgeTracePolicy`。
- Trace value：`SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION`、`SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR`、`SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR`、`SourceNeutralTraceSchema`、`SourceNeutralTraceWithoutMocksSchema`、`SourceNeutralMockStatsSchema`、`parseSourceNeutralTrace` 与 `attachSourceNeutralMockStats`。
- Trace type：`SourceNeutralTrace` 与 `SourceNeutralMockStats`。

## 迁移

`1.0.0-beta` canonical 入口用面向用户的 façade 取代了原先的装配优先 surface。一般化 façade 还用 `{ variants, evaluators, comparisons, analyses }` 取代早期固定的 `{ executor, control, treatment, evaluator }` 输入；Executor 与 config 下沉到各 Variant 的 `execution`，Sampling Design 独占 paired／independent 语义，每项 summary 或 interval 都是具名的 `analyses[]` 请求。删除 `comparisonKind`，并将多余的 `analysis: { analyses: [...] }` 包装直接改为 `analyses: [...]`；旧结构不会被读取或检测。把 `runId`、`signal`、`onEvent`、`clock`、`annotations`、`summaries` 与 `eventBufferCapacity` 从声明移到可选的第二个 `EvaluationRunOptions` 参数；省略 `runId` 时自动生成。Decision 可省略；传入时通过 `analysisId` 精确选择一个 interval，或选择一份显式有界的 comparison family。Rubric 评测必须使用 `judges + aggregation`，不接受单数 `judge + model + effort` 结构。Policy 字段统一归入 `execution`、`evaluation`、`failure`、`budget` 与 `evidence`；早期扁平的 concurrency、timeout、invocation、failure 与 classification 字段不再接受。它不提供 0.x 兼容读取、旧 overload 或旧结构检测。已有底层 import 从 `oh-my-knowledge/eval-runtime` 移到 `oh-my-knowledge/eval-runtime/advanced`；wire schema 仍位于 `/contracts`。`createEvaluationEngine` 只有一种含义和一个入口：完整 staged engine 从 `oh-my-knowledge/eval-core` 导入；如果已经装配好 Runtime、Definition 与 Policy，只需一次标准完整运行，则使用 advanced 的 `runEvaluation`。新宿主从包根导入 `evaluate`、`prepareEvaluation` 或 `checkExecutor`；偏好领域限定 import 的消费者仍可使用完全等价的 `/eval-runtime` 入口。

预算 limit 现在位于显式 scope 下：将 `budget.maxInvocations` 改为 `budget.run.maxInvocations`。旧结构不会被读取或检测。

自定义 analysis graph、持久 artifact admission、分阶段重放或显式跨 run 可比性使用 `oh-my-knowledge/eval-core`。实现深路径不受支持。
