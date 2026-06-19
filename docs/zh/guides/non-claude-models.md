# 使用非 Claude 模型

**没有 Claude？** 大多数国产模型（GLM、通义千问、Moonshot、DeepSeek 等）都兼容 OpenAI API 格式，可以直接使用 `openai-api` 执行器：

```bash
# GLM（智谱）
export OPENAI_API_KEY="你的智谱 API Key"
export OPENAI_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
omk eval --executor openai-api --model glm-4-plus \
  --judge-models openai-api:glm-4-plus --no-cache

# 通义千问
export OPENAI_API_KEY="你的通义 API Key"
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
omk eval --executor openai-api --model qwen-plus \
  --judge-models openai-api:qwen-plus

# DeepSeek
export OPENAI_API_KEY="你的 DeepSeek API Key"
export OPENAI_BASE_URL="https://api.deepseek.com"
omk eval --executor openai-api --model deepseek-chat \
  --judge-models openai-api:deepseek-chat

# Moonshot（Kimi）
export OPENAI_API_KEY="你的 Moonshot API Key"
export OPENAI_BASE_URL="https://api.moonshot.cn/v1"
omk eval --executor openai-api --model moonshot-v1-8k \
  --judge-models openai-api:moonshot-v1-8k
```

**Ollama 本地模型：**

```bash
cd examples/custom-executor
omk eval --control baseline --treatment echo-assistant \
  --executor "python ollama-executor.py" --model llama3 --no-judge --report-only
```

`--report-only` 适合这组很小的教学样本：omk 仍会输出 verdict，但不会让教学样本量改写命令退出码。

## 关于评委

- `--judge-models <list>` 指定评委，格式 `executor:model[,executor:model]`。默认 `${executor}:haiku`（没设 `--executor` 时为 `claude:haiku`）
- 1 条 = 单评委；≥ 2 条 = 多评委 ensemble + inter-judge agreement
- 没有 Claude 时把 `--judge-models` 指向你可用的模型，例如 `--judge-models openai-api:glm-4-plus`
- 加 `--no-judge` 可跳过 LLM 评委，仅使用断言评分

执行器全表见 [执行器](../reference/executors)，指定被评测对象的方式见 [Artifact 与 variant 布局](../reference/artifact-layout)。
