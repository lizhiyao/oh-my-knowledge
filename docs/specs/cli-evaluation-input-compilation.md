# CLI Evaluation Input Compilation

> **Status**: implemented as the migration foundation for [#451](https://github.com/lizhiyao/oh-my-knowledge/issues/451), under the [Evaluation Core vNext RFC](./evaluation-core-vnext.md). This layer does not switch the production `omk eval` pipeline and does not call `createEvaluationEngine()`.

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
- `RuntimeBindingRequest` contains only implementation requirements derived from Definition. A registry may resolve them, but cannot override model, effort, prompt variant, protocol, evaluator identity, or behavior config.
- `ResolvedHostResources` binds a stable resource ID and digest to an effect locator. It is not a Core schema and never enters canonical measurement JSON.
- `EvaluationOrchestrationOptions` owns dry-run, resume locator, batch, independent Series repeats, preflight switches, diagnostic post-processing, gold post-hoc workflows, and managed-evidence append behavior.
- `EvaluationPresentationOptions` owns output locator, index scope, language, server, verbosity, layered view, and CLI exit presentation. None changes `DecisionResult`.
- Static RunOptions metadata may contain serializable annotations and summaries. The orchestrator creates run ID, cancellation, event writer, and buffers only when a Run actually starts.

`HostExecutionPlan` is intentionally absent. The only object named Plan is produced and sealed by Core prepare.

## 3. Identity, lineage, and resource safety

Behavior identity and source lineage are separate axes:

- Target config contains the bytes/configuration that affect behavior as `{resourceId, digest, mediaType, classification}` descriptors, plus normalized workspace, tool, mock, sandbox, model, and effort facts.
- Host resources contain locator, resolved commit, repository origin, and materialization evidence. Moving the same content between absolute/relative paths or machines does not invalidate execution identity.
- A behavior change changes the Definition digest. A lineage-only change is assessed later by explicit comparability and provenance policy, not smuggled into Target config.

Mock rules and strict mode enter Target behavior. Every payload is a digest-bound descriptor; inline secret or gold content is forbidden. Compile also requires every reference role to match its host resource kind: artifact, workspace, MCP config, mock payload, evaluator content, and gold dataset cannot be substituted for one another even when a descriptor happens to match. Runtime adapters must verify the digest immediately before use. Missing interception, allowed-tool, skill-discovery, MCP, cancellation, seed, or sandbox capability fails closed during Core prepare; adapters must never drop mocks or fall back to real external calls.

Dataset projections preserve the Gold boundary: Executors see only `input + executionContext`; evaluators may receive `expected + evaluationContext`; analysis receives only explicit membership and analysis context. Gold locators remain host resources. Post-hoc gold comparison is exploratory and cannot masquerade as a preregistered decision.

## 4. Measurement mapping

- Control/treatment is represented only by `Comparison`; artifact contents are Target behavior.
- Assertions, rubric judges, dimensions, composites, and RAG metrics remain distinct Evaluator/Metric/AnalysisGraph concepts.
- Judge members carry explicit instrument, ensemble member, replicate group, and replicate index. No analysis may parse evaluator IDs to infer hierarchy.
- Holdout/cohort membership is analysis-only and fixed before execution.
- Bootstrap, correction, thresholds, and trivial-difference gates are Definition facts in AnalysisGraph or DecisionPolicy.
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

The names reserved for the final CLI cutover are `--execution-cache-mode`, `--evaluation-cache-mode`, `--execution-cache-source`, and `--evaluation-cache-source`; `eval.yaml` will use `cache.executionMode`, `cache.evaluationMode`, `cache.executionSource`, and `cache.evaluationSource`. Resolve maps the source inputs to `orchestration.cacheSources.executionSourceLocator` and `evaluationSourceLocator`. These are not live production flags yet: the legacy pipeline remains unchanged. In the migration-only parser, omitted cache input and legacy disable-only input both normalize to the fresh double-disabled policy; an explicit legacy cache-enable request fails instead of being guessed as transparent reuse.

## 5. Determinism and validation

`parseCliEvaluationRequest()` is the pure normalization boundary for raw CLI/config inputs. The host passes only flags explicitly supplied by the user, an already syntax-validated `EvalConfig`, and any environment-selected defaults as explicit values with provenance. CLI and config candidates pass through the same canonical field validators before precedence is applied. Provenance is emitted only for a value that exists at this stage; later-derived values acquire provenance only when they are actually derived. Oclif-injected defaults must not be passed as explicit CLI values. Judge disablement is resolved before judge-model parsing, so an unused malformed judge source cannot fail a no-judge request.

`compileCliEvaluationInput()` accepts only resolved, serializable IR. It performs no I/O and returns deeply frozen output. It uses Core's public `normalizeEvaluationDefinition()` and `validateDefinitionSemantics()` contracts before emitting output: schema validation, canonical set-like ordering, reference integrity, and static semantic checks therefore have one owner. The Core boundary revalidates those contracts before runtime qualification. Object property order, nested membership/cohort-filter order, host locator spelling, CLI/YAML source, and lineage do not affect Definition or Policy digests; actual behavior bytes do.

Parse and compilation errors are host `CliEvaluationInputError` values with stable codes and optional source/field paths. Core static-validation failures retain their Core code/details inside the host error without leaking Core Run errors across the pre-Run boundary. They are not Core `EvaluationError` records, because a Run has not started. Runtime capability claims are not accepted by compile; only Core prepare can qualify them.

## 6. Migration boundary

This layer is additive. The production `omk eval` command continues to use `RunConfig → runEvaluation → executeEvaluationPipeline`; it does not double-run, shadow-run, persist Core Bundles, or change legacy reports. A later Runtime-adapter change may consume only the contracts emitted here and may not parse CLI inputs again.

The legacy `--no-cache`／`noCache` boolean has no faithful Core equivalent: its enabled state meant stochastic read-through execution reuse and said nothing about Evaluation cache. The registry therefore marks it for replacement rather than mapping it to `transparent-deterministic` or `reuse`. The final cutover may remove the old cache files and behavior without a compatibility reader.

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
