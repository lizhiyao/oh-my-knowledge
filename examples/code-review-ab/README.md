# Code review A/B

这是 omk 核心对比模型的最小示例：固定模型和样本，只改变知识载体。

- `code-review-v1`：泛泛做代码审查。
- `code-review-v2`：明确要求覆盖安全、健壮性、可维护性和性能。
- `eval-samples.json`：用具体代码片段检查审查行为。

先预览任务计划，不调用模型：

```bash
omk eval --control code-review-v1 --treatment code-review-v2 --dry-run
```

配置好执行器后，再跑真实对比：

```bash
omk eval --control code-review-v1 --treatment code-review-v2
```

内置样本刻意很少，真实运行适合看报告结构，不适合直接做发布决策。

如果还没有配置 Claude，先跑 `custom-executor` 示例。
