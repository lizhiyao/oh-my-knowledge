# Knowledge-gap signal contracts

This page specifies heuristic signals and aggregation used by production observation. See the [observation guide](../../guides/observe/observe-production.md) for user steps.

## 1. Input and meaning {#current-scope}

`omk observe` converts actual source-trace tools and text into analysis inputs. `computeGapReport` includes entries only when the selected variant exists and `ok !== false`; upstream owns source and task/skill segmentation. Read `sampleCount` and source integrity together; a zero rate does not establish no problems.

Signals identify reviewable failed-search or uncertainty clues. They prove neither absent knowledge, completeness, nor a carrier causing results. Knowledge-file access coverage and Core evidence coverage have separate purposes.

## 2. Four signal types {#current-signals}

| Signal | Current source | Weight |
|---|---|---|
| failed_search | Failed or empty search/file read | 1.0 |
| repeated_failure | At least three consecutive failures of the same search type | 1.0 |
| explicit_marker | Explicit inference/unknown/gap markers in output | 0.5 |
| hedging | Uncertainty phrasing patterns in output | 0.5 |

`observability/analysis/gap-analyzer.ts` and `trace/tool-search.ts` own rule details. Exploratory search, quoted rules, and business hypotheses may cause false positives. Review original context before turning a signal into knowledge or samples.

## 3. Aggregation {#current-aggregation}

`gapRate = samplesWithGap / sampleCount`. The numerator deduplicates signal-bearing sample IDs while the denominator counts included entries. Upstream segments use unique sample IDs; multiple signals do not count an identity twice. `weightedGapRate` averages each entry's highest signal weight. Type counts still count individual signal events.

Rates retain four decimal places. A zero denominator yields zero rates while preserving zero sampleCount. Statistics remain conditional on sources and rules; different source scopes, rules, or task distributions do not directly establish improvement.

## 4. Explicit classifier capability {#current-classifier}

`applyHedgingClassifier` is callable code, not automatically wired into production observation. Callers must supply `model`. Defaults classify at most 50 candidates in batches of 10. Truncated tails and call/parse failures remain conservatively included; results return `truncated`. A candidate cap does not guarantee a monetary budget.

The in-process cache keys by the first 16 characters of the sentence digest; it is not persisted measurement evidence. Model-reported confidence changes no weights and is not calibrated reliability. There is no automatic enablement, default model, or `eval.yaml.hedgingClassifier` configuration.

## 5. Presentation and next actions {#current-display}

Reports retain signal context, denominators, source scope, and limits. Humans review originals before revising knowledge or drafting formal evaluation samples. [Effective observation review](effective-observation-review.md) owns review priorities and annotation application without overwriting original evidence.

Current `omk eval` has neither `--max-gap-rate` nor `--gap-rate-regression`. Automatic sample-expansion nudges, completeness judgments, active competency questions, and cross-evaluation gap gates are undelivered.
