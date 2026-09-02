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

Different Bundle digests do not automatically mean incomparable, and equal digests do not prove a valid experimental design. ComparabilityPolicy inspects Dataset projections, Targets, Runtimes, Evaluators, SamplingDesign, and DecisionPolicy and returns compatible, conditional, or incompatible with reasons. Section 7 freezes the v1 decision contract.

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
  analysis?: {
    memberships: readonly { cohortId: string; membershipValue?: JsonValue }[];
    context?: { value: JsonValue; classification: ContentClassification };
  };
  annotations?: JsonValue;
}
```

- An Executor receives only a frozen projection of `input + executionContext`.
- An Evaluator may declaratively read output/trace/expected/evaluationContext or the Core-owned
  `execution-facts` projection.
- An Analysis Runtime receives stable analysis membership through AnalysisPlan only.
- `annotations` are audit and presentation data and affect neither execution nor scoring.
- Mappings use restricted JSON Pointer by default and select one value. Multi-value JSONPath is an adapter extension.

A Dataset has four distinct digests:

| Digest | Coverage | Purpose |
|---|---|---|
| `datasetRevisionDigest` | complete Dataset | lineage and audit |
| `executionInputDigest` | `input + executionContext` | ExecutionPlan identity |
| `evaluationInputDigest` | execution projection plus `expected + evaluationContext` | EvaluationPlan identity |
| `analysisInputDigest` | stable sample identity, analysis membership/context, and cohort definitions | AnalysisPlan identity |

Changing Gold or evaluator-only metadata cannot change the ExecutionPlan, schedule, or anything observable by an Executor.

### 5.3 Target and Runtime capabilities

```ts
interface TargetDefinition {
  targetId: string;
  targetKind: string;
  protocolId: string;
  executorId: string;
  versionConstraint?: string;
  executionRequirements: {
    systemInstructions: 'required' | 'not-required';
    workspace: 'copy-on-write-overlay' | 'not-required';
    mcp: 'native-config' | 'not-required';
    mockInterception: 'pre-tool-call' | 'not-required';
    toolPolicy: 'runtime-default' | 'allow-list';
    skillDiscovery: 'runtime-default' | 'disabled' | 'allow-list';
    sandboxId?: string;
  };
  executionControls: {
    defaults: EffectiveExecutionControl;
    sampleOverrides: readonly Array<{
      sampleId: string;
      workspace?: WorkspaceExecutionControl;
      tools?: ToolExecutionControl;
    }>;
  };
  config?: JsonValue;
}
```

`targetKind` is descriptive and never drives a Core-orchestrator switch. Behavior comes from a versioned protocol family, input/output schemas, and a capability manifest. Capabilities negotiate optional behavior; they do not replace the type system.

v1 defines only two built-in protocol families:

- `omk.invoke/v1`: one structured request/response per trial with an optional source-neutral trace; covers pure functions, models, services, RAG, and stateless workflows.
- `omk.session/v1`: an isolated session lifecycle per trial with multi-turn messages, tool calls, and partial trajectories; covers agents and stateful workflows.

Every protocol manifest also declares structured execution capabilities: concurrency safety and limits, cancellation semantics, run resource lifecycle, trial state, seed control, determinism, trace/usage telemetry, and a closed `features` object. `features` records the actual system-instruction delivery mode (`native`, `prepended`, or `unsupported`) plus canonical, duplicate-free sets for workspace lease modes, MCP modes, mock-interception modes, tool-policy modes, skill-discovery modes, and sandbox IDs. Empty sets and `unsupported` are explicit; absence is invalid.

The complete manifest is the independently published `omk.executor-capabilities/v1` wire contract. Its JSON Schema identity is sealed into every Run contract, while each Runtime's concrete capability value remains sealed in `RuntimeIdentity`. Validator semantics and implementation claims therefore cannot change behind unchanged plan identity.

Core matches `executionRequirements` only against the selected protocol during prepare. A mismatch fails with `EVAL_DEFINITION_CAPABILITY_UNSUPPORTED` before any Runtime `openRun()`. System-instruction `native` and `prepended` both satisfy `required`, but the actual mode remains sealed in `RuntimeIdentity`, so they are different execution designs. Model, effort, provider deployment, effective tool schemas, resource bytes, and locators are not capabilities: behavior facts remain in Target config or Runtime implementation identity, while verified resource acquisition remains host-owned. Run-scoped resources may reuse infrastructure such as connection pools and clients; business state remains isolated per trial for `omk.session/v1`, while `omk.invoke/v1` remains stateless. A runtime declaring `cancellation: unsupported` cannot be combined with a timeout policy. A stochastic Runtime without seed control can use only an `uncontrolled` seed design. Transparent Execution cache hits require both deterministic capability and verified Runtime assurance.

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
  implementationManifest:
    | { coverageKind: 'fingerprint-complete' }
    | { coverageKind: 'fingerprint-plus-facets'; facets: Array<{
        facetId: string;
        value: JsonValue;
      }> };
  provenanceFacets?: {
    observation?: { observerId?: string; observedAt?: string };
    attestation?: { attestationDigest: Sha256Digest; attestorId?: string };
  };
}
```

