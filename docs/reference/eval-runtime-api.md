# eval-runtime API layers

`package.json#exports` is the supported boundary. The API allowlist locks every value and type below. All entries are ESM-only.

## `oh-my-knowledge`

The recommended ordinary-user entry. It exposes exactly the same canonical Runtime façade as `oh-my-knowledge/eval-runtime`: `evaluate`, `prepareEvaluation`, `checkExecutor`, their stable errors, and their public model types. Core engines, builders, registrations, and adapters are intentionally absent.

## `oh-my-knowledge/eval-runtime`

The canonical API for application developers:

| Export | Purpose |
|---|---|
| `evaluate` | Run one explicit solo, paired, or independent-group evaluation design, including multi-arm and multi-metric comparisons. |
| `prepareEvaluation` | Seal and inspect the exact Definition, Policy, Plan, Runtime resolutions, digest, and work estimate before any Target or Evaluator call. |
| `checkExecutor` | Certify an Executor through success, failure, cancellation, cleanup, and measurement checks. |
| `EvaluationConfigurationError` | Stable caller-configuration failure with a public code and no rejected payload. |
| `EvaluationEventConsumptionError` | Stable, redacted observer／event-stream failure that retains the terminal `EvaluationResult` when available. |

Public model types are `Artifact`, `ArtifactKind`, `ArtifactSource`, `Variant`, `VariantExecution`, `RuntimeContext`, `AllowedToolsInput`, `AllowedToolsPlan`, `WorkspaceDescriptor`, `WorkspaceInput`, `WorkspacePlan`, `WorkspaceProvider`, `WorkspaceOpenRequest`, `WorkspaceLease`, `WorkspaceAccess`, `Dataset`, `Sample`, `EvaluationExecutor`, `Executor`, `InvokeExecutor`, `SessionExecutor`, `ExecutorSessionContext`, `ExecutorSessionAttempt`, `ExecutorSession`, `ExecutorCapabilities`, `ExecutorInvocation`, `ExecutorResult`, `Evaluator`, `ExactMatchEvaluator`, `RetrievalEvaluator`, `RetrievalMetricIds`, `ToolTrajectoryEvaluator`, `ToolTrajectoryMatchMode`, `RubricJudgeEvaluator`, `RubricJudgeMember`, `RubricJudgeAggregation`, `CustomEvaluator`, `CustomEvaluatorInvocation`, `CustomEvaluatorResult`, `CustomEvaluatorBinding`, `CustomEvaluatorContent`, `Metric`, `Judge`, `Rubric`, `Experiment`, `SamplingDesign`, `AnalysisRequest`, `CohortFilter`, `Comparison`, `ComparisonFamilyMember`, `CompositeMetricComponent`, `CompositeAggregation`, `Decision`, `FamilyDecisionCriterion`, `Policy`, `StagePolicy`, `RetryPolicy`, `RetryBackoff`, `FailurePolicy`, `BudgetPolicy`, `BudgetScope`, `RunBudgetScope`, `AttemptBudgetScope`, `ProviderCostLimit`, `EvaluateInput`, `EvaluationRunOptions`, `EvaluationResult`, `PreparedEvaluation`, `PreparedEvaluationPlan`, `RuntimeCapabilityResolution`, `EvaluationWorkEstimate`, `EventObserver`, and `Clock`. Executor certification uses `ExecutorCheckInput`, `ExecutorCheckResult`, and `RuntimeConformanceCheck`.

`Policy` uses independent `execution` and `evaluation` `StagePolicy` values. Each stage seals its own concurrency, timeout, and optional `RetryPolicy`; retry error codes are host-defined stable identifiers, and `RetryBackoff` is an explicit `none`, `fixed`, or `exponential` union. `FailurePolicy` is also discriminated: only `failure-threshold` carries `maxFailures`. `BudgetPolicy` exposes run, stage, coordinate, and attempt scopes with auditable invocation, active-duration, wall-clock, and provider-cost limits. Provider-cost admission is deliberately fixed to bounded overshoot; `onUnreportedProviderCost` selects fail-closed or unverifiable handling. The façade only materializes these declarations into the Core Measurement Policy; all scheduling, timeout, retry, cancellation, budget accounting, and failure-threshold behavior remains in Core.

