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

配对比较以 scheduling block 为调度原子。编译器会把比较关系的连通性固化为 canonical `ExecutionPlan.schedulingTargetGroups`：有重叠的比较合并为一个 Target 连通组，未参与比较的 Target 保持单元素组。该分组纳入 `executionPlanDigest`，因此改变配对连通性会产生新的 Execution 身份。comparison label、treatment role 与 metric projection 不改变 Execution 或 Evaluation 身份，但会改变 Analysis 身份及全部下游 digest。`seedCoupling` 显式决定同一 block、同一 sample 的各 Target 共享随机条件、按 Target 派生独立随机条件，还是诚实声明 Target 随机性不可控；sample coordinate 始终进入 seed 派生，避免一个大 block 内不同 sample 意外复用 seed。预算不足时不得只启动 block 的一侧；未启动的坐标标记为 budget-censored，不伪造 attempt，也不进入主要配对估计。

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

复杂分析由有向无环的 AnalysisGraph 表达。每个节点声明输入、输出 schema、实现身份和参数；已解析 capability 会分别封存 parameter schema，以及 Metric、上游 result、Comparison 三类输入基数。Core 在计算 plan digest 前校验 parameter 并物化默认值，因此缺省、非法或被实现静默忽略的选项不会折叠成相同 runtime 行为。completed result 校验还会接收这些 sealed parameter 作为上下文：estimator 回显的区间置信度、重采样次数，以及 correction 回显的 alpha，都必须在在线执行和 Bundle 重验时与 plan 一致。区间的 `unitCount` 由 Core 根据 included row 和 sealed resampling unit 独立推导；paired block 只有同时纳入声明 contrast 的两侧 target 才计数。percentile interval 不要求包含其点估计。prepare 检查循环、缺失依赖、值域不匹配和输入基数不匹配。

DecisionPolicy 的每个 comparison family member 都声明 `(comparisonId, treatmentTargetId, metricId, analysisResultId)`。该 AnalysisResult 的 producer 必须精确且仅消费这个 member 的 Metric 与 Comparison selector，不能混入 family 外输入。未校正的 singleton result 必须由 DecisionPolicy 直接消费。需要校正的 family 还要为每个 member 声明 canonical `hypothesisId`；correction node 必须精确消费全部 member 的 `analysisResultId`，DecisionPolicy 则消费唯一 correction result。超过一个 member 的 family 必须绑定 correction；空或单 member family 不能伪装成多重比较。Decision 只能收到带 result identity 和可选 hypothesis identity 的投影 contrast，不能看到所属 Comparison 中无关的 treatment 或 Metric。correction table 的 canonical hypothesis ID、family size 和 raw p-value 必须全部一致，才能产生 verdict。内建 `progress/v1` 只选择 singleton contrast 绑定的唯一 result；没有 family 时只接受唯一声明 result，输入有歧义则返回 not-decided，并且不声称支持 multiple-comparison。多 contrast 的发布语义必须由专用 DecisionPolicy 明确定义。

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
  evaluation: EvaluationRuntimePolicy;
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

为 AnalysisGraph 的每个节点保存一条 canonical 事实：completed、inconclusive、failed 或 not evaluated。每条事实绑定已解析的 RuntimeIdentity、输出 SchemaIdentity、声明的输入引用、对应 estimand 的 observation coverage、前提检查、父结果 digest、analysis mode、生成时间与 record digest。Bundle 另行记录 terminal status、graph coverage、EvaluationBundle 与 AnalysisPlan digest、provenance 和自身 digest。missing、invalid、evaluation-failed、source-unavailable、not-started 与 censored observation 保持独立计数；included 与 comparable 集合不能超过 observed evidence。

`parseAnalysisBundleDocument()` 校验独立 wire、canonical result 顺序、coverage 算术、record digest 和 Bundle digest。`parseAnalysisBundle()` 再绑定 sealed RunPlan、ExecutionBundle 与 EvaluationBundle，核对完整 graph universe、Runtime／schema identity、声明输入、parent lineage、analysis mode 与 source trust ceiling。

### 5．EvaluationReport

Report 是为人和产品消费构造的物化视图。它可以内联稳定摘要，也可以按 digest 引用 Bundle 并附带可选 retrieval URI，但不能成为重评分和审计的唯一数据源。DecisionResult 单独进行内容寻址，并绑定 DecisionPlan、policy、已解析 runtime、AnalysisBundle 与命名 AnalysisResult。Report materializer 不执行 Analysis node 或 DecisionPolicy。

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
- 单 Run 共享的 EventSequencer；
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
- 需要无损持久化时使用 EventWriter。v1 只支持 blocking backpressure；writer 与 notification delivery 按单 Run sequence 串行化，是否启用 writer 及失败策略由 sealed EventDeliveryPolicy 决定。infrastructure／internal failure 的优先级高于先发生的 cancellation 或 budget stop，因此 required writer 与 resource disposal failure 必须改变权威 Bundle 的 terminal state，包括 terminal event 投递阶段发生的失败。

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

