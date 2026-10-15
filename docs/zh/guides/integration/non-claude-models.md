# 使用 OpenAI 兼容端点与本地模型

先准备明确的 control、treatment 和 v3 用例，见[评测入门](../evaluation/quickstart-skill-eval.md)。执行器决定调用方式，模型名和端点由你实际可访问的服务决定；不把历史示例里的模型名当成当前可用清单。

## OpenAI 兼容 HTTP 端点

`openai-api` 使用相同的 `OPENAI_BASE_URL` 与 Bearer API key 调用两种协议：Core 被测目标使用 `/v1/responses`，辅助调用（`doctor`、样本生成和 rubric 评委）使用 `/v1/chat/completions`。同时用于目标和评委的服务须支持两种协议，协议之间不会自动回退。

Base URL 填服务根或其 `/v1` 前缀；尾部斜杠会规范化，网关路径前缀会保留。不要填具体操作路径、查询参数、fragment 或内嵌凭证。Core 要求 HTTPS，loopback 端点除外。其它协议需要自定义适配器。

```bash
export OPENAI_API_KEY="<your-api-key>"
export OPENAI_BASE_URL="https://your-compatible-endpoint.example"
omk eval --control baseline --treatment ./skill.md   --samples ./eval-samples.json --executor openai-api   --model '<available-model>' --judge-models 'openai-api:<available-judge-model>'
```

先核对服务的实际模型标识、请求路由和权限。该命令会调用所选模型；端点可连接不等于评测证据充分。API 直调不提供原生 Agent 工具轨迹或 mock hooks；需求超出文本输入时查[执行器支持范围](../../reference/integration/executors.md)。

## 本地模型示例

仓库 `examples/custom-executor` 提供 Ollama 适配示例。先阅读该目录说明并确认本地模型服务已启动，再用已安装模型运行：

```bash
cd examples/custom-executor
omk eval --control baseline --treatment echo-assistant   --executor "python ollama-executor.py" --model '<installed-model>'   --no-judge --report-only
```

这是小规模教学用例。`--report-only` 保留结论展示而不让它控制退出码，不证明发布质量。

## 关于评委

`--judge-models` 配置 rubric 评委，格式为 `executor:model[,executor:model]`；应显式选择端点可用的模型。`--no-judge` 跳过该 LLM 评委。RAG assertion 的评委调用有独立边界，不自动继承 rubric 的 repeat／ensemble，见[RAG 规范](../../specs/evaluation/rag-metrics-spec.md)。

<a id="使用非-claude-模型"></a>
