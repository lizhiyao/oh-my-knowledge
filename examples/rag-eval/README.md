# RAG evaluation

这个示例展示 omk 的 RAG 专用断言：

- `faithfulness`
- `answer_relevancy`
- `context_recall`

先预览任务计划，不调用模型：

```bash
omk eval --control baseline --treatment rag-answerer --dry-run
```

样本把上下文直接放在 `eval-samples.yaml` 里。被测 skill 应该基于上下文回答、拒绝上下文未支持的信息，并保持简洁。

配置好执行器和评委后，再跑真实 RAG eval：

```bash
omk eval --control baseline --treatment rag-answerer
```
