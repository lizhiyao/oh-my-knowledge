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

两个 Bundle digest 不同不代表一定不可比较，相同也不代表实验设计有效。ComparabilityPolicy 根据 Dataset 投影、Target、Runtime、Evaluator、SamplingDesign 和 DecisionPolicy 的变化给出 compatible、conditional 或 incompatible，并解释理由。第七节冻结 v1 判定契约。

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
  analysis?: {
    memberships: readonly { cohortId: string; membershipValue?: JsonValue }[];
    context?: { value: JsonValue; classification: ContentClassification };
  };
  annotations?: JsonValue;
}
```

- Executor 只收到 `input + executionContext` 的冻结投影；
- Evaluator 可以按声明读取 output／trace／expected／evaluationContext；
- Analysis Runtime 只能通过 AnalysisPlan 读取稳定的分析 membership；
- `annotations` 只用于审计和展示，不参与执行或评分；
- 映射默认使用受限 JSON Pointer，只允许定位一个值；多值 JSONPath 属于 adapter 扩展。

Dataset 具有四个不同 digest：

| Digest | 覆盖内容 | 用途 |
|---|---|---|
| `datasetRevisionDigest` | 完整 Dataset | lineage 和审计 |
| `executionInputDigest` | `input + executionContext` | ExecutionPlan 身份 |
| `evaluationInputDigest` | 执行投影 + `expected + evaluationContext` | EvaluationPlan 身份 |
| `analysisInputDigest` | 稳定 Sample identity、分析 membership／context 与 cohort 定义 | AnalysisPlan 身份 |

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
  implementationManifest:
    | { coverageKind: 'fingerprint-complete' }
    | { coverageKind: 'fingerprint-plus-facets'; facets: Array<{
        facetId: string;
        value: JsonValue;
      }> };
  provenanceFacets?: {
    observation?: { observerId?: string; observedAt?: string };
    attestation?: { attestationDigest: Sha256Digest; attestorId?: string };
  };
}
```

调用方声明的版本或 fingerprint 只是要求，Report 记录 Runtime 实际解析出的身份。`implementationManifest.facets` 保存尚未由 `fingerprint` 承诺、且能够改变行为的事实，例如远程模型 deployment、effective tool schema、sandbox policy、依赖和环境。discriminated manifest 从结构上消除歧义 sibling state：`fingerprint-complete` 不携带 facet payload；`fingerprint-plus-facets` 必须提供非空 facet array，且 ID 唯一、canonical。`provenanceFacets` 是封闭的 evidence-only 结构，只允许 observation 与 attestation metadata，因此不能放入任意行为事实。coverage 缺失、歧义、非 canonical 或不完整时，prepare 必须拒绝。manifest 负责让分类在结构上可判定；Runtime 声明是否可信，仍由 assurance 与独立宿主验证决定。

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
  randomizationSlots: readonly {
    targetId: string;
    randomizationSlotId: string;
  }[];
}
```

trial 表示同一实验条件的一次重复测量；retry attempt 表示一次 trial 内的基础设施重试，两者不能互换。统计实现必须在 prepare 阶段验证自己支持当前 SamplingDesign，不能把重复 trial 自动视为独立样本。

配对比较以 scheduling block 为调度原子。编译器会把比较关系的连通性固化为 canonical `ExecutionPlan.schedulingTargetGroups`：有重叠的比较合并为一个 Target 连通组，未参与比较的 Target 保持单元素组。该分组纳入 `executionPlanDigest`，因此改变配对连通性会产生新的 Execution 身份。comparison label、treatment role 与 metric projection 不改变 Execution 或 Evaluation 身份，但会改变 Analysis 身份及全部下游 digest。`randomizationSlots` 为每个 Target 分配唯一、稳定的实验 slot；该 slot 只标识随机化条件，绝不编码 control／treatment role。宿主比较 successive subject implementation 时，即使 Target ID 改变，也必须保持同一个 slot。

`randomizationSlots` 按 `(randomizationSlotId, targetId)` canonical 排序，并在两个字段上分别保持一一对应。`seedCoupling` 显式决定同一 block、同一 sample 的各 Target 共享随机条件、按稳定 slot 派生独立随机条件，还是诚实声明 Target 随机性不可控；Executor 不能自行猜测。Core 使用 `omk.randomization-design/v1` domain，根据 execution-input projection、trial count、root seed、会影响执行的 SamplingDesign projection、SchedulingPolicy、sampling membership，以及只使用 `randomizationSlotId` 表达的 scheduling connectivity，封存 `randomizationDesignDigest`；其中不包含只属于 Analysis 的 `estimatorId`、原始 Target ID、Target definition、Runtime identity 或绑定 Plan 的 artifact ID。计划 admission rank 与受控 trial seed 只能根据该 digest、trial index、sample identity，以及仅在独立 coupling 下使用的稳定 slot 派生；不得依赖 `executionPlanDigest`、`schedulingBlockId`、`trialId`、Runtime fingerprint 或 Target implementation content。sample coordinate 始终进入 seed 派生，避免一个大 block 内不同 sample 意外复用 seed。预算不足时不得只启动 block 的一侧；未启动的坐标标记为 budget-censored，不伪造 attempt，也不进入主要配对估计。

ExecutionPlan 携带同一份 execution-affecting ExperimentDesign projection，因此不存在 `estimatorId`；包含 estimator identity 的完整 ExperimentDesign 从 AnalysisPlan 开始出现。只改变 estimator 时，ExecutionPlan 与 EvaluationPlan identity 保持不变，AnalysisPlan 及其全部下游 identity 失效。

`pairingBlockId`、`clusterId`、`stratumId` 分别表达统计归属，`schedulingBlockId` 只表达调度原子；它们不能复用一个含义模糊的 ID。artifact identity 继续 hash 规范化后的完整 `(targetId, sampleId)` coordinate 集和影响调度的 sampling-unit IDs，不能拆成会丢失对应关系的 Target／sample 两个集合。这些绑定 Plan 的 ID 负责 uniqueness、lineage 与 cache isolation，但不作为随机输入。随机化改用上文单独封存的 subject-neutral projection，避免有意改变 subject 时扰动其它对应 coordinate 已分配的实验条件。

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

复杂分析由有向无环的 AnalysisGraph 表达。每个节点声明输入、输出 schema、实现身份和参数；已解析 capability 会分别封存 parameter schema，以及 Metric、上游 result、Comparison 三类输入基数。Core 在计算 plan digest 前校验 parameter 并物化默认值，因此缺省、非法或被实现静默忽略的选项不会折叠成相同 runtime 行为。completed result 校验还会接收这些 sealed parameter 作为上下文：estimator 回显的区间置信度、重采样次数，以及 correction 回显的 alpha，都必须在在线执行和 Bundle 重验时与 plan 一致。区间的 `unitCount` 由 Core 根据 included row 和 sealed resampling unit 独立推导；paired block 只有同时纳入声明 contrast 的两侧 target 才计数。percentile interval 不要求包含其点估计，但端点仍须有序（`lower <= upper`）。prepare 检查循环、缺失依赖、值域不匹配和输入基数不匹配。

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

`prepareEvaluationPlan()` 是 Comparability 接受的进程内 `SealedRunPlan` capability 唯一签发入口。注册与验证该 capability 的 authority 位于 Evaluation Core internal module 命名空间，并由 package export map 阻断；Compiler 与 Core consumer 通过相对内部导入使用它，不把该 authority 暴露为包解析可达的 consumer 入口。RunPlan 字段仍可序列化为 JSON 供审计，但 clone 或 transported document 不具备比较权限；`assessComparability()` 再次消费前必须经过 Runtime resolution 重新 prepare。这样可以阻止调用方保留旧 digest 与 authenticated stage source，却替换 Target、instrument、sampling、Analysis 或 Decision projection。

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

`parseExecutionBundleDocument()` 只做不依赖外部状态的 wire、局部状态机与 digest 校验。导入或物化必须调用绑定 sealed RunPlan 的 `parseExecutionBundle()`，进一步核对 parent digests、完整 coordinate universe、trial／seed／sampling／scheduling identities、Target Runtime、retry policy、结构可判定的 cache envelope、provider-cost 事实和 paired-block 原子删失；不能信任 Bundle 自报的 block、cache status 或 coverage。`parseExecutionBundle()` 与 `verifyExecutionBundle()` 返回 `ExecutionBundleSource`，其中包含可序列化 Bundle 与独立的 `planVerification` 信封。native record provenance 不能高于实际产出它的 sealed Executor Runtime assurance，Bundle provenance 也不能高于其中最不可信的 record。native record 给出调用次数与 provider cost 下界，尚未验证的 replay claim 给出上界；若只凭 Bundle JSON 无法证明，则 provenance、cache receipt、调用预算或 provider-cost 预算状态为 `indeterminate`。只有从可信 cache 边界独立取得的 receipt 或宿主 attestation 才能闭合相应证明；从 Bundle 自身重建 digest 只能验证结构，不能认证 provenance 或 receipt。Execution Runtime 通过 `ExecutionRun.source` 暴露同一份已认证 source，`ExecutionRun.result` 仅作为可序列化 artifact 的便利入口；后续阶段必须消费 source，不能重新解析后丢弃 verification 信封。配置 provider-cost 预算时，completed Bundle 的每次 native attempt 都必须报告封存币种，且 native 调用总成本必须低于上限。

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
  randomizationDesignDigest,
  target snapshots,
  executor manifests,
  不含 estimatorId 的 execution-affecting ExperimentDesign projection,
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
  analysisInputDigest,
  analysis samples + cohort definitions,
  AnalysisGraph,
  estimator manifests
)

decisionPlanDigest = H(
  analysisPlanDigest,
  comparisons,
  DecisionPolicy
)

runContractDigest = H(all plan digests + schema identities + event delivery + optional Series membership)
```

