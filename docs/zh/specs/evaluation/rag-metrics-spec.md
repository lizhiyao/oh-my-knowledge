# RAG metrics 规范

本页规定当前 `faithfulness`、`answer_relevancy` 和 `context_recall` 的输入、评委仪器及结果边界。实现由 `measurement/evaluators/llm-assertions.ts`、`instruments/prompts/judge-prompts.ts` 与 `assertions/layers.ts` 共同约束；公开字段见[样本格式](../../reference/evaluation/eval-sample-format.md)。示例见 [examples/rag-eval/](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/rag-eval)。

## 三件事的关系 {#三件事的关系}

| Metric | 回答的问题 | 输入需求 |
|---|---|---|
| `faithfulness` | 输出是否被声明的 context 支持 | output + assertion.reference，回退至 evaluationContext.reference |
| `answer_relevancy` | 输出是否切题 | output + 文本输入 input.text，编译为 criterion.question |
| `context_recall` | 声明的参考事实是否在输出中使用 | output + assertion.reference，回退至 evaluationContext.reference |

这些指标检验声明的参考资料与输出的关系，不证明参考资料本身正确，也不单独判定检索器召回质量。按待验证问题选择指标；同时使用多个指标仍须明确各自输入和阈值。

## 设计选择 — 为什么是单 LLM 调用而非 RAGAS 多步 {#设计选择-—-为什么是单-llm-调用而非-ragas-多步}

当前 evaluator 对每条 RAG 观测发起一次 1–5 分评委请求，不做原子陈述拆分或逐句评分。一次请求不等于固定成本或延迟，也不能提供逐条事实的诊断。

评委返回的原始分数在 evaluator 内与 `threshold` 比较，生成 Boolean metric observation（若有 negation，再反转判定）；原始分数、理由和阈值保留在 evidence。RAG assertion 被显式归入 `fact` layer，后续统计消费的是已声明的观测及分析结果，不能把原始 1–5 分直接说成 ratio 或连续 composite 分数。

`--judge-repeat` 和 `--judge-models` 配置 rubric 评委，不会自动给这三类 RAG assertion 增加重复或 ensemble。需要重复校准或逐句诊断时，必须另行声明测量设计或实现 custom evaluator；不能靠这些 flag 推定 RAG 已获相同保证。

## Prompt 形态 (1-5 评分锚) {#prompt-形态-1-5-评分锚}

三个 metric 的判分锚点由 `src/eval-workflows/instruments/prompts/judge-prompts.ts` 的 RAG 评委 prompt builder 定义：

### faithfulness {#faithfulness}
- 5 = 全部陈述都有 context 支持，无编造
- 4 = 多数有支持，有 1-2 处不重要的编造
- 3 = 一半有支持
- 2 = 多数无支持
- 1 = 完全编造或与 context 矛盾

默认 threshold = 3 (>= 才 pass)。阈值应按目标场景显式声明；默认值不是生产验收标准。

### answer_relevancy {#answer-relevancy}
- 5 = 完整切题回答，无冗余无遗漏
- 4 = 切题但有少量冗余或小遗漏
- 3 = 部分切题，部分跑题或避而不答
- 2 = 大部分跑题
- 1 = 完全跑题或拒答

默认 threshold = 3。

### context_recall {#context-recall}
- 5 = 全部关键事实被覆盖
- 4 = 大部分覆盖，缺 1-2 条次要事实
- 3 = 一半覆盖
- 2 = 仅覆盖少量
- 1 = 完全未覆盖

默认 threshold = 3。

## Length-debias 自动继承 {#length-debias-自动继承}

三个 RAG prompt 恒含短版 `RAG_LENGTH_DEBIAS` 和 `RAG_PRESENTATION_NEUTRALITY`。以下按原始字节引用长度去偏段落；它与 rubric 全版是不同的冻结仪器，详见[评分等价规范](./evaluation-scoring-equivalence.md)。

```
## 重要：长度不是质量信号
评分时聚焦内容实质，不要因输出更长就给更高分。
简洁正确的回答与冗长正确的回答应得相同分数。
```

`--no-debias-length` 只作用于 rubric，不能关闭 RAG 的这两段指令。包含指令表达评委标准，不证明现实偏置已被消除。

## 与 RAGAS / DeepEval 的对比 {#与-ragas-deepeval-的对比}

本规范只声明 OMK 已实现的行为，不对其他框架的当前版本作能力缺失或统计可靠性排名。跨工具比较必须记录版本、仪器、用例、阈值和统计单元；不同定义的同名指标不能直接横比。

| 边界 | 当前 OMK 行为 |
|---|---|
| 原始评委量尺 | 1–5 分，保存在 evidence |
| Metric observation | 阈值化后的 Boolean，不是原始分数 ratio |
| Composite / comparison | 使用封存的分析图、policy 和证据，不自动校准 RAG 量尺 |
| 重复评委 / ensemble | rubric 的配置不会自动应用到 RAG assertions |
| 去偏指令 | RAG 短版恒开；效果仍需要实测 |

## 用法示例 {#用法示例}

```yaml
samples:
  - sampleId: my_rag_sample
    input:
      inputKind: text
      text: |-
        根据 context 回答 X

        ```
        [gold context here]

        ```
    evaluationContext:
      assertions:
        - type: faithfulness
          threshold: 4
        - type: answer_relevancy
        - type: context_recall
      reference: |
        [gold context here]
schemaVersion: omk.eval-sample-set/v3
```

context_recall 也可以传独立的 gold key facts:

```yaml
- type: context_recall
  reference: "key fact A; key fact B; key fact C"
```

## 已知边界 {#已知边界}

1. 原始分数和阈值尚无适用于所有任务的噪声或误差上界，不能声称固定 ±1 分或固定跨厂商偏差。
2. 比较时固定评委身份、输入资料、阈值和封存设计；更换模型或仪器后重新检查可比性。
3. 默认 threshold = 3，只是默认判定条件；验收标准需要用户按任务预先声明。

## 参考文献 {#参考文献}

研究背景保留原始出处，不作为当前第三方能力或 OMK 接入范围的证明：

- [RAGAS: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217)
- [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)
- [AlpacaEval LC](https://arxiv.org/abs/2404.04475)
