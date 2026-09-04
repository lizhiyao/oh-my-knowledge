# eval-runtime API 分层

`package.json#exports` 是受支持边界，API allowlist 会锁定下列全部 value 与 type。所有入口仅支持 ESM。

## `oh-my-knowledge`

这是普通用户的推荐入口，与 `oh-my-knowledge/eval-runtime` 暴露完全相同的 canonical Runtime façade：`evaluate`、`checkExecutor`、稳定错误和公开模型 type。Core engine、builder、registration 与 adapter 不会进入包根。

## `oh-my-knowledge/eval-runtime`

面向应用开发者的 canonical API：

| Export | 用途 |
|---|---|
| `evaluate` | 使用宿主持有的 Executor，对一个 control 和一个 treatment 进行评测。 |
| `checkExecutor` | 通过成功、失败、取消、清理和测量检查认证 Executor。 |
| `EvaluationConfigurationError` | 稳定的调用方配置错误；只包含公开 code，不保留被拒绝 payload。 |
| `EvaluationEventConsumptionError` | 稳定且脱敏的观察器／event stream 错误；可用时保留终态 `EvaluationResult`。 |

公开模型 type 包括 `Artifact`、`ArtifactKind`、`ArtifactSource`、`Variant`、`RuntimeContext`、`Dataset`、`Sample`、`Executor`、`ExecutorCapabilities`、`ExecutorInvocation`、`ExecutorResult`、`Evaluator`、`ExactMatchEvaluator`、`RubricJudgeEvaluator`、`Judge`、`Rubric`、`Experiment`、`Policy`、`EvaluateInput`、`EvaluationResult`、`EventObserver` 与 `Clock`。Executor 认证使用 `ExecutorCheckInput`、`ExecutorCheckResult` 与 `RuntimeConformanceCheck`。

`RuntimeContext` 只包含可重放的宿主自定义 JSON `values`。canonical façade 不接受文件系统路径充当 workspace identity；在一般化 Runtime 提供内容寻址 workspace descriptor 与宿主持有的 lease 前，需要 workspace 的宿主应使用 advanced Core assembly 路径。`Sample.executionContext` 是单条用例中仅供 Executor 使用的输入，`Sample.evaluationContext` 是仅供 Evaluator 使用的输入；这两个用例投影都不描述宿主运行环境。

`EvaluationResult` 保留 Core `EvaluationRunResult` 的全部字段，并增加 `definition` 与 `policy`，用于访问 façade 实际编译出的 sealed Core Definition 和完整物化的 Measurement Policy。执行与评价 evidence 位于 `artifacts`，Decision 位于 `artifacts.decision`，公开 Report 位于 `report`。

对于一组 control／treatment 比较，façade 会封存区间感知的 Core `progress/v2` 策略。只有完整置信区间排除配置的 threshold 加 equivalence band，才会给出 `PROGRESS` 或 `REGRESSION`；区间重叠时返回 `NOISE`。这个三分类方向策略有意小于 CLI workflow 的六分类发布策略，后者还会区分 `UNDERPOWERED`／`CAUTIOUS` 并执行发布门禁。两条路径因此共享同一个区间要求，但不伪装成完全相同的策略契约。

该入口有意不暴露 Definition builder、Runtime registry、Core Target、生命周期 adapter 或 Rubric 手工 factory。`Artifact` 是被评测对象，`Variant` 将其绑定到 runtime context，`control`／`treatment` 是实验角色。

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

`1.0.0-beta` canonical 入口用面向用户的 façade 取代了原先的装配优先 surface。已有底层 import 从 `oh-my-knowledge/eval-runtime` 移到 `oh-my-knowledge/eval-runtime/advanced`；wire schema 仍位于 `/contracts`。`createEvaluationEngine` 只有一种含义和一个入口：完整 staged engine 从 `oh-my-knowledge/eval-core` 导入；如果已经装配好 Runtime、Definition 与 Policy，只需一次标准完整运行，则使用 advanced 的 `runEvaluation`。新宿主从包根导入 `evaluate` 或 `checkExecutor`；偏好领域限定 import 的消费者仍可使用完全等价的 `/eval-runtime` 入口。

自定义 analysis graph、持久 artifact admission、分阶段重放或显式跨 run 可比性使用 `oh-my-knowledge/eval-core`。实现深路径不受支持。
