<!--
title: Glossary — industry ML / stats terms and omk-specific names
description: A quick-reference glossary for omk docs readers. Covers industry-standard terms (bootstrap CI, Δ, Pearson, Krippendorff α, composite score, executor, reliability check) plus omk-internal naming (artifact, verdict, holdout). Each entry gives a one-line definition + where it shows up.
-->

# Glossary

omk docs (blog posts, SKILL.md, CLI output, report pages) freely mix industry-standard ML / statistics / measurement terms. These words are de facto standard in the English community, so this table is a quick-reference index: each entry gives a one-line definition + where it shows up in omk.

> **Scope**: a reader's cheat sheet, not a design spec. omk maintainers follow this vocabulary when writing new docs.
>
> **Sibling docs**: [terminology spec](../specs/terminology-spec.md) (maintainer-internal decision record) / [statistical rigor](../explanation/statistical-rigor.md) / [composite-score construct validity](../specs/scoring.md)

---

## 1. Statistics / measurement

| Term | One-line definition | Where it shows up in omk |
|---|---|---|
| bootstrap CI | Distribution-free 95% confidence interval, computed by resampling (1000 iterations by default) | `omk eval --bootstrap`; the "paired comparison" table on the report page |
| Δ (delta) | Mean difference in composite score between treatment and control | hero "Δ +2.778"; paired comparison table |
| 95% CI | The true mean falls in this interval with 95% probability. CI excluding 0 = a significant difference | hero tooltip; paired comparison table |
| significant | CI excludes 0 (the gap is not by chance) | reliability check ✓ significant-difference badge |
| Pearson r | Pearson correlation coefficient. 1 = perfectly aligned / 0 = unrelated / -1 = perfectly opposed | "cross-sample judge agreement" table for the multi-judge ensemble |
| MAD | Mean absolute deviation. Average distance among judges scoring the same sample. On a 1-5 scale, < 0.5 is tight agreement, > 1.5 is large disagreement | multi-judge agreement table |
| Krippendorff α | Ordinal-weighted multi-judge agreement. α ≥ 0.8 high agreement / 0.667-0.8 acceptable / < 0.4 low | Human gold section |
| p-value | Probability that a gap this large appears by chance; smaller is more significant (0.05 is the usual threshold) | t-test section (not omk's primary path; bootstrap takes priority) |
| effect size | The gap relative to the noise (Cohen's d / Hedges' g), putting a scale on "how big the difference is" | Cohen's d column in the variance / significance table |
| CV | Coefficient of variation, stddev / mean, a stability metric. On a 1-5 scale, < 5% stable / 5-15% medium / > 15% unstable | stability column + hero tooltip |
| stddev (σ) | Standard deviation, a statistic for the magnitude of value fluctuation | stability column |
| saturation | The point where adding more samples no longer changes the conclusion (CI-width shrinkage flattens out) | reliability check "✓ saturated" badge |
| holdout (set) | Independent validation samples the skill never explicitly covered, used to guard against sample-set overfitting | post-evaluation follow-up recommendations |
| construct validity | Whether the measurement actually measures the intended thing (vs measurement error) | scoring.md: composite-score construct-validity argument |
| ad hoc | An implementation choice made without a principled justification — typically "ship it first, justify later" | scoring.md: equal-weight composite aggregation is ad hoc |
| sample-set overfitting | The evaluation set happens to be "already answered," inflating scores | scoring.md / evaluation blog caveat section |
| length debias | Correction for the known LLM-judge bias of scoring longer answers higher | on by default; disable with `omk eval --no-debias-length` |

---

## 2. omk evaluation concepts

| Term | One-line definition | Where it shows up in omk |
|---|---|---|
| artifact | The unified abstraction for omk's "thing under evaluation": skill / prompt / agent / workflow / baseline | determined by experiment role (`--control` / `--treatment` / baseline), not a standalone flag |
| executor | How the model is run: claude / codex / openai-api / gemini | `--executor` parameter; execution-environment fingerprint |
| ensemble (judge) | Multiple LLMs act as judges and score independently, then combine | `--judge-models claude:opus,claude:sonnet` |
| judge | An LLM scoring against a rubric | judge model parameter; evidence table |
| rubric | The detailed criteria a judge follows when scoring (must recognize X / must include Y / at least N items / ...) | rubric field in sample config |
| anchor | A method for calibrating the LLM judge against human standards | `--gold-dir` human anchors |
| gate (layer gate) | Three independent layer significance tests (fact / behavior / judge); a regression in any layer triggers CAUTIOUS+ | verdict algorithm; "variance / significance" table on the report page |
| verdict | One of six tiers: PROGRESS / REGRESS / CAUTIOUS / NOISE / UNDERPOWERED / SOLO | hero badge; CLI verdict output |
| sample (evaluation sample) | A single evaluation case | eval-samples.json |
| eval-samples | The sample config file (each entry has prompt / rubric / assertion / capability) | `omk eval --samples` |
| baseline (reserved variant) | The control group with no skill injected; omk reserves this variant name | `--control baseline` |
| treatment | The experiment group with the skill injected | `--treatment <name>` |
| control | An alias for baseline | `--control <name>` |
| composite (score) | Equal-weight mean of the fact / behavior / judge layers on a 1-5 scale (see scoring.md) | first column of the six-dimension comparison table |
| fact (layer) | Assertion pass rate mapped to 1-5 via `1 + ratio*4` | "📋 Fact" in the six-dimension comparison table |
| behavior (layer) | Pass rate of process-level assertions (tool calls / turns / cost caps) | "🛠️ Behavior" in the six-dimension comparison table |
| judge (layer) | The 1-5 score the judge gives directly against the rubric | "💬 LLM judge" in the six-dimension comparison table |
| dimension | Capability-aligned scoring dimension (not part of composite) | five-layer scoring pipeline architecture |
| reliability check | Four evidence blocks — judge agreement / significant difference / saturation / human alignment — collapsible on the report page | details block on the report page |

---

## 3. Machine learning / AI general

| Term | One-line definition |
|---|---|
| prompt | The input text given to an LLM |
| system prompt | Background instructions injected before user input; for evaluation omk injects the entire SKILL.md as the system prompt |
| agent | An AI that can call tools and run over multiple turns |
| workflow | A multi-step AI process orchestration |
| skill | One of omk's core evaluation targets, usually in the form of a `SKILL.md` |
| tool call | An external function the LLM invokes during execution |
| turn | One interaction unit of "LLM output + user/tool response" |
| context | All the history the LLM sees while generating |
| fingerprint | A version hash from a SHA-256 prefix (12 chars by default), used to verify consistency across runs |
| session trace | The event stream of one complete AI conversation (prompt / tool calls / output / scoring), the object observe parses |

---

## 4. Architecture / omk's three-stage loop

omk's long-term positioning is "knowledge evaluation + management + insight" in one, mapping to a three-stage loop of **inspect / evaluate / observe**:

| Stage | omk command | Question it answers |
|---|---|---|
| inspect | `omk doctor` | Is the skill well-written (static health, 7-dimension LLM-judge checkup) |
| evaluate | `omk eval` | Does the skill help on the samples (A/B comparison + significance + stability) |
| observe | `omk observe` | How does the skill perform in production (full release coming soon) |

Each stage maps to a different verdict gate + a different report UI path.

---

## Writing conventions

The terms above are the shared vocabulary for omk docs. Detailed naming decisions for omk-internal terms (artifact / executor / variant / verdict, etc.) live in the [terminology spec](../specs/terminology-spec.md). The Chinese docs additionally follow GB/T 15834 punctuation and a set of translation rules; those are documented in the Chinese glossary and do not apply to English prose.

---

Sibling docs: [terminology spec](../specs/terminology-spec.md) / [statistical rigor](../explanation/statistical-rigor.md) / [composite-score construct validity](../specs/scoring.md)
