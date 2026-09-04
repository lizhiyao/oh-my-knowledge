<!--
title: Statistical rigor — uncertainty, calibration, debiasing, and evidence gates
description: Why Evaluation Core decisions are auditable: preregistered Bootstrap families, explicit Gold comparison, frozen judge prompts, and fail-closed evidence coverage.
-->

# Statistical rigor

omk evaluates a knowledge change by fixing the model and sample design, changing the artifact, and carrying the resulting evidence through a sealed Evaluation Core plan. A higher display score is not release authority. The registered Core Decision must be able to trace its conclusion back to complete, comparable observations and preregistered analysis.

Four safeguards cover different failure modes.

## 1. Bootstrap comparison families

`omk eval` estimates uncertainty from the observed sampling units with a percentile Bootstrap rather than assuming a parametric score distribution.

- Target means and treatment-minus-control intervals are produced by `omk.bootstrap-family-table/v1`.
- Paired designs require an explicit pairing key and never fall back to an independent estimator.
- Multiple treatments share one sealed comparison family. The effective level is `alpha / K`, so adding comparisons cannot silently inflate the family-wise false-positive rate.
- The resample count, nominal alpha, design, target／sample order, and deterministic Mulberry32 stream are part of the Analysis identity. Default CLI resampling uses 1000 draws.
- Missing comparison intervals remain inconclusive. The release policy never substitutes a point estimate.

Implementation: `src/eval-workflows/runtime-adapter/analysis/bootstrap-family-table.ts` and `bootstrap-family-parameters.ts`.

## 2. Gold agreement is explicit calibration

Bootstrap uncertainty answers whether the observed difference is distinguishable from resampling noise. It does not prove that an LLM judge agrees with a human standard.

Gold comparison is therefore a separate authenticated Core projection. The caller selects an exact run, Target, Evaluator, numeric Metric, and optional trial coordinate. Gold and Metric scales must match; ambiguous observations fail instead of being averaged across trials or ensemble members.

The projection reports:

- interval-distance Krippendorff alpha as the primary agreement statistic;
- weighted kappa and Pearson correlation as supporting diagnostics;
- paired-unit Bootstrap uncertainty and structured missing states;
- contamination warnings when annotator and judge identities make agreement optimistic.

Post-hoc Gold comparison is exploratory calibration. It does not retroactively rewrite the preregistered release Decision.

Implementation: the explicit projection is `src/eval-workflows/projections/gold.ts`; the preregistered Core Analysis node is `src/eval-workflows/runtime-adapter/analysis/agreement-table.ts`.

## 3. Judge debiasing and prompt identity

LLM judges can reward verbosity, polished formatting, or confident tone independently of correctness. omk's rubric prompts explicitly neutralize these signals.

- Presentation and tone neutrality are always enabled.
- Length debiasing is enabled by default; `--no-debias-length` disables only the length instruction for controlled research or replication.
- Every scoring prompt has a registry identity and hash. Reports with different evaluator identities or prompt variants are not treated as blind equivalents.
- The frozen hashes are catalogued and guarded by `test/measurement-governance/prompt-registry.ts` and `prompt-registry-freeze.test.ts`. This governance-only manifest is excluded from the published runtime.

Prompt instructions reduce a known bias risk; they do not prove that a judge is unbiased. Gold calibration is the external check.

## 4. Evidence and coverage fail closed

Missing evidence is not a zero score and is not silently dropped from the decision boundary.

- Assertion, judge, dimension, and composite tables preserve observed, missing, invalid, failed, unavailable, and not-started states.
- Structural non-applicability is distinct from a planned observation that was not obtained.
- Coverage is conserved through Analysis lineage and validated again when transported Bundles are read.
- The release Decision requires complete evidence and exact source binding before issuing a directional conclusion.

This prevents a run from looking better merely because difficult coordinates failed to produce a score.

## Release Decision

`omk.release-decision/v4` consumes the authenticated Composite table, Bootstrap family, and optional Judge Ensemble table. Its conclusions are:

