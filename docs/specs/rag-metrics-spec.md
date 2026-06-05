# RAG metrics spec

Design, prompt shape, and relationship to mainstream approaches for omk's three RAG-specific assertion types (`faithfulness` / `answer_relevancy` / `context_recall`). See the companion example: [examples/rag-eval/](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/rag-eval).

## How the three relate

| Metric | Question it answers | Input requirements |
|---|---|---|
| `faithfulness` | Is the output supported by the context (anti-hallucination)? | output + context (`sample.context` or `assertion.reference`) |
| `answer_relevancy` | Does the output actually answer the prompt? | output + prompt (`sample.prompt`) |
| `context_recall` | Are the key facts from the gold context actually used in the output? | output + reference (`assertion.reference`, or `sample.context` fallback) |

They are most useful together. RAG failures are often "fluently fabricated" (high `answer_relevancy` + low `faithfulness`), which no single metric can surface on its own.

## Design choice — why a single LLM call instead of RAGAS multi-step

The standard [RAGAS](https://docs.ragas.io/) implementation is statement-decomposition:

1. Use an LLM to break the output into atomic statements.
2. Use an LLM to judge each statement against the context.
3. ratio = supported / total

This flow is **more interpretable** (you can see which statement was wrong), but the number of calls **grows linearly**, and it introduces two rounds of LLM noise.

omk's tradeoff: **a single 1-5 score judgment**, consistent with omk's other LLM-judge assertions (`semantic_similarity` has the same shape). Advantages:

- A single call, with predictable cost and latency.
- Composes naturally with omk's existing length-debias / α / bootstrap rigor framework (a single score flows into ratio, into the layer, into composite, into the bootstrap CI).
- No second round of LLM noise.

Drawbacks:

- Coarser granularity than RAGAS — you can't see which specific statement was wrong.
- The judge's own 1-5 scoring stability matters a lot — pair it with `--judge-repeat 3` or a `--judge-models claude:opus,openai:gpt-4o` ensemble to calibrate.

For scenarios that need RAGAS-grade granularity: implement statement-decomposition yourself in a `custom` assertion, or wrap omk's LLM judge output across a layer.

## Prompt shape (1-5 scoring anchors)

The scoring anchors for the three metrics (extracted from `runRagJudge` in `src/grading/assertions.ts`):

### faithfulness
- 5 = every statement is supported by the context, no fabrication
- 4 = most are supported, with 1-2 unimportant fabrications
- 3 = half are supported
- 2 = most are unsupported
- 1 = entirely fabricated or contradicts the context

Default threshold = 3 (>= passes). Use 4 for production scenarios.

### answer_relevancy
- 5 = complete on-topic answer, no redundancy, no omissions
- 4 = on-topic with minor redundancy or small omissions
- 3 = partly on-topic, partly off-topic or evasive
- 2 = mostly off-topic
- 1 = entirely off-topic or refuses to answer

Default threshold = 3.

### context_recall
- 5 = all key facts covered
- 4 = most covered, missing 1-2 minor facts
- 3 = half covered
- 2 = only a few covered
- 1 = not covered at all

Default threshold = 3.

## Length-debias is inherited automatically

The judge prompt for all three metrics **automatically includes the same "length is not a quality signal" paragraph as the main judge**:

```
## 重要:长度不是质量信号
评分时聚焦内容实质,不要因输出更长就给更高分。
简洁正确的回答与冗长正确的回答应得相同分数。
```

This means the length-debias protection **automatically covers** RAG metrics — no separate configuration needed.

## Comparison with RAGAS / DeepEval

| Dimension | omk RAG metrics | RAGAS | DeepEval |
|---|---|---|---|
| Faithfulness implementation | single call, 1-5 score | statement decomp | LLM-based with statement extraction |
| Answer Relevancy | single call, 1-5 score | embedding-based + LLM | LLM-based |
| Context Recall | single call, 1-5 score | statement decomp | LLM-based |
| Length-debias | ✓ (same framework as the main judge) | ✗ | ✗ |
| Bootstrap CI | ✓ (composite layer) | ✗ | ✗ |
| Krippendorff α | ✓ (--gold-dir) | ✗ | ✗ |

omk differentiates on "stacked rigor": granularity is coarser than RAGAS, but every 1-5 score drops automatically into omk's statistical framework, with a bootstrap CI, an α anchor, and length-debias. RAGAS gives you finer diagnostics; omk gives you more reliable statistical conclusions.

## Usage example

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

`context_recall` can also take its own gold key facts:

```yaml
- type: context_recall
  reference: "key fact A; key fact B; key fact C"
```

## Known limitations

1. **The judge's own 1-5 score carries ±1 point of noise** — suppress it with `--judge-repeat 3+`.
2. **Absolute scores across vendors can differ by 0.5-1 point** — compare using only one judge model within a single report.
3. **The default threshold of 3 is lenient** — use 4 or higher for production scenarios.

## References

- RAGAS: [Es et al. 2024 — RAGAS: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217)
- LLM-as-Judge bias survey: [Zheng et al. 2023](https://arxiv.org/abs/2306.05685)
- Length bias in LLM judges: [Wang et al. 2024 — AlpacaEval LC](https://arxiv.org/abs/2404.04475)