`RuntimeContext` contains only reproducible host-defined JSON `values`. A Variant selects a logical workspace with a content-addressed `WorkspaceDescriptor`, or a `WorkspacePlan` containing one `default` plus `bySampleId` overrides; `null` explicitly disables the default for that sample. The Executor owns the corresponding `WorkspaceProvider`. Its stable `providerId`, `version`, and optional measurement-relevant `fingerprintFacets` participate in Runtime identity, while credentials, CAS locators, caches, and base directories remain inside the provider closure. Both canonical and advanced JSON adapters bind that provider identity into the final Executor fingerprint. `prepareEvaluation()` seals descriptors without opening a lease. At execution time the provider must verify the requested immutable descriptor and return a fresh `WorkspaceLease` with an absolute, trial-private `root`. The same `WorkspaceAccess` is reused across retry attempts for that trial, then the Runtime calls `close()` after success, failure, timeout, or cancellation. OMK itself never adds the physical root or provider-private state to a Definition, result, or error; an Executor must likewise avoid returning locators in its own output or trace. Invoke and session Executors receive only `{ descriptor, root }`; they cannot close another component's lease. Reusing a lease object across trials or an active physical root fails closed, and a root whose cleanup fails remains quarantined in that process. `open()` and `close()` must be bounded local resource work. A lease provides measurement isolation, not a security sandbox; containing untrusted code remains the host's responsibility.

A Variant may also set `execution.allowedTools` to one exact list or an `AllowedToolsPlan` with `default` and `bySampleId`. OMK sorts the list for identity but never unions lists across samples. `[]` denies every tool; a `null` sample override explicitly restores the Executor runtime default. The Executor must declare `capabilities.toolPolicy: 'allow-list'` and strictly apply the `allowedTools` received by `execute()` or `openSession()`. Undefined means runtime default. OMK fails before execution if the capability is absent, but the capability is self-reported: do not declare it when the backend cannot enforce the exact list. Neither tool names nor workspace controls enter Gold or evaluation-only context. `checkExecutor()` currently rejects workspace- or tool-policy-enabled declarations because its generic probes cannot prove their isolation or enforcement; run a real Evaluation until dedicated conformance probes are available.

```ts
const executor: Executor<string, undefined, string> = {
  executorId: 'acme.agent/v1',
  version: '1.0.0',
  schemas: { input: z.string(), output: z.string() },
  workspaceProvider: {
    providerId: 'acme.cas-workspace/v1',
    version: '1.0.0',
    async open({ descriptor, runId, trialId }) {
      const root = await materializeFreshOverlay(descriptor, { runId, trialId });
      return { root, close: () => removeOverlay(root) };
    },
  },
  async execute({ input, workspace, signal }) {
    return { output: await runAgent(input, { cwd: workspace?.root, signal }) };
  },
};

const variant: Variant<string, undefined, string> = {
  variantId: 'workspace-agent-v1',
  artifact: { name: 'workspace-agent-v1', kind: 'agent', source: 'inline', content: '...' },
  execution: { executor, workspace: workspaceDescriptor },
};
```

`Sample.executionContext` is per-sample input visible to the Executor; `Sample.evaluationContext` is per-sample input visible only to the Evaluator. These sample projections do not describe the host environment.

`EvaluationExecutor` is the union accepted by a Variant. `Executor` and its explicit alias `InvokeExecutor` run one stateless `omk.invoke/v1` callback; omitting `protocol` means invoke. `SessionExecutor` requires `protocol: 'session'` and opens one isolated, newly allocated `ExecutorSession` object for each Core trial; object reuse across trials or Runs is rejected. `ExecutorSessionContext` exposes the Target projection plus stable `runId` and `trialId`, but never Gold or evaluation-only context. Retries call the same session's `execute()` with a fresh `ExecutorSessionAttempt`, including `attemptId`, `attemptNumber`, and the Core `AbortSignal`. Coordinate-derived `attemptId` values may recur in a separate Run, so provider idempotency keys must also be namespaced by `runId` or an equivalent provider-session scope. Success, failure, timeout, and cancellation all end with exactly one `close()`. `openSession()` and `close()` must be bounded local lifecycle work; opening is resource acquisition rather than a measured provider attempt, so billable or model work belongs in `execute()`. A session is temporary and run-scoped; it is not a cross-Run conversation or memory store.

`EvaluationResult` preserves every field of the Core `EvaluationRunResult` and adds the effective `runId`, `definition`, `policy`, and `analysisResults`. The last field is a read-only `analysisId` index over the exact Core Analysis records, not a second analysis implementation. Execution and evaluation evidence remain under `artifacts`, the decision remains under `artifacts.decision`, and the public report remains under `report`.

