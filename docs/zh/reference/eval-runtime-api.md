# eval-runtime API 分层

`package.json#exports` 是受支持边界，API allowlist 会锁定下列全部 value 与 type。所有入口仅支持 ESM。

## `oh-my-knowledge`

这是普通用户的推荐入口，与 `oh-my-knowledge/eval-runtime` 暴露完全相同的 canonical Runtime façade：`evaluate`、`prepareEvaluation`、`evaluateSeries`、`prepareEvaluationSeries`、`rescore`、`reanalyze`、`redecide`、`assessComparability`、`saveEvaluationResult`、`loadEvaluationResult`、`checkRuntime`、`checkExecutor`、`checkContentStore`、稳定错误和公开模型 type。Core engine、builder、registration 与 adapter 不会进入包根。

## `oh-my-knowledge/eval-runtime`

面向应用开发者的 canonical API：

| Export | 用途 |
|---|---|
| `evaluate` | 运行一份显式的 solo、paired 或 independent-group 评测设计，包括多臂与多指标比较。 |
| `prepareEvaluation` | 在任何 Target 或 Evaluator 调用前，封存并检查最终 Definition、Policy、Plan、Runtime resolution、digest 和工作量估计。 |
| `evaluateSeries` | 在一份固定测量设计下运行预注册数量的独立 member 评测，并跨 Run 汇总一个数值 Analysis result。 |
| `prepareEvaluationSeries` | 在首次 Target 调用前封存全部 Series member、membership、Series plan 与总工作量估算。 |
| `rescore` | 复用已认证的 Execution stage，再按新封存声明执行 Evaluation、Analysis、Decision 与 Report。 |
| `reanalyze` | 复用已认证的 Execution 与 Evaluation stage，再按新封存声明执行 Analysis、Decision 与 Report。 |
| `redecide` | 复用已认证的 Execution、Evaluation 与 Analysis stage，再执行新声明的 Decision 与 Report。 |
| `assessComparability` | 在不重新执行 Target 的前提下，按 evaluation、analysis 或 decision scope 评估两份已认证 canonical Run result 的可比性。 |
| `saveEvaluationResult` | 通过宿主注入的 `ContentStore` 持久化一份已认证 canonical result；版本化 envelope 始终按 Gold 分类。 |
| `loadEvaluationResult` | 按准确的 `PreparedEvaluation` 解析并重新接纳已存结果；恢复 provenance authority 前必须通过独立宿主 verifier。 |
| `EVALUATION_RESULT_MEDIA_TYPE` | 已存 result envelope 的版本化 media type。 |
| `EvaluationResultStoreError` | 稳定且脱敏的存储、解析、认证、plan 或 content 错误。 |
| `checkRuntime` | 通过版本化行为探针检查单个注入的 Runtime 组件。当前支持 Executor、Custom Evaluator、Judge、execution／evaluation cache、ContentStore／ContentResolver 与 WorkspaceProvider。 |
| `checkContentStore` | 验证宿主 ContentStore／ContentResolver 的 descriptor 完整性与稳定性、幂等写入，以及回读 value、classification 和 media type；宿主异常只会归约为稳定 reason code。 |
| `checkExecutor` | 通过成功、失败、取消、清理和测量探针检查 Executor 行为。 |
| `RUNTIME_CHECK_RESULT_SCHEMA_VERSION` | 全部可序列化 `checkRuntime` result envelope 共享的版本标记。 |
| `EvaluationConfigurationError` | 稳定的调用方配置错误；只包含公开 code，不保留被拒绝 payload。 |
| `EvaluationEventConsumptionError` | 稳定且脱敏的观察器／event stream 错误；可用时保留终态 `EvaluationResult`。 |

内容存储一致性检查使用 `ContentStoreCheckInput`、`ContentStoreCheckResult` 与 `ContentStoreConformanceCheck`。

统一检查使用判别联合 `RuntimeCheckInput`、`RuntimeCheckKind` 与 `RuntimeCheckResult`。组件输入和结果包括 `ExecutorRuntimeCheckInput`、`ExecutorRuntimeCheckResult`、`EvaluatorRuntimeCheckInput`、`EvaluatorRuntimeCheckResult`、`JudgeRuntimeCheckInput`、`JudgeRuntimeCheckResult`、`CacheRuntimeCheckInput`、`CacheRuntimeCheckResult`、`ContentStoreRuntimeCheckInput`、`ContentStoreRuntimeCheckResult`、`WorkspaceProviderRuntimeCheckInput` 与 `WorkspaceProviderRuntimeCheckResult`。探针细节使用 `EvaluatorConformanceProbeSources`、`EvaluatorConformanceProbeInput`、`EvaluatorConformanceCheck`、`EvaluatorConformanceResult`、`JudgeConformanceProbeCase`、`JudgeConformanceProbeInput`、`JudgeConformanceCheck`、`JudgeConformanceResult`、`CacheConformanceProbeInput`、`CacheConformanceCheck`、`CacheConformanceResult`、`WorkspaceProviderConformanceProbeInput`、`WorkspaceProviderConformanceCheck` 与 `WorkspaceProviderConformanceResult`。

