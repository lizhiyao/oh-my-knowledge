<!--
title: Statistical rigor — Bootstrap CI, Krippendorff α, length-debias, saturation curves
description: Why omk's eval results are auditable, not just claimed. Distribution-free CIs, judge ↔ human agreement, length-debiased scoring, saturation curves — all on by default.
-->

# Statistical rigor

omk's job is to answer **"the knowledge you give your LLM — what's it actually worth?"** with objective data. The biggest LLM-eval failure mode is **confident bias** — narrow CIs around the wrong answer. omk ships four pieces by default so conclusions can be externally audited.

This page is the depth reference. The README hero callout is the entry; come here for formulas, flags, and the why.

## 1. Bootstrap CI(`--bootstrap`)

**Distribution-free confidence intervals.**

The t-test breaks on ordinal LLM scores (Likert-like buckets, not normal-distributed continuous values). Bootstrap directly resamples the raw observations and stays valid at small N (< 30) and on skewed distributions.

- **Mean CI** per variant — resampled with replacement N times (default 5000)
- **Pairwise diff CI** between two variants — diff of resampled means; if the CI does not cross 0, the difference is significant at the chosen α (default 0.05 → 95% CI)
- **Output**: each `VariantResult.bootstrapCI` carries `[lo, hi]` for mean and pairwise; HTML report draws CI bands; CLI `bench verdict` consumes them in the 6-tier verdict logic

**Reference**: Efron & Tibshirani (1993), "An Introduction to the Bootstrap". omk implementation: `src/eval-core/bootstrap.ts`. Frozen by `judge-hash-frozen.test.ts` to prevent silent formula drift.

## 2. Human Gold + Krippendorff α(`--gold-dir`)

**Judge ↔ human agreement, anchored externally.**

CI tells you "is the judge stable across resamples". α tells you "is the judge agreeing with a human standard". Two complementary axes:

- **Stable + low α** = judge is consistently wrong (systematic bias)
- **Unstable + high α** = judge agrees with humans on average but is noisy
- **Stable + high α** = trust the judge for this rubric
- **Unstable + low α** = judge is broken

omk auto-detects gold-judge collusion: if the gold annotator is the same model as the judge (e.g., both `claude-3.5-sonnet`), α inflates because both share the same biases. omk warns and reports adjusted α.

**Formula**: standard Krippendorff α with ordinal distance metric. Implementation: `src/grading/human-gold.ts`. Inputs: `<gold-dir>/<sample_id>.json` files with human scores per dimension.

## 3. Length-controlled judge prompt(default ON)

**Research shows LLM judges over-weight verbosity.** Longer responses get higher scores, independent of quality. omk's judge prompt explicitly states "length is not a quality signal" + uses chain-of-thought + length normalization heuristics.

- Template hash `v3-cot-length` — older reports use `v2-cot` (pre-debias), reports are visibly different by hash
- `omk bench debias-validate length <reportId>` — re-judges with the opposite setting, reports the score shift; if shift > threshold, original report had measurable length bias
- `--no-debias-length` opt-out for research / replication scenarios
- Reference: Saito et al. (2023), "Verbosity Bias in Preference Labeling by Large Language Models"

**Frozen by**: `test/grading/judge-hash-frozen.test.ts` — byte-level hash freeze prevents silent prompt drift across versions.

## 4. Saturation curve

**Answers "have I run enough samples?"**

With `--repeat ≥ 5`, omk accumulates cumulative N → bootstrap CI sequence. When CI shrink rate stays under 5% across 3 windows, the eval is **saturated** — more samples buy nothing, additional cost is wasted.

- HTML report inlines an SVG saturation curve + verdict label
- `omk bench verdict` uses saturation as one input to the 6-tier verdict logic
- Default window size: 3 consecutive measurements; threshold: 5% relative shrink in CI width
- Reference: this is omk's own design, not a published method. Implementation: `src/eval-core/saturation.ts`

## Why these four together

Each piece guards a different failure mode:

| Failure mode | Guard |
|---|---|
| "v2 looks better but it's within margin of error" | Bootstrap CI(pairwise diff CI not crossing 0) |
| "Judge says v2 is better but I don't trust the judge" | Krippendorff α (judge ↔ human) |
| "Judge is biased toward verbose answers" | Length-controlled judge prompt |
| "I ran 10 samples and stopped — was that enough?" | Saturation curve |

Skip any one and you have a hole. omk ships all four by default; you can opt out of length-debias for research replication, but the others are unconditional.

## Construct-validity isolation(`--strict-baseline`, default ON)

A fifth invariant, separate from the four above but also default-on:

baseline gets the prompt **without** the skill being tested. omk cuts three contamination paths so baseline doesn't silently see the skill it's compared against:

1. SDK skill auto-discovery
2. subagent Skill tool
3. cwd file-system access via the `skills/<name>/` symlink

`eval.yaml` `allowedSkills` allows per-variant whitelists for advanced cases. Without isolation, any "v2 is better than baseline" claim is suspect because baseline may have been reading v2's own SKILL.md through one of the three channels.

See: [docs/sample-design-spec.md](sample-design-spec.md) for related sample-design considerations.

---

## Reproducibility / audit trail

Every report carries:
- omk version (`reportMeta.cliVersion`)
- Node version (`reportMeta.nodeVersion`)
- Judge model + hash (`reportMeta.judgeModel`, `reportMeta.judgePromptHash`)
- Executor runtime fingerprint (`reportMeta.executorRuntime`, `reportMeta.judgeRuntime`)
- Sample fingerprints (`reportMeta.sampleHashes`)
- Skill isolation snapshot (`reportMeta.skillIsolation`)
- Schema version (`reportMeta.schemaVersion`)

Cross-version comparability is enforced by `BREAKING-COMPARABILITY` callouts in [CHANGELOG](../CHANGELOG.md) — when a measurement invariant changes, you'll see it.
