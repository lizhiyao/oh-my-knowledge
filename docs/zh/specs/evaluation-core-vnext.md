# Evaluation Core vNext RFC

> **状态**：已由 [#426](https://github.com/lizhiyao/oh-my-knowledge/pull/426) 接受。关联 [#425](https://github.com/lizhiyao/oh-my-knowledge/issues/425)，并作为 [#424](https://github.com/lizhiyao/oh-my-knowledge/issues/424) 的架构前置。本文定义全新 Evaluation Core 的领域边界和测量契约，不兼容现有 `runEvaluation`、文件型 Sample 或 Report JSON schema。旧实现只作为算法与失败案例的参考。

## 一、摘要

Evaluation Core vNext 是一个宿主无关、纯内存、可重评分的评测内核。它把一次评测拆成四个可独立验证和重算的阶段：

```text
EvaluationDefinition + MeasurementPolicy
        │ prepare／validate／resolve capabilities／seal
        ▼
  Immutable RunPlan
        │
        ├── execute ──> ExecutionBundle
        │                  │
        │                  └── evaluate／re-evaluate
        ▼
      EvaluationBundle
        │
        └── reduce／compare／infer
                           ▼
                    AnalysisBundle
                           │
                           └── decide ──> EvaluationReport
```

核心决定：

- Execution、Evaluation、Analysis 和 Decision 是不同阶段；
- Bundle 是不可变事实记录，Report 是物化视图；
- Evaluator 统一执行协议，但 Metric、Reducer 和 DecisionPolicy 分离；
- Gold 通过不同数据投影与 digest 隔离，不能影响 Target 执行；
- 所有会改变输出、缺失、顺序或结论的策略都在第一次外部调用前封存；
- Event 是旁路生命周期通知，不是唯一事实源；
- digest 证明内容身份，不冒充可复现性或来源证明。

## 二、问题

现有 pipeline 把 CLI 参数、文件解析、artifact 解析、执行器、评分、统计、报告落盘和进度回调连在一条流程里。它已经验证了 assertion、LLM 评委、paired bootstrap、稳定性、runtime fingerprint 等能力，但不适合作为长期公共内核：

- 无法在不重跑 Target 的情况下重评分；
- Definition 混入路径、函数或宿主状态后无法可靠序列化和寻址；
- Gold 隔离依赖调用约定，缺少能力边界；
- timeout、budget、retry、cache 等运行选项可能改变测量结果，却没有统一进入测量身份；
- 单一 Report 同时承担事实、分析、展示和持久化职责；
- 进程级全局资源使并发 Run 难以隔离；
- 现有 composite 的等权、混合量表和缺失维度降权不适合作为新内核默认模型。

## 三、目标与非目标

### 目标

1. 用纯 JSON Definition 和可信 Runtime 实现分离配置与代码。
2. 支持函数、模型、RAG、Agent、Workflow 和外部执行结果，而不在 Core 写宿主分支。
3. 支持执行结果重评分、重新分析和重新决策，并保留完整 derivation lineage。
4. 让统计设计、缺失机制、缓存和预算成为显式测量契约。
5. 让并发 Run 的资源、取消、事件和缓存完全隔离。
6. 为包根嵌入式 API、CLI、Studio 和未来宿主提供同一套 Core。

### 非目标

- 历史 API、Sample 或 Report schema 兼容；
- CLI、Studio、文件路径、数据库、队列、租户或 UI；
- 分布式调度、checkpoint／resume 或工作流引擎；
- 在线生产评分、通用 APM 或实时告警；
- 执行不可信用户上传代码的 sandbox；
- 某个模型供应商、RAG 产品或 FaaS 的专属字段。

## 四、设计原则与测量不变量

### 1．先定义 estimand，再执行任务

评测不是「跑完后看有什么数据就算什么」。Definition、SamplingDesign、Metric、Reducer、Comparison 和 DecisionPolicy 共同定义要估计的量。第一次 Target 调用前必须生成 sealed RunPlan。

### 2．统一接口不等于统一分数

assertion、结构化 scorer 和 LLM 评委都是 Evaluator 实现，但它们的输出可以属于不同量表。Core 不默认归一化到 0–1，不默认求平均，也不在维度缺失时自动降权。

### 3．缺失不是零

execution error、evaluation error、取消、预算截尾和无法解析的内容分别记录。任何 Reducer 和 DecisionPolicy 都必须显式声明自己如何处理缺失；不满足前提时返回 inconclusive，而不是猜测。

### 4．缓存不是新试验

随机系统的 cache hit 不能计作新的独立 trial。replay 保留原始 trial identity 和 provenance；只有经过验证的 deterministic Target 才允许透明复用 Execution cache。

### 5．可比性是显式关系

两个 Bundle digest 不同不代表一定不可比较，相同也不代表实验设计有效。ComparabilityPolicy 根据 Dataset 投影、Target、Runtime、Evaluator、SamplingDesign 和 DecisionPolicy 的变化给出 compatible、conditional 或 incompatible，并解释理由。

### 6．标准兼容，不被标准绑架

Core 的领域类型保持最小且宿主无关。CloudEvents、OpenTelemetry／OpenInference、W3C Trace Context 和外部实验平台只通过 adapter 映射，不成为 Core SDK 依赖。

## 五、领域模型

### 1．Definition

Definition 是不可变、可序列化的意图，不包含函数、类实例、绝对路径或进程状态。

```ts
interface EvaluationDefinition {
  schemaVersion: 'omk.evaluation-definition/v1';
  dataset: EvaluationDataset;
  targets: readonly TargetDefinition[];
  evaluators: readonly EvaluatorDefinition[];
  metrics: readonly MetricDefinition[];
  analysisGraph: AnalysisGraphDefinition;
  comparisons: readonly ComparisonDefinition[];
  decisionPolicy?: DecisionPolicyDefinition;
  extensions?: Readonly<Record<string, JsonValue>>;
}
```

未知顶层字段默认拒绝，防止拼写错误静默生效。扩展只能放在命名空间化 `extensions` 中，并由扩展自己的 schema URI 和 digest 描述。

Wire contract 以仓库现有 Zod 4 schema 为单一来源，并限制在能完整导出 JSON Schema 2020-12 的子集。CI 使用 `z.toJSONSchema()` 生成并检查发布 schema；遇到 `transform`、`date`、`map`、`set`、`custom` 等不可表达类型时直接失败，不允许降级成 `{}`。跨字段、capability 和统计前提校验属于 prepare compiler，不藏在无法导出的 schema refinement 中。

### 2．Dataset 与用例投影

```ts
interface EvaluationSample {
  sampleId: string;
  input: JsonValue;
  executionContext?: JsonValue;
  expected?: JsonValue;
  evaluationContext?: JsonValue;
  annotations?: JsonValue;
}
```

- Executor 只收到 `input + executionContext` 的冻结投影；
- Evaluator 可以按声明读取 output／trace／expected／evaluationContext；
- `annotations` 只用于审计和展示，不参与执行或评分；
- 映射默认使用受限 JSON Pointer，只允许定位一个值；多值 JSONPath 属于 adapter 扩展。

Dataset 具有三个不同 digest：

| Digest | 覆盖内容 | 用途 |
|---|---|---|
| `datasetRevisionDigest` | 完整 Dataset | lineage 和审计 |
| `executionInputDigest` | `input + executionContext` | ExecutionPlan 身份 |
| `evaluationInputDigest` | 执行投影 + `expected + evaluationContext` | EvaluationPlan 身份 |

Gold 或 evaluator-only metadata 变化不得改变 ExecutionPlan、调度或 Executor 可观察状态。

### 3．Target 与 Runtime capability

```ts
interface TargetDefinition {
  targetId: string;
  targetKind: string;
  protocolId: string;
  executorId: string;
  versionConstraint?: string;
  config?: JsonValue;
}
```

`targetKind` 是描述性分类，不驱动 Core orchestrator 的 switch。行为由版本化 protocol family、输入输出 schema 和 capability manifest 决定。capability 描述可选能力，不替代类型系统。

v1 只内建两个 protocol family：

- `omk.invoke/v1`：一个 trial 对应一次结构化 request／response，可附 source-neutral trace；覆盖纯函数、模型、服务、RAG 和无会话 Workflow；
- `omk.session/v1`：一个 trial 拥有独立 session lifecycle，支持多轮消息、工具调用和部分 trajectory；覆盖 Agent 和有状态 Workflow。

每个 protocol manifest 还必须声明结构化 execution capability：并发安全性与上限、取消语义、run resource lifecycle、trial state、seed control、determinism，以及 trace／usage telemetry。run-scoped resource 只允许连接池、客户端等基础设施复用；`omk.session/v1` 的业务状态始终按 trial 隔离，`omk.invoke/v1` 的 trial state 始终 stateless。声明 `cancellation: unsupported` 的实现不能与 timeout policy 组合；随机 Runtime 若不支持 seed，只能使用 `uncontrolled` seed design；只有 determinism 与 Runtime assurance 都为 verified 的实现才能透明命中 Execution cache。

导入宿主已经执行好的结果不属于第三个执行协议，而是直接校验并接收 ExecutionBundle。protocol ID 是不可变契约；不兼容修改发布新 major path，可选能力只能做不改变既有字段语义的追加。

Runtime 在 prepare 阶段解析实际实现：

```ts
interface RuntimeIdentity {
  implementationId: string;
  version?: string;
  fingerprint: string;
  fingerprintBasis: 'content-derived' | 'environment-derived' | 'self-reported' | 'opaque';
  assuranceLevel: 'verified' | 'declared' | 'unknown';
  capabilities: JsonValue;
}
```

调用方声明的版本或 fingerprint 只是要求，Report 记录 Runtime 实际解析出的身份。远程模型 deployment、工具、sandbox、依赖和环境以 provenance facets 保存。

### 4．ExperimentDesign 与 SamplingDesign

```ts
interface SamplingDesign {
  experimentalUnit: 'sample' | 'run' | 'cluster';
  pairingKey?: string;
  clusterKey?: string;
  stratumKey?: string;
  repeatedMeasures: boolean;
  resamplingUnit: 'sample' | 'paired-block' | 'cluster' | 'run';
  estimatorId: string;
  seedCoupling: 'shared-within-block' | 'independent-by-target' | 'uncontrolled';
}

interface ExperimentDesign {
  trials: number;
  seed: string;
  sampling: SamplingDesign;
  scheduling: SchedulingPolicy;
}
```

trial 表示同一实验条件的一次重复测量；retry attempt 表示一次 trial 内的基础设施重试，两者不能互换。统计实现必须在 prepare 阶段验证自己支持当前 SamplingDesign，不能把重复 trial 自动视为独立样本。

配对比较以 scheduling block 为调度原子。编译器会把比较关系的连通性固化为 canonical `ExecutionPlan.schedulingTargetGroups`：有重叠的比较合并为一个 Target 连通组，未参与比较的 Target 保持单元素组。该分组纳入 `executionPlanDigest`；改变配对连通性会产生新的 Execution 身份，而只影响决策的比较元数据不会。`seedCoupling` 显式决定同一 block、同一 sample 的各 Target 共享随机条件、按 Target 派生独立随机条件，还是诚实声明 Target 随机性不可控；sample coordinate 始终进入 seed 派生，避免一个大 block 内不同 sample 意外复用 seed。预算不足时不得只启动 block 的一侧；未启动的坐标标记为 budget-censored，不伪造 attempt，也不进入主要配对估计。

`pairingBlockId`、`clusterId`、`stratumId` 分别表达统计归属，`schedulingBlockId` 只表达调度原子；它们不能复用一个含义模糊的 ID。scheduling identity hash 规范化后的完整 `(targetId, sampleId)` coordinate 集和影响调度的 sampling-unit IDs，不能拆成会丢失对应关系的 Target／sample 两个集合。所有 ID 从 Plan digest 与规范化成员集合做 domain-separated 派生，不直接 hash 低熵的原始 pairing／cluster／stratum 值。

### 5．Evaluator、Metric、Reducer 与 DecisionPolicy

```ts
interface MetricDefinition {
  metricId: string;
  valueType: 'numeric' | 'boolean' | 'categorical' | 'text' | 'ranking';
  scope: 'sample' | 'target' | 'comparison' | 'run';
  scale?: { min?: number; max?: number };
  unit?: string;
  direction?: 'higher-is-better' | 'lower-is-better' | 'target-is-best';
  missingPolicyId: string;
}
```

- Evaluator 是可信可执行实现，产生 MetricObservation 和 evidence；
- MetricDefinition 定义值的语义，不执行代码；
- Reducer 把 observation 归约成 AnalysisResult；
- DecisionPolicy 消费命名的 AnalysisResult，产生 verdict；
- weight 只属于明确的 composite reducer，不是 Metric 的通用属性。

复杂分析由有向无环的 AnalysisGraph 表达。每个节点声明输入、输出 schema、实现身份和参数；prepare 检查循环、缺失依赖和值域不匹配。

v1 内建的 reducer／estimator 保持最小：

- `descriptive.mean/v1`、`descriptive.rate/v1`、`descriptive.quantile/v1`；
- `bootstrap.mean-percentile/v1`；
- `bootstrap.paired-difference-percentile/v1`；
- `bootstrap.cluster-percentile/v1`；
- multiple-comparison correction 的 `bonferroni/v1`。

alpha、重采样次数、resampling unit 和 seed 都进入 AnalysisPlan。v1 不内建 t-test、ANOVA、Hotelling T² 等参数方法；未来通过 AnalysisRegistry 增加新 estimator identity，不改变 observation 或 Bundle 契约。值域或 SamplingDesign 不受某 estimator 支持时，prepare 失败，不自动换算法。

重新分析和重新决策保留 parent bundle digest、policy digest、生成时间以及 `analysisMode: preregistered | exploratory`。执行后修改的阈值或方法不能冒充预先封存的发布门槛。

## 六、计划、Bundle 与 Report

### 1．Sealed RunPlan

```ts
interface MeasurementPolicy {
  execution: ExecutionPolicy;
  retry: RetryPolicy;
  budget: BudgetPolicy;
  cache: CachePolicy;
  evidence: EvidencePolicy;
  failure: FailurePolicy;
  eventDelivery: EventDeliveryPolicy;
}
```

所有可能改变输出、缺失、调度、证据完整度或结论的配置都属于 MeasurementPolicy，并在 prepare 时进入 RunPlan 和对应 digest。`start()` 只能接收外部 `AbortSignal`、annotations、EventWriter 和不影响测量结果的 observer options，不能覆盖测量策略。

### 2．ExecutionBundle

按 canonical `(targetId, sampleId, trialIndex)` 顺序保存，每条记录携带从 ExecutionPlan 派生的 `trialId`、`trialSeed`、`schedulingBlockId` 和独立 sampling-unit IDs：

- completed output 可按 EvidencePolicy 内联、保存 ContentDescriptor、仅保存 digest 或省略；是否省略不改变 executionStatus；
- source-neutral trace；
- trial 级可聚合 usage 与 timing；
- 携带每次真实调用精确 usage 和 provider-reported cost 的 retry attempt；
- execution error；
- RuntimeIdentity；
- execution、cache／replay provenance；
- 父 Plan digest 和 Bundle digest。

started record 与 budget-censored record 是互斥结构。后者没有 attempt、timing、output、trace 或 usage，因为对应调用从未开始。completed attempt 必须终止 trial，后续不能再伪造 retry。Bundle 另有正交的 terminal status 与 coverage counters：`planned = started + budgetCensored + notStarted`，`started = succeeded + failed + cancelled`；`budget-exhausted` 必须把所有尚未启动的坐标归类为 budget-censored，而不是笼统的 notStarted。预算也可能在最后一个已启动 trial 内耗尽，例如 retry 无法获准或 provider cost 只能在完成后得知；此时合法的 budget-exhausted Bundle 不需要伪造一个 censored coordinate。

`parseExecutionBundleDocument()` 只做不依赖外部状态的 wire、局部状态机与 digest 校验。导入或物化必须调用绑定 sealed RunPlan 的 `parseExecutionBundle()`，进一步核对 parent digests、完整 coordinate universe、trial／seed／sampling／scheduling identities、Target Runtime、retry policy、调用预算和 paired-block 原子删失；不能信任 Bundle 自报的 block 或 coverage。

Evaluator 若声明读取 output 或 trace，prepare 必须拒绝会移除该输入的 EvidencePolicy。Execution 阶段仍可只产生 `summary-only` Bundle；只有 `self-contained` 要求 completed output 以及所有 active record 的 trace 全部内联，`resolvable` 要求这些内容可内联或通过经 digest 校验的 descriptor 解析。

价格目录推算的 cost 不是原始执行事实，应作为带 pricing fingerprint 的派生 AnalysisResult 保存。

### 3．EvaluationBundle

保存：

- evaluator RuntimeIdentity；
- MetricObservation；
- evidence 或 ContentDescriptor；
- evaluation error；
- cache provenance；
- parent ExecutionBundle digest、EvaluationPlan digest 和自身 digest。

### 4．AnalysisBundle

保存 AnalysisGraph 各节点的结果、前提检查、coverage、置信区间、分布、表格或曲线，以及 parent EvaluationBundle digest。

### 5．EvaluationReport

Report 是为人和产品消费构造的物化视图。它可以内联 Bundle 摘要或引用 Bundle，但不能成为重评分和审计的唯一数据源。

Report 使用三个正交状态：

```ts
interface EvaluationStatus {
  runStatus: 'completed' | 'cancelled' | 'budget-exhausted' | 'failed';
  evidenceStatus: 'complete' | 'partial' | 'unresolvable';
  conclusionStatus: 'conclusive' | 'inconclusive' | 'not-evaluated';
}
```

`runStatus: completed` 只表示流程结束。只有 coverage gate、统计前提和 evidence 完整度满足 DecisionPolicy 时，才能产生 PROGRESS／REGRESSION 等方向性 verdict。

### 6．Replayability

每个 Bundle 声明：

- `self-contained`：重评分所需内容全部内联；
- `resolvable`：可由注入的 ContentResolver 取回并验证 digest；
- `summary-only`：不承诺重评分。

导入 Bundle 还要声明 provenance trust。schema 和 digest 校验只能证明内容完整，不能证明它确实由声称的 Target 产生。

v1 不在 Core 内实现 Bundle 签名。签名要求身份策略、可信根、证书／密钥生命周期和验证材料，属于宿主治理边界。v1 只记录 digest、provenance trust 和 assurance level；宿主可以在命名空间化 extension 中附加 Sigstore／DSSE 等 attestation，并通过注入 verifier 提升 trust。没有 verifier 的签名材料只作为 opaque evidence，不能自动变成 verified。

## 七、身份、规范化与可比性

Definition、Plan、Bundle、Event 和 Report 都带独立 `schemaVersion`，并发布 JSON Schema 2020-12。TypeScript 类型与运行时 schema 必须单一来源生成，或由 parity test 保证一致。

可寻址对象限制为 RFC 8785 JCS 可规范化的 I-JSON 子集，不允许 `NaN`、`Infinity`、函数、symbol、循环引用或依赖属性插入顺序的语义。digest 使用完整 `sha256:<hex>`。

```text
executionPlanDigest = H(
  executionInputDigest,
  target snapshots,
  executor manifests,
  SamplingDesign,
  scheduling + execution policy
)

evaluationPlanDigest = H(
  executionPlanDigest,
  evaluationInputDigest,
  evaluator manifests,
  metric definitions,
  evaluation policy
)

analysisPlanDigest = H(
  evaluationPlanDigest,
  AnalysisGraph,
  estimator manifests
)

decisionPlanDigest = H(
  analysisPlanDigest,
  comparisons,
  DecisionPolicy
)

runContractDigest = H(all plan digests + schema identities)
```

`project`、`owner`、`tags` 等 annotations 不进入测量 digest。Evidence capture 若不改变评分但改变审计能力，进入独立 evidence contract 和 Bundle provenance；若会让 Evaluator 缺少输入，则必须进入 EvaluationPlan。

## 八、运行时、资源与取消

Core 默认不得读写文件、读取环境配置、写 stdout／stderr、加载 CLI／Studio、创建目录、调用 `process.exit` 或维护进程级可变 registry。

Runtime ports 至少包括：

- ExecutorRegistry；
- EvaluatorRegistry；
- AnalysisRegistry；
- ContentResolver／ContentStore；
- Clock、IdGenerator 和 RandomSource；
- 可选 EventWriter。

Executor／Evaluator 可以通过 `openRun()` 返回 run-scoped resource handle 和异步 disposer。资源所有权必须形成严格树：Engine 拥有 registry，Run 拥有连接池／客户端等资源，trial／attempt 拥有隔离的业务状态和临时资源。run-scoped resource lifecycle 不表示跨 trial 共享 session state；一个 Run 的取消或 teardown 不能关闭另一个 Run 的资源。

取消统一使用 AbortSignal。用户取消产生诚实的部分 Bundle；timeout 和 budget 因为影响缺失机制，属于 sealed MeasurementPolicy。Core 不提供跨进程 resume；宿主可以从完整 ExecutionBundle 启动新的 Evaluation 阶段。

Execution runtime 是 sealed RunPlan 的纯内存解释器。`startExecution()` 在暴露 Run 前同步检查所需端口和 Executor Runtime identity 是否与 Plan 完全一致，并捕获对应 Executor 引用，后续 registry 变化不能替换 sealed implementation。坐标只从 Plan 派生；randomized admission 只使用 sealed root seed；全局与每个 Executor 的 semaphore 均归当前 Run 所有。paired scheduling block 在 admission 时原子预留首次真实调用；cache hit 不消耗调用预算，每次 retry 则单独消耗。发生在 `trial.execute()` 之前的错误属于 run-level resource failure，不能伪造 attempt 或消耗调用预算。

timeout 采用协作式取消：Core abort attempt signal 后仍等待 Executor promise settle，避免遗留晚到 promise；即使 Executor 在观察到 abort 后返回成功，也只记录一次 timeout terminal fact。外部取消遵循同样的单终态规则。`maxDurationMs` 是基于 monotonic clock 的软 admission deadline：已经获准的工作继续 settle，后续 block 才进入删失。provider cost 上限只使用供应商报告的可审计事实；已获准 batch 可能 overshoot，此后停止新 block admission，但不会回写或删除已经发生的 usage。

Execution cache 与 evidence storage 都是注入端口，不是 Core 内建文件服务。`replay-only` miss 和损坏的 cache entry 均 fail closed；transparent hit 只能使用 prepare 已封存的 deterministic、verified identity。cache write 推迟到 resource teardown 成功、且 commit 时尚未出现 execution、cancellation 或 budget terminal 之后；只有 cost audit、evidence materialization 和 trial teardown 全部成功的 record 才 eligible。随后发生的 terminal-event delivery failure 不会追溯作废已经提交的 Target fact。full、reference、digest-only 与省略四种 capture 都服从 classification ceiling；reference 写入 Bundle 前必须核对 ContentStore descriptor digest。宿主原始异常文本不会复制进事件或 Bundle。

每个 attempt 保留自己的精确 UsageRecord；record 级 UsageRecord 只负责可聚合摘要。token 与同币种 cost 可以求和；混合币种或部分上报的 cost 只保留在 attempt facts 中，并在 aggregate details 标记为不可直接比较。Runtime 不得因为无法形成一个标量总额而删除已经观察到的 cost。

## 九、Event 语义

`run.events` 是有界的热通知流：

- 未消费事件不得阻塞或改变 `run.result`；
- 每个 Run 只允许一个 AsyncIterable 消费者；多路 fan-out 由宿主完成；
- Run 创建时即开始写入内存 journal，默认最多保留 256 条；晚订阅者先收到仍保留的历史事件，再进入实时流；Run 结束后仍可订阅一次并排空 journal；
- 宿主可以在 start observer options 中调整容量；它不进入测量 digest，因为事件拥塞不能改变 Bundle 或结论；
- 缓冲满时丢弃最旧的 retained notification；terminal event 最后追加，因此始终保留在最终窗口中；
- observation、Bundle 和 terminal data 不得只存在于事件中；
- 每个 Event 带 schemaVersion、eventId、runId、单 Run 单调 sequence、eventKind、time、subject 和 data；
- 需要无损持久化时使用 EventWriter。v1 只支持 blocking backpressure；writer 与 notification delivery 按单 Run sequence 串行化，是否启用 writer 及失败策略由 sealed EventDeliveryPolicy 决定。required writer 失败会停止后续 admission，并改变权威 Bundle 的 terminal state；即使失败发生在最初 completed terminal event 的投递阶段也是如此。

Event 可以在 adapter 层无损映射到 CloudEvents。Trace 可以映射到 OpenTelemetry／OpenInference，并可接收 W3C Trace Context；Core 不依赖这些 SDK。

## 十、错误与失败

prepare 阶段的 schema、引用、capability 或统计前提错误抛出 `EvaluationDefinitionError`，不创建 Run。

运行中错误分类：

- configuration；
- infrastructure；
- execution；
- evaluation；
- analysis；
- internal invariant violation。

execution／evaluation error 是 observation，由 FailurePolicy 决定 continue、fail-fast 或 failure threshold。质量失败、assertion 失败和 treatment 回归都是有效测量，不属于运行错误。

异常对象不能直接序列化进 Event 或 Report；必须转为稳定错误码、阶段、可公开消息、受控 details 和 cause chain。

## 十一、内容、安全与隐私

```ts
interface ContentDescriptor {
  mediaType: string;
  digest: string;
  size?: number;
  uri?: string;
}
```

Core 不直接解引用 URI。ContentResolver 负责访问控制、大小限制、协议白名单和 digest 校验。

内容至少分为 public、sensitive、secret、gold。EventWriter、Report materializer、ContentStore 和 error serializer 各自声明允许接收的最高分类。Evaluator 产生的 evidence 和错误信息也经过相同分类与 redaction。

EvidencePolicy 分别控制 input、output、trace、expected 和 evidence 的 full／reference／digest／none 捕获方式，并清楚报告这会不会降低 replayability 或 evidenceStatus。

## 十二、公共 API 草案

```ts
const engine = createEvaluationEngine(runtime);

const plan = await engine.prepare(definition, measurementPolicy);

const run = plan.start({
  signal,
  annotations,
  eventWriter,
  observer: { maxBufferedEvents: 256 },
});

for await (const event of run.events) {
  // 可选的生命周期通知
}

const result = await run.result;
```

高级 API 支持：

- `execute(plan.execution)`；
- `evaluate(plan.evaluation, executionBundle)`；
- `analyze(plan.analysis, evaluationBundle)`；
- `decide(plan.decision, analysisBundle)`。

包根另提供一次完成全流程的便捷 façade。高级 API 输出可序列化 Bundle，不暴露可变内部调度器。公共导出通过 `package.json#exports` 白名单管理，不再承诺 `./dist/*` 深层导入。

## 十三、Conformance 与验证

第一组 conformance fixture 同时覆盖：

1. 纯函数：结构化 input／output、无 trace；
2. RAG top-K：retrieval evidence、ranking Metric；
3. Agent trajectory：多轮消息、工具调用、取消和部分 trace。

若 Core orchestrator 需要按 `targetKind` 加分支，协议抽象不通过验收。

必须包含以下性质测试：

- JSON 属性顺序变化不改变 digest；
- annotations 变化不改变测量 digest；
- Gold 变化只失效 Evaluation 及下游；
- Evaluator 变化不失效 Execution；
- Runtime fingerprint 变化必然失效对应阶段；
- replay 不增加随机 trial 数；
- repeated trial 不被当作独立 experimental unit；
- 慢 Event 消费者不改变结果；
- 并发 Run 不共享取消、cache 或 teardown；
- paired block 在预算耗尽时不会只完成一侧；
- secret／gold 不进入未授权 Event、Report 或 error；
- partial evidence 无法越过 coverage gate 产生方向性 verdict。

统计实现还要使用已知参考向量和 simulation 检查 coverage、I 型错误率、配对和 cluster resampling，而不只锁 snapshot。

## 十四、被否决的方案

### 1．在现有 `runEvaluation` 上继续加 options

否决。它保留了 CLI、文件、全局状态和 Report 耦合，无法建立清晰的 Gold 和 effect 边界。

### 2．只保留一个 Report，重评分时从 Report 取数据

否决。展示捕获策略会反向限制测量事实，Report schema 也会同时承担过多职责。

### 3．把 Event Log 当作唯一事实源

否决。Core 不承担 durable event store 和恢复协议；未消费或拥塞的通知流不能影响测量事实。

### 4．所有 Metric 统一到 0–1 并默认平均

否决。统一范围不等于 construct 可比，会隐藏量表、方向和缺失语义。

### 5．所有 Target 使用一个不断增长的 capability 列表

否决。它会形成 Boolean soup。采用 protocol family + schema + capability negotiation。

### 6．透明复用所有 Execution cache

否决。它会把同一输出伪装成新的随机 trial，破坏方差与稳定性测量。

### 7．在 Core 内实现数据库、队列和 checkpoint

否决。durability 和分布式编排属于宿主；Core 提供可寻址 Bundle 作为组合边界。

## 十五、交付顺序

1. 本 RFC 与关键 ADR 评审通过；
2. 创建 Contracts、Compiler、Execution、Evaluation／Analysis、Conformance 五个 child Issue；
3. Contracts：schema、类型、canonicalization、digest 和状态机；
4. Compiler：projection、capability resolution、Plan sealing；
5. Execution：trial、paired scheduling、资源和 ExecutionBundle；
6. Evaluation／Analysis：重评分、AnalysisGraph、统计和 DecisionPolicy；
7. Conformance：三类 Target、fault injection、安全与 simulation；
8. #424 包根 façade；
9. 最后迁移 CLI／Studio。

每一阶段只依赖前一阶段的公开 Bundle／Plan 契约，不直接导入内部实现。

## 十六、RFC 决议记录

本轮评审关闭五个阻断问题：

1. **Schema 单一来源**：采用 Zod 4 可完整导出的 wire-schema 子集；JSON Schema 2020-12 由 CI 生成，语义校验留在 prepare compiler。
2. **Protocol family**：v1 只有 `omk.invoke/v1` 和 `omk.session/v1`；外部结果通过 ExecutionBundle 导入，不新增 import protocol。
3. **Event journal**：单消费者、默认 256 条、晚订阅回放保留窗口、progress 优先合并、溢出显式报告；无损需求走 EventWriter。
4. **Bundle 签名**：v1 不内建签名，只记录 digest 与 trust；签名／attestation 由宿主 extension 和 verifier 组合。
5. **Estimator registry**：v1 内建描述性 reducer、percentile bootstrap 的 mean／paired-difference／cluster 和 Bonferroni，不内建参数方法。

这些决定关闭 Contracts 开工前的架构选择；实现阶段仍需用 conformance 和 simulation 验证默认常量与算法正确性。

## 十七、Contracts v1 实现基线

第一阶段实现由 [#427](https://github.com/lizhiyao/oh-my-knowledge/issues/427) 跟踪。单一来源隔离在 `src/evaluation-core/contracts/`，不导入历史 `src/eval-core/`、CLI、executor、grading、renderer 或 server 层。

Catalog 当前在 `schemas/evaluation-core/v1/` 发布十二个 JSON Schema 2020-12 根契约：EvaluationDefinition、MeasurementPolicy、四个阶段 Plan 与 RunPlan、Event、三个 Bundle、EvaluationReport。TypeScript 类型从同一组 Zod 4 schema 推导。`yarn build:schemas` 重新生成文件；`yarn build` 检查已提交产物是否漂移，并把它们复制到 package build。

Wire 入口使用 `parseWireDocument()`，不直接裸调 schema parse。它先拒绝不能表示为 I-JSON 或 JCS 输入的值，包括非有限数、函数、symbol、循环引用、稀疏数组、accessor property、class instance 和未配对 Unicode surrogate，再执行 Zod schema 校验。宿主若接收原始 JSON 文本，还必须在构造 JavaScript 值前拒绝重复属性名，因为普通 `JSON.parse()` 完成后已无法观测重复键。

Digest 边界是可执行契约：

| Identity | 包含 | 排除 |
|---|---|---|
| `datasetRevisionDigest` | 完整 Dataset | 无 |
| `executionInputDigest` | `sampleId`、`input`、`executionContext` | Gold、evaluator context、annotations |
| `evaluationInputDigest` | execution projection、`expected`、`evaluationContext` | annotations |
| 各阶段 Plan digest | 前序阶段 identity、当前阶段定义、实际解析的 Runtime identity、相关 sealed policy | 后续阶段 policy、审计 annotations |
| `runContractDigest` | 全部阶段 Plan digest、schema identity、EventDeliveryPolicy | Report annotations、仅 observer 使用的选项 |

所有 digest 都是 RFC 8785 canonical UTF-8 bytes 的完整小写 `sha256:<hex>`。它只证明内容身份。Provenance trust、fingerprint basis 与 assurance level 保持独立字段；v1 不实现签名。

[#431](https://github.com/lizhiyao/oh-my-knowledge/issues/431) 在 Execution 开工前加固 v1：SamplingDesign 显式封存 seed coupling；protocol manifest 拆分资源生命周期与 trial state；Execution identity 使用 domain separation；ExecutionBundle 把 active／censored record、terminal status、coverage 和 replayability 分开建模。因为尚无历史用户需要迁移，这些修改直接收敛 v1，不保留旧字段兼容层。

## 十八、行业参考

- [Inspect AI Tasks](https://inspect.aisi.org.uk/tasks.html)、[Scorers](https://inspect.aisi.org.uk/scorers.html)、[Eval Logs](https://inspect.aisi.org.uk/eval-logs.html)；
- [Phoenix Experiments](https://arize.com/docs/ax/improve/experiment-in-code)；
- [Pydantic Evals](https://pydantic.dev/docs/ai/evals/evals/)、[Report Evaluators](https://pydantic.dev/docs/ai/evals/evaluators/report-evaluators/)；
- [lm-evaluation-harness Task Guide](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/task_guide.md)；
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)、[OpenInference Semantic Conventions](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md)；
- [CloudEvents](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)、[W3C Trace Context](https://www.w3.org/TR/trace-context/)；
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)、[RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html)、[RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)。
- [Zod 4 JSON Schema](https://zod.dev/json-schema)、[Node.js Events](https://nodejs.org/api/events.html)、[Sigstore Bundle specification](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto)。

## 相关文档

- [评分公式](scoring.md)；
- [统计严谨性](../explanation/statistical-rigor.md)；
- [术语规范](terminology-spec.md)；
- [RAG metrics 规范](rag-metrics-spec.md)。