每次 `checkRuntime()` 只检查一个组件，不对整套宿主组合背书。结果中的 `schemaVersion`、限定名称 `runtimeKind`、版本化 `checkStandardId` 与 `evidenceLevel: 'behavioral-probe'` 会准确说明已观察的边界。通过检查不等于完成 Runtime identity 认证，也不证明 provider 质量、安全隔离、持久性或端到端用例隔离(construct validity)。逐项检查后，仍应使用 `evaluate()` 运行预期的真实组合。

Cache 探针会执行写入，并有意保留无害 entry，因此必须使用调用方持有、从未使用过的 `probeNamespace` 和可丢弃 namespace。Timeout 只能限制调用方等待时间，无法取消任意 cache promise。ContentStore 探针同样会写入一份幂等 public value。WorkspaceProvider 探针会打开 trial lease，观察请求转发、retry 复用、活跃 root 区分、Target access，以及成功、失败和取消后的 `close()` 调用；它不证明 descriptor byte、物理删除或 sandbox containment。Judge 探针最多执行四次真实调用并可能产生费用，因此必须显式设置 `allowExternalCalls: true`。每个 `publicProbeText` 都会作为生成的 rubric prompt 一部分发送给该 provider，只能包含无害的 public data。结果会报告实际 invocation 数、声明的费用报告模式与已测 provider cost，但不会保留 prompt、output、provider exception、cache entry、content payload、workspace root、locator 或 credential。

Evaluation cache、Custom Evaluator 与 Judge 探针包含经 canonical Core 调度的并发 coordinate；对应 port 必须在调用重叠时保持正确。当前 Core 的 execution cache 读取路径按真实调用方式检查，不额外声称并发保证。Workspace 的 `timeoutMs` 会限制检查等待 `close()` 的时间，但无法停止已经运行的 provider promise，因此 provider 仍须实现有界的本地清理。取消检查要求 Custom Evaluator 或 Judge 调用自身在 abort 后拒绝；即使 Core 最终把 Run 标记为 cancelled，稍后成功返回的调用也不会通过检查。

Mock interception type 包括 `MockInterceptionDescriptor`、`MockInterceptionInput`、`MockInterceptionPlan`、`MockInterceptionProvider`、`MockInterceptionOpenRequest`、`MockInterceptionLease`、`MockInterceptionAccess`、`MockInterceptionRequest` 与 `MockInterceptionDecision`。

公开模型 type 包括 `Artifact`、`ArtifactKind`、`ArtifactSource`、`Variant`、`VariantExecution`、`RuntimeContext`、`AllowedToolsInput`、`AllowedToolsPlan`、`McpConfigDescriptor`、`McpConfigInput`、`McpConfigPlan`、`McpConfigProvider`、`McpConfigOpenRequest`、`McpConfigLease`、`McpConfigAccess`、`WorkspaceDescriptor`、`WorkspaceInput`、`WorkspacePlan`、`WorkspaceProvider`、`WorkspaceOpenRequest`、`WorkspaceLease`、`WorkspaceAccess`、`ContentDescriptor`、`ContentValue`、`ContentStoreRequest`、`ContentStore`、`ContentResolver`、`ExecutionCache`、`ExecutionCacheEntry`、`EvaluationCache`、`EvaluationCacheEntry`、`ExecutorIdentityVerifier`、`ExecutorIdentityVerificationRequest`、`ExecutorIdentityVerification`、`EvaluationInfrastructure`、`Dataset`、`Sample`、`EvaluationExecutor`、`Executor`、`InvokeExecutor`、`SessionExecutor`、`ExecutorSessionContext`、`ExecutorSessionAttempt`、`ExecutorSession`、`ExecutorCapabilities`、`ExecutorInvocation`、`ExecutorResult`、`Evaluator`、`ExactMatchEvaluator`、`RetrievalEvaluator`、`RetrievalMetricIds`、`AbstentionEvaluator`、`AbstentionMetricIds`、`ToolTrajectoryEvaluator`、`ToolTrajectoryMatchMode`、`RubricJudgeEvaluator`、`RubricJudgeMember`、`RubricJudgeAggregation`、`CustomEvaluator`、`CustomEvaluatorInvocation`、`CustomEvaluatorResult`、`CustomEvaluatorBinding`、`CustomEvaluatorContent`、`Metric`、`Judge`、`Rubric`、`Experiment`、`SamplingDesign`、`AnalysisRequest`、`CohortFilter`、`Comparison`、`ComparisonFamilyMember`、`CompositeMetricComponent`、`CompositeAggregation`、`Decision`、`FamilyDecisionCriterion`、`Policy`、`StagePolicy`、`RetryPolicy`、`RetryBackoff`、`FailurePolicy`、`CachePolicy`、`EvidencePolicy`、`BudgetPolicy`、`BudgetScope`、`RunBudgetScope`、`AttemptBudgetScope`、`ProviderCostLimit`、`EvaluateInput`、`EvaluationRunOptions`、`EvaluationResult`、`PreparedEvaluation`、`PreparedEvaluationPlan`、`RuntimeCapabilityResolution`、`EvaluationWorkEstimate`、`EventObserver`、`Clock`、`AssessComparabilityInput`、`EvaluationComparabilitySubject` 与 `EvaluationComparabilityAssessment`。Series 使用 `EvaluationSeriesInput`、`EvaluationSeriesStability`、`EvaluationSeriesRunOptions`、`PreparedEvaluationSeries`、`EvaluationSeriesWorkEstimate`、`EvaluationSeriesMemberResult`、`EvaluationSeriesResult`、`EvaluationSeriesStabilityResult` 与 `RunStabilityValue`。Executor 行为检查使用 `ExecutorCheckInput`、`ExecutorCheckResult` 与 `RuntimeConformanceCheck`。

