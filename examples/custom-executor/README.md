# custom-executor 示例

不依赖 Claude 也能跑 omk —— 把任意「读 JSON、回 JSON」的脚本接成 executor。**这是零 API key 跑通 omk 的最快路径**，适合第一次上手。

- `echo-executor.sh`：最简执行器，从 stdin 读 `{prompt}`、输出 `{output}`（纯回显，离线）
- `ollama-executor.py`：接本地 Ollama 模型
- `openai-compat-executor.py`：接任意 OpenAI 兼容 API
- `skills/v1/`：一个最简助手 skill；`eval-samples.json`：2 条用例

## 跑（离线、无需 API key）

```bash
cd examples/custom-executor
omk eval --control baseline --treatment v1 --executor ./echo-executor.sh --no-judge
```

echo 执行器只回显 prompt，所以分数本身没意义——这一步是确认「装好了、能跑通、出得了报告」。跑通后把 `--executor` 换成 `ollama-executor.py` 或 `openai-compat-executor.py` 接真实模型。

## 看点

`--executor <脚本>` 让 omk 与模型供应商解耦：同一套用例 / 断言 / verdict 规则，可以跑在 Claude、本地模型或任何自建网关上。
