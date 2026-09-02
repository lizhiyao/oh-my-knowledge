# RAG evaluation

[中文说明](./README.zh.md)

## Purpose

This example demonstrates OMK's RAG-specific assertions:

- `faithfulness`
- `answer_relevancy`
- `context_recall`

The samples embed retrieval context in `eval-samples.yaml`. The treatment skill should answer only from that context, decline unsupported claims, and stay concise.

## Run

Preview the sealed task plan without calling a model:

```bash
omk eval --control context-answerer --treatment rag-answerer --dry-run
```

The three RAG assertions require semantic evaluation. After configuring a task executor and an LLM judge, run the real comparison:

```bash
omk eval --control context-answerer --treatment rag-answerer
```

## Evidence boundary

The explicit control can use the supplied information but has no grounding discipline; the treatment adds the context-only contract. This is an assertion-protocol example, not a retrieval-system benchmark: its context is supplied directly rather than retrieved. The three samples are too small for a release decision and do not measure retriever recall, ranking quality, or production corpus drift.
