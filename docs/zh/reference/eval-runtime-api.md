# eval-runtime API 分层

`package.json#exports` 是唯一受支持的边界。Allowlist 测试锁定下列每一个 value 与 type export，因此新增、移动或删除 export 都必须显式审查。三个入口都只支持 ESM，在正式 `1.0.0` 前按 beta API 管理。

## `oh-my-knowledge/eval-runtime`

层级：日常宿主 API。目标用户：Node.js／FaaS 应用开发者。稳定性：受支持的 beta API；breaking change 必须提供迁移说明。

| Export | 用途 |
|---|---|
| `runEvaluation` | 执行普通 Core Definition／Policy，并安全 drain 进度事件。 |
| `EvaluationEventConsumptionError` | 观察器或事件消费失败，同时保留 Core 终态结果。 |
| `createEvaluationEngine` | 检查 sealed plan 或显式使用运行阶段。 |
| `createEvaluationRuntime` | 用显式 Executor／Evaluator registration 和 Core built-in 装配 Runtime。 |
| `EvaluationRuntimeAssemblyError` | 稳定的 Runtime registration 配置错误。 |
| `createExactMatchDefinition` | 构造 canonical exact-match 配对比较。 |
| `createPairedComparisonDefinition` | 构造单指标、自定义 Evaluator 的配对比较。 |
| `createMeasurementPolicy` | 显式物化 Core policy 默认值。 |
| `createExactMatchEvaluator` | 注册 built-in exact-match Evaluator。 |
| `createInvokeExecutorIdentity` | 声明并封存 `omk.invoke/v1` Executor identity。 |
| `createRuntimeIdentity` | 声明非 Executor 宿主 identity，例如 LLM gateway。 |
| `createJsonExecutorAdapter` | 把带运行时校验的类型化 JSON callback 绑定到 Core Executor port。 |
| `createRubricJudgeKit` | 一次派生匹配的 Rubric instrument、Definition 片段、Metric 与 registration。 |
| `createRubricJudgeEvaluationContext` | 为一个或多个 kit 构造与 sealed pointer 完全一致的 criterion context。 |
| `createRubricJudgeRegistration` | 把多个 Rubric kit 合并为一个 implementation registration。 |
| `runExecutorConformance` | 检查成功、失败、取消、telemetry、隔离与清理。 |
| `assertExecutorConformance` | 把失败的 conformance check 转成稳定异常。 |
| `RuntimeConformanceError` | 携带稳定错误码和失败 check ID 的 conformance 异常。 |

Type export：`RunEvaluationInput`、`EvaluationEventObserver` 描述高层运行；`CreateEvaluationRuntimeInput` 描述装配；`ExactMatchDefinitionBuilderInput`、`ExactMatchTarget`、`PairedComparisonDefinitionBuilderInput`、`EvaluationRuntimeTarget`、`MeasurementPolicyBuilderInput`、`CreateExactMatchEvaluatorInput` 描述 builder；`InvokeExecutorIdentityDeclaration`、`RuntimeIdentityDeclaration` 描述 identity；`CreateJsonExecutorAdapterInput`、`JsonExecutorInvocation`、`JsonExecutorInvocationResult`、`RuntimeValueParser` 描述 JSON 边界；`OmkLlmJudgeEffort`、`OmkLlmJudgeInvocationPort`、`OmkLlmJudgeInvocationRequest`、`OmkLlmJudgeInvocationResult` 描述宿主拥有的 Judge 调用；`CreateRubricJudgeKitInput`、`RubricJudgeKit` 描述 Judge 组合 API；`ExecutorConformanceProbeInput`、`ExecutorConformanceResult`、`RuntimeConformanceCheck` 描述 conformance 证据。每个 type 的目标用户、层级与稳定性跟消费或返回它的 value 一致。

## `oh-my-knowledge/eval-runtime/advanced`

层级：宿主扩展 SPI。目标用户：框架与 adapter 作者。稳定性：需审查的 beta SPI；普通应用通常不需要。

