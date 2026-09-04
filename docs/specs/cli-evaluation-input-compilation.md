# CLI Evaluation Input Compilation

> **Status**: implemented production input boundary under the [Evaluation Core vNext RFC](./eval-core-vnext.md). Parse, resolve, compile, Runtime assembly, host workflow, Core execution, and artifact persistence now form the authoritative `omk eval` path.

## 1. Purpose and boundary

The CLI host must translate flags, `eval.yaml`, files, and local resources into the same host-neutral measurement contract. It must not build a second plan beside Core's sealed RunPlan. Input handling therefore has five distinct responsibilities:

```text
CLI flags / eval.yaml
        │ parse precedence and syntax
        ▼
CliEvaluationRequest
        │ resolve files, artifacts, samples and host resources
        ▼
ResolvedCliEvaluationInput + ResolvedHostResources
        │ pure deterministic compilation
        ▼
EvaluationDefinition + MeasurementPolicy
RuntimeBindingRequest + EvaluationOrchestrationOptions
EvaluationPresentationOptions + static RunOptions metadata
        │
        ├── Core prepare: schema, references, capabilities, runtime identity, sealing
        └── adapter preflight: doctor, credentials, connectivity, physical environment
```

| Phase | Owns | Must not do |
|---|---|---|
| Parse | `parseCliEvaluationRequest()` applies `CLI > eval.yaml > explicit host default`, validates syntax, and records source attribution | Read files/environment/network/clock, accept parser-injected defaults as explicit flags, create a Runtime, calculate measurement digests |
| Resolve | Materialization, git pinning, content/tree digests, mock and workspace descriptors, locator binding | Call Core prepare, trust self-reported capabilities, emit a sealed plan |
| Compile | Pure mapping to canonical, schema-valid, statically coherent Core contracts and host-side requests | Read filesystem/environment/network/clock, create `AbortSignal`, writer, store, or run ID |
| Core prepare | Revalidate the contract, qualify verified Runtime capability/identity, and seal the only RunPlan | Perform connectivity or doctor checks |
| Adapter preflight | Credentials, connectivity, path permissions, doctor, physical health | Replace Core capability validation or rewrite sealed measurement design |

## 2. Output ownership

- `EvaluationDefinition` owns data projections, Target behavior, evaluator instruments, metrics, experiment design, analysis, comparisons, and decision policy.
- `MeasurementPolicy` owns execution/evaluation concurrency, timeout, retry, cache, evidence, failure, event delivery, and the shared Run budget ledger.
- `RuntimeBindingRequest` v4 contains only implementation and resource-lease requirements derived from Definition／resolved host resources. Executor qualification reuses the exact canonical `TargetDefinition.executionRequirements`; it does not maintain a second approximation. A registry may resolve bindings, but cannot override execution requirements, model, effort, prompt variant, protocol, evaluator identity, or behavior config. Its complete assembly contract is specified in [Evaluation Runtime Adapter](./evaluation-runtime-adapter.md).
- `ResolvedHostResources` binds a stable resource ID and digest to an effect locator. It is not a Core schema and never enters canonical measurement JSON.
- `EvaluationOrchestrationOptions` owns dry-run, resume locator, batch, independent Series repeats, preflight switches, diagnostic post-processing, gold post-hoc workflows, and managed-evidence append behavior.
- Sample-bundle `requires` is normalized as host-only `dependencyRequirements`, together with its `baseDirectoryLocator`, for the later doctor/preflight workflow. Relative files and preflight commands therefore keep the sample bundle's resolution semantics. This host context does not enter Core measurement digests and is never silently discarded.
- `EvaluationPresentationOptions` owns output locator, index scope, language, server, verbosity, layered view, and CLI exit presentation. None changes `DecisionResult`.
- Static RunOptions metadata may contain serializable annotations and summaries. The orchestrator creates run ID, cancellation, event writer, and buffers only when a Run actually starts.

`HostExecutionPlan` is intentionally absent. The only object named Plan is produced and sealed by Core prepare.

## 3. Identity, lineage, and resource safety

Behavior identity and source lineage are separate axes:

- Target config contains Target-wide behavior facts such as artifact, mock, sandbox, model, and effort. Canonical `executionControls` separately holds Target defaults and sample overrides for workspace and tool authority; its workspace descriptors contain no locator.
- Target `executionRequirements` is the aggregate capability request derived from resolved behavior and every effective sample control: explicit system-instruction use, copy-on-write workspace, native MCP config, pre-tool-call mock interception, tool allow-list, skill-discovery policy, and sandbox ID. It enters Definition and ExecutionPlan identity; only Core prepare may compare it with Runtime features. It never grants the aggregate workspace or tool authority to one Trial.
- Host resources contain locator, resolved commit, repository origin, and materialization evidence. Moving the same content between absolute/relative paths or machines does not invalidate execution identity.
- A behavior change changes the Definition digest. A lineage-only change is assessed later by explicit comparability and provenance policy, not smuggled into Target config.

