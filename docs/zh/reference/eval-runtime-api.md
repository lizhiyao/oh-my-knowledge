# eval-runtime API 分层

`package.json#exports` 是受支持边界，API allowlist 会锁定下列全部 value 与 type。所有入口仅支持 ESM。

## `oh-my-knowledge`

这是普通用户的推荐入口，与 `oh-my-knowledge/eval-runtime` 暴露完全相同的 canonical Runtime façade：`evaluate`、`checkExecutor`、稳定错误和公开模型 type。Core engine、builder、registration 与 adapter 不会进入包根。

## `oh-my-knowledge/eval-runtime`

面向应用开发者的 canonical API：

| Export | 用途 |
|---|---|
| `evaluate` | 运行一份显式的 solo、paired 或 independent-group 评测设计，包括多臂与多指标比较。 |
| `checkExecutor` | 通过成功、失败、取消、清理和测量检查认证 Executor。 |
| `EvaluationConfigurationError` | 稳定的调用方配置错误；只包含公开 code，不保留被拒绝 payload。 |
| `EvaluationEventConsumptionError` | 稳定且脱敏的观察器／event stream 错误；可用时保留终态 `EvaluationResult`。 |

公开模型 type 包括 `Artifact`、`ArtifactKind`、`ArtifactSource`、`Variant`、`VariantExecution`、`RuntimeContext`、`Dataset`、`Sample`、`Executor`、`ExecutorCapabilities`、`ExecutorInvocation`、`ExecutorResult`、`Evaluator`、`ExactMatchEvaluator`、`RubricJudgeEvaluator`、`RubricJudgeMember`、`RubricJudgeAggregation`、`CustomEvaluator`、`CustomEvaluatorInvocation`、`CustomEvaluatorResult`、`CustomEvaluatorBinding`、`CustomEvaluatorContent`、`Metric`、`Judge`、`Rubric`、`Experiment`、`SamplingDesign`、`Analysis`、`AnalysisRequest`、`CohortFilter`、`Comparison`、`Decision`、`Policy`、`EvaluateInput`、`EvaluationResult`、`EventObserver` 与 `Clock`。Executor 认证使用 `ExecutorCheckInput`、`ExecutorCheckResult` 与 `RuntimeConformanceCheck`。

`RuntimeContext` 只包含可重放的宿主自定义 JSON `values`。canonical façade 不接受文件系统路径充当 workspace identity；在一般化 Runtime 提供内容寻址 workspace descriptor 与宿主持有的 lease 前，需要 workspace 的宿主应使用 advanced Core assembly 路径。`Sample.executionContext` 是单条用例中仅供 Executor 使用的输入，`Sample.evaluationContext` 是仅供 Evaluator 使用的输入；这两个用例投影都不描述宿主运行环境。

`EvaluationResult` 保留 Core `EvaluationRunResult` 的全部字段，并增加 `definition`、`policy` 与 `analysisResults`。最后一项只是按 `analysisId` 索引同一批 Core Analysis record 的只读视图，不是第二套分析实现。执行与评价 evidence 位于 `artifacts`，Decision 位于 `artifacts.decision`，公开 Report 位于 `report`。

`SamplingDesign` 支持单 Variant 的 `solo` 质量画像、complete-block `paired` 比较和 fixed-quota `independent` 比较。solo 设计可以声明 `clusterKey`，此时 Core 将完整 cluster 作为实验单位与重采样单位。一项 `Comparison` 声明一个 control、一个或多个 treatment 与参与分析的 Metric。`evaluators` 可包含多个 exact-match、Rubric 评委或 custom evaluator，但 evaluator ID 与 metric ID 必须分别唯一。

