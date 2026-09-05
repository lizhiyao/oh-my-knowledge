# Evaluation Runtime Adapter 规范

> **状态**：本规范已成为正式生产宿主边界。binding assembly、verified resource lease、adapter preflight、非阻塞事件投影、Core composition root，以及 factory registry／support port 现已驱动 `omk eval`。

## 一、边界

具体宿主装配位于 `eval-hosts`，与 Runtime 层分离。`createOmkRuntimeProvider()` 在这个外层边界
接收产品编译产物，返回 Runtime 拥有的 `EvaluationRuntimeProvider` 能力。Workflow 显式接收该能力
和验证器，准备评测时只传入 `EvaluationExecutionInput`。它没有默认 Node 工厂、租约目录或直接
执行 Core engine／Series 的路径。产品 analysis 和 evaluator 实现在 `eval-workflows/measurement`，
通用生命周期与 Series 执行归 Runtime。


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
       createEvaluationExecution().prepare()
                    │ Runtime 执行接口
                    ▼
       createEvaluationEngine().prepare()
                    │ actual identity／capabilities
                    ▼
              SealedRunPlan
```

独立 Series 分析装配为 `EvaluationSeriesRuntimePorts`，绝不进入 `EvaluationEngineRuntimeBindings`。装配保留 Core Series analysis 和 decision port 的 `openRun` 生命周期及每次运行的清理接口，不再转换为旧的顶层 `analyze／decide` 回调。

## 二、Binding 完整覆盖

Assembly 要求以下每个引用都有且只有一个 binding：

- Target executor 和 Evaluator；
- AnalysisGraph node，以及独立的 Sampling Estimator requirement；
- MissingPolicy 和 DecisionPolicy；
- Series analysis node 和 Series decision policy。

Analysis binding 同时携带 `referenceId` 和 Core `requirementKind`。Sampling Estimator 不再从 AnalysisGraph node 猜测，也不能由 fallback registry 静默解析。

完整结构使用 `omk.runtime-binding-request/v5`。Evaluator binding 会封存可选的宿主声明 judge deployment revision；未声明 revision 时，远端 provider identity 保持 opaque。

调用任何 factory 前，assembly 会验证 binding ID／reference key 唯一性、Definition／Series 精确覆盖、implementation／version、executor protocol／model／effort／behavior digest、evaluator measurement／config digest，以及 resource lease requirement。验证失败时 factory 调用次数必须为零。

## 三、不可变 Entry 与身份

Assembly 首先复制并深度冻结 Definition、Series 和 RuntimeBindingRequest。Factory 按 `implementationId` 查找，但按 binding 分别调用，因此共享同一实现的两个 reference 仍得到不同 port instance。

`createProductionRuntimeFactoryRegistry()` 是 Codex CLI／SDK、Claude CLI／SDK、OpenAI API、Anthropic API、custom command，以及 OMK 自有 scoring／analysis 实现的唯一生产映射。它先快照化配置并暴露不可变 map view，不调用未使用的 factory。Executor preflight declaration 是必填宿主输入，并与同一配置一起捕获；registry 不伪造 doctor、credential、connectivity、filesystem、MCP 或 mock 检查成功。Node support port 共享一个校验 digest 的 content store 实例，clock 也必须显式传入。

Factory 返回实际 port identity 和 version resolution。Assembly 校验 port 形状与 implementation identity，捕获不可变 identity snapshot，并用原始实例的方法包装 port。Executor binding 还必须与 `TargetDefinition.executionRequirements` 精确相等；qualification 直接复用该 canonical 值，不重新派生 feature 语义。Core preparation resolver 和运行 port 由同一个 entry 投影；后续 registry 或请求对象变化不能造成 split-brain。只有 Core 能把 requirements 与实际 port capability manifest 做匹配。

每个 entry 保存：

- 完整 binding 和实际 `RuntimeResolution`；
- 捕获后的 port；
- 显式 resource lease requirement；
- 由完整 binding 派生并传给对应 factory 的 binding-local `sessionIsolationKey`。
- 仅向 Executor／Evaluator factory 提供 binding-scoped resource access view；它按当前 Core `runId` 取 lease，不能枚举其它 binding 或 analysis-only resource。

Adapter 必须把 `sessionIsolationKey` 与 Core `runId`、`trialId` 组合使用；它不允许跨 run 或 binding 复用有状态 session。

## 四、Adapter preflight

Preflight 是 Core 权威 prepare 完成后的宿主物理就绪阶段。它不属于 Evaluation Core，不创建宿主计划，也不能让被 Core 拒绝的 Runtime 获得资格。Factory 必须把显式 preflight declaration 数组与 port、实际 Runtime identity、version result 一并返回。空数组表示有意声明没有检查项；字段缺失则是非法 factory result。四项结果来自同一次 factory 调用，避免独立 check registry 解析出另一套实现或 binding。

每条 declaration 都有稳定 ID，角色只能是 `doctor`、`credential`、`connectivity`、`filesystem`、`mcp-readiness` 或 `mock-readiness`，并且只能选择一种 disposition：

- `check` 捕获 callback；其输入只有冻结、不含 secret 的 binding metadata，以及调用方可选的 `AbortSignal`；
- `not-required` 携带稳定且不敏感的 reason code，不包含 callback。

Executor binding 必须声明可执行 doctor check，以及 credential、connectivity disposition。需要资格认证的 Evaluator 必须声明 credential 与 connectivity disposition。任何带 resource requirement 的 binding 都必须声明 filesystem check；MCP 与 mock 角色还必须声明对应的物理就绪检查。系统会在第一次执行 callback 前验证所有 active binding 的覆盖情况，即使 doctor 或 connectivity 被配置为跳过也不例外。因此 skip 只能抑制一条已声明 callback，不能让不完整 adapter 变合法，也不能把真实的 `not-required` 伪装成 `skipped`。

Runner 只消费已编译的 orchestration mode，不读取 CLI flag。Composition root 先调用 `EvaluationEngine.prepare()`；启用 Independent Series 时还会调用 `prepareEvaluationSeriesPlan()`。因此无论采用哪种 skip mode，single-run 与 Series 的 schema、reference、capability、identity 和 sealed-policy 检查都保持权威。之后按 `bindingId` 排序 active binding entry，保留每个 entry 已捕获的 declaration 顺序，并串行执行检查。任一失败都会阻止后续 effect，只公开稳定的 binding／check metadata；callback error 与其返回的 diagnostic 不会透传。Check 只返回 `void`，避免任意 diagnostic payload 形成未分类的证据通道。

调用方传入的准确 signal 会被原样转交。取消发生后，active check 必须真正 settle，preflight 才会 reject；runner 不使用可能把 credential、network 或 filesystem 操作遗留在后台的 race。生成的不可变 record 保存在 `OmkPreparedEvaluation.preflight`。Definition、MeasurementPolicy、RuntimeBinding、不可变 binding entry 与 `SealedRunPlan` 均不改变，也不会传给 check。

Preflight 只证明探测时刻的就绪状态，不能把 locator 变成 content identity，也不会为稍后的 run 预留资源。Run start 仍须依据实际字节或目录树获取并复核 verified resource lease。同理，如果没有 Judge binding，就绝不调用其 factory，因此不会发生 Judge declaration、credential read 或 connectivity probe。

## 五、Event projection

CLI progress 不是 `EventWriter`。EventWriter delivery 属于 sealed MeasurementPolicy：它可能施加阻塞 backpressure，配置要求的 writer 失败也可能让 run 失败。展示层不能获得这些权力。宿主会消费 Core 有界的 `EvaluationRun.events`，只把已经发布的 event 投影到独立展示路径。

投影保留 `eventId`、`sequence`、`runId`、`eventKind`、时间与 subject，使输出仍可追溯到 Core event；它只从 `eventKind` 派生 source-neutral 的 stage 与 status。任意 event `data` 都有意排除，避免 provider error、evidence、coverage payload 或未来扩展内容进入未分类 UI 通道。Subject 与 run identity 继续使用 Core event contract 定义的 canonical 非敏感标识。

接入 progress sink 时，宿主会立即消费 single-consumer Core stream，并分流到两个有界、非权威的路径：

- 提供给调用方、同样采用 drop-oldest 行为的 raw-event mirror；
- 拥有独立容量、与权威运行脱离的 renderer queue。

缓慢或永不 settle 的 renderer 只能填满并覆盖自己的展示队列。调用方若从不消费 raw mirror，也只会丢失旧展示历史。Renderer reject、同步 exception、close failure、event-consumer failure 或 sink 已关闭，都不能改变 `EvaluationRunResult`、资源清理、取消、预算、重试、EventWriter policy 或终态 artifact。Run start 发生 effect 前会捕获 sink method identity，后续对象变更不能替换 active run 背后的 renderer。

同进程 JavaScript 无法隔离一个故意以同步 CPU 工作阻塞 event loop 的 callback。因此 sink contract 要求 `render()` 迅速返回，并把昂贵渲染放到自己的异步边界后。宿主队列可以隔离 Promise 延迟与失败；CPU 隔离需要 worker 或独立进程，不属于本 adapter 边界。

## 六、Same-process Runtime adapter

`createSameProcessExecutorAdapter()` 与 `createSameProcessEvaluatorAdapter()` 是 binding-local 同进程实现的基准桥接层。宿主必须显式提供 `RuntimeIdentity` 和全部生命周期回调；adapter 不从 Definition 推断 capability，也不提供评分算法。

桥接层会在构造时校验并冻结 identity，捕获 lease resolver 与回调函数，并为每个 run、trial／evaluation record 派生独立的内容寻址隔离键。因此，工厂对象后续发生变更，也不能在已封存的 identity 背后替换实际执行实现。重复的 active run 与 operation identity 会 fail closed；即使调用方并发或重试清理，每个 dispose 回调也至多执行一次。

Core attempt 的 `AbortSignal`、trial seed、Target／Evaluator 配置、已验证的 binding lease 与可选 usage 会原样转交。未报告 usage 时仍保持缺失。桥接层不拥有独立 timeout、retry、budget、cache 或 cancellation race；这些行为只由 sealed Core Policy 驱动。Cooperative implementation 收到转交 signal 的 abort 后，必须让底层操作真正收敛。

Composition root conformance 使用 `test.*` 命名空间下、根据输入和 binding 动态生成结果的实现。它们会经过真实 Core prepare 与 run 路径，但不会被导出或伪装成生产 Executor／Evaluator 算法。

## 七、Custom-command Runtime adapter

`createCustomCommandExecutorAdapter()` 是进程外 Runtime 的基准桥接层。它接受 sealed Target 与 RuntimeBinding、绝对 executable path、显式 argument vector，以及完整且逐项分类的 child environment。每个环境变量必须分类为公开 behavior identity、credential 或 effect locator；behavior identity 进入 Runtime facet，credential 与 locator 的值既不持久化，也不计算持久化 hash。Adapter 不启动 shell、不搜索 `PATH`、不继承 `process.env`／`process.cwd()`、不解析 command string，也不接受任意 live directory。它从准确的 sample-scoped Trial control 选择工作目录：需要 workspace 时从已验证快照创建新的 Trial 私有副本，否则创建空的 Trial 私有目录；两者均在 Trial 结束时删除，从执行契约中排除宿主环境漂移、可变目录 locator 与 shell quoting 差异。

每次 attempt 只启动一个进程，并通过 stdin 发送一份 canonical `omk.custom-command-exchange/v1` JSON 文档。文档只包含 Core run／trial／attempt context、准确的 effective execution control、内容寻址的 isolation key，以及当前 Trial 已验证的 resource lease 投影。Resource entry 按 resource ID canonical 排序。自定义 Runtime 实现本身是每个 executor binding 中一项 sensitive、内容寻址的资源；adapter 只启动其 Run 级 immutable snapshot，绝不启动原始 locator。adapter 会拒绝与 sealed Target 不一致的 Trial control，要求 binding lease 精确覆盖，并从 child request 中排除 Runtime 实现及其它 Sample 的全部 workspace。Gold classification 和 analysis-only resource kind 会在创建进程前 fail closed。响应是严格、source-neutral、带版本的文档：成功响应可包含 output／trace 和已报告 usage；结构化失败只暴露稳定 code 与 execution／infrastructure stage。未报告 usage 继续保持缺失；多余字段和非法 JSON fail closed；child stderr 不进入 Core error。

这版 process-per-attempt contract 只支持 `omk.invoke/v1`，不声明 `omk.session/v1`。Session adapter 必须真正持有 per-trial 隔离 session 的生命周期，不能把互相独立的子进程伪装成保留了对话状态。

Adapter 把 Core attempt 的原始 `AbortSignal` 直接交给进程协调器；协调器先发 SIGTERM，再以有界 SIGKILL 兜底，并等待 child 真正 settle。即使 child 捕获 SIGTERM 后以零码退出，取消仍是权威结果。Adapter 不拥有 timeout、retry、budget 或 cache。每条输出流另有显式 byte limit 作为宿主内存保护；该限制进入 Runtime implementation facet，不属于 measurement Policy。

Custom-command identity 采用保守模型。每个 assembly 周期都重新解析，不使用进程级缓存。若宿主明确提供本地实现文件，adapter 会对实际字节计算 hash，记录 canonical role／digest／size 证据，并在每次 spawn 前复核；由于 adapter 无法证明调用方列出的文件覆盖完整，assurance 仍为 `declared`。没有内容证据时，basis 是 `opaque`，assurance 是 `unknown`。Argument、executable path digest、分类后的 environment identity、sample-scoped 工作目录执行方式、输出限制、exchange version、进程组合与 identity coverage 都作为不泄露 secret 的 implementation facet 捕获。因此，command string 或 path 本身绝不可能产生 `verified` identity。Capability 是 factory 持有的固定 manifest，不根据 Target requirement 动态补齐，并且必须诚实声明本 adapter 的 best-effort cancellation 与 per-invocation stateless lifecycle。

## 八、Codex CLI Runtime adapter

`createCodexCliExecutorAdapter()` 是首个 provider-family Core adapter。它绑定一份已编译 Target 及其准确的 Executor binding；解析 identity 前，target ID、implementation ID、protocol、execution requirement、execution-control digest、behavior digest、model 与 effort 必须一致。它只支持 `omk.invoke/v1`。每次 Core attempt 都以 sealed model／effort、Trial 私有 workspace 副本或空的 Trial 私有目录启动全新的 `codex exec --json` 进程，并发送 canonical `omk.codex-cli-prompt/v1` JSON envelope。Sample control 不一致时会在创建进程前失败；Codex 只能声明 runtime-default tool surface，因此任何 allow-list 都会在 adapter prepare 阶段失败。Envelope 只包含 knowledge artifact、sample input，以及 `ExecutorTrialContext` 暴露的 execution context；expected output、evaluation context、analysis membership 与 Gold 绝不进入 adapter。文件 artifact 成为一个显式 instruction 字段。目录 artifact 必须在根部提供 `SKILL.md`：只有该入口具有 instruction 语义，其余按 canonical path 排序的 UTF-8 文件会投影为 supporting resource，不会提升为 instruction。缺失入口、非 UTF-8 文件、symlink 与特殊文件均 fail closed。这保留了 Codex CLI 单 prompt 边界中 normative instruction 与 supporting asset 的语义差异，不宣称原生 filesystem-backed skill loading。

进程控制遵循当前 [Codex CLI reference](https://developers.openai.com/codex/cli/reference) 与 [non-interactive execution guidance](https://developers.openai.com/codex/noninteractive)：临时 session、忽略用户配置、忽略项目／用户 execpolicy 规则、严格配置解析、非交互 approval、显式 sandbox、显式 working directory、JSONL 输出与关闭 stdin。Child 接收完整的分类环境，不继承 `process.env`；Codex 创建的 shell command 也不继承宿主环境。Adapter 不拥有 timeout、retry、budget 或 cache；它把 Core 的准确 `AbortSignal` 交给子进程协调器，并等待 SIGTERM／SIGKILL 真正 settle。

每次 adapter assembly 都重新解析 Codex identity。Adapter 对实际 executable 与显式列出的 implementation file 计算 hash，使用捕获的准确 launcher 执行 `--version`，确认探测期间字节未变化，并在每次 attempt 前再次验证。Version probe 使用独立、有界、记录在 implementation facet 中的 assembly-safety timeout；它不是 measurement attempt timeout，不能取消或重试 provider 工作。证据来自内容，但 assurance 仍为 `declared`：wrapper 或调用方提供的文件列表无法证明覆盖全部 native helper、dynamic library、remote deployment 或服务端模型 revision。Model、effort、behavior digest、adapter composition、prompt projection、固定 control、limit、分类环境 identity 与 launcher identity 都保留为 implementation facet，即使它们没有进入 binary-content fingerprint。

Capability manifest 有意比旧 CLI executor 更窄。它声明 prepend system instruction、可选 source-neutral trace／usage、copy-on-write workspace、runtime-default tool／skill discovery、best-effort cancellation，以及两个明确的 read-only／workspace-write sandbox ID。执行仍保持串行；Trial 私有目录本身不足以证明 provider 的全部状态都支持安全并行。它不声明 deterministic seed control、MCP config、mock interception、tool allow-list、skill disable／allow-list、provider cost 或 session protocol。Target 要求任一不支持能力时，Core 会在 provider call 前拒绝。特别是 Codex 具有随机性，当前 CLI／[configuration surface](https://developers.openai.com/codex/config-reference) 不暴露准确 sampling seed；不能仅把 trial seed 写入 prompt，就声称实现了 controlled seed coupling。

JSONL 边界严格验证 event／item family、lifecycle closure、terminal status、最终 assistant output 与安全 token count。Provider event 投影为既有 source-neutral turn／tool-call trace；raw event 与 stderr 不返回 Core。未上报 usage 与 provider cost 继续保持缺失。已报告 input／output token 原样保存，cached／reasoning token 保留为具名 detail；可信 terminal usage record 可以伴随被脱敏的 failure，但不能把 failure 变成 success。`createCodexCliCoreSchemaValidators()` 从计算 advertised schema identity 的同一组 input／output／trace contract 派生 validator，composition root 无需维护宽松或独立的 provider-schema registry。

## 九、Claude CLI Runtime adapter

`createClaudeCliExecutorAdapter()` 把一次 attempt 一个进程的 Claude Code Runtime 绑定到 `omk.invoke/v1`。在探测 executable 前，会捕获 Target、binding、model、受支持 effort、execution requirement、execution-control digest、behavior digest 与准确的聚合 resource requirement。每个 Trial 都会与 sealed sample control 核对，只得到自己的 workspace 与 built-in tool allow-list。每次 attempt 获得私有 `CLAUDE_CONFIG_DIR`、通过 stdin 输入的 canonical user envelope，以及由 verified artifact entrypoint 生成的可选原生 system-instruction file。目录 artifact 要求根部存在 `SKILL.md`；其它 UTF-8 文件继续在 user envelope 中显式标记为 supporting resource，绝不提升为 system instruction。Expected answer、evaluation context、analysis membership 与 Gold resource 不会跨过 Executor 边界。

启动契约遵循当前 [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)、[settings precedence](https://code.claude.com/docs/en/configuration) 与 [memory controls](https://code.claude.com/docs/en/memory)：stream JSON、verbose event、禁用 session persistence 与 Chrome integration、不读取普通 user／project／local setting source、使用严格且显式的 MCP config、禁用 CLAUDE.md／auto-memory、把 `@file` 当字面输入而非隐式展开、禁用持久后台任务、updater 与非必要流量。Prompt content 不放入 argv。这组更窄的控制保留显式 runtime-default skill／plugin；不会采用更宽的 `--bare`，因为它会静默违背已声明能力。Assembly 会拒绝低于审计基线的版本、prerelease build，以及 help surface 缺少任一必需 flag 的准确 launcher。Child 只接收完整分类环境与 adapter 自有 control，绝不继承 `process.env`。Child tool 可以检查环境，因此 credential entry 会把 output／trace 污染为 secret，effect locator 则污染为 sensitive。系统不声称能够抑制 host-managed setting、managed instruction 与 managed MCP policy。由于这些状态和 remote model deployment 仍不透明，即使 executable 与全部已声明 implementation file 都经过内容 hash 和 spawn 前复核，identity assurance 仍为 `declared`。

Native MCP config、PreToolUse mock interception、built-in tool allow-list、runtime-default skill discovery 与完整 skill disablement，只在 CLI 可强制执行的组合中受支持。不支持的组合会在 adapter assembly 或 open run 时失败：存在 dynamic MCP tool 时，built-in allow-list 不能冒充完整 policy；MCP mock server 名称不能与 sealed MCP config 冲突；非空 skill allow-list 会被拒绝；系统不声明任何 sandbox ID。Mock rule 与 payload 只来自独立 secret verified lease。任何模型进程启动前都会验证规则；每次 retry attempt 都重新物化 payload，并在 child settle 后移除。配置的 Node launcher 本身属于 content identity；没有 mock interception 时，它不会被加入 PATH 或 Runtime identity。

Capability 固定且由源码持有：串行 stochastic execution、best-effort cancellation、per-invocation stateless protocol、必需 source-neutral trace、可选 usage 与 provider-reported USD cost、不支持 seed control，也没有 sandbox。Adapter 只负责有界 stdin／stdout materialization、identity probe、process coordination 与 cleanup；timeout、retry、cache、budget 与 admission 只由 Core 持有。JSONL 必须包含一个结构一致的 terminal result；malformed conversation record、不一致 success flag、重复 terminal、不安全 counter、溢出 cost、terminal 后继续输出 conversation，以及 success 缺失 output，都会 fail closed，且不会暴露 stderr 或 provider error text。

## 十、Claude SDK Runtime adapter

`createClaudeSdkExecutorAdapter()` 把可选的 `@anthropic-ai/claude-agent-sdk` Runtime 绑定到同一 Core protocol，不经过旧 `ExecutorFn`。它遵循官方 [TypeScript Agent SDK contract](https://code.claude.com/docs/en/agent-sdk/typescript)：每个 Core attempt 创建全新 `query()`，获得独立 `AbortController` 与私有 `CLAUDE_CONFIG_DIR`，消费原生 async message stream，并在 attempt cleanup 前关闭 query。Core 继续独占 timeout／retry／budget／cache。Adapter 不使用旧进程级 SDK cache、SIGINT subscriber、wall-clock timeout、debug transcript 或补零 usage fallback。

Assembly 解析 SDK package 及其 platform-specific bundled Claude Code package，不使用进程级 identity cache。SDK package tree、native package tree、manifest、entrypoint 与准确 executable 都会计算 content hash，并在每次 query 前复核；SDK version 与 bundled Claude Code version 是两个独立 identity facet。Remote deployment 与 host-managed policy 仍不透明，因此 assurance 为 `declared`。可信 resolver seam 只用于离线 conformance 与替代宿主解析，并且必须提供相同的最低 identity coverage。

SDK 接收完整分类环境而非 `process.env`；没有 MCP lease 时接收显式空 MCP config；filesystem setting source、CLAUDE.md、auto-memory、attachment 与 session persistence 均关闭，同时启用严格 MCP validation、带 verified artifact append 的 Claude Code preset system instruction，以及与 CLI family 相同的 canonical supporting-resource envelope。Built-in tool allow-list 会禁用 dynamic MCP tool；skill discovery 只能是 runtime-default 或完全关闭。SDK PreToolUse mock 每次 attempt 都重新创建，并且只有 sealed MCP config 中存在对应 server 时才能拦截其 tool。Output 与 trace 继承 resource／environment 的最强 classification。Provider message 共用严格的 Claude terminal／usage／trace parser，但采用 SDK 专属 schema identity 与稳定 failure code。

## 十一、资源需求

RuntimeBindingRequest 只记录资源角色和预期 lease mode，不记录 locator 或内容：

| 角色 | Lease mode |
|---|---|
| artifact、MCP config、mock rule、mock payload、evaluator content | immutable snapshot |
| workspace | verified base + copy-on-write overlay |

这些只是 acquisition requirement。后续 Verified HostResource lease 层仍须在 port 打开 run 前验证 kind、classification、size、digest、实际字节／目录树、隔离和 exactly-once release。Gold resource 不得出现在 executor 或 evaluator binding requirement 中。

Lease acquisition 在首个 effect 之前同步复制并冻结全部 descriptor 和 binding request。随后它只物化 active binding 请求的资源，把源字节复制到 run 私有目录，并验证私有 snapshot，而不是继续消费 locator。Immutable snapshot 是只读的。Workspace binding lease 只暴露已验证的只读 base。Codex CLI／SDK、Claude CLI／SDK、DSH 和 custom-command adapter 在每个 Trial 开始时创建私有可写副本，在 Trial 结束时释放；没有绑定 workspace 的 Trial 从空的私有目录开始。同一 Trial 的 attempt 保留目录状态，不同 Trial 和 run 绝不共享可写工作目录。Run 不再分配可写 overlay。Node backend 当前用 eager private copy 实现这个 copy-on-write 隔离契约；lease mode 规定的是隔离语义，而不是强制某种文件系统机制。Gold 只能通过 analysis-host map 投影。

文件身份是实际消费字节的 SHA-256。目录树身份使用 `omk.tree-sha256/v1`：条目按相对路径排序，并将条目类型、UTF-8 路径、文件大小、executable／non-executable mode 和文件字节纳入 framing。空目录参与身份；symlink 和特殊文件 fail closed。Pinned Git 还会验证精确的 `HEAD` commit 和干净的常规文件 checkout；dirty、untracked、ignored 或 submodule 内容不能冒充 commit 内容。根 `.git` metadata 在 resolve 与 lease 两个阶段的目录树身份中都会被排除。只有 snapshot 的实际 size 和 digest 都与 v2 descriptor 一致才会被接受。Acquisition 失败会清理部分创建的 run root；成功的 lease 暴露同一个幂等 `dispose()` promise，底层只尝试一次清理。

单资源和整个 run 的字节／条目上限约束取得的 snapshot。Trial 副本受已验证 base 的大小限制；这不是 provider 后续新建文件的磁盘配额。计划的逻辑字节数在复制前就会被拒绝；条目上限则在有界资源物化过程中执行。错误只携带稳定 code 与 resource／binding identity，不包含 locator、secret 字节或 Gold 内容。结构合法但没有被 active binding 请求的 inventory entry 不会被打开、哈希、Git probe 或复制，以保持 no-Judge 副作用边界。

**BREAKING-COMPARABILITY：** Trial 工作区隔离修正了原先共享 run 目录的行为。Codex CLI／SDK、Claude CLI／SDK 和 DSH adapter implementation version 更新为 `2.0.0`；custom-command 在工作目录 facet 中封存 `trial-private-sealed-snapshot-v2`。新身份将修正后的执行条件与旧报告区分开。要建立可比基线，需要重新评测；不提供恢复旧目录共享行为的兼容模式。本次修正不改变 prompt 字节、评分和统计、Core Schema 或报告存储格式。

Runtime 通过 `createEvaluationExecution()` 持有运行生命周期。接口只接收 Core Definition、MeasurementPolicy、可选运行元数据、显式 engine port，以及可选的宿主 `acquireRun` 回调，不依赖 Workflow／CLI 类型。Prepare 在物理 preflight 前封存 Core Plan；start 获取宿主资源、激活 binding-scoped access，只有获取成功且未取消时才启动 Core。调度、超时、重试和预算仍由 Core 独占。

宿主验证 binding／resource 精确覆盖并快照化租约描述符。返回的租约提供 `activate()`、可选 EventWriter 和 `close()`。Runtime 在 Core teardown 后、activation 失败或 start 失败时准确调用一次 close。资源清理完成前，active run ID 不允许重用。仅用于探索性事后比较的 Gold 由其独立消费者获取。

取消信号传递给资源获取和 EventWriter 构造。Node 在复制、哈希文件时检查取消，并向 Git 验证传递信号。即使自定义宿主忽略信号，Runtime 也会立即拒绝已取消的 start。取消错误通过 `cleanup` promise 暴露迟到获取操作和租约清理的最终结果，迟到租约绝不激活。不配合取消的宿主可能延迟资源释放，但不能在取消后启动测量；迟到的获取或清理失败仍可被观察。

已有 Core 结果后发生清理失败时，Runtime 抛出 `EvaluationRuntimeLifecycleError`，并在 `runResult` 中保留原始结果。产品持久化路径仍保存完整证据链。CLI 和 DSH 等待持久化后再返回运行错误；Series 的任一 member 发生运行拒绝时，即使报告成功保存，也会拒绝本次发布与自动迭代。保存测量证据不等于批准失败的宿主生命周期通过发布门禁。

## 十二、Core Composition 与 Support Ports

`createOmkEvaluationRuntime()` 只消费一份完整的 `CliEvaluationCompileResult`；调用方不能在 `prepare()` 或 `start()` 传入替代 Definition／Policy。Composition root 会校验 compiled canonical digest、快照化全部宿主配置、合并 Core-owned Analysis schema validator 与 Runtime factory、装配 binding，再把测量声明和注入端口传给 Runtime 拥有的 `createEvaluationExecution()` 接口。独立 Series assembly 单独暴露，不进入 single-run engine。

Support port 被捕获为绑定原实例方法的不可变 view。是否必需完全由 sealed Policy 推导，且不会改写 Policy：

- execution／evaluation cache mode 非 disabled 时，必须提供对应 cache port，并精确绑定 `orchestration.cacheSources` 编译出的分阶段 source locator；
- output／trace 使用 reference capture 时，必须提供 Execution ContentStore；
- evaluator evidence 使用 reference capture 时，必须提供 Evaluation ContentStore；
- Evaluator 消费 reference-captured output／trace 时，必须提供 ContentResolver；
- required EventWriter mode 必须提供 run-scoped writer factory。

Clock 与 SchemaValidator contract 在 factory assembly 前校验。Core-owned Analysis validator 恒定合入。Validator key 必须等于完整 schema identity；同一 schema URI 出现另一 version、digest 或 validator 时 fail closed。Built-in Analysis、MissingPolicy 与 Decision factory 按 implementation ID 合并，宿主 factory 不能覆盖 Core-owned implementation。

EventWriter 不进入静态 `EvaluationEngineRuntime`。Optional／required delivery 会在 resource acquisition 后、Core start 前创建 writer，并通过 `PreparedEvaluation.start()` 注入；disabled mode 绝不调用 factory。Policy 要求的 port 缺失或形状错误时，在任何 Runtime factory 或 run port 调用前失败。因此不存在 Judge binding 时，也不会构造 Judge factory、读取凭证、执行 connectivity probe 或物化对应资源。

## 十三、错误归属

- malformed input、coverage、duplicate、Definition mismatch、missing factory、factory failure 和 invalid port 在 Run 开始前使用稳定 `OmkRuntimeAssemblyError` code；
- compiled input、support port、cache source、schema conflict 与 writer construction 使用稳定 `OmkEvaluationRuntimeError` code；
- active run、启动前取消、非法 run lease 和 cleanup failure 归属 Runtime 的 `EvaluationRuntimeLifecycleError`，不保留旧错误码别名；
- capability、schema、protocol support、identity assurance 和 version satisfaction 仍由 Core preparation 报错；
- credential、connectivity 与 physical readiness 仍属于独立 adapter preflight；verified resource materialization 是 Core start 前的 run-scoped host failure；
- provider、session、attempt、cancellation 和 dispose failure 在 Run 开始后属于 Runtime port。

本层不修改冻结 prompt、五层评分、统计公式、cache 语义、Bundle／Report schema 或旧 pipeline。

## 十四、故障隔离与依赖边界

Composition root 把每个 `runId` 视为独立 failure domain。并发 run 拥有彼此独立的 lease registration、adapter session、raw-event mirror、progress queue、cancellation signal 与 teardown promise。取消一个进行中的 run，不能取消另一个 run、向对方的 event／progress channel 发布内容，或释放对方资源。Runtime port lifecycle 与宿主 lease 都只在各自 run settle 后准确释放一次。

Fault-injection 覆盖 acquisition 前失败、acquisition 过程失败、EventWriter 构造失败、Core start／execution 失败、非权威 progress rendering 失败，以及 Runtime／lease disposal 失败。每个已获取租约汇入单次清理。获取期间取消绝不启动 Core；迟到的宿主获取结果通过取消错误的 cleanup promise 观察。

源码依赖守卫同样保护 Evaluation Core。Core TypeScript 只能导入 `src/eval-core` 内其它文件、`zod` 或 `node:crypto`；不能导入 CLI、宿主 orchestration、filesystem API、provider SDK，也不能读取环境态 `process.env`／`process.cwd()`。这让架构边界成为 CI 可执行规则，而不只是一项约定。
