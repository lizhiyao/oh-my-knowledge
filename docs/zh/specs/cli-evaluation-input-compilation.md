# CLI 评测输入编译规范

> **状态**：作为 [#451](https://github.com/lizhiyao/oh-my-knowledge/issues/451) 的迁移基础实现，服从 [Evaluation Core vNext RFC](./evaluation-core-vnext.md)。本层不切换正式 `omk eval` pipeline，也不调用 `createEvaluationEngine()`。

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
| Parse | `CLI > eval.yaml > documented default`、语法、来源归因 | 读文件、创建 Runtime、计算测量 digest |
| Resolve | materialization、git pin、内容／目录树 digest、mock／workspace descriptor、locator 绑定 | 调用 Core prepare、相信自报能力、产出 sealed plan |
| Compile | 纯映射到 schema-valid Core contract 和宿主请求 | 读取文件系统／环境／网络／时钟，创建 `AbortSignal`、writer、store 或 run ID |
| Core prepare | 校验 schema／引用和已验证的 Runtime capability／identity，封存唯一 RunPlan | 做 connectivity 或 doctor 检查 |
| Adapter preflight | credential、connectivity、路径权限、doctor、物理环境健康度 | 替代 Core capability 校验或改写 sealed measurement design |

## 二、输出归属

- `EvaluationDefinition` 负责数据投影、Target 行为、evaluator instrument、metric、实验设计、分析、比较和决策策略；
- `MeasurementPolicy` 负责 execution／evaluation concurrency、timeout、retry、cache、evidence、failure、event delivery 和共享 Run 预算账本；
- `RuntimeBindingRequest` 只保存从 Definition 派生的 implementation requirement。宿主 registry 可以解析实现，但不能覆盖 model、effort、prompt variant、protocol、evaluator identity 或行为配置；
- `ResolvedHostResources` 用稳定 resource ID 和 digest 绑定 effect locator。它不是 Core schema，也不进入 canonical measurement JSON；
- `EvaluationOrchestrationOptions` 负责 dry-run、resume locator、batch、独立 Series repeat、preflight 开关、diagnostic 后处理、gold post-hoc workflow 和受管证据追加；
- `EvaluationPresentationOptions` 负责输出 locator、索引范围、语言、server、verbose、layered view 和 CLI exit 展示。这些字段都不能改变 `DecisionResult`；
- 静态 RunOptions metadata 可以保存可序列化的 annotation 和 summary。只有真正启动 Run 时，orchestrator 才创建 run ID、取消信号、EventWriter 和 buffer。

架构中刻意不存在 `HostExecutionPlan`。唯一名为 Plan 的对象由 Core prepare 生成并封存。

## 三、身份、lineage 与资源安全

行为身份和来源 lineage 是两条不同轴：

- Target config 通过 `{resourceId, digest, mediaType, classification}` descriptor 保存会影响行为的字节／配置，并包含规范化的 workspace、tool、mock、sandbox、model 和 effort 事实；
- Host resources 保存 locator、resolved commit、仓库来源和 materialization 证据。同一内容在绝对／相对路径或不同机器间移动，不会让 execution identity 失效；
- 行为变化会改变 Definition digest。只有 lineage 变化时，后续由显式 comparability／provenance policy 判断，不能偷偷塞进 Target config。

Mock match rule 和 strict mode 进入 Target 行为。每份 payload 都是 digest-bound descriptor；禁止内联 secret 或 gold 内容。Runtime adapter 在使用前必须重新校验 digest。缺少 interception、allowed-tool、skill-discovery、MCP、cancellation、seed 或 sandbox capability 时，Core prepare 必须 fail closed；adapter 不能删除 mock，也不能降级成真实外部调用。

Dataset 投影保护 Gold 边界：Executor 只看到 `input + executionContext`；evaluator 可以读取 `expected + evaluationContext`；analysis 只读取显式 membership 和 analysis context。Gold locator 只留在宿主资源中。Post-hoc gold compare 标记为 exploratory，不能冒充 preregistered decision。

## 四、测量映射

- control／treatment 角色只进入 `Comparison`，artifact 内容属于 Target 行为；
- assertion、rubric 评委、dimension、composite 和 RAG metric 仍是不同的 Evaluator／Metric／AnalysisGraph 概念；
- 评委成员显式携带 instrument、ensemble member、replicate group 和 replicate index。分析代码不得解析 evaluator ID 推断层级；
- holdout／cohort membership 只进入 analysis，并在执行前固定；
- bootstrap、correction、threshold 和 trivial-difference gate 是 AnalysisGraph 或 DecisionPolicy 中的 Definition 事实；
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

## 五、确定性与校验

`compileCliEvaluationInput()` 只接收已解析、可序列化的 IR，不执行任何 I／O，并返回 deep-frozen 输出。它立即使用已发布的 Core schema 校验 Definition 和 Policy。对象属性顺序、宿主 locator 写法、CLI／YAML 来源和 lineage 不影响 Definition／Policy digest；实际行为字节变化则必须影响 digest。

编译错误使用宿主 `CliEvaluationInputError`，包含稳定 code，以及可选的 source／field path。它不是 Core `EvaluationError`，因为 Run 尚未开始。Compile 不接受 Runtime 自报能力；只有 Core prepare 有权做 capability qualification。

## 六、迁移边界

本层是增量架构。正式 `omk eval` 仍走 `RunConfig → runEvaluation → executeEvaluationPipeline`；不双跑、不 shadow run、不持久化 Core Bundle，也不改变旧 Report。后续 Runtime adapter 只能消费这里产出的 contract，不能重新解析 CLI 输入。

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
| CLI | `--lang` | `presentation.language` | 300 | `"zh"` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--layered-stats` | `presentation.layeredView` | 300 | `false` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--mcp-config` | `resources.mcpConfigLocator` | 300 | — | Orchestration | none | `tool-mock-sandbox` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--model` | `definition.targetRuntime.model` | 300 | — (environment-selection) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-cache` | `policy.cache` | 300 | `"enabled"` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
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
| eval.yaml | `noCache` | `policy.cache` | 200 | `"enabled"` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
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
