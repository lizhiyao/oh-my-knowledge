# 执行器

**执行器**是 omk 拿 artifact 去跑模型的后端 —— 把 `(system, prompt, model)` 变成输出。选哪个（`--executor`）决定模型**怎么被调用**：Claude CLI、Agent SDK、codex、裸 HTTP API，还是你自己的命令。**一次 run 里执行器要固定** —— 拿不同执行器跑不同 variant，比的是 runtime 而不只是 artifact（omk 会给 runtime 打指纹、不一致时告警，见下方 construct-validity 说明）。

## 内置执行器

| 执行器 | 适用场景 | 说明 |
|--------|----------|------|
| `claude` | Claude Code 环境下的 skill 评测 | 通过 `claude -p` 调用 Claude CLI |
| `claude-sdk` | agent 评测（工具 / 轮次 trace）、结构化输出 | 通过 Claude Agent SDK 调用，抽取 turns / toolCalls trace，无 stdout 解析、避免 buffer 截断 |
| `codex` | Codex / ChatGPT desktop 编程任务（CLI） | 通过 `codex exec --json` 调用，需本地装好登录的 codex（`@openai/codex`）；best-effort tool trace，**costUSD 不报**（codex 自身不输出 USD，需外部账单核算） |
| `codex-sdk` | Codex agent 评测（SDK） | 通过 `@openai/codex-sdk` 调用其自带的 `@openai/codex` binary 和 SDK 事件流；**costUSD 不报** |
| `anthropic-api` | CI / 没装 CLI | 直接调用 Anthropic HTTP API（需 `ANTHROPIC_API_KEY`） |
| `openai-api` | CI / 没装 CLI；或接非 Claude 模型 | 直接调用 OpenAI HTTP API（需 `OPENAI_API_KEY`） |

API 直调执行器支持通过环境变量自定义 Base URL：`ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL`。

