# Evaluation Core vNext RFC

> **Status**: Accepted by [#426](https://github.com/lizhiyao/oh-my-knowledge/pull/426). Tracks [#425](https://github.com/lizhiyao/oh-my-knowledge/issues/425) and is the architecture prerequisite for [#424](https://github.com/lizhiyao/oh-my-knowledge/issues/424). This RFC defines a new Evaluation Core domain and measurement contract. It is intentionally incompatible with the current `runEvaluation`, file-based Sample, and Report JSON schema. The old pipeline is evidence for algorithms and failure modes, not a compatibility target.

## 1. Summary

Evaluation Core vNext is a host-neutral, in-memory, re-scorable evaluation kernel. It separates an evaluation into four independently verifiable and recomputable stages:

```text
EvaluationDefinition + MeasurementPolicy
        │ prepare / validate / resolve capabilities / seal
        ▼
  Immutable RunPlan
        │
        ├── execute ──> ExecutionBundle
        │                  │
        │                  └── evaluate / re-evaluate
        ▼
      EvaluationBundle
        │
        └── reduce / compare / infer
                           ▼
                    AnalysisBundle
                           │
                           └── decide ──> EvaluationReport
```

Core decisions:

- Execution, Evaluation, Analysis, and Decision are separate stages.
- Bundles are immutable facts; a Report is a materialized view.
- Evaluators share one execution protocol, while Metrics, Reducers, and DecisionPolicy remain separate.
- Gold is isolated through distinct data projections and digests and cannot affect Target execution.
- Every policy that can change output, missingness, order, or conclusions is sealed before the first external call.
- Events are side-channel lifecycle notifications, not the sole source of truth.
- A digest proves content identity; it is not a claim of reproducibility or provenance.

## 2. Problem

The current pipeline joins CLI flags, file parsing, artifact resolution, executors, scoring, statistics, report persistence, and progress callbacks into one workflow. It has validated assertions, LLM judges, paired bootstrap, stability analysis, and runtime fingerprints, but is not a durable public kernel:

- Evaluators cannot be changed without re-running the Target.
- A Definition containing paths, functions, or host state cannot be reliably serialized or content-addressed.
- Gold isolation depends on convention rather than a capability boundary.
- Timeout, budget, retry, and cache can change the measurement but are not represented by one sealed identity.
- One Report carries facts, analysis, presentation, and persistence concerns.
- Process-global resources make concurrent Runs difficult to isolate.
- The current composite's equal weights, mixed scales, and missing-dimension reduction are unsuitable as new-core defaults.

## 3. Goals and non-goals

### Goals

1. Separate pure-JSON intent from trusted Runtime implementations.
2. Support functions, models, RAG, agents, workflows, and externally executed outputs without host-specific Core branches.
3. Support re-evaluation, re-analysis, and re-decision with complete derivation lineage.
4. Make statistical design, missingness, caching, and budgets explicit measurement contracts.
5. Isolate resources, cancellation, events, and caches between concurrent Runs.
6. Provide one Core for the package-root embedded API, CLI, Studio, and future hosts.

### Non-goals

- Compatibility with historical APIs, Samples, or Report schemas.
- CLI, Studio, file paths, databases, queues, tenancy, or UI.
- Distributed scheduling, checkpoint/resume, or a workflow engine.
- Online production scoring, general APM, or real-time alerting.
- Sandboxing untrusted user-uploaded code.
- Provider-specific fields for a model, RAG product, or FaaS.

## 4. Design principles and measurement invariants

### 4.1 Define the estimand before execution

An evaluation does not run first and decide later what available data means. Definition, SamplingDesign, Metrics, Reducers, Comparisons, and DecisionPolicy define the estimand. A sealed RunPlan must exist before the first Target call.

### 4.2 A unified interface is not a unified score

Assertions, structured scorers, and LLM judges are Evaluator implementations, but may emit values on different scales. Core does not normalize to 0–1, average by default, or silently reweight when a dimension is missing.

### 4.3 Missing is not zero

Execution errors, evaluation errors, cancellation, budget censoring, and unresolved content remain distinct. Every Reducer and DecisionPolicy declares how it handles missing data; unmet assumptions yield an inconclusive result.

### 4.4 A cache hit is not a new trial

A cached stochastic output cannot count as a new independent trial. Replay preserves the original trial identity and provenance. Transparent Execution cache reuse is limited to Targets verified as deterministic.

### 4.5 Comparability is an explicit relation

Different Bundle digests do not automatically mean incomparable, and equal digests do not prove a valid experimental design. ComparabilityPolicy inspects Dataset projections, Targets, Runtimes, Evaluators, SamplingDesign, and DecisionPolicy and returns compatible, conditional, or incompatible with reasons.

### 4.6 Standards-compatible, not standards-shaped

Core domain types remain minimal and host-neutral. CloudEvents, OpenTelemetry/OpenInference, W3C Trace Context, and experiment platforms are adapter mappings, not Core SDK dependencies.

## 5. Domain model

### 5.1 Definition

A Definition is immutable, serializable intent. It contains no function, class instance, absolute path, or process state.

```ts
interface EvaluationDefinition {
  schemaVersion: 'omk.evaluation-definition/v1';
  dataset: EvaluationDataset;
  targets: readonly TargetDefinition[];
  evaluators: readonly EvaluatorDefinition[];
  metrics: readonly MetricDefinition[];
  analysisGraph: AnalysisGraphDefinition;
  comparisons: readonly ComparisonDefinition[];
  decisionPolicy?: DecisionPolicyDefinition;
  extensions?: Readonly<Record<string, JsonValue>>;
}
```

Unknown top-level fields are rejected to catch misspellings. Extensions live only under namespaced `extensions` and declare their own schema URI and digest.

Wire contracts use the repository's existing Zod 4 schemas as the single source of truth and are restricted to the subset that exports completely to JSON Schema 2020-12. CI generates and checks published schemas with `z.toJSONSchema()`. Encountering unrepresentable constructs such as transforms, dates, maps, sets, or custom types is an error and never degrades to `{}`. Cross-field, capability, and statistical-assumption validation belongs to the prepare compiler rather than an unexportable schema refinement.

### 5.2 Dataset and case projections

```ts
interface EvaluationSample {
  sampleId: string;
  input: JsonValue;
  executionContext?: JsonValue;
  expected?: JsonValue;
  evaluationContext?: JsonValue;
  annotations?: JsonValue;
}
```

- An Executor receives only a frozen projection of `input + executionContext`.
- An Evaluator may declaratively read output/trace/expected/evaluationContext.
- `annotations` are audit and presentation data and affect neither execution nor scoring.
- Mappings use restricted JSON Pointer by default and select one value. Multi-value JSONPath is an adapter extension.

A Dataset has three distinct digests:

| Digest | Coverage | Purpose |
|---|---|---|
| `datasetRevisionDigest` | complete Dataset | lineage and audit |
| `executionInputDigest` | `input + executionContext` | ExecutionPlan identity |
| `evaluationInputDigest` | execution projection plus `expected + evaluationContext` | EvaluationPlan identity |

Changing Gold or evaluator-only metadata cannot change the ExecutionPlan, schedule, or anything observable by an Executor.

### 5.3 Target and Runtime capabilities

```ts
interface TargetDefinition {
  targetId: string;
  targetKind: string;
  protocolId: string;
  executorId: string;
  versionConstraint?: string;
  config?: JsonValue;
}
```

`targetKind` is descriptive and never drives a Core-orchestrator switch. Behavior comes from a versioned protocol family, input/output schemas, and a capability manifest. Capabilities negotiate optional behavior; they do not replace the type system.

v1 defines only two built-in protocol families:

- `omk.invoke/v1`: one structured request/response per trial with an optional source-neutral trace; covers pure functions, models, services, RAG, and stateless workflows.
- `omk.session/v1`: an isolated session lifecycle per trial with multi-turn messages, tool calls, and partial trajectories; covers agents and stateful workflows.

Every protocol manifest also declares structured execution capabilities: concurrency safety and limits, cancellation semantics, run resource lifecycle, trial state, seed control, determinism, and trace/usage telemetry. Run-scoped resources may reuse infrastructure such as connection pools and clients; business state remains isolated per trial for `omk.session/v1`, while `omk.invoke/v1` remains stateless. A runtime declaring `cancellation: unsupported` cannot be combined with a timeout policy. A stochastic Runtime without seed control can use only an `uncontrolled` seed design. Transparent Execution cache hits require both deterministic capability and verified Runtime assurance.

Importing host-executed results is not a third execution protocol; Core validates and accepts an ExecutionBundle directly. Protocol IDs are immutable contracts. Incompatible changes use a new major path, while optional capabilities may only add behavior without changing existing field semantics.

The Runtime resolves the actual implementation during prepare:

```ts
interface RuntimeIdentity {
  implementationId: string;
  version?: string;
  fingerprint: string;
  fingerprintBasis: 'content-derived' | 'environment-derived' | 'self-reported' | 'opaque';
  assuranceLevel: 'verified' | 'declared' | 'unknown';
  capabilities: JsonValue;
}
```

Caller-supplied versions and fingerprints are requirements, not facts. The Report records the identity resolved by Runtime. Remote model deployment, tools, sandbox, dependencies, and environment live in provenance facets.

### 5.4 ExperimentDesign and SamplingDesign

```ts
interface SamplingDesign {
  experimentalUnit: 'sample' | 'run' | 'cluster';
  pairingKey?: string;
  clusterKey?: string;
  stratumKey?: string;
  repeatedMeasures: boolean;
  resamplingUnit: 'sample' | 'paired-block' | 'cluster' | 'run';
  estimatorId: string;
  seedCoupling: 'shared-within-block' | 'independent-by-target' | 'uncontrolled';
}

interface ExperimentDesign {
  trials: number;
  seed: string;
  sampling: SamplingDesign;
  scheduling: SchedulingPolicy;
}
```

A trial is one repeated measurement under the same condition. A retry attempt is infrastructure recovery within one trial. They are not interchangeable. Statistical implementations validate that they support the SamplingDesign during prepare and never treat repeated trials as independent samples by default.

Paired comparisons use a scheduling block as the dispatch atom. The compiler materializes comparison connectivity as canonical `ExecutionPlan.schedulingTargetGroups`: overlapping comparisons form one connected Target group, while unreferenced Targets remain singleton groups. These groups are covered by `executionPlanDigest`, so changing paired connectivity creates a new Execution identity. Comparison labels, treatment roles, and metric projections do not change Execution or Evaluation identity, but they do change Analysis identity and every downstream digest. `seedCoupling` explicitly chooses whether Targets for the same sample in a block share a random condition, derive independent per-Target conditions, or honestly declare Target randomness uncontrolled; an Executor cannot infer this choice. The sample coordinate always enters seed derivation so that distinct samples in a larger block never reuse a seed accidentally. A block is not started unless budget exists for all arms. Coordinates that never start are budget-censored, create no attempt, and are excluded from the primary paired estimator.

`pairingBlockId`, `clusterId`, and `stratumId` express distinct statistical membership, while `schedulingBlockId` identifies only the dispatch atom. They never share one ambiguous ID. Scheduling identity hashes the canonical full set of `(targetId, sampleId)` coordinates plus sampling-unit IDs that affect dispatch; splitting membership into independent Target and sample sets would lose incidence. Each ID is domain-separated from the Plan digest and a canonical member set rather than hashing a low-entropy raw pairing, cluster, or stratum value.

### 5.5 Evaluator, Metric, Reducer, and DecisionPolicy

```ts
interface MetricDefinition {
  metricId: string;
  valueType: 'numeric' | 'boolean' | 'categorical' | 'text' | 'ranking';
  scope: 'sample' | 'target' | 'comparison' | 'run';
  scale?: { min?: number; max?: number };
  unit?: string;
  direction?: 'higher-is-better' | 'lower-is-better' | 'target-is-best';
  missingPolicyId: string;
}
```

- An Evaluator is trusted executable code that emits MetricObservations and evidence.
- MetricDefinition gives values meaning and executes no code.
- A Reducer derives AnalysisResults from observations.
- DecisionPolicy consumes named AnalysisResults and produces a verdict.
- Weights belong only to an explicit composite reducer, never to every Metric.

Complex analysis is a directed acyclic AnalysisGraph. Every node declares inputs, output schema, implementation identity, and parameters. Its resolved capability seals a parameter schema plus separate cardinalities for Metric, upstream-result, and Comparison inputs. Core validates parameters and materializes defaults before computing plan digests, so absent, malformed, and silently ignored options cannot collapse to the same runtime behavior. Completed-result validation receives those sealed parameters as context: metadata echoed by an estimator, including interval confidence and resample count or a correction's alpha, must agree with the plan in both live execution and Bundle revalidation. Core independently derives interval `unitCount` from included rows and the sealed resampling unit; a paired block counts only when both declared contrast targets are included. A percentile interval is not required to contain its point estimate, but its endpoints remain ordered (`lower <= upper`). Prepare rejects cycles, missing dependencies, value-domain mismatches, and cardinality mismatches.

Every DecisionPolicy comparison-family member declares `(comparisonId, treatmentTargetId, metricId, analysisResultId)`. That AnalysisResult's producer must consume exactly the member's Metric and Comparison selector, with no family-external inputs. An uncorrected singleton's result must be consumed directly by the DecisionPolicy. A corrected family additionally gives every member a canonical `hypothesisId`; its correction node must consume exactly the members' `analysisResultId` values, and the DecisionPolicy consumes the unique correction result. A family with more than one member must bind correction; an empty or singleton family cannot claim multiple-comparison correction. Decision receives only projected contrasts carrying their result and optional hypothesis identities, never the enclosing Comparison's unrelated treatments or Metrics. The correction table must contain the same canonical hypothesis IDs, family size, and raw p-values before a verdict can be produced. The built-in `progress/v1` policy selects the one result bound by a singleton contrast, or the only declared result when no family exists; it returns not-decided for ambiguous inputs and does not claim multiple-comparison support. Multi-contrast release semantics require a dedicated DecisionPolicy.

v1 keeps its built-in reducers and estimators minimal:

- `descriptive.mean/v1`, `descriptive.rate/v1`, and `descriptive.quantile/v1`;
- `bootstrap.mean-percentile/v1`;
- `bootstrap.paired-difference-percentile/v1`;
- `bootstrap.cluster-percentile/v1`;
- `bonferroni/v1` for multiple-comparison correction.

Alpha, resample count, resampling unit, and seed enter AnalysisPlan. v1 does not embed parametric methods such as t-tests, ANOVA, or Hotelling T². Future estimators are added through AnalysisRegistry identities without changing observation or Bundle contracts. Prepare fails when an estimator does not support the value domain or SamplingDesign and never switches algorithms implicitly.

Re-analysis and re-decision preserve parent Bundle digest, policy digest, derivation time, and `analysisMode: preregistered | exploratory`. Thresholds or methods chosen after observing results cannot masquerade as pre-sealed release gates.

## 6. Plans, Bundles, and Reports

### 6.1 Sealed RunPlan

```ts
interface MeasurementPolicy {
  execution: ExecutionPolicy;
  retry: RetryPolicy;
  budget: BudgetPolicy;
  evaluation: EvaluationRuntimePolicy;
  cache: CachePolicy;
  evidence: EvidencePolicy;
  failure: FailurePolicy;
  eventDelivery: EventDeliveryPolicy;
}
```

Every option that can change output, missingness, scheduling, evidence completeness, or conclusions belongs to MeasurementPolicy and enters the RunPlan and relevant digest during prepare. `start()` accepts only an external AbortSignal, annotations, EventWriter, and observer options that cannot affect measurement results; it cannot override measurement policy.

### 6.2 ExecutionBundle

Records use canonical `(targetId, sampleId, trialIndex)` order. Each carries an ExecutionPlan-derived `trialId`, `trialSeed`, `schedulingBlockId`, and distinct sampling-unit IDs:

- completed output may be inline, a ContentDescriptor, digest-only, or omitted according to EvidencePolicy; omission does not change execution status;
- source-neutral trace;
- trial-level aggregatable usage and timing;
- retry attempts with exact per-invocation usage and provider-reported cost;
- execution error;
- RuntimeIdentity;
- execution and cache/replay provenance;
- parent Plan digest and Bundle digest.

Started records and budget-censored records are disjoint shapes. A censored record has no attempts, timing, output, trace, or usage because invocation never started. A completed attempt terminates its trial and can never be followed by a retry. The Bundle has orthogonal terminal status and coverage counters: `planned = started + budgetCensored + notStarted` and `started = succeeded + failed + cancelled`. A `budget-exhausted` Bundle classifies every coordinate that did not start as budget-censored rather than generic notStarted. Exhaustion may occur inside the final started trial—for example when a retry cannot be admitted or provider cost is known only after completion—so a valid budget-exhausted Bundle need not invent a censored coordinate.

`parseExecutionBundleDocument()` validates only wire shape, local state-machine invariants, and the digest without external state. Import and materialization must call `parseExecutionBundle()` with the sealed RunPlan to verify parent digests, the complete coordinate universe, trial/seed/sampling/scheduling identities, Target Runtime bindings, retry policy, invocation budget, and atomic paired-block censoring. Bundle-reported blocks and coverage are never trusted on their own.

If an Evaluator binds output or trace, prepare rejects any EvidencePolicy that removes that input. Execution may still produce a `summary-only` Bundle. Only `self-contained` requires every completed output and every active-record trace inline; `resolvable` permits those contents inline or as digest-verified descriptors.

Cost inferred from a pricing catalog is not a raw execution fact. It is a derived AnalysisResult carrying a pricing fingerprint.

### 6.3 EvaluationBundle

It records:

- evaluator RuntimeIdentity;
- MetricObservations;
- evidence or ContentDescriptor;
- evaluation errors;
- cache provenance;
- parent ExecutionBundle digest, EvaluationPlan digest, and its own digest.

### 6.4 AnalysisBundle

It records one canonical fact for every AnalysisGraph node: completed, inconclusive, failed, or not evaluated. Each fact binds the resolved RuntimeIdentity, output SchemaIdentity, declared input references, estimand-specific observation coverage, assumption checks, parent result digests, analysis mode, derivation time, and a record digest. The Bundle separately records terminal status, graph coverage, EvaluationBundle and AnalysisPlan digests, provenance, and its own digest. Missing, invalid, evaluation-failed, source-unavailable, not-started, and censored observations remain distinct counters; included and comparable sets cannot exceed observed evidence.

`parseAnalysisBundleDocument()` verifies standalone wire, canonical result order, coverage arithmetic, record digests, and the Bundle digest. `parseAnalysisBundle()` additionally binds the sealed RunPlan, ExecutionBundle, and EvaluationBundle and verifies the exact graph universe, Runtime and schema identities, declared inputs, parent lineage, analysis mode, and source trust ceiling.

### 6.5 EvaluationReport

A Report is a materialized view for people and products. It may inline stable summaries or reference Bundles by digest, optionally with a retrieval URI, but is never the only source for re-evaluation or audit. DecisionResult is separately content-addressed and binds the DecisionPlan, policy, resolved runtime, AnalysisBundle, and named AnalysisResults. Report materialization never executes an Analysis node or DecisionPolicy.

Reports use three orthogonal status axes:

```ts
interface EvaluationStatus {
  runStatus: 'completed' | 'cancelled' | 'budget-exhausted' | 'failed';
  evidenceStatus: 'complete' | 'partial' | 'unresolvable';
  conclusionStatus: 'conclusive' | 'inconclusive' | 'not-evaluated';
}
```

`runStatus: completed` means only that processing ended. A directional verdict such as PROGRESS or REGRESSION requires the DecisionPolicy's coverage gate, statistical assumptions, and evidence-completeness requirements to pass.

### 6.6 Replayability

Every Bundle declares:

- `self-contained`: everything needed for re-evaluation is inline;
- `resolvable`: content can be retrieved through an injected ContentResolver and verified by digest;
- `summary-only`: re-evaluation is not promised.

Imported Bundles also declare provenance trust. Schema and digest validation prove integrity, not that a claimed Target produced the content.

v1 does not implement Bundle signing inside Core. Signing requires identity policy, trust roots, certificate/key lifecycle, and verification material and therefore belongs to host governance. v1 records digest, provenance trust, and assurance level. A host may attach a Sigstore/DSSE-style attestation through a namespaced extension and raise trust through an injected verifier. Without a verifier, signature material is opaque evidence and never becomes verified automatically.

## 7. Identity, canonicalization, and comparability

Definition, Plan, Bundle, Event, and Report each carry a `schemaVersion` and publish JSON Schema 2020-12. TypeScript and runtime schemas come from one source or are guarded by automatic parity tests.

Content-addressed objects are restricted to the RFC 8785 JCS-compatible I-JSON subset. `NaN`, `Infinity`, functions, symbols, cycles, and insertion-order-dependent semantics are invalid. Digests use full `sha256:<hex>` values.

```text
executionPlanDigest = H(
  executionInputDigest,
  target snapshots,
  executor manifests,
  SamplingDesign,
  scheduling + execution policy
)

evaluationPlanDigest = H(
  executionPlanDigest,
  evaluationInputDigest,
  evaluator manifests,
  metric definitions,
  evaluation policy
)

analysisPlanDigest = H(
  evaluationPlanDigest,
  AnalysisGraph,
  estimator manifests
)

decisionPlanDigest = H(
  analysisPlanDigest,
  comparisons,
  DecisionPolicy
)

runContractDigest = H(all plan digests + schema identities)
```

Annotations such as `project`, `owner`, and `tags` do not enter measurement digests. Evidence capture that changes auditability but not scores has an evidence contract and Bundle provenance. If capture removes an Evaluator input, it belongs in EvaluationPlan.

## 8. Runtime, resources, and cancellation

Core does not read or write files, read environment configuration, write stdout/stderr, load CLI/Studio, create directories, call `process.exit`, or maintain process-global mutable registries by default.

Runtime ports include at least:

- ExecutorRegistry;
- EvaluatorRegistry;
- AnalysisRegistry;
- ContentResolver/ContentStore;
- Clock, IdGenerator, and RandomSource;
- a shared per-Run EventSequencer;
- optional EventWriter.

Executors and Evaluators may use `openRun()` to return a run-scoped resource handle and asynchronous disposer. Resource ownership is a strict tree: Engine owns registries, Run owns resources such as connection pools and clients, and trials/attempts own isolated business state and temporary resources. A run-scoped resource lifecycle never implies shared session state across trials. One Run's cancellation or teardown cannot close another Run's resources.

Cancellation uses AbortSignal. User cancellation produces honest partial Bundles. Timeout and budget belong to sealed MeasurementPolicy because they affect missingness. Core does not provide cross-process resume; a host may start a new Evaluation stage from a complete ExecutionBundle.

The Execution runtime is an in-memory interpreter of a sealed RunPlan. `startExecution()` synchronously verifies required ports and exact Executor Runtime identities before it exposes a Run, and captures those Executor references so later registry mutation cannot replace a sealed implementation. It derives coordinates only from the Plan, uses the sealed root seed for randomized admission, and applies global and per-Executor semaphores scoped to that Run. Paired scheduling blocks reserve their first real invocations atomically; cache hits consume no invocation, while each retry does. Failures before `trial.execute()` are run-level resource failures and never fabricate an attempt or consume invocation budget.

Timeout is cooperative: Core aborts the attempt signal, waits for the Executor promise to settle so no late promise is abandoned, and records timeout as the single terminal fact even if the Executor returns success after observing abort. External cancellation has the same single-terminal rule. `maxDurationMs` is a monotonic soft admission deadline: already admitted work settles, while later blocks are censored. Provider-cost limits use only provider-reported facts; an admitted batch may overshoot, after which no new block is admitted and already observed usage is never rewritten.

Execution cache and evidence storage are injected ports rather than filesystem services. `replay-only` misses and invalid cache entries fail closed; transparent hits require the deterministic, verified identity already sealed by prepare. Cache writes are deferred until resources tear down successfully and the run has no execution, cancellation, or budget terminal at commit time; only records whose cost audit, evidence materialization, and trial teardown succeeded are eligible. A later terminal-event delivery failure does not retroactively invalidate an already committed Target fact. Full, reference, digest-only, and omitted capture are materialized under the classification ceiling. Reference capture verifies the ContentStore descriptor digest before it enters a Bundle. Raw host exception text is not copied into events or Bundles.

Every attempt retains its exact UsageRecord. The record-level UsageRecord is only an aggregate: token counts and same-currency costs may be summed, while mixed or partial currencies remain solely in the attempt facts and are marked non-comparable in aggregate details. Runtime never deletes an observed cost merely because it cannot produce one scalar total.

## 9. Event semantics

`run.events` is a bounded hot notification stream:

- an unconsumed stream cannot block or change `run.result`;
- each Run permits one AsyncIterable consumer; hosts provide fan-out;
- journaling begins when the Run is created and retains 256 events by default; a late subscriber receives the retained window before live events, and may subscribe once after completion to drain the journal;
- a host may override capacity in start observer options; it does not enter measurement digests because event congestion cannot change Bundles or conclusions;
- when full, the journal drops the oldest retained notification; the terminal event is appended last and therefore remains in the final retained window;
- observations, Bundles, and terminal data never exist only as events;
- every Event has schemaVersion, eventId, runId, monotonic per-Run sequence, eventKind, time, subject, and data;
- lossless persistence uses EventWriter. v1 supports blocking backpressure; writer and notification delivery are serialized by per-Run sequence, while enablement and failure behavior come from sealed EventDeliveryPolicy. Infrastructure and internal failures dominate an earlier cancellation or budget stop, so required writer and resource-disposal failures always change the authoritative Bundle terminal state, including during terminal-event delivery.

Adapters may map Events losslessly to CloudEvents. Traces may map to OpenTelemetry/OpenInference and accept W3C Trace Context. Core depends on none of those SDKs.

## 10. Errors and failures

Schema, reference, capability, and statistical-assumption errors during prepare throw `EvaluationDefinitionError` and create no Run.

Runtime errors are classified as:

- configuration;
- infrastructure;
- execution;
- evaluation;
- analysis;
- internal invariant violation.

Execution and evaluation errors are observations governed by FailurePolicy's continue, fail-fast, or failure-threshold behavior. Quality failure, assertion failure, and treatment regression are valid measurements, not runtime errors.

Raw exception objects are never serialized into Events or Reports. They become a stable error code, stage, public message, controlled details, and cause chain.

## 11. Content, security, and privacy

```ts
interface ContentDescriptor {
  mediaType: string;
  digest: string;
  size?: number;
  uri?: string;
}
```

Core never dereferences a URI directly. ContentResolver enforces access control, size limits, protocol allowlists, and digest verification.

Content is classified at least as public, sensitive, secret, or gold. EventWriter, Report materializer, ContentStore, and error serializer each declare their maximum accepted classification. Evaluator evidence and errors pass through the same classification and redaction rules.

EvidencePolicy controls full/reference/digest/none capture independently for input, output, trace, expected, and evidence and reports how each choice affects replayability or evidenceStatus.

## 12. Public API sketch

```ts
const engine = createEvaluationEngine(runtime);

const plan = await engine.prepare(definition, measurementPolicy);

const run = plan.start({
  signal,
  annotations,
  eventWriter,
  observer: { maxBufferedEvents: 256 },
});

for await (const event of run.events) {
  // Optional lifecycle notifications.
}

const result = await run.result;
```

Advanced APIs support:

- `execute(plan.execution)`;
- `evaluate(plan.evaluation, executionBundle)`;
- `analyze(plan.analysis, evaluationBundle)`;
- `decide(plan.decision, analysisBundle)`.

The package root also provides a one-call façade. Advanced APIs return serializable Bundles and do not expose mutable schedulers. Public exports are allowlisted through `package.json#exports`; `./dist/*` deep imports are not a contract.

## 13. Conformance and verification

The first conformance fixtures cover:

1. Pure function: structured input/output, no trace.
2. RAG top-K: retrieval evidence and ranking Metrics.
3. Agent trajectory: multi-turn messages, tool calls, cancellation, and partial traces.

If the Core orchestrator needs a `targetKind` branch, the protocol abstraction fails acceptance.

Required property tests include:

- JSON property order does not change a digest.
- Annotation changes do not change measurement digests.
- Gold changes invalidate only Evaluation and downstream plans.
- Evaluator changes do not invalidate Execution.
- Runtime fingerprint changes invalidate the corresponding stage.
- Replay does not increase stochastic trial count.
- Repeated trials are not treated as independent experimental units.
- A slow Event consumer does not change results.
- Concurrent Runs share no cancellation, cache, or teardown.
- Budget exhaustion cannot complete only one side of a paired block.
- Secret/gold data never reaches unauthorized Events, Reports, or errors.
- Partial evidence cannot pass a coverage gate and produce a directional verdict.

An ExecutionBundle records the `runContractDigest` and `datasetRevisionDigest` of the RunPlan
that produced it as origin lineage. Re-scoring admits that Bundle against another RunPlan by its
`executionPlanDigest` and `executionInputDigest`; it must not require origin-only digests to match.
This stage-scoped admission rule is what makes Gold or Evaluator changes reusable without invoking
the Target again. Provenance still binds the recorded origin contract, so relaxing admission does
not permit an origin claim to be rewritten silently.

Statistical implementations also use known reference vectors and simulations to test coverage, type-I error, pairing, and cluster resampling rather than relying only on snapshots.

## 14. Rejected alternatives

### 14.1 Add more options to the current `runEvaluation`

Rejected. It preserves CLI, file, global-state, and Report coupling and cannot establish clean Gold and effect boundaries.

### 14.2 Keep one Report and re-score from it

Rejected. Presentation capture would constrain measurement facts, and the Report schema would carry too many responsibilities.

### 14.3 Use the Event Log as the sole source of truth

Rejected. Core does not own a durable event store or recovery protocol. An unconsumed or congested notification stream cannot affect measurement facts.

### 14.4 Normalize all Metrics to 0–1 and average by default

Rejected. Equal ranges do not make constructs comparable and hide scale, direction, and missingness semantics.

### 14.5 Represent every Target with one ever-growing capability list

Rejected. It creates Boolean soup. Use protocol family plus schema plus capability negotiation.

### 14.6 Transparently reuse all Execution caches

Rejected. It can disguise one output as new stochastic trials and corrupt variance and stability measurements.

### 14.7 Build databases, queues, and checkpoints into Core

Rejected. Durability and distributed orchestration belong to hosts. Content-addressed Bundles are the composition boundary.

## 15. Delivery sequence

1. Review this RFC and its blocking ADRs.
2. Create five child issues: Contracts, Compiler, Execution, Evaluation/Analysis, and Conformance.
3. Contracts: schemas, types, canonicalization, digests, and status model.
4. Compiler: projections, capability resolution, and Plan sealing.
5. Execution: trials, paired scheduling, resources, and ExecutionBundle.
6. Evaluation/Analysis: re-scoring, AnalysisGraph, statistics, and DecisionPolicy.
7. Conformance: three Target classes, fault injection, security, and simulation.
8. Deliver the package-root façade in #424.
9. Migrate CLI and Studio last.

Each phase depends only on the previous phase's public Plan/Bundle contracts, never its internal implementation.

## 16. RFC decision record

This review closes five blocking questions:

1. **Schema source of truth**: use the fully exportable Zod 4 wire-schema subset; CI generates JSON Schema 2020-12 and semantic validation remains in the prepare compiler.
2. **Protocol families**: v1 includes only `omk.invoke/v1` and `omk.session/v1`; external results enter through ExecutionBundle rather than an import protocol.
3. **Event journal**: one consumer, 256 events by default, retained-window replay for late subscribers, progress-first coalescing, and explicit overflow reporting; lossless delivery uses EventWriter.
4. **Bundle signing**: v1 records digest and trust but does not sign; hosts compose attestations and verifiers through extensions.
5. **Estimator registry**: v1 includes descriptive reducers, percentile bootstrap for mean/paired-difference/cluster designs, and Bonferroni, with no built-in parametric methods.

These decisions close the architectural choices required before Contracts. Conformance tests and simulations must still validate implementation constants and algorithms.

## 17. Contracts v1 implementation baseline

The first implementation phase is tracked by [#427](https://github.com/lizhiyao/oh-my-knowledge/issues/427). Its source of truth is isolated under `src/evaluation-core/contracts/`; it does not import the historical `src/eval-core/`, CLI, executor, grading, renderer, or server layers.

The catalog currently publishes twelve JSON Schema 2020-12 roots under `schemas/evaluation-core/v1/`: EvaluationDefinition, MeasurementPolicy, four stage Plans plus RunPlan, Event, three Bundles, and EvaluationReport. TypeScript types are inferred from the same Zod 4 schemas. `yarn build:schemas` regenerates the files, while `yarn build` checks committed output for drift and copies it into the package build.

Wire entry points use `parseWireDocument()` rather than a bare schema parse. It first rejects values that cannot be represented as I-JSON or JCS input, including non-finite numbers, functions, symbols, cycles, sparse arrays, accessor properties, class instances, and unpaired Unicode surrogates, and then applies the Zod schema. Hosts accepting raw JSON text must additionally reject duplicate property names before constructing a JavaScript value because duplicates are no longer observable after ordinary `JSON.parse()`.

Digest boundaries are executable contracts:

| Identity | Includes | Excludes |
|---|---|---|
| `datasetRevisionDigest` | complete Dataset | nothing |
| `executionInputDigest` | `sampleId`, `input`, `executionContext` | Gold, evaluator context, annotations |
| `evaluationInputDigest` | execution projection, `expected`, `evaluationContext` | annotations |
| stage Plan digests | previous-stage identity plus stage definitions, resolved Runtime identities, and relevant sealed policy | later-stage policy and audit annotations |
| `runContractDigest` | all stage Plan digests, schema identities, and EventDeliveryPolicy | Report annotations and observer-only options |

Every digest is the full lowercase `sha256:<hex>` of RFC 8785 canonical UTF-8 bytes. It proves content identity only. Provenance trust, fingerprint basis, and assurance level remain separate fields, and v1 does not implement signing.

[#431](https://github.com/lizhiyao/oh-my-knowledge/issues/431) hardens v1 before Execution begins: SamplingDesign seals seed coupling explicitly; protocol manifests separate resource lifecycle from trial state; Execution identities use domain separation; and ExecutionBundle models active/censored records, terminal status, coverage, and replayability independently. With no historical users to migrate, these changes converge v1 directly and retain no compatibility layer for the old fields.

## 18. Evaluation Runtime v1 implementation baseline

[#435](https://github.com/lizhiyao/oh-my-knowledge/issues/435) implements record-scoped re-evaluation as a separate stage. Its ports expose Evaluators, content resolution/storage, cache, clock, a shared EventSequencer, and EventWriter only; no Executor can be reached through the Evaluation API. `startEvaluation(plan, executionBundle, ports, options)` validates the sealed source bundle synchronously before starting asynchronous work.

Evaluation coordinates use canonical `(targetId, sampleId, trialIndex, evaluatorId)` order. `evaluationId`, attempt IDs, and observation IDs use domain-separated digest derivation. Every active EvaluationRecord binds the exact canonical ExecutionRecord digest and resolved Evaluator RuntimeIdentity. The cache key additionally binds the EvaluationPlan, materialized inputs, source record, and effective source trust, so changing Gold, evaluator identity, bindings, execution evidence, or the source trust ceiling cannot silently reuse a score. Cache replay validates the full record schema, retry identities, ordered metric contract, scale, source digest, runtime identity, deterministic attempt-to-record usage aggregation, and provider-cost eligibility before accepting a hit; replay provenance never raises source trust.

Evaluation retry, timeout, concurrency, invocation/duration/provider-cost budgets are sealed under `MeasurementPolicy.evaluation`; start-time options cannot override them. An invocation reservation is consumed only immediately before `evaluate()`, so `openRun()` and `openRecord()` failures consume no quota. Failed and retried invocations retain and charge their provider-reported usage exactly like successful invocations. Timeout is cooperative: Core aborts, waits for the evaluator promise to settle, discards any late result, and only then retries or disposes the record resource. Cache entries are committed only after evaluator record/run resources close cleanly. Event delivery reuses the stage-neutral sealed EventDeliveryPolicy and an injected per-Run EventSequencer shared by Execution and Evaluation.

Missingness is source-aware and binding-based. Before evaluator admission, Core freezes binding closure for the entire coordinate universe. A missing or budget-censored ExecutionRecord, or any unresolvable required binding, produces `not-evaluated`, never a zero or default score. Failed and cancelled ExecutionRecords remain eligible when all declared inputs are still materializable, such as trace-only evaluation. For reference content, the descriptor seals media type alongside value digest and classification: a Resolver may supply the value but cannot rewrite that identity, and a ContentStore descriptor must preserve the requested media type. Evaluator omissions become explicit missing observations. Unknown/duplicate metrics are evaluator failures; value-type mismatches and numeric scale violations become invalid observations without coercion or clamping. Evaluators receive only their declared sealed MetricDefinitions. Observation metadata is classified content and follows the same capture and classification ceiling as evidence. Evaluator-produced metrics are sample-scoped; aggregation remains an AnalysisGraph responsibility.

`parseEvaluationBundleDocument()` validates standalone wire shape, state transitions, identities, coverage, replayability, and digest. `parseEvaluationBundle()` additionally binds the sealed RunPlan and validated ExecutionBundle and checks every structurally decidable invariant; a durable Bundle remains valid when external runtime evidence is unavailable. `verifyEvaluationBundle()` returns a separate `planVerification`: known native invocations establish a lower bound, unverified cache claims establish an upper bound, and cache-receipt or invocation-budget status becomes `indeterminate` rather than invalid when Bundle JSON alone cannot prove the lookup. Supplying independently obtained `verifiedCacheRecordDigests` closes that proof; Evaluation Runtime requires both statuses to be `verified` before returning its own Bundle. Reconstructing a claimed native miss from the hit itself never grants a receipt. Coverage follows `planned = eligible + sourceUnavailable`, `eligible = started + notStarted`, and `started = completed + failed + cancelled`.

## 19. Analysis and Decision Runtime v1 implementation baseline

[#437](https://github.com/lizhiyao/oh-my-knowledge/issues/437) implements Analysis and Decision as separate, reproducible stages. AnalysisPlan seals the metric contracts, full ExperimentDesign including trial count and root seed, Comparisons, AnalysisGraph, MissingPolicy identities, Analysis Runtime identities, and output schemas. DecisionPlan separately seals DecisionPolicy and its resolved RuntimeIdentity. A Comparison change invalidates Analysis and downstream identity; a policy-only change invalidates Decision and the root contract.

Analysis materializes an immutable typed relation over the complete planned metric-coordinate universe. Rows retain Target, sample, trial, evaluator, Metric, sampling-unit identities, censoring, and source status. Observed, missing, invalid, evaluation-failed, source-unavailable, and not-started values remain distinct; only observed rows may be included in v1. Nodes execute in stable topological order and receive only declared Metric, upstream result, or exact Comparison-contrast inputs. Core, rather than an implementation, assigns result identity, RuntimeIdentity, schema, coverage, lineage, mode, and digest. Runtime output is checked as the complete `{ resultType, value }` envelope against both the wire result contract and a Core-owned validator selected from an independently injected registry by the full sealed SchemaIdentity; an Analysis implementation cannot validate its own output. Semantic invariants that JSON Schema cannot express, including Bonferroni arithmetic and canonical family membership, are part of the validator and schema digest.

The built-in registry provides the three descriptive reducers, three deterministic percentile-bootstrap estimators, Bonferroni correction, explicit exclusion MissingPolicy, and a minimal progress DecisionPolicy. Each built-in reducer and estimator seals exactly one Metric input. Bootstrap draws are domain-separated from the sealed root seed, AnalysisPlan digest, node identity, and replicate index. Repeated trials are first reduced within their declared sampling unit; paired contrasts are formed within complete pairing blocks before resampling; cluster bootstrap resamples whole clusters. Insufficient units or failed assumptions yield an inconclusive result and never select a fallback estimator. Built-in Runtime identities are self-reported and carry `assuranceLevel: declared`; only an independent host verifier or attestation boundary may promote executing code to verified assurance.

Decision consumes only the policy's named AnalysisResults plus coverage, assumption checks, evidence status, and its explicitly sealed comparison family. A correction result must match that exact family, rather than the global Comparison count. Failed gates produce stable `not-decided` reasons. Policy or infrastructure failure is distinct from a statistical conclusion. EvaluationReport then materializes Bundle references, the content-addressed DecisionResult, provenance, and the derived run/evidence/conclusion axes without recomputing statistics or verdicts. Host annotations are presentation metadata: they may change the report artifact digest but never a stage Plan or source Bundle digest.

AnalysisBundle and EvaluationReport expose standalone document validators and plan-and-source-aware validators. The latter require the exact source Bundle chain, complete graph/runtime/schema bindings, independent output validation, parent digests, policy digest, and a provenance trust level no higher than the least-trusted source or executed Runtime assurance. Analysis trust includes every executed AnalysisNode and consulted MissingPolicy; report trust additionally includes DecisionPolicy assurance when a decision is present. AnalysisBundle provenance has exactly one parent—the validated EvaluationBundle—and cannot admit unrelated digests. Optional Bundle-reference URIs locate content but do not participate in source identity beyond the sealed digest.

Analysis, Decision, and eventful Report materialization reuse the same injected per-Run EventSequencer and sealed EventDeliveryPolicy. Events contain identities, status, coverage summaries, and reason codes only. Bounded streams never backpressure authoritative work; required durable delivery is delegated to EventWriter. Every asynchronous terminal path closes its event stream and Analysis removes its external AbortSignal listener, including unexpected clock, sequencer, validation, or materialization failures. Analysis cancellation is cooperative at node boundaries, preserves completed facts, and materializes every remaining node as not evaluated. The same AbortSignal is passed into in-flight Analysis and Decision ports; once aborted, a port rejection or late success cannot overwrite the cancelled terminal fact. Node resources are disposed exactly once, and Core performs no file, network, environment, process-signal, or global-registry access.

## 20. Conformance v1 implementation baseline

[#439](https://github.com/lizhiyao/oh-my-knowledge/issues/439) adds a deterministic,
host-independent harness under `test/evaluation-core/conformance/`. Pure function, RAG top-K,
and Agent trajectory fixtures share one stage driver from preparation through report
materialization. Only protocol manifests, Runtime capabilities, structured adapter values, and
Evaluator declarations vary; Core contains no `targetKind` dispatch. Every serialized Bundle and
Report is revalidated against its sealed plan and parent facts.

The suite exercises Gold isolation and evaluator-only re-scoring, native Recall@K, Precision@K,
MRR, and NDCG observations, source-neutral trajectory evidence, output-only evaluator projection,
session lifecycle, reversed Comparison roles, paired-block budget censoring, repeated-trial unit
counts, evidence gates, classification redaction, reference content resolution, cache replay,
absent live Event consumers, and required EventWriter behavior. Its fault matrix covers Runtime
resolve/open/execute/dispose, cache read/write/miss/stale/forged provenance, content store and
resolver digest/classification failures, continue/fail-fast/failure-threshold, and cancellation
before admission, in flight, at a stage boundary, and during disposal. Concurrent fixtures use one
explicitly injected Runtime registry, event sequencer, artifact store, and pair of caches while
retaining distinct Run ids, state, cancellation, sessions, and teardown; deferred gates force their
lifecycles to overlap. All fixtures use deterministic clocks, seeds, deferred gates, and in-memory
stores; they do not read files, networks, user configuration, or wall-clock delays. Known
statistical vectors and deterministic simulations guard bootstrap unit semantics, broad interval
coverage, and a broad null paired-effect type-I error bound.

The #425 acceptance audit is now complete for Contracts, Compiler, Execution, Evaluation,
Analysis/Decision, and cross-stage conformance. The package-root façade, public export allowlist,
and independent Node.js host acceptance remain intentionally assigned to #424. CLI and Studio
migration remain later consumers and are not Evaluation Core acceptance dependencies.

Conformance exposed one cross-stage defect: ExecutionBundle admission previously compared the
originating root contract and complete Dataset revision with the current RunPlan. Those lineage
facts still remain sealed and provenance-bound, but admission is now stage-scoped to
`executionPlanDigest` and `executionInputDigest`, enabling Gold or Evaluator changes to re-score an
existing ExecutionBundle without weakening origin integrity.
Execution cache admission also verifies the exact native provenance and original cache-miss receipt
that Core emitted for the sealed ExecutionPlan. A stale digest or a self-consistent record rewritten
as replay provenance fails closed before an Executor is opened.

## 21. Industry references

- [Inspect AI Tasks](https://inspect.aisi.org.uk/tasks.html), [Scorers](https://inspect.aisi.org.uk/scorers.html), and [Eval Logs](https://inspect.aisi.org.uk/eval-logs.html)
- [Phoenix Experiments](https://arize.com/docs/ax/improve/experiment-in-code)
- [Pydantic Evals](https://pydantic.dev/docs/ai/evals/evals/) and [Report Evaluators](https://pydantic.dev/docs/ai/evals/evaluators/report-evaluators/)
- [lm-evaluation-harness Task Guide](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/task_guide.md)
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) and [OpenInference Semantic Conventions](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md)
- [CloudEvents](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md) and [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12), [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html), and [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)
- [Zod 4 JSON Schema](https://zod.dev/json-schema), [Node.js Events](https://nodejs.org/api/events.html), and the [Sigstore Bundle specification](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto)

## Related documents

- [Scoring pipeline](scoring.md)
- [Statistical rigor](../explanation/statistical-rigor.md)
- [Terminology spec](terminology-spec.md)
- [RAG metrics spec](rag-metrics-spec.md)
