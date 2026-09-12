# 参考执行器 API（`oh-my-knowledge/eval-hosts`）

OMK 的产品宿主在本仓库内部使用各供应商适配器。这个子路径把它们作为**参考执行器**发布出来：输入普通配置，输出一个规范的 façade `Executor`。平台宿主仍然维护自己的 `registryId@version` 注册表，只下发 id 与配置，而供应商协议本身——参数拼装、JSONL 解析、进程控制——由 OMK 已验证的代码承担。`package.json#exports` 就是受支持边界；下面的白名单测试锁定每个值与类型在两份语言文档中的完整性。该入口与其他发布子路径一样只提供 ESM，CommonJS 宿主须用 `await import()` 加载。目前发布出来的只有 Codex CLI 一个适配器——其余内部适配器要达到同样的试点标准，才会进入这个入口。

## 这个入口刻意不做什么

- **没有注册表、发现、下载或动态加载。** OMK 不按名称解析适配器，也不会拉取或运行时加载代码。注册与版本治理始终在宿主侧，与[平台宿主集成指南](../guides/platform-host-integration)里的「id→实现注册表」契约一致。
- **不是私有宿主接缝。** `src/eval-workflows/hosts/adapters/**` 以及 composition、input-resolution、resource-lease 三层都不导出；深层导入会以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 失败。发布入口复用密封接缝里的供应商协议代码，但不暴露该接缝依赖的计划内机制。
- **不是能力升级。** 一切依赖计划内权威的能力——trial workspace 叠加、原生 MCP 配置、工具调用前 mock 拦截、逐用例工具白名单、runtime context 投影——都**失败关闭**并给出稳定错误码，而不是降级成更弱的隔离。供应商侧账号与网络隔离仍是宿主的责任。
- **不是对每个供应商版本的兼容承诺。** `CODEX_CLI_MIN_SUPPORTED_VERSION` 是本适配器验证过的最低供应商版本；见下文「支持面与版本漂移治理」。

## 导出清单

| 导出 | 用途 |
|---|---|
| `createCodexCliReferenceExecutor` | 装配 Codex CLI 参考执行器。它是异步的，因为返回前要先探测供应商可执行文件。 |
| `CreateCodexCliReferenceExecutorInput` | 全部已发布配置：`executorId`、`executablePath`、`model`，以及可选的 `effort`／`sandbox`／`environment`／`contentIdentityFiles`／`maxOutputBytes`／`maxPromptBytes`／`identityProbeTimeoutMs`／`fingerprintFacets`。 |
| `CodexCliEnvironmentEntry` | 一个环境变量：`value`，加上 `identity` 判别字段——其 `identityKind` 选定该值在 Runtime 身份中的角色（`behavior` 携带一份公开 `value`、`credential`、`effect-locator`）——以及可选的 `outputTaint`，它独立于该角色抬升输出与 trace 的处理等级。 |
| `CodexCliContentIdentityFile` | 额外参与内容身份指纹的文件：`{ facetId, path }`。 |
| `CODEX_CLI_MIN_SUPPORTED_VERSION` | 装配时强制执行的供应商版本下限。 |
| `CODEX_CLI_REFERENCE_ADAPTER_VERSION` | 本参考适配器的版本，写入身份指纹。 |
| `DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS` | 装配期版本探测的默认超时。 |

`executorId`、`executablePath` 与非空 `model` 必填。`codexCli` 这个指纹键由适配器保留：在 `fingerprintFacets` 里传入它会直接抛错，宿主因此无法用自己的标签覆盖供应商身份。

## 装配阶段：拿到执行器之前就会被拒的事

1. **配置固化。** `executablePath` 必须是绝对路径且不含 NUL；`model` 非空；`sandbox` 取 `read-only`／`workspace-write`，`effort` 取 `low`／`medium`／`high`／`xhigh`／`max`，两者都在装配期拒绝，而不是留给供应商报错；各类上限为正整数；每个 `CodexCliEnvironmentEntry` 都经过校验与分类。`credential` 条目会把输出与 trace 的处理等级抬到 `secret`，本接缝的下限是 `sensitive`，而 `outputTaint` 只会往上抬，声明它并不能把凭据降回更低的等级；取值本身绝不进入身份指纹，进入的只有分类后条目的摘要。
2. **内容身份采集。** 对可执行文件加上每个 `CodexCliContentIdentityFile` 计算摘要。
3. **版本探测。** 在 `identityProbeTimeoutMs` 内用声明的环境执行一次 `--version`。非正式发布串（例如 `0.146.0-alpha.1` 或 `nightly`）按不支持的版本格式拒绝；低于 `CODEX_CLI_MIN_SUPPORTED_VERSION` 的发布按低于支持下限拒绝。探测到的版本就是返回对象的 `executor.version`。
4. **复验。** 探测之后重新读取身份文件；一旦漂移就直接抛错，而不是把一个已经在脚下变过的二进制固化进指纹。