`RubricJudgeEvaluator` 是一份显式评委 panel。`judges` 包含一个或多个 `RubricJudgeMember`；`replicateCount` 只重复该成员的测量，不会重新执行 Target。单个 panel 最多可展开为 1000 个 member × replicate 坐标。`RubricJudgeAggregation` 必须选择成员等权的 `mean`，或权重完整覆盖所有成员、均为正数且总和为 1 的 `weighted-mean`。目前唯一支持的缺失规则是 `require-complete`：任一计划成员或 replicate 不可用时，对应 Target × Sample × Trial 的 panel 读数不会进入分析，更不会用剩余评委补平均；原始成员与 replicate record 仍保留在 Evaluation Bundle 中。

`CustomEvaluator` 是 canonical API 中一次只产出一个 Metric 的 callback 扩展。它显式声明输入 `bindings`、可序列化 `parameters`、sample-scope `Metric`、schema parser 与测量相关 identity facets。Callback 只能收到 bindings 选中的值，无法读取完整 sample 或 execution record；返回值只能是一个 `score`、`missing`、`invalid` 或稳定 `failed`。并发、超时、预算、取消、evidence capture 与错误脱敏仍只由 Core 负责。该 callback 契约要求无状态、可安全并行且协作响应取消；需要有状态生命周期的宿主应使用 `/advanced`。单个 evaluator 不得产出多个 Metric，也不得自行声明 ensemble coordinate。

Numeric 与 boolean custom Metric 必须显式声明 `higher-is-better` 或 `lower-is-better` direction；categorical、text 与 ranking Metric 不得声明 scale 或 direction。Canonical `progress/v2` Decision 目前只接受 `higher-is-better`，因为把它的正向效应规则静默用于 lower-is-better 量表会反转 verdict。

`implementation.version`、schema `fingerprintFacets` 与 implementation `fingerprintFacets` 是必填 identity 声明。OMK 不会对 `Function#toString()` 做指纹；callback 代码、依赖、schema 或 provider 配置一旦改变测量行为，调用方必须更新至少一个 identity facet。Binding 与 value schema 只能校验，不能 coercion、补默认值或删除字段。`CustomEvaluatorContent` 为 evidence 或 invalid value 显式携带 classification；未声明的 source value 永远不会传入 callback。

`independent` 必须为每个 Variant 显式声明 allocation，以及全局和逐 stratum 的最小样本数。seed、可选 `stratumKey`、weight 与 minimum 会在任何 Executor 调用前封存；Core 把每个 sample 恰好分给一个 Variant，重复 trial 沿用同一分组，任何 minimum 无法满足时都在执行前失败。每项比较使用非配对 percentile Bootstrap estimator，绝不把独立组数据伪装成 paired data。

Analysis 必须显式声明并在执行前预注册。`analysis.analyses[]` 接受具名的 `summary`、`quality-interval` 与 `comparison-interval`：summary 支持 numeric `mean`、boolean `rate` 和 numeric `quantile`，区间显式声明置信水平与重采样次数。每项请求只选择一个 Variant 或一个已声明的 comparison contrast，并可应用封存的 Dataset cohort filter。Rubric panel 会先在成员内平均 replicate，再按声明聚合成员，最后在 sample 内归约重复 Target trial；cluster Bootstrap 则重采样完整 cluster。Metric direction 不会被用于静默翻转结果符号。`decision` 通过 `analysisId` 精确选择一个区间；summary 或 lower-is-better Metric 不能静默驱动 `progress/v2`。空 analysis 列表只保留类型化 evaluation evidence，不会虚构统计量或 composite verdict。

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
| `createRuntimeIdentity` | 声明其它宿主 Runtime identity。 |
| `createJsonExecutorAdapter` | 将 typed JSON callback 适配到 Core Executor。 |
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

