# CLI 评测输入编译规范

> **状态**：本规范已成为 [Evaluation Core vNext RFC](./eval-core-vnext.md) 下的正式输入边界。Parse、Resolve、Compile、Runtime 装配、宿主 workflow、Core 执行与产物持久化共同组成权威 `omk eval` 路径。

## 一、目的与边界

CLI 宿主必须把 flag、`eval.yaml`、文件和本机资源翻译成同一份宿主无关的测量契约，不能在 Core sealed RunPlan 旁再建一套 plan。因此，输入处理固定为五种互不重叠的职责：

```text
CLI flags／eval.yaml
        │ parse precedence and syntax
        ▼
CliEvaluationRequest
        │ resolve files, artifacts, samples and host resources
        ▼
ResolvedCliEvaluationInput + ResolvedHostResources
        │ pure deterministic compilation
        ▼
EvaluationDefinition + MeasurementPolicy
RuntimeBindingRequest + EvaluationOrchestrationOptions
EvaluationPresentationOptions + static RunOptions metadata
        │
        ├── Core prepare：schema／reference／capability／runtime identity／seal
        └── adapter preflight：doctor／credential／connectivity／physical environment
```

| 阶段 | 负责 | 禁止 |
|---|---|---|
| Parse | `parseCliEvaluationRequest()` 执行 `CLI > eval.yaml > explicit host default`、校验语法并记录来源归因 | 读取文件系统／环境／网络／时钟，把 parser 注入的默认值当成显式 flag，创建 Runtime，计算测量 digest |
| Resolve | materialization、git pin、内容／目录树 digest、mock／workspace descriptor、locator 绑定 | 调用 Core prepare、相信自报能力、产出 sealed plan |
| Compile | 纯映射到 canonical、schema-valid、静态语义完整的 Core contract 和宿主请求 | 读取文件系统／环境／网络／时钟，创建 `AbortSignal`、writer、store 或 run ID |
| Core prepare | 重新校验契约，确认已验证的 Runtime capability／identity，封存唯一 RunPlan | 做 connectivity 或 doctor 检查 |
| Adapter preflight | credential、connectivity、路径权限、doctor、物理环境健康度 | 替代 Core capability 校验或改写 sealed measurement design |

## 二、输出归属

- `EvaluationDefinition` 负责数据投影、Target 行为、evaluator instrument、metric、实验设计、分析、比较和决策策略；
- `MeasurementPolicy` 负责 execution／evaluation concurrency、timeout、retry、cache、evidence、failure、event delivery 和共享 Run 预算账本；
- `RuntimeBindingRequest` v4 只保存从 Definition／已解析宿主资源派生的 implementation 和 resource lease requirement。Executor qualification 直接复用 canonical `TargetDefinition.executionRequirements`，不维护第二份近似语义。宿主 registry 可以解析 binding，但不能覆盖 execution requirement、model、effort、prompt variant、protocol、evaluator identity 或行为配置。完整装配契约见 [Evaluation Runtime Adapter 规范](./evaluation-runtime-adapter.md)；
- `ResolvedHostResources` 用稳定 resource ID 和 digest 绑定 effect locator。它不是 Core schema，也不进入 canonical measurement JSON；
- `EvaluationOrchestrationOptions` 负责 dry-run、resume locator、batch、独立 Series repeat、preflight 开关、diagnostic 后处理、gold post-hoc workflow 和受管证据追加；
- Sample bundle 的 `requires` 会连同 `baseDirectoryLocator` 规范化成宿主侧 `dependencyRequirements`，供后续 doctor／preflight workflow 消费；相对文件与 preflight 命令因此继续锚定 sample bundle 根目录。该宿主上下文不进入 Core 测量 digest，也不能被静默丢弃；
- `EvaluationPresentationOptions` 负责输出 locator、索引范围、语言、server、verbose、layered view 和 CLI exit 展示。这些字段都不能改变 `DecisionResult`；
- 静态 RunOptions metadata 可以保存可序列化的 annotation 和 summary。只有真正启动 Run 时，orchestrator 才创建 run ID、取消信号、EventWriter 和 buffer。

