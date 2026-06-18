# agent-eval 示例

评测「会调用工具的 agent」而不只是一段 prompt，并演示用控制实验保住构念效度。

- `skills/v1/`：严格四步工作流的代码分析 agent（先确认文件、再读、再统计行数）
- `skills/v2/`：直接式 agent（不做多余操作）
- `eval-samples.json`：带工具调用断言（`tools_called` / `tool_output_contains` / `turns_min` 等）的 agent 任务
- `control-experiments/`：进阶——runtime-context 隔离 / artifact 注入 / 断言判别力三组控制实验，配 `skills/strict-reader/` 受控 artifact

## 跑

```bash
cd examples/agent-eval
omk eval --control v1 --treatment v2
```

会评测两个 agent 在工具调用层面的差异（是否按预期调用 Bash / Read、轮数、最终产物）。

## 看点

agent 评测断言能验「模型有没有真的去调工具 / 读对文件」，而不只看最终文本。`control-experiments/` 演示如何用受控变量把「skill 真的起作用」与「换了 cwd / 注入了 artifact 的副作用」分开——构念效度的实操。