`Policy` 使用相互独立的 execution／evaluation `StagePolicy`。每个 stage 分别封存 concurrency、timeout 与可选 `RetryPolicy`；retry error code 是宿主定义的稳定 identifier，`RetryBackoff` 是显式的 `none`／`fixed`／`exponential` 判别联合。`FailurePolicy` 同样使用判别联合，只有 `failure-threshold` 可以携带 `maxFailures`。`BudgetPolicy` 暴露 run、stage、coordinate 与 attempt scope，以及可审计的 invocation、active-duration、wall-clock 和 provider-cost limit。Provider-cost admission 固定为 bounded overshoot；`onUnreportedProviderCost` 选择失败关闭或不可验证处理。`CachePolicy` 分别控制 execution 的 `disabled`／`reuse`／`replay-only` 与 evaluation 的 `disabled`／`reuse`。`EvidencePolicy` 通过 `output`、`trace` 与 `evaluatorEvidence` 分别选择 `full`、`reference`、`digest` 或 `none`，并声明统一 classification ceiling。Façade 只负责把声明物化为 Core Measurement Policy；scheduler、timeout、retry、取消、预算计量、缓存验证、证据捕获和 failure-threshold 行为仍全部由 Core 实现。

`EvaluateInput.infrastructure` 接收宿主显式提供的 `ContentStore` 与 `ContentResolver` port。Reference capture 使用同一 store 写入 execution output、trace 和 Evaluator evidence；下游 Evaluator 消费 reference output 或 trace 时，再由 resolver 取回。Core 会在存储前派生 canonical digest、验证 store 返回的 descriptor，并在评测前重新核对解析值的 digest、classification 和 media type。Façade 在 prepare 时捕获方法 binding，并在第一次 Target 调用前拒绝缺失的必要 port、移除 Evaluator 已声明输入的 capture mode，或不足以保留输入的 classification ceiling。Store 实现与 credential 不进入 sealed Definition；返回的 descriptor 会进入 run artifact，因此可选 `uri` 必须是稳定、opaque 且不含 credential 的 locator，不能是物理路径或 signed URL。没有 Evaluator 消费的 output 或 trace 仍可选择 `digest` 或 `none`。

同一 `EvaluationInfrastructure` 还可以提供相互独立的 `ExecutionCache` 与 `EvaluationCache`。Execution `reuse` 只接受 deterministic Executor，并要求独立的 `ExecutorIdentityVerifier` 把捕获的实际 callable 与完整行为依赖绑定到稳定 attestation；仅运行 `checkExecutor()` 或相信 Executor 自报的 fingerprint 不构成该认证。`replay-only` 在 miss 时失败，绝不调用 Target；Evaluation `reuse` 可以独立启用。Façade 在 prepare 阶段校验所需 port 与认证器，Core 独占 cache key、entry 验证、命中 provenance 和写入时机。