Mock rules and payloads are separate secret, digest-bound descriptors. Raw `tool`／`match` values never enter Core or static Target JSON; the Runtime adapter reads them only through the run-scoped verified lease before any business process starts. `sampleIds`, strict mode, the rule descriptor, and ordered payload descriptors remain canonical Target behavior, so changing rule bytes or return order changes measurement identity. `sampleId` is supplied by Core to the adapter and is never appended to the model prompt. Compile also requires every reference role to match its host resource kind: artifact, workspace, MCP config, mock rule, mock payload, evaluator content, and gold dataset cannot be substituted for one another even when a descriptor happens to match. Runtime adapters must verify the digest immediately before use. Missing interception, allowed-tool, skill-discovery, MCP, cancellation, seed, or sandbox capability fails closed during Core prepare; adapters must never drop mocks or fall back to real external calls. Heterogeneous sample `cwd` and `allowedTools` values compile into canonical sample overrides; they are never unioned, and adapters receive only the exact effective Trial control.

`ResolvedHostResources` v3 makes `descriptor.size` mandatory and represents pinned Git verification as `{verificationKind, verifiedDigest, commitId}`. The commit ID is a normalized 40–64 character lowercase hexadecimal object identity; a branch or tag name is not a pin. File-only MCP config, mock rule, mock payload, and evaluator-content resources require `content-digest`; mock rules additionally require `application/json`. MCP config and both mock-control resource kinds must be classified `secret`. Workspaces require `tree-digest` or `pinned-git`; pinned Git is limited to artifacts and workspaces. `gold` classification and `gold-dataset` kind are mutually required. Earlier shapes are rejected without a compatibility reader.

Dataset projections preserve the Gold boundary: Executors see only `input + executionContext`; evaluators may receive `expected + evaluationContext`; analysis receives only explicit membership and analysis context. Gold locators remain host resources. Post-hoc gold comparison is exploratory and cannot masquerade as a preregistered decision.

## 4. Measurement mapping

- Control/treatment is represented only by `Comparison`; artifact contents are Target behavior.
- Assertions, rubric judges, dimensions, composites, and RAG metrics remain distinct Evaluator/Metric/AnalysisGraph concepts. An Evaluator template owns its algorithm `implementationId`, instrument, and runtime prompt variant; a judge member owns only provider executor, model, effort, and ensemble identity.
- Judge members carry explicit instrument, ensemble member, replicate group, and replicate index. No analysis may parse evaluator IDs to infer hierarchy.
- Holdout/cohort membership is analysis-only and fixed before execution.
- Bootstrap, correction, thresholds, and trivial-difference gates are Definition facts in AnalysisGraph or DecisionPolicy.
- Every treatment has its own explicit paired control comparison; multi-treatment requests never collapse into one ambiguous treatment identifier.
- Deterministic assertion evaluators emit explicit structural-missing observations when a criterion does not apply. LLM assertions and rubric dimensions instead seal canonical `applicableSampleIds`; Core omits non-applicable Evaluator coordinates from plan identity, coverage, execution, and analysis rather than scoring an unintended sample.
- The production design uses paired blocks with `seedCoupling: uncontrolled`: current provider adapters expose no exact sampling-seed control. The host may deterministically randomize coordinate order, but it must not claim coupled model randomness.
- Length debias changes rubric evaluator config; presentation/tone neutralization remains always on.
- Legacy total USD maps to a shared Run provider-cost limit. Per-sample USD and milliseconds map to per-coordinate provider-cost and active-duration limits. They are not implemented by a host `AbortController` or report rewrite.

The repetition hierarchy is explicit:

| Concept | Contract |
|---|---|
| Trial | Repeated Target measurement inside one sealed Run |
| Retry attempt | Infrastructure recovery for one coordinate |
| Judge replicate | Repeated observation by the same instrument |
| Ensemble member | A distinct judge instrument/Runtime |
| `--repeat` | Independent Runs in an Evaluation Series |
| Batch child | A different artifact workflow, not a Series replicate |

For `--repeat > 1`, the orchestrator allocates a unique `seriesInstanceId` before resolution. Compilation binds that host-owned instance identity to the complete Series design—measurement design, repeat count, comparison scope, and minimum status—to derive Core's final `seriesId`. The compiler never invents identity from a clock or random source, and reusing an instance ID with a different design cannot alias the same Series.

