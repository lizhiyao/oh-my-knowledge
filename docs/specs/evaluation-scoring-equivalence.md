# Evaluation scoring equivalence RFC

> Status: implemented migration contract for [#480](https://github.com/lizhiyao/oh-my-knowledge/issues/480). The phased statements below preserve the migration rationale; production `omk eval` now executes this Core scoring graph and persists only Core artifacts after the atomic `BREAKING-SCHEMA` cutover.

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

The old pipeline served only as the bounded equivalence oracle while #480 was in progress. Production cutover is complete, the duplicated path has been removed, and current code must not reintroduce legacy graders as an implementation or compatibility layer.

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
| semantic similarity | output, expected/evaluation context | Boolean threshold result; fixed-response parse evidence | semantic prompt hash, model Runtime identity, threshold, negation |
| RAG metric | output and evaluation context | Boolean threshold result; fixed-response parse evidence | metric-specific prompt hash, model Runtime identity, threshold, negation |
| rubric judge | output, optional trace, evaluation context | Raw numeric reading on the 1–5 scale | rubric prompt hash, debias variant, ensemble member, replicate index, model Runtime identity |

The Core never imports `PROMPT_REGISTRY`. The composition root resolves a frozen prompt and places its hash in the host Runtime identity. `lengthDebias=false` selects only the existing rubric debias-off instrument. Presentation and tone neutrality remain enabled. RAG and semantic prompts have no length-debias switch.

Semantic and RAG assertions use `omk.llm-assertions/v2`. One Evaluator coordinate owns exactly one criterion and one Boolean Metric, so a provider failure cannot suppress or falsify an unrelated criterion. Canonical `applicableSampleIds` removes non-applicable coordinates before evaluation and analysis without merging criteria into a shared provider call. The sealed criterion retains threshold, positive weight, explicit negation, and fact-layer identity for downstream aggregation. Negation is applied only after a valid raw score is compared with the threshold; evidence retains both `rawPassed` and `negated`, and provider failure, invalid response, timeout, cancellation, or budget censoring cannot become an observed pass. The sealed instrument records the assertion type, registry prompt ID, and frozen prompt hash; the Runtime fingerprint additionally binds the selected model configuration and the host invocation Runtime identity. The host invocation port performs exactly one cooperative-cancellation-aware call. It has no retry, timeout, budget, or cache policy of its own.

A strict integer reading in `[1, 5]` with a non-empty explanation produces an observed Boolean threshold result. Non-JSON, malformed JSON, malformed score, out-of-range score, and missing explanation produce distinct invalid observations. Provider failure produces a failed Evaluation record with a redacted stable code. Core timeout and cancellation remain attempt states, and admission failure remains budget censoring. Unknown usage or provider cost stays absent. This is the intentional `BREAKING-COMPARABILITY` correction owned by [#481](https://github.com/lizhiyao/oh-my-knowledge/issues/481); no compatibility mode or legacy reader is provided.

Rubric judging uses `omk.rubric-judge/v1` and the same host-owned single-invocation provider port. Each measurement coordinate emits only one numeric raw reading; replicate and ensemble aggregation remain AnalysisGraph concerns. The instrument seals the existing debias-on or debias-off registry identity together with an explicit `none` or `source-neutral` trace policy. Trace-enabled evaluation binds only `omk.source-neutral-trace/v2`, and its summary-shaping algorithm and schema enter the Runtime fingerprint. A valid response is a JSON object with an integer score in `[1, 5]` and a non-empty reason; reasoning is optional evidence. Protocol failures use the same distinct invalid states as the LLM assertions, while provider failures remain failed records. The Core intentionally rejects the legacy rubric parser's malformed-JSON salvage, numeric-string and fractional coercion, out-of-range readings, empty reasons, and score-zero failure sentinel. This `BREAKING-COMPARABILITY` correction is owned by [#492](https://github.com/lizhiyao/oh-my-knowledge/issues/492), has no compatibility mode, and does not change the frozen rubric prompt bytes or hashes.

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
3. `dimension-weighted-mean`: sealed weighted mean over every planned dimension, rounded to two decimals; any missing dimension makes the aggregate missing.
4. `assertion-layer-score`: weighted pass ratio separately for fact and behavior, mapped with `1 + ratio * 4`, rounded to two decimals.
5. `composite-score`: equal mean over present fact, behavior, and judge rows, rounded to two decimals; no present layer yields the historical zero sentinel only in the legacy projection, while the authoritative Core result is inconclusive/missing.

The first two derivations are implemented by the host-owned Analysis nodes `omk.judge-replicate-table/v2` and `omk.judge-ensemble-table/v2`. The replicate table groups by the complete target／sample／trial／metric／instrument／ensemble-member／replicate-group coordinate, orders the explicitly planned replicate indices without requiring them to be contiguous, and retains every observed or non-observed row. It rounds member means to two decimals and sample standard deviation (`n - 1`) to three decimals. The ensemble table consumes that schema-validated result, gives every observed member mean equal weight, rounds consensus to two decimals, and computes pairwise mean absolute difference over observed members only to three decimals. Fewer than two observed members produces missing agreement. Both output schemas enforce canonical ordering, coverage conservation, content-derived lineage identities, and recomputable statistics during live execution and transported Bundle validation; their Runtime fingerprints bind these estimators, scale, missing policy, rounding rules, and Core-derived pairing／cluster／stratum sampling-unit identities. The v2 identity replaces the pre-cutover v1 contract rather than mutating its schema digest; this correction is owned by [#497](https://github.com/lizhiyao/oh-my-knowledge/issues/497), with no v1 registration or compatibility reader.

The third derivation is implemented by the host-owned `omk.dimension-table/v2` node. Sealed parameters bind each dimension to one Metric, one upstream judge-ensemble Analysis result, and explicit per-sample applicability and weight. Each sample's planned weights must sum to one. The node computes a two-decimal weighted mean only when every planned dimension is observed; an absent group, missing reading, or invalid weight total fails closed to a missing aggregate. Its table validator recomputes coverage and aggregation, enforces canonical ordering and stable bindings, and authenticates weights in content-derived lineage. Every criterion is evaluated by a separate judge call, so criterion ordering inside a multi-criterion prompt is not part of the measurement. Runtime fingerprinting binds these semantics and all upstream, parameter, and output schema identities.

The fourth derivation is implemented by the host-owned `omk.assertion-layer-table/v1` node from [#496](https://github.com/lizhiyao/oh-my-knowledge/issues/496). Its sealed parameters explicitly map each unique criterion and Boolean Metric to `fact`, `behavior`, or `excluded-mixed-layer` plus a finite positive weight; the node never infers classification from assertion names, Evaluator IDs, or evidence. Every target／sample／trial row retains the complete criterion status and Core-derived sampling-unit lineage. `criterion-not-applicable` is structural and excluded from assertion scoring coverage, while Analysis Bundle v2 retains the rectangular coordinate in `planned`, classifies it in the separate `notApplicable` bucket, and authenticates its row identity and reason through `notApplicableRows`. It therefore does not degrade evidence completeness; every other non-observed status still reduces coverage without becoming `false` or score zero. The table validator recomputes weighted scores, coverage, canonical ordering, globally unique source lineage, content-derived group identity, and a criterion design that must remain identical across all measurement units. Runtime fingerprinting binds these semantics and both schema identities. The production CLI consumes this node through the registered Core AnalysisGraph.

The fifth derivation is implemented by the host-owned `omk.composite-table/v2` node from [#512](https://github.com/lizhiyao/oh-my-knowledge/issues/512). Sealed parameters bind fact and behavior layers to an assertion-layer result and bind the judge layer to either an ensemble consensus or a dimension aggregate; no source is inferred from graph position or labels. For each target／sample／trial unit, the node takes the equal mean of present observed layers and rounds to two decimals. An absent source group is structural non-applicability and creates no layer entry, while a present missing group remains explicit evidence; zero observed layers is authoritative missing rather than numeric zero. The validator recomputes the aggregate and coverage, enforces canonical unit／layer ordering, stable bindings, globally unique source-result／source-group lineage, and content-derived group identity. Direct Metric-row coverage is empty because all provenance follows upstream Analysis groups. Real Core DAG conformance covers assertion-only and dimension-backed judge-only plans, including transported Bundle validation, parent-failure blocking, cancellation, and exactly-once disposal. The production CLI consumes this node through the registered Core AnalysisGraph.

This migration intentionally breaks the legacy convention that allowed a failed member's score-zero sentinel to pollute agreement while excluding it from consensus. Failed, invalid, unavailable, and not-started coordinates now remain distinct missing evidence and never become numeric zero. The correction is owned by [#494](https://github.com/lizhiyao/oh-my-knowledge/issues/494), has no compatibility mode, and does not aggregate Evaluator usage into Analysis artifacts.

Mixed-layer `assert-set` criteria remain visible assertion observations but are excluded from both fact and behavior. Zero total weight yields a missing layer. A failed rubric judge is missing, not score zero.

The legacy RAG and semantic paths convert provider/parse failure into a failed Boolean assertion. That behavior remains frozen only as historical differential evidence. The Core deliberately does not reproduce it: invalid readings and failed attempts are excluded from assertion-layer pass ratios and reduce coverage instead. A valid reading below the threshold remains observed `false`, so negative content evidence is still counted.

The legacy async path now applies the public `Assertion.not` contract only to valid semantic, RAG, or custom pass/fail readings. Provider failure, malformed or incomplete judge output, missing RAG input, custom exceptions, and invalid custom results remain failed under negation. The Core seals the same Boolean criterion rule into its v2 Definition and evidence contract. This independent `BREAKING-COMPARABILITY` correction is owned by [#489](https://github.com/lizhiyao/oh-my-knowledge/issues/489); it does not weaken the #481 rule that Core infrastructure and protocol failures remain structured missing evidence instead of observed Boolean false.

## 7. Statistical standards

The exact migration standards are distinct from similarly named generic Core built-ins when their random stream or conclusion contract differs.

| Legacy standard | Direct Core built-in reuse? | Reason |
|---|---|---|
| arithmetic mean/rate | yes, where no per-unit derived table is required | Same estimand and missing exclusion |
| mean/independent/paired percentile bootstrap | no for exact golden equivalence | Legacy uses Mulberry32 with integer seed `20260616` and rounds endpoints to four decimals; Core `bootstrap.* /v1` domain-separates SHA-derived draws |
| Bonferroni alpha/K | no for exact legacy equivalence | Legacy computes each interval at `alpha/K` and has no p-value table; Core `bonferroni/v1` consumes p-values |
| Krippendorff alpha | new interval-distance Analysis standard | Existing formula is not a Core built-in and undefined cases must become inconclusive |
| release verdict | new OMK release DecisionPolicy | Core `progress/v1` is a single-effect three-way policy, not the six-tier legacy contract |

The legacy-equivalence bootstrap standard resamples the declared experimental unit, preserves pairing, uses the frozen random stream, and exposes point estimate, rounded bounds, resample count, alpha, and significance derived from the rounded bounds. It must never fall back to an unpaired estimator. That behavior remains frozen in `omk.bootstrap-family-table/v1` for replay, but is not the production decision standard.

Degenerate inputs are part of the standard rather than implementation accidents. A legacy mean interval over one observation is the point interval with `samples=0`; a paired difference over one complete pair performs the requested resamples and returns the constant difference. Empty inputs map to an inconclusive authoritative Core result, with the historical all-zero object allowed only in the legacy projection. These cases receive separate golden vectors before the statistical implementation lands.

Production uses the host-owned `omk.bootstrap-family-table/v2` Analysis node. It retains the same experimental units, pairing rules, deterministic Mulberry32 stream, and descriptive percentile intervals, but changes the decision evidence under an explicit new identity. `K` is the sealed planned comparison count even when later observations are missing. Significance uses the relevant zero-tail count from unrounded draws rather than rounded interval endpoints. An exact Clopper-Pearson interval quantifies finite-resample Monte Carlo error, with Bonferroni allocation providing 99% simultaneous confidence across the planned family; crossing the `alpha/(2K)` boundary yields `indeterminate`. Strictly signed complete resampling support is an exact proof and needs no Monte Carlo approximation. Every observation, interval, tail count, uncertainty bound, coverage value, ordering rule, and lineage link is recomputed during transported Bundle validation.

Krippendorff alpha uses interval distance `delta^2=(c-k)^2`; nominal or ordinal variants are not equivalent. Empty input, one total rating pair, or zero expected disagreement is inconclusive, not numeric zero. The alpha bootstrap resamples paired rating units.

The standard is implemented by the host-owned `omk.agreement-table/v3` Analysis node, evolved from the v1 node introduced by [#522](https://github.com/lizhiyao/oh-my-knowledge/issues/522). It consumes the schema-sealed weighted Dimension v2 table plus Gold ratings that exist only in Analysis sample context; Execution and Evaluation plans and Bundles never receive that context. The node seals one target, annotator identity, annotation version, numeric scale, JSON pointer, sample order, bootstrap configuration, and the interval-distance alpha definition. Repeated Dimension trials are averaged within each sample while retaining per-sample group coverage and lineage. The output reports Krippendorff alpha as the primary statistic, weighted kappa and Pearson as auxiliary diagnostics, complete bootstrap-draw coverage, and structured missing results for insufficient pairs, zero expected disagreement, undefined statistics, perfect-agreement bootstrap non-applicability, or unexpected invalid draws. v3 retains v2's Krippendorff-recommended bootstrap—resampling paired observed disagreement while holding expected disagreement fixed from the original ratings—and changes the authenticated upstream contract to weighted Dimension v2. v1 and v2 remain registered against Dimension v1 for exact replay. The table is statistically recomputed during transported Bundle validation. Production Gold comparison consumes this authenticated Core projection with explicit selectors.

## 8. DecisionPolicy boundary

The release DecisionPolicy consumes named, plan-bound Analysis results and explicit evidence gates. It must reproduce the legacy six verdicts and reason precedence without reading a legacy Report object.

Before a directional conclusion, it checks coverage, required results, assumptions, source trust, and the comparison family. The policy then applies paired confidence intervals, layer gates, sample-size/power status, judge disagreement, stability, and holdout-gap rules. Presentation strings and CLI next-step text remain outside the policy; stable reason codes are authoritative.

`SOLO`, `UNDERPOWERED`, `NOISE`, `PROGRESS`, `CAUTIOUS`, and `REGRESSION` are conclusions, not run statuses. Infrastructure failure remains a failed or not-decided decision.

The contract is implemented by the host-owned `omk.release-decision/v7` policy, evolved from the v1 policy introduced in [#525](https://github.com/lizhiyao/oh-my-knowledge/issues/525). Its parameters explicitly bind the Composite table, Bootstrap Family v2 table, every applicable Judge Ensemble selector with its sample scope, sealed target and sample order, all gate thresholds, the preregistered sample-size requirement, and an optional disjoint train／holdout partition. The policy validates the estimator-owned `comparisonFamilyResultId`, exact result/schema universe, Composite-to-Bootstrap observation lineage, comparison bindings, and every configured Judge Ensemble's coverage before applying the six-tier precedence. A positive comparison becomes `CAUTIOUS` when any applicable dimension has dissent or unmeasurable cross-judge agreement; deterministic designs without a Judge Ensemble are unaffected. Nonsignificant comparisons apply the sample-size gate to complete pairs or the smaller observed independent arm, never to authored but unobserved samples. A significant positive comparison passes the practical-effect gate only when the persisted percentile lower bound reaches the sealed threshold; the point estimate alone is insufficient. The requirement is either an explicit minimum or a recomputable a priori paired-comparison plan whose assumptions and provenance were sealed before outcomes. A missing interval or Monte Carlo-indeterminate significance remains not-decided; the Core path never falls back to a point estimate. Cross-run stability remains a Series DecisionPolicy concern rather than being inferred from a single Run. Historical release policies v1 through v6 and Bootstrap family v1 remain registered for exact replay.

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

The first baseline is `test/fixtures/eval-core/scoring-equivalence-v1.json`, anchored to commit `38648427`. It freezes:

- all six scoring prompt hashes;
- deterministic assertions, nested same-layer and mixed-layer `assert-set` behavior, weighting, layer mapping, and rounding;
- fixed-response semantic and RAG outcomes and usage;
- judge replicate failures, sample standard deviation, ensemble member evidence, and consensus;
- independent and paired bootstrap vectors under the legacy random stream;
- interval Krippendorff alpha, weighted kappa, Pearson, and alpha bootstrap.

Later migration tests consume the same fixture through the new Core path and compare observations, coverage, evidence, per-unit tables, interval results, usage provenance, and reason codes. Exact identity and status comparisons never use numeric tolerance. Floating-point tolerance is allowed only in formula property tests that are not artifact equality tests.

The semantic/RAG conformance vectors additionally freeze the intentional failure-semantic break: valid pass, valid threshold fail, valid negation, provider failure, non-JSON, malformed JSON, malformed score, out-of-range score, missing explanation, timeout, cancellation, budget censoring, unknown usage/cost, and the invariant that adding an infrastructure failure cannot lower an observed content pass rate. Legacy custom assertion vectors cover valid pass/fail, negation, thrown and timed-out modules, and invalid result objects.

The final offline differential harness was delivered by
[#528](https://github.com/lizhiyao/oh-my-knowledge/issues/528) and removed with its legacy oracle
after cutover. Its immutable input fixture remains at
`test/fixtures/eval-core/scoring-equivalence-v1.json`. Current Core and production-boundary
coverage lives under `test/eval-core/conformance/` and
`test/eval-workflows/production-host/`. The differential harness prepared and executed one
real sealed plan across two Targets and four paired samples, then traversed
`Execution -> Evaluation -> Analysis -> Decision` through the public engine facade. The plan
contains output-only and execution-aware deterministic assertions, all four semantic/RAG
instruments, two rubric ensemble members with two measurement replicates each, assertion-layer,
replicate, ensemble, dimension, composite, Bootstrap-family, Agreement, and release-decision
nodes. The legacy projection is generated independently from the same outputs, fixed provider
readings, Gold ratings, thresholds, and seed.

The harness compares exact criterion readings, structured failure states, coverage, usage and
provider-cost provenance, prompt IDs and frozen hashes, sample/trial/member/replicate/pairing
identities, layer and composite rows, Bootstrap source lineage, Gold lineage, agreement
statistics, release conclusion, and stable reason codes. Runtime-produced schema validators and
artifact digest checks remain active; the test does not construct final tables by calling their
pure functions. No production CLI, Report reader/writer, Studio, resume, batch, evolve, or
persistence path participates in the run.

### 10.1 Historical typed differential exception inventory

The differential harness admits only the following issue-owned differences. Each entry is a
typed value with an explicit `accepted` or `blocking` status; an unlisted mismatch fails exact
comparison.

| Owning issue | Status | Deliberate difference |
|---|---|---|
| [#481](https://github.com/lizhiyao/oh-my-knowledge/issues/481) | accepted | Provider or parse failure remains failed/invalid/missing evidence instead of a Boolean content failure. The full-chain failure probe checks both projections and downstream coverage. |
| [#484](https://github.com/lizhiyao/oh-my-knowledge/issues/484) | accepted | `json_schema` validator sessions are isolated instead of sharing legacy process-global state. |
| [#492](https://github.com/lizhiyao/oh-my-knowledge/issues/492) | accepted | Malformed, coerced, out-of-range, empty-reason, and zero-sentinel rubric responses are not valid readings. |
| [#489](https://github.com/lizhiyao/oh-my-knowledge/issues/489) | accepted | Async assertion negation is sealed and applies only after a valid raw pass/fail reading; invalidity and infrastructure failure cannot become success. |

This inventory is not a compatibility mode. Accepted entries describe the authoritative Core
semantics, and the harness has no remaining differential exception blocking formal cutover.
The production dependency direction remains Core contracts/runtime inward and host
adapters outward: Evaluation Core does not import the legacy Report, CLI, provider SDK,
environment, filesystem, or prompt-registry text. Provider invocation and prompt construction
remain injected host ports; only sealed identities and captured artifacts cross the boundary.

## 11. Delivery slices

1. Baseline RFC and immutable legacy fixture.
2. Output-only deterministic assertion Evaluator, followed by execution-aware assertions after #483 and the custom assertion Evaluator.
3. Semantic, RAG, and rubric Evaluators using fixed-response replay.
4. Replicate, ensemble, dimension, assertion-layer, and composite Analysis nodes.
5. Exact bootstrap and agreement Analysis standards.
6. Six-tier release DecisionPolicy.
7. Full offline old/new differential conformance and dependency audit.

Every implementation slice exercised a prepared Core plan and real Runtime lifecycle, including cancellation and exactly-once disposal. Test implementations use the `test.*` namespace. The later cutover phase connected production `omk eval`, Studio, resume, batch, evolve, Gold comparison, and artifact graph to these contracts and deleted legacy Report readers and writers.
