<!--
title: Composite score — how it's computed, and what it can / can't answer
description: The full derivation of omk's composite score: the five-layer scoring pipeline, the ratioToScore formula, missing-dimension handling, and three ad hoc limitations stated plainly. An honest account of the construct-validity boundary, so the number isn't mistaken for an absolute psychometric measure.
-->

# Composite score

The "composite 4.28 / 1.71" you see in an omk report is the subject of this document. Internally it plays three roles — cross-run ranking, bootstrap CI, and verdict comparison signal — making it the **core scalar** of omk's measurement narrative. This document makes two things clear:

1. **How it's computed** — the five-layer scoring pipeline, the ratioToScore formula, missing-dimension handling
2. **What it can / can't answer** — it's fit for A/B comparison, not for use as an absolute psychometric measure

---

## 1. Core formula

```
composite = mean({fact, behavior, judge})   // equal-weight arithmetic mean
```

**fact / behavior**: assertion pass rate, linearly mapped onto a 1-5 scale:

```
factScore = 1 + (passed_weight / total_weight) × 4
behaviorScore = 1 + (passed_weight / total_weight) × 4
```

Pass rate 0% → 1 point, 100% → 5 points. Weighted assertions (`weight: 2` is more important than `weight: 1`) are summed by weight, not by count.

**judge**: the LLM judge scores 1-5 directly against the rubric. omk does no post-processing (no normalization, no anchor-offset removal) — the raw reading enters composite directly.

**Missing dimensions**:

```ts
const scores = [factScore, behaviorScore, judgeScore].filter(non-null);
const composite = scores.reduce(+) / scores.length;
```

If any layer is missing (no assertion configured / no judge configured / scoring failed) → composite is the mean over the remaining layers.

Implementation: `src/grading/layered-scores.ts`. Frozen by `test/grading/judge-hash-frozen.test.ts`; formula drift triggers a comparability break.

---

## 2. Five-layer scoring pipeline architecture

omk's scoring is in fact a layered pipeline:

```
raw observations (LLM output / tool calls / cost / latency)
   ↓
[Layer 1] assertion       —— rule-assertion pass rate (contains / regex / json_schema / tool_called / ...)
   ↓
[Layer 2] llm (raw judge) —— LLM judge raw 1-5 score
   ↓
[Layer 3] judge (rubric)  —— rubric-anchored semantic score (defaults to llm; the two coincide in omk's 0.x phase)
   ↓
[Layer 4] dimension       —— capability-aligned dimension score (capability scoring system, wired in later in 0.x)
   ↓
[Layer 5] composite       —— equal-weight mean of fact / behavior / judge
```

**Currently (v0.x) only three layers actually enter composite**: fact + behavior + judge. The dimension layer does not participate in composite until the capability spec fully lands. assertion is split in the table into two classes — fact (semantic assertions) and behavior (execution-process assertions); the classification rules are in `FACTUAL_ASSERTION_TYPES` / `BEHAVIORAL_ASSERTION_TYPES` at the top of `src/grading/layered-scores.ts`.

---

## 3. Limitations: stated plainly

### ① Equal-weight aggregation is ad hoc

The three layers (fact / behavior / judge) each carry 1/3 weight, **not derived from stakeholder needs**. "The three layers are equally important" is an assertion, not an argument. A psychometrics textbook would require an explicit weighting justification (expert consensus / PCA / factor analysis); omk currently does none of this.

**Practical consequence**: a large gain in fact plus a slight drop in judge can leave composite flat, masking a structural change. omk weakens this risk with "multi-layer independent gates" (see §4), but the risk is not eliminated.

### ② Inconsistent scales added directly

- **fact / behavior**: binary (pass/fail) → pass rate → `1 + ratio × 4` stretched to 1-5
- **judge**: a genuine ordinal score (the LLM gives 1/2/3/4/5)

Stretching binary data into 5 buckets and **adding it directly to a genuine ordinal score, then taking the mean**, violates the principle of measurement scale homogeneity. The rigorous approach is to standardize first (z-score or rank), then aggregate with weights. omk currently does not.