`EvaluateInput` contains only the measurement declaration. `EvaluationRunOptions` contains run-scoped `runId`, cancellation, progress observation, report annotations／summaries, event-buffer capacity, and clock. Omitting `runId` generates one and returns it as `EvaluationResult.runId`. `prepareEvaluation(input)` captures all mutable declarations, materializes defaults, resolves Runtime capabilities, and seals the Core Plan without calling a Target or Evaluator. Its frozen `PreparedEvaluation` exposes the exact `definition`, `policy`, `plan`, complete-contract `planDigest`, `resolvedRuntimes`, and `estimatedWork`; `run(options)` executes that same sealed Plan without re-reading the input or recompiling. Planned coordinates exclude retries and early termination, while duration and provider cost remain explicitly uncertain until execution.

`SamplingDesign` supports a one-Variant `solo` quality profile, complete-block `paired` comparisons, and fixed-quota `independent` comparisons. It is the only owner of paired／independent semantics. A solo design may declare `clusterKey`; Core then treats whole clusters as the experimental and resampling unit. A `Comparison` declares one control, one or more treatments, and the Metrics to analyze; it contains no duplicate sampling discriminator. `evaluators` may contain multiple exact-match, retrieval, tool-trajectory, Rubric Judge, or custom evaluators, provided evaluator and metric IDs are unique.

`RetrievalEvaluator` is the source-neutral binary-relevance top-k preset. It reads a unique ordered document-ID array from an explicit output or trace JSON Pointer and a non-empty set of unique relevant IDs from `Sample.expected`. Its four `RetrievalMetricIds` are bounded, higher-is-better sample Metrics: Recall@k uses all known relevant documents as its denominator, Precision@k always uses `k` (missing result slots are non-hits), Reciprocal Rank@k uses the first relevant rank, and nDCG@k uses binary gain with log2 discount. The ranking is truncated before measurement. Duplicate or malformed IDs and empty relevance sets produce invalid evidence; they are never deduplicated, clamped, or converted to `NaN`. A summary `mean` over the Reciprocal Rank Metric is MRR. Cutoff, pointers, Metric IDs, and algorithm identity are sealed into the Definition and Runtime fingerprint.

`ToolTrajectoryEvaluator` deterministically compares `ToolCallInfo.tool` names from one complete `omk.source-neutral-trace/v2` against tool names projected only from `Sample.expected`. Its explicit `ToolTrajectoryMatchMode` is `exact-order`, `same-tools`, `contains-in-order`, or `contains-any-order`; the names describe the actual-to-expected relationship without ambiguous subset／superset orientation. Matching is case-sensitive and preserves repeated-call multiplicity. Every call status participates because this Metric measures the agent's call decisions, not whether tools succeeded. Empty actual trajectories are valid. Empty expected trajectories are valid only for exact modes, where they assert that no tool should be called; contains modes reject the vacuous condition. Invalid trace／Gold becomes invalid evidence, while an unresolved pointer remains Core `not-evaluated` evidence. The boolean observation never copies the sensitive trajectory.

A `RubricJudgeEvaluator` is an explicit judge panel. `judges` contains one or more `RubricJudgeMember` values; `replicateCount` repeats only that member's measurement and never reruns the Target. One panel may expand to at most 1,000 member × replicate coordinates. `RubricJudgeAggregation` must select equal-member `mean` or a `weighted-mean` whose positive weights cover every member and sum to one. The only supported missing rule is `require-complete`: one unavailable planned member or replicate removes that Target × Sample × Trial panel reading from analysis rather than averaging the survivors. Raw member and replicate records remain in the Evaluation Bundle.

A `CustomEvaluator` is the canonical one-Metric callback extension. It declares explicit input `bindings`, serializable `parameters`, a sample-scope `Metric`, schema parsers, and measurement-relevant identity facets. The callback receives only the values selected by its bindings; it cannot inspect the full sample or execution record. It returns one `score`, `missing`, `invalid`, or stable `failed` result. Core remains the only owner of concurrency, timeout, budget, cancellation, evidence capture, and failure redaction. The callback contract is stateless, parallel-safe, and cancellation-cooperative; stateful lifecycle integrations use `/advanced`. One evaluator cannot emit multiple Metrics or claim ensemble coordinates.

Numeric and boolean custom Metrics require an explicit `higher-is-better` or `lower-is-better` direction. Categorical, text, and ranking Metrics cannot declare a scale or direction. The canonical `progress/v2` Decision currently accepts only `higher-is-better`, because silently applying its positive-effect rule to a lower-is-better scale would reverse the verdict.