原内置 `gemini` 执行器已经移除，因为它无法提供可信内置集成所需的 trace、隔离、mock 和成本证据。既有 `executor: gemini` 配置现在会明确失败，不会静默回退到自定义执行器协议。需要继续使用 Gemini CLI 时，请编写[自定义执行器](#自定义执行器)适配 OMK 的 JSON stdin/stdout 协议。

## Sample mock 兼容性

`Sample.mocks` 要求执行器能在底层工具真正运行前拦截调用。仅能事后输出 tool trace 并不等于支持 mock：执行器即使能记录 `Read`，也未必能用 fixture 替换这次调用。

| 执行器 | `Sample.mocks` 支持 |
|--------|---------------------|
| `claude` / `claude-sdk` | 支持，通过原生 hooks 拦截 |
| `codex` / `codex-sdk` | 不支持；当前 CLI 和 SDK 能输出 trace，但没有工具拦截 hook |
| `anthropic-api` / `openai-api` | 不支持 |
| 自定义执行器 | 通过 `OMK_MOCKS_FILE` / `OMK_MOCK_SETTINGS_FILE` 委托；命令必须安装或消费 omk 提供的 hook |

目标执行器不支持拦截时，`omk sample` 会自动生成无 mock 用例，并移除依赖模拟调用的正向证据（`mock_hit`、`tools_called`、`tools_count_min`、`tool_input_contains`、`tool_output_contains`）。模型若仍输出 `environment`，其中的事实会迁移到明确标注「未物化」的 `context`，不会被丢弃或冒充 fixture。`omk eval` 会在任何模型调用前拒绝已有的 mocks 用例；`--dry-run` 和 `--skip-doctor` 也不能绕过，避免把评测环境不兼容误算成模型失败。

`environment.files_available` 仅是题设上下文，不会在 `cwd` 创建文件。任务必须读取真实字节时，应把 fixture 放进用例工作目录。

## 默认 runtime 怎么选

CLI、`eval.yaml` 和环境变量的优先级是：显式 CLI flag → `eval.yaml` → `OMK_*` 环境偏好 → 自动检测。

- ChatGPT desktop 的 Codex 任务内自动选择 `codex`。
- 普通终端只有 Codex CLI 可用时选择 `codex`。
- 普通终端同时装有 Claude 和 Codex 时保留 `claude` 默认，避免升级后无提示切换历史测量 runtime。
- 显式选择 Codex 而没有传 `--model` 时，读取 `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml` 的顶层 `model`。
- 默认评委跟随所选执行器：Claude 使用 `claude:haiku`；Codex 使用与被测任务相同的模型，不会回落到 Claude。
- `eval`、`doctor`、`sample`、`evolve` 和 `observe inbox --llm-enhanced-review` 共用这套解析逻辑。

要在普通终端固定使用 Codex，把下面的偏好加入 shell 配置，例如 `~/.zshrc`：

```bash
export OMK_EXECUTOR=codex
# 可选：export OMK_MODEL="你的 Codex 模型"
# 可选：export OMK_JUDGE_MODELS="codex:你的评委模型"
```

不设置两个可选变量时，模型读取 Codex 配置，评委沿用被测模型。

**怎么选：** 在 Codex 环境直接用 `codex`，它的测量隔离最完整；只有明确需要 SDK 事件流时再用 `codex-sdk`。Claude Code 环境用 `claude`；要工具调用 / 轮次断言或结构化输出可换 `claude-sdk`。CI 上没 CLI 用 `*-api`；其它厂商把 `openai-api` 指向它的 base URL 或自己写执行器。接非 Claude 模型见[使用非 Claude 模型](../guides/non-claude-models)。

**Codex construct-validity 说明：**

- **runtime 打指纹**：`codex` 用 `PATH` 上的 `codex` binary，`codex-sdk` 用 `@openai/codex-sdk` 解析到的自带 binary。Core artifact 会封存 executor 与 evaluator Runtime identity，包括宿主能取得的本机 binary 或 SDK 证据。除非在 `eval.yaml` 显式提供 `judgeModels[].deploymentRevision`，远端评委部署会保持 `opaque/unknown`；即使提供，也只是 `self-reported/declared`。Runtime identity 不同时，结果要视为 runtime 对比，而不只是 prompt/template 行为。详见[统计严谨性](../explanation/statistical-rigor#三评委去偏与-prompt-identity)。
- **配置与会话隔离**：omk 只在启动前读取 Codex 配置里的顶层 `model`，然后把它作为显式模型传入。`codex` 传 `--ephemeral` + `--ignore-user-config` + `--ignore-rules`。`codex-sdk` 为每次执行创建独立的 `$CODEX_HOME` 临时目录，复制 `auth.json`，并在子进程退出后删除；用户配置和历史 SDK 会话不会渗入评测。
- **SDK execpolicy 限制**：当前 `@openai/codex-sdk` API 没有暴露 CLI 的 `--ignore-rules`。显式工作目录中的项目 execpolicy 仍可能影响 `codex-sdk`。需要隔离项目规则时优先使用 `codex`；否则必须固定执行器和 runtime context 后再比较结果。

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

当前 PoC 通过 DSH 的人类命令注册表提供 `/omk`，因此要求 profile 组合 `ctx.commands` 及其命令适配器；内置 `web` profile 满足这一条件，headless／ACP／JSON-RPC surface 暂不消费该命令。`Sample.mocks` 仍不支持。runtime 指纹包含 DSH 宿主版本、OMK 适配器版本、provider、agent preset 和有效工具 schema。由于 DSH 尚未提供覆盖全部插件与策略的规范组合摘要，该指纹会明确标记为仅部分可审计，严格可比性检查将给出警告，而不会声称运行时完全一致。

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

先看执行／评分覆盖和具体原因代码，再检查模型输出。`OMK_CODEX_CLI_UPGRADE_REQUIRED` 表示当前 CLI 不支持所选模型：检查 `codex --version` 并升级，再用同一模型和用例重跑。不要通过换模型来证明原来的知识对比已恢复。

Codex 的 `Reconnecting...` 是传输重连通知；只有后续出现合法的完成事件和答案才算成功，最终失败、缺少完成事件或未知错误仍会阻断评测。此修复升级了 Codex 执行与评委的适配身份：旧版本可能将已恢复的调用记为失败，前后结果不要当成相同测量条件直接合并，应重新运行完整比较。

`--retry` 只重试密封策略允许的错误代码，默认是 `timeout` 和 `transport-error`。自定义服务应按实际失败原因返回代码，不能为获得重试把所有业务失败都标成传输错误。

## 前置要求

OMK 基础安装不再携带可选 Agent SDK 及其大型平台二进制。默认的 `claude`／`codex` CLI 执行器、API 执行器、自定义执行器和 DSH 宿主插件都不需要它们。只有明确选择 `*-sdk` 执行器时，才在 OMK 所在的同一作用域安装对应 SDK。

- **claude**：安装 [Claude Code](https://claude.ai/code) 并认证
- **claude-sdk**：本地安装可选 Agent SDK：`npm i @anthropic-ai/claude-agent-sdk@^0.3.143`；如果 OMK 是全局安装，则在同一全局 npm prefix 执行 `npm i -g @anthropic-ai/claude-agent-sdk@^0.3.143`，随后完成 Claude 认证
- **codex**：安装 Codex CLI（`npm i -g @openai/codex`）并认证
- **codex-sdk**：本地安装兼容的可选 SDK：`npm i @openai/codex-sdk@^0.149.0`；如果 OMK 是全局安装，则执行 `npm i -g @openai/codex-sdk@^0.149.0`（自带 `@openai/codex` binary）
- **DSH 插件**：在已有 command-capable DSH profile 中安装 `oh-my-knowledge`，使用 `/omk eval <eval.yaml>`
- **anthropic-api**：设置 `ANTHROPIC_API_KEY` 环境变量
- **openai-api**：设置 `OPENAI_API_KEY` 环境变量

## 相关

- [Artifact 与 variant 布局](./artifact-layout) —— variant 如何解析为 artifact + runtime context
- [评测 agent](../guides/agent-eval) —— source-neutral agent 评测与显式项目上下文
- [使用非 Claude 模型](../guides/non-claude-models) —— GLM / 通义 / DeepSeek / Moonshot / Ollama
