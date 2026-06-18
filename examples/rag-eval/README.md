# RAG eval 示例

omk 的三个 RAG 专用 metric 演示:`faithfulness` / `answer_relevancy` / `context_recall`。

## 三个 metric 各自回答什么

- **faithfulness** — 输出有没有编造?(anti-hallucination)
- **answer_relevancy** — 输出有没有切题?(catches dodge / topic drift)
- **context_recall** — gold context 里的关键信息,输出真的用了吗?(catches retrieved-but-ignored)

三者互补:一个 RAG 系统可能 retrieve 了对的 context、生成的内容也很流畅(answer_relevancy 高),但事实层面跟 context 对不上(faithfulness 低)——这种"流畅地编造"是 RAG 最常见的失败模式之一。

## 跑示例

本目录自带一个最简 RAG 答题 skill `skills/rag-v1/`（严格基于 context 作答），可直接跑：

```bash
cd examples/rag-eval
omk eval --control baseline --treatment rag-v1 --bootstrap
```

`baseline` 是无 skill 的裸模型对照，`rag-v1` 是「只用 context、没有就明说」的处理组。换成你自己的 RAG skill 即可评测你的系统。

可叠加 `--gold-dir` 引入人工锚点对评分做外部验证，或叠加 `--repeat 5` 看饱和曲线。

> 注：三个 RAG 指标都是 LLM 评委型（没有确定性断言），所以这个示例需要一个真实评委模型才能出分，没有 `--no-judge` 离线模式。

## 实现注脚

omk 当前实现是**单 LLM 调用直接输出 1-5 分**,不是 RAGAS 的多步 statement-decomposition。优势是简单快速、与 omk 其他 LLM-judge assertion 一致;劣势是粒度比 RAGAS 粗。需要 RAGAS 级粒度的场景请用 `custom` assertion 自实现。

三个 metric 的 judge prompt **自动包含与主 judge 同款的"长度不是质量信号"段落**(v3-cot-length),不会因输出更长就给更高分。

完整 prompt 形态见 `docs/specs/rag-metrics-spec.md`。
