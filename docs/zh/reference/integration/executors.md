# 执行器

**执行器**负责按样本输入、知识载体和运行条件调用被测系统，返回输出与可提供的执行证据。`--executor` 选择调用方式：CLI、SDK、HTTP API 或你的可执行适配器。比较知识版本时，应固定模型、执行器与运行条件。同一份考卷可以复用，但不同执行器的身份与分数不能视为同一测量条件。

## 选择输入与执行器

1. 编写同一套 [v3 样本](../evaluation/eval-sample-format.md)：任务写入 `input`，运行条件写入 `executionContext`，参考结果与评分声明写入 `expected`／`evaluationContext`。按任务数据选择 `text`、`json` 或 `messages`，无需为 prompt、RAG、skill、agent、workflow 分别设计考卷格式。
2. 查看[输入支持矩阵](../evaluation/eval-sample-format.md#输入与适配器支持)。CLI／SDK 适配器接收文本；API 适配器还支持 JSON 与普通角色历史。工具历史等应用协议通过[自定义执行器](#自定义执行器)接入。支持某种输入不等于支持工具、工作目录或保证某种输出格式。
3. 比较版本时固定样本文件与评分声明，配合选定的 control、treatment 和 model 使用 `--samples ./eval-samples.json --executor openai-api`；自己的适配器使用 `--executor ./my-executor.mjs`。`--dry-run` 检查编译与声明的要求，不能证明被测系统实际执行成功。

## 内置执行器

| 执行器 | 适用场景 | 说明 |
|--------|----------|------|
| `codex` | Codex / ChatGPT desktop 编程任务（CLI） | 通过 `codex exec --json` 调用，需本地装好登录的 codex（`@openai/codex`）；best-effort tool trace，**costUSD 不报**（codex 自身不输出 USD，需外部账单核算） |
| `codex-sdk` | Codex agent 评测（SDK） | 通过 `@openai/codex-sdk` 调用其自带的 `@openai/codex` binary 和 SDK 事件流；**costUSD 不报** |
| `openai-api` | CI / 没装 CLI；或接 OpenAI 兼容模型 | 直接调用 OpenAI HTTP API（需 `OPENAI_API_KEY`） |

`openai-api` 通过 `OPENAI_BASE_URL` 自定义 Base URL。Core 评测使用 `/v1/responses`；辅助模型调用与 rubric 评委使用 `/v1/chat/completions`。Base URL 可以停在服务根或 `/v1`，可带尾部斜杠。查询参数、fragment 与内嵌凭证会被拒绝。参见[端点要求](../../guides/integration/non-claude-models.md)。

辅助执行器在创建时捕获环境。API 诊断先遮蔽已知凭证值与 Bearer／Basic 凭证，再缩短错误摘要；API 响应上限为 4 MiB，也约束流式响应。这些处理不改写成功输出或原始 trace，也不能识别服务商文本中的所有秘密。

**BREAKING-RUNTIME / BREAKING-COMPARABILITY：**API 评委 provider identity 升级为 `omk.judge-provider-runtime/v3`，封存 `openai-chat-completions/v3` 适配器及拒绝、过滤、截断的失败语义。其他评委 provider 保留原有 v2 derivation。Node 评委调用使用捕获的调用环境；API 评委身份还封存端点摘要、Chat Completions 协议和响应上限。已有报告仍可读取，但跨越此 runtime 边界合并测量前应建立新基线。Prompt 字节与评分公式不变。

### 辅助调用的结构化输出

编程式辅助接口 `ExecutorInput` 接受显式 `outputFormat`：`json-schema` 提供 `{ name, schema }`，始终请求 strict 解码；`json-object` 请求 JSON mode；`prompt-json` 依靠调用方的 prompt，不发送 provider 格式参数。省略该字段保留普通文本调用。这些控制不增加 CLI flag，也不改变 Core 目标执行。

| 执行器 | 支持的输出模式 | `maxOutputTokens` |
|---|---|---|
| `openai-api` | `json-schema`、`json-object`、`prompt-json` | 传为 `max_completion_tokens` |
| `codex` | `json-schema`、`prompt-json` | 不支持 |
| `codex-sdk`、自定义脚本及其他宿主 | 此适配器不支持显式模式 | 不支持 |

不支持的显式请求会在执行前失败。OpenAI schema 模式发送带 `strict: true` 的 `response_format.json_schema`；兼容端点或所选模型仍可能拒绝。Codex 通过 `--output-schema` 传入私有临时 schema 文件，在成功、失败、超时或取消后删除。Schema 只约束输出结构；调用方仍须校验逐字引文、身份及其他领域要求。OpenAI strict schema 要求所有属性 required，所有对象设置 `additionalProperties: false`；可选 wire 值用 `null` 表达，再显式映射到领域契约。参见 [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 与 [Codex schema 输出](https://learn.chatgpt.com/docs/non-interactive-mode)。

每次调用只发送一个请求，不自动降级或重试。失败结果保留可取得的助手原文和已报告 token 分桶（含缓存读取），同时提供类型化 `failure` 诊断及原有展示 `error`。原始拒绝通道另存为 `refusal`；`output` 优先保留原 content，缺失时回退到拒绝原文。这些原始字段不属于诊断摘要，可能含私有文本。拒绝、`content_filter` 和输出上限截断仍是失败，即使文本能解析成 JSON。HTTP 诊断保留状态及合法、有界的 `Retry-After`；缺失用量明确标记为未报告。调用方负责降级、取消、累计预算和持久化尝试证据，并须将所选模式、schema 与重试策略纳入测量身份。缓存命中统计不保证下一次请求一定命中；参见 [Prompt 缓存](https://developers.openai.com/api/docs/guides/prompt-caching)。

原内置 `gemini` 执行器已经移除，因为它无法提供可信内置集成所需的 trace、隔离、mock 和成本证据。既有 `executor: gemini` 配置现在会明确失败，不会静默回退到自定义执行器协议。需要继续使用 Gemini CLI 时，请编写[自定义执行器](#自定义执行器)适配 OMK 的 JSON stdin/stdout 协议。

## 移除 Anthropic：BREAKING-RUNTIME／BREAKING-STORAGE／BREAKING-PROMPT

移除内置 `claude`、`claude-sdk`、`anthropic-api` 执行器及可选 Claude Agent SDK 依赖。显式旧执行器 ID 会报错，不会替换服务商或模型。所有宿主的默认执行器统一为 `codex`。开始新比较前，检查 `executor`、评委条目、`OMK_EXECUTOR` 与模型选择。历史 trace 仍可只读解析；已有执行证据不改写，也不会被当成 Codex 证据。

`omk install` 只面向 Codex/AGENTS 或显式 `--dest`，不再安装到 Claude Code。移除 `CCV_PROXY_URL` 与 Claude hook 变量 `OMK_MOCK_SETTINGS_FILE`。自定义模型调用脚本自行消费 manifest 或可选 fake MCP 配置。样本生成 prompt 版本为 `omk.sample-generation/v3`，生成的 mocks 强制 strict，不自动重生成已有样本文件。

用户设置升级为 `schemaVersion: 2`，Studio 载体测量记录使用 `omk-carrier-measurement-v2`；只读取当前版本。迁移前备份 v1 文件：保留目录和语言，改选 `codex` 或 `openai-api`，明确选择对应模型，再将 `schemaVersion` 设为 2。旧载体测量元数据保留在磁盘但不再加载；保留 canonical run 报告，重新预览测量。详见[设置](../shared/settings.md)。更换执行器或重新生成样本会改变测量条件，应建立新基线。

## Sample mock 兼容性

自定义脚本可选用的 fake MCP server 版本为 `0.0.2`。它执行所有声明的匹配条件，包括展开 `~` 后的文件路径精确与后缀匹配；同次调用的多个进程共用 `return_seq` 序号。命中键使用 mock 声明中的工具名与序号（`Tool:N`，包括 `*:N`）。共享计数加锁并原子发布；状态损坏或锁等待达到 5 秒时返回 MCP 错误，不重置序列。持锁进程崩溃后需重新发起调用。既有证据保留，受影响的 mock 测量应重跑并建立新基线。

`Sample.mocks` 要求执行器能在底层工具真正运行前拦截调用。仅能事后输出 tool trace 并不等于支持 mock：执行器即使能记录 `Read`，也未必能用 fixture 替换这次调用。

| 执行器 | `Sample.mocks` 支持 |
|--------|---------------------|
| `codex` / `codex-sdk` | 不支持；当前 CLI 和 SDK 能输出 trace，但没有工具拦截 hook |
| `openai-api` | 不支持 |
| 自定义执行器 | 旧模型调用脚本接收 `OMK_MOCKS_FILE`／可选 `OMK_MOCK_MCP_CONFIG_FILE`，自行实现拦截和统计；Core 目标适配器消费封存的资源描述 |

目标执行器不支持拦截时，`omk sample` 会自动生成无 mock 用例，并移除依赖模拟调用的正向证据（`mock_hit`、`tools_called`、`tools_count_min`、`tool_input_contains`、`tool_output_contains`）。模型若仍输出 `environment`，其中的事实会迁移到明确标注「未物化」的 `context`，不会被丢弃或冒充 fixture。`omk eval` 会在任何模型调用前拒绝已有的 mocks 用例；`--dry-run` 和 `--skip-doctor` 也不能绕过，避免把评测环境不兼容误算成模型失败。

`environment.files_available` 仅是题设上下文，不会在 `cwd` 创建文件。任务必须读取真实字节时，应把 fixture 放进用例工作目录。

## 默认 runtime 怎么选

CLI、`eval.yaml` 和环境变量的优先级是：显式 CLI flag → `eval.yaml` → `OMK_*` 环境偏好 → `codex`。

- ChatGPT desktop 的 Codex 任务内自动选择 `codex`。
- 显式选择 Codex 而没有传 `--model` 时，从 `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml` 解析模型：顶层 `profile` 指向某个 profile 时取该 profile 的 `model`（该 profile 未声明模型时沿用顶层 `model`），否则取顶层 `model`。
- 默认评委沿用所选执行器和被测模型；显式 `judgeModels`／`OMK_JUDGE_MODELS` 优先。
- `eval`、`doctor`、`sample`、`evolve` 和 `observe inbox --llm-enhanced-review` 共用这套解析逻辑。

要在普通终端固定使用 Codex，把下面的偏好加入 shell 配置，例如 `~/.zshrc`：

```bash
export OMK_EXECUTOR=codex
# 可选：export OMK_MODEL="你的 Codex 模型"
# 可选：export OMK_JUDGE_MODELS="codex:你的评委模型"
```

不设置两个可选变量时，模型读取 Codex 配置，评委沿用被测模型。

**怎么选：** 在 Codex 环境直接用 `codex`，它的测量隔离最完整；只有明确需要 SDK 事件流时再用 `codex-sdk`。CI 上没 CLI 用 `openai-api`；其它厂商把 `openai-api` 指向它的 base URL 或自己写执行器。兼容端点配置见[使用 OpenAI 兼容模型](../../guides/integration/non-claude-models.md)。

**Codex construct-validity 说明：**

Core Codex 适配器目前只声明 `runtime-default` skill 发现。严格 `baseline` 要求禁用发现，因此会在执行前被拒绝，不会静默降为“只清空注入 prompt”。Codex 比较使用两个显式 artifact 版本；裸模型 baseline 使用 `openai-api`。用户、管理员及内置 skills 可能位于 `cwd` 之外，仅清空工作目录不能证明完整 skill 隔离。参见[官方发现位置与逐 skill 控制](https://learn.chatgpt.com/docs/build-skills)。

辅助 Codex CLI／SDK 调用同样拒绝显式 `allowedSkills`，包括 `[]`。知识生成通过私有工作目录排除项目上下文，skill 发现仍采用 runtime 默认行为。推理 effort 会传入 CLI 配置或 SDK 的 `modelReasoningEffort`；所选模型须支持请求的档位。

- **runtime 打指纹**：`codex` 用 `PATH` 上的 `codex` binary，`codex-sdk` 用 `@openai/codex-sdk` 解析到的自带 binary。Core artifact 会封存 executor 与 evaluator Runtime identity，包括宿主能取得的本机 binary 或 SDK 证据。除非在 `eval.yaml` 显式提供 `judgeModels[].deploymentRevision`，远端评委部署会保持 `opaque/unknown`；即使提供，也只是 `self-reported/declared`。Runtime identity 不同时，结果要视为 runtime 对比，而不只是 prompt/template 行为。详见[统计严谨性](../../explanation/statistical-rigor.md#三、评委去偏与-prompt-identity)。
- **配置与会话隔离**：omk 只在启动前解析 Codex 配置里的模型（顶层 `profile` 选中时取该 profile 的模型），然后把它作为显式模型传入。`codex` 传 `--ephemeral` + `--ignore-user-config` + `--ignore-rules`。`codex-sdk` 为每次执行创建独立的 `$CODEX_HOME` 临时目录，复制 `auth.json`，并在子进程退出后删除；用户配置和历史 SDK 会话不会渗入评测。
- **SDK execpolicy 限制**：当前 `@openai/codex-sdk` API 没有暴露 CLI 的 `--ignore-rules`。显式工作目录中的项目 execpolicy 仍可能影响 `codex-sdk`。需要隔离项目规则时优先使用 `codex`；否则必须固定执行器和 runtime context 后再比较结果。

### Codex SDK 契约覆盖

optional peer 范围允许安装，不代表其中每个版本都已经验证。仓库测试精确安装 `@openai/codex-sdk` 0.165.0 及其自带的 `@openai/codex` 0.165.0，由 [package.json](https://github.com/lizhiyao/oh-my-knowledge/blob/main/package.json) 与 [yarn.lock](https://github.com/lizhiyao/oh-my-knowledge/blob/main/yarn.lock) 固定。测试将 OMK 类型与真实 SDK 声明核对，解析已安装模块及其自带 native 包，并让真实 SDK 调用临时假可执行文件，验证选项、私有环境、事件以及 abort 后的子进程终止。进程 fixture 使用 POSIX 可执行文件，在 Windows 跳过；通过结果只覆盖实际运行的操作系统、架构和 Node 版本。这些检查不调用模型、不读取用户认证，不能证明线上认证、provider 行为或其他 SDK 版本兼容。参见[官方 SDK 指南](https://learn.chatgpt.com/docs/codex-sdk)。

在这个受测 SDK 中，`runStreamed` 会把 `turn.completed.usage` 缺失的 `cache_write_input_tokens` 补为 `0`。OMK 目前将这个 SDK 归一化字段投影为 `cacheWriteInputTokens`；仅凭该值不能认定 provider 报告了零次缓存写入。契约测试显式展示 CLI 字段缺失与 SDK 生成零值的区别。本次保持既有 usage 和持久化证据格式，比较测量结果时须固定 SDK 版本。

## DeepSeek Harness：优先使用宿主插件

已经在本机使用 DSH 时，推荐让现有 DSH profile 加载 OMK，而不是由 OMK 再启动一套 runtime：

```bash
dsh plugin --profile web add oh-my-knowledge
dsh --profile web
```

然后在 DSH 中运行：

```text
/omk eval eval.yaml
/omk observe
/omk observe <session-id>
```

`eval.yaml` 相对当前 DSH session 的 `cwd` 解析。配置中应省略顶层 `executor`，被测执行器始终是当前 DSH 宿主。被测模型默认继承当前 session；也可以在配置中显式写 `model`。评委需要复用当前 DSH 时，可使用面向用户的 `executor: dsh` 别名；`dsh-host` 是 OMK 内部标识，不能写入用户配置。插件为每条 sample 创建新的 DSH agent／session，复用当前 profile 已配置的 provider、凭证、工具、sandbox 与持久化，同时用 complete system-prompt section 注入 control／treatment、关闭 runtime context 和环境 `skill` 工具。DSH 的 `session/event` 按宿主观测顺序映射为 OMK 的 token、turn、tool call 与子 agent 证据，报告写入项目的 `.omk/eval`。

插件会先从发起命令的 session 组合 active agent preset，再叠加 OMK 的测量隔离。继承当前 session 模型且评委均复用同一个 DSH 模型时，当前交互 session 本身即作为连通性证据，不会额外创建探测 session；显式覆盖被测模型、使用不同 DSH 评委模型或外部评委时仍会执行连通性预检。宿主模式的配置应省略 `effort`：DSH 的 reasoning effort 是 provider-owned 枚举，无法与 OMK 的五档通用级别无损映射；需要在 DSH profile 中固定目标推理配置。`goldDir` 仍受支持，并会把人工 gold 一致性写回持久化报告。

当前 PoC 通过 DSH 的人类命令注册表提供 `/omk`，因此要求 profile 组合 `ctx.commands` 及其命令适配器；内置 `web` profile 满足这一条件，headless／ACP／JSON-RPC surface 暂不消费该命令。`Sample.mocks` 仍不支持。runtime 指纹包含 DSH 宿主版本、OMK 适配器版本、provider、agent preset、有效工具 schema 和清理超时。由于 DSH 尚未提供覆盖全部插件与策略的规范组合摘要，该指纹会明确标记为仅部分可审计，严格可比性检查将给出警告，而不会声称运行时完全一致。

取消后，Core 等待宿主 idle 最多 5 秒，随后等待 session 关闭最多再用 5 秒。嵌入适配器时可通过 `DshHostCoreConfiguration.cleanupTimeoutMs` 配置 1～2147483647 毫秒的整数，该值纳入 runtime 指纹。宿主卡住时会输出诊断并保留取消或基础设施失败，不能算作成功执行；停止等待不代表宿主已经终止。适配器实现版本为 `2.0.2`；存量证据保留，但 runtime identity 与早期适配器不同。Studio 使用默认固定端口 7799 或 `OMK_REPORT_PORT`；并发 observe 共用一次启动，插件关闭时释放该服务。

`/omk observe` 还要求 profile 提供 `ctx.sessionPersistence`。它列出最近已结束的 root session，并排除发起命令的当前 session；`/omk observe <session-id>` 通过 `listSnapshots()`／`inspect()` 只读取得逻辑事件流，比较读取前后的 revision，稳定后转换为 `sourceKind: dsh` 的 Trace IR，并返回实际监听地址下的 Studio 任务轨迹链接。JSONL、zstd 与 SQLite 的物理格式均由 DSH backend 负责，OMK 不解析这些文件。持续写入、required 未知事件、序号断裂、未闭合 turn／step 或缺失 tool result 都会拒绝“完整轨迹”结论。首版是离线快照，不实时跟随正在运行的 session。

本地开发 checkout 可以先构建，再直接链接到 profile：

```bash
npm run build
dsh plugin --profile web add /absolute/path/to/oh-my-knowledge
```

## 自定义执行器

**自定义执行器（Custom Executor，`custom-executor`）**让你定义样本如何执行：你的程序接收输入，调用 RAG、agent 或 workflow，再返回结果。OMK 负责样本格式、评分、版本比较和证据保存。

`omk eval --executor` 接受**一个可执行文件路径**。路径相对于评测项目目录解析；`node my-provider.mjs`、`python my-provider.py` 这样的带参数命令不会被当作 shell 命令执行。脚本须有 shebang 和执行权限；需要参数时，用一个可执行包装脚本调用你的服务。

### Beta 改名：BREAKING-PROTOCOL／BREAKING-COMPARABILITY

`custom-command` 统一改为 `custom-executor`。已有脚本的请求校验及响应 `schemaVersion` 须从 `omk.custom-command-exchange/v1` 改为 `omk.custom-executor-exchange/v1`；旧响应直接拒绝，不保留别名或兼容模式。错误码统一使用 `OMK_CUSTOM_EXECUTOR_*`。Runtime ID、资源 lineage 与输入／输出／trace Schema identity 同步采用新命名空间，需重新运行比较以建立新基线。历史报告不会回写。配置中的可执行文件路径保持原样；`custom-executor` 是适配器名称，不是 `--executor` 的字面值。

### 先跑通 stdin/stdout

把下面保存为 `my-executor.mjs`。它只返回固定文字，用于验证接入，不调用模型，也不证明 skill 的效果：

```js
#!/usr/bin/env node
let text = '';
for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
if (request.schemaVersion !== 'omk.custom-executor-exchange/v1') {
  throw new Error('Unsupported OMK request');
}
// 接入服务时，读取 request.trial.input，返回服务的实际输出。
console.log(JSON.stringify({
  schemaVersion: 'omk.custom-executor-exchange/v1',
  resultStatus: 'completed',
  output: { value: '接入成功', classification: 'public' },
}));
```

在 `omk init` 创建的项目内运行：

```bash
chmod +x my-executor.mjs
omk eval --control code-review-v1 --treatment code-review-v2 \
  --executor ./my-executor.mjs --skip-connectivity --no-judge \
  --no-serve --report-only
```

这条命令只验证目标执行与断言评分，`--no-judge` 显式关闭 LLM 评委，`--report-only` 不以发布门禁决定退出码。固定回答不能满足演示题目的断言是预期现象；检查执行覆盖是否成功，再替换为真实服务。

### 接入自己的服务

每次尝试启动一个进程，stdin 接收一个 JSON 请求，stdout 必须返回一个 JSON 响应。日志写到 stderr。当前协议是 `omk.custom-executor-exchange/v1`，不接受旧的 `{ ok, output: "..." }` 或纯文本响应。

| 请求字段 | 用途 |
|---|---|
| `trial.input` | 解析后的题目输入；CLI 文本用例通常是字符串。 |
| `trial.targetConfig.runtime` | 模型、effort 等运行配置。 |
| `trial.targetConfig.behavior.artifact` | 被测知识载体的资源描述符。 |
| `resources` | 本次执行可读取的资源快照，用 `resourceId` 与描述符关联；`snapshotPath` 是临时路径。 |
| `trial.trialSeed` | 测量种子；仅在你的服务实际支持时使用。 |
| `attempt` | 本次尝试的身份与重试序号。 |

要测量 prompt／skill 改动，需要按 artifact 描述符在 `resources` 中找到知识快照，并让服务实际使用其中内容；只读取题目会忽略被测知识。不要在快照之外读取原始 skill，也不要把标准答案交给被测服务。资源仅在本次生命周期内有效，不持久化这些临时路径。

成功返回 `resultStatus: 'completed'` 和 `output: { value, classification }`，其中 `value` 可为 JSON 值。数据分类按真实内容选择 `public`、`sensitive` 或 `secret`；可选 `trace` 使用同样结构。可选 `usage` 使用 Core 的 `UsageRecord` 契约，不提供用量就保持缺失，不能填零冒充实测。

调用失败可以返回稳定的错误代码：

```json
{"schemaVersion":"omk.custom-executor-exchange/v1","resultStatus":"failed","error":{"code":"SERVICE_UNAVAILABLE","stage":"execution"}}
```

`stage` 为 `execution` 或 `infrastructure`。非零退出、超时和非法响应同样会记录为执行失败；例如旧协议输出会产生 `OMK_CUSTOM_EXECUTOR_OUTPUT_INVALID`。从报告的执行覆盖和失败证据排查，不能把失败当成低分答案。

上述协议用于 `omk eval` 的目标执行。`doctor`／`sample`／`evolve` 的模型调用接口及自定义 LLM 评委仍使用旧的 `{ model, system, prompt }` 适配接口；不要把仅实现本节协议的脚本直接用作那些模型调用。需要评委时通过 `--judge-models` 单独配置受支持的执行器。

## 运行失败时如何排查

DSH 观测通过 `Object.is` 比较不透明的 persistence revision token。宿主须提供在未变化快照之间保持稳定的不可变 token（例如字符串）。新建的对象 token 不会被假设为结构相等；三轮读取仍不稳定时明确失败。OMK 无法从相似的序列化对象推断后端快照稳定性。

先看执行／评分覆盖和具体原因代码，再检查模型输出。`OMK_CODEX_CLI_UPGRADE_REQUIRED` 表示当前 CLI 不支持所选模型：检查 `codex --version` 并升级，再用同一模型和用例重跑。不要通过换模型来证明原来的知识对比已恢复。

Codex 的 `Reconnecting...` 是传输重连通知；只有后续出现合法的完成事件和答案才算成功，最终失败、缺少完成事件或未知错误仍会阻断评测。此修复升级了 Codex 执行与评委的适配身份：旧版本可能将已恢复的调用记为失败，前后结果不要当成相同测量条件直接合并，应重新运行完整比较。

`--retry` 只重试密封策略允许的错误代码，默认是 `timeout` 和 `transport-error`。自定义服务应按实际失败原因返回代码，不能为获得重试把所有业务失败都标成传输错误。

## 前置要求

OMK 基础安装不再携带可选 Agent SDK 及其大型平台二进制。`codex` CLI 执行器、API 执行器、自定义执行器和 DSH 宿主插件都不需要它们。只有明确选择 `*-sdk` 执行器时，才在 OMK 所在的同一作用域安装对应 SDK。

- **codex**：安装 Codex CLI（`npm i -g @openai/codex`）并认证
- **codex-sdk**：本地安装兼容的可选 SDK：`npm i @openai/codex-sdk@^0.165.0`；如果 OMK 是全局安装，则执行 `npm i -g @openai/codex-sdk@^0.165.0`（自带 `@openai/codex` binary）
- **DSH 插件**：在已有 command-capable DSH profile 中安装 `oh-my-knowledge`，使用 `/omk eval <eval.yaml>`
- **openai-api**：设置 `OPENAI_API_KEY` 环境变量

已有安装如果仍使用旧版可选 Codex SDK，请按上面的本地或全局 SDK 命令升级。此次依赖升级不需要迁移存量数据；历史测量保留各自记录的 Runtime identity，使用不同 SDK 版本的测量不能合并为固定 runtime 的比较。

## 相关

- [Artifact 与 variant 布局](../evaluation/artifact-layout.md) —— variant 如何解析为 artifact + runtime context
- [评测 agent](../../guides/evaluation/agent-eval.md) —— source-neutral agent 评测与显式项目上下文
- [使用 OpenAI 兼容模型](../../guides/integration/non-claude-models.md) —— GLM / 通义 / DeepSeek / Moonshot / Ollama
