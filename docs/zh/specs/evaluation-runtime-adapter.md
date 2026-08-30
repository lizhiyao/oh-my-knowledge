# Evaluation Runtime Adapter 规范

> **状态**：作为 [#457](https://github.com/lizhiyao/oh-my-knowledge/issues/457) 的 binding assembly 基础。本层是增量架构，不切换正式 `omk eval` pipeline。

## 一、边界

OMK 宿主完整消费 `compileCliEvaluationInput()` 的输出，并在 Evaluation Core 外执行 effect。Binding assembly 不创建第二套 plan、不重新解释 CLI 输入，也不把 registry 声明当成 Runtime 实际身份。

```text
EvaluationDefinition + RuntimeBindingRequest
                    │ exact coverage／immutable snapshot
                    ▼
        assembleOmkRuntimeBindings()
                    │ implementation factory resolution
                    ▼
  immutable binding entries + Core Runtime ports
                    │ actual identity／capabilities
                    ▼
       createEvaluationEngine().prepare()
                    │
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

Adapter 必须把 `sessionIsolationKey` 与 Core `runId`、`trialId` 组合使用；它不允许跨 run 或 binding 复用有状态 session。

## 四、资源需求

RuntimeBindingRequest 只记录资源角色和预期 lease mode，不记录 locator 或内容：

| 角色 | Lease mode |
|---|---|
| artifact、MCP config、mock payload、evaluator content | immutable snapshot |
| workspace | verified base + copy-on-write overlay |

这些只是 acquisition requirement。后续 Verified HostResource lease 层仍须在 port 打开 run 前验证 kind、classification、size、digest、实际字节／目录树、隔离和 exactly-once release。Gold resource 不得出现在 executor 或 evaluator binding requirement 中。

Lease acquisition 在首个 effect 之前同步复制并冻结全部 descriptor 和 binding request。随后它只物化 active binding 请求的资源，把源字节复制到 run 私有目录，并验证私有 snapshot，而不是继续消费 locator。Immutable snapshot 是只读的。每个 workspace binding 在当前 run 内获得共享只读 base 上的独立可写 overlay；不同 run 绝不共享可写状态。Node backend 当前用 eager private copy 实现这个 copy-on-write 隔离契约；lease mode 规定的是隔离语义，而不是强制某种文件系统机制。Gold 只能通过 analysis-host map 投影。

文件身份是实际消费字节的 SHA-256。目录树身份使用 `omk.tree-sha256/v1`：条目按相对路径排序，并将条目类型、UTF-8 路径、文件大小、executable／non-executable mode 和文件字节纳入 framing。空目录参与身份；symlink 和特殊文件 fail closed。Pinned Git 还会验证精确的 `HEAD` commit 和干净的常规文件 checkout；dirty、untracked、ignored 或 submodule 内容不能冒充 commit 内容。根 `.git` metadata 在 resolve 与 lease 两个阶段的目录树身份中都会被排除。只有 snapshot 的实际 size 和 digest 都与 v2 descriptor 一致才会被接受。Acquisition 失败会清理部分创建的 run root；成功的 lease 暴露同一个幂等 `dispose()` promise，底层只尝试一次清理。

单资源和整个 run 的字节／条目上限都包含可写 overlay。计划的逻辑字节数在复制前就会被拒绝；条目上限则在有界资源物化过程中执行。错误只携带稳定 code 与 resource／binding identity，不包含 locator、secret 字节或 Gold 内容。结构合法但没有被 active binding 请求的 inventory entry 不会被打开、哈希、Git probe 或复制，以保持 no-Judge 副作用边界。

## 五、错误归属

- malformed input、coverage、duplicate、Definition mismatch、missing factory、factory failure 和 invalid port 在 Run 开始前使用稳定 `OmkRuntimeAssemblyError` code；
- capability、schema、protocol support、identity assurance 和 version satisfaction 仍由 Core preparation 报错；
- credential、connectivity、filesystem readiness 和资源物化属于后续 adapter preflight／lease 层；
- provider、session、attempt、cancellation 和 dispose failure 在 Run 开始后属于 Runtime port。

本层不修改冻结 prompt、五层评分、统计公式、cache 语义、Bundle／Report schema 或旧 pipeline。