| Verdict | Meaning |
|---|---|
| `PROGRESS` | Significant positive comparison and all registered release gates passed |
| `CAUTIOUS` | Positive signal, but a practical-effect, layer, judge-dissent, unmeasured judge-uncertainty, or holdout gate requires review |
| `REGRESSION` | Significant negative comparison |
| `NOISE` | The comparison interval overlaps zero with sufficient observed comparison units |
| `UNDERPOWERED` | The interval overlaps zero and observed comparison units are below the registered minimum |
| `SOLO` | One Target is present and no comparison exists |

Operational status, evidence status, conclusion status, and verdict remain separate. `PROGRESS` authorizes the normal release route only when it also carries `release-gates-passed`. Cross-run stability is an Evaluation Series concern and is never inferred from a single run.

For a paired design, v4 applies the sample-size gate to complete pairs. For an independent design, it uses the smaller observed arm, because the larger arm cannot compensate for missing evidence on the other side. Authored but unobserved samples never turn `UNDERPOWERED` into `NOISE`.

The default `minimum-count` requirement of 20 comparison units is a configurable heuristic evidence floor, not a claim of statistical power. For a release study with defensible prior information, configure an a priori paired-comparison plan in `eval.yaml`:

```yaml
decision:
  power:
    minimumDetectableDifference: 0.5
    expectedDifferenceStandardDeviation: 1.0
    targetPower: 0.8
    assumptionSource: pilot-2026-q3
```

Before execution, omk seals the minimum meaningful treatment-minus-control difference, the externally estimated standard deviation of paired differences, target power, assumption provenance, family-wide alpha, planned comparison count, method identity, and the resulting required complete-pair count. The current method is a two-sided normal approximation with Bonferroni allocation across the planned family; it is an approximation for planning, not a guarantee of the percentile Bootstrap's realized operating characteristics. Complex, strongly discrete, or skewed designs should establish sample size by simulation outside omk and register that result with `decision.minimumComparisonUnits`. omk deliberately does not report retrospective “observed power”: using the run's observed effect or variance to justify its own sample size would be circular.

For a configured Judge Ensemble, v4 estimates cross-judge agreement independently for control and treatment. If either side has fewer than two complete judge-member series across at least two samples, agreement is not estimable; a positive result is reported as `CAUTIOUS` with `judge-uncertainty-unmeasured`, rather than treating one LLM reading as exact. This gate is inapplicable when the design has no Judge Ensemble. Historical v1, v2, and v3 remain registered solely for exact replay; v3 already uses observed comparison units but has only the fixed minimum-count contract.

Planning references: [NIST's two-sided sample-size formulation](https://www.itl.nist.gov/div898/handbook/prc/section2/prc222.htm), [CONSORT 2025 on prespecifying target difference, assumptions, alpha, and power](https://www.bmj.com/content/389/bmj-2024-081124), and [Hoenig and Heisey on the abuse of retrospective power](https://doi.org/10.1198/000313001300339897).

Implementation: `src/eval-workflows/runtime-adapter/analysis/release-decision.ts`.

## Construct validity and audit trail

Statistical machinery cannot rescue a contaminated experiment. Strict baseline isolation prevents the control from discovering the treatment through local skills, workspace files, or agent tooling. Artifact, Dataset, Runtime, evaluator, prompt, policy, and stage identities are sealed before the first Target call.

Each persisted run contains the exact Run Plan, Execution Bundle, Evaluation Bundle, Analysis Bundle, and Evaluation Report, linked by digests. Studio is a rebuildable projection over those artifacts, not a second source of measurement truth. Changes to frozen prompts, five-layer scoring semantics, Bootstrap formulas, Krippendorff alpha, missing-evidence treatment, or length-debias semantics require an explicit `BREAKING-COMPARABILITY` review.

See also [Composite scoring](../specs/scoring.md), [Sample design](../specs/sample-design-spec.md), and the [Evaluation Core cutover guide](../guides/eval-core-cutover.md).
