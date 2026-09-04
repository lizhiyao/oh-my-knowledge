# eval-runtime API layers

`package.json#exports` is the supported boundary. The API allowlist locks every value and type below. All entries are ESM-only.

## `oh-my-knowledge`

The recommended ordinary-user entry. It exposes exactly the same canonical Runtime façade as `oh-my-knowledge/eval-runtime`: `evaluate`, `checkExecutor`, their stable errors, and their public model types. Core engines, builders, registrations, and adapters are intentionally absent.

## `oh-my-knowledge/eval-runtime`

The canonical API for application developers:

| Export | Purpose |
|---|---|
| `evaluate` | Evaluate one control and one treatment with a host-owned Executor. |
| `checkExecutor` | Certify an Executor through success, failure, cancellation, cleanup, and measurement checks. |
| `EvaluationConfigurationError` | Stable caller-configuration failure with a public code and no rejected payload. |
| `EvaluationEventConsumptionError` | Stable, redacted observer／event-stream failure that retains the terminal `EvaluationResult` when available. |

Public model types are `Artifact`, `ArtifactKind`, `ArtifactSource`, `Variant`, `RuntimeContext`, `Dataset`, `Sample`, `Executor`, `ExecutorCapabilities`, `ExecutorInvocation`, `ExecutorResult`, `Evaluator`, `ExactMatchEvaluator`, `RubricJudgeEvaluator`, `Judge`, `Rubric`, `Experiment`, `Policy`, `EvaluateInput`, `EvaluationResult`, `EventObserver`, `EventWriter`, and `Clock`. Executor certification uses `ExecutorCheckInput`, `ExecutorCheckResult`, and `RuntimeConformanceCheck`.

`RuntimeContext` describes the environment bound to a variant, currently including `cwd` and host-defined values. `Sample.executionContext` is per-sample input visible to the Executor; `Sample.evaluationContext` is per-sample input visible only to the Evaluator. These sample projections do not describe the host environment.

`EvaluationResult` preserves every field of the Core `EvaluationRunResult` and adds `definition` plus `policy`, the exact sealed Core Definition and fully materialized Measurement Policy compiled by the façade. Execution and evaluation evidence remain under `artifacts`, the decision remains under `artifacts.decision`, and the public report remains under `report`.

The entry deliberately exposes no Definition builder, Runtime registry, Core Target, lifecycle adapter, or raw Rubric factory. `Artifact` is what is evaluated, `Variant` binds it to runtime context, and `control`／`treatment` are experiment roles.

## `oh-my-knowledge/eval-runtime/advanced`

Low-level host assembly and extension SPI. Applications should prefer `evaluate()`.

| Export | Purpose |
|---|---|
| `createEvaluationEngine` | Inspect a sealed plan or drive explicit stages. |
| `runEvaluation` | Run an already assembled Core Definition, Runtime, and Policy. |
| `EvaluationEventConsumptionError` | Event-consumption failure for `runEvaluation`. |
| `createEvaluationRuntime` | Assemble Executor／Evaluator registrations and Core built-ins. |
| `EvaluationRuntimeAssemblyError` | Stable registration or resolution failure. |
| `createExactMatchDefinition` | Build an exact-match paired Core Definition. |
| `createPairedComparisonDefinition` | Build a one-metric paired Core Definition. |
| `createMeasurementPolicy` | Materialize Core Policy defaults. |
| `createExactMatchEvaluator` | Create the built-in exact-match Evaluator port. |
| `createInvokeExecutorIdentity` | Declare an `omk.invoke/v1` Executor identity. |
| `createRuntimeIdentity` | Declare another host Runtime identity. |
| `createJsonExecutorAdapter` | Adapt a typed JSON callback to a Core Executor. |
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

Run and assembly types are `RunEvaluationInput`, `EvaluationEventObserver`, `CreateEvaluationRuntimeInput`, `EvaluationRuntimeSupportPorts`, and `RuntimePortRegistration`. Builder types are `ExactMatchDefinitionBuilderInput`, `ExactMatchTarget`, `PairedComparisonDefinitionBuilderInput`, `EvaluationRuntimeTarget`, `MeasurementPolicyBuilderInput`, and `CreateExactMatchEvaluatorInput`. Identity and JSON adapter types are `InvokeExecutorIdentityDeclaration`, `RuntimeIdentityDeclaration`, `CreateJsonExecutorAdapterInput`, `JsonExecutorInvocation`, `JsonExecutorInvocationResult`, and `RuntimeValueParser`. Judge types are `OmkLlmJudgeEffort`, `OmkLlmJudgeInvocationPort`, `OmkLlmJudgeInvocationRequest`, `OmkLlmJudgeInvocationResult`, `CreateRubricJudgeKitInput`, `RubricJudgeKit`, `CreateRubricJudgeEvaluatorInput`, `RubricJudgeEvaluatorBinding`, and `RubricJudgeEvaluatorDefinitionBuilderInput`. Conformance types are `ExecutorConformanceProbeInput`, `ExecutorConformanceResult`, and `RuntimeConformanceCheck`. Legacy and lifecycle SPI types are `CreateExecutorFnAdapterInput`, `ExecutorFn`, `ExecutorInput`, `ExecResult`, `ExecutorFnInputMapper`, `ExecutorFnResultMapper`, `CreateSameProcessExecutorAdapterInput`, `CreateSameProcessEvaluatorAdapterInput`, `SameProcessExecutorImplementation`, `SameProcessEvaluatorImplementation`, `SameProcessResourceLeaseAccess`, `SameProcessRunScope`, and `SameProcessOperationScope`.

## `oh-my-knowledge/eval-runtime/contracts`

Versioned wire contracts for adapter and trace authors:

- Rubric identities and schemas: `RUBRIC_JUDGE_EVALUATOR_IMPLEMENTATION_ID`, `RUBRIC_JUDGE_BINDINGS`, `RUBRIC_JUDGE_INSTRUMENT_SCHEMA_VERSION`, `RUBRIC_JUDGE_CONTEXT_SCHEMA_VERSION`, `RUBRIC_JUDGE_EVIDENCE_SCHEMA_VERSION`, `RUBRIC_JUDGE_INSTRUMENT_SCHEMA`, `RUBRIC_JUDGE_CONTEXT_SCHEMA`, and `RUBRIC_JUDGE_EVIDENCE_SCHEMA`.
- Rubric types: `RubricJudgeInstrument`, `RubricJudgeRuntimeConfig`, `RubricJudgeConfig`, `RubricJudgeCriterion`, and `RubricJudgeTracePolicy`.
- Trace values: `SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION`, `SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR`, `SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR`, `SourceNeutralTraceSchema`, `SourceNeutralTraceWithoutMocksSchema`, `SourceNeutralMockStatsSchema`, `parseSourceNeutralTrace`, and `attachSourceNeutralMockStats`.
- Trace types: `SourceNeutralTrace` and `SourceNeutralMockStats`.

## Migration

The `1.0.0-beta` canonical entry replaces the previous assembly-first surface. Move existing low-level imports from `oh-my-knowledge/eval-runtime` to `oh-my-knowledge/eval-runtime/advanced`; wire schemas remain at `/contracts`. New hosts should import `evaluate` or `checkExecutor` from the package root. The `/eval-runtime` entry remains the explicit equivalent for consumers that prefer domain-qualified imports.

Use `oh-my-knowledge/eval-core` for custom analysis graphs, persisted artifact admission, staged replay, or explicit cross-run comparability. Deep implementation imports are unsupported.
