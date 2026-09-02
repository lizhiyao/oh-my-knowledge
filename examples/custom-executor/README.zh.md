# 自定义 executor

[English](./README.md)

## 用途

这个示例演示 OMK 的自定义命令 JSON stdin／stdout 契约，不要求使用托管模型。目录包含：

- `echo-executor.sh`：确定性、零成本的协议烟测；
- `ollama-executor.py`：本地 Ollama adapter。

## 运行

跳过 LLM 评委，执行确定性链路：

```bash
omk eval --control baseline --treatment echo-assistant \
  --executor ./echo-executor.sh --no-judge --report-only
```

`--no-judge` 只保留确定性断言。`--report-only` 仍会生成并输出报告，但不会让这组刻意保持很小的样本控制进程退出码。

尝试本地 Ollama 模型：

```bash
omk eval --control baseline --treatment echo-assistant \
  --executor "python ollama-executor.py" --model llama3 --no-judge --report-only
```

## 证据边界

echo 路径只能验证请求传输、executor 响应解析、断言和报告生成。由于输出是预先确定的，并且跳过了评委，它不能测量模型或知识载体质量。Ollama adapter 只是参考实现，生产使用前仍需审核超时、重试、模型生命周期和数据处理要求。托管的 OpenAI-compatible 服务应使用 OMK 内置的 `openai-api` executor，而不是复制自行处理凭证的脚本。