返回对象是冻结的，且只带 façade `Executor` 的字段：`executorId`、`version`、`schemas`、`outputClassification`、`traceClassification`、`outputMediaType`（`text/plain`）、`traceMediaType`（Source-Neutral Trace）、`capabilities`、`fingerprintFacets`、`execute`。任何供应商专有细节都不会漏出来，而自声明能力对一个随机性供应商 CLI 而言是诚实的：`determinism: 'stochastic'`、`cancellation: 'best-effort'`、`concurrency.safety: 'parallel-safe'`、`seedControl: 'unsupported'`、`telemetry.trace: 'optional'`、`telemetry.usage: 'optional'`、`telemetry.providerCost.reporting: 'unsupported'`。

## 执行阶段：稳定错误码，不外泄供应商细节

每次尝试都在私有的临时工作目录中运行，并在生成进程前复验身份文件；该目录在每条终止路径上都会被删除。不响应取消的供应商进程先收到 SIGTERM，再升级为 SIGKILL。供应商 stderr 与原始 stdout 永不返回：调用方只看到一个稳定错误码，以及协议确实解析出来时的用量记录。

| 错误码 | 含义 |
|---|---|
| `OMK_CODEX_CLI_ISOLATION_UNSUPPORTED` | 把租约式 workspace、MCP 配置或 mock 拦截计划交给了无法满足它的接缝。此时不会启动进程。 |
| `OMK_CODEX_CLI_TOOL_POLICY_UNSUPPORTED` | 请求了逐用例工具白名单。 |
| `OMK_CODEX_CLI_RUNTIME_CONTEXT_UNSUPPORTED` | 传入了宿主 `runtimeContext` 取值；本接缝能投影的载体是 artifact 加上 `executionContext`。 |
| `OMK_CODEX_CLI_ARTIFACT_UNSUPPORTED` | 知识载体不是本接缝可交接的非空字符串——空白载体，或目录形态的 Skill。`content: null` 的 `baseline` artifact 属于合法情形，按无载体运行。 |
| `OMK_CODEX_CLI_WORKING_DIRECTORY_UNAVAILABLE` | 无法创建尝试私有目录。 |
| `OMK_CODEX_CLI_IDENTITY_CHANGED` | 参与指纹的文件在采集与本次尝试之间发生了变化。 |
| `OMK_CODEX_CLI_EXIT_NONZERO` | 供应商进程非正常退出，且没有升级信号。 |
| `OMK_CODEX_CLI_UPGRADE_REQUIRED` | 供应商自己报告该模型需要更新的 CLI。 |
| `OMK_CODEX_CLI_TURN_FAILED` | 流解析成功但报告本轮失败；已记录的用量会保留。 |
| `OMK_CODEX_CLI_PROTOCOL_INVALID` | JSONL 流不是本适配器能理解的协议形态。 |
| `OMK_CODEX_CLI_OUTPUT_LIMIT_EXCEEDED` | 供应商输出超过 `maxOutputBytes`。 |
| `OMK_CODEX_CLI_STDIN_UNAVAILABLE`／`OMK_CODEX_CLI_SPAWN_FAILED`／`OMK_CODEX_CLI_CANCELLED` | 进程层面的基础设施失败，包括超时与被中止的尝试。 |

`OMK_CODEX_CLI_PROTOCOL_INVALID` 就是更新供应商版本时的漂移探测器：无法识别的流会失败关闭，而不会报回一个 OMK 无法归因的答案。

## 适配器记录的测量身份

这些指纹挂在 `codexCli` 下，由 Runtime 连同自身的 `facade` 指纹一起密封进执行身份的 `host` 半边。配置与二进制相同则摘要相同；任何能动模型答案的东西，也必须能动指纹。

