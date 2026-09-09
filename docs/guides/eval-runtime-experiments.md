# Design comparisons and reuse evidence

Complete the [service integration guide](./eval-runtime.md) first. Consult the sections you need; this is not a required linear tutorial.

Code fragments use `input`, `variants` and application clients from the [complete integration example](./eval-runtime-scoring.md#exact-match-evaluation) or your application; these are not OMK-provided services.

<a id="prepare-plan"></a>

## Inspect a plan before running

When a host needs dry-run inspection, budget review, or human approval, prepare first:

```ts
const prepared = await prepareEvaluation(input);

console.log(prepared.definition, prepared.policy);
console.log(prepared.planDigest, prepared.resolvedRuntimes);
console.log(prepared.estimatedWork);

const result = await prepared.run({ runId: 'approved-release-42', signal });
```

Preparation resolves capabilities and seals the complete Core Plan without calling a Target or Evaluator. `prepared.run()` executes that exact immutable Plan; mutating the original input after preparation cannot change its Definition, Policy, digest, or behavior. `estimatedWork` reports planned execution and evaluation coordinates before retries or early termination, and explicitly lists duration and provider cost as runtime-dependent. Direct `evaluate(input, options)` is canonically equivalent to `prepareEvaluation(input).run(options)`.
<a id="compare-runs"></a>

## Check whether two runs are comparable

To check whether two independent Runs support an exact comparison, pass their original results to `assessComparability()` and map every intentionally changed Variant as one subject:

```ts
import { assessComparability } from 'oh-my-knowledge';

const assessment = assessComparability({
  comparisonScope: 'decision',
  subjects: [{
    subjectId: 'candidate-under-test',
    leftVariantId: 'candidate',
    rightVariantId: 'candidate',
  }],
  left: previousResult,
  right: candidateResult,
});

if (assessment.comparabilityStatus !== 'compatible') {
  console.error(assessment.designStatus, assessment.evidenceQualificationStatus);
}
```

The assessment never compares scores or decides whether the candidate improved. It checks whether the measurement design remained invariant after the declared subject change and whether both source chains have enough authenticated evidence. Preserve the exact result objects: a clone or deserialized artifact cannot retain the in-process Core source authority and fails closed. Persistent cross-process admission remains available through the advanced Core surface until the Runtime artifact-store adapter lands.
<a id="repeat-run-stability"></a>

## Repeat an evaluation to check stability

If a result looks better but might change on another run, repeat the complete evaluation. An Evaluation Series holds data, scoring, and the measurement seed fixed, then summarizes a selected statistic across runs. Prepare `repeatableInput` separately: keep the comparison analysis ID from the [integration example](./eval-runtime-scoring.md#exact-match-evaluation), use a deterministic service or an executor that actually supports seed control, and declare controlled seed coupling. That example’s `uncontrolled` configuration does not meet exact cross-run comparability requirements; passing it directly to Series yields `inconclusive`, not numerical stability statistics.

Once those prerequisites hold, repeat the evaluation and read its result:

```ts
import { prepareEvaluationSeries } from 'oh-my-knowledge';

const preparedSeries = await prepareEvaluationSeries({
  evaluation: repeatableInput,
  seriesInstanceId: 'release-42-repeatability',
  repeatCount: 10,
  stability: {
    sourceAnalysisId: 'prompt-v1-vs-v2-correct',
    projection: 'interval-estimate',
  },
});

// No Target or Evaluator has run yet.
console.log(preparedSeries.memberPlans, preparedSeries.estimatedWork);

const series = await preparedSeries.run({ signal });
if (series.status === 'failed') throw new Error(series.error.code);
if (series.status === 'cancelled') throw new Error('Series was cancelled.');
if (series.stability?.analysisStatus === 'completed') {
  console.log(series.stability.value.mean);
  console.log(series.stability.value.sampleStandardDeviation);
} else {
  console.error(series.stability);
}
```

Declare the full `repeatCount` before execution. OMK captures the Evaluation declaration once, preregisters every membership, and verifies that all stage-plan digests remain identical while each member receives a unique Run contract. Members run sequentially with Execution and Evaluation cache disabled. A failed or cancelled member retains its actual partial, failed, cancelled, or missing coverage state and is never replaced; the API does not stop early based on observed values. Each member receives its own Run budgets.

The Series experimental unit is one complete Run. Trials, retries, samples, and Judge replicates remain nested within that Run and do not increase `runCount`. The measurement seed is held fixed with the rest of the design, so seed-aware Executors receive the same trial seeds in each member; intentionally varying a Run-level seed requires a different experiment contract. The stability table is descriptive: mean, Bessel-corrected sample variance with denominator `n - 1`, standard deviation, minimum, maximum, and range. It does not issue a release verdict, estimate an iid confidence interval, or establish reproducibility across environments. Every preregistered slot must be eligible and comparable; otherwise stability is inconclusive rather than silently dropping failed or missing Runs. Select a scalar Analysis result with `projection: 'scalar'`; selecting the point estimate from an interval requires the explicit `interval-estimate` projection. Complete evidence is required by default. Allow partial evidence only when that missingness policy is defensible for the intended claim.

`PreparedEvaluationSeries` is single-use, and `seriesInstanceId` names that intentional execution. Use a fresh value for a genuinely new Series. For a direct shortcut, `evaluateSeries(input, options)` is equivalent to preparing and running once.
<a id="reuse-stages"></a>

## Reuse outputs after changing labels or analysis

Correcting expected answers or changing scoring and statistics need not call the model again. Choose a function based on what changed and pass the original result object from the earlier run:

| Change | Function | Work performed again |
|---|---|---|
| Expected answers or scoring | `rescore()` | Scoring, analysis, and decision. |
| Statistical analysis | `reanalyze()` | Analysis and decision. |
| Decision rule | `redecide()` | Decision only. |

Run `evaluate()` again if prompts, execution inputs, or execution settings changed. Names such as `correctedGoldDataset` below represent your revised complete declarations:

```ts
import { reanalyze, redecide, rescore } from 'oh-my-knowledge';

const rescored = await rescore(
  { ...input, dataset: correctedGoldDataset },
  originalResult,
  { runId: 'corrected-gold' },
);
const reanalyzed = await reanalyze(
  { ...input, analyses: revisedAnalyses },
  rescored,
  { runId: 'revised-analysis' },
);
const redecided = await redecide(
  { ...input, analyses: revisedAnalyses, decision: revisedDecision },
  reanalyzed,
  { runId: 'revised-decision' },
);
```

`rescore()` reuses Execution, `reanalyze()` reuses Execution plus Evaluation, and `redecide()` reuses Execution plus Evaluation plus Analysis. Each call takes a complete new declaration so defaults and identities are sealed before the suffix runs. Core rejects any change that belongs to a skipped stage, and only exact canonical result objects from the current process carry the required source authority. Run options, progress events, and budget consumption apply to the newly executed suffix; reused bundles retain their original identity and historical evidence without charging their work again. To reuse persisted Bundle documents across processes, use explicit Core admission with independent provenance verification; a report or JSON clone is never sufficient evidence.
<a id="independent-groups"></a>

## Assign samples to separate version groups

The `paired` design runs both versions on every sample. Use `independent` when each sample should run on just one version, and declare allocation weights. This example stratifies by `locale`; samples must provide `executionContext.locale` and meet the group and stratum minimums. The two teaching samples in the [integration example](./eval-runtime-scoring.md#exact-match-evaluation) are insufficient for these settings:

```ts
comparisons: [{
  comparisonId: 'prompt-v1-vs-v2',
  controlVariantId: 'prompt-v1',
  treatmentVariantIds: ['prompt-v2'],
  metricIds: ['correct'],
}],
experiment: {
  seed: 'release-2026-09-04',
  sampling: {
    samplingKind: 'independent',
    allocations: [
      { variantId: 'prompt-v1', weight: 1 },
      { variantId: 'prompt-v2', weight: 1 },
    ],
    minimumSamplesPerVariant: 20,
    minimumSamplesPerVariantPerStratum: 5,
    stratumKey: '/executionContext/locale',
  },
},
```

OMK deterministically seals one Variant per sample before execution. Repeated trials reuse that assignment; changing the seed, weights, strata, or minima produces a different randomization identity.
<a id="multiple-criteria"></a>

## Apply multiple release criteria together

If release requires both “correctness must not fall too far” and “safety must not decline,” declare both comparisons and thresholds before running. Looking at separate 95% intervals does not preserve a 95% joint coverage target as comparisons accumulate; `comparison-family` adjusts intervals for the declared group. This example assumes `correctness` and `safety` metrics already exist:

```ts
analyses: [{
  analysisId: 'release-family',
  analysisKind: 'comparison-family',
  statistic: 'mean-difference',
  members: [
    {
      analysisId: 'v2-correctness',
      comparisonId: 'prompt-v1-vs-v2',
      treatmentVariantId: 'prompt-v2',
      metricId: 'correctness',
    },
    {
      analysisId: 'v2-safety',
      comparisonId: 'prompt-v1-vs-v2',
      treatmentVariantId: 'prompt-v2',
      metricId: 'safety',
    },
  ],
  confidence: {
    method: 'bonferroni-percentile-bootstrap',
    level: 0.95,
    resamples: 10_000,
  },
}],
decision: {
  decisionKind: 'comparison-family',
  analysisId: 'release-family',
  rule: 'all',
  criteria: [
    { analysisId: 'v2-correctness', minimumEffect: -0.01 },
    { analysisId: 'v2-safety', minimumEffect: 0 },
  ],
},
```

The two member records use 97.5% marginal intervals, targeting at least 95% simultaneous coverage when the marginal interval procedure has its stated coverage. Percentile Bootstrap remains an approximate method, so this correction is not an unconditional finite-sample coverage guarantee. The family record is available as `result.analysisResults['release-family']`; each member remains available under its own `analysisId`. Members are fixed before execution, and the preset never derives p-values from bootstrap intervals.

The optional family `decision` names that outer family plus one bounded criterion for every member. Bounds use raw treatment-minus-control effect units and equality is acceptable. With `rule: 'all'`, OMK returns `RELEASE` only when every complete simultaneous interval lies inside its declared bounds, `BLOCK` when at least one interval lies wholly outside a bound, and not-decided when any interval still crosses a bound. Criteria cannot be omitted, duplicated, added after results, weighted, or collapsed into a composite score.
<a id="composite-score"></a>

## Combine metrics into one score

Use a weighted composite when the product explicitly defines quality as, for example, 70% correctness and 30% conciseness. Establish the tradeoff and fix weights before running. Do not use an average to hide failure on safety or quality requirements that must pass separately. This example assumes both metrics are already defined:

```ts
analyses: [{
  analysisId: 'v2-overall-quality',
  analysisKind: 'composite-comparison-interval',
  compositeMetricId: 'overall-quality',
  comparisonId: 'prompt-v1-vs-v2',
  treatmentVariantId: 'prompt-v2',
  components: [
    { metricId: 'correctness', weight: 0.7 },
    { metricId: 'conciseness', weight: 0.3 },
  ],
  aggregation: { method: 'weighted-mean', missing: 'require-complete' },
  confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 10_000 },
}],
```

Every component must be a boolean Metric or a bounded numeric Metric with a monotonic direction. OMK converts each sealed source Metric to `[0, 1]`, composes complete readings within the experimental unit, and only then bootstraps the derived Metric. Weights are positive, unique by `metricId`, and sum exactly to one; there is no default weighting, scale override, clamp, or renormalization after missing evidence. Use `composite-quality-interval` with `variantId` for one-Variant quality. Use `composite-comparison-interval` with a paired or independent Sampling Design for treatment-minus-control change. A Decision selects either result by its `analysisId`.