`project`、`owner`、`tags` 等 annotations 不进入测量 digest。output／trace 的捕获方式及其 classification ceiling 会改变持久化 Execution 事实和 cache key，因此进入 ExecutionPlan 身份。完整的 v1 EvidencePolicy 同时进入 EvaluationPlan，因为 Evaluator 产生的 evidence 属于 Evaluation 事实。Dataset 的 input 和 expected 是 sealed stage input，不是 EvidencePolicy 捕获目标：`executionInputDigest` 绑定 Executor 可见的 input，`evaluationInputDigest` 进一步绑定 expected 和 evaluation context。Evaluator evidence 的捕获方式不失效 Execution。

### 1．ADR：在不变测量系统下比较显式声明的研究对象

**状态**：v1 已接受并实现，由 [#441](https://github.com/lizhiyao/oh-my-knowledge/issues/441) 跟踪。

可比性是两个候选对象针对一种明确用途的关系，不是任一 Run 自带的固有属性。v1 只支持一种刻意保守的设计模式：`exact-measurement-design`。调用方把一组一一对应的 Target 显式声明为研究对象；只有这些映射 Target 的定义及其 Executor Runtime 实现身份可以变化。观察、评分、抽样、分析这些研究对象，以及在请求时作出决策的全部测量系统保持不变。

该决策把三个绝不能压缩成同一 Boolean 的命题分开：

1. **内容身份**：canonical digest 相同，只表示对应阶段的 sealed content 相同；它不认证生产者，也不证明实验设计有效。
2. **证据资格**：Runtime assurance、provenance trust、宿主 attestation 与 source verification axes，描述所声明内容和执行得到多强的认证；它不能让两个不同测量工具变得等价。
3. **实验可比性**：只改变声明的研究对象，同时保持请求 scope 所需的测量投影不变。

Replayability 与 reproducibility 继续作为独立 artifact 属性。一次比较可以有效，却不承诺逐 byte 复现；self-contained replay 也不能修复已经改变的 Evaluator 或 sampling unit。

### 2．Policy 与 Assessment 契约

v1 wire contract 的概念结构如下：

```ts
interface ComparabilityPolicy {
  schemaVersion: 'omk.comparability-policy/v1';
  designMode: 'exact-measurement-design';
  comparisonScope: 'evaluation' | 'analysis' | 'decision';
  subjects: readonly {
    subjectId: string;
    leftTargetId: string;
    rightTargetId: string;
  }[];
  policyDigest: Sha256Digest;
}

type ComparabilitySourceVerificationFact =
  | {
      verificationFactKind: 'verification-axis';
      stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
      sourceDigest: Sha256Digest;
      verificationAxis:
        | 'provenance-attestation'
        | 'cache-receipt'
        | 'invocation-budget'
        | 'provider-cost-budget'
        | 'policy-execution';
      verificationStatus: 'verified' | 'indeterminate';
    }
  | {
      verificationFactKind: 'source-trust';
      stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
      sourceDigest: Sha256Digest;
      trustRelation: 'parent' | 'effective';
      trust: Provenance['trust'];
    };

interface RuntimeQualificationFact {
  stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
  runtimeKind:
    | 'executor'
    | 'evaluator'
    | 'analysis-node'
    | 'missing-policy'
    | 'decision-policy';
  referenceId: string;
  runtimeIdentityDigest: Sha256Digest;
  runtimeImplementationDigest: Sha256Digest;
  fingerprintBasis: RuntimeIdentity['fingerprintBasis'];
  sealedAssuranceLevel: RuntimeIdentity['assuranceLevel'];
  effectiveAssuranceLevel: RuntimeIdentity['assuranceLevel'];
  verifiedByAttestationDigest?: Sha256Digest;
}

interface ComparabilityCandidateIdentity {
  runContractDigest: Sha256Digest;
  planDigests: PlanDigests;
  randomizationDesignDigest: Sha256Digest;
  artifacts: readonly {
    stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
    artifactDigest: Sha256Digest;
  }[];
  sourceVerification: readonly ComparabilitySourceVerificationFact[];
  runtimeQualification: readonly RuntimeQualificationFact[];
  candidateDigest: Sha256Digest;
}

interface ComparabilityAssessment {
  schemaVersion: 'omk.comparability-assessment/v1';
  policyDigest: Sha256Digest;
  designMode: 'exact-measurement-design';
  comparisonScope: 'evaluation' | 'analysis' | 'decision';
  left: ComparabilityCandidateIdentity;
  right: ComparabilityCandidateIdentity;
  designStatus: 'compatible' | 'incompatible';
  evidenceQualificationStatus: 'verified' | 'conditional' | 'rejected';
  comparabilityStatus: 'compatible' | 'conditional' | 'incompatible';
  reasons: readonly ComparabilityReason[];
  assessmentDigest: Sha256Digest;
}

type ComparabilityReasonCode =
  | 'comparability-identity-declared-subject-change'
  | 'comparability-design-subject-mapping-invalid'
  | 'comparability-design-undeclared-subject-change'
  | 'comparability-design-evaluation-input-mismatch'
  | 'comparability-design-evaluation-instrument-mismatch'
  | 'comparability-design-sampling-mismatch'
  | 'comparability-design-randomization-mismatch'
  | 'comparability-design-analysis-mismatch'
  | 'comparability-design-comparison-mismatch'
  | 'comparability-design-decision-mismatch'
  | 'comparability-design-schema-mismatch'
  | 'comparability-design-projection-mismatch'
  | 'comparability-evidence-source-absent'
  | 'comparability-evidence-verification-indeterminate'
  | 'comparability-evidence-assurance-unverified'
  | 'comparability-evidence-source-untrusted'
  | 'comparability-evidence-runtime-identity-opaque';

interface ComparabilityReason {
  reasonCode: ComparabilityReasonCode;
  axis: 'design' | 'evidence' | 'identity';
  severity: 'info' | 'conditional' | 'incompatible';
  scope: 'evaluation' | 'analysis' | 'decision';
}

interface ComparabilityVerificationContext {
  /** 由独立宿主 verifier 产生，绝不能从 Assessment JSON 重建。 */
  verifiedRuntimeAttestations?: ReadonlyMap<Sha256Digest, {
    attestationDigest: Sha256Digest;
    verifiedAssuranceLevel: 'verified';
  }>;
}

interface ComparabilityAssessmentPlanVerification {
  assessmentComputationStatus: 'verified';
  policyDigest: Sha256Digest;
  leftCandidateDigest: Sha256Digest;
  rightCandidateDigest: Sha256Digest;
}

interface ComparabilityAssessmentSource {
  assessment: ComparabilityAssessment;
  planVerification: ComparabilityAssessmentPlanVerification;
}
```

`ComparabilityCandidateIdentity` 为审计记录全部 stage Plan digest、subject-neutral `randomizationDesignDigest`、已提供的 source Bundle 或 Decision digest，以及本次判断实际使用的规范化 verification facts。`ComparabilitySourceVerificationFact` 使用 discriminated union，因此 cache receipt 不能填写 provenance trust，parent trust fact 也不能填写 `indeterminate`。缺少 artifact 时，通过 Assessment 中不存在对应条目并附带 reason 表达，绝不伪造 digest 或自报 verified fact。该 identity 不复制原始 Dataset、Gold、output、trace、attestation material、cost value 或 invocation count。

Runtime 比较使用两个分别计算 digest 的投影。`runtimeIdentityDigest` 使用 `omk.runtime-identity/v1` domain 并覆盖完整 sealed RuntimeIdentity；`runtimeImplementationDigest` 使用 `omk.runtime-implementation-identity/v1` domain，且只覆盖 `implementationId`、`version`、`fingerprint`、`capabilities` 与完整 `implementationManifest`，只有该 digest 参与 design equality。Evidence qualification 包含 `fingerprintBasis`、sealed／effective assurance、封闭的 `provenanceFacets`、effective source trust 与 source verification axes。implementation manifest 必须在结构上证明每个行为相关依赖已经由 `fingerprint` 承诺，或作为 canonical implementation facet 存在；provenance 只能包含 observation 与 attestation metadata。这样，只改变 basis 或 assurance 不会伪装成测量算法改变，effective dependency 变化不能藏进 evidence metadata，implementation digest 相同也不会伪装成执行已认证。

`ComparabilityVerificationContext` 是不可序列化的 trusted-host 输入，与现有 Bundle verification context 平行。Map key 是完整 `runtimeIdentityDigest`，value 是已经由独立宿主边界验证过的 attestation material digest。Core 绝不把 raw attestation material、transported `verifiedByAttestationDigest` 或调用方自填的 effective level 当作证明。只有 context 精确匹配 Runtime identity 时，effective assurance 才能高于 sealed level；Core 随后把 verified attestation digest 记录到 candidate。畸形 context entry 会被拒绝；与本次 Runtime identity 无关的 entry 不授予任何信任，直接忽略。新增 attestation 会产生新的 candidate／Assessment digest，不能修改旧 artifact。

Comparability 与其它 durable stage 使用同一套 document／source 分层：

- `parseComparabilityAssessmentDocument()` 只校验 wire shape、canonical ordering、局部不变量和排除自身字段后的 digest；它只返回 document，绝不返回 authenticated source；
- `assessComparability()` 消费 Policy、两个 sealed RunPlan、两侧可用的准确 authenticated stage-source prefix，以及可选 trusted verification context，返回 branded `ComparabilityAssessmentSource`；
- `parseComparabilityAssessment()` 消费 transported document 及同一组 Plan、source、Policy 与 verification context，完整重算预期 Assessment，只有完全相等时才返回 branded source。

`evaluation` 所需 source prefix 是 Execution+Evaluation，`analysis` 再加 Analysis，`decision` 再加 Decision。plan-only diagnosis 可以提供更短但必须准确的 prefix，并产生显式 conditional reason；存在空洞、foreign parent、stale stage 或 unbranded source 时，在比较前直接拒绝。`ComparabilityAssessmentSource` 与现有 Bundle source 一样，是受保护的不可序列化 capability。自动发布消费者必须同时要求该 source 与 `comparabilityStatus: 'compatible'`；transported Assessment 即使自报 `verified` 也没有权限。宿主可以签名证明 document transport，但 v1 不允许签名绕过 plan／source-aware 重算。

Policy 不可变、canonical 且内容寻址。它作为参数传给 Core 的纯操作，不进入 `MeasurementPolicy` 或任一 RunPlan：比较历史 Run 不会改变它们原本的生产方式。Policy、candidate 与 Assessment 计算 digest 时均排除自身 digest 字段。Assessment 绑定两个 candidate digest 与 Policy digest，并重复 Policy 的 `designMode` 与 `comparisonScope`，避免 standalone reader 把 Analysis comparability 误当成 Decision comparability；plan-aware validation 要求它们完全一致。Assessment 不包含 clock time、本地化 message、宿主路径或无序 reason 集合；展示 adapter 再把稳定 reason code 映射为人类文案。

Policy 与 Assessment 发布各自独立的 JSON Schema，但这些事后比较 schema 刻意不进入每份 RunPlan 的 `schemaIdentities`。新增或修改比较机制不能反向扰动被比较测量本身的 identity；只有生产 Run 时实际消费的 schema 才进入 `runContractDigest`。

Subject mapping 必须非空，`subjectId` 必须唯一，左右两侧分别一一对应，并引用对应 sealed Plan 中真实存在的 Target。在比较 connectivity、Comparison reference 或其它以 Target 为 key 的结构前，Core 先把每个 Target alpha-rename 为带 tag 的 canonical reference：mapped Target 变为 `{ targetReferenceKind: 'subject', referenceId: subjectId }`，未映射 Target 变为 `{ targetReferenceKind: 'literal-target', referenceId: targetId }`。tag 属于 canonical identity，因此即使 `subjectId` 与无关的 literal Target ID 相同，也不会折叠成同一节点。每一侧在投影后仍须保持一一对应；重复的 tagged reference 属于非法。描述性的 `targetKind` 没有特殊语义。未声明的 Target 新增、删除、重映射、定义变化或 Executor 实现变化都属于测量系统漂移，结果为 incompatible。已声明的 subject change 会记录为 informational reason，而不是从审计轨迹中抹除。

全部数组在 hashing 前使用以下 total order；document parser 遇到非 canonical input 时直接拒绝，不能静默重排：

- string 严格按 RFC 8785／JCS property-name sorting 的未转义 UTF-16 code unit 做 lexicographic comparison；缺失 optional value 排在 present value 前；
- stage 顺序是 `execution < evaluation < analysis < decision`；
- Runtime kind 顺序是 `executor < evaluator < analysis-node < missing-policy < decision-policy`；
- source fact 先按 stage，再按 `verification-axis < source-trust`；verification axis 顺序是 `provenance-attestation < cache-receipt < invocation-budget < provider-cost-budget < policy-execution`，trust relation 顺序是 `parent < effective`，最后比较 source digest；
- tagged Target reference 先按 `targetReferenceKind` 的 `subject < literal-target` 排序，再按 `referenceId` 排序；subject 按 `(subjectId, leftTargetId, rightTargetId)` 排序，artifact 按 `(stage, artifactDigest)` 排序，Runtime qualification 按 `(stage, runtimeKind, referenceId, runtimeIdentityDigest)` 排序；
- reason 先按 severity `incompatible < conditional < info`、axis `design < evidence < identity`、scope `evaluation < analysis < decision` 排序，最后按 `reasonCode` 排序。

Uniqueness key 分别是 `subjectId`、左右两侧各自的 Target ID、每侧 tagged Target reference、artifact stage、source fact 的 `(stage, sourceDigest, verificationFactKind, verificationAxis/trustRelation)`、Runtime qualification 的 `(stage, runtimeKind, referenceId)`，以及 reason 的 `reasonCode`。即使其它 value 不同，semantic key 重复仍属于非法。每个 reason code 只有一个 normative `(axis, severity)` 组合，`scope` 必须等于 Assessment scope：identity-change code 映射到 `(identity, info)`；全部 `comparability-design-*` code 映射到 `(design, incompatible)`；`comparability-evidence-source-untrusted` 映射到 `(evidence, incompatible)`；其它 `comparability-evidence-*` code 映射到 `(evidence, conditional)`。同一类别无论由多少 component-level difference 触发，对应 code 最多输出一次。Canonical component diff、path 和 per-component digest pair 是根据两份 authenticated Plan 重新计算的 diagnostic view，不进入 content-addressed Assessment。跨语言和宿主的 `policyDigest`、`candidateDigest` 与 `assessmentDigest` 由这些规则决定，不能依赖实现遍历顺序或 diff 粒度。

### 3．Scope 投影

比较引擎不会根据 root 或下游 digest 是否相同来猜测等价关系。只要研究对象发生预期变化，`executionPlanDigest` 及全部下游 digest 必然失效，因此引擎必须比较 canonical component projection。

| 请求 scope | 必须不变的测量投影 | 允许有意变化的投影 |
| --- | --- | --- |
| `evaluation` | Execution 与 Evaluation Dataset 投影；sample identity 与顺序；scheduling group；包含 trial、root seed、seed coupling、randomization slot、pairing、stratum、cluster 与 resampling unit 的完整 ExperimentDesign；`randomizationDesignDigest`；execution／retry／budget／cache／failure policy；Evaluator 与 Metric 定义；Evaluator implementation identity；evaluation policy 与 evidence capture | 仅限已声明的 Target 定义及其绑定 Executor implementation identity |
| `analysis` | `evaluation` 的全部内容，加上 Comparison 定义与 family、AnalysisGraph、MissingPolicy 与 Analysis Runtime implementation identity、output schema identity 和 estimator parameter | 仅限已声明的 Target 定义及其绑定 Executor implementation identity |
| `decision` | `analysis` 的全部内容，加上 DecisionPolicy 定义与 Decision Runtime implementation identity | 仅限已声明的 Target 定义及其绑定 Executor implementation identity |

请求 scope 以外的字段不会污染有效的上游比较。例如，只改变 DecisionPolicy 时，`analysis` scope 为 compatible，`decision` scope 为 incompatible。反过来，Gold、evaluation context、Evaluator、Metric、evidence binding、trial count、seed coupling、randomization slot 或 digest、pairing、cluster、stratum、resampling unit 或 estimator 发生变化时，所有消费该字段的 scope 均为 incompatible。受控随机比较只有在 subject-neutral planned admission rank 和对应 trial seed 相同时才属于 exact；随机 subject 使用 `uncontrolled` 时不满足 `exact-measurement-design`，经过验证的 deterministic subject 因不存在 Target randomness 可以不携带 trial seed。v1 不会猜测两种不同 instrument、scale、random condition、sampling design 或 statistical model 是否「足够接近」。未来若要支持 calibration、bridge study、uncontrolled 或 independently randomized cross-Run design、Dataset overlap 或 schema migration，必须新增显式 design mode，并声明对应的 construct-specific assumption。

JSON property order 与排除在测量 identity 外的 annotation 不会产生 incompatibility。Schema identity 变化会在第一个消费该 schema 的 scope 变为 incompatible。Extension data 遵循 compiler 声明的 impact stage：`audit` extension 被忽略，测量阶段 extension 则进入对应 projection。

### 4．Status 推导与 fail-closed 规则

只有全部 invariant projection 相同且所有 subject mapping 有效时，`designStatus` 才是 `compatible`。任一处不匹配都会使其成为 `incompatible`；全部适用 mismatch category 各输出一次并按确定顺序排列，diagnostic view 仍可枚举每个 changed component。

`evidenceQualificationStatus` 与 EvaluationReport 表达完整性的 `evidenceStatus` 不同。只有请求 scope 所需的 source chain 得到独立认证、所有适用 verification axis 都是 `verified`，且实际使用的每个 Runtime 在应用独立宿主验证后都具有 verified effective assurance 时，它才是 `verified`。Plan-only preflight、缺少必要 source、`indeterminate` verification、unknown／declared effective provenance，或 declared／unknown effective Runtime assurance 都会产生带明确 reason code 的 `conditional`。invariant Runtime 使用 `fingerprintBasis: 'opaque'` 也会产生 condition，因为相等值无法说明究竟固定了哪份实现。effective source trust 为 `untrusted` 时，结果为 `rejected`：这是负面事实，不是尚未闭合的条件。Plan、artifact、parent chain 结构非法、digest 伪造或 verification context 畸形时，应先由各自 validator 拒绝；ComparabilityPolicy 不是另一条 artifact admission 旁路。

Overall status 只能由 Core 推导，宿主不能自行填写：

```text
if designStatus == incompatible                                  => incompatible
else if evidenceQualificationStatus == rejected                  => incompatible
else if evidenceQualificationStatus == conditional               => conditional
else                                                              => compatible
```

因此，`conditional` 的唯一含义是「实验设计匹配，但列出的认证条件尚未闭合」，绝不表示「设计大概相似」或「来源已经确认不可信」。`rejected` 会保留这项负面 evidence fact，独立的 `designStatus` 继续说明设计本身是否匹配。conditional 与 rejected evidence 都不能授权方向性发布决策。现有 Decision 与 Report evidence gate 继续对 indeterminate 或 untrusted source fail closed。

以下初始变化矩阵是 normative。除显式标记 `conditional` 的行外，结果均假定其它证据已经 verified。「忽略」表示字段位于请求 scope 之外，不表示它未进入任一 Run 的 identity。

| 变化 | `evaluation` | `analysis` | `decision` | 稳定 reason code |
| --- | --- | --- | --- | --- |
| 只改变 annotation 或 JSON property order | compatible | compatible | compatible | 无 |
| Gold 或 evaluation context | incompatible | incompatible | incompatible | `comparability-design-evaluation-input-mismatch` |
| Evaluator、Metric 或 evaluation evidence policy | incompatible | incompatible | incompatible | `comparability-design-evaluation-instrument-mismatch` |
| 已声明 subject 的 Target 定义或绑定 Executor 实现 | compatible | compatible | compatible | `comparability-identity-declared-subject-change` |
| 未声明的 Target 或 Executor 实现 | incompatible | incompatible | incompatible | `comparability-design-undeclared-subject-change` |
| trial count、root seed、seed coupling、randomization slot、pairing、cluster、stratum、resampling unit 或 scheduling connectivity | incompatible | incompatible | incompatible | `comparability-design-sampling-mismatch` |
| subject-neutral randomization digest／planned rank／受控 coordinate seed 不同，或随机 subject 使用 uncontrolled | incompatible | incompatible | incompatible | `comparability-design-randomization-mismatch` |
| AnalysisGraph 或 estimator | 忽略 | incompatible | incompatible | `comparability-design-analysis-mismatch` |
| Comparison 定义或 family | 忽略 | incompatible | incompatible | `comparability-design-comparison-mismatch` |
| DecisionPolicy 或 Decision Runtime 实现 | 忽略 | 忽略 | incompatible | `comparability-design-decision-mismatch` |
| 被消费的 schema 或测量阶段 extension | 从第一个消费 scope 起 incompatible | incompatible | incompatible | `comparability-design-schema-mismatch` |
| 只比较 Plan，或缺少必要 source | conditional | conditional | conditional | `comparability-evidence-source-absent` |
| transported source verification 为 `indeterminate` | conditional | conditional | conditional | `comparability-evidence-verification-indeterminate` |
| effective provenance 为 unknown／declared，或 Runtime assurance 未 verified | conditional | conditional | conditional | `comparability-evidence-assurance-unverified` |
| effective source trust 为 `untrusted` | incompatible（`evidenceQualificationStatus: rejected`） | incompatible（`evidenceQualificationStatus: rejected`） | incompatible（`evidenceQualificationStatus: rejected`） | `comparability-evidence-source-untrusted` |
| invariant Runtime 使用 opaque fingerprint | conditional | conditional | conditional | `comparability-evidence-runtime-identity-opaque` |

无效 subject mapping 使用 `comparability-design-subject-mapping-invalid`；其它没有更具体 code 的 invariant component 使用 `comparability-design-projection-mismatch`。Stage／artifact digest 相同还是不同会记录在 candidate identity 中，不作为 verdict reason。Reason code 按类别唯一；需要 field-level explanation 的 adapter 根据 authenticated Plan 重算不具权威性的 diagnostic diff。自动发布消费者遇到未知 reason code 时必须 fail closed；reader 仍可保留并展示它。

### 5．影响与否决方案

该设计允许把新的 prompt、RAG 配置、skill、agent、workflow、model 或 service implementation 作为独立变量，而不削弱测量工具；也允许只改变后续 DecisionPolicy 时，Analysis result 继续保持可比。代价是刻意的严格：在某类假设被表达为带版本的 design mode 前，v1 会拒绝可能在特定条件下成立的比较。

以下方案被否决：

- **只比较 `runContractDigest`**：会拒绝每次预期 subject change，并混淆全部下游失效；
- **把 stage digest 相同当作充分条件**：它只证明 content identity，忽略 provenance、subject declaration 与 construct validity；
- **交给 CLI、Studio 或宿主临时判断**：会形成互不一致的发布门禁和无法审计的历史结果；
- **用 `conditional` 容纳任意 design drift**：会把精确状态变成 waiver 机制，使自动决策失去安全性；
- **把 ComparabilityPolicy 放入每个 RunPlan**：会因为一个事后关系改变 Run identity，也使同一 immutable Run 无法参与多种声明比较。
- **根据绑定 Plan 的 artifact ID 派生 seed 或 admission rank**：会让预期的 subject change 扰动 random condition，因此 identity 与 randomization 使用不同 domain；
- **把 Target alpha-rename 为不带 tag 的 string**：会允许 subject alias 与未映射 Target 碰撞，因此 canonical reference 使用带 tag 的 namespace；
- **把 `fingerprintBasis` 或 diagnostic diff detail 放入 design identity**：会混淆 evidence／presentation 与行为；行为相关 facet 进入 implementation identity，reason identity 只保留类别。

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

Execution cache 与 evidence storage 都是注入端口，不是 Core 内建文件服务。`replay-only` miss 和损坏的 cache entry 均 fail closed；transparent hit 只能使用 prepare 已封存的 deterministic、verified identity。任一 cached record 成为 replay fact 前，接纳层会重验 coordinate／runtime identity、native provenance、原始 miss receipt、output／trace capture mode、classification ceiling、完整 attempt／retry chain、从 attempt 推导的 usage 与 provider-cost eligibility。durable validation 执行相同的 sealed cache envelope 与 cost 规则，但只有独立可信 cache 边界提供 receipt 时才标记为 verified；transport 后的自报 claim 保持 `indeterminate`。native invocation cost 按当前 Bundle 聚合；replay 的历史 cost 只证明 cache eligibility，不计入当前运行消费。cache write 推迟到 resource teardown 成功、且 commit 时尚未出现 execution、cancellation 或 budget terminal 之后；只有 cost audit、evidence materialization 和 trial teardown 全部成功的 record 才 eligible。随后发生的 terminal-event delivery failure 不会追溯作废已经提交的 Target fact。full、reference、digest-only 与省略四种 capture 都服从 classification ceiling；reference 写入 Bundle 前必须核对 ContentStore descriptor digest。宿主原始异常文本不会复制进事件或 Bundle。

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

EvidencePolicy v1 分别控制 Executor output、execution trace 和 Evaluator 产生的 evidence 的 full／reference／digest／none 捕获方式。Dataset 的 input 和 expected 是 sealed plan input，不是 capture envelope。

### 十一．一 ADR：v1 EvidencePolicy 不承载 Dataset input

**状态**：v1 已接受，由 [#441](https://github.com/lizhiyao/oh-my-knowledge/issues/441) 跟踪。

EvidencePolicy v1 不暴露 `input` 或 `expected` 捕获方式。早期草案包含这两个字段，但改变它们只会改变 EvaluationPlan identity：Runtime 不捕获对应 artifact，Bundle 不记录该选择，durable import 也无法重验。v1 因此把这些字段作为未知字段拒绝，不保留 alias、deprecated path 或无行为的兼容逻辑。

Dataset input 继续由 `executionInputDigest` 绑定；expected 和 evaluation context 继续由 `evaluationInputDigest` 绑定。sealed EvaluationPlan 向 Evaluator 提供其声明的 binding，同时 Gold 不进入 Executor context 和 execution artifact。这样既保持测量身份与 Gold 隔离，也不会把 plan 内的数据伪装成持久化 evidence capture。

未来若要为 Dataset 内容提供 full／reference／digest／none policy，需要单独设计内容寻址 artifact model，并避免按 trial 和 Evaluator 重复放大数据。该模型必须定义 ContentStore／ContentResolver 授权、digest 与 media type 校验、classification 与 redaction、replayability 与 evidence status 后果，以及 durable import 重验。Dataset／Gold 的持久化与展示因此留给显式 artifact 或 host policy；若要增加这项能力，必须发布新的 wire schema revision，不能静默恢复 v1 字段。

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

ExecutionBundle 以 `runContractDigest` 和 `datasetRevisionDigest` 记录产出它的 RunPlan，作为
来源血缘。重评分时，另一个 RunPlan 只按 `executionPlanDigest` 与 `executionInputDigest`
接纳该 Bundle，不要求仅描述来源的 digest 相同。这个阶段化接纳规则保证 Gold 或 Evaluator
变化时可以复用执行结果，而不再次调用 Target。provenance 仍必须绑定所记录的来源 contract，
因此放宽接纳并不允许静默改写来源声明。

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

Catalog 当前在 `schemas/evaluation-core/v1/` 发布十四个 JSON Schema 2020-12 根契约：EvaluationDefinition、MeasurementPolicy、四个阶段 Plan 与 RunPlan、ComparabilityPolicy、ComparabilityAssessment、Event、三个 Bundle、EvaluationReport。TypeScript 类型从同一组 Zod 4 schema 推导。`yarn build:schemas` 重新生成文件；`yarn build` 检查已提交产物是否漂移，并把它们复制到 package build。

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

Evaluation coordinate 使用 canonical `(targetId, sampleId, trialIndex, evaluatorId)` 顺序，并绑定 Evaluator 显式的 instrument、ensemble-member、replicate-group 与 replicate-index identity。`evaluationId`、attempt ID 和 observation ID 使用 domain-separated digest 派生。每条 active EvaluationRecord 都绑定准确的 canonical ExecutionRecord digest、评委测量坐标和已解析的 Evaluator RuntimeIdentity。cache key 还绑定 EvaluationPlan、物化后的输入、source record 与 effective source trust，因此 Gold、Evaluator identity、binding、execution evidence 或 source trust ceiling 任一变化都不能静默复用旧评分。cache replay 必须先完整校验 record schema、retry identity、有序 metric contract、scale、source digest、runtime identity、attempt 到 record 的确定性 usage 聚合与 provider-cost eligibility；replay provenance 不得提升 source trust。

Evaluation 的 retry、timeout、concurrency、调用次数／时长／provider cost 预算统一封存在 `MeasurementPolicy.evaluation`，start-time options 不得覆盖。invocation reservation 只在进入 `evaluate()` 前一刻核销，因此 `openRun()`／`openRecord()` 失败不消耗调用额度。失败与重试调用同成功调用一样保留并计入 provider-reported usage。timeout 采用协作式取消：Core 发出 abort 后等待 evaluator promise settle，丢弃晚到结果，再进入 retry 或 record dispose。只有 evaluator record／run 资源全部正常关闭后才提交 cache。Event delivery 复用阶段中立的 sealed EventDeliveryPolicy，并使用 Execution／Evaluation 共享的单 Run EventSequencer。

缺失必须保留来源并以 binding 为判断依据。Evaluator admission 前，Core 先冻结完整 coordinate universe 的 binding closure。ExecutionRecord 缺失、被 budget-censored，或任一必要 binding 无法解析时，产生 `not-evaluated`，绝不伪造零分或默认分；failed／cancelled ExecutionRecord 若仍能物化全部声明输入，例如只依赖 trace，则仍可进入评测。reference content 的 descriptor 会与 value digest、classification 一起封存 media type：Resolver 只负责提供 value，不能改写这部分 identity；ContentStore 返回的 descriptor 也必须保留请求中的 media type。Evaluator 省略 metric 时生成显式 missing observation；未知／重复 metric 属于 Evaluator failure；value type 不匹配和数值越界产生 invalid observation，不做 coercion 或 clamp。Evaluator 只能看到自己声明的 sealed MetricDefinition。Observation metadata 属于分类内容，与 evidence 使用相同的 capture policy 和 classification ceiling。Evaluator 只能产生 sample-scoped metric，聚合仍由 AnalysisGraph 负责。

`parseEvaluationBundleDocument()` 校验独立 wire shape、状态转换、identity、coverage、replayability 和 digest。`parseEvaluationBundle()` 再绑定 sealed RunPlan 与已认证的 `ExecutionBundleSource`，检查全部可由 artifact 结构判定的不变量，并返回 `EvaluationBundleSource`；缺少外部 runtime evidence 时，durable Bundle 仍保持有效，但 verification 保持 `indeterminate`。接纳按阶段发生：Execution source 必须匹配当前 ExecutionPlan，EvaluationBundle 必须匹配当前 EvaluationPlan 与准确的直接父 ExecutionBundle；其持久化 `runContractDigest` 保留已认证的来源血缘，不要求等于后续阶段单独变化后形成的新 root contract。已知 native invocation 与 provider cost 给出下界，未验证的 cache claim 给出上界；当 Bundle JSON 本身无法证明时，provenance、cache receipt、调用预算或 provider-cost 预算状态标记为 `indeterminate`，而不是把 Bundle 判为 invalid。配置 provider-cost 预算时，completed Bundle 的每次 native evaluator attempt 都必须报告封存币种，且 native 调用总成本必须低于上限。Evaluation Runtime 通过 `EvaluationRun.source` 暴露独立观测到的证据，并根据已认证 source 的有效 trust 派生下游 provenance。仅从 artifact 自身重建 claimed native miss 或 provenance digest 永远不构成 receipt 或 attestation。Analysis 仍可用于诊断，但任一 source 存在 `indeterminate` 验证轴时，Decision 必须产生稳定的 `not-decided` reason；Report validator 也会拒绝绕过该门禁的方向性 DecisionResult。Coverage 满足 `planned = eligible + sourceUnavailable`、`eligible = started + notStarted` 和 `started = completed + failed + cancelled`。

## 十九、Analysis 与 Decision Runtime v1 实现基线

[#437](https://github.com/lizhiyao/oh-my-knowledge/issues/437) 把 Analysis 与 Decision 实现为彼此分离、可以重算的阶段。ExecutionPlan 只封存 execution-affecting ExperimentDesign projection；AnalysisPlan 封存 Metric contract、包含 estimator identity、trial count 与 root seed 的完整 ExperimentDesign、Comparison、AnalysisGraph、MissingPolicy identity、Analysis Runtime identity 与输出 schema。DecisionPlan 单独封存 DecisionPolicy 及其已解析的 RuntimeIdentity。Comparison 或 estimator 变化会使 Analysis 及下游 identity 失效，但不失效 Execution 或 Evaluation；仅 policy 变化只使 Decision 与 root contract 失效。

Analysis 在完整 planned metric-coordinate universe 上物化不可变 typed relation。每行保留 Target、sample、trial、Evaluator、Metric、sampling-unit identity、censoring 与 source status。observed、missing、invalid、evaluation-failed、source-unavailable 和 not-started 保持不同事实；v1 只有 observed row 可以进入统计。节点按稳定拓扑顺序执行，只能收到声明的 Metric、上游 result 或精确 Comparison contrast 输入。result identity、RuntimeIdentity、schema、coverage、lineage、mode 与 digest 由 Core 分配，不能由实现自报。Runtime 输出以完整 `{ resultType, value }` envelope 同时经过 wire result contract，以及由完整 sealed SchemaIdentity 从独立注入 registry 选择的 Core-owned validator 校验；Analysis 实现不能校验自己的输出。JSON Schema 无法表达的语义不变量，包括 Bonferroni 算术与 canonical family membership，也必须进入 validator 和 schema digest。

内建 registry 提供三个 descriptive reducer、三个确定性的 percentile-bootstrap estimator、Bonferroni correction、显式 exclusion MissingPolicy 与最小 progress DecisionPolicy。每个内建 reducer／estimator 都封存恰好一个 Metric 输入。Bootstrap draw 从 sealed root seed、AnalysisPlan digest、node identity 与 replicate index 做 domain-separated 派生。重复 trial 先在声明的 sampling unit 内归约；paired contrast 先在完整 pairing block 内形成，再进行重采样；cluster bootstrap 按整簇重采样。有效单位不足或前提失败时产生 inconclusive result，绝不自动选择 fallback estimator。内建 Runtime identity 属于 self-reported，使用 `assuranceLevel: declared`；只有独立宿主 verifier 或 attestation 边界才能把实际执行代码提升为 verified assurance。

Decision 只消费 policy 命名的 AnalysisResult，以及 coverage、assumption check、evidence status 与显式封存的 comparison family。correction result 必须匹配这个精确 family，而不是全局 Comparison 数量。gate 未通过时产生稳定的 `not-decided` reason；policy 或基础设施失败与统计结论保持分离。EvaluationReport 随后物化 Bundle reference、内容寻址的 DecisionResult、provenance 与派生的 run／evidence／conclusion 三轴状态，不重算统计量或 verdict。Host annotation 属于展示元数据：它可以改变 report artifact digest，但不能改变任何 stage Plan 或 source Bundle digest。

AnalysisBundle、DecisionResult 与 EvaluationReport 同时提供独立 document validator 和绑定 plan／source 的 validator。Runtime 与经验证的导入会为 Execution、Evaluation、Analysis 和 Decision 返回已认证 source envelope；每个 envelope 保留不可序列化的 verification evidence，并绑定直接父 artifact digest。下游阶段既要求这条准确 source chain，也递归要求每个被消费阶段匹配当前 Plan identity，因此不能拼接来自不同 Run、但各自结构合法的 artifact，旧阶段也不能越过已经变化的阶段边界。仅下游 Plan 变化时，只要上游自己的阶段 Plan 与直接父来源未变，仍可复用 durable envelope。各阶段 Bundle 的 `runContractDigest` 记录其生产时的 root；只有最终 EvaluationReport 必须绑定当前 RunContract root。传输后的 JSON 在 producer 或 host verifier 独立 attestation 其 digest 前一律保持 `indeterminate`；重建 digest 不能认证 provenance 或 policy execution。

每个 child envelope 会把已认证直接父来源的 effective trust 与自身 provenance attestation 分开记录。因此，真实历史 artifact 在现场验证材料缺失时仍可保持结构合法，但 effective trust 会被封顶，而不是被误判为 invalid。只对 Evaluation、Analysis 或 Decision 子产物做 attestation，不能抬高未认证父来源的 trust。Decision effective trust 同时受 Analysis source trust、DecisionPolicy Runtime assurance 与 policy-execution attestation 限制；即使结果是非方向性的 `not-decided`，Report trust 也必须纳入这条有效 Decision trust。validator 还要求完整 graph／runtime／schema binding、独立 output validation、policy identity，以及不高于最不可信 source 或实际执行 Runtime assurance 的 provenance trust。每条 AnalysisRecord 都以 canonical `runtimeDependencies` 封存实际调用过的 AnalysisNode 与 MissingPolicy；Core 在进入 port 前先记录 dependency，因此 failure／cancellation 不能擦除使用事实。独立 validator 会把这些事实绑定进 record／Bundle digest，绑定 Plan 的 validator 还会拒绝未封存、不可达、非 canonical 或结构上遗漏的 dependency。Analysis trust 只取已认证 source trust 与这些实际 Runtime dependency 的最低值，Plan 中存在但未使用的 Runtime 既不能降低也不能抬高结果。结构化 Analysis port failure 只保留校验后的 code／stage，provider message 会统一脱敏；畸形 failure 会被封装为 infrastructure error。AnalysisBundle provenance 只能有一个 parent，即已验证的 EvaluationBundle，不能夹带无关 digest。Bundle reference 的可选 URI 只负责定位内容；来源身份仍由 sealed digest 决定。

Execution、Evaluation、Analysis、Decision 与带事件的 Report materialization 复用同一个注入的 per-Run EventSequencer 和 sealed EventDeliveryPolicy。Event 只包含 identity、status、coverage summary 与 reason code。Bounded stream 不会反压权威计算；需要无损持久化时交给 EventWriter。所有异步终态路径都会关闭 event stream，Analysis 还会移除外部 AbortSignal listener，包括非预期的 clock、sequencer、validation 或 materialization failure。Analysis cancellation 在 node boundary 协作发生，保留已完成事实，并把全部剩余节点物化为 not evaluated。同一个 AbortSignal 会传入执行中的 Analysis 与 Decision port；signal 一旦 abort，port 后续 reject 或迟到的成功结果都不能覆盖 cancelled 终态。Node resource exactly-once dispose，Core 不访问文件、网络、环境变量、process signal 或全局 registry。

## 二十、Conformance v1 实现基线

[#439](https://github.com/lizhiyao/oh-my-knowledge/issues/439) 在
`test/evaluation-core/conformance/` 建立确定性、宿主无关的共享 harness。纯函数、RAG top-K
与 Agent trajectory 使用同一套阶段驱动器，从 prepare 一直执行到 report materialization；
只有 protocol manifest、Runtime capability、结构化 adapter value 与 Evaluator 声明不同，
Core 不包含 `targetKind` 分派。每个序列化 Bundle 与 Report 都会基于 sealed plan 和 parent
facts 重新验证。

该 suite 覆盖 Gold 隔离与只替换 Evaluator 的重评分、原生 Recall@K／Precision@K／MRR／NDCG
observation、source-neutral trajectory evidence、output-only Evaluator 投影、session lifecycle、
反向 Comparison 角色、paired-block 预算 censoring、重复 trial 与 cluster bootstrap 的 unit count，
以及能区分整簇与逐 row 重采样的精确 interval reference、
带 raw-to-corrected hypothesis lineage 的端到端 Bonferroni comparison family、evidence gate、
classification 脱敏、reference 内容解析、cache replay、无实时 Event consumer 与必需
EventWriter。fault matrix 覆盖 Runtime resolve／open／execute／dispose，cache
read／write／miss／stale／forged provenance，ContentStore 与 ContentResolver 的 digest／classification
失败，continue／fail-fast／failure-threshold，以及 admission 前、in-flight、阶段边界和 dispose
期间的取消。并发 fixture 显式共享同一个 Runtime registry、event sequencer、artifact store 与两层
cache，同时保持不同的 Run id、state、取消、session 和 teardown；deferred gate 强制生命周期真实
重叠。全部 fixture 只使用确定性 clock、seed、deferred gate 与内存 store，不读取文件、网络、用户
配置，也不依赖 wall-clock delay。已知统计参考向量与确定性 simulation 共同守护 bootstrap unit
语义、宽松的区间 coverage 校准带，以及零 paired effect 的宽松 I 型错误率上界。

#425 对 Contracts、Compiler、Execution、Evaluation、Analysis／Decision 与跨阶段 conformance
的验收审计至此完成。包根 façade、公开 export 白名单和独立 Node.js 宿主验收仍明确归 #424；
CLI／Studio 迁移是后续消费者，不构成 Evaluation Core 验收前置条件。

Conformance 暴露并修复了多个跨阶段缺口：durable Bundle 接纳曾要求来源 root contract 等于
当前 RunPlan。来源血缘仍被封存并受 provenance 绑定，但接纳现在按阶段发生，递归校验每个被
消费阶段的 Plan 与准确直接父来源。仅下游变化时，可以复用仍然有效的 Execution、Evaluation 或
Analysis 证据；某阶段一旦变化，旧阶段 envelope 会在 Runtime admission 前被拒绝。EvaluationReport
仍绑定当前 root RunContract。
Execution cache 接纳还会校验 Core 为 sealed ExecutionPlan 产生的精确 native provenance 与原始
cache-miss receipt，以及封存的 output／trace capture、classification、attempt／retry chain、
确定性 aggregate usage 与 provider-cost 语义。stale digest、replay provenance 改写、classification
提升、capture mode 不匹配、attempt chain 畸形、伪造 aggregate usage，或 cost 缺失、币种不匹配、
达到封存上限，都会在打开 Executor 前 fail closed。Execution capture policy 属于 ExecutionPlan identity，
因此合法策略变化会进入新的 cache namespace，而不是被误报成基础设施故障。
Executor provenance 现在从每条 native record、ExecutionBundle 一直到最终 Report 都受 sealed Runtime
assurance 封顶。source envelope 还会独立保留直接父来源的 effective trust，child attestation 不能越级
抬高 parent；Report provenance 对方向性与非方向性结果都会纳入 Decision policy-execution attestation。
Conformance suite 会对这些 trust chain、cluster resampling artifact 与已校正 comparison family 进行
序列化导入和完整重验。

## 二十一、分析 cohort、评委重复测量与 Evaluation Series

[#452](https://github.com/lizhiyao/oh-my-knowledge/issues/452) 直接修正 v1 中三个测量单位缺口。这些变化属于 `BREAKING-SCHEMA`：v1 不提供兼容 reader 或数据迁移路径。

### 21.1 Analysis-only Sample 投影

`EvaluationSample.analysis` 只保存分析 membership 与带分类的分析 context。`EvaluationDataset.analysisCohorts` 定义每个稳定 `cohortId`、所属 `cohortSetId`、该集合是互斥的 `partition` 还是可重叠的 `cohort`、内容 classification、disclosure 规则，以及可选的带版本 seeded derivation。同一 Sample 在每个 partition set 中最多属于一个 cohort。`identity-only` cohort 不能携带 raw membership value。

Compiler 现在封存四种彼此独立的投影：

| 投影 | 内容 | 可见方 |
|---|---|---|
| Execution | `sampleId + input + executionContext` | Executor |
| Evaluation | Execution 投影加 `expected + evaluationContext` | Evaluator |
| Analysis | 稳定的 `sampleId + analysis` 与 cohort 定义 | Analysis Runtime |
| Dataset revision | 全部 Dataset 事实与审计 annotation | lineage 与审计 |

`analysisInputDigest` 覆盖 Analysis 投影。它进入 AnalysisPlan、DecisionPlan 和 `runContractDigest`，但不进入 ExecutionPlan 或 EvaluationPlan。因此改变 holdout 或 cohort 不会扰动 Target 执行、评委 cache identity 或评委可见的 Gold。AnalysisPlan 物化分析 Sample 与 cohort registry，并将两者作为封存的执行上下文传给 Analysis Runtime；每条 metric row 携带 canonical `cohortIds`，节点按封存的 `cohortFilter` 过滤，不解析 sample ID、数组位置或宿主闭包。Report 和 Event contract 不会自动复制 raw analysis context。

### 21.2 评委测量 identity

每个 EvaluatorDefinition 都声明版本化测量坐标：`instrumentId`、`ensembleMemberId`、`replicateGroupId` 和从零开始的 `replicateIndex`。Evaluator RuntimeIdentity 仍负责证明实际 implementation、模型、prompt 和 capability fingerprint，不能代替实验 identity。`evaluatorId` 只保留为稳定定义引用，不再解释为编码过的重复约定。

Evaluation coordinate、`evaluationId`、EvaluationRecord、cache identity 与 Analysis metric row 都绑定完整测量坐标。retry 的 `attemptNumber` 仍是一个 evaluator replicate 内部的基础设施恢复。Target trial、evaluator replicate、ensemble member、retry attempt、独立 Run 与 batch item 因而成为不同的类型层级。Analysis 实现可以按 `replicateGroupId` 计算 self-consistency，按 `ensembleMemberId` 计算 inter-rater agreement，并在 sample-level estimator 中避免把重复观测误当成独立实验单位。

### 21.3 Evaluation Series

Evaluation Series 是独立 Run 之上的离线 Core workflow。`createEvaluationSeriesDefinition()` 把 canonical member slot、从零开始的 replicate index、exact-design comparability policy、版本化 Series analysis standard 和可选 Series decision policy 规范化为 `seriesDesignDigest`。preregistered slot 不能包含执行后才知道的 expected Run digest；每个成员 EvaluationDefinition 必须在执行前绑定 `{ seriesDesignDigest, memberId, replicateIndex }`，这项 membership 只改变根 Run contract identity。`prepareEvaluationSeriesPlan()` 将 Series Runtime requirement 封存为 content-addressed `EvaluationSeriesPlan`；成员与 Runtime 的输入顺序不能改变其 identity。exploratory Series 可以额外绑定已知的 expected Run contract digest，但永远不能再升级为 preregistered。

Series 不接受文件、URI、未经验证的 Report object 或宿主 summary 作为证据。`createEvaluationSeriesMemberSource()` 要求 sealed RunPlan 与认证过的 Execution、Evaluation、Analysis、可选 Decision source chain，并重新验证 EvaluationReport，随后才签发不可序列化的 member capability。每个持久化 `SeriesMemberReference` 绑定 Run contract、全部阶段 Plan digest、全部 Bundle digest、可选 Decision digest、Report digest、三轴终态和 effective trust。

`runEvaluationSeries()` 先检查 member slot 唯一性、可选 expected Run identity，并在 preregistered 模式下校验成员 Run 精确的执行前 Series binding；没有匹配 binding 的 post-hoc Run 会 fail closed。随后 Core 按显式 ComparabilityPolicy 从 anchor Run 对每个候选执行比较，并把每个非 anchor 成员的完整认证 ComparabilityAssessment 持久化到 SeriesAnalysisBundle，使 design incompatible、evidence conditional 与 identity change 保持可审计，而不是塌缩成一个计数。design incompatible 永不接纳。evidence conditional 只有在预注册 policy 允许 `conditional` 时才能进入分析；identity change 不能伪装成 missing member。missing、partial、cancelled、budget-exhausted 和 failed Run 全部进入 `SeriesMemberCoverage`，不得静默丢弃或折算为零。

Series Analysis Runtime 只能收到 sealed plan 与认证过的 member capability。每个节点显式声明 member 或上游 result 输入，以及最低 member evidence status；design-compatible 但 failed、cancelled、budget-exhausted 或低于该 evidence 阈值的 Run 仍保留在 coverage 中，但不会传给 estimator，也不会计作 resampling unit。prepare 会拒绝缺失引用、重复输入、cycle、implementation 不匹配，以及未声明 `experimentalUnit = run` 的 Analysis Runtime。Runtime 按 canonical DAG 拓扑执行并绑定每个 parent digest。节点声明版本化 `analysisStandardId`，例如 variance、coefficient-of-variation 或 stability 实现；RuntimeIdentity、完整 output SchemaIdentity 与 assumption check 一并进入 record digest。Core-owned validator 按精确 schema identity 独立注入，并且必须原样保留完整 `{ resultType, value }` envelope；结果生产 Runtime 不能自行证明输出合法。符合 evidence 条件的 Run 少于两个或 assumption 失败时产生显式 inconclusive record。Record 与 decision 明确区分 `executed` 和 `not-executed`；Runtime 失败只落盘固定、已脱敏的 Core error，不反射宿主 details。只有封存的 coverage ratio、minimum member evidence status、required-result 与 assumption gate 全部通过后，Series decision 才能产生方向性结论。否则 Core 输出 `not-decided`，且不调用方向性 policy。`SeriesAnalysisBundle` 与 `EvaluationSeriesReport` 分别验证 canonical order、唯一性、coverage 算术、输入 lineage 与全部内容 digest。重新分析会产生新的 derivation artifact，并保留 preregistered 或 exploratory mode；它不会修改或重新执行 member Run。

Series 固定使用 `experimentalUnit = run`。Run 内 trial、evaluator replicate 与 retry attempt 永远不能作为独立 Run 重采样。既有 Bootstrap、Krippendorff alpha、五层评分与发布公式保持不变；新增 Series 公式必须作为单独版本化 Runtime standard 引入并声明其适用前提。

## 二十二、行业参考

- [Inspect AI Tasks](https://inspect.aisi.org.uk/tasks.html)、[Scorers](https://inspect.aisi.org.uk/scorers.html)、[Eval Logs](https://inspect.aisi.org.uk/eval-logs.html)；
- [MLflow Evaluation Datasets](https://mlflow.org/docs/latest/genai/datasets/)、[LLM Judges and Scorers](https://mlflow.org/docs/latest/genai/eval-monitor/scorers/index.html)；
- [Phoenix Experiments](https://arize.com/docs/ax/improve/experiment-in-code)；
- [Pydantic Evals](https://pydantic.dev/docs/ai/evals/evals/)、[Report Evaluators](https://pydantic.dev/docs/ai/evals/evaluators/report-evaluators/)；
- [lm-evaluation-harness Task Guide](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/task_guide.md)；
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)、[OpenInference Semantic Conventions](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md)；
- [CloudEvents](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)、[W3C Trace Context](https://www.w3.org/TR/trace-context/)；
- [W3C PROV Overview](https://www.w3.org/TR/prov-overview/)、[PROV-AQ](https://www.w3.org/TR/prov-aq/)；
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12)、[RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html)、[RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)。
- [Zod 4 JSON Schema](https://zod.dev/json-schema)、[Node.js Events](https://nodejs.org/api/events.html)、[Sigstore Bundle specification](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto)。

## 相关文档

- [评分公式](scoring.md)；
- [统计严谨性](../explanation/statistical-rigor.md)；
- [术语规范](terminology-spec.md)；
- [RAG metrics 规范](rag-metrics-spec.md)。
