# 执行器

**执行器**是 omk 拿 artifact 去跑模型的后端 —— 把 `(system, prompt, model)` 变成输出。选哪个（`--executor`）决定模型**怎么被调用**：Claude CLI、Agent SDK、codex、裸 HTTP API，还是你自己的命令。**一次 run 里执行器要固定** —— 拿不同执行器跑不同 variant，比的是 runtime 而不只是 artifact（omk 会给 runtime 打指纹、不一致时告警，见下方 construct-validity 说明）。

## 内置执行器

| 执行器 | 适用场景 | 说明 |
|--------|----------|------|
| `claude` | Claude Code 环境下的 skill 评测 | 通过 `claude -p` 调用 Claude CLI |
| `claude-sdk` | agent 评测（工具 / 轮次 trace）、结构化输出 | 通过 Claude Agent SDK 调用，抽取 turns / toolCalls trace，无 stdout 解析、避免 buffer 截断 |
| `codex` | Codex / ChatGPT desktop 编程任务（CLI） | 通过 `codex exec --json` 调用，需本地装好登录的 codex（`@openai/codex`）；best-effort tool trace，**costUSD 不报**（codex 自身不输出 USD，需外部账单核算） |
| `codex-sdk` | Codex agent 评测（SDK） | 通过 `@openai/codex-sdk` 调用其自带的 `@openai/codex` binary 和 SDK 事件流；**costUSD 不报** |
| `dsh` | 实验性 DeepSeek Harness agent 评测 | 通过 `@deepseek-ai/dsh-sdk-client` 驱动显式 DSH JSON-RPC runtime；映射主会话／子 agent 事件与工具 trace；**costUSD 不报** |
| `gemini` | 跨厂商对比 | 通过 `gemini` CLI 调用 |
| `anthropic-api` | CI / 没装 CLI | 直接调用 Anthropic HTTP API（需 `ANTHROPIC_API_KEY`） |
| `openai-api` | CI / 没装 CLI；或接非 Claude 模型 | 直接调用 OpenAI HTTP API（需 `OPENAI_API_KEY`） |

API 直调执行器支持通过环境变量自定义 Base URL：`ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL`。

## Sample mock 兼容性

`Sample.mocks` 要求执行器能在底层工具真正运行前拦截调用。仅能事后输出 tool trace 并不等于支持 mock：执行器即使能记录 `Read`，也未必能用 fixture 替换这次调用。

| 执行器 | `Sample.mocks` 支持 |
|--------|---------------------|
| `claude` / `claude-sdk` | 支持，通过原生 hooks 拦截 |
| `codex` / `codex-sdk` / `dsh` | 不支持；当前 SDK 能输出 trace，但没有工具拦截 hook |
| `gemini` / `anthropic-api` / `openai-api` | 不支持 |
| 自定义命令 | 通过 `OMK_MOCKS_FILE` / `OMK_MOCK_SETTINGS_FILE` 委托；命令必须安装或消费 omk 提供的 hook |

目标执行器不支持拦截时，`omk sample` 会自动生成无 mock 用例，并移除依赖模拟调用的正向证据（`mock_hit`、`tools_called`、`tools_count_min`、`tool_input_contains`、`tool_output_contains`）。模型若仍输出 `environment`，其中的事实会迁移到明确标注「未物化」的 `context`，不会被丢弃或冒充 fixture。`omk eval` 会在任何模型调用前拒绝已有的 mocks 用例；`--dry-run` 和 `--skip-doctor` 也不能绕过，避免把评测环境不兼容误算成模型失败。

`environment.files_available` 仅是题设上下文，不会在 `cwd` 创建文件。任务必须读取真实字节时，应把 fixture 放进用例工作目录。

## 默认 runtime 怎么选

CLI、`eval.yaml` 和环境变量的优先级是：显式 CLI flag → `eval.yaml` → `OMK_*` 环境偏好 → 自动检测。

- ChatGPT desktop 的 Codex 任务内自动选择 `codex`。
- 普通终端只有 Codex CLI 可用时选择 `codex`。
- 普通终端同时装有 Claude 和 Codex 时保留 `claude` 默认，避免升级后无提示切换历史测量 runtime。
- 显式选择 Codex 而没有传 `--model` 时，读取 `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml` 的顶层 `model`。
- 默认评委跟随所选执行器：Claude 使用 `claude:haiku`；Codex／DSH 使用与被测任务相同的模型，不会回落到 Claude。
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

