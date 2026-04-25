# RAG metrics 规范

omk 的三个 RAG 专用 assertion type(`faithfulness` / `answer_relevancy` / `context_recall`)的设计、prompt 形态、与主流方案的关系。配套示例:[examples/rag-eval/](../examples/rag-eval/)。

## 三件事的关系

| Metric | 回答的问题 | 输入需求 |
|---|---|---|
| `faithfulness` | 输出是否被 context 支持 (anti-hallucination) | output + context (sample.context 或 assertion.reference) |
| `answer_relevancy` | 输出是否切题回答了 prompt | output + prompt (sample.prompt) |
| `context_recall` | gold context 中的关键信息是否在输出中被使用 | output + reference (assertion.reference 或 sample.context fallback) |

三个一起用最有效——RAG 失败模式经常是"流畅地编造"(answer_relevancy 高 + faithfulness 低),靠任何单一 metric 看不出。

## 设计选择 — 为什么是单 LLM 调用而非 RAGAS 多步

[RAGAS](https://docs.ragas.io/) 的标准实现是 statement-decomposition:

1. 用 LLM 把输出拆成原子陈述
2. 用 LLM 逐条判断每个陈述是否被 context 支持
3. ratio = supported / total

这个流程**更可解释**(能看到哪条陈述错了)、但**调用次数线性增长**,且引入两轮 LLM 噪声。

omk 的取舍:**单次 1-5 分判断**,与 omk 其他 LLM-judge assertion 一致(`semantic_similarity` 同形态)。优势:

- 单次调用,cost 与 latency 都可预测
- 与 omk 已有的 length-debias / α / bootstrap 严谨性框架自然组合(单分数进 ratio 进 layer 进 composite 进 bootstrap CI)
- 不引入第二轮 LLM 噪声

劣势:

- 粒度比 RAGAS 粗 — 看不到具体哪条陈述错了
- judge 自身的 1-5 评分稳定性影响明显 — 建议配合 `--judge-repeat 3` 或 `--judge-models claude:opus,openai:gpt-4o` ensemble 校准

需要 RAGAS 级粒度的场景:用 `custom` assertion 自己实现 statement-decomposition,或者跨层 wrapping omk 的 LLM judge 输出。

## Prompt 形态 (1-5 评分锚)

三个 metric 的判分锚点(从 `src/grading/assertions.ts` 的 `runRagJudge` 抽取):

### faithfulness
- 5 = 全部陈述都有 context 支持,无编造
- 4 = 多数有支持,有 1-2 处不重要的编造
- 3 = 一半有支持
- 2 = 多数无支持
- 1 = 完全编造或与 context 矛盾

默认 threshold = 3 (>= 才 pass)。建议生产场景用 4。

### answer_relevancy
- 5 = 完整切题回答,无冗余无遗漏
- 4 = 切题但有少量冗余或小遗漏
- 3 = 部分切题,部分跑题或避而不答
- 2 = 大部分跑题
- 1 = 完全跑题或拒答

默认 threshold = 3。

### context_recall
- 5 = 全部关键事实被覆盖
- 4 = 大部分覆盖,缺 1-2 条次要事实
- 3 = 一半覆盖
- 2 = 仅覆盖少量
- 1 = 完全未覆盖

默认 threshold = 3。

## Length-debias 自动继承

三个 metric 的 judge prompt **自动包含与主 judge 同款的"长度不是质量信号"段落**:

```
## 重要:长度不是质量信号
评分时聚焦内容实质,不要因输出更长就给更高分。
简洁正确的回答与冗长正确的回答应得相同分数。
```

这意味着 v0.21 Phase 3a 的 length-debias 保护**自动覆盖** RAG metrics —— 不需要单独配置。

## 与 RAGAS / DeepEval 的对比

| 维度 | omk RAG metrics | RAGAS | DeepEval |
|---|---|---|---|
| Faithfulness 实现 | 单调用 1-5 分 | statement decomp | LLM-based with statement extraction |
| Answer Relevancy | 单调用 1-5 分 | embedding-based + LLM | LLM-based |
| Context Recall | 单调用 1-5 分 | statement decomp | LLM-based |
| Length-debias | ✓ (与主 judge 同框架) | ✗ | ✗ |
| Bootstrap CI | ✓ (composite 层) | ✗ | ✗ |
| Krippendorff α | ✓ (--gold-dir) | ✗ | ✗ |

omk 的差异化在"严谨性叠加":粒度比 RAGAS 粗,但每个 1-5 分都自动落入 omk 的统计框架,有 bootstrap CI、有 α 锚点、有 length-debias。RAGAS 给你更细的诊断,omk 给你更可靠的统计结论。

## 用法示例

```yaml
samples:
  - sample_id: my_rag_sample
    prompt: 根据 context 回答 X
    context: |
      [gold context here]
    assertions:
      - type: faithfulness
        threshold: 4
      - type: answer_relevancy
      - type: context_recall
        # 不传 reference,自动用 sample.context
```

context_recall 也可以传独立的 gold key facts:

```yaml
- type: context_recall
  reference: "key fact A; key fact B; key fact C"
```

## 已知边界

1. **judge 自身 1-5 评分有 ±1 分噪声** — 用 `--judge-repeat 3+` 抑制
2. **跨厂商 judge 之间 absolute 分数可能差 0.5-1 分** — 同 report 内只用一个 judge model 比较
3. **threshold 默认 3 偏宽松** — 生产场景建议用 4 或更高

## 参考文献

- RAGAS: [Es et al. 2024 — RAGAS: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217)
- LLM-as-Judge bias survey: [Zheng et al. 2023](https://arxiv.org/abs/2306.05685)
- Length bias in LLM judges: [Wang et al. 2024 — AlpacaEval LC](https://arxiv.org/abs/2404.04475)