### 4.1 Cache and replay

Fresh measurement is the default. The normalized policy always carries two independent fields:

```yaml
cache:
  executionMode: disabled # disabled | replay-only | transparent-deterministic
  evaluationMode: disabled # disabled | reuse
```

`executionMode` and `evaluationMode` enter their respective Core contract digests. A non-disabled mode also requires a stage-specific source locator in host-owned `orchestration.cacheSources`; the locator never enters Core canonical JSON. The Runtime adapter must assemble exactly that source into the corresponding cache port and must not substitute an environment-selected or global default.

`replay-only` is a fail-closed read path. A missing, unavailable, corrupt, or identity-mismatched coordinate terminates the run and never falls back to a live Target call. Replayed records retain the original trial identity, Runtime identity, usage, cost, and provenance; they add neither a native invocation nor an independent replicate. Until Series has an explicit effective-independent-sample model, compilation rejects every non-disabled cache mode together with an independent Series repeat. It also rejects mixing cache reuse with resume in one request. `transparent-deterministic` is available only when Core prepare verifies deterministic execution and a verified Runtime identity. Evaluation `reuse` is independent and remains bound to the complete evaluation contract, including evaluator/model/prompt variant, replicate identity, Gold-facing inputs, metrics, and evidence policy.

The Core contract reserves `--execution-cache-mode`, `--evaluation-cache-mode`, `--execution-cache-source`, and `--evaluation-cache-source`; `eval.yaml` reserves `cache.executionMode`, `cache.evaluationMode`, `cache.executionSource`, and `cache.evaluationSource`. These explicit reuse controls are not exposed by the current production CLI. Production runs normalize omitted cache input and the disable-only `--no-cache` input to a fresh, double-disabled policy. An explicit cache-enable request fails instead of being guessed as transparent reuse.

## 5. Determinism and validation

`parseCliEvaluationRequest()` is the pure normalization boundary for raw CLI/config inputs. The host passes only flags explicitly supplied by the user, an already syntax-validated `EvalConfig`, and any environment-selected defaults as explicit values with provenance. CLI and config candidates pass through the same canonical field validators before precedence is applied. Provenance is emitted only for a value that exists at this stage; later-derived values acquire provenance only when they are actually derived. Oclif-injected defaults must not be passed as explicit CLI values. Judge disablement is resolved before judge-model parsing, so an unused malformed judge source cannot fail a no-judge request.

`compileCliEvaluationInput()` accepts only resolved, serializable IR. It performs no I/O and returns deeply frozen output. It uses Core's public `normalizeEvaluationDefinition()` and `validateDefinitionSemantics()` contracts before emitting output: schema validation, canonical set-like ordering, reference integrity, and static semantic checks therefore have one owner. The Core boundary revalidates those contracts before runtime qualification. Object property order, nested membership/cohort-filter order, host locator spelling, CLI/YAML source, and lineage do not affect Definition or Policy digests; actual behavior bytes do.

Parse and compilation errors are host `CliEvaluationInputError` values with stable codes and optional source/field paths. Core static-validation failures retain their Core code/details inside the host error without leaking Core Run errors across the pre-Run boundary. They are not Core `EvaluationError` records, because a Run has not started. Runtime capability claims are not accepted by compile; only Core prepare can qualify them.

## 6. Migration boundary

This layer is the production boundary. `omk eval` consumes its contracts through Runtime assembly and the Core host workflow, then persists the Core Plan, Bundles, and Report. The deleted legacy pipeline is neither double-run nor shadow-run, and no later layer reparses CLI input.

The migration contracts are intentionally incompatible: parse output is `omk.cli-evaluation-request/v2`, resolved compiler input is `omk.resolved-cli-evaluation-input/v5`, HostResource inventory remains `omk.resolved-host-resources/v3`, and binding output remains `omk.runtime-binding-request/v4`. Request v2 and resolved input v5 add the required sample-size planning contract and select `omk.release-decision/v4`; earlier shapes are rejected without inference or a compatibility reader. The v4 resolved input had previously replaced inline mock match rules with a secret `mock-rule` descriptor and lease role. Release-policy identity now makes the changed sample-size semantics explicit while historical v1–v3 policies remain registered for replay.

The disable-only `--no-cache`／`noCache` surface has no faithful Core cache-enable equivalent: the removed implementation used stochastic read-through execution reuse and expressed nothing about Evaluation cache. The current registry therefore normalizes only the disabled state and marks explicit cache reuse for a future, separately designed interface. Old cache files are not read.