Caller-supplied versions and fingerprints are requirements, not facts. The Report records the identity resolved by Runtime. `implementationManifest.facets` contains behavior-affecting facts not already committed by `fingerprint`, such as remote model deployment, effective tool schemas, sandbox policy, dependencies, and environment. The discriminated manifest makes ambiguous sibling states unrepresentable: `fingerprint-complete` has no facet payload, while `fingerprint-plus-facets` requires a non-empty facet array whose IDs are unique and canonical. `provenanceFacets` is a closed evidence-only shape for observation and attestation metadata, so arbitrary behavior facts cannot be placed there. Prepare rejects missing, ambiguous, non-canonical, or incomplete coverage. The manifest makes classification structurally decidable; assurance and independent host verification still determine whether the Runtime's claims are trustworthy.

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
  randomizationSlots: readonly {
    targetId: string;
    randomizationSlotId: string;
  }[];
}
```

A trial is one repeated measurement under the same condition. A retry attempt is infrastructure recovery within one trial. They are not interchangeable. Statistical implementations validate that they support the SamplingDesign during prepare and never treat repeated trials as independent samples by default.

Paired comparisons use a scheduling block as the dispatch atom. The compiler materializes comparison connectivity as canonical `ExecutionPlan.schedulingTargetGroups`: overlapping comparisons form one connected Target group, while unreferenced Targets remain singleton groups. These groups are covered by `executionPlanDigest`, so changing paired connectivity creates a new Execution identity. Comparison labels, treatment roles, and metric projections do not change Execution or Evaluation identity, but they do change Analysis identity and every downstream digest. `randomizationSlots` assigns every Target exactly one unique, stable experimental slot; the slot identifies a condition for randomization only and never encodes control/treatment role. A host comparing successive subject implementations preserves the slot even when its Target ID changes.

`randomizationSlots` is canonical by `(randomizationSlotId, targetId)` and is one-to-one on both fields. `seedCoupling` explicitly chooses whether Targets for the same sample in a block share a random condition, derive independent per-slot conditions, or honestly declare Target randomness uncontrolled; an Executor cannot infer this choice. Core seals `randomizationDesignDigest` with domain `omk.randomization-design/v1` from the execution-input projection, trials, root seed, the execution-affecting SamplingDesign projection, SchedulingPolicy, sampling memberships, and scheduling connectivity expressed only with `randomizationSlotId` values. The analysis-only `estimatorId`, raw Target IDs, Target definitions, Runtime identities, and plan-bound artifact IDs are excluded. Planned admission ranks and controlled trial seeds derive from this digest, trial index, sample identity, and—only for independent coupling—the stable slot. They never derive from `executionPlanDigest`, `schedulingBlockId`, `trialId`, a Runtime fingerprint, or Target implementation content. The sample coordinate always enters seed derivation so that distinct samples in a larger block never reuse a seed accidentally. A block is not started unless budget exists for all arms. Coordinates that never start are budget-censored, create no attempt, and are excluded from the primary paired estimator.

ExecutionPlan carries that same execution-affecting ExperimentDesign projection and therefore has no `estimatorId`; the full ExperimentDesign, including estimator identity, begins at AnalysisPlan. An estimator-only change preserves ExecutionPlan and EvaluationPlan identities and invalidates AnalysisPlan plus every downstream identity.

`pairingBlockId`, `clusterId`, and `stratumId` express distinct statistical membership, while `schedulingBlockId` identifies only the dispatch atom. They never share one ambiguous ID. Artifact identities continue to hash the canonical full set of `(targetId, sampleId)` coordinates plus sampling-unit IDs that affect dispatch; splitting membership into independent Target and sample sets would lose incidence. Those plan-bound IDs provide uniqueness, lineage, and cache isolation, but are not random inputs. Randomization instead uses the separately sealed subject-neutral projection above so an intentional subject change cannot perturb the condition assigned to an otherwise corresponding coordinate.

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

Every DecisionPolicy comparison-family member declares `(comparisonId, treatmentTargetId, metricId, analysisResultId)`. Two explicit family shapes are valid. In the generic correction shape, each member owns a distinct AnalysisResult whose producer consumes exactly that member's Metric and Comparison selector; a corrected family additionally assigns canonical `hypothesisId` values, the correction node consumes exactly those member results, and the DecisionPolicy consumes the unique correction result. In the estimator-owned shape, `comparisonFamilyResultId` names one authoritative result shared by every member and consumed by the DecisionPolicy; the family-producing estimator seals and validates the complete family itself. A family with more than one member always declares `multipleComparisonPolicyId`, the authoritative result must be produced by an estimator with that implementation identity, and the resolved DecisionPolicy capability must admit the same standard. Core does not require an additional correction node for the estimator-owned shape and never manufactures p-values. Empty and singleton families cannot claim multiple-comparison correction. Decision receives only projected contrasts carrying their result and optional hypothesis identities, never the enclosing Comparison's unrelated treatments or Metrics. Generic correction tables must contain the same canonical hypothesis IDs, family size, and raw p-values; estimator-owned tables are instead validated against their versioned output schema and DecisionPolicy lineage checks before a verdict can be produced. The built-in `progress/v1` policy selects the one result bound by a singleton contrast, or the only declared result when no family exists; it returns not-decided for ambiguous inputs and does not claim multiple-comparison support. Multi-contrast release semantics require a dedicated DecisionPolicy.

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

`prepareEvaluationPlan()` is the sole issuer of the in-process `SealedRunPlan` capability accepted by Comparability. The authority that registers and verifies this capability lives under an Evaluation Core internal module namespace that is denied by the package export map; the Compiler and Core consumers use relative internal imports rather than exposing that authority as a package-resolved consumer entry point. The RunPlan fields remain JSON-serializable for audit, but a clone or transported document is not a comparison authority: it must be prepared again through Runtime resolution before `assessComparability()` can consume it. This prevents a caller from retaining old digests and authenticated stage sources while substituting different Target, instrument, sampling, Analysis, or Decision projections.

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

`parseExecutionBundleDocument()` validates only wire shape, local state-machine invariants, and the digest without external state. Import and materialization must call `parseExecutionBundle()` with the sealed RunPlan to verify parent digests, the complete coordinate universe, trial/seed/sampling/scheduling identities, Target Runtime bindings, retry policy, structurally decidable cache envelopes, provider-cost facts, and atomic paired-block censoring. Bundle-reported blocks, cache status, and coverage are never trusted on their own. `parseExecutionBundle()` and `verifyExecutionBundle()` return an `ExecutionBundleSource` containing the serializable Bundle and a separate `planVerification` envelope. Native record provenance cannot exceed the assurance of the sealed Executor Runtime that produced it, and Bundle provenance cannot exceed its least-trusted record. Native records establish invocation and provider-cost lower bounds, unverified replay claims establish upper bounds, and provenance, cache-receipt, invocation-budget, or provider-cost-budget status becomes `indeterminate` when Bundle JSON alone cannot prove it. Supplying independently obtained cache receipts or host attestation closes the corresponding proof; reconstructing digests from the Bundle itself validates structure but never authenticates provenance or a receipt. Execution Runtime exposes the same authenticated source through `ExecutionRun.source`, while `ExecutionRun.result` remains the serializable artifact convenience. Every later stage consumes the source rather than reparsing and discarding its verification envelope. A completed Bundle under a provider-cost budget requires every native attempt to report the sealed currency, and its aggregate native spend must remain below the limit.

Evaluators that reason about execution outcomes bind the complete Core-owned
`omk.execution-facts/v1` projection with `sourceKind: 'execution-facts'` and the root pointer `''`.
Core rejects sub-pointers so every implementation receives one versioned semantic unit rather than
creating an accidental field-level API. The projection contains the source record digest, terminal
status, attempt and retry counts, per-attempt status and reporting state, active and wall-clock timing,
token and provider-cost reporting state, cache status, content-capture summaries, and minimal effective source
provenance. It never exposes output, trace, error messages, usage details, provenance facets, or parent
digests. Reported, partial, mixed-currency, unreported, absent, and budget-censored states remain
distinct; Core never fills missing telemetry with zero or derives catalog cost. The binding inherits the
most restrictive classification of captured output and trace, and its value, media type, classification,
source digest, Evaluator identity, and EvaluationPlan identity all participate in the Evaluation cache
key. Offline EvaluationBundle verification reconstructs the same projection from the bound
ExecutionRecord and the authenticated source trust envelope; effective trust can never exceed the
record trust ceiling. Budget-censored records remain canonically not evaluated because no invocation
occurred, although the pure projection is defined for conformance and future analysis adapters.
Trial index, retry count, and trace turn count are never aliases. Turn count remains a separate,
versioned, source-neutral trace binding: Core does not infer it from retries or parse provider-specific
trace shapes into an apparently authoritative execution fact.

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
  randomizationDesignDigest,
  target snapshots,
  executor manifests,
  execution-affecting ExperimentDesign projection without estimatorId,
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
  analysisInputDigest,
  analysis samples + cohort definitions,
  AnalysisGraph,
  estimator manifests
)

decisionPlanDigest = H(
  analysisPlanDigest,
  comparisons,
  DecisionPolicy
)

runContractDigest = H(all plan digests + schema identities + event delivery + optional Series membership)
```

Annotations such as `project`, `owner`, and `tags` do not enter measurement digests. Output/trace capture mode and their classification ceiling enter ExecutionPlan identity because they change the durable Execution facts and cache key. The complete v1 EvidencePolicy also enters EvaluationPlan because evaluator-produced evidence is an Evaluation fact. Dataset input and expected values are sealed stage inputs rather than EvidencePolicy capture targets: `executionInputDigest` binds executor-visible input, while `evaluationInputDigest` additionally binds expected and evaluation context. Evaluator-evidence capture does not invalidate Execution.

### 7.1 ADR: compare a declared subject under an invariant measurement system

