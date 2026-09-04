<!--
title: Composite scoring — derivation, coverage, and decision boundary
description: How Evaluation Core derives fact, behavior, judge, dimension, and composite evidence without turning missing observations into zero or treating a display score as release authority.
-->

# Composite scoring

Evaluation Core treats scoring as an authenticated evidence graph, not a mutable report row. The historical five-layer contract remains stable—`assertion`, `llm`, `judge`, `dimension`, and `composite`—but those names identify responsibilities rather than five consecutive averages.

```text
criterion observations          raw rubric readings
          │                              │
          ▼                              ▼
 assertion-layer table      replicate → ensemble tables
     fact / behavior                    │
          │                       dimension table
          └──────────────┬───────────────┘
                         ▼
                  composite table
                         │
             Bootstrap comparison family
                         │
                 Release Decision
```

## Assertion layers

Each Boolean criterion is explicitly bound to `fact`, `behavior`, or `excluded-mixed-layer` with a finite positive weight. Classification is sealed in Analysis parameters; the implementation does not infer it from assertion names or evaluator IDs.

For one Target／Sample／Trial coordinate, an observed assertion layer is:

```text
layerScore = 1 + passedObservedWeight / observedWeight × 4
```

The result is rounded to two decimals on a 1–5 scale. Structural non-applicability is excluded from assertion scoring coverage. Analysis Bundle v2 still retains the rectangular input coordinate, classifies it separately as `notApplicable`, and authenticates its row identity and reason through `notApplicableRows`, so it does not degrade evidence completeness. Missing, invalid, failed, unavailable, and not-started observations remain explicit coverage states and never become `false`. If no weight was observed, the layer is missing rather than zero.

Implementation: `omk.assertion-layer-table/v1` in `src/eval-workflows/runtime-adapter/analysis/assertion-layer.ts`.

## Judge and dimension derivation

Raw rubric readings retain their evaluator, metric, instrument, ensemble-member, replicate-group, replicate-index, Sample, Trial, and sampling-unit identities.

- The replicate table averages observed readings for one planned member and preserves non-observed rows.
- The ensemble table gives each observed member mean equal weight and reports agreement only when the required evidence exists.
- The dimension table binds each dimension to one Metric and one upstream ensemble result. Missing upstream evidence remains missing; zero observed dimensions does not become zero.

This prevents retry attempts, judge repeats, ensemble members, Trials, and independent Runs from being collapsed into the same statistical unit.

## Composite derivation

Sealed parameters bind up to three present layers: `fact`, `behavior`, and `judge`. The judge source is either an ensemble consensus or a dimension aggregate.

```text
composite = mean(observed present layers)
```

The aggregate is rounded to two decimals. An absent layer is structural non-applicability; a present but missing layer remains explicit missing evidence. If no planned layer is observed, the composite is missing rather than numeric zero. Every source group and binding is retained in lineage, and transported tables are recomputed during validation.

Implementation: `omk.composite-table/v1` in `src/eval-workflows/runtime-adapter/analysis/composite-table.ts`.

## What the composite can answer

The composite is a comparison signal inside one sealed design. It is useful for a preregistered treatment-minus-control Bootstrap comparison when Dataset, Target conditions, evaluator identities, policy, and layer bindings are held fixed.

It is not an absolute psychometric level. Equal weighting is pragmatic, assertion pass rates and rubric scores have different measurement properties, and designs with different present layers measure different constructs. Do not rank unrelated artifacts, datasets, or runs by their raw composite values.

## Decision boundary

A composite score or positive point estimate cannot authorize release by itself. `omk.release-decision/v4` consumes the exact Composite and Bootstrap-family results, plus an optional Judge Ensemble result, and first checks complete evidence and source lineage.

Its six conclusions are `PROGRESS`, `CAUTIOUS`, `REGRESSION`, `NOISE`, `UNDERPOWERED`, and `SOLO`. A normal release route requires a decided `PROGRESS` carrying `release-gates-passed`. When a Judge Ensemble is bound but cross-judge agreement cannot be estimated for control or treatment, a positive comparison becomes `CAUTIOUS` with `judge-uncertainty-unmeasured`; deterministic evaluations without a Judge Ensemble are unaffected. A nonsignificant paired comparison uses complete pairs for the sample-size gate; an independent comparison uses its smaller observed arm. The sealed requirement is either an explicit minimum or a recomputable a priori paired-comparison plan; no observed run variance enters that plan. Missing intervals remain not-decided; multi-treatment results use the worst registered conclusion; cross-run stability belongs to an Evaluation Series rather than a single-run score. Historical v1, v2, and v3 remain registered for exact replay.

See [Statistical rigor](../explanation/statistical-rigor.md) for uncertainty, agreement, debiasing, and coverage gates.

## Comparability invariant

The five-layer meanings, frozen scoring prompts, Bootstrap formulas, missing-evidence semantics, and length-debias toggle anchor cross-version comparison. A change to these semantics requires an explicit `BREAKING-COMPARABILITY` review. A presentation-only Studio projection must never redefine the score or Decision.
