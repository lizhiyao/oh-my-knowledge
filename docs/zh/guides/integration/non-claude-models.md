# 使用 OpenAI 兼容端点与本地模型

先准备明确的 control、treatment 和 v3 用例，见[评测入门](../../quickstart-skill-eval.md)。执行器决定调用方式，模型名和端点由你实际可访问的服务决定；不把历史示例里的模型名当成当前可用清单。

## OpenAI 兼容 HTTP 端点

当前 `openai-api` 将 `/v1/chat/completions` 追加到 `OPENAI_BASE_URL`，用 Bearer API key 发送文本消息。因此 Base URL 必须停在这段路径之前；不要重复填写 `/v1` 或尾部 `/`。只有请求形态匹配的服务才能使用，非标准路由需要自己的适配器。

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