**Status:** accepted and implemented for v1; tracked by [#441](https://github.com/lizhiyao/oh-my-knowledge/issues/441).

Comparability is a relation between two candidates for one declared use, not an intrinsic property of either Run. v1 supports one deliberately conservative design mode: `exact-measurement-design`. The caller declares one or more one-to-one Target mappings as the subjects under study. Only the mapped Target definitions and their Executor Runtime implementation identities may differ. Everything that defines how those subjects are observed, scored, sampled, analyzed, and—when requested—decided remains invariant.

This decision separates three propositions that must never collapse into one Boolean:

1. **Content identity:** equal canonical digests mean equal sealed content at that stage. They do not authenticate the producer or validate an experimental design.
2. **Evidence qualification:** Runtime assurance, provenance trust, host attestation, and source-verification axes state how strongly the claimed content and execution are authenticated. They do not make different measurement instruments equivalent.
3. **Experimental comparability:** the declared subject is varied while the measurement projection required by the requested scope remains invariant.

Replayability and reproducibility remain separate artifact properties. A comparison may be valid without guaranteeing byte-identical reproduction, and a self-contained replay does not repair a changed Evaluator or sampling unit.

### 7.2 Policy and assessment contract

The v1 wire contract is conceptually:

```ts
interface ComparabilityPolicy {
  schemaVersion: 'omk.comparability-policy/v1';
  designMode: 'exact-measurement-design';
  comparisonScope: 'evaluation' | 'analysis' | 'decision';
  subjects: readonly {
    subjectId: string;
    leftTargetId: string;
    rightTargetId: string;
  }[];
  policyDigest: Sha256Digest;
}

type ComparabilitySourceVerificationFact =
  | {
      verificationFactKind: 'verification-axis';
      stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
      sourceDigest: Sha256Digest;
      verificationAxis:
        | 'provenance-attestation'
        | 'cache-receipt'
        | 'invocation-budget'
        | 'provider-cost-budget'
        | 'policy-execution';
      verificationStatus: 'verified' | 'indeterminate';
    }
  | {
      verificationFactKind: 'source-trust';
      stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
      sourceDigest: Sha256Digest;
      trustRelation: 'parent' | 'effective';
      trust: Provenance['trust'];
    };

interface RuntimeQualificationFact {
  stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
  runtimeKind:
    | 'executor'
    | 'evaluator'
    | 'analysis-node'
    | 'missing-policy'
    | 'decision-policy';
  referenceId: string;
  runtimeIdentityDigest: Sha256Digest;
  runtimeImplementationDigest: Sha256Digest;
  fingerprintBasis: RuntimeIdentity['fingerprintBasis'];
  sealedAssuranceLevel: RuntimeIdentity['assuranceLevel'];
  effectiveAssuranceLevel: RuntimeIdentity['assuranceLevel'];
  verifiedByAttestationDigest?: Sha256Digest;
}

interface ComparabilityCandidateIdentity {
  runContractDigest: Sha256Digest;
  planDigests: PlanDigests;
  randomizationDesignDigest: Sha256Digest;
  artifacts: readonly {
    stage: 'execution' | 'evaluation' | 'analysis' | 'decision';
    artifactDigest: Sha256Digest;
  }[];
  sourceVerification: readonly ComparabilitySourceVerificationFact[];
  runtimeQualification: readonly RuntimeQualificationFact[];
  candidateDigest: Sha256Digest;
}

interface ComparabilityAssessment {
  schemaVersion: 'omk.comparability-assessment/v1';
  policyDigest: Sha256Digest;
  designMode: 'exact-measurement-design';
  comparisonScope: 'evaluation' | 'analysis' | 'decision';
  left: ComparabilityCandidateIdentity;
  right: ComparabilityCandidateIdentity;
  designStatus: 'compatible' | 'incompatible';
  evidenceQualificationStatus: 'verified' | 'conditional' | 'rejected';
  comparabilityStatus: 'compatible' | 'conditional' | 'incompatible';
  reasons: readonly ComparabilityReason[];
  assessmentDigest: Sha256Digest;
}

type ComparabilityReasonCode =
  | 'comparability-identity-declared-subject-change'
  | 'comparability-design-subject-mapping-invalid'
  | 'comparability-design-undeclared-subject-change'
  | 'comparability-design-evaluation-input-mismatch'
  | 'comparability-design-evaluation-instrument-mismatch'
  | 'comparability-design-sampling-mismatch'
  | 'comparability-design-randomization-mismatch'
  | 'comparability-design-analysis-mismatch'
  | 'comparability-design-comparison-mismatch'
  | 'comparability-design-decision-mismatch'
  | 'comparability-design-schema-mismatch'
  | 'comparability-design-projection-mismatch'
  | 'comparability-evidence-source-absent'
  | 'comparability-evidence-verification-indeterminate'
  | 'comparability-evidence-assurance-unverified'
  | 'comparability-evidence-source-untrusted'
  | 'comparability-evidence-runtime-identity-opaque';

interface ComparabilityReason {
  reasonCode: ComparabilityReasonCode;
  axis: 'design' | 'evidence' | 'identity';
  severity: 'info' | 'conditional' | 'incompatible';
  scope: 'evaluation' | 'analysis' | 'decision';
}

interface ComparabilityVerificationContext {
  /** Produced by an independent host verifier; never reconstructed from Assessment JSON. */
  verifiedRuntimeAttestations?: ReadonlyMap<Sha256Digest, {
    attestationDigest: Sha256Digest;
    verifiedAssuranceLevel: 'verified';
  }>;
}

interface ComparabilityAssessmentPlanVerification {
  assessmentComputationStatus: 'verified';
  policyDigest: Sha256Digest;
  leftCandidateDigest: Sha256Digest;
  rightCandidateDigest: Sha256Digest;
}

interface ComparabilityAssessmentSource {
  assessment: ComparabilityAssessment;
  planVerification: ComparabilityAssessmentPlanVerification;
}
```

`ComparabilityCandidateIdentity` records all stage Plan digests for audit, the subject-neutral `randomizationDesignDigest`, the source Bundle or Decision digest when supplied, and only the normalized verification facts actually used. `ComparabilitySourceVerificationFact` is a discriminated union so a cache receipt cannot claim a provenance trust value and a parent trust fact cannot claim `indeterminate`. A missing artifact is represented by absence plus a reason in the Assessment, never by a fake digest or a self-reported verified fact. The identity never copies raw Dataset, Gold, output, trace, attestation material, cost values, or invocation counts.

Runtime comparison uses two separately digested projections. `runtimeIdentityDigest` uses domain `omk.runtime-identity/v1` and covers the complete sealed RuntimeIdentity. `runtimeImplementationDigest` uses domain `omk.runtime-implementation-identity/v1` and covers exactly `implementationId`, `version`, `fingerprint`, `capabilities`, and the complete `implementationManifest`; only this digest participates in design equality. Evidence qualification contains `fingerprintBasis`, sealed/effective assurance, the closed `provenanceFacets`, effective source trust, and source-verification axes. The implementation manifest must prove structurally that every behavior-affecting dependency is either committed by `fingerprint` or present as a canonical implementation facet; provenance may contain observation and attestation metadata only. A basis- or assurance-only change therefore cannot masquerade as a changed measurement algorithm, a changed effective dependency cannot hide as evidence metadata, and an equal implementation digest cannot masquerade as authenticated execution.

`ComparabilityVerificationContext` is a non-serializable trusted-host input, parallel to existing Bundle verification contexts. Its map key is the complete `runtimeIdentityDigest`; its value is the digest of attestation material already verified by an independent host boundary. Core never accepts raw attestation material, a transported `verifiedByAttestationDigest`, or a caller-supplied effective level as proof. A Runtime may rise above its sealed assurance only when the context contains an exact identity match; Core then records the verified attestation digest in the candidate. Malformed context entries are rejected, while entries for unrelated identities grant no trust and are ignored. New attestation produces a new candidate and Assessment digest rather than mutating an existing artifact.

Comparability follows the same document/source split as every other durable stage:

- `parseComparabilityAssessmentDocument()` validates wire shape, canonical ordering, local invariants, and self-excluding digests only. It returns a document, never an authenticated source.
- `assessComparability()` consumes the Policy, two sealed RunPlans, an exact authenticated stage-source prefix for each side when available, and an optional trusted verification context. It returns a branded `ComparabilityAssessmentSource`.
- `parseComparabilityAssessment()` consumes a transported document plus the same Plans, sources, Policy, and verification context; it recomputes the complete expected Assessment and returns a branded source only on exact equality.

Required source prefixes are Execution+Evaluation for `evaluation`, plus Analysis for `analysis`, and plus Decision for `decision`. A shorter exact prefix is allowed for plan-only diagnosis and yields explicit conditional reasons; a hole, foreign parent, stale stage, or unbranded source is rejected before comparison. `ComparabilityAssessmentSource` is a non-serializable capability guarded like the existing Bundle sources. Automated release consumers must require that source and `comparabilityStatus: 'compatible'`; a transported Assessment that merely claims `verified` has no authority. Host signing may attest a document for transport, but v1 never lets signing bypass plan/source-aware recomputation.

The Policy is immutable, canonical, and content-addressed. It is supplied to the pure Core operation rather than embedded in `MeasurementPolicy` or either RunPlan: comparing historical Runs does not change how either Run was produced. Policy, candidate, and Assessment digests omit their own digest field. The Assessment binds both candidate digests and the Policy digest, and repeats the Policy's `designMode` and `comparisonScope` so a standalone reader cannot mistake Analysis comparability for Decision comparability; plan-aware validation requires exact equality. It contains no clock time, localized message, host path, or unordered reason collection; presentation adapters map stable reason codes to human text.

The Policy and Assessment publish their own JSON Schemas, but those post-hoc schemas are deliberately excluded from each RunPlan's `schemaIdentities`. Adding or revising the comparison mechanism must not retroactively perturb the identity of the measurements being compared. Only schemas consumed while producing a Run enter `runContractDigest`.

Subject mappings must be non-empty, use a unique `subjectId`, be one-to-one on each side, and reference Targets present in the corresponding sealed Plan. Before comparing connectivity, Comparison references, or any other Target-keyed structure, Core alpha-renames every Target to a tagged canonical reference: a mapped Target becomes `{ targetReferenceKind: 'subject', referenceId: subjectId }`, while an unmapped Target becomes `{ targetReferenceKind: 'literal-target', referenceId: targetId }`. The tag is part of canonical identity, so a `subjectId` may equal an unrelated literal Target ID without collapsing two nodes. Each side must remain one-to-one after projection; a duplicate tagged reference is invalid. A descriptive `targetKind` has no special semantics. An undeclared Target addition, removal, remapping, definition change, or Executor implementation change is measurement-system drift and is incompatible. A declared subject change is recorded as an informational reason rather than erased from the audit trail.

All arrays use the following total order before hashing; non-canonical input is rejected rather than silently reordered during document parsing:

- strings compare lexicographically by unescaped UTF-16 code units exactly as RFC 8785/JCS property-name sorting; absent optional values sort before present values;
- stages: `execution < evaluation < analysis < decision`;
- Runtime kinds: `executor < evaluator < analysis-node < missing-policy < decision-policy`;
- source facts: stage, then `verification-axis < source-trust`; verification axes use `provenance-attestation < cache-receipt < invocation-budget < provider-cost-budget < policy-execution`, trust relations use `parent < effective`, followed by source digest;
- tagged Target references sort by `targetReferenceKind` `subject < literal-target` and then `referenceId`; subjects sort by `(subjectId, leftTargetId, rightTargetId)`, artifacts by `(stage, artifactDigest)`, and Runtime qualifications by `(stage, runtimeKind, referenceId, runtimeIdentityDigest)`;
- reasons sort by severity `incompatible < conditional < info`, axis `design < evidence < identity`, scope `evaluation < analysis < decision`, then `reasonCode`.

Uniqueness keys are `subjectId`, each side's Target ID, each side's tagged Target reference, artifact stage, `(stage, sourceDigest, verificationFactKind, verificationAxis/trustRelation)` for source facts, `(stage, runtimeKind, referenceId)` for Runtime qualifications, and `reasonCode` for reasons. A duplicate semantic key is invalid even when the remaining values differ. Each reason code has exactly one normative `(axis, severity)` pair; `scope` must equal the Assessment scope. The identity-change code maps to `(identity, info)`; every `comparability-design-*` code maps to `(design, incompatible)`; `comparability-evidence-source-untrusted` maps to `(evidence, incompatible)`; every other `comparability-evidence-*` code maps to `(evidence, conditional)`. A code is emitted at most once when its category applies, regardless of how many component-level differences triggered it. Canonical component diffs, paths, and per-component digest pairs are a recomputable diagnostic view over the two authenticated Plans, not fields of the content-addressed Assessment. These rules, rather than implementation traversal or diff granularity, define `policyDigest`, `candidateDigest`, and `assessmentDigest` across languages and hosts.

### 7.3 Scope projections

The comparison engine does not infer equivalence from root or downstream digest equality. It compares canonical component projections because an intentional subject change necessarily invalidates `executionPlanDigest` and every downstream digest.

| Requested scope | Invariant measurement projection | Intentionally variable projection |
| --- | --- | --- |
| `evaluation` | execution and evaluation Dataset projections; sample identities and order; scheduling groups; complete ExperimentDesign including trials, root seed, seed coupling, randomization slots, pairing, strata, clusters, and resampling unit; `randomizationDesignDigest`; execution/retry/budget/cache/failure policy; Evaluator and Metric definitions; Evaluator implementation identities; evaluation policy and evidence capture | only declared Target definitions and their bound Executor implementation identities |
| `analysis` | everything for `evaluation`, plus Comparison definitions and families, AnalysisGraph, MissingPolicy and Analysis Runtime implementation identities, output schema identities, and estimator parameters | only declared Target definitions and their bound Executor implementation identities |
| `decision` | everything for `analysis`, plus DecisionPolicy definition and Decision Runtime implementation identity | only declared Target definitions and their bound Executor implementation identities |

Fields outside the requested scope do not poison a valid upstream comparison. For example, a DecisionPolicy-only change is compatible for `analysis` and incompatible for `decision`. Conversely, changing Gold, evaluation context, an Evaluator, Metric, evidence binding, trial count, seed coupling, randomization slots or digest, pairing, cluster, stratum, resampling unit, or estimator is incompatible for every scope that consumes it. A controlled stochastic comparison is exact only when the subject-neutral planned admission ranks and corresponding trial seeds match. An `uncontrolled` stochastic subject is not eligible for `exact-measurement-design`; verified deterministic subjects may omit trial seeds because no Target randomness exists. v1 does not guess that two different instruments, scales, random conditions, sampling designs, or statistical models are “close enough.” Supporting calibration, bridge studies, uncontrolled or independently randomized cross-Run designs, Dataset overlap, or schema migration requires a future explicit design mode and construct-specific assumptions.

JSON property order and annotations excluded from measurement identity produce no incompatibility. A schema identity change is incompatible at the first scope that consumes that schema. Extension data follows its compiler-declared impact stage; an `audit` extension is ignored, while a measurement-stage extension participates in the corresponding projection.

### 7.4 Status derivation and fail-closed rules

`designStatus` is `compatible` only when every invariant projection matches and every subject mapping is valid. Any mismatch makes it `incompatible`; all applicable mismatch categories are reported once in deterministic order, while the diagnostic view may enumerate every changed component.

`evidenceQualificationStatus` is distinct from EvaluationReport's completeness-oriented `evidenceStatus`. It is `verified` only when the supplied source chain required by the scope is independently authenticated, every applicable verification axis is `verified`, and every actually used Runtime has verified effective assurance after applying independent host verification. Plan-only preflight, a required source that is absent, `indeterminate` verification, unknown/declared effective provenance, or declared/unknown effective Runtime assurance yields `conditional` with explicit reason codes. An invariant Runtime with `fingerprintBasis: 'opaque'` also yields a condition because equality does not establish what implementation was held fixed. An effective source trust of `untrusted` yields `rejected`: this is a negative fact, not an unresolved condition. Structurally invalid Plans, artifacts, parent chains, forged digests, or malformed verification context are rejected by their validators before comparison; ComparabilityPolicy is not an alternate artifact-admission path.

The overall status is derived, never supplied by a host:

```text
if designStatus == incompatible                                  => incompatible
else if evidenceQualificationStatus == rejected                  => incompatible
else if evidenceQualificationStatus == conditional               => conditional
else                                                              => compatible
```

`conditional` therefore means “the experimental design matches, but listed authentication conditions remain unresolved.” It never means “the design is probably similar” or “the source is known to be untrusted.” `rejected` preserves that negative evidence fact; the separate `designStatus` shows whether the design itself still matched. Neither conditional nor rejected evidence may authorize a directional release decision. Existing Decision and Report evidence gates continue to fail closed on indeterminate or untrusted sources.

The initial change matrix below is normative. Outcomes assume otherwise verified evidence; `conditional` rows override that assumption. “Ignored” means outside the requested scope, not omitted from either Run's identity.

| Change | `evaluation` | `analysis` | `decision` | Stable reason code |
| --- | --- | --- | --- | --- |
| annotations or JSON property order only | compatible | compatible | compatible | none |
| Gold or evaluation context | incompatible | incompatible | incompatible | `comparability-design-evaluation-input-mismatch` |
| Evaluator, Metric, or evaluation evidence policy | incompatible | incompatible | incompatible | `comparability-design-evaluation-instrument-mismatch` |
| declared subject Target definition or bound Executor implementation | compatible | compatible | compatible | `comparability-identity-declared-subject-change` |
| undeclared Target or Executor implementation | incompatible | incompatible | incompatible | `comparability-design-undeclared-subject-change` |
| trial count, root seed, seed coupling, randomization slots, pairing, cluster, stratum, resampling unit, or scheduling connectivity | incompatible | incompatible | incompatible | `comparability-design-sampling-mismatch` |
| subject-neutral randomization digest, planned rank, or controlled coordinate seed differs; or a stochastic subject is uncontrolled | incompatible | incompatible | incompatible | `comparability-design-randomization-mismatch` |
| AnalysisGraph or estimator | ignored | incompatible | incompatible | `comparability-design-analysis-mismatch` |
| Comparison definition or family | ignored | incompatible | incompatible | `comparability-design-comparison-mismatch` |
| DecisionPolicy or Decision Runtime implementation | ignored | ignored | incompatible | `comparability-design-decision-mismatch` |
| consumed schema or measurement-stage extension | incompatible at first consuming scope | incompatible | incompatible | `comparability-design-schema-mismatch` |
| plan-only comparison or required source absent | conditional | conditional | conditional | `comparability-evidence-source-absent` |
| transported source verification is `indeterminate` | conditional | conditional | conditional | `comparability-evidence-verification-indeterminate` |
| effective provenance is unknown/declared, or Runtime assurance is not verified | conditional | conditional | conditional | `comparability-evidence-assurance-unverified` |
| effective source trust is `untrusted` | incompatible (`evidenceQualificationStatus: rejected`) | incompatible (`evidenceQualificationStatus: rejected`) | incompatible (`evidenceQualificationStatus: rejected`) | `comparability-evidence-source-untrusted` |
| an invariant Runtime uses an opaque fingerprint | conditional | conditional | conditional | `comparability-evidence-runtime-identity-opaque` |

Invalid subject mappings use `comparability-design-subject-mapping-invalid`; any invariant component not covered by a more specific code uses `comparability-design-projection-mismatch`. Equal versus different stage and artifact digests are recorded in candidate identities, not emitted as verdict reasons. Reason codes are category-level and unique; adapters that need field-level explanations recompute a non-authoritative diagnostic diff from the authenticated Plans. Unknown reason codes fail closed for automated release consumers; readers may still preserve and display them.

### 7.5 Consequences and rejected alternatives

This design allows a new prompt, RAG configuration, skill, agent, workflow, model, or service implementation to be the independent variable without weakening the measurement instrument. It also allows an Analysis result to remain comparable when only a later DecisionPolicy changes. The cost is deliberate strictness: v1 rejects potentially defensible comparisons until their assumptions are represented by a versioned design mode.

The following alternatives are rejected:

- **Compare only `runContractDigest`:** rejects every intended subject change and conflates all downstream invalidation.
- **Treat equal stage digests as sufficient:** proves content identity only and ignores provenance, subject declaration, and construct validity.
- **Let CLI, Studio, or a host decide ad hoc:** produces mutually inconsistent release gates and unauditable historical results.
- **Use `conditional` for arbitrary design drift:** turns a precise state into a waiver mechanism and makes automated decisions unsafe.
- **Put ComparabilityPolicy in each RunPlan:** changes Run identity for a post-hoc relation and prevents one immutable Run from participating in multiple declared comparisons.
- **Derive seeds or admission ranks from plan-bound artifact IDs:** lets the intended subject change perturb the random condition, so identity and randomization use separate domains.
- **Alpha-rename Targets to untagged strings:** permits a subject alias to collide with an unmapped Target; canonical references use a tagged namespace.
- **Put `fingerprintBasis` or diagnostic diff details in design identity:** mixes evidence or presentation with behavior. Behavior-affecting facets enter implementation identity; reason identity remains category-level.

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

Timeout is cooperative: Core aborts the attempt signal, waits for the Executor promise to settle so no late promise is abandoned, and records timeout as the single terminal fact even if the Executor returns success after observing abort. External cancellation has the same single-terminal rule. The shared Run budget separates a monotonic wall-clock deadline from summed active attempt duration: already admitted work settles, while later blocks are censored. Provider-cost limits use only provider-reported facts; strict mode reserves a trusted bound, while bounded-overshoot mode stops later admission after observed exhaustion. Already observed usage is never rewritten.

Execution cache and evidence storage are injected ports rather than filesystem services. `replay-only` misses and invalid cache entries fail closed; transparent hits require the deterministic, verified identity already sealed by prepare. Admission revalidates coordinate/runtime identity, native provenance, the original miss receipt, output/trace capture mode, classification ceiling, the complete attempt/retry chain, attempt-derived usage, and provider-cost eligibility before any cached record becomes a replay fact. Durable validation applies the same sealed cache envelope and cost rules, but treats the receipt as verified only when an independent trusted cache boundary supplies it; transported self-claims remain `indeterminate`. Native invocation cost is aggregated across the current Bundle, while replayed historical cost proves cache eligibility and never counts as current spend. Cache writes are deferred until resources tear down successfully and the run has no execution, cancellation, or budget terminal at commit time; only records whose cost audit, evidence materialization, and trial teardown succeeded are eligible. A later terminal-event delivery failure does not retroactively invalidate an already committed Target fact. Full, reference, digest-only, and omitted capture are materialized under the classification ceiling. Reference capture verifies the ContentStore descriptor digest before it enters a Bundle. Raw host exception text is not copied into events or Bundles.

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

EvidencePolicy v1 controls full/reference/digest/none capture independently for executor output, execution trace, and evaluator-produced evidence. Dataset input and expected values are sealed plan inputs, not capture envelopes.

### 11.1 ADR: keep Dataset inputs out of EvidencePolicy v1

**Status:** accepted for v1; tracked by [#441](https://github.com/lizhiyao/oh-my-knowledge/issues/441).

EvidencePolicy v1 does not expose `input` or `expected` capture modes. Earlier drafts included both fields, but changing them only changed EvaluationPlan identity: no Runtime captured a corresponding artifact, no Bundle recorded the choice, and durable import could not revalidate it. v1 therefore rejects those fields as unknown instead of retaining aliases, deprecation paths, or no-op compatibility behavior.

Dataset input remains bound by `executionInputDigest`; expected and evaluation context remain bound by `evaluationInputDigest`. The sealed EvaluationPlan supplies the requested bindings to Evaluators, while Gold stays absent from Executor contexts and execution artifacts. This preserves measurement identity and Gold isolation without pretending that plan-resident values are durable evidence captures.

A future full/reference/digest/none policy for Dataset content requires a separate, content-addressed artifact model that avoids per-trial and per-Evaluator duplication. It must define ContentStore/ContentResolver authorization, digest and media-type verification, classification and redaction, replayability and evidence-status consequences, and durable-import revalidation. Dataset/Gold persistence and presentation are therefore deferred to an explicit artifact or host policy; adding them requires a new wire-schema revision rather than silently restoring v1 fields.

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

The first implementation phase is tracked by [#427](https://github.com/lizhiyao/oh-my-knowledge/issues/427). Its source of truth is isolated under `src/evaluation-core/contracts/`; it does not import CLI, executor, grading, renderer, server, or other application layers. The historical evaluation implementation has been removed.

The catalog currently publishes twenty JSON Schema 2020-12 roots under `schemas/evaluation-core/v1/`: ExecutorCapabilities, EvaluationDefinition, MeasurementPolicy, four stage Plans plus RunPlan, ComparabilityPolicy, ComparabilityAssessment, Event, BudgetSummary, three single-Run Bundles, EvaluationReport, and four Evaluation Series contracts. TypeScript types are inferred from the same Zod 4 schemas. `yarn build:schemas` regenerates the files, while `yarn build` checks committed output for drift and copies it into the package build.

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

Evaluation coordinates use canonical `(targetId, sampleId, trialIndex, evaluatorId)` order and bind the Evaluator's explicit instrument, ensemble-member, replicate-group, and replicate-index identity. `evaluationId`, attempt IDs, and observation IDs use domain-separated digest derivation. Every active EvaluationRecord binds the exact canonical ExecutionRecord digest, evaluator measurement coordinate, and resolved Evaluator RuntimeIdentity. The cache key additionally binds the EvaluationPlan, materialized inputs, source record, and effective source trust, so changing Gold, evaluator identity, bindings, execution evidence, or the source trust ceiling cannot silently reuse a score. Cache replay validates the full record schema, retry identities, ordered metric contract, scale, source digest, runtime identity, deterministic attempt-to-record usage aggregation, and provider-cost eligibility before accepting a hit; replay provenance never raises source trust.

Evaluation retry, timeout, and concurrency are sealed under `MeasurementPolicy.evaluation`; invocation, active-duration, wall-clock, and provider-cost limits are sealed once under the shared `MeasurementPolicy.budget`. Start-time options cannot override either contract. An invocation reservation is consumed only immediately before `evaluate()`, so `openRun()` and `openRecord()` failures consume no quota. Failed and retried invocations retain and charge their provider-reported usage exactly like successful invocations. Timeout is cooperative: Core aborts, waits for the evaluator promise to settle, discards any late result, and only then retries or disposes the record resource. Cache entries are committed only after evaluator record/run resources close cleanly. Event delivery reuses the stage-neutral sealed EventDeliveryPolicy and an injected per-Run EventSequencer shared by Execution and Evaluation.

Missingness is source-aware and binding-based. Before evaluator admission, Core freezes binding closure for the entire coordinate universe. A missing or budget-censored ExecutionRecord, or any unresolvable required binding, produces `not-evaluated`, never a zero or default score. Failed and cancelled ExecutionRecords remain eligible when all declared inputs are still materializable, such as trace-only evaluation. For reference content, the descriptor seals media type alongside value digest and classification: a Resolver may supply the value but cannot rewrite that identity, and a ContentStore descriptor must preserve the requested media type. Evaluator omissions become explicit missing observations. Unknown/duplicate metrics are evaluator failures; value-type mismatches and numeric scale violations become invalid observations without coercion or clamping. Evaluators receive only their declared sealed MetricDefinitions. Observation metadata is classified content and follows the same capture and classification ceiling as evidence. Evaluator-produced metrics are sample-scoped; aggregation remains an AnalysisGraph responsibility.

`parseEvaluationBundleDocument()` validates standalone wire shape, state transitions, identities, coverage, replayability, and digest. `parseEvaluationBundle()` additionally binds the sealed RunPlan and an authenticated `ExecutionBundleSource`, checks every structurally decidable invariant, and returns an `EvaluationBundleSource`; a durable Bundle remains valid when external runtime evidence is unavailable, but its verification remains `indeterminate`. Admission is stage-scoped: the Execution source must match the current ExecutionPlan, while the EvaluationBundle must match the current EvaluationPlan and exact parent ExecutionBundle. Their persisted `runContractDigest` values retain authenticated origin lineage rather than requiring equality with a later downstream-only root contract. Known native invocations and provider cost establish lower bounds, while unverified cache claims establish upper bounds; provenance, cache-receipt, invocation-budget, or provider-cost-budget status becomes `indeterminate` rather than invalid when Bundle JSON alone cannot prove it. A completed Bundle under a provider-cost budget requires every native evaluator attempt to report the sealed currency, and its aggregate native spend must remain below the limit. Evaluation Runtime publishes independently observed evidence through `EvaluationRun.source` and derives downstream provenance from the effective authenticated source trust. Reconstructing a claimed native miss or provenance digest from the artifact itself never grants a receipt or attestation. Analysis may still run for diagnosis, but Decision produces stable `not-decided` reasons whenever either source has an indeterminate verification axis; Report validation also rejects a directional DecisionResult that bypasses this gate. Coverage follows `planned = eligible + sourceUnavailable`, `eligible = started + notStarted`, and `started = completed + failed + cancelled`.

## 19. Analysis and Decision Runtime v1 implementation baseline

[#437](https://github.com/lizhiyao/oh-my-knowledge/issues/437) implements Analysis and Decision as separate, reproducible stages. ExecutionPlan seals only the execution-affecting ExperimentDesign projection. AnalysisPlan seals the metric contracts, full ExperimentDesign including estimator identity, trial count and root seed, Comparisons, AnalysisGraph, MissingPolicy identities, Analysis Runtime identities, and output schemas. DecisionPlan separately seals DecisionPolicy and its resolved RuntimeIdentity. A Comparison or estimator change invalidates Analysis and downstream identity without invalidating Execution or Evaluation; a policy-only change invalidates Decision and the root contract.

Analysis materializes an immutable typed relation over the complete planned metric-coordinate universe. Rows retain Target, sample, trial, evaluator, Metric, sampling-unit identities, censoring, and source status. Observed, missing, invalid, evaluation-failed, source-unavailable, and not-started values remain distinct; only observed rows may be included in v1. Nodes execute in stable topological order and receive only declared Metric, upstream result, or exact Comparison-contrast inputs. Core, rather than an implementation, assigns result identity, RuntimeIdentity, schema, coverage, lineage, mode, and digest. Runtime output is checked as the complete `{ resultType, value }` envelope against both the wire result contract and a Core-owned validator selected from an independently injected registry by the full sealed SchemaIdentity; an Analysis implementation cannot validate its own output. Semantic invariants that JSON Schema cannot express, including Bonferroni arithmetic and canonical family membership, are part of the validator and schema digest.

The built-in registry provides the three descriptive reducers, three deterministic percentile-bootstrap estimators, Bonferroni correction, explicit exclusion MissingPolicy, and a minimal progress DecisionPolicy. Each built-in reducer and estimator seals exactly one Metric input. Bootstrap draws are domain-separated from the sealed root seed, AnalysisPlan digest, node identity, and replicate index. Repeated trials are first reduced within their declared sampling unit; paired contrasts are formed within complete pairing blocks before resampling; cluster bootstrap resamples whole clusters. Insufficient units or failed assumptions yield an inconclusive result and never select a fallback estimator. Built-in Runtime identities are self-reported and carry `assuranceLevel: declared`; only an independent host verifier or attestation boundary may promote executing code to verified assurance.

Decision consumes only the policy's named AnalysisResults plus coverage, assumption checks, evidence status, and its explicitly sealed comparison family. A correction result must match that exact family, rather than the global Comparison count. A decided result carries both the verdict and a non-empty, unique, canonically ordered reason-code set; a failed gate produces stable `not-decided` reasons under the same canonical rule. Reason codes participate in the Decision digest and terminal event so a directional conclusion remains independently auditable without parsing presentation text. Policy or infrastructure failure is distinct from a statistical conclusion. EvaluationReport then materializes Bundle references, the content-addressed DecisionResult, provenance, and the derived run/evidence/conclusion axes without recomputing statistics or verdicts. Host annotations are presentation metadata: they may change the report artifact digest but never a stage Plan or source Bundle digest.

AnalysisBundle, DecisionResult, and EvaluationReport expose standalone document validators and plan-and-source-aware validators. Runtime and verified imports return authenticated source envelopes for Execution, Evaluation, Analysis, and Decision; each envelope retains non-serializable verification evidence and binds its direct parent digest. Downstream stages require both this exact source chain and the current Plan identity for every consumed stage, so individually valid artifacts from different runs cannot be spliced together and a stale stage cannot cross a changed stage boundary. A downstream-only Plan change may still reuse durable upstream envelopes whose own stage Plans and direct parents remain unchanged. Stage Bundle `runContractDigest` fields record their producing root; the final EvaluationReport alone must bind the current RunContract root. Transported JSON remains `indeterminate` until a producer or host verifier independently attests its digest; a reconstructed digest never authenticates provenance or policy execution.

Each child envelope records the effective trust of its authenticated direct parent separately from the child's own provenance attestation. A valid historical artifact may therefore remain structurally admissible when live verification material is unavailable, while its effective trust is capped rather than rejected. Attesting only an Evaluation, Analysis, or Decision child never upgrades an unattested parent. Decision effective trust is capped by Analysis source trust, DecisionPolicy Runtime assurance, and policy-execution attestation; Report trust consumes that effective Decision trust even for non-directional `not-decided` results. The validators also require complete graph/runtime/schema bindings, independent output validation, policy identity, and a provenance trust level no higher than the least-trusted source or executed Runtime assurance. Every AnalysisRecord seals canonical `runtimeDependencies` for the AnalysisNode and MissingPolicies that were actually invoked; Core records a dependency before entering its port so failure and cancellation cannot erase it. Standalone validation binds these facts into the record and Bundle digests, while plan-aware validation rejects non-sealed, unreachable, non-canonical, or structurally omitted dependencies. Analysis trust is the minimum of authenticated source trust and only those recorded Runtime dependencies, so a planned but unused Runtime cannot lower or raise the result. Structured Analysis port failures preserve validated code and stage but replace the provider message; malformed failures become a contained infrastructure error. AnalysisBundle provenance has exactly one parent—the validated EvaluationBundle—and cannot admit unrelated digests. Optional Bundle-reference URIs locate content but do not participate in source identity beyond the sealed digest.

Execution, Evaluation, Analysis, Decision, and eventful Report materialization reuse the same injected per-Run EventSequencer and sealed EventDeliveryPolicy. Events contain identities, status, coverage summaries, and reason codes only. Bounded streams never backpressure authoritative work; required durable delivery is delegated to EventWriter. Every asynchronous terminal path closes its event stream and Analysis removes its external AbortSignal listener, including unexpected clock, sequencer, validation, or materialization failures. Analysis cancellation is cooperative at node boundaries, preserves completed facts, and materializes every remaining node as not evaluated. The same AbortSignal is passed into in-flight Analysis and Decision ports; once aborted, a port rejection or late success cannot overwrite the cancelled terminal fact. Node resources are disposed exactly once, and Core performs no file, network, environment, process-signal, or global-registry access.

## 20. Conformance v1 implementation baseline

[#439](https://github.com/lizhiyao/oh-my-knowledge/issues/439) adds a deterministic,
host-independent harness under `test/evaluation-core/conformance/`. Pure function, RAG top-K,
and Agent trajectory fixtures share one stage driver from preparation through report
materialization. Only protocol manifests, Runtime capabilities, structured adapter values, and
Evaluator declarations vary; Core contains no `targetKind` dispatch. Every serialized Bundle and
Report is revalidated against its sealed plan and parent facts.

The suite exercises Gold isolation and evaluator-only re-scoring, native Recall@K, Precision@K,
MRR, and NDCG observations, source-neutral trajectory evidence, output-only evaluator projection,
session lifecycle, reversed Comparison roles, paired-block budget censoring, repeated-trial and
cluster bootstrap unit counts and an exact interval reference that distinguishes whole-cluster from
row resampling, an end-to-end Bonferroni comparison family with raw-to-corrected
hypothesis lineage, evidence gates, classification redaction, reference content resolution, cache replay,
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

Conformance exposed cross-stage defects: durable Bundle admission previously compared the
originating root contract with the current RunPlan. Origin lineage remains sealed and
provenance-bound, but admission is now stage-scoped and recursively checks each consumed stage Plan
plus its exact direct parent. A downstream-only change can therefore reuse still-current upstream
Execution, Evaluation, or Analysis evidence, while a changed stage rejects the old stage envelope
before Runtime admission. EvaluationReport remains bound to the current root RunContract.
Execution cache admission also verifies the exact native provenance and original cache-miss receipt
that Core emitted for the sealed ExecutionPlan, plus sealed output/trace capture, classification,
attempt/retry-chain, deterministic aggregate-usage and provider-cost semantics. A stale digest,
replay-provenance rewrite, classification escalation, capture-mode mismatch, malformed attempt chain,
forged aggregate usage, missing cost, currency mismatch, or cost at or above the sealed maximum fails
closed before an Executor is opened. Execution capture policy is part of ExecutionPlan identity, so a
legitimate policy change creates a fresh cache
namespace instead of turning into an infrastructure failure.
Executor provenance is now capped by sealed Runtime assurance from each native record through the
ExecutionBundle and final Report. Source envelopes also preserve the effective trust of their direct
parent independently of child attestation, and Report provenance includes Decision policy-execution
attestation for both directional and non-directional results. The conformance suite imports and
fully revalidates these trust chains, cluster-resampling artifacts, and corrected comparison families.

## 21. Analysis cohorts, evaluator replicates, and Evaluation Series

[#452](https://github.com/lizhiyao/oh-my-knowledge/issues/452) corrects three v1 measurement-unit gaps. These changes are `BREAKING-SCHEMA`: v1 has no compatibility reader or data migration path.

### 21.1 Analysis-only sample projection

`EvaluationSample.analysis` contains only analysis membership and classified analysis context. `EvaluationDataset.analysisCohorts` defines every stable `cohortId`, its `cohortSetId`, whether the set is a mutually exclusive `partition` or overlapping `cohort`, its content classification, disclosure rule, and optional versioned seeded derivation. A sample may belong to at most one cohort in each partition set. An `identity-only` cohort cannot carry a raw membership value.

The Compiler now seals four distinct projections:

| Projection | Content | Visible to |
|---|---|---|
| Execution | `sampleId + input + executionContext` | Executor |
| Evaluation | Execution projection plus `expected + evaluationContext` | Evaluator |
| Analysis | stable `sampleId + analysis` and cohort definitions | Analysis Runtime |
| Dataset revision | every Dataset fact and audit annotation | lineage and audit |

`analysisInputDigest` covers the Analysis projection. It enters AnalysisPlan, DecisionPlan, and `runContractDigest`, but not ExecutionPlan or EvaluationPlan. Changing a holdout or cohort therefore cannot perturb Target execution, evaluator cache identity, or evaluator-visible Gold. AnalysisPlan materializes the analysis samples and cohort registry, and both are passed to Analysis Runtime as sealed execution context. Each metric row carries canonical `cohortIds`; a node applies its sealed `cohortFilter` without parsing sample IDs, array positions, or host closures. Report and Event contracts never copy raw analysis context automatically.

### 21.2 Evaluator measurement identity

Every EvaluatorDefinition declares a versioned measurement coordinate with `instrumentId`, `ensembleMemberId`, `replicateGroupId`, and zero-based `replicateIndex`. The Evaluator RuntimeIdentity still proves the actual implementation, model, prompt, and capability fingerprint; it cannot substitute for experimental identity. `evaluatorId` remains a stable definition reference and is no longer interpreted as an encoded repeat convention.

Evaluation coordinates, `evaluationId`, EvaluationRecord, cache identity, and Analysis metric rows all bind the complete measurement coordinate. Retry `attemptNumber` remains infrastructure recovery inside one evaluator replicate. Target trial, evaluator replicate, ensemble member, retry attempt, independent Run, and batch item are consequently distinct typed levels. Analysis implementations can compute self-consistency by `replicateGroupId`, inter-rater agreement by `ensembleMemberId`, and sample-level estimates without treating repeated observations as independent experimental units.

### 21.3 Evaluation Series

An Evaluation Series is a separate offline Core workflow over independent Runs. `createEvaluationSeriesDefinition()` canonicalizes member slots, zero-based replicate indices, exact-design comparability policy, versioned Series analysis standards, and an optional Series decision policy into `seriesDesignDigest`. A preregistered slot cannot contain a post-execution expected Run digest. Instead, every member EvaluationDefinition binds `{ seriesDesignDigest, memberId, replicateIndex }` before execution; this membership changes only the root Run contract identity. `prepareEvaluationSeriesPlan()` resolves Series Runtime requirements into a content-addressed `EvaluationSeriesPlan`; member and Runtime order cannot change its identity. An exploratory Series may additionally bind already-known expected Run contract digests, but can never be upgraded to preregistered.

Series never accepts a file, URI, unverified Report object, or host summary as evidence. `createEvaluationSeriesMemberSource()` requires a sealed RunPlan and the authenticated Execution, Evaluation, Analysis, optional Decision source chain, then revalidates the EvaluationReport before issuing a non-serializable member capability. Each durable `SeriesMemberReference` binds the Run contract, all stage Plan digests, all Bundle digests, optional Decision digest, Report digest, terminal three-axis status, and effective trust.

`runEvaluationSeries()` first enforces member-slot uniqueness, any expected Run identity, and—when preregistered—the member Run's exact pre-execution Series binding. A post-hoc Run with no matching binding fails closed. Core then applies the explicit ComparabilityPolicy from an anchor Run to every candidate. The complete authenticated ComparabilityAssessment for every non-anchor member is persisted in SeriesAnalysisBundle, so design incompatibility, evidence conditionality, and identity change remain auditable rather than collapsing into a count. Design incompatibility is never accepted. Evidence-conditional comparability is admitted only when the preregistered policy allows `conditional`; an identity change cannot be hidden as a missing member. Missing, partial, cancelled, budget-exhausted, and failed Runs remain in `SeriesMemberCoverage` and are never dropped or converted to zero.

Series Analysis Runtime receives only the sealed plan and authenticated member capabilities. Every node declares explicit member or upstream-result inputs plus its minimum member evidence status; design-comparable Runs that are failed, cancelled, budget-exhausted, or below that evidence threshold remain in coverage but are not passed to the estimator or counted as resampling units. Prepare rejects missing references, duplicate inputs, cycles, implementation mismatches, and any analysis Runtime that does not declare `experimentalUnit = run`. Runtime executes the canonical DAG topologically and binds each parent digest. A node declares a versioned `analysisStandardId`, such as a variance, coefficient-of-variation, or stability implementation; its RuntimeIdentity, complete output SchemaIdentity, and assumption checks enter the record digest. The Core-owned validator is independently injected by exact schema identity and must preserve the complete `{ resultType, value }` envelope; the producing Runtime cannot validate its own output. Fewer than two eligible Runs or a failed assumption produces an explicit inconclusive record. Records and decisions distinguish `executed` from `not-executed`; Runtime failures are persisted with a fixed, redacted Core error rather than reflecting host details. A Series decision is directional only after the sealed coverage ratio, minimum member evidence status, required-result, and assumption gates pass. Otherwise Core emits `not-decided` without invoking the directional policy. `SeriesAnalysisBundle` and `EvaluationSeriesReport` independently verify canonical order, uniqueness, coverage arithmetic, input lineage, and all content digests. Re-analysis creates new derivation artifacts and preserves the preregistered or exploratory mode; it does not mutate or re-execute member Runs.

Series uses `experimentalUnit = run`. Within-Run trials, evaluator replicates, and retry attempts are never resampled as independent Runs. Existing Bootstrap, Krippendorff alpha, five-layer scoring, and release formulas are unchanged; a new Series formula must be introduced as a separately versioned Runtime standard and must declare its assumptions.

## 22. Shared Run budget contract and authoritative ledger

[#453](https://github.com/lizhiyao/oh-my-knowledge/issues/453) replaces the independent Execution and Evaluation counters with one Core-owned `RunBudgetSource`. This is a `BREAKING-SCHEMA` change with no legacy reader or migration path. Budget policy is sealed once under `MeasurementPolicy.budget`; both stage Plans carry the same complete policy so a detached stage cannot silently reinterpret a Run limit.

The policy has four typed scopes. `run` limits invocations, provider cost, summed active attempt duration, and wall-clock duration. `stages.execution` and `stages.evaluation` constrain stage consumption without creating independent ledgers. `coordinate` applies to the shared `(targetId, sampleId, trialId)` across Target execution, every Evaluator, and every retry. `attempt` owns per-invocation provider-cost limits, while `MeasurementPolicy.execution.timeoutMs` and `MeasurementPolicy.evaluation.timeoutMs` remain cooperative attempt timeouts. All applicable scopes are conjunctive: admission and offline verification apply every configured limit, cumulative scopes use the most restrictive applicable aggregate ceiling, and the per-attempt ceiling is checked independently rather than being misapplied to a retry aggregate. Evaluation's Run-level verification includes the authenticated Execution ledger prefix. Wall-clock time and summed active duration are intentionally different: queueing, binding resolution, and backoff consume wall time; only an admitted native invocation contributes active duration. Concurrent attempts therefore add active duration independently instead of pretending it is elapsed wall time.

`RunBudgetSource` is an in-memory capability authenticated by Core and bound to both `runId` and `runContractDigest`. Its host-visible value is a frozen opaque handle with no reservation, settlement, or snapshot methods; mutable ledger authority remains in a Core-private `WeakMap`. It cannot be recreated from JSON, mutated by the host, reused across Runs, or replaced by a stage-local counter. The Engine creates one source and passes it through Execution and Evaluation. An advanced detached Evaluation may start only from an authenticated `ExecutionBundleSource`; Core seeds a new capability from that source's verified ledger prefix and rebinds the resulting summary to the current downstream Run contract. Persisted `BudgetSummary` is evidence, never authority.

Admission is reservation based. A scheduling block submits all first attempts in one operation, so a paired block is admitted or censored atomically. Retry attempts reserve separately. Invocation limits reserve exactly. Under `strict-reservation`, every applicable provider-cost limit requires a `verified` Runtime identity, required provider-cost reporting, and a sealed trusted per-invocation upper bound in Runtime capabilities; missing or wrong-currency bounds fail before invocation. Under `bounded-overshoot`, Core stops future admission after observed exhaustion and persists the maximum number of concurrent unreserved cost-bearing invocations. This makes the overshoot envelope explicit instead of presenting post-paid cost as a hard pre-execution guarantee.

Every consumed native attempt settles exactly once into the canonical ledger with stage, shared coordinate, attempt identity, invocation count, active duration, reported cost or explicit unreported status, admission mode, and outcome (`completed`, `failed`, `cancelled`, or `attempt-timeout`). Unknown cost is never converted to zero. The sealed policy chooses `fail-run` or `mark-unverifiable`; the latter blocks directional decisions through the existing provider-cost verification gate. Currency mismatch and violation of a trusted reservation bound fail closed.

`BudgetSummary` is embedded in ExecutionBundle, EvaluationBundle, and EvaluationReport. It persists the sealed limits beside actual per-scope totals, explicit overshoot, unreported-cost coverage, outstanding reservations, cumulative wall-clock usage, and each strict provider-cost reservation with its honored, violated, or not-assessable status. Its contiguous sequence, unique attempt identities, per-scope totals, multi-currency aggregation, overshoot, and `ledgerDigest` are independently recomputable. Evaluation's ledger must extend the authenticated Execution ledger prefix; every current native record attempt must match exactly one ledger entry, while a cache replay must add none. Report must retain the final Evaluation summary exactly. Termination keeps budget censoring, active-budget exhaustion, wall-clock exhaustion, attempt timeout, cancellation, and failure distinct. Cache hits carry historical usage for eligibility audits but create no current native invocation entry.

This design follows resource-quota admission practice rather than billing dashboards: reserve before starting work, account actual use after settlement, and keep limit, usage, and uncertainty separate. It also follows structured deadline/cancellation practice by preserving one Run deadline while keeping attempt timeout a narrower child boundary. GenAI telemetry conventions inform the usage facts, but provider telemetry remains an observation with explicit trust and reporting status, not the authority that grants budget admission.

## 23. Sample-scoped execution controls

[#542](https://github.com/lizhiyao/oh-my-knowledge/issues/542) makes workspace and tool authority an explicit, sample-scoped Core contract. This is a `BREAKING-SCHEMA` change with no legacy reader or migration path. A Target declares canonical `executionControls.defaults` plus sparse `sampleOverrides`. Each override replaces the complete workspace field, tool field, or both; inheritance is field-by-field and never unions tool sets. `allow-list` with an empty list therefore means deny all tools, while `runtime-default` remains a distinct policy.

A workspace control is either `not-required` or `copy-on-write-overlay` with a content-addressed descriptor containing only `resourceId`, digest, media type, classification, and size. Locator, credentials, bytes, and `gold` classification are forbidden in Core JSON. Host-owned resource leases bind the descriptor to the locator and verify it before use. `TargetDefinition.executionRequirements` is only the aggregate capability request across all effective sample controls; it does not grant a Trial the aggregate authority.

The Compiler resolves one canonical `EffectiveExecutionControl` for every `(targetId, sampleId)` coordinate and passes exactly that frozen value to the Executor Trial. The execution-coordinate digest, Trial identity, native provenance, and v2 cache key bind that effective control. Changing sample A's workspace or tools invalidates only sample A coordinates and cache entries; sample B identity remains stable. Gold, expected values, evaluation context, annotations, other samples' workspace locators, and other samples' tool grants never enter the Trial projection.

Runtime preparation separately binds the complete canonical control table through `RuntimeBinding.executionControlsDigest` and binds every required workspace through the aggregate resource lease. This prevents a host from pairing a validated Runtime with a different control table while preserving coordinate-local cache identity. An adapter must enforce the exact Trial workspace and exact tool policy, expose only the selected workspace lease, or fail closed during preparation when its backend cannot represent that policy. It may not approximate sample controls with a Target-wide union, common subset, process working directory, or best-effort filtering.

## 24. ADR: publish staged execution through prepared capabilities

**Status:** accepted for the public API tracked by [#597](https://github.com/lizhiyao/oh-my-knowledge/issues/597).

The advanced API is issued by `PreparedEvaluation`, not by exporting a second engine that accepts
wire-shaped plans. `prepared.stages(options)` creates one run-scoped stage session. The session owns
the host-assigned run identity, AbortSignal, bounded event settings, EventWriter, and one shared
EventSequencer. Each of Execution, Evaluation, Analysis, Decision, and Report materialization may be
started once, in the suffix required by the host. Every method delegates directly to the existing
stage runtime, so scheduling, cache, budget, failure, cancellation, and resource teardown semantics
remain single-sourced.

The package root deliberately types `prepare()` as the minimal one-call `PreparedEvaluation`.
`oh-my-knowledge/evaluation-core` exposes the same factory with the narrower advanced return type;
it does not create a second implementation, registry, or execution path. Studio and downstream
projections live behind their own explicit subpaths, while unlisted and `dist/*` deep imports remain
closed. This keeps dependency direction visible without fragmenting runtime authority.

Each prepare or one-call start captures the Runtime's top-level infrastructure ports, binding
resolver functions, and an independent Schema-validator registry. Validator SchemaIdentity values
and parse functions are captured together. A host may update its registry for a later prepare, but
mutating the original Map, validator object, or Runtime property cannot change validation semantics
for an already prepared RunPlan. This extends the binding snapshot rule to every executable
validator that participates in Analysis admission without pretending to freeze host-internal client
state.

The session owns its `runId` in the Engine while it is open, rejects overlapping stages, and releases
the identity automatically after Report termination. Hosts that intentionally stop at an earlier
Bundle call `await stages.close()`; close aborts any in-flight stage, waits for its existing runtime
teardown, and only then releases the identity. This prevents event identifier collisions with the
one-call facade without introducing another scheduler.

Execution and Evaluation in the same session share the authenticated in-memory budget capability.
A detached Evaluation instead seeds a new budget capability from the admitted Execution source's
verified ledger prefix, as the low-level runtime already requires. Stage outputs expose both their
serializable document and the non-serializable source envelope. Event streams remain lossy,
bounded observations and never gate the authoritative result.

Transported artifacts re-enter through `PreparedEvaluation.admitExecutionBundle()`,
`admitEvaluationBundle()`, `admitAnalysisBundle()`, and `admitDecisionResult()`. These methods close
over the freshly sealed plan and Core-owned schema validators, recursively validate the exact parent
chain, and return runtime-authenticated source capabilities. `admitReport()` validates the complete
chain without creating a new authority. A copied plan, Bundle, verification summary, or provenance
claim therefore cannot substitute for a capability issued by prepare, runtime execution, or
plan-aware admission. Missing external attestations remain indeterminate and never become verified
because their digest can be recomputed.

This ADR publishes composition only. It changes no wire schema, Plan digest, scoring rule,
statistical implementation, prompt, trust calculation, or comparability reason.

## 25. Industry references

- [Inspect AI Tasks](https://inspect.aisi.org.uk/tasks.html), [Scorers](https://inspect.aisi.org.uk/scorers.html), and [Eval Logs](https://inspect.aisi.org.uk/eval-logs.html)
- [MLflow Evaluation Datasets](https://mlflow.org/docs/latest/genai/datasets/) and [LLM Judges and Scorers](https://mlflow.org/docs/latest/genai/eval-monitor/scorers/index.html)
- [Phoenix Experiments](https://arize.com/docs/ax/improve/experiment-in-code)
- [Pydantic Evals](https://pydantic.dev/docs/ai/evals/evals/) and [Report Evaluators](https://pydantic.dev/docs/ai/evals/evaluators/report-evaluators/)
- [lm-evaluation-harness Task Guide](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/docs/task_guide.md)
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) and [OpenInference Semantic Conventions](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md)
- [Kubernetes Resource Quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/) and [Go context deadlines and cancellation](https://pkg.go.dev/context)
- [CloudEvents](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md) and [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [W3C PROV Overview](https://www.w3.org/TR/prov-overview/) and [PROV-AQ](https://www.w3.org/TR/prov-aq/)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12), [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html), and [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)
- [Zod 4 JSON Schema](https://zod.dev/json-schema), [Node.js Events](https://nodejs.org/api/events.html), and the [Sigstore Bundle specification](https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto)

## Related documents

- [Scoring pipeline](scoring.md)
- [Scoring equivalence migration RFC](evaluation-scoring-equivalence.md)
- [Statistical rigor](../explanation/statistical-rigor.md)
- [Terminology spec](terminology-spec.md)
- [RAG metrics spec](rag-metrics-spec.md)