架构中刻意不存在 `HostExecutionPlan`。唯一名为 Plan 的对象由 Core prepare 生成并封存。

## 三、身份、lineage 与资源安全

行为身份和来源 lineage 是两条不同轴：

- Target config 保存 artifact、mock、sandbox、model 与 effort 等 Target-wide behavior fact。canonical `executionControls` 单独保存 workspace 与工具授权的 Target 默认值和 Sample override；其中的 workspace descriptor 不包含 locator；
- Target `executionRequirements` 是从 resolved behavior 与全部 effective sample control 派生的聚合 capability 请求：显式 system instruction 使用、copy-on-write workspace、native MCP config、pre-tool-call mock interception、tool allow-list、skill discovery policy 和 sandbox ID。它进入 Definition 与 ExecutionPlan identity，只有 Core prepare 可以把它与 Runtime feature 做匹配；它绝不把聚合 workspace 或工具权限授予某个 Trial；
- Host resources 保存 locator、resolved commit、仓库来源和 materialization 证据。同一内容在绝对／相对路径或不同机器间移动，不会让 execution identity 失效；
- 行为变化会改变 Definition digest。只有 lineage 变化时，后续由显式 comparability／provenance policy 判断，不能偷偷塞进 Target config。

Mock rule 和 payload 是相互独立的 secret、digest-bound descriptor。原始 `tool`／`match` 不进入 Core 或静态 Target JSON；Runtime adapter 只能在业务进程启动前，通过 run-scoped verified lease 读取它们。`sampleIds`、strict mode、rule descriptor 和有序 payload descriptor 仍是 canonical Target 行为，因此修改规则字节或返回顺序都会改变测量身份。`sampleId` 由 Core 交给 adapter，绝不拼入模型 prompt。Compile 还要求每个引用角色匹配对应的宿主资源类型：artifact、workspace、MCP config、mock rule、mock payload、evaluator content 和 gold dataset 即使 descriptor 恰好相同，也不能相互替代。Runtime adapter 在使用前必须重新校验 digest。缺少 interception、allowed-tool、skill-discovery、MCP、cancellation、seed 或 sandbox capability 时，Core prepare 必须 fail closed；adapter 不能删除 mock，也不能降级成真实外部调用。不同 Sample 的 `cwd` 与 `allowedTools` 会编译成 canonical sample override，永远不做 union；adapter 只能收到准确的 effective Trial control。

`ResolvedHostResources` v3 要求 `descriptor.size` 必填，并把 pinned Git verification 表达为 `{verificationKind, verifiedDigest, commitId}`。`commitId` 必须是规范化的 40–64 位小写十六进制对象身份，branch 或 tag 名不是 pin。仅文件的 MCP config、mock rule、mock payload 和 evaluator content 资源必须使用 `content-digest`；mock rule 还必须使用 `application/json`。MCP config 与两类 mock control 资源都必须标记为 `secret`。workspace 必须使用 `tree-digest` 或 `pinned-git`；pinned Git 仅适用于 artifact 和 workspace。`gold` classification 与 `gold-dataset` kind 必须同时成立。旧结构会被直接拒绝，不提供 compatibility reader。

Dataset 投影保护 Gold 边界：Executor 只看到 `input + executionContext`；evaluator 可以读取 `expected + evaluationContext`；analysis 只读取显式 membership 和 analysis context。Gold locator 只留在宿主资源中。Post-hoc gold compare 标记为 exploratory，不能冒充 preregistered decision。

## 四、测量映射