| Export | 用途 |
|---|---|
| `createNodeEvaluationClock` | 显式提供默认 Node.js Core clock。 |
| `EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID` | 引用 built-in exact-match implementation identity。 |
| `createExactMatchEvaluatorIdentity` | 不创建 port，直接检查 exact-match Runtime identity。 |
| `INVOKE_JSON_INPUT_SCHEMA` | `omk.invoke/v1` 默认 JSON input schema identity。 |
| `INVOKE_JSON_OUTPUT_SCHEMA` | `omk.invoke/v1` 默认 JSON output schema identity。 |
| `INVOKE_JSON_TRACE_SCHEMA` | `omk.invoke/v1` 默认 JSON trace schema identity。 |
| `createExecutorFnAdapter` | 桥接 OMK 旧 `ExecutorFn`；不是新宿主 canonical 入口。 |
| `createSameProcessExecutorAdapter` | 实现显式进程内 run／trial lifecycle SPI。 |
| `createSameProcessEvaluatorAdapter` | 实现显式进程内 run／record lifecycle SPI。 |
| `createRubricJudgeCriterion` | 脱离 kit 独立构造 criterion。 |
| `createRubricJudgeInstrument` | 独立构造冻结的 built-in Rubric instrument。 |
| `createRubricJudgeRuntimeConfig` | 构造原始 Rubric provider runtime config。 |
| `createRubricJudgeEvaluatorDefinition` | 构造原始 Rubric Evaluator Definition 片段。 |
| `createRubricJudgeMetricDefinition` | 构造原始 1～5 分 Rubric Metric。 |
| `createRubricJudgeEvaluatorIdentity` | 派生原始 Rubric Evaluator Runtime identity。 |
| `createRubricJudgeEvaluator` | 构造一个原始 Rubric Evaluator port。 |
| `createRubricJudgeEvaluatorRegistration` | 把原始 Rubric binding 合并为 registration。 |
| `rubricJudgeInstrumentId` | 派生 built-in contract 使用的 instrument ID。 |

Type export：`EvaluationRuntimeSupportPorts`、`RuntimePortRegistration` 描述宿主装配 SPI；`CreateExecutorFnAdapterInput`、`ExecutorFn`、`ExecutorInput`、`ExecResult`、`ExecutorFnInputMapper`、`ExecutorFnResultMapper` 描述旧 bridge；`CreateSameProcessExecutorAdapterInput`、`CreateSameProcessEvaluatorAdapterInput`、`SameProcessExecutorImplementation`、`SameProcessEvaluatorImplementation`、`SameProcessResourceLeaseAccess`、`SameProcessRunScope`、`SameProcessOperationScope` 描述生命周期 SPI；`CreateRubricJudgeEvaluatorInput`、`RubricJudgeEvaluatorBinding`、`RubricJudgeEvaluatorDefinitionBuilderInput` 描述 Rubric 手工装配。它们继承 advanced 层的目标用户与稳定性。

## `oh-my-knowledge/eval-runtime/contracts`

层级：Runtime protocol 与 schema contract。目标用户：adapter 作者、trace producer、持久化与校验集成。稳定性：版本化 contract；语义变化必须使用新的 schema identity。

| Export | 用途 |
|---|---|
| `RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID` | 版本化的 built-in Rubric implementation ID。 |
| `RUBRIC_JUDGE_BINDINGS` | canonical actual／criterion／trace binding ID。 |
| `RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION` | Rubric instrument wire version。 |
| `RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION` | Criterion context wire version。 |
| `RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION` | Judge evidence wire version。 |
| `RUBRIC_JUDGE_INSTRUMENT_SCHEMA` | Rubric instrument schema identity descriptor。 |
| `RUBRIC_JUDGE_CONTEXT_SCHEMA` | Criterion context schema identity descriptor。 |
| `RUBRIC_JUDGE_EVIDENCE_SCHEMA` | Judge evidence schema identity descriptor。 |
| `SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION` | 完整 source-neutral trace wire version。 |
| `SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR` | 完整 trace schema identity descriptor。 |
| `SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR` | 无 mocks trace schema identity descriptor。 |
| `SourceNeutralTraceSchema` | 运行时校验完整 source-neutral trace。 |
| `SourceNeutralTraceWithoutMocksSchema` | 校验无 mocks trace variant。 |
| `SourceNeutralMockStatsSchema` | 校验 source-neutral mock 统计。 |
| `parseSourceNeutralTrace` | 按 mock mode 解析 provider-neutral trace JSON。 |
| `attachSourceNeutralMockStats` | 在不改变 provider 事实的前提下附加已校验 mock 统计。 |

Type export：`RubricJudgeInstrument`、`RubricJudgeRuntimeConfig`、`RubricJudgeConfig`、`RubricJudgeCriterion`、`RubricJudgeTracePolicy` 描述 Rubric wire value；`SourceNeutralTrace`、`SourceNeutralMockStats` 描述 trace wire value。它们都是版本化 contract，目标用户与稳定性跟本入口一致。

## 何时离开便捷层

多指标图、`lower-is-better`／`target-is-best` 指标、自定义 Analysis Runtime、持久 artifact admission、分阶段 replay 或显式跨 run 可比性应使用 `oh-my-knowledge/eval-core`。`eval-runtime` 不定义第二套 Definition、Policy、Report、retry、timeout、budget、cache、统计或 Decision contract。
