# Use non-Claude models

**Don't have Claude?** Most Chinese LLMs (GLM, Qwen, Moonshot, DeepSeek, etc.) are OpenAI-API compatible — use the `openai-api` executor directly:

```bash
# GLM (Zhipu)
export OPENAI_API_KEY="your Zhipu API key"
export OPENAI_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
omk eval --executor openai-api --model glm-4-plus \
  --judge-models openai-api:glm-4-plus --no-cache

# Qwen (Alibaba)
export OPENAI_API_KEY="your Qwen API key"
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
omk eval --executor openai-api --model qwen-plus \
  --judge-models openai-api:qwen-plus

# DeepSeek
export OPENAI_API_KEY="your DeepSeek API key"
export OPENAI_BASE_URL="https://api.deepseek.com"
omk eval --executor openai-api --model deepseek-chat \
  --judge-models openai-api:deepseek-chat

# Moonshot (Kimi)
export OPENAI_API_KEY="your Moonshot API key"
export OPENAI_BASE_URL="https://api.moonshot.cn/v1"
omk eval --executor openai-api --model moonshot-v1-8k \
  --judge-models openai-api:moonshot-v1-8k
```

**Ollama local model:**

```bash
omk eval --executor "python examples/custom-executor/ollama-executor.py" \
  --model llama3 --no-judge
```

## About the judge

- `--judge-models <list>` picks the LLM judge(s). Format: `executor:model[,executor:model]`. Default: `${executor}:haiku` (or claude:haiku when no `--executor` set)
- 1 entry = single judge; ≥ 2 entries = multi-judge ensemble + inter-judge agreement
- If you don't have Claude, point `--judge-models` at whatever you have, e.g. `--judge-models openai-api:glm-4-plus`
- Add `--no-judge` to skip the LLM judge and rely on assertions alone

See [Executors](../reference/executors) for the full executor list and [Artifact & variant layout](../reference/artifact-layout) for how to specify what gets evaluated.
