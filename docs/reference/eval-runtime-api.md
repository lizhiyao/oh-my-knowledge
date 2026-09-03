# eval-runtime API layers

`package.json#exports` is the only supported boundary. The allowlist test locks every value and type below, so adding, moving, or removing an export requires an explicit API review. All three entries are ESM-only and beta-stable until `1.0.0`.

## `oh-my-knowledge/eval-runtime`

Layer: everyday host API. Audience: Node.js／FaaS application developers. Stability: supported beta API; breaking changes require a migration note.

| Export | Purpose |
|---|---|
| `runEvaluation` | Run an ordinary Core Definition and Policy while safely draining progress events. |
| `EvaluationEventConsumptionError` | Report observer or event-consumer failure while retaining the terminal Core result. |
| `createEvaluationEngine` | Inspect a sealed plan or use explicit run stages without importing implementation paths. |
| `createEvaluationRuntime` | Assemble explicit Executor／Evaluator registrations with Core built-ins. |
| `EvaluationRuntimeAssemblyError` | Stable runtime-registration configuration failure. |
| `createExactMatchDefinition` | Build the canonical exact-match paired comparison. |
| `createPairedComparisonDefinition` | Build a single-metric custom Evaluator paired comparison. |
| `createMeasurementPolicy` | Materialize explicit Core policy defaults. |
| `createExactMatchEvaluator` | Register the built-in exact-match Evaluator. |
| `createInvokeExecutorIdentity` | Declare and seal an `omk.invoke/v1` Executor identity. |
| `createRuntimeIdentity` | Declare a non-Executor host identity, including an LLM gateway. |
| `createJsonExecutorAdapter` | Bind a typed, runtime-validated JSON callback to the Core Executor port. |
| `createRubricJudgeKit` | Derive matching Rubric instrument, Definition fragments, Metric and registration. |
| `createRubricJudgeEvaluationContext` | Build the exact criterion context shape for one or more kits. |
| `createRubricJudgeRegistration` | Combine multiple Rubric kits into one implementation registration. |
| `runExecutorConformance` | Probe success, failure, cancellation, telemetry, isolation and cleanup. |
| `assertExecutorConformance` | Turn failed conformance checks into a stable exception. |
| `RuntimeConformanceError` | Stable conformance assertion error and failed check IDs. |

Type exports: `RunEvaluationInput` and `EvaluationEventObserver` describe the high-level run; `CreateEvaluationRuntimeInput` describes assembly; `ExactMatchDefinitionBuilderInput`, `ExactMatchTarget`, `PairedComparisonDefinitionBuilderInput`, `EvaluationRuntimeTarget`, `MeasurementPolicyBuilderInput`, and `CreateExactMatchEvaluatorInput` describe builders; `InvokeExecutorIdentityDeclaration` and `RuntimeIdentityDeclaration` describe identity declarations; `CreateJsonExecutorAdapterInput`, `JsonExecutorInvocation`, `JsonExecutorInvocationResult`, and `RuntimeValueParser` describe the JSON boundary; `OmkLlmJudgeEffort`, `OmkLlmJudgeInvocationPort`, `OmkLlmJudgeInvocationRequest`, and `OmkLlmJudgeInvocationResult` describe the host-owned Judge call; `CreateRubricJudgeKitInput` and `RubricJudgeKit` describe the composite Judge API; `ExecutorConformanceProbeInput`, `ExecutorConformanceResult`, and `RuntimeConformanceCheck` describe conformance evidence. These types have the same audience, layer, and stability as the value that consumes or returns them.

## `oh-my-knowledge/eval-runtime/advanced`

Layer: host extension SPI. Audience: framework and adapter authors. Stability: reviewed beta SPI; most applications should not need it.