- control／treatment 角色只进入 `Comparison`，artifact 内容属于 Target 行为；
- assertion、rubric 评委、dimension、composite 和 RAG metric 仍是不同的 Evaluator／Metric／AnalysisGraph 概念。Evaluator template 持有算法 `implementationId`、instrument 与 runtime prompt variant；judge member 只持有 provider executor、model、effort 与 ensemble identity；
- 评委成员显式携带 instrument、ensemble member、replicate group 和 replicate index。分析代码不得解析 evaluator ID 推断层级；
- holdout／cohort membership 只进入 analysis，并在执行前固定；
- bootstrap、correction、threshold 和 trivial-difference gate 是 AnalysisGraph 或 DecisionPolicy 中的 Definition 事实；
- 每个 treatment 都有独立、显式的 paired control comparison，多 treatment 请求不能压成一个含混的 treatment identity；
- 确定性 assertion evaluator 在 criterion 不适用时产出显式 structural-missing observation。LLM assertion 与 rubric dimension 则封存 canonical `applicableSampleIds`；Core 会从 plan identity、coverage、execution 与 analysis 中排除不适用的 Evaluator coordinate，不能误评到其它 sample；
- 生产设计使用 paired block 与 `seedCoupling: uncontrolled`：当前 provider adapter 都不具备精确 sampling seed control。宿主可以确定性随机化 coordinate 顺序，但不能声称模型随机性已经耦合；
- length debias 改变 rubric evaluator config；排版／语气中性化恒开；
- 旧 total USD 映射为共享 Run provider-cost limit；per-sample USD 和毫秒映射为 per-coordinate provider-cost／active-duration limit。不得用宿主 `AbortController` 或事后改写 report 实现。

重复层级必须显式：

| 概念 | 契约 |
|---|---|
| Trial | 同一 sealed Run 内重复 Target measurement |
| Retry attempt | 同一 coordinate 的基础设施恢复 |
| Judge replicate | 同一 instrument 的重复观测 |
| Ensemble member | 不同的评委 instrument／Runtime |
| `--repeat` | Evaluation Series 中的独立 Run |
| Batch child | 不同 artifact workflow，不是 Series replicate |

当 `--repeat > 1` 时，orchestrator 在 Resolve 前分配唯一的 `seriesInstanceId`。Compile 把这份宿主持有的实例身份与完整 Series 设计绑定，包括 measurement design、repeat count、comparison scope 和 minimum status，并由此派生 Core 最终使用的 `seriesId`。编译器不会从时钟或随机源创造身份；同一实例 ID 被错误复用于不同设计时，也不会映射成同一个 Series。

### 4.1 Cache 与 replay

Fresh measurement 是默认语义。规范 policy 始终分别携带两个字段：

```yaml
cache:
  executionMode: disabled # disabled | replay-only | transparent-deterministic
  evaluationMode: disabled # disabled | reuse
```

`executionMode` 和 `evaluationMode` 分别进入对应的 Core contract digest。任何非 disabled 模式还必须在宿主持有的 `orchestration.cacheSources` 中声明对应阶段的 source locator；locator 不进入 Core canonical JSON。Runtime adapter 必须把这份指定 source 装配为对应 cache port，不得换成环境选择或全局默认 source。

`replay-only` 是 fail-closed 只读路径。coordinate 缺失、source 不可用、entry 损坏或 identity 不匹配都会终止运行，绝不回退为实时 Target 调用。Replay record 沿用原 trial identity、Runtime identity、usage、cost 和 provenance；既不新增 native invocation，也不增加独立 replicate。在 Series 具备显式 effective-independent-sample 模型前，Compile 会拒绝任何非 disabled cache mode 与独立 Series repeat 组合，也会拒绝在同一请求中混用 cache reuse 与 resume。只有 Core prepare 验证 execution 为 deterministic 且 Runtime identity 为 verified 时，才能使用 `transparent-deterministic`。Evaluation `reuse` 与 Execution 独立，并继续绑定完整 evaluation contract，包括 evaluator／model／prompt variant、replicate identity、Gold-facing input、metric 和 evidence policy。

Core contract 为 `--execution-cache-mode`、`--evaluation-cache-mode`、`--execution-cache-source` 和 `--evaluation-cache-source` 预留语义；`eval.yaml` 相应预留 `cache.executionMode`、`cache.evaluationMode`、`cache.executionSource` 和 `cache.evaluationSource`。当前正式 CLI 尚未开放这些显式复用控制。省略 cache 输入或传入 disable-only 的 `--no-cache` 都会规范化为 fresh 双 disabled policy；显式请求 cache enable 会直接失败，不猜测成透明复用。