`implementation.version`, schema `fingerprintFacets`, and implementation `fingerprintFacets` are mandatory identity declarations. OMK never fingerprints `Function#toString()`. Callers must change one of these facets whenever callback code, dependencies, schemas, or provider configuration changes measurement behavior. Binding and value schemas validate without coercion, defaults, or field removal. `CustomEvaluatorContent` carries an explicit classification for evidence or invalid values; undeclared source values are never passed to the callback.

`independent` requires an explicit allocation for every Variant plus global and per-stratum minimum sample counts. The seed, optional `stratumKey`, weights, and minima are sealed before any Executor call. Core assigns each sample to exactly one Variant, reuses that assignment across repeated trials, and fails before execution if any minimum cannot be met. It analyzes each comparison with the unpaired percentile-bootstrap estimator; it never relabels independent data as paired.

Analysis is always explicit and preregistered. Top-level `analyses[]` accepts named `summary`, `quality-interval`, `comparison-interval`, `comparison-family`, `composite-quality-interval`, and `composite-comparison-interval` requests. Summaries expose numeric `mean`, boolean `rate`, and numeric `quantile`; individual intervals use an explicit confidence level and resample count. A comparison family declares at least two globally named contrasts plus one family-wise confidence level. Its `bonferroni-percentile-bootstrap` method seals every member at marginal confidence `1 - (1 - family level) / family size`, then produces one Core-verified simultaneous-family table; the family level is a nominal target whose coverage depends on the marginal Bootstrap intervals having their stated coverage. It never fabricates p-values or selects family members after observing results. Each request may apply one sealed Dataset cohort filter. Rubric panels aggregate replicates within members, members by the declared rule, and repeated Target trials within a sample before bootstrap. Paired and independent members retain their respective resampling units. Metric direction is never used to silently flip a signed result. An analysis `decision` selects one interval. A `comparison-family` decision selects the outer family and supplies one raw-effect `FamilyDecisionCriterion` per member; its explicit `all` rule releases only when every simultaneous interval satisfies its inclusive bounds, blocks a proven violation, and otherwise stays not-decided. An empty analysis list intentionally retains typed evaluation evidence without fabricating statistics or a composite verdict.

A composite request names its derived `[0, 1]` higher-is-better Metric with `compositeMetricId`, then declares at least two `CompositeMetricComponent` values and one explicit `CompositeAggregation`. Components must have unique source Metric IDs, positive weights that sum exactly to one, and the only v1 aggregation is `{ method: 'weighted-mean', missing: 'require-complete' }`. Boolean Metrics and bounded numeric Metrics with a monotonic direction are supported; the request cannot override their sealed scale or direction. Runtime materializes the derived Metric and, for a composite comparison, adds it to the selected Core Comparison. Core remains the sole owner of normalization, panel aggregation, unit-first composition, missing-component exclusion, resampling, coverage, and source-row lineage.

```ts
const analysis: AnalysisRequest = {
  analysisId: 'overall-quality',
  analysisKind: 'composite-quality-interval',
  compositeMetricId: 'overall-quality',
  variantId: 'prompt-v2',
  components: [
    { metricId: 'correct', weight: 0.6 },
    { metricId: 'rubric-quality', weight: 0.4 },
  ],
  aggregation: { method: 'weighted-mean', missing: 'require-complete' },
  confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 1_000 },
};
```

The entry deliberately exposes no Definition builder, Runtime registry, Core Target, lifecycle adapter, or raw Rubric factory. `Artifact` is what is evaluated, `Variant` binds it to an Executor, config, and runtime context, and control／treatment roles exist only inside an explicit `Comparison`.

## `oh-my-knowledge/eval-runtime/advanced`

Low-level host assembly and extension SPI. Applications should prefer `evaluate()`.