| 指纹 | 内容 |
|---|---|
| `adapter` | `adapterVersion`、`seam: 'eval-runtime-facade'`、`sourceProtocol: 'codex exec --json'`、`cancellation: 'sigterm-then-sigkill'`、`processIsolation: 'per-attempt'`。 |
| `version-floor` | `minSupportedVersion`、`probeTimeoutMs`。 |
| `runtime` | `model`、`effort`（未设置时为 `null`）、`sandbox`。 |
| `launcher` | 绝对 `executablePath` 的摘要——字节完全相同的二进制换个位置，变的是这个指纹而不是 `binary`。 |
| `binary` | `coverage: 'declared-files-reverified-before-spawn'`，以及每个文件的 `{ facetId, digest, size }`。 |
| `environment` | 分类后的条目：必须保密的取值只留摘要，公开可复现的行为留原值。 |
| `limits` | `maxOutputBytes`、`maxPromptBytes`。 |
| `fixed-controls` | 本接缝写死的控制项：`approvalPolicy: 'never'`、`configMode: 'strict-ignore-user-config'`、`rules: 'ignored'`、`session: 'ephemeral'`、`shellEnvironmentInheritance: 'none'`、`workspaceRoot: 'attempt-private-temp-directory'`。 |
| `input-projection` | `version: 'omk.codex-cli-prompt/v1'`、`promptSchemaVersion`、`artifact: 'content-string-only'`、`envelope: 'canonical-json'`、`executionContext: 'executionContext-field'`、`task: 'sample-input-verbatim'`。 |

知识载体的**内容字节刻意不进入运行时身份**：载体正是受控对比要改变的东西，把它钉进身份会让对照组与实验组彼此不可比。密封计划仍然记录 artifact 摘要，因此载体可归因，但不属于被测对象身份。

## 支持面与版本漂移治理

- **CI 能验证的**是适配器自身对协议替身的行为：参数拼装与顺序、JSONL 解析规则、用量与 trace 映射、取消升级、每条终止路径的清理、身份漂移，以及上表每个失败关闭的错误码。随后 `oh-my-knowledge/eval-runtime` 的 `checkExecutor()` 会经由真实 Runtime façade 认证这个已发布执行器——成功、失败、取消、清理、telemetry、终止状态、覆盖度、evaluation-observation、paired-analysis 与 decision 各项检查。
- **CI 无法验证的**是真实供应商发布：这里不安装任何供应商二进制。因此 `CODEX_CLI_MIN_SUPPORTED_VERSION` 记录的是下限而非已测集合，OMK 也不对上限之上未测的版本作任何声明。上游意外变更会以 `OMK_CODEX_CLI_PROTOCOL_INVALID` 或 `OMK_CODEX_CLI_UPGRADE_REQUIRED` 暴露，绝不会把一个被静默重新解释的答案当作正常结果。
- **每次适配器变更的回归面**就是协议替身所钉住的下限版本：冻结的 `codex exec --json` 事件形状、参数向量，以及上表逐一列出的失败模式（非零退出、升级诱饵、畸形流、输出超限、取消、身份漂移）。先于下限升级供应商的宿主要把该版本当作未测：先跑 `checkExecutor()`，再用自有用例跑一次真实 Evaluation，才可信跨版本比较。
- **抬高下限**必须先对新供应商版本完成一次验证运行，并同步提升 `CODEX_CLI_REFERENCE_ADAPTER_VERSION`，同时作为发布说明项交付：低于新下限的宿主需要升级供应商 CLI 或改用其他执行器。它本身不改变测量语义，因为 `version-floor`、`binary`、`adapter` 已经在这次变更前后把指纹分区开了。
- **改动输入投影**——prompt 信封字节、`fixed-controls`、或任一 `codexCli` 指纹的含义——就是在改动模型看到什么，或如何推导被测对象身份。这属于 `BREAKING-COMPARABILITY`：提升 `input-projection.version`，在 PR 上标注对应标签，并预期新旧结果在看板上分区展示。
- **重命名、删除或改变形状**已发布的值、类型或配置字段属于 `BREAKING-SCHEMA`：白名单测试与两份语言 API 参考必须在同一个改动里更新，且不保留兼容别名。
- **凭据、网络出口与供应商账号**永远不进入这条边界。适配器只转发你显式声明的环境变量，并且对所有被判定为私有的取值只做摘要、不做记录。

## 相关阅读

- [平台宿主集成（评测中心类）](../guides/platform-host-integration) — 下发契约与参考执行器接入样板
- [Runtime API 参考](./eval-runtime-api)
- [执行器](./executors)
- [术语表](./glossary)
