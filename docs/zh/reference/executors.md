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

原内置 `gemini` 执行器已经移除，因为它无法提供可信内置集成所需的 trace、隔离、mock 和成本证据。既有 `executor: gemini` 配置现在会明确失败，不会静默回退到自定义命令协议。需要继续使用 Gemini CLI 时，请编写[自定义执行器](#自定义执行器)适配 OMK 的 JSON stdin/stdout 协议。

## Sample mock 兼容性

`Sample.mocks` 要求执行器能在底层工具真正运行前拦截调用。仅能事后输出 tool trace 并不等于支持 mock：执行器即使能记录 `Read`，也未必能用 fixture 替换这次调用。

| 执行器 | `Sample.mocks` 支持 |
|--------|---------------------|
| `claude` / `claude-sdk` | 支持，通过原生 hooks 拦截 |
| `codex` / `codex-sdk` | 不支持；当前 CLI 和 SDK 能输出 trace，但没有工具拦截 hook |
| `anthropic-api` / `openai-api` | 不支持 |
| 自定义命令 | 通过 `OMK_MOCKS_FILE` / `OMK_MOCK_SETTINGS_FILE` 委托；命令必须安装或消费 omk 提供的 hook |

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

- **runtime 打指纹**：`codex` 用 `PATH` 上的 `codex` binary，`codex-sdk` 用 `@openai/codex-sdk` 解析到的自带 binary。报告持久化 per-variant `meta.executorRuntimes` / `meta.executorRuntime` 和每个评委的 `meta.judgeModels[].runtime` 指纹（binary 或 SDK 版本 + 能力快照）；strict comparability checks 在指纹无法审计时告警。跨 variant 指纹不一致时，结果要当成 executor-runtime 对比，而不只是 prompt/template 行为。
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
```

`eval.yaml` 相对当前 DSH session 的 `cwd` 解析。配置中应省略顶层 `executor`，被测执行器始终是当前 DSH 宿主。被测模型默认继承当前 session；也可以在配置中显式写 `model`。评委需要复用当前 DSH 时，可使用面向用户的 `executor: dsh` 别名；`dsh-host` 是 OMK 内部标识，不能写入用户配置。插件为每条 sample 创建新的 DSH agent／session，复用当前 profile 已配置的 provider、凭证、工具、sandbox 与持久化，同时用 complete system-prompt section 注入 control／treatment、关闭 runtime context 和环境 `skill` 工具。DSH 的 `session/event` 按宿主观测顺序映射为 OMK 的 token、turn、tool call 与子 agent 证据，报告写入项目的 `.omk/reports`。

插件会先从发起命令的 session 组合 active agent preset，再叠加 OMK 的测量隔离。继承当前 session 模型且评委均复用同一个 DSH 模型时，当前交互 session 本身即作为连通性证据，不会额外创建探测 session；显式覆盖被测模型、使用不同 DSH 评委模型或外部评委时仍会执行连通性预检。宿主模式的配置应省略 `effort`：DSH 的 reasoning effort 是 provider-owned 枚举，无法与 OMK 的五档通用级别无损映射；需要在 DSH profile 中固定目标推理配置。`goldDir` 仍受支持，并会把人工 gold 一致性写回持久化报告。

当前 PoC 通过 DSH 的人类命令注册表提供 `/omk`，因此要求 profile 组合 `ctx.commands` 及其命令适配器；内置 `web` profile 满足这一条件，headless／ACP／JSON-RPC surface 暂不消费该命令。`Sample.mocks` 仍不支持。runtime 指纹包含 DSH 宿主版本、OMK 适配器版本、provider、agent preset 和有效工具 schema。由于 DSH 尚未提供覆盖全部插件与策略的规范组合摘要，该指纹会明确标记为仅部分可审计，严格可比性检查将给出警告，而不会声称运行时完全一致。

本地开发 checkout 可以先构建，再直接链接到 profile：

```bash
npm run build
dsh plugin --profile web add /absolute/path/to/oh-my-knowledge
```

## 自定义执行器

任何 shell 命令都可以作为执行器，通过 stdin/stdout JSON 协议通信：

```bash
omk eval --executor "python my_provider.py"
omk eval --executor "./my-executor.sh"
```

**协议约定：**

- **输入**（stdin）：JSON `{"model":"...","system":"...","prompt":"..."}`
- **输出**（stdout）：JSON `{"ok":true,"output":"模型回复","inputTokens":0,"outputTokens":0,"costUSD":0}`；为兼容旧脚本，可以省略 `ok`
- 返回 `{"ok":false,"error":"失败原因"}` 可显式报告执行失败
- stdout 中只需返回有值的字段，其余默认为 0；也可以直接输出纯文本（不解析 token/成本）
- 要暴露 source-neutral agent 证据，可增加 `turns`、`toolCalls`、`fullNumTurns`、`numSubAgents`。每条 tool call 包含 `tool`、JSON `input` / `output`、`success`，并可带 `status`（`success` / `failure` / `cancelled` / `unknown`）及来源身份字段。trace 字段格式错误时整次执行失败，不会静默丢弃。
- 只有四个 token 计数 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheCreationTokens` 全部存在时，token 使用量才视为 runtime 实测；否则报告标记为未报告。
- 命令引用的本地脚本或可执行文件字节会进入 runtime 指纹；即使命令字符串不变，文件内容变化也会让 cache 与 strict comparability 失效。
- JSON 中的 `output` 为空，或纯文本只含空白，均视为失败
- 非零退出码视为执行失败

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
