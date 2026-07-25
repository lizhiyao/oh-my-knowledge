# 执行器

**执行器**是 omk 拿 artifact 去跑模型的后端 —— 把 `(system, prompt, model)` 变成输出。选哪个（`--executor`）决定模型**怎么被调用**：Claude CLI、Agent SDK、codex、裸 HTTP API，还是你自己的命令。**一次 run 里执行器要固定** —— 拿不同执行器跑不同 variant，比的是 runtime 而不只是 artifact（omk 会给 runtime 打指纹、不一致时告警，见下方 construct-validity 说明）。

## 内置执行器

| 执行器 | 适用场景 | 说明 |
|--------|----------|------|
| `claude` | Claude Code 环境下的 skill 评测 | 通过 `claude -p` 调用 Claude CLI |
| `claude-sdk` | agent 评测（工具 / 轮次 trace）、结构化输出 | 通过 Claude Agent SDK 调用，抽取 turns / toolCalls trace，无 stdout 解析、避免 buffer 截断 |
| `codex` | Codex / ChatGPT desktop 编程任务（CLI） | 通过 `codex exec --json` 调用，需本地装好登录的 codex（`@openai/codex`）；best-effort tool trace，**costUSD 不报**（codex 自身不输出 USD，需外部账单核算） |
| `codex-sdk` | Codex agent 评测（SDK） | 通过 `@openai/codex-sdk` 调用其自带的 `@openai/codex` binary 和 SDK 事件流；**costUSD 不报** |
| `gemini` | 跨厂商对比 | 通过 `gemini` CLI 调用 |
| `anthropic-api` | CI / 没装 CLI | 直接调用 Anthropic HTTP API（需 `ANTHROPIC_API_KEY`） |
| `openai-api` | CI / 没装 CLI；或接非 Claude 模型 | 直接调用 OpenAI HTTP API（需 `OPENAI_API_KEY`） |

API 直调执行器支持通过环境变量自定义 Base URL：`ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL`。

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

**怎么选：** 在 Codex 环境直接用 `codex`；需要 SDK 事件流时用 `codex-sdk`。Claude Code 环境用 `claude`；要工具调用 / 轮次断言或结构化输出可换 `claude-sdk`。CI 上没 CLI 用 `*-api`；其它厂商把 `openai-api` 指向它的 base URL 或自己写执行器。接非 Claude 模型见[使用非 Claude 模型](../guides/non-claude-models)。

**Codex construct-validity 说明：**

- **runtime 打指纹**：`codex` 用 `PATH` 上的 `codex` binary，`codex-sdk` 用 `@openai/codex-sdk` 解析到的自带 binary。报告持久化 per-variant `meta.executorRuntimes` / `meta.executorRuntime` 和每个评委的 `meta.judgeModels[].runtime` 指纹（binary 或 SDK 版本 + 能力快照）；strict comparability checks 在指纹无法审计时告警。跨 variant 指纹不一致时，结果要当成 executor-runtime 对比，而不只是 prompt/template 行为。
- **config 隔离**：omk 只在启动前读取 Codex 配置里的顶层 `model`，然后把它作为显式模型传入。实际评测仍隔离其它用户级配置：`codex` 传 `--ephemeral` + `--ignore-user-config`，`codex-sdk` 把 `$CODEX_HOME` 重定向到 per-process tmp 目录（auth.json 通过 symlink 透传）。自定义 effort、工具配置或 instructions 不会渗入 eval。

## 自定义执行器

任何 shell 命令都可以作为执行器，通过 stdin/stdout JSON 协议通信：

```bash
omk eval --executor "python my_provider.py"
omk eval --executor "./my-executor.sh"
```

**协议约定：**

- **输入**（stdin）：JSON `{"model":"...","system":"...","prompt":"..."}`
- **输出**（stdout）：JSON `{"output":"模型回复","inputTokens":0,"outputTokens":0,"costUSD":0}`
- stdout 中只需返回有值的字段，其余默认为 0；也可以直接输出纯文本（不解析 token/成本）
- 非零退出码视为执行失败

## 前置要求

- **claude**：安装 [Claude Code](https://claude.ai/code) 并认证
- **claude-sdk**：安装 [Claude Code](https://claude.ai/code) 并认证（使用 Agent SDK，无需 CLI stdout 解析）
- **codex**：安装 Codex CLI（`npm i -g @openai/codex`）并认证
- **codex-sdk**：`npm i @openai/codex-sdk`（自带 `@openai/codex` binary）
- **anthropic-api**：设置 `ANTHROPIC_API_KEY` 环境变量
- **openai-api**：设置 `OPENAI_API_KEY` 环境变量
- **gemini**：`npm i -g @google/gemini-cli` 并认证

## 相关

- [Artifact 与 variant 布局](./artifact-layout) —— variant 如何解析为 artifact + runtime context
- [评测 agent](../guides/agent-eval) —— 用 `claude-sdk` 做 agent-aware 评测
- [使用非 Claude 模型](../guides/non-claude-models) —— GLM / 通义 / DeepSeek / Moonshot / Ollama