Run 与装配 type 包括 `RunEvaluationInput`、`EvaluationEventObserver`、`CreateEvaluationRuntimeInput`、`EvaluationRuntimeSupportPorts` 与 `RuntimePortRegistration`。Builder type 包括 `ExactMatchDefinitionBuilderInput`、`ExactMatchTarget`、`PairedComparisonDefinitionBuilderInput`、`EvaluationRuntimeTarget`、`MeasurementPolicyBuilderInput`、`MeasurementEventDeliveryInput` 与 `CreateExactMatchEvaluatorInput`。Identity 与 JSON adapter type 包括 `InvokeExecutorIdentityDeclaration`、`RuntimeIdentityDeclaration`、`CreateJsonExecutorAdapterInput`、`JsonExecutorInvocation`、`JsonExecutorInvocationResult` 与 `RuntimeValueParser`。Judge type 包括 `OmkLlmJudgeEffort`、`OmkLlmJudgeInvocationPort`、`OmkLlmJudgeInvocationRequest`、`OmkLlmJudgeInvocationResult`、`CreateRubricJudgeKitInput`、`RubricJudgeKit`、`CreateRubricJudgeEvaluatorInput`、`RubricJudgeEvaluatorBinding` 与 `RubricJudgeEvaluatorDefinitionBuilderInput`。Conformance type 包括 `ExecutorConformanceProbeInput`、`ExecutorConformanceResult` 与 `RuntimeConformanceCheck`。旧 bridge 与生命周期 SPI type 包括 `CreateExecutorFnAdapterInput`、`ExecutorFn`、`ExecutorInput`、`ExecResult`、`ExecutorFnInputMapper`、`ExecutorFnResultMapper`、`CreateSameProcessExecutorAdapterInput`、`CreateSameProcessEvaluatorAdapterInput`、`SameProcessExecutorImplementation`、`SameProcessEvaluatorImplementation`、`SameProcessResourceLeaseAccess`、`SameProcessRunScope` 与 `SameProcessOperationScope`。

## `oh-my-knowledge/eval-runtime/contracts`

面向 adapter 与 trace 作者的版本化 wire contract：

- Rubric identity 与 schema：`RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID`、`RUBRIC_JUDGE_BINDINGS`、`RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION`、`RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION`、`RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION`、`RUBRIC_JUDGE_INSTRUMENT_SCHEMA`、`RUBRIC_JUDGE_CONTEXT_SCHEMA` 与 `RUBRIC_JUDGE_EVIDENCE_SCHEMA`。
- Rubric type：`RubricJudgeInstrument`、`RubricJudgeRuntimeConfig`、`RubricJudgeConfig`、`RubricJudgeCriterion` 与 `RubricJudgeTracePolicy`。
- Trace value：`SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION`、`SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR`、`SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR`、`SourceNeutralTraceSchema`、`SourceNeutralTraceWithoutMocksSchema`、`SourceNeutralMockStatsSchema`、`parseSourceNeutralTrace` 与 `attachSourceNeutralMockStats`。
- Trace type：`SourceNeutralTrace` 与 `SourceNeutralMockStats`。

## 迁移

`1.0.0-beta` canonical 入口用面向用户的 façade 取代了原先的装配优先 surface。一般化 façade 还用 `{ variants, evaluators, comparisons }` 取代早期固定的 `{ executor, control, treatment, evaluator }` 输入；Executor 与 config 下沉到各 Variant 的 `execution`，sampling 改为显式声明，每项 summary 或 interval 都是具名的 `analysis.analyses` 请求。Decision 可省略；传入时通过 `analysisId` 精确选择一个 interval。Rubric 评测必须使用 `judges + aggregation`，不接受单数 `judge + model + effort` 结构。它不提供 0.x 兼容读取或旧结构检测。已有底层 import 从 `oh-my-knowledge/eval-runtime` 移到 `oh-my-knowledge/eval-runtime/advanced`；wire schema 仍位于 `/contracts`。`createEvaluationEngine` 只有一种含义和一个入口：完整 staged engine 从 `oh-my-knowledge/eval-core` 导入；如果已经装配好 Runtime、Definition 与 Policy，只需一次标准完整运行，则使用 advanced 的 `runEvaluation`。新宿主从包根导入 `evaluate` 或 `checkExecutor`；偏好领域限定 import 的消费者仍可使用完全等价的 `/eval-runtime` 入口。

自定义 analysis graph、持久 artifact admission、分阶段重放或显式跨 run 可比性使用 `oh-my-knowledge/eval-core`。实现深路径不受支持。