`RuntimeContext` 只包含可重放的宿主自定义 JSON `values`。Variant 使用内容寻址的 `WorkspaceDescriptor` 选择逻辑 workspace，也可以使用包含一个 `default` 和 `bySampleId` override 的 `WorkspacePlan`；`null` 表示为该 sample 显式禁用默认 workspace。Executor 持有对应的 `WorkspaceProvider`：稳定的 `providerId`、`version` 和可选的测量相关 `fingerprintFacets` 进入 Runtime identity，credential、CAS locator、cache 与 base directory 则只保留在 provider closure 内；canonical 与 advanced JSON adapter 都会把 provider identity 强制组合到最终 Executor fingerprint。`prepareEvaluation()` 只封存 descriptor，不打开 lease。执行时 provider 必须验证请求的不可变 descriptor，并返回一份带绝对路径、trial 私有 `root` 的新 `WorkspaceLease`。同一 trial 的 retry 复用同一个 `WorkspaceAccess`，随后无论成功、失败、timeout 还是取消，Runtime 都会调用 `close()`。OMK 自身绝不会把物理 root 或 provider 私有状态加入 Definition、result 或 error；Executor 同样不应通过自己的 output 或 trace 返回 locator。Invoke 与 session Executor 只能看到 `{ descriptor, root }`，无法关闭其它组件持有的 lease。跨 trial 复用 lease object、复用仍活跃的物理 root，都会失败关闭；清理失败的 root 在当前进程中保持隔离。`open()` 与 `close()` 必须是有界的本地资源工作。Lease 提供的是测量隔离，不是安全 sandbox；不可信代码的 containment 仍由宿主负责。

Variant 还可以把 `execution.allowedTools` 设为一份准确列表，或设为带 `default` 与 `bySampleId` 的 `AllowedToolsPlan`。OMK 会为身份计算排序，但绝不会把不同 sample 的列表取并集。`[]` 表示禁用全部工具；sample override 的 `null` 表示显式恢复 Executor runtime 默认值。Executor 必须声明 `capabilities.toolPolicy: 'allow-list'`，并严格执行 `execute()` 或 `openSession()` 收到的 `allowedTools`；`undefined` 表示使用 runtime 默认值。缺少 capability 时，OMK 会在执行前失败关闭；但 capability 属于自我声明，后端无法准确执行列表时绝不能声明。工具名和 workspace control 都不会进入 Gold 或 evaluation-only context。Skill discovery、安装与名称解析仍由宿主／Workflow 负责；Runtime 只封存最终 execution contract，不增加 `allowedSkills` policy。`checkExecutor()` 当前会拒绝启用 workspace 或 tool policy 的声明，因为通用 probe 无法证明其隔离或执行效果；专用 conformance probe 完成前，应运行真实 Evaluation 验证。

原生 MCP 配置由 Variant 直接选择 secret `application/json` `McpConfigDescriptor`，或通过 `McpConfigPlan` 逐 sample 选择；`null` 表示为该 sample 禁用默认配置。Executor 必须成对声明 `capabilities.mcp: 'native-config'` 与 `McpConfigProvider`。Provider identity 与被选中的 descriptor 进入 Runtime 和 execution-coordinate identity，credential、locator 与配置 byte 则留在 provider 内。Provider 返回的 canonical JSON 必须匹配声明的 digest 与 byte size。Runtime 为每个 Trial 打开一份新 lease，只在该 Trial 的 retry 间复用，只向 Executor 暴露 `{ descriptor, config }`，并在所有终态路径关闭。OMK 不会把配置内容序列化进自己的 result 或 error；Executor 仍须避免通过 output 或 trace 回显 secret。在专用 isolation probe 完成前，`checkExecutor()` 会拒绝启用 MCP 的声明，应使用真实 Evaluation 验证。Discovery、默认值与产品特定的 Workflow 装配不属于该 Runtime port。

工具调用前 mock 由 Variant 直接选择 secret `MockInterceptionDescriptor`，或通过 `MockInterceptionPlan` 逐 sample 选择；`null` 表示为该 sample 禁用默认 interception。Descriptor 必须使用 `MOCK_INTERCEPTION_PLAN_MEDIA_TYPE`（`application/vnd.omk.mock-interception-plan+json`），并标识一份完整绑定 strictness、first-match 规则顺序与有序 payload descriptor 的聚合 plan。Executor 必须成对声明 `capabilities.mockInterception: 'pre-tool-call'` 与 `MockInterceptionProvider`。Provider identity 与被选中的 descriptor 进入 Runtime 和 coordinate identity，plan bytes、rule bytes、payload 与 locator 则留在 provider 内。Provider 校验 descriptor 后返回一份新的 attempt-scoped lease。Invoke Executor 在 invocation 上收到 `MockInterceptionAccess`；Session Executor 在每个 `ExecutorSessionAttempt` 上收到，`openSession()` 永远不可见。Runtime 校验 request 与 `mocked`／`pass-through`／`denied` decision，只在 Target 调用 settle 后关闭 lease，拒绝复用 lease，把 output 与 trace classification 提升到 `secret`，并对 provider failure 脱敏。每次 retry 都获得全新状态；strict miss 必须在真实工具调用前拒绝。在真实 tool-call probe 完成前，`checkExecutor()` 会拒绝启用 mock 的声明。

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

