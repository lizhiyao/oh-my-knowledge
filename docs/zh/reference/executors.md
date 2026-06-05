# 执行器

## 内置执行器

| 执行器 | 适用场景 | 说明 |
|--------|----------|------|
| `claude` | 默认 | 通过 `claude -p` 调用 Claude CLI |
| `claude-sdk` | 结构化输出 | 通过 Claude Agent SDK 调用，无 stdout 解析，避免 buffer 截断 |
| `codex` | OpenAI agent CLI | 通过 `codex exec --json` 调用，需本地装好登录的 codex（`@openai/codex`）；best-effort tool trace，**costUSD 不报**（codex 自身不输出 USD，需外部账单核算） |
| `codex-sdk` | OpenAI agent SDK | 通过 `@openai/codex-sdk` 调用其自带的 `@openai/codex` binary 和 SDK 事件流；**costUSD 不报** |
| `gemini` | 跨厂商对比 | 通过 `gemini` CLI 调用 |
| `anthropic-api` | 无需 CLI | 直接调用 Anthropic HTTP API（需 `ANTHROPIC_API_KEY`） |
| `openai-api` | 无需 CLI | 直接调用 OpenAI HTTP API（需 `OPENAI_API_KEY`） |

API 直调执行器支持通过环境变量自定义 Base URL：`ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL`。

Codex construct-validity 说明：（1）`codex` 使用 `PATH` 上找到的 `codex` binary；`codex-sdk` 使用 `@openai/codex-sdk` 解析到的自带 `@openai/codex` binary。报告会持久化 per-variant `meta.executorRuntimes`、`meta.executorRuntime`，以及每个评委的 `meta.judgeModels[].runtime` 指纹（binary 或 SDK 版本 + 能力快照），strict comparability checks 会在 runtime 指纹无法审计时提示。runtime 指纹不一致时，结果应解释为 executor runtime 对比，而不只是 prompt/template 行为对比。（2）两个 executor 都隔离用户级 config：`codex` 传 `--ephemeral` + `--ignore-user-config`，`codex-sdk` 把 `$CODEX_HOME` 重定向到 per-process tmp 目录（auth.json 通过 symlink 透传）。用户的 `~/.codex/config.toml` 不会渗入任意一个 executor 的 eval。

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
