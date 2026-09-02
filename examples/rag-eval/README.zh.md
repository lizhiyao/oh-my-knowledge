# RAG 评测

[English](./README.md)

## 用途

这个示例展示 OMK 的三种 RAG 专用断言：

- `faithfulness`
- `answer_relevancy`
- `context_recall`

用例将检索上下文直接写在 `eval-samples.yaml` 中。被测 skill 应仅根据上下文回答、拒绝没有依据的结论，并保持简洁。

## 运行

先预览封存后的任务计划，不调用模型：

```bash
omk eval --control context-answerer --treatment rag-answerer --dry-run
```

三种 RAG 断言需要语义评估。配置任务 executor 和 LLM 评委后，再运行真实对比：

```bash
omk eval --control context-answerer --treatment rag-answerer
```

## 证据边界

显式 control 可以使用给定信息，但没有 grounding 纪律；treatment 增加了只能依据上下文回答的契约。这是断言协议示例，不是完整的检索系统 benchmark：上下文由用例直接提供，而不是实时检索。三条样本不足以支撑发布决策，也不测量 retriever recall、排序质量或生产语料漂移。