| Export | Purpose |
|---|---|
| `runEvaluation` | Run an already assembled Core Definition, Runtime, and Policy. |
| `EvaluationEventConsumptionError` | Event-consumption failure for `runEvaluation`. |
| `createEvaluationRuntime` | Assemble Executor／Evaluator registrations and Core built-ins. |
| `EvaluationRuntimeAssemblyError` | Stable registration or resolution failure. |
| `createExactMatchDefinition` | Build an exact-match paired Core Definition. |
| `createPairedComparisonDefinition` | Build a one-metric paired Core Definition. |
| `createMeasurementPolicy` | Materialize Core Policy defaults, including explicit EventWriter delivery mode. |
| `createExactMatchEvaluator` | Create the built-in exact-match Evaluator port. |
| `createInvokeExecutorIdentity` | Declare an `omk.invoke/v1` Executor identity. |
| `createSessionExecutorIdentity` | Declare an isolated `omk.session/v1` Executor identity. |
| `createRuntimeIdentity` | Declare another host Runtime identity. |
| `createJsonExecutorAdapter` | Adapt a typed JSON callback to a Core Executor. |
| `createJsonSessionExecutorAdapter` | Adapt a typed, per-trial JSON session lifecycle to a Core Executor. |
| `createRubricJudgeKit` | Derive matching Rubric Definition, Metric, context, and registration fragments. |
| `createRubricJudgeEvaluationContext` | Combine criterion context for multiple Rubric kits. |
| `createRubricJudgeRegistration` | Combine multiple Rubric kit bindings. |
| `runExecutorConformance` | Run the low-level Executor conformance probe. |
| `assertExecutorConformance` | Throw when a conformance result failed. |
| `RuntimeConformanceError` | Stable conformance assertion error. |
| `createNodeEvaluationClock` | Supply the default Node.js Core clock. |
| `EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID` | Built-in exact-match implementation ID. |
| `createExactMatchEvaluatorIdentity` | Inspect the exact-match Runtime identity. |
| `INVOKE_JSON_INPUT_SCHEMA` | Default JSON input schema identity. |
| `INVOKE_JSON_OUTPUT_SCHEMA` | Default JSON output schema identity. |
| `INVOKE_JSON_TRACE_SCHEMA` | Default JSON trace schema identity. |
| `SESSION_JSON_INPUT_SCHEMA` | Default session JSON input schema identity. |
| `SESSION_JSON_OUTPUT_SCHEMA` | Default session JSON output schema identity. |
| `SESSION_JSON_TRACE_SCHEMA` | Default session JSON trace schema identity. |
| `createExecutorFnAdapter` | Bridge the legacy `ExecutorFn`. |
| `createSameProcessExecutorAdapter` | Implement explicit in-process Executor lifecycle SPI. |
| `createSameProcessEvaluatorAdapter` | Implement explicit in-process Evaluator lifecycle SPI. |
| `createRubricJudgeCriterion` | Construct a raw Rubric criterion. |
| `createRubricJudgeInstrument` | Construct a raw frozen Rubric instrument. |
| `createRubricJudgeRuntimeConfig` | Construct raw Judge Runtime config. |
| `createRubricJudgeEvaluatorDefinition` | Construct a raw Rubric Evaluator Definition. |
| `createRubricJudgeMetricDefinition` | Construct the raw 1–5 Metric. |
| `createRubricJudgeEvaluatorIdentity` | Derive the raw Rubric Evaluator identity. |
| `createRubricJudgeEvaluator` | Construct one raw Rubric Evaluator port. |
| `createRubricJudgeEvaluatorRegistration` | Combine raw Rubric bindings. |
| `rubricJudgeInstrumentId` | Derive the built-in instrument ID. |

Run and assembly types are `RunEvaluationInput`, `EvaluationEventObserver`, `CreateEvaluationRuntimeInput`, `EvaluationRuntimeSupportPorts`, and `RuntimePortRegistration`. Builder types are `ExactMatchDefinitionBuilderInput`, `ExactMatchTarget`, `PairedComparisonDefinitionBuilderInput`, `EvaluationRuntimeTarget`, `MeasurementPolicyBuilderInput`, `MeasurementStagePolicyInput`, `MeasurementRetryPolicyInput`, `MeasurementRetryBackoffInput`, `MeasurementFailurePolicyInput`, `MeasurementEventDeliveryInput`, and `CreateExactMatchEvaluatorInput`. Identity and JSON adapter types are `InvokeExecutorIdentityDeclaration`, `SessionExecutorIdentityDeclaration`, `RuntimeIdentityDeclaration`, `CreateJsonExecutorAdapterInput`, `CreateJsonSessionExecutorAdapterInput`, `JsonExecutorInvocation`, `JsonExecutorInvocationResult`, `JsonSessionExecutorContext`, `JsonSessionExecutorAttempt`, `JsonExecutorSession`, `RuntimeValueParser`, `AllowedToolsInput`, `AllowedToolsPlan`, `WorkspaceDescriptor`, `WorkspaceInput`, `WorkspacePlan`, `WorkspaceProvider`, `WorkspaceOpenRequest`, `WorkspaceLease`, and `WorkspaceAccess`. Judge types are `OmkLlmJudgeEffort`, `OmkLlmJudgeInvocationPort`, `OmkLlmJudgeInvocationRequest`, `OmkLlmJudgeInvocationResult`, `CreateRubricJudgeKitInput`, `RubricJudgeKit`, `CreateRubricJudgeEvaluatorInput`, `RubricJudgeEvaluatorBinding`, and `RubricJudgeEvaluatorDefinitionBuilderInput`. Conformance types are `ExecutorConformanceProbeInput`, `ExecutorConformanceResult`, and `RuntimeConformanceCheck`. Legacy and lifecycle SPI types are `CreateExecutorFnAdapterInput`, `ExecutorFn`, `ExecutorInput`, `ExecResult`, `ExecutorFnInputMapper`, `ExecutorFnResultMapper`, `CreateSameProcessExecutorAdapterInput`, `CreateSameProcessEvaluatorAdapterInput`, `SameProcessExecutorImplementation`, `SameProcessEvaluatorImplementation`, `SameProcessResourceLeaseAccess`, `SameProcessRunScope`, and `SameProcessOperationScope`.

