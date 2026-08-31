# Evaluation scoring equivalence RFC

> Status: migration contract for [#480](https://github.com/lizhiyao/oh-my-knowledge/issues/480). This RFC does not switch `omk eval`, persist Evaluation Core artifacts, or change the legacy Report schema.

## 1. Decision

The current scoring and release semantics will be re-expressed as an Evaluation Core pipeline with four explicit boundaries:

```text
sealed sample evaluation context
  -> host Evaluators: criterion observations and raw judge readings
  -> AnalysisGraph: replicate, ensemble, layer, dimension, and composite derivations
  -> statistical Analysis nodes: intervals, agreement, and corrections
  -> DecisionPolicy: release verdict
```

The migration is validated offline against fixed execution outputs and fixed provider responses. Production dual-run, dual-write, fallback selection, and old-artifact migration are out of scope.

The old pipeline remains the equivalence oracle only while #480 is in progress. New code must not import legacy graders as its implementation. Once production cutover is complete, the duplicated legacy path can be removed instead of becoming a compatibility layer.

## 2. Construct model

The historical term “five-layer scoring” describes five identities, not five consecutive averages:

| Identity | Current meaning | Core role |
|---|---|---|
| assertion | Weighted pass/fail criterion; later classified as fact or behavior | Evaluator observation plus evidence |
| llm | One raw 1–5 reading from one judge invocation | Numeric Evaluator observation |
| judge | Successful replicate mean, then successful ensemble-member mean | Per-unit Analysis results |
| dimension | Named rubric result; dimensions are averaged into the sample judge score | Per-unit Analysis result |
| composite | Equal mean of the present fact, behavior, and judge scores | Per-unit Analysis result |

`dimension` does not currently enter `composite` as an additional fourth score. It is one route for obtaining the judge-layer score. A migration that averages assertion → llm → judge → dimension → composite in sequence would measure a different construct and is rejected.

## 3. Sealed input and applicability

Legacy scoring criteria vary by sample, while Core Evaluator definitions are run-plan-wide. The compiler therefore materializes a scoring projection in each sample's `evaluationContext` and a union of stable Metric definitions for the dataset.

Evaluator families are run-plan-wide and declare only the inputs they need. For a sample to which a declared metric does not apply, the Evaluator emits `missing` with reason `criterion-not-applicable`. It must not emit zero or fabricate a pass. The sample evaluation context, prompt hashes, evaluator configuration, and Metric union are covered by the EvaluationPlan identity before the first Target invocation.

This design avoids three invalid alternatives:

- runtime-created Evaluators, which would evade the sealed plan;
- encoding sample, retry, or repeat state into `evaluatorId` conventions;
- one opaque grader observation containing only the final legacy score.

## 4. Runtime families

The host owns provider calls, prompt registry access, custom-module loading, and content parsing. Evaluation Core owns scheduling, retry, timeout, budget, cache, input binding, evidence policy, cancellation, and lifecycle.

| Runtime family | Input bindings | Observation | Identity requirements |
|---|---|---|---|
| deterministic assertion | output and evaluation context; execution-aware leaves additionally require Core-owned execution facts | Boolean criterion result; assertion detail as evidence | assertion algorithm version and supported type registry |
| custom assertion | output and evaluation context; verified resource lease | Boolean criterion result or structured evaluator failure | module content identity and sandbox/resource policy |
| semantic similarity | output, expected/evaluation context | Boolean threshold result; fixed-response parse evidence | semantic prompt hash, model Runtime identity, threshold |
| RAG metric | output and evaluation context | Boolean threshold result; fixed-response parse evidence | metric-specific prompt hash, model Runtime identity, threshold |
| rubric judge | output, optional trace, evaluation context | Raw numeric reading on the 1–5 scale | rubric prompt hash, debias variant, ensemble member, replicate index, model Runtime identity |

The Core never imports `PROMPT_REGISTRY`. The composition root resolves a frozen prompt and places its hash in the host Runtime identity. `lengthDebias=false` selects only the existing rubric debias-off instrument. Presentation and tone neutrality remain enabled. RAG and semantic prompts have no length-debias switch.

Semantic and RAG assertions use `omk.llm-assertions/v1`. One Evaluator coordinate owns exactly one criterion and one Boolean Metric, so a provider failure cannot suppress or falsify an unrelated criterion. The sealed criterion retains threshold, positive weight, and fact-layer identity for downstream aggregation. The sealed instrument records the assertion type, registry prompt ID, and frozen prompt hash; the Runtime fingerprint additionally binds the selected model configuration and the host invocation Runtime identity. The host invocation port performs exactly one cooperative-cancellation-aware call. It has no retry, timeout, budget, or cache policy of its own.

A strict integer reading in `[1, 5]` with a non-empty explanation produces an observed Boolean threshold result. Non-JSON, malformed JSON, malformed score, out-of-range score, and missing explanation produce distinct invalid observations. Provider failure produces a failed Evaluation record with a redacted stable code. Core timeout and cancellation remain attempt states, and admission failure remains budget censoring. Unknown usage or provider cost stays absent. This is the intentional `BREAKING-COMPARABILITY` correction owned by [#481](https://github.com/lizhiyao/oh-my-knowledge/issues/481); no compatibility mode or legacy reader is provided.

Deterministic assertions are split into two independently identified families. The output-only family binds only output and evaluation context. The execution-aware family recursively computes each assertion tree's least-authority source union, then binds only the required subset of output, Core-owned `execution-facts`, source-neutral trace, and evaluation context. Criteria with different dependency signatures are separate Evaluator groups so unavailable trace cannot suppress a facts-only metric.

Cost uses only a complete provider-reported USD aggregate from `ExecutionFacts.usage.providerCost`; unreported, partial, or mixed-currency cost is a missing observation, never zero. Latency uses trial wall-clock duration from `ExecutionFacts.timing.wallClockDurationMs`. Turn assertions use `omk.source-neutral-trace/v2`'s independent provider/runtime `numTurns` field, never transcript breadth (`fullNumTurns`), attempt count, or retry count. Tool assertions use source-neutral `toolCalls`; mock-hit assertions require source-neutral `mockStats` captured by the configured interception boundary. Missing telemetry remains missing rather than becoming a failed quality assertion. The v2 cutover is intentional and has no v1 compatibility reader: reusing the v1 identity for a different required-field set would make persisted evidence ambiguous.

Each Core `json_schema` criterion compiles in an isolated validator session. The legacy module-global Ajv registry can retain `$id` state across otherwise-independent criteria and make results depend on process history; reproducing that contamination would violate run and binding isolation. This is the explicit `BREAKING-COMPARABILITY` exception owned by [#484](https://github.com/lizhiyao/oh-my-knowledge/issues/484): a later schema that reuses an earlier `$id` may fail in the legacy process only because compilation state leaked, while the Core evaluates both schemas independently. Formal cutover accepts the Core result directly. It does not emulate the old cache, add a compatibility flag, or share a registry across criteria, records, bindings, or runs.

## 5. Identity and statistical units

| Legacy concept | Core identity |
|---|---|
| execution `--repeat` | Target `trialIndex` and `trialId` |
| `--judge-repeat` | Evaluator `replicateGroupId` and `replicateIndex` |
| judge model in an ensemble | `ensembleMemberId` plus resolved Runtime identity |
| provider retry | `attemptNumber` inside one `evaluationId` |
| sample | `sampleId` and sampling-unit identities |
| paired control/treatment observation | `pairingBlockId` |
| batch child evaluation | independent Run identity |

Retry never creates a new measurement replicate. A failed judge replicate remains failed and is not silently replaced by an extra successful call. Aggregators consume only the explicitly planned replicate coordinates and preserve failure counts.

## 6. AnalysisGraph

Per-unit derivations use versioned table envelopes. Each row binds target, sample, trial, metric or dimension identity, input observation IDs, value or structured missing reason, and the exact rounding stage. Downstream nodes consume these tables as Analysis results; they do not create new MetricObservations after Evaluation has completed.

Planned nodes are:

1. `judge-replicate-mean`: mean and sample standard deviation over successful raw readings; zero successful readings is missing.
2. `judge-ensemble-mean`: equal mean over successful member means; member rows and failures remain in the input lineage.
3. `dimension-mean`: equal mean over present dimension scores, rounded to two decimals.
4. `assertion-layer-score`: weighted pass ratio separately for fact and behavior, mapped with `1 + ratio * 4`, rounded to two decimals.
5. `composite-score`: equal mean over present fact, behavior, and judge rows, rounded to two decimals; no present layer yields the historical zero sentinel only in the legacy projection, while the authoritative Core result is inconclusive/missing.

Mixed-layer `assert-set` criteria remain visible assertion observations but are excluded from both fact and behavior. Zero total weight yields a missing layer. A failed rubric judge is missing, not score zero.

The legacy RAG and semantic paths convert provider/parse failure into a failed Boolean assertion. That behavior remains frozen only as historical differential evidence. The Core deliberately does not reproduce it: invalid readings and failed attempts are excluded from assertion-layer pass ratios and reduce coverage instead. A valid reading below the threshold remains observed `false`, so negative content evidence is still counted.

The legacy async path also ignores the otherwise-public `Assertion.not` contract. That independent Boolean-semantics defect is tracked by [#489](https://github.com/lizhiyao/oh-my-knowledge/issues/489) and is not folded into the #481 failure-state correction.

## 7. Statistical standards

The exact migration standards are distinct from similarly named generic Core built-ins when their random stream or conclusion contract differs.

| Legacy standard | Direct Core built-in reuse? | Reason |
|---|---|---|
| arithmetic mean/rate | yes, where no per-unit derived table is required | Same estimand and missing exclusion |
| mean/independent/paired percentile bootstrap | no for exact golden equivalence | Legacy uses Mulberry32 with integer seed `20260616` and rounds endpoints to four decimals; Core `bootstrap.* /v1` domain-separates SHA-derived draws |
| Bonferroni alpha/K | no for exact legacy equivalence | Legacy computes each interval at `alpha/K` and has no p-value table; Core `bonferroni/v1` consumes p-values |
| Krippendorff alpha | new interval-distance Analysis standard | Existing formula is not a Core built-in and undefined cases must become inconclusive |
| release verdict | new OMK release DecisionPolicy | Core `progress/v1` is a single-effect three-way policy, not the six-tier legacy contract |

The equivalence bootstrap standard resamples the declared experimental unit, preserves pairing, uses the frozen random stream, and exposes point estimate, rounded bounds, resample count, alpha, and significance derived from the rounded bounds. It must never fall back to an unpaired estimator. A comparison family seals its members and effective `alpha/K` before interval estimation; it does not manufacture p-values to fit the generic correction built-in.

Degenerate inputs are part of the standard rather than implementation accidents. A legacy mean interval over one observation is the point interval with `samples=0`; a paired difference over one complete pair performs the requested resamples and returns the constant difference. Empty inputs map to an inconclusive authoritative Core result, with the historical all-zero object allowed only in the legacy projection. These cases receive separate golden vectors before the statistical implementation lands.

Krippendorff alpha uses interval distance `delta^2=(c-k)^2`; nominal or ordinal variants are not equivalent. Empty input, one total rating pair, or zero expected disagreement is inconclusive, not numeric zero. The alpha bootstrap resamples paired rating units.

## 8. DecisionPolicy boundary

The release DecisionPolicy consumes named, plan-bound Analysis results and explicit evidence gates. It must reproduce the legacy six verdicts and reason precedence without reading a legacy Report object.

Before a directional conclusion, it checks coverage, required results, assumptions, source trust, and the comparison family. The policy then applies paired confidence intervals, layer gates, sample-size/power status, judge disagreement, stability, and holdout-gap rules. Presentation strings and CLI next-step text remain outside the policy; stable reason codes are authoritative.

`SOLO`, `UNDERPOWERED`, `NOISE`, `PROGRESS`, `CAUTIOUS`, and `REGRESSION` are conclusions, not run statuses. Infrastructure failure remains a failed or not-decided decision.

## 9. Field mapping and rejection rules

| Legacy field/fact | Core artifact | Rejection rule |
|---|---|---|
| `AssertionDetail.type/value/weight/passed/layer` | Boolean observation plus classified evidence | unsupported or malformed type fails during compile/prepare |
| `llmScoreSamples` | raw replicate observations | sample order cannot be inferred from completion order |
| `llmScoreFailures` | failed replicate coverage | failure cannot become an extra zero reading |
| `llmEnsemble` | member-scoped observations and per-member Analysis rows | member identity/model mismatch is incompatible |
| `dimensions[name]` | named metric and dimension table row | empty rubric or undeclared dimension is rejected |
| `layeredScores` | fact/behavior/judge Analysis rows | mixed assertion set cannot be assigned to one layer |
| `compositeScore` | composite Analysis row plus coverage | missing layers cannot be silently reweighted without recording the included set |
| `bootstrapCI`/pairwise CI | interval Analysis records | wrong unit, seed standard, alpha, or pairing is incompatible |
| `humanAgreement.alpha` | agreement Analysis record | non-interval distance standard is incompatible |
| verdict and rationale | DecisionResult reason codes | incomplete evidence cannot yield a directional verdict |
| cost value plus reported flag | Usage provenance | unreported cost remains absent/unknown, never numeric zero |

Host diagnostics that do not affect a Metric or decision remain post-processing. Any diagnostic that changes a conclusion must become a sealed Analysis input or DecisionPolicy parameter.

## 10. Conformance evidence

The first baseline is `test/fixtures/evaluation-core/scoring-equivalence-v1.json`, anchored to commit `38648427`. It freezes:

- all six scoring prompt hashes;
- deterministic assertions, nested same-layer and mixed-layer `assert-set` behavior, weighting, layer mapping, and rounding;
- fixed-response semantic and RAG outcomes and usage;
- judge replicate failures, sample standard deviation, ensemble member evidence, and consensus;
- independent and paired bootstrap vectors under the legacy random stream;
- interval Krippendorff alpha, weighted kappa, Pearson, and alpha bootstrap.

Later migration tests consume the same fixture through the new Core path and compare observations, coverage, evidence, per-unit tables, interval results, usage provenance, and reason codes. Exact identity and status comparisons never use numeric tolerance. Floating-point tolerance is allowed only in formula property tests that are not artifact equality tests.

The semantic/RAG conformance vectors additionally freeze the intentional failure-semantic break: valid pass, valid threshold fail, provider failure, non-JSON, malformed JSON, malformed score, out-of-range score, missing explanation, timeout, cancellation, budget censoring, unknown usage/cost, and the invariant that adding an infrastructure failure cannot lower an observed content pass rate.

## 11. Delivery slices

1. Baseline RFC and immutable legacy fixture.
2. Output-only deterministic assertion Evaluator, followed by execution-aware assertions after #483 and the custom assertion Evaluator.
3. Semantic, RAG, and rubric Evaluators using fixed-response replay.
4. Replicate, ensemble, dimension, assertion-layer, and composite Analysis nodes.
5. Exact bootstrap and agreement Analysis standards.
6. Six-tier release DecisionPolicy.
7. Full offline old/new differential conformance and dependency audit.

Every implementation slice must exercise a prepared Core plan and real Runtime lifecycle, including cancellation and exactly-once disposal. Test implementations use the `test.*` namespace. Production `omk eval`, legacy Report readers/writers, Studio, resume, batch, evolve, gold compare, and artifact graph stay untouched until the separate cutover phase.