## 五、确定性与校验

`parseCliEvaluationRequest()` 是 raw CLI／config 输入的纯规范化边界。宿主只传入用户显式提供的 flag、已完成语法校验的 `EvalConfig`，以及带来源信息的环境选择默认值。CLI 和 config 候选值必须先经过同一组规范字段校验，再应用优先级。只有本阶段真实存在的值才能产生 provenance；后续派生值只在实际派生时记录来源。不得把 Oclif 自动注入的默认值冒充用户显式 CLI 输入。Judge 开关必须先于 judge-model 解析确定，因此 no-judge 请求不会因一份不再使用的错误评委来源而失败。

`compileCliEvaluationInput()` 只接收已解析、可序列化的 IR，不执行任何 I／O，并返回 deep-frozen 输出。它在产出前调用 Core 公开的 `normalizeEvaluationDefinition()` 和 `validateDefinitionSemantics()`：schema 校验、类集合字段的 canonical 排序、引用完整性和静态语义校验由同一个 owner 定义。Core 边界会在 Runtime qualification 前再次校验这些契约。对象属性顺序、嵌套 membership／cohort filter 顺序、宿主 locator 写法、CLI／YAML 来源和 lineage 不影响 Definition／Policy digest；实际行为字节变化则必须影响 digest。

Parse 和 Compile 错误使用宿主 `CliEvaluationInputError`，包含稳定 code，以及可选的 source／field path。Core 静态校验失败会把原始 Core code／details 保留在宿主错误中，但不会让 Core Run 错误越过尚未开始 Run 的边界。它们不是 Core `EvaluationError`。Compile 不接受 Runtime 自报能力；只有 Core prepare 有权做 capability qualification。

## 六、迁移边界

本层已经是正式生产边界。`omk eval` 把这里产出的 contract 交给 Runtime 装配与 Core 宿主 workflow，并持久化 Core Plan、Bundle 和 Report。已删除的旧 pipeline 不会双跑或 shadow run，后续层也不会重新解析 CLI 输入。

迁移 contract 有意不兼容：parse output 使用 `omk.cli-evaluation-request/v2`，resolved compiler input 使用 `omk.resolved-cli-evaluation-input/v5`，HostResource inventory 仍使用 `omk.resolved-host-resources/v3`，binding output 仍使用 `omk.runtime-binding-request/v4`。Request v2 与 resolved input v5 增加必需的样本量规划 contract，并选择 `omk.release-decision/v5` 与 `omk.bootstrap-family-table/v2`；旧结构会直接被拒绝，不做推断，也不提供 compatibility reader。此前 resolved input v4 已用 secret `mock-rule` descriptor 和 lease role 取代内联 mock match rule。新的 release-policy identity 同时绑定计划家族校正与显式 Monte Carlo 判定证据，历史 release policy v1～v4 与 Bootstrap family v1 仍保留注册用于重放。

disable-only 的 `--no-cache`／`noCache` 没有忠实的 Core cache-enable 等价语义：已删除实现中的 enabled 状态表示 stochastic read-through execution reuse，却没有表达 Evaluation cache。当前 Registry 只规范化 disabled 状态，并把显式 cache reuse 留给未来单独设计的接口；旧 cache 文件不会被读取。

## 七、完整输入 registry

Declarative registry 对每个正式 `omk eval` flag 和每个机器可枚举的 `EvalConfig` path 进行分类。CI 对两组 source key 做严格集合比较，任何未分类新字段都会失败。下表由 `yarn build:docs` 从 registry 生成。

