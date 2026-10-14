# RAG metrics specification

This page specifies inputs, judge instruments, and result boundaries for current `faithfulness`, `answer_relevancy`, and `context_recall`. `measurement/evaluators/llm-assertions.ts`, `instruments/prompts/judge-prompts.ts`, and `assertions/layers.ts` define the implementation. The [sample format](../../reference/evaluation/eval-sample-format.md) owns public fields. See [examples/rag-eval/](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/rag-eval).

## How the three metrics relate

| Metric | Question | Required input |
|---|---|---|
| `faithfulness` | Is the output supported by the declared context? | output + assertion.reference, falling back to evaluationContext.reference |
| `answer_relevancy` | Does the output answer the question? | output + text input input.text, compiled as criterion.question |
| `context_recall` | Does the output use the declared reference facts? | output + assertion.reference, falling back to evaluationContext.reference |

These metrics test the relationship between declared references and output. They prove neither the references' correctness nor retriever recall quality by themselves. Choose metrics for the question being tested; using several still requires explicit inputs and thresholds.

## Design choice — one LLM call instead of RAGAS multi-step

The current evaluator makes one 1–5 judge request per RAG observation. It does not decompose or score atomic statements individually. One request guarantees neither fixed cost nor latency and provides no per-fact diagnosis.

The evaluator compares the raw score with `threshold` to produce a Boolean metric observation, then applies negation if declared. Evidence retains the raw score, reason, and threshold. RAG assertions explicitly belong to the `fact` layer. Later statistics consume declared observations and analysis results: the raw 1–5 score is not directly a ratio or continuous composite score.

`--judge-repeat` and `--judge-models` configure the rubric judge. They do not automatically add repeats or an ensemble to these RAG assertions. Repeated calibration or per-statement diagnosis requires a separate declared measurement design or custom evaluator; these flags do not establish equivalent RAG guarantees.

## Prompt shape (1-5 scoring anchors) {#prompt-shape-1-5-scoring-anchors}

The scoring anchors for the three metrics are implemented by the RAG prompt builders in `src/eval-workflows/instruments/prompts/judge-prompts.ts`:

### faithfulness {#faithfulness}
- 5 = every statement is supported by the context, no fabrication
- 4 = most are supported, with 1-2 unimportant fabrications
- 3 = half are supported
- 2 = most are unsupported
- 1 = entirely fabricated or contradicts the context

Default threshold = 3 (>= passes). Declare a threshold for the intended scenario; the default is not a production acceptance standard.

### answer_relevancy {#answer-relevancy}
- 5 = complete on-topic answer, no redundancy, no omissions
- 4 = on-topic with minor redundancy or small omissions
- 3 = partly on-topic, partly off-topic or evasive
- 2 = mostly off-topic
- 1 = entirely off-topic or refuses to answer

Default threshold = 3.

### context_recall {#context-recall}
- 5 = all key facts covered
- 4 = most covered, missing 1-2 minor facts
- 3 = half covered
- 2 = only a few covered
- 1 = not covered at all

Default threshold = 3.

## Length-debias is inherited automatically {#length-debias-is-inherited-automatically}

All three RAG prompts always include the short `RAG_LENGTH_DEBIAS` and `RAG_PRESENTATION_NEUTRALITY` fragments. The length fragment below is quoted byte-for-byte. It is a different frozen instrument from the full rubric fragment; see [scoring equivalence](./evaluation-scoring-equivalence.md).

```
## 重要：长度不是质量信号
评分时聚焦内容实质，不要因输出更长就给更高分。
简洁正确的回答与冗长正确的回答应得相同分数。
```

`--no-debias-length` affects only the rubric judge and cannot disable either RAG fragment. Instructions declare judge standards; their presence does not prove real bias has been eliminated.

## Comparison with RAGAS / DeepEval {#comparison-with-ragas-deepeval}

This specification declares only implemented OMK behavior. It makes no current-version absence claims or statistical-reliability ranking of other frameworks. Cross-tool comparisons must record versions, instruments, samples, thresholds, and statistical units. Same-name metrics with different definitions cannot be compared directly.

| Boundary | Current OMK behavior |
|---|---|
| Raw judge scale | 1–5, retained in evidence |
| Metric observation | Thresholded Boolean, not a raw-score ratio |
| Composite / comparison | Sealed analysis graph, policy, and evidence; no automatic RAG scale calibration |
| Judge repeats / ensemble | Rubric configuration does not automatically apply to RAG assertions |
| Debiasing instructions | RAG short fragments always enabled; effects still need measurement |

## Usage example {#usage-example}

```yaml
samples:
  - sampleId: my_rag_sample
    input:
      inputKind: text
      text: |-
        Answer X based on the context

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

`context_recall` can also take its own gold key facts:

```yaml
- type: context_recall
  reference: "key fact A; key fact B; key fact C"
```

## Known limitations {#known-limitations}

1. Raw scores and thresholds have no established task-independent noise or error bound. No fixed ±1 score noise or fixed cross-provider difference is guaranteed.
2. Fix judge identity, reference inputs, thresholds, and sealed design when comparing; reassess comparability after changing models or instruments.
3. Default threshold = 3 is a default decision condition. Users must declare task-specific acceptance standards beforehand.

## References {#references}

Original research sources remain as background, not proof of current third-party capabilities or OMK integration scope:

- [RAGAS: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217)
- [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)
- [AlpacaEval LC](https://arxiv.org/abs/2404.04475)