`saveEvaluationResult()` 只接受带完整 Execution／Evaluation／Analysis source chain 的原始已认证 result，通过调用方的 `ContentStore` 写入版本化 canonical JSON envelope，并返回内容寻址的 `ContentDescriptor`。Result 包含 sealed Definition 与 Dataset Gold，因此 Runtime 始终以 `classification: 'gold'` 写入，宿主必须实施匹配的访问控制。`loadEvaluationResult()` 要求调用方重新 prepare 完全相同的声明，保持调用方指定的 descriptor 不可变，通过注入的 `ContentResolver` 验证外层值，以及每份以 reference 捕获的 output、trace 与 Evaluator evidence，随后要求 `EvaluationResultVerifier` 认证准确 envelope，最后才让 Core 重新接纳每个 bundle 与 report。Verifier 是宿主信任边界，其 `EvaluationResultVerification` 必须显式列出经过独立认证的 provenance Bundle digest、cache receipt digest 与 Decision policy-execution digest。Runtime 只向 Core 传递这些事实，绝不从已存 Bundle 自身的 claim 推导 verified receipt；只重新计算公开 envelope checksum 不足以构成认证。Store、resolver 与 verifier 可以在宿主内部使用文件或数据库，但 Runtime 不会发现它们，并会同时脱敏 rejected promise 与 malformed return value。不一致 plan、不完整 result、保存 clone、丢失 reference content、被篡改 content 或认证不足均失败关闭。相关 type 包括 `SaveEvaluationResultInput`、`LoadEvaluationResultInput`、`EvaluationResultVerifier`、`EvaluationResultVerificationRequest` 与 `EvaluationResultVerification`。

`EvaluateInput` 只包含测量声明；`EvaluationRunOptions` 容纳单次运行的 `runId`、取消、进度观察、报告 annotation／summary、event buffer 容量与 clock。省略 `runId` 时由 Runtime 生成，并通过 `EvaluationResult.runId` 返回。`prepareEvaluation(input)` 会捕获全部可变声明、物化默认值、解析 Runtime capability，并在不调用 Target 或 Evaluator 的情况下封存 Core Plan。冻结的 `PreparedEvaluation` 暴露准确的 `definition`、`policy`、`plan`、完整运行契约 `planDigest`、`resolvedRuntimes` 与 `estimatedWork`；`run(options)` 直接执行同一份 sealed Plan，不重新读取 input 或重新编译。计划 coordinate 不包含 retry 与提前终止带来的变化，duration 和 provider cost 在执行前会明确保持不确定。

`assessComparability()` 接受 canonical evaluation 或 `loadEvaluationResult()` 返回的两份原始已认证 `EvaluationResult`。普通 clone 或反序列化文档不具备 source authority，会被拒绝而不是冒充已认证证据。`comparisonScope` 选择需要保持不变的最深契约阶段，每个 `EvaluationComparabilitySubject` 显式映射左右两侧有意变化的 Variant。返回的 `EvaluationComparabilityAssessment` 完全由 Core 生成，并将 `designStatus`、`evidenceQualificationStatus` 与总的 `comparabilityStatus` 分开保留；已映射 subject 的变化只是 identity 事实，不会被误判为设计漂移，未闭合的 Runtime assurance 则保持 conditional。

`evaluateSeries()` 测量固定设计下的重复性。`repeatCount` 会预注册完整的 member Run 数量；整份 Dataset、SamplingDesign、Evaluator、Analysis graph、policy、Runtime identity 与测量 seed 只捕获一次，并在执行前封存到每个 member。一个 Run 才是一个实验单位；Target trial、retry 与 Rubric 评委 replicate 都是 Run 内嵌套测量，不能增加 Series 的 `runCount`。Member 顺序执行，Execution／Evaluation cache 必须禁用；失败或取消后的 slot 不会被替换，所有缺失都保留在 coverage 中。`stability.sourceAnalysisId` 选择一个既有的 scalar Analysis result，也可以通过显式 `interval-estimate` projection 选择区间的点估计。内置结果只报告 mean、分母为 `n - 1` 的贝塞尔校正样本方差、标准差、最小值、最大值与极差，不产生 verdict 或置信区间。只有全部预注册 slot 都符合 evidence 门槛并可比较时才会完成；否则 stability record 为 inconclusive，不会发布 complete-case 估计。这是同一封存设计下的描述性重复性证据，不代表跨环境复现性，也不主张各 Run 独立同分布。因此，支持 seed 的 Executor 会在每个 member 收到相同的封存 trial seed；有意改变 Run-level seed 属于另一种实验设计，不由首版 façade 表达。