## 7. Exhaustive input registry

The declarative registry classifies every live `omk eval` flag and every machine-enumerable `EvalConfig` path. CI compares both source-key sets strictly, so an unclassified new field fails. The table is generated from the registry by `yarn build:docs`.

<!-- omk:eval-input-registry:start -->
| Source | Field | Normalized field | Priority | Normalized default (source) | Owner | Digest stage | Runtime qualification | Error / migration |
|---|---|---|---:|---|---|---|---|---|
| CLI | `--batch` | `orchestration.batch` | 300 | `false` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--bootstrap` | `definition.analysisGraph.bootstrap` | 300 | `true` (documented) | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--bootstrap-samples` | `definition.analysisGraph.bootstrap.resamples` | 300 | `1000` (documented) | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--budget-per-sample-ms` | `policy.budget.perCoordinateActiveDurationMs` | 300 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--budget-per-sample-usd` | `policy.budget.perCoordinateProviderCostUSD` | 300 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--budget-usd` | `policy.budget.totalProviderCostUSD` | 300 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--concurrency` | `policy.executionConcurrency` | 300 | `1` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--config` | `orchestration.configLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--control` | `definition.targets.control` | 300 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--control-cwd` | `resources.controlWorkspaceLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--dry-run` | `orchestration.dryRun` | 300 | `false` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--effort` | `definition.targetRuntime.effort` | 300 | `"low"` (documented) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--executor` | `definition.targetRuntime.implementationId` | 300 | — (environment-selection) | Definition | execution | `executor-protocol`<br>`model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--global` | `presentation.indexScope` | 300 | `"project"` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--gold-dir` | `orchestration.gold.resourceLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--holdout-ratio` | `definition.dataset.analysisCohorts` | 300 | — | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--judge-models` | `definition.judges.members` | 300 | — (environment-selection) | Definition | evaluation | `evaluator-instrument`<br>`model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--judge-repeat` | `definition.judges.replicateCount` | 300 | `1` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--lang` | `presentation.language` | 300 | `"zh"` (environment-selection) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--layered-stats` | `presentation.layeredView` | 300 | `false` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--mcp-config` | `resources.mcpConfigLocator` | 300 | — | Orchestration | none | `tool-mock-sandbox` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--model` | `definition.targetRuntime.model` | 300 | — (environment-selection) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-cache` | `policy.cache.executionMode` | 300 | `"disabled"` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_LEGACY_CACHE_ENABLE_UNSUPPORTED`<br>replace → --execution-cache-mode / --evaluation-cache-mode |
| CLI | `--no-debias-length` | `definition.judges.lengthDebias` | 300 | `true` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-diagnostic` | `orchestration.diagnostic` | 300 | `"enabled-outside-core"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-evidence` | `orchestration.managedEvidence` | 300 | `"append"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-gate` | `presentation.exitMode` | 300 | `"gate"` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>rename → --report-only |
| CLI | `--no-judge` | `definition.judges.enabled` | 300 | `true` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-serve` | `presentation.serve` | 300 | `true` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--no-strict-baseline` | `definition.baselineIsolation` | 300 | `true` (documented) | Definition | execution | — | `CLI_INPUT_INVALID`<br>`CLI_INPUT_BASELINE_ISOLATION_CONFLICT`<br>retain |
| CLI | `--output-dir` | `presentation.outputDirectoryLocator` | 300 | — | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--repeat` | `orchestration.independentSeries.repeatCount` | 300 | `1` (documented) | Orchestration | run | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--report-only` | `presentation.exitMode` | 300 | `"gate"` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--resume` | `orchestration.resumeSourceLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--retry` | `policy.retryCount` | 300 | `0` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--samples` | `orchestration.samplesLocator` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--skill-dir` | `orchestration.skillDirectoryLocator` | 300 | `"skills"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--skip-connectivity` | `orchestration.preflight.connectivity` | 300 | `"required"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--skip-doctor` | `orchestration.preflight.doctor` | 300 | `"required"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--strict-baseline` | `definition.baselineIsolation` | 300 | `true` (documented) | Definition | execution | — | `CLI_INPUT_INVALID`<br>`CLI_INPUT_BASELINE_ISOLATION_CONFLICT`<br>retain |
| CLI | `--threshold` | `definition.decisionPolicy.threshold` | 300 | — (derived) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--timeout` | `policy.executionTimeoutMs` | 300 | `120000` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--treatment` | `definition.targets.treatments` | 300 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--treatment-cwd` | `resources.treatmentWorkspaceLocators` | 300 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--trivial-diff` | `definition.decisionPolicy.trivialDifference` | 300 | — (derived) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| CLI | `--verbose` | `presentation.verbose` | 300 | `false` (documented) | Presentation | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `bootstrap` | `definition.analysisGraph.bootstrap` | 200 | `true` (documented) | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `bootstrapSamples` | `definition.analysisGraph.bootstrap.resamples` | 200 | `1000` (documented) | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `budget` | `policy.budget` | 200 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `budget.perSampleMs` | `policy.budget.perCoordinateActiveDurationMs` | 200 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `budget.perSampleUSD` | `policy.budget.perCoordinateProviderCostUSD` | 200 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `budget.totalUSD` | `policy.budget.totalProviderCostUSD` | 200 | — | MeasurementPolicy | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `concurrency` | `policy.executionConcurrency` | 200 | `1` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision` | `definition.decisionPolicy` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.minimumComparisonUnits` | `definition.decisionPolicy.sampleSize.minimumComparisonUnits` | 200 | `20` (documented) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power` | `definition.decisionPolicy.sampleSize` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power.assumptionSource` | `definition.decisionPolicy.sampleSize.assumptionSource` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power.expectedDifferenceStandardDeviation` | `definition.decisionPolicy.sampleSize.expectedDifferenceStandardDeviation` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power.minimumDetectableDifference` | `definition.decisionPolicy.sampleSize.minimumDetectableDifference` | 200 | — | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.power.targetPower` | `definition.decisionPolicy.sampleSize.targetPower` | 200 | `0.8` (documented) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.threshold` | `definition.decisionPolicy.threshold` | 200 | — (derived) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `decision.trivialDifference` | `definition.decisionPolicy.trivialDifference` | 200 | — (derived) | Definition | decision | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `effort` | `definition.targetRuntime.effort` | 200 | `"low"` (documented) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `executor` | `definition.targetRuntime.implementationId` | 200 | — (environment-selection) | Definition | execution | `executor-protocol`<br>`model-effort` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `goldDir` | `orchestration.gold.resourceLocator` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `holdoutRatio` | `definition.dataset.analysisCohorts` | 200 | — | Definition | analysis | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `judgeModels` | `definition.judges.members` | 200 | — (environment-selection) | Definition | evaluation | `evaluator-instrument` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `judgeModels[].executor` | `definition.judges.members[].executorId` | 200 | — | Definition | evaluation | `evaluator-instrument` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `judgeModels[].model` | `definition.judges.members[].model` | 200 | — | Definition | evaluation | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `judgeRepeat` | `definition.judges.replicateCount` | 200 | `1` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `lengthDebias` | `definition.judges.lengthDebias` | 200 | `true` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `mcpConfig` | `resources.mcpConfigLocator` | 200 | — | Orchestration | none | `tool-mock-sandbox` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `model` | `definition.targetRuntime.model` | 200 | — (environment-selection) | Definition | execution | `model-effort` | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `noCache` | `policy.cache.executionMode` | 200 | `"disabled"` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_LEGACY_CACHE_ENABLE_UNSUPPORTED`<br>replace → cache.executionMode / cache.evaluationMode |
| eval.yaml | `noDiagnostic` | `orchestration.diagnostic` | 200 | `"enabled-outside-core"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `noJudge` | `definition.judges.enabled` | 200 | `true` (documented) | Definition | evaluation | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `repeat` | `orchestration.independentSeries.repeatCount` | 200 | `1` (documented) | Orchestration | run | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `samples` | `orchestration.samplesLocator` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `skipDoctor` | `orchestration.preflight.doctor` | 200 | `"required"` (documented) | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `strictBaseline` | `definition.baselineIsolation` | 200 | `true` (documented) | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `timeoutMs` | `policy.executionTimeoutMs` | 200 | `120000` (documented) | MeasurementPolicy | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants` | `definition.targets` | 200 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].allowedSkills` | `definition.targets[].behavior.allowedSkills` | 200 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].artifact` | `resources.targets[].artifactLocator` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].cwd` | `resources.targets[].workspaceLocator` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].git` | `resources.targets[].gitSource` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].git.ref` | `resources.targets[].gitSource.ref` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].git.spec` | `resources.targets[].gitSource.spec` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].git.url` | `resources.targets[].gitSource.url` | 200 | — | Orchestration | none | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].name` | `definition.targets[].targetId` | 200 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
| eval.yaml | `variants[].role` | `definition.targets[].experimentRole` | 200 | — | Definition | execution | — | `CLI_INPUT_INVALID`<br>retain |
<!-- omk:eval-input-registry:end -->
