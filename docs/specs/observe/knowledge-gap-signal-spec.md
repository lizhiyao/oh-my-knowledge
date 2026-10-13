# Knowledge-gap signal contracts {#omk-knowledge-gap-signal-specification}

This page specifies heuristic signals and aggregation used by production observation. See the [observation guide](../../guides/observe/observe-production.md) for user steps. Historical proposals at the end are not current capabilities.

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

## 6. Historical design {#current-history}

[Original gap design](history/knowledge-gap-signal-spec-design.md) preserves motivation, formula discussions, proposed trends/gates, and active probing. It is not current configuration or CLI reference. A falling signal rate requires checking sources, task distribution, and rules; it cannot be attributed directly to knowledge improvement.

<!-- Preserve old section links; the archive above owns historical content. -->
<a id="_1-stance-and-positioning"></a>
<a id="_2-why-gap-needs-to-be-its-own-metric"></a>
<a id="_3-the-core-limit-what-it-can-and-cannot-show"></a>
<a id="what-it-can-show-valid-claims"></a>
<a id="what-it-cannot-show-claims-you-must-not-make"></a>
<a id="in-one-sentence"></a>
<a id="_4-the-four-sources-of-gap-signals"></a>
<a id="_1-failed-search-strong-signal-·-auto-detectable"></a>
<a id="_2-explicit-marker-weak-signal-·-text-matching"></a>
<a id="_3-hedging-language-weak-signal-·-llm-assisted-second-pass-judgment"></a>
<a id="_4-repeated-tool-failure-strong-signal-·-behavioral-pattern"></a>
<a id="_5-the-gap-rate-aggregation-formula"></a>
<a id="_6-cross-evaluation-trend"></a>
<a id="_7-what-action-gap-rate-drives"></a>
<a id="_1-mandatory-test-set-watermark"></a>
<a id="_2-gap-inventory-per-evaluation"></a>
<a id="_3-gap-classification-per-evaluation"></a>
<a id="_4-ci-thresholds-cross-evaluation"></a>
<a id="_8-sample-evolution-gap-rate-near-0-is-not-the-finish-line"></a>
<a id="concrete-practices-for-sample-evolution-what-v0-1-can-do"></a>
<a id="the-decision-rule-for-sample-evolution"></a>
<a id="why-this-rule-has-to-be-in-the-spec"></a>
<a id="_9-v0-2-outlook-active-probing-competency-questions"></a>
<a id="_10-known-limits-and-future-work"></a>
<a id="appendix-terminology-mapping"></a>