`prepareEvaluationSeries()` 执行同样的捕获，并在不调用 Target 的情况下返回单次使用的 `PreparedEvaluationSeries`，其中包含精确 `definition`、Core `plan`、全部 member Plan 与 `estimatedWork`。`seriesInstanceId` 标识一次有意执行；调用方需要开始一轮不同的 Series 时，必须使用新的 identity。默认要求完整 member evidence，并接受 conditional comparability，因为普通 callback identity 通常来自自我声明；调用方可以显式允许 partial evidence，或要求 compatible comparability。本入口不提供依据结果提前停止、替换 member、复用 cache 或隐式 Decision。调用方取消会停止后续 member，并把同一 signal 传给 Core；终态为 `cancelled`，保留完整的计划 member outcome 列表，但不会伪造 completed Series Analysis 或 Report。

`rescore()`、`reanalyze()` 与 `redecide()` 接收一份完整的新 `EvaluateInput`、一份原始 `EvaluationResult`，以及可选的 `EvaluationRunOptions`。Runtime 会先封存新声明，再由 Core 递归验证保留的 source capability 与全部跳过阶段一致：`rescore` 不能隐藏 Target 输入变化，`reanalyze` 不能隐藏 Gold 或 Evaluator 变化，`redecide` 不能隐藏 Analysis 变化。Clone、反序列化 report 或 Bundle JSON 不具备进程内 source authority，都会被拒绝。复用的上游 bundle 保留原始 identity 与历史 evidence；新执行的后缀阶段使用新 Run identity，只为后缀产生新进度事件，也只消耗新 Run 的后缀预算。Façade 不重建 evidence、不调用被跳过的 callback，也不复制 Core 的评分、统计、Decision、Report、预算、缓存或调度实现。

`SamplingDesign` 支持单 Variant 的 `solo` 质量画像、complete-block `paired` 比较和 fixed-quota `independent` 比较，也是 paired／independent 语义的唯一持有者。solo 设计可以声明 `clusterKey`，此时 Core 将完整 cluster 作为实验单位与重采样单位。一项 `Comparison` 声明一个 control、一个或多个 treatment 与参与分析的 Metric，不再包含重复的 sampling 判别字段。`evaluators` 可包含多个 exact-match、retrieval、abstention、tool-trajectory、Rubric 评委或 custom evaluator，但 evaluator ID 与 metric ID 必须分别唯一。

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

## 内置弃答与混合召回评测

`AbstentionEvaluator` 是内置的 `evaluators[]` 声明，可通过包根与 `/eval-runtime` 使用。它编译为既有 Core 契约，产生两个布尔型 `AbstentionMetricIds`，不引入单独的评测工厂、数据集选择器或执行生命周期。

```ts
const abstention: AbstentionEvaluator = {
  evaluatorKind: 'abstention',
  evaluatorId: 'abstention',
  ranking: { source: 'output', pointer: '/solutionIds' },
  shouldAbstainPointer: '/shouldAbstain',
  metricIds: {
    abstentionCorrect: 'correct-abstention',
    falseAbstention: 'false-abstention',
  },
};
// evaluate({ dataset, evaluators: [abstention], ...hostDesign })
```

`ranking` 必须选择 output 或 trace 中经过应用阈值过滤的**最终**有序推荐 ID 列表。执行成功且合法列表为空，才表示弃答。null、缺失输出、空白／非字符串／重复 ID、执行失败和超时均不算正确弃答。ID 按大小写精确比较，不隐式裁剪空白或去重。`shouldAbstainPointer` 选择 `Sample.expected` 中明确的布尔值；null 和其它非布尔值为非法证据，缺失 Gold 路径在执行前拒绝。评分器不从空相关集合推断标签，也不理解业务审核状态。Gold 绑定不会传给 Target。

| 指标 | 适用样本及含义 | 方向 |
|---|---|---|
| `abstentionCorrect` | 合法且 `shouldAbstain: true` 的样本；空列表为 true，任何非空列表为 false | 越高越好 |
| `falseAbstention` | 合法且 `shouldAbstain: false` 的样本；空列表为 true，非空列表为 false | 越低越好 |