Advanced budget-builder types are `MeasurementBudgetPolicyInput`, `MeasurementBudgetScopeInput`, `MeasurementRunBudgetScopeInput`, `MeasurementAttemptBudgetScopeInput`, and `MeasurementProviderCostLimitInput`.

## `oh-my-knowledge/eval-runtime/contracts`

Versioned wire contracts for adapter and trace authors:

- Rubric identities and schemas: `RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID`, `RUBRIC_JUDGE_BINDINGS`, `RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION`, `RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION`, `RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION`, `RUBRIC_JUDGE_INSTRUMENT_SCHEMA`, `RUBRIC_JUDGE_CONTEXT_SCHEMA`, and `RUBRIC_JUDGE_EVIDENCE_SCHEMA`.
- Rubric types: `RubricJudgeInstrument`, `RubricJudgeRuntimeConfig`, `RubricJudgeConfig`, `RubricJudgeCriterion`, and `RubricJudgeTracePolicy`.
- Trace values: `SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION`, `SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR`, `SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR`, `SourceNeutralTraceSchema`, `SourceNeutralTraceWithoutMocksSchema`, `SourceNeutralMockStatsSchema`, `parseSourceNeutralTrace`, and `attachSourceNeutralMockStats`.
- Trace types: `SourceNeutralTrace` and `SourceNeutralMockStats`.

## Migration

The `1.0.0-beta` canonical entry replaces the previous assembly-first surface. The general façade also replaces the earlier fixed `{ executor, control, treatment, evaluator }` input with `{ variants, evaluators, comparisons, analyses }`; Executor and config now live under each Variant's `execution`, Sampling Design alone selects paired or independent semantics, and every summary or interval is an explicit named `analyses[]` request. Remove `comparisonKind` and replace the redundant `analysis: { analyses: [...] }` wrapper with `analyses: [...]`; neither old shape is read or detected. Move `runId`, `signal`, `onEvent`, `clock`, `annotations`, `summaries`, and `eventBufferCapacity` from the declaration into the optional second `EvaluationRunOptions` argument; omitted `runId` is generated. A Decision optionally selects one interval or one explicitly bounded comparison family by `analysisId`. Rubric evaluation requires `judges + aggregation`; the singular `judge + model + effort` shape is not accepted. Policy fields are grouped under `execution`, `evaluation`, `failure`, `budget`, and `evidence`; the earlier flat concurrency, timeout, invocation, failure, and classification fields are not accepted. There is no 0.x compatibility reader, old overload, or legacy-shape detector. Move low-level imports from `oh-my-knowledge/eval-runtime` to `oh-my-knowledge/eval-runtime/advanced`; wire schemas remain at `/contracts`. `createEvaluationEngine` has one meaning and one home: import the full staged engine from `oh-my-knowledge/eval-core`; use advanced `runEvaluation` when a preassembled Runtime, Definition, and Policy only need a standard complete run. New hosts should import `evaluate`, `prepareEvaluation`, or `checkExecutor` from the package root. The `/eval-runtime` entry remains the explicit equivalent for consumers that prefer domain-qualified imports.

Budget limits now live under explicit scopes: replace `budget.maxInvocations` with `budget.run.maxInvocations`. The old form is neither read nor detected.

Use `oh-my-knowledge/eval-core` for custom analysis graphs, persisted artifact admission, staged replay, or explicit cross-run comparability. Deep implementation imports are unsupported.