**Practical consequence**: fact pass rate 80% → factScore 4.2; judge gives 4 → judgeScore 4.0. The two 4.x numbers are close in magnitude, but fact's "4.2" and judge's "4.0" carry different information densities (the former is 4 of 5 binary checks passing, the latter is the judge's semantic verdict on the whole output).

### ③ Missing-dimension auto-reduction → not comparable

```
A skill: composite = mean(fact=4.5, behavior=4.0, judge=4.5) = 4.33
B skill: composite = mean(judge=4.33) = 4.33
```

The two 4.33 numbers are identical, **but the constructs are completely different**. Mechanically comparing composites across variants / across skills leads to misjudgment.

**Practical consequence**: when two variants in a report have one with assertions configured and one without, comparing composites is apples-to-oranges. omk's UI currently does not explicitly annotate "how many layers this composite was computed from" — a known gap.

---

## 4. Relationship between multi-layer independent gates and the composite

omk's verdict system (`src/eval-core/verdict.ts`) **does not look at composite alone**. It runs an independent significance test on each of the three layers — fact / behavior / judge:

```
verdict algorithm (condensed):
  for each (control, treatment) pair, run bootstrap CI on (treatment - control) for each layer
  - any layer-gate FAILs (default threshold 3.5)        → REGRESS / CAUTIOUS
  - all layer CIs insignificant                         → NOISE
  - composite significant + all layer-gates PASS        → PROGRESS · SHIP
  - composite significant but some layer-gate FAILs     → CAUTIOUS · INVESTIGATE
  - would be PROGRESS, but the judge ensemble strongly
    disagrees (inter-judge Pearson < 0.4, on control
    or treatment)                                       → CAUTIOUS · judge signal unreliable
```

**What this means**: a composite alone at +2.78 cannot make omk return a SHIP verdict — **all three layers must pass**. This weakens (does not eliminate) the misleading risk of composite's ad hoc aggregation.

The 4 badges in the "methodology audit" section (judges agree / difference significant / saturated / human-aligned) visualize the conclusions of these independent tests, so during review a user can spot the case where "composite looks fine but some layer has a problem". Among these, "judges agree" (inter-judge Pearson) is not merely a visualization: strong multi-judge disagreement (Pearson < 0.4) downgrades a would-be PROGRESS verdict to CAUTIOUS — when the judges can't agree among themselves, the judge-layer signal driving this "improvement" is unreliable.

### The six verdicts at a glance

The verdict you see on a report's top pill (and as the `omk eval` exit signal) is one of six:

| Verdict | Meaning | What to do |
|---|---|---|
| **PROGRESS** | diff CI shows a real positive shift, no layer regressed | ship |
| **CAUTIOUS** | positive shift but a layer broke its gate, the judge ensemble strongly disagrees, or it's not yet powered | investigate before shipping |
| **REGRESS** | diff CI clearly negative, or a layer dropped its gate | don't ship |
| **NOISE** | the diff CI contains 0 — can't separate the change from noise | inconclusive; get more signal |
| **UNDERPOWERED** | N too small (below the pre-flight power band) / saturation low-confidence, no signal | add samples or `--repeat` |
| **SOLO** | single-variant report; nothing to compare against | add a control variant |

Source: `computeVerdict` in `src/eval-core/verdict.ts`. The same rule engine drives both the terse CLI line and the report's verdict pill, so the two always agree.

---

## 5. Recommended usage

| Scenario | Use composite? |
|---|---|
| A/B comparison on the same eval-samples, looking at the delta + bootstrap CI + multi-layer gates | ✓ Holds up |
| Cross-run ranking of "which run scored highest", to pick a report for a deep read | ✓ Holds up (list / trends page usage) |
| Feeding the verdict algorithm to decide SHIP / NO-SHIP | ✓ Holds up (validated by multi-layer gates) |
| Stating in a report that "this skill scores 4.28/5" as an absolute evaluation metric | ✗ Triple ad hoc: equal weight + inconsistent scales + missing-dimension reduction |
| Comparing composites across skills (skill A at 4.5 beats skill B at 3.8) | ✗ Not comparable when A/B use different eval-samples / different configured layers |
| Declaring across versions that "skill v2's absolute level is 4.28" | ✗ Same as above |

**Mantra**: composite is a "**comparison signal**", not an "**absolute level**". The former is held up by bootstrap CI + multi-layer gates; the latter is not.

---

## 6. Measurement invariants and the future path

The invariants registered in `CLAUDE.md` include:

- Report JSON schema field semantics
- Five-layer scoring pipeline semantics (assertion / llm / judge / dimension / composite)
- The judge prompt hash frozen by `judge-hash-frozen.test.ts`
- The Bootstrap CI formula
- Length-debias toggle semantics

**Changing the composite algorithm = `BREAKING-COMPARABILITY`**: all historical reports are invalidated, and cross-version score comparison stops working. This is a red line for omk's long-term trust.

A more rigorous aggregation in the future follows a **v1.0 milestone** path:

1. **Explicit weights**: let SKILL.md / config declare `weights: {fact: w1, behavior: w2, judge: w3}`, with the weights justified
2. **Standardize then aggregate**: z-score or rank each dimension first, then aggregate with weights
3. **Multivariate verdict**: upgrade the current "composite + multi-layer independent gates combined" to multivariate hypothesis testing (Hotelling T² or similar)
4. **Scoring whitepaper**: distill this scheme into an externally auditable methodology document

This is a quarter-scale architectural change, not a patch, and also a potential next-step differentiator for omk ("omk is the AI eval tool that takes measurement science seriously").

---

## 7. Citations and code pointers

- Formula implementation: `src/grading/layered-scores.ts` (`computeLayeredScores` function)
- Verdict algorithm: `src/eval-core/verdict.ts` (`computeVerdict` function + `verdictForPair` multi-layer gate logic)
- Bootstrap CI: `src/eval-core/bootstrap.ts` (pairwise diff CI implementation)
- Invariant freeze test: `test/grading/judge-hash-frozen.test.ts`
- Report UI: `src/renderer/summary.ts` (`renderSummaryCards` renders the composite column + scoring modal)

Sister documents:

- [Statistical rigor](../explanation/statistical-rigor.md) — Bootstrap CI / Krippendorff α / length-debias / saturation curves
- [omk vs comparable tools](../reference/comparison.md)
