# Custom executor

这个示例用于在不依赖 Claude 的情况下跑通 omk 链路。

目录包含：

- `echo-executor.sh`：最小 JSON stdin/stdout executor，用于零成本烟测。
- `openai-compat-executor.py`：OpenAI 兼容 HTTP executor。
- `ollama-executor.py`：本地 Ollama executor。

不接 Claude，直接生成本地报告：

```bash
omk eval --control baseline --treatment echo-assistant --executor ./echo-executor.sh --no-judge --report-only
```

`--no-judge` 会跳过 LLM 评委，只依赖断言评分。`--report-only` 会保留 verdict 输出，但不让这组很小的教学样本改写命令退出码。

尝试本地 Ollama 模型：

```bash
omk eval --control baseline --treatment echo-assistant \
  --executor "python ollama-executor.py" --model llama3 --no-judge --report-only
```