这些指标使用 summary `statistic: 'rate'`。另一类样本记为 `missing`，原因是 `abstention-not-applicable`，按 `exclude/v1` 排除，不伪造零或一。output 或 trace 绑定缺失时，Core 在评分器运行前记录为不可用；缺失 Gold 路径则在准备阶段拒绝。展示完整 Analysis coverage，包括 `included`（实际分母）、`missing`、`invalid`、`sourceUnavailable`、`evaluationFailed`，并同时展示 Execution coverage。零适用观测保持非完成的 Analysis 状态。条件正确弃答率不等于端到端交付率：一条正确空返回、九条超时，可以在有效输出上得到百分之百，但在全部十条应弃答请求上只有百分之十成功交付。重复 trial 仍使用 Core 已声明的实验单位及归约，不隐式以 attempt 数为分母。

版本化的 `omk.eval-runtime.abstention/v1` instrument 将指针、指标 ID 和成功空列表协议封存到 Definition 与 Runtime identity。它不改变 retrieval v1 的公式、评分、prompt 或 Core Schema。不能与历史上把空 Gold 算作召回满分的指标直接比较；应为新 instrument 建立明确基线。自然语言拒答和安全拦截不属于这个列表协议。

完整离线示例及宿主辅助函数均位于单个文件 `examples/eval-runtime/retrieval-abstention.mjs`。构建仓库后运行 `node examples/eval-runtime/retrieval-abstention.mjs`。独立服务可以复制这个示例文件并安装 OMK；合成 Executor 无需凭证或业务网络。

示例在执行前准备并校验标签，默认拒绝待标注样本，允许显式排除，并记录来源版本、数量和原因。业务 `quality.reviewStatus` 只由该辅助函数解释，实际纳入的 Dataset 由 Core 封存。示例组合内置 retrieval、内置 abstention，以及独立的禁用 ID 命中 Custom Evaluator。全部样本提供相关 ID 绑定；负例的空相关集保留 retrieval v1 既有的 `invalid` 观测。召回分析显式选择 `answerable` cohort，在聚合前排除负例；弃答按自身适用范围评分。独立禁用命中示例检查最终结果的前三项，只纳入输出合法且禁用列表非空的样本，不将禁用列表当成所有错误结果的全集。正确召回与禁用命中可以同时发生。

数据准备与禁用 ID 辅助函数是示例代码，不是额外的 OMK 公开 API。调用方可以替换它们而不改变内置弃答 instrument。本次增加可组合评分能力，不规定固定七指标套件。

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

Run 与装配 type 包括 `RunEvaluationInput`、`EvaluationEventObserver`、`CreateEvaluationRuntimeInput`、`EvaluationRuntimeSupportPorts` 与 `RuntimePortRegistration`。Builder type 包括 `ExactMatchDefinitionBuilderInput`、`ExactMatchTarget`、`PairedComparisonDefinitionBuilderInput`、`EvaluationRuntimeTarget`、`MeasurementPolicyBuilderInput`、`MeasurementStagePolicyInput`、`MeasurementRetryPolicyInput`、`MeasurementRetryBackoffInput`、`MeasurementFailurePolicyInput`、`MeasurementEvidencePolicyInput`、`MeasurementEventDeliveryInput` 与 `CreateExactMatchEvaluatorInput`。Identity 与 JSON adapter type 包括 `InvokeExecutorIdentityDeclaration`、`SessionExecutorIdentityDeclaration`、`RuntimeIdentityDeclaration`、`CreateJsonExecutorAdapterInput`、`CreateJsonSessionExecutorAdapterInput`、`JsonExecutorInvocation`、`JsonExecutorInvocationResult`、`JsonSessionExecutorContext`、`JsonSessionExecutorAttempt`、`JsonExecutorSession`、`RuntimeValueParser`、`AllowedToolsInput`、`AllowedToolsPlan`、`WorkspaceDescriptor`、`WorkspaceInput`、`WorkspacePlan`、`WorkspaceProvider`、`WorkspaceOpenRequest`、`WorkspaceLease` 与 `WorkspaceAccess`。Judge type 包括 `OmkLlmJudgeEffort`、`OmkLlmJudgeInvocationPort`、`OmkLlmJudgeInvocationRequest`、`OmkLlmJudgeInvocationResult`、`CreateRubricJudgeKitInput`、`RubricJudgeKit`、`CreateRubricJudgeEvaluatorInput`、`RubricJudgeEvaluatorBinding` 与 `RubricJudgeEvaluatorDefinitionBuilderInput`。Conformance type 包括 `ExecutorConformanceProbeInput`、`ExecutorConformanceResult` 与 `RuntimeConformanceCheck`。旧 bridge 与生命周期 SPI type 包括 `CreateExecutorFnAdapterInput`、`ExecutorFn`、`ExecutorInput`、`ExecResult`、`ExecutorFnInputMapper`、`ExecutorFnResultMapper`、`CreateSameProcessExecutorAdapterInput`、`CreateSameProcessEvaluatorAdapterInput`、`SameProcessExecutorImplementation`、`SameProcessEvaluatorImplementation`、`SameProcessResourceLeaseAccess`、`SameProcessRunScope` 与 `SameProcessOperationScope`。