| Export | Purpose |
|---|---|
| `createNodeEvaluationClock` | Supply the default Node.js Core clock explicitly. |
| `EXACT_MATCH_EVALUATOR_IMPLEMENTATION_ID` | Refer to the built-in exact-match implementation identity. |
| `createExactMatchEvaluatorIdentity` | Inspect the exact-match Runtime identity without creating a port. |
| `INVOKE_JSON_INPUT_SCHEMA` | Default JSON input schema identity for `omk.invoke/v1`. |
| `INVOKE_JSON_OUTPUT_SCHEMA` | Default JSON output schema identity for `omk.invoke/v1`. |
| `INVOKE_JSON_TRACE_SCHEMA` | Default JSON trace schema identity for `omk.invoke/v1`. |
| `createExecutorFnAdapter` | Bridge OMK's legacy `ExecutorFn`; not a canonical new-host API. |
| `createSameProcessExecutorAdapter` | Implement explicit run／trial lifecycle SPI in process. |
| `createSameProcessEvaluatorAdapter` | Implement explicit run／record lifecycle SPI in process. |
| `createRubricJudgeCriterion` | Construct a criterion independently of a kit. |
| `createRubricJudgeInstrument` | Construct the frozen built-in Rubric instrument independently. |
| `createRubricJudgeRuntimeConfig` | Construct raw Rubric provider runtime config. |
| `createRubricJudgeEvaluatorDefinition` | Construct a raw Rubric Evaluator Definition fragment. |
| `createRubricJudgeMetricDefinition` | Construct the raw 1–5 Rubric Metric fragment. |
| `createRubricJudgeEvaluatorIdentity` | Derive the raw Rubric Evaluator Runtime identity. |
| `createRubricJudgeEvaluator` | Construct one raw Rubric Evaluator port. |
| `createRubricJudgeEvaluatorRegistration` | Combine raw Rubric bindings into a registration. |
| `rubricJudgeInstrumentId` | Derive the instrument ID used by the built-in contract. |

Type exports: `EvaluationRuntimeSupportPorts` and `RuntimePortRegistration` describe host assembly SPI; `CreateExecutorFnAdapterInput`, `ExecutorFn`, `ExecutorInput`, `ExecResult`, `ExecutorFnInputMapper`, and `ExecutorFnResultMapper` describe the legacy bridge; `CreateSameProcessExecutorAdapterInput`, `CreateSameProcessEvaluatorAdapterInput`, `SameProcessExecutorImplementation`, `SameProcessEvaluatorImplementation`, `SameProcessResourceLeaseAccess`, `SameProcessRunScope`, and `SameProcessOperationScope` describe lifecycle SPI; `CreateRubricJudgeEvaluatorInput`, `RubricJudgeEvaluatorBinding`, and `RubricJudgeEvaluatorDefinitionBuilderInput` describe manual Rubric assembly. These types inherit the advanced layer's audience and stability.

## `oh-my-knowledge/eval-runtime/contracts`

Layer: runtime protocol and schema contracts. Audience: adapter authors, trace producers and persistence／validation integrations. Stability: versioned contract; semantic changes require a new schema identity.

| Export | Purpose |
|---|---|
| `RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID` | Versioned built-in Rubric implementation ID. |
| `RUBRIC_JUDGE_BINDINGS` | Canonical actual／criterion／trace binding IDs. |
| `RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION` | Rubric instrument wire version. |
| `RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION` | Criterion context wire version. |
| `RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION` | Judge evidence wire version. |
| `RUBRIC_JUDGE_INSTRUMENT_SCHEMA` | Rubric instrument schema identity descriptor. |
| `RUBRIC_JUDGE_CONTEXT_SCHEMA` | Criterion context schema identity descriptor. |
| `RUBRIC_JUDGE_EVIDENCE_SCHEMA` | Judge evidence schema identity descriptor. |
| `SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION` | Full source-neutral trace wire version. |
| `SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR` | Full trace schema identity descriptor. |
| `SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR` | Trace-without-mocks schema identity descriptor. |
| `SourceNeutralTraceSchema` | Validate a full source-neutral trace at runtime. |
| `SourceNeutralTraceWithoutMocksSchema` | Validate the no-mocks trace variant. |
| `SourceNeutralMockStatsSchema` | Validate source-neutral mock statistics. |
| `parseSourceNeutralTrace` | Parse provider-neutral trace JSON with the selected mock mode. |
| `attachSourceNeutralMockStats` | Add validated mock statistics without changing provider facts. |

Type exports: `RubricJudgeInstrument`, `RubricJudgeRuntimeConfig`, `RubricJudgeConfig`, `RubricJudgeCriterion`, and `RubricJudgeTracePolicy` describe Rubric wire values; `SourceNeutralTrace` and `SourceNeutralMockStats` describe trace wire values. They are versioned contracts with the same audience and stability as this entry.

## Leaving the convenience layer

Use `oh-my-knowledge/eval-core` for multi-metric graphs, lower-is-better or target-is-best metrics, custom Analysis Runtime implementations, persisted artifact admission, staged replay, or explicit cross-run comparability. `eval-runtime` never defines a second Definition, Policy, Report, retry, timeout, budget, cache, statistical, or Decision contract.