<!-- omk:eval-input-registry:start -->
| 来源 | 字段 | 规范字段 | 优先级 | 规范默认值（来源） | Owner | Digest 阶段 | Runtime qualification | 错误／迁移 |
|---|---|---|---:|---|---|---|---|---|
| CLI | `--batch` | `orchestration.batch` | 300 | `false` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--bootstrap` | `definition.analysisGraph.bootstrap` | 300 | `true` (documented) | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--bootstrap-samples` | `definition.analysisGraph.bootstrap.resamples` | 300 | `1000` (documented) | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--budget-per-sample-ms` | `policy.budget.perCoordinateActiveDurationMs` | 300 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--budget-per-sample-usd` | `policy.budget.perCoordinateProviderCostUSD` | 300 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--budget-usd` | `policy.budget.totalProviderCostUSD` | 300 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--concurrency` | `policy.executionConcurrency` | 300 | `1` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--config` | `orchestration.configLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--control` | `definition.targets.control` | 300 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--control-cwd` | `resources.controlWorkspaceLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--dry-run` | `orchestration.dryRun` | 300 | `false` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--effort` | `definition.targetRuntime.effort` | 300 | `"low"` (documented) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--executor` | `definition.targetRuntime.implementationId` | 300 | — (environment-selection) | Definition | execution | `executor-protocol`<br>`model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--global` | `presentation.indexScope` | 300 | `"project"` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--gold-dir` | `orchestration.gold.resourceLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--holdout-ratio` | `definition.dataset.analysisCohorts` | 300 | — | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--judge-models` | `definition.judges.members` | 300 | — (environment-selection) | Definition | evaluation | `evaluator-instrument`<br>`model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--judge-repeat` | `definition.judges.replicateCount` | 300 | `1` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--lang` | `presentation.language` | 300 | `"zh"` (environment-selection) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--layered-stats` | `presentation.layeredView` | 300 | `false` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--mcp-config` | `resources.mcpConfigLocator` | 300 | — | Orchestration | none | `tool-mock-sandbox` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--model` | `definition.targetRuntime.model` | 300 | — (environment-selection) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-cache` | `policy.cache.executionMode` | 300 | `"disabled"` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_LEGACY_CACHE_ENABLE_UNSUPPORTED`<br>replace → --execution-cache-mode / --evaluation-cache-mode |
| CLI | `--no-debias-length` | `definition.judges.lengthDebias` | 300 | `true` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-diagnostic` | `orchestration.diagnostic` | 300 | `"enabled-outside-core"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-evidence` | `orchestration.managedEvidence` | 300 | `"append"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-gate` | `presentation.exitMode` | 300 | `"gate"` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>rename → --report-only |
| CLI | `--no-judge` | `definition.judges.enabled` | 300 | `true` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-serve` | `presentation.serve` | 300 | `true` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-strict-baseline` | `definition.baselineIsolation` | 300 | `true` (documented) | Definition | execution | — | `CLI_INPUT_INVALID`<br>`CLI_INPUT_BASELINE_ISOLATION_CONFLICT`<br>retain |
| CLI | `--output-dir` | `presentation.outputDirectoryLocator` | 300 | — | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--repeat` | `orchestration.independentSeries.repeatCount` | 300 | `1` (documented) | Orchestration | run | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--report-only` | `presentation.exitMode` | 300 | `"gate"` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--resume` | `orchestration.resumeSourceLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--retry` | `policy.retryCount` | 300 | `0` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--samples` | `orchestration.samplesLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--skill-dir` | `orchestration.skillDirectoryLocator` | 300 | `"skills"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--skip-connectivity` | `orchestration.preflight.connectivity` | 300 | `"required"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--skip-doctor` | `orchestration.preflight.doctor` | 300 | `"required"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--strict-baseline` | `definition.baselineIsolation` | 300 | `true` (documented) | Definition | execution | — | `CLI_INPUT_INVALID`<br>`CLI_INPUT_BASELINE_ISOLATION_CONFLICT`<br>retain |
| CLI | `--threshold` | `definition.decisionPolicy.threshold` | 300 | — (derived) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--timeout` | `policy.executionTimeoutMs` | 300 | `120000` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--treatment` | `definition.targets.treatments` | 300 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--treatment-cwd` | `resources.treatmentWorkspaceLocators` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--trivial-diff` | `definition.decisionPolicy.trivialDifference` | 300 | — (derived) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--verbose` | `presentation.verbose` | 300 | `false` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `bootstrap` | `definition.analysisGraph.bootstrap` | 200 | `true` (documented) | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `bootstrapSamples` | `definition.analysisGraph.bootstrap.resamples` | 200 | `1000` (documented) | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `budget` | `policy.budget` | 200 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `budget.perSampleMs` | `policy.budget.perCoordinateActiveDurationMs` | 200 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `budget.perSampleUSD` | `policy.budget.perCoordinateProviderCostUSD` | 200 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `budget.totalUSD` | `policy.budget.totalProviderCostUSD` | 200 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `concurrency` | `policy.executionConcurrency` | 200 | `1` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision` | `definition.decisionPolicy` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.minimumComparisonUnits` | `definition.decisionPolicy.sampleSize.minimumComparisonUnits` | 200 | `20` (documented) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power` | `definition.decisionPolicy.sampleSize` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power.assumptionSource` | `definition.decisionPolicy.sampleSize.assumptionSource` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power.expectedDifferenceStandardDeviation` | `definition.decisionPolicy.sampleSize.expectedDifferenceStandardDeviation` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power.minimumDetectableDifference` | `definition.decisionPolicy.sampleSize.minimumDetectableDifference` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power.targetPower` | `definition.decisionPolicy.sampleSize.targetPower` | 200 | `0.8` (documented) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.threshold` | `definition.decisionPolicy.threshold` | 200 | — (derived) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.trivialDifference` | `definition.decisionPolicy.trivialDifference` | 200 | — (derived) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `effort` | `definition.targetRuntime.effort` | 200 | `"low"` (documented) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `executor` | `definition.targetRuntime.implementationId` | 200 | — (environment-selection) | Definition | execution | `executor-protocol`<br>`model-effort` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `goldDir` | `orchestration.gold.resourceLocator` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `holdoutRatio` | `definition.dataset.analysisCohorts` | 200 | — | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `judgeModels` | `definition.judges.members` | 200 | — (environment-selection) | Definition | evaluation | `evaluator-instrument` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `judgeModels[].executor` | `definition.judges.members[].executorId` | 200 | — | Definition | evaluation | `evaluator-instrument` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `judgeModels[].model` | `definition.judges.members[].model` | 200 | — | Definition | evaluation | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `judgeRepeat` | `definition.judges.replicateCount` | 200 | `1` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `lengthDebias` | `definition.judges.lengthDebias` | 200 | `true` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `mcpConfig` | `resources.mcpConfigLocator` | 200 | — | Orchestration | none | `tool-mock-sandbox` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `model` | `definition.targetRuntime.model` | 200 | — (environment-selection) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `noCache` | `policy.cache.executionMode` | 200 | `"disabled"` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_LEGACY_CACHE_ENABLE_UNSUPPORTED`<br>replace → cache.executionMode / cache.evaluationMode |
| eval.yaml | `noDiagnostic` | `orchestration.diagnostic` | 200 | `"enabled-outside-core"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `noJudge` | `definition.judges.enabled` | 200 | `true` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `repeat` | `orchestration.independentSeries.repeatCount` | 200 | `1` (documented) | Orchestration | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `samples` | `orchestration.samplesLocator` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `skipDoctor` | `orchestration.preflight.doctor` | 200 | `"required"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `strictBaseline` | `definition.baselineIsolation` | 200 | `true` (documented) | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `timeoutMs` | `policy.executionTimeoutMs` | 200 | `120000` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants` | `definition.targets` | 200 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].allowedSkills` | `definition.targets[].behavior.allowedSkills` | 200 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].artifact` | `resources.targets[].artifactLocator` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].cwd` | `resources.targets[].workspaceLocator` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].git` | `resources.targets[].gitSource` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].git.ref` | `resources.targets[].gitSource.ref` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].git.spec` | `resources.targets[].gitSource.spec` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].git.url` | `resources.targets[].gitSource.url` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].name` | `definition.targets[].targetId` | 200 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].role` | `definition.targets[].experimentRole` | 200 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
<!-- omk:eval-input-registry:end -->
