# Evaluation Runtime Adapter 规范

> **状态**：已建立 [#457](https://github.com/lizhiyao/oh-my-knowledge/issues/457) 的 binding assembly、verified resource lease 与 Core composition root。本层是增量架构，不切换正式 `omk eval` pipeline。

## 一、边界

OMK 宿主完整消费 `compileCliEvaluationInput()` 的输出，并在 Evaluation Core 外执行 effect。Binding assembly 不创建第二套 plan、不重新解释 CLI 输入，也不把 registry 声明当成 Runtime 实际身份。

```text
       compileCliEvaluationInput()
                    │ 完整不可变产物
                    ▼
       createOmkEvaluationRuntime()
                    │
        ┌───────────┼────────────────┐
        ▼           ▼                ▼
 binding entries  support ports  run lease registry
        └───────────┼────────────────┘
                    ▼
       createEvaluationEngine().prepare()
                    │ actual identity／capabilities
                    ▼
              SealedRunPlan
```

独立 Series 分析装配为 `EvaluationSeriesRuntimePorts`，绝不进入 `EvaluationEngineRuntimeBindings`。

## 二、Binding 完整覆盖

Assembly 要求以下每个引用都有且只有一个 binding：

- Target executor 和 Evaluator；
- AnalysisGraph node，以及独立的 Sampling Estimator requirement；
- MissingPolicy 和 DecisionPolicy；
- Series analysis node 和 Series decision policy。

Analysis binding 同时携带 `referenceId` 和 Core `requirementKind`。Sampling Estimator 不再从 AnalysisGraph node 猜测，也不能由 fallback registry 静默解析。

完整结构使用 `omk.runtime-binding-request/v2`。不完整的迁移期 v1 request 会被直接拒绝，不增加 compatibility 分支。

调用任何 factory 前，assembly 会验证 binding ID／reference key 唯一性、Definition／Series 精确覆盖、implementation／version、executor protocol／model／effort／behavior digest、evaluator measurement／config digest，以及 resource lease requirement。验证失败时 factory 调用次数必须为零。

## 三、不可变 Entry 与身份

Assembly 首先复制并深度冻结 Definition、Series 和 RuntimeBindingRequest。Factory 按 `implementationId` 查找，但按 binding 分别调用，因此共享同一实现的两个 reference 仍得到不同 port instance。

Factory 返回实际 port identity 和 version resolution。Assembly 校验 port 形状与 implementation identity，捕获不可变 identity snapshot，并用原始实例的方法包装 port。Core preparation resolver 和运行 port 由同一个 entry 投影；后续 registry 或请求对象变化不能造成 split-brain。

每个 entry 保存：

- 完整 binding 和实际 `RuntimeResolution`；
- 捕获后的 port；
- 显式 resource lease requirement；
- 由完整 binding 派生并传给对应 factory 的 binding-local `sessionIsolationKey`。
- 仅向 Executor／Evaluator factory 提供 binding-scoped resource access view；它按当前 Core `runId` 取 lease，不能枚举其它 binding 或 analysis-only resource。

Adapter 必须把 `sessionIsolationKey` 与 Core `runId`、`trialId` 组合使用；它不允许跨 run 或 binding 复用有状态 session。

## 四、Same-process Runtime adapter

`createSameProcessExecutorAdapter()` 与 `createSameProcessEvaluatorAdapter()` 是 binding-local 同进程实现的基准桥接层。宿主必须显式提供 `RuntimeIdentity` 和全部生命周期回调；adapter 不从 Definition 推断 capability，也不提供评分算法。

桥接层会在构造时校验并冻结 identity，捕获 lease resolver 与回调函数，并为每个 run、trial／evaluation record 派生独立的内容寻址隔离键。因此，工厂对象后续发生变更，也不能在已封存的 identity 背后替换实际执行实现。重复的 active run 与 operation identity 会 fail closed；即使调用方并发或重试清理，每个 dispose 回调也至多执行一次。

Core attempt 的 `AbortSignal`、trial seed、Target／Evaluator 配置、已验证的 binding lease 与可选 usage 会原样转交。未报告 usage 时仍保持缺失。桥接层不拥有独立 timeout、retry、budget、cache 或 cancellation race；这些行为只由 sealed Core Policy 驱动。Cooperative implementation 收到转交 signal 的 abort 后，必须让底层操作真正收敛。

Composition root conformance 使用 `test.*` 命名空间下、根据输入和 binding 动态生成结果的实现。它们会经过真实 Core prepare 与 run 路径，但不会被导出或伪装成生产 Executor／Evaluator 算法。

## 五、资源需求

RuntimeBindingRequest 只记录资源角色和预期 lease mode，不记录 locator 或内容：

| 角色 | Lease mode |
|---|---|
| artifact、MCP config、mock payload、evaluator content | immutable snapshot |
| workspace | verified base + copy-on-write overlay |

这些只是 acquisition requirement。后续 Verified HostResource lease 层仍须在 port 打开 run 前验证 kind、classification、size、digest、实际字节／目录树、隔离和 exactly-once release。Gold resource 不得出现在 executor 或 evaluator binding requirement 中。

Lease acquisition 在首个 effect 之前同步复制并冻结全部 descriptor 和 binding request。随后它只物化 active binding 请求的资源，把源字节复制到 run 私有目录，并验证私有 snapshot，而不是继续消费 locator。Immutable snapshot 是只读的。每个 workspace binding 在当前 run 内获得共享只读 base 上的独立可写 overlay；不同 run 绝不共享可写状态。Node backend 当前用 eager private copy 实现这个 copy-on-write 隔离契约；lease mode 规定的是隔离语义，而不是强制某种文件系统机制。Gold 只能通过 analysis-host map 投影。

文件身份是实际消费字节的 SHA-256。目录树身份使用 `omk.tree-sha256/v1`：条目按相对路径排序，并将条目类型、UTF-8 路径、文件大小、executable／non-executable mode 和文件字节纳入 framing。空目录参与身份；symlink 和特殊文件 fail closed。Pinned Git 还会验证精确的 `HEAD` commit 和干净的常规文件 checkout；dirty、untracked、ignored 或 submodule 内容不能冒充 commit 内容。根 `.git` metadata 在 resolve 与 lease 两个阶段的目录树身份中都会被排除。只有 snapshot 的实际 size 和 digest 都与 v2 descriptor 一致才会被接受。Acquisition 失败会清理部分创建的 run root；成功的 lease 暴露同一个幂等 `dispose()` promise，底层只尝试一次清理。

单资源和整个 run 的字节／条目上限都包含可写 overlay。计划的逻辑字节数在复制前就会被拒绝；条目上限则在有界资源物化过程中执行。错误只携带稳定 code 与 resource／binding identity，不包含 locator、secret 字节或 Gold 内容。结构合法但没有被 active binding 请求的 inventory entry 不会被打开、哈希、Git probe 或复制，以保持 no-Judge 副作用边界。

Composition root 在 Core 能调用任何 `openRun()` 前取得完整的 active-binding run lease。它验证 binding／resource 精确覆盖，捕获不可变 map 与 descriptor 快照，然后才注册 binding-scoped access。所有 Core port teardown settle 后先撤销注册，再执行一次 lease disposal。Acquisition、Core start 前取消、EventWriter 创建、Core start、正常完成与失败路径共享同一个幂等 cleanup promise。重复 active `runId` 会在第二次 acquisition 前被拒绝。用于 exploratory post-hoc comparison 的 Gold 不会被 single-run Core composition 提前物化；独立 analysis-host workflow 在存在真实消费者时再请求对应 lease。

## 六、Core Composition 与 Support Ports

`createOmkEvaluationRuntime()` 只消费一份完整的 `CliEvaluationCompileResult`；调用方不能在 `prepare()` 或 `start()` 传入替代 Definition／Policy。Composition root 会校验 compiled canonical digest、快照化全部宿主配置、合并 Core-owned Analysis schema validator 与 Runtime factory、装配 binding，并调用真实的 `createEvaluationEngine(...).prepare(...)`。独立 Series assembly 单独暴露，不进入 single-run engine。

Support port 被捕获为绑定原实例方法的不可变 view。是否必需完全由 sealed Policy 推导，且不会改写 Policy：

- execution／evaluation cache mode 非 disabled 时，必须提供对应 cache port，并精确绑定 `orchestration.cacheSources` 编译出的分阶段 source locator；
- output／trace 使用 reference capture 时，必须提供 Execution ContentStore；
- evaluator evidence 使用 reference capture 时，必须提供 Evaluation ContentStore；
- Evaluator 消费 reference-captured output／trace 时，必须提供 ContentResolver；
- required EventWriter mode 必须提供 run-scoped writer factory。

Clock 与 SchemaValidator contract 在 factory assembly 前校验。Core-owned Analysis validator 恒定合入。Validator key 必须等于完整 schema identity；同一 schema URI 出现另一 version、digest 或 validator 时 fail closed。Built-in Analysis、MissingPolicy 与 Decision factory 按 implementation ID 合并，宿主 factory 不能覆盖 Core-owned implementation。

EventWriter 不进入静态 `EvaluationEngineRuntime`。Optional／required delivery 会在 resource acquisition 后、Core start 前创建 writer，并通过 `PreparedEvaluation.start()` 注入；disabled mode 绝不调用 factory。Policy 要求的 port 缺失或形状错误时，在任何 Runtime factory 或 run port 调用前失败。因此不存在 Judge binding 时，也不会构造 Judge factory、读取凭证、执行 connectivity probe 或物化对应资源。

## 七、错误归属

- malformed input、coverage、duplicate、Definition mismatch、missing factory、factory failure 和 invalid port 在 Run 开始前使用稳定 `OmkRuntimeAssemblyError` code；
- compiled input、support port、cache source、schema conflict、writer construction、active run 与 host cleanup failure 使用稳定 `OmkEvaluationRuntimeError` code；
- capability、schema、protocol support、identity assurance 和 version satisfaction 仍由 Core preparation 报错；
- credential、connectivity 与 physical readiness 仍属于独立 adapter preflight；verified resource materialization 是 Core start 前的 run-scoped host failure；
- provider、session、attempt、cancellation 和 dispose failure 在 Run 开始后属于 Runtime port。

本层不修改冻结 prompt、五层评分、统计公式、cache 语义、Bundle／Report schema 或旧 pipeline。