Advanced budget builder type 包括 `MeasurementBudgetPolicyInput`、`MeasurementBudgetScopeInput`、`MeasurementRunBudgetScopeInput`、`MeasurementAttemptBudgetScopeInput` 与 `MeasurementProviderCostLimitInput`。

Advanced adapter 还暴露 `McpConfigAccess`、`McpConfigDescriptor`、`McpConfigInput`、`McpConfigLease`、`McpConfigOpenRequest`、`McpConfigPlan`、`McpConfigProvider`、`MockInterceptionAccess`、`MockInterceptionDecision`、`MockInterceptionDescriptor`、`MockInterceptionLease`、`MockInterceptionOpenRequest`、`MockInterceptionProvider` 与 `MockInterceptionRequest`。

`MeasurementCachePolicyInput` 是 advanced policy builder 对应的缓存策略输入类型。

## `oh-my-knowledge/eval-runtime/contracts`

面向 adapter 与 trace 作者的版本化 wire contract：

- Rubric identity 与 schema：`RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID`、`RUBRIC_JUDGE_BINDINGS`、`RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION`、`RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION`、`RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION`、`RUBRIC_JUDGE_INSTRUMENT_SCHEMA`、`RUBRIC_JUDGE_CONTEXT_SCHEMA` 与 `RUBRIC_JUDGE_EVIDENCE_SCHEMA`。
- Rubric type：`RubricJudgeInstrument`、`RubricJudgeRuntimeConfig`、`RubricJudgeConfig`、`RubricJudgeCriterion` 与 `RubricJudgeTracePolicy`。
- Trace value：`SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION`、`SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR`、`SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR`、`SourceNeutralTraceSchema`、`SourceNeutralTraceWithoutMocksSchema`、`SourceNeutralMockStatsSchema`、`parseSourceNeutralTrace` 与 `attachSourceNeutralMockStats`。
- Trace type：`SourceNeutralTrace` 与 `SourceNeutralMockStats`。

## 迁移

`1.0.0-beta` canonical 入口用面向用户的 façade 取代了原先的装配优先 surface。一般化 façade 还用 `{ variants, evaluators, comparisons, analyses }` 取代早期固定的 `{ executor, control, treatment, evaluator }` 输入；Executor 与 config 下沉到各 Variant 的 `execution`，Sampling Design 独占 paired／independent 语义，每项 summary 或 interval 都是具名的 `analyses[]` 请求。删除 `comparisonKind`，并将多余的 `analysis: { analyses: [...] }` 包装直接改为 `analyses: [...]`；旧结构不会被读取或检测。把 `runId`、`signal`、`onEvent`、`clock`、`annotations`、`summaries` 与 `eventBufferCapacity` 从声明移到可选的第二个 `EvaluationRunOptions` 参数；省略 `runId` 时自动生成。Decision 可省略；传入时通过 `analysisId` 精确选择一个 interval，或选择一份显式有界的 comparison family。Rubric 评测必须使用 `judges + aggregation`，不接受单数 `judge + model + effort` 结构。Policy 字段统一归入 `execution`、`evaluation`、`failure`、`budget` 与 `evidence`；早期扁平的 concurrency、timeout、invocation、failure 与 classification 字段不再接受。它不提供 0.x 兼容读取、旧 overload 或旧结构检测。已有底层 import 从 `oh-my-knowledge/eval-runtime` 移到 `oh-my-knowledge/eval-runtime/advanced`；wire schema 仍位于 `/contracts`。`createEvaluationEngine` 只有一种含义和一个入口：完整 staged engine 从 `oh-my-knowledge/eval-core` 导入；如果已经装配好 Runtime、Definition 与 Policy，只需一次标准完整运行，则使用 advanced 的 `runEvaluation`。新宿主从包根导入 `evaluate`、`prepareEvaluation` 或 `checkExecutor`；偏好领域限定 import 的消费者仍可使用完全等价的 `/eval-runtime` 入口。

预算 limit 现在位于显式 scope 下：将 `budget.maxInvocations` 改为 `budget.run.maxInvocations`。旧结构不会被读取或检测。

自定义 analysis graph、分阶段重放、transported 自定义 comparability policy，或不符合上述 canonical 完整结果契约的 artifact admission，使用 `oh-my-knowledge/eval-core`。实现深路径不受支持。