`eval.yaml` 相对当前 DSH session 的 `cwd` 解析。被测模型默认继承当前 session；也可以在配置中显式写 `model`。插件为每条 sample 创建新的 DSH agent／session，复用当前 profile 已配置的 provider、凭证、工具、sandbox 与持久化，同时用 complete system-prompt section 注入 control／treatment、关闭 runtime context 和环境 `skill` 工具。DSH 的 `session/event` 直接映射为 OMK 的 token、turn、tool call 与子 agent 证据，报告写入项目的 `.omk/reports`。

当前 PoC 通过 DSH 的人类命令注册表提供 `/omk`，因此要求 profile 组合 `ctx.commands` 及其命令适配器；内置 `web` profile 满足这一条件，headless／ACP／JSON-RPC surface 暂不消费该命令。`Sample.mocks` 仍不支持。DSH host package 版本会进入 runtime 指纹；跨版本报告不能默认视为严格可比。

本地开发 checkout 可以先构建，再直接链接到 profile：

```bash
npm run build
dsh plugin --profile web add /absolute/path/to/oh-my-knowledge
```

### 从 OMK CLI 外部驱动 DSH

`--executor dsh` 是反方向的自动化入口，适合 CI 或明确需要从 OMK CLI 发起的批处理。它消费 DSH typed SDK 事件流，不解析交互式 CLI stdout，但需要独立 JSON-RPC runtime；已有 DSH 用户通常不需要这条路径。

DSH TypeScript SDK 不自带 runtime。需要显式提供 JSON-RPC runtime 与 Cordis 配置：

```bash
export OMK_DSH_COMMAND=node
export OMK_DSH_ARGS='["/absolute/path/to/dsh-jsonrpc-runtime.js"]'
export OMK_DSH_CONFIG=/absolute/path/to/cordis.yml
export OMK_DSH_PROVIDER=deepseek-official

omk eval --executor dsh --model deepseek-chat \
  --control baseline --treatment ./skills/my-skill \
  --samples eval-samples.json
```

`OMK_DSH_ARGS` 是 JSON 字符串数组；OMK 会把 `OMK_DSH_CONFIG` 追加为 runtime 的最后一个参数。`OMK_DSH_MAX_TOKENS` 可设置每次请求的正整数输出上限。模型必须来自 `--model`、`OMK_MODEL` 或 `DSH_MODEL`。

每次 executor 调用都会创建全新的 runtime 进程、SDK session、`DSH_HOME` 和 `DSH_SESSION_ROOT`，关闭后删除临时状态。OMK 还向 runtime 暴露以下 bridge 契约：

| 环境变量 | 契约 |
|---|---|
| `DSH_CORDIS_CONFIG` | 同一份显式 Cordis 配置的绝对路径 |
| `DSH_CWD` | 隔离后的 sample 工作目录 |
| `DSH_SYSTEM_PROMPT` | artifact 的原始 system prompt；没有时为空字符串 |
| `DSH_HOME` / `DSH_SESSION_ROOT` | 每次调用独立的临时状态目录 |

提供的 Cordis 配置必须消费这些变量。严格比较 control／treatment 时，还必须关闭环境中的 DSH skill 自动发现，并固定 provider、preset、sandbox、approval policy、plugin 集合与 lockfile。OMK 会把 runtime 可执行文件、启动参数、Cordis 配置字节、provider／model 和 DSH SDK 版本写入指纹。忽略 bridge 变量的配置仍可能跑通，但其结果不能证明只有 artifact 发生变化。DSH 当前是固定版本的实验性集成；SDK 小版本变化也可能需要更新 adapter。

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

- **claude**：安装 [Claude Code](https://claude.ai/code) 并认证
- **claude-sdk**：安装 [Claude Code](https://claude.ai/code) 并认证（使用 Agent SDK，无需 CLI stdout 解析）
- **codex**：安装 Codex CLI（`npm i -g @openai/codex`）并认证
- **codex-sdk**：`npm i @openai/codex-sdk`（自带 `@openai/codex` binary）
- **DSH 插件**：在已有 command-capable DSH profile 中安装 `oh-my-knowledge`，使用 `/omk eval <eval.yaml>`
- **dsh 外部执行器**：仅在从 OMK CLI 驱动时提供 DSH JSON-RPC runtime 与固定 Cordis 配置；OMK 包含 client SDK，但不包含 runtime
- **anthropic-api**：设置 `ANTHROPIC_API_KEY` 环境变量
- **openai-api**：设置 `OPENAI_API_KEY` 环境变量
- **gemini**：`npm i -g @google/gemini-cli` 并认证

## 相关

- [Artifact 与 variant 布局](./artifact-layout) —— variant 如何解析为 artifact + runtime context
- [评测 agent](../guides/agent-eval) —— source-neutral agent 评测与显式项目上下文
- [使用非 Claude 模型](../guides/non-claude-models) —— GLM / 通义 / DeepSeek / Moonshot / Ollama