## 十八、Evaluation Runtime v1 实现基线

[#435](https://github.com/lizhiyao/oh-my-knowledge/issues/435) 把 record-scoped 重评分实现为独立阶段。其 ports 只暴露 Evaluator、内容解析／存储、cache、clock、共享 EventSequencer 和 EventWriter，Evaluation API 无法触达 Executor。`startEvaluation(plan, executionBundle, ports, options)` 会在异步工作开始前同步校验 sealed source bundle。

Evaluation coordinate 使用 canonical `(targetId, sampleId, trialIndex, evaluatorId)` 顺序。`evaluationId`、attempt ID 和 observation ID 使用 domain-separated digest 派生。每条 active EvaluationRecord 都绑定准确的 canonical ExecutionRecord digest 和已解析的 Evaluator RuntimeIdentity。cache key 还绑定 EvaluationPlan、物化后的输入、source record 与 effective source trust，因此 Gold、Evaluator identity、binding、execution evidence 或 source trust ceiling 任一变化都不能静默复用旧评分。cache replay 必须先完整校验 record schema、retry identity、有序 metric contract、scale、source digest、runtime identity、attempt 到 record 的确定性 usage 聚合与 provider-cost eligibility；replay provenance 不得提升 source trust。

Evaluation 的 retry、timeout、concurrency、调用次数／时长／provider cost 预算统一封存在 `MeasurementPolicy.evaluation`，start-time options 不得覆盖。invocation reservation 只在进入 `evaluate()` 前一刻核销，因此 `openRun()`／`openRecord()` 失败不消耗调用额度。失败与重试调用同成功调用一样保留并计入 provider-reported usage。timeout 采用协作式取消：Core 发出 abort 后等待 evaluator promise settle，丢弃晚到结果，再进入 retry 或 record dispose。只有 evaluator record／run 资源全部正常关闭后才提交 cache。Event delivery 复用阶段中立的 sealed EventDeliveryPolicy，并使用 Execution／Evaluation 共享的单 Run EventSequencer。

缺失必须保留来源并以 binding 为判断依据。Evaluator admission 前，Core 先冻结完整 coordinate universe 的 binding closure。ExecutionRecord 缺失、被 budget-censored，或任一必要 binding 无法解析时，产生 `not-evaluated`，绝不伪造零分或默认分；failed／cancelled ExecutionRecord 若仍能物化全部声明输入，例如只依赖 trace，则仍可进入评测。reference content 的 descriptor 会与 value digest、classification 一起封存 media type：Resolver 只负责提供 value，不能改写这部分 identity；ContentStore 返回的 descriptor 也必须保留请求中的 media type。Evaluator 省略 metric 时生成显式 missing observation；未知／重复 metric 属于 Evaluator failure；value type 不匹配和数值越界产生 invalid observation，不做 coercion 或 clamp。Evaluator 只能看到自己声明的 sealed MetricDefinition。Observation metadata 属于分类内容，与 evidence 使用相同的 capture policy 和 classification ceiling。Evaluator 只能产生 sample-scoped metric，聚合仍由 AnalysisGraph 负责。

`parseEvaluationBundleDocument()` 校验独立 wire shape、状态转换、identity、coverage、replayability 和 digest。`parseEvaluationBundle()` 再绑定 sealed RunPlan 与已验证的 ExecutionBundle，并检查全部可由 artifact 结构判定的不变量；缺少外部 runtime evidence 时，durable Bundle 仍保持有效。`verifyEvaluationBundle()` 另行返回 `planVerification`：已知 native invocation 给出下界，未验证的 cache claim 给出上界；当 Bundle JSON 本身无法证明 lookup 时，cache receipt 或调用预算状态标记为 `indeterminate`，而不是把 Bundle 判为 invalid。调用方传入从可信 cache 边界独立取得的 `verifiedCacheRecordDigests` 后才能闭合该证明；Evaluation Runtime 返回自身 Bundle 前要求两项状态均为 `verified`。仅从 hit 重建 claimed native miss 永远不构成 receipt。Coverage 满足 `planned = eligible + sourceUnavailable`、`eligible = started + notStarted` 和 `started = completed + failed + cancelled`。

## 十九、Analysis 与 Decision Runtime v1 实现基线

[#437](https://github.com/lizhiyao/oh-my-knowledge/issues/437) 把 Analysis 与 Decision 实现为彼此分离、可以重算的阶段。AnalysisPlan 封存 Metric contract、包含 trial count 与 root seed 的完整 ExperimentDesign、Comparison、AnalysisGraph、MissingPolicy identity、Analysis Runtime identity 与输出 schema。DecisionPlan 单独封存 DecisionPolicy 及其已解析的 RuntimeIdentity。Comparison 变化会使 Analysis 及下游 identity 失效；仅 policy 变化只使 Decision 与 root contract 失效。

Analysis 在完整 planned metric-coordinate universe 上物化不可变 typed relation。每行保留 Target、sample、trial、Evaluator、Metric、sampling-unit identity、censoring 与 source status。observed、missing、invalid、evaluation-failed、source-unavailable 和 not-started 保持不同事实；v1 只有 observed row 可以进入统计。节点按稳定拓扑顺序执行，只能收到声明的 Metric、上游 result 或精确 Comparison contrast 输入。result identity、RuntimeIdentity、schema、coverage、lineage、mode 与 digest 由 Core 分配，不能由实现自报。Runtime 输出以完整 `{ resultType, value }` envelope 同时经过 wire result contract，以及由完整 sealed SchemaIdentity 从独立注入 registry 选择的 Core-owned validator 校验；Analysis 实现不能校验自己的输出。JSON Schema 无法表达的语义不变量，包括 Bonferroni 算术与 canonical family membership，也必须进入 validator 和 schema digest。

内建 registry 提供三个 descriptive reducer、三个确定性的 percentile-bootstrap estimator、Bonferroni correction、显式 exclusion MissingPolicy 与最小 progress DecisionPolicy。每个内建 reducer／estimator 都封存恰好一个 Metric 输入。Bootstrap draw 从 sealed root seed、AnalysisPlan digest、node identity 与 replicate index 做 domain-separated 派生。重复 trial 先在声明的 sampling unit 内归约；paired contrast 先在完整 pairing block 内形成，再进行重采样；cluster bootstrap 按整簇重采样。有效单位不足或前提失败时产生 inconclusive result，绝不自动选择 fallback estimator。内建 Runtime identity 属于 self-reported，使用 `assuranceLevel: declared`；只有独立宿主 verifier 或 attestation 边界才能把实际执行代码提升为 verified assurance。

Decision 只消费 policy 命名的 AnalysisResult，以及 coverage、assumption check、evidence status 与显式封存的 comparison family。correction result 必须匹配这个精确 family，而不是全局 Comparison 数量。gate 未通过时产生稳定的 `not-decided` reason；policy 或基础设施失败与统计结论保持分离。EvaluationReport 随后物化 Bundle reference、内容寻址的 DecisionResult、provenance 与派生的 run／evidence／conclusion 三轴状态，不重算统计量或 verdict。Host annotation 属于展示元数据：它可以改变 report artifact digest，但不能改变任何 stage Plan 或 source Bundle digest。

AnalysisBundle 与 EvaluationReport 同时提供独立 document validator 和绑定 plan／source 的 validator。后者要求准确的 source Bundle chain、完整 graph／runtime／schema binding、独立 output validation、parent digest、policy digest，以及不高于最不可信 source 或实际执行 Runtime assurance 的 provenance trust。Analysis trust 纳入全部已执行 AnalysisNode 与实际使用的 MissingPolicy；存在 decision 时，report trust 还要纳入 DecisionPolicy assurance。AnalysisBundle provenance 只能有一个 parent，即已验证的 EvaluationBundle，不能夹带无关 digest。Bundle reference 的可选 URI 只负责定位内容；来源身份仍由 sealed digest 决定。

Analysis、Decision 与带事件的 Report materialization 复用同一个注入的 per-Run EventSequencer 和 sealed EventDeliveryPolicy。Event 只包含 identity、status、coverage summary 与 reason code。Bounded stream 不会反压权威计算；需要无损持久化时交给 EventWriter。所有异步终态路径都会关闭 event stream，Analysis 还会移除外部 AbortSignal listener，包括非预期的 clock、sequencer、validation 或 materialization failure。Analysis cancellation 在 node boundary 协作发生，保留已完成事实，并把全部剩余节点物化为 not evaluated。同一个 AbortSignal 会传入执行中的 Analysis 与 Decision port；signal 一旦 abort，port 后续 reject 或迟到的成功结果都不能覆盖 cancelled 终态。Node resource exactly-once dispose，Core 不访问文件、网络、环境变量、process signal 或全局 registry。

## 二十、行业参考

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
