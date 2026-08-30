# Evaluation Runtime Adapter

> **Status**: binding assembly, verified resource leases, and the Core composition root for [#457](https://github.com/lizhiyao/oh-my-knowledge/issues/457). It is additive and does not switch the production `omk eval` pipeline.

## Boundary

The OMK host consumes the complete output of `compileCliEvaluationInput()` and performs effects outside Evaluation Core. Binding assembly does not create a second plan, reinterpret CLI input, or trust a registry declaration as actual Runtime identity.

```text
       compileCliEvaluationInput()
                    │ complete immutable result
                    ▼
       createOmkEvaluationRuntime()
                    │
        ┌───────────┼────────────────┐
        ▼           ▼                ▼
 binding entries  support ports  run lease registry
        └───────────┼────────────────┘
                    ▼
       createEvaluationEngine().prepare()
                    │ actual identity and capabilities
                    ▼
              SealedRunPlan
```

Independent Series analysis is assembled as `EvaluationSeriesRuntimePorts`; it never enters `EvaluationEngineRuntimeBindings`.

## Binding coverage

Assembly requires one exact binding for every:

- Target executor and Evaluator reference;
- AnalysisGraph node and the separate Sampling Estimator requirement;
- MissingPolicy and DecisionPolicy reference;
- Series analysis node and Series decision policy reference.

An analysis binding carries both `referenceId` and Core's `requirementKind`. Sampling Estimator is therefore not inferred from an AnalysisGraph node or silently resolved from a fallback registry.

This complete shape is `omk.runtime-binding-request/v2`. The incomplete migration-only v1 request is rejected rather than read through a compatibility branch.

Before invoking any factory, assembly validates unique binding IDs and reference keys, exact Definition／Series coverage, implementation and version constraints, executor protocol／model／effort／behavior digest, evaluator measurement／config digest, and resource lease requirements. A validation failure causes zero factory calls.

## Immutable entries and identity

Assembly first clones and deep-freezes Definition, Series, and RuntimeBindingRequest. Each implementation factory is selected by `implementationId`, but it is called once per binding so two references using the same implementation receive distinct port instances.

The factory returns the actual port identity and version-resolution result. Assembly validates the port shape and implementation identity, captures an immutable identity snapshot, and wraps the port methods around the original instance. The Core preparation resolver and the captured execution port are then projected from the same entry; later registry or request mutation cannot create split-brain resolution.

Every entry records:

- the complete binding and actual `RuntimeResolution`;
- the captured port;
- explicit resource lease requirements;
- a binding-local `sessionIsolationKey` derived from the complete binding and passed to its factory.
- for Executor and Evaluator factories only, a binding-scoped resource access view that resolves the current Core `runId` and cannot enumerate another binding or analysis-only resources.

Adapters combine `sessionIsolationKey` with Core's `runId` and `trialId`; it is not permission to pool state across runs or bindings.

## Resource requirements

RuntimeBindingRequest records resource role and intended lease mode, not locators or content:

| Role | Lease mode |
|---|---|
| artifact, MCP config, mock payload, evaluator content | immutable snapshot |
| workspace | verified base plus copy-on-write overlay |

These are acquisition requirements only. The verified HostResource lease layer remains responsible for checking kind, classification, size, digest, actual bytes／tree, isolation, and exactly-once release before a port can open a run. Gold resources never appear in executor or evaluator binding requirements.

Lease acquisition snapshots all descriptors and binding requests synchronously before its first effect. It then materializes only resources requested by active bindings, copies source bytes into a private run directory, and verifies the private snapshot rather than continuing to consume the locator. Immutable snapshots are read-only. Each workspace binding receives its own writable overlay over a shared read-only base within that run; different runs never share writable state. The Node backend currently realizes this copy-on-write isolation contract as an eager private copy; the lease mode specifies isolation semantics, not a required filesystem mechanism. Gold is projected only through the analysis-host map.

File identity is SHA-256 over the consumed bytes. Tree identity uses `omk.tree-sha256/v1`: entries are sorted by relative path and framed by entry type, UTF-8 path, file size, executable／non-executable mode, and file bytes. Empty directories participate; symlinks and special files fail closed. Pinned Git additionally verifies the exact `HEAD` commit and a clean regular-file checkout; dirty, untracked, ignored, or submodule content is not accepted as commit content. Root `.git` metadata is excluded from both resolve-stage and lease-stage tree identity. A copied snapshot is accepted only when both its actual size and digest match the v2 descriptor. Acquisition failure cleans the partial run root; successful leases expose one idempotent `dispose()` promise and perform one underlying cleanup attempt.

Per-resource and whole-run byte／entry limits include writable overlays. Planned logical bytes are rejected before copying; entry limits are enforced while bounded resources are materialized. Errors carry stable codes and resource／binding identity but never include locator strings, secret bytes, or Gold content. Structurally valid inventory entries that no active binding requests are not opened, hashed, Git-probed, or copied; this preserves the no-Judge side-effect boundary.

The composition root acquires the complete active-binding lease before Core can call any `openRun()`. It validates exact binding and resource coverage, captures immutable map and descriptor snapshots, and only then registers binding-scoped access. Registration is removed after all Core port teardown has settled, followed by one lease-disposal attempt. Acquisition, cancellation-before-start, EventWriter construction, Core start, Core completion, and failure paths share the same idempotent cleanup promise. Duplicate active `runId` values are rejected before a second acquisition. Gold declared for exploratory post-hoc comparison is not materialized by the single-run Core composition; the separate analysis-host workflow requests that lease when it has an actual consumer.

## Core composition and support ports

`createOmkEvaluationRuntime()` consumes one complete `CliEvaluationCompileResult`; callers cannot pass a replacement Definition or Policy to `prepare()` or `start()`. The composition root validates the compiled canonical digests, snapshots all host-owned configuration, merges Core-owned Analysis schema validators and Runtime factories, assembles bindings, and invokes the real `createEvaluationEngine(...).prepare(...)`. It exposes the independent Series assembly separately rather than placing Series ports in the single-run engine.

Support ports are captured as bound immutable method views. Their presence is derived from the sealed Policy without changing it:

- non-disabled execution or evaluation cache mode requires the corresponding cache port and the exact stage-specific source locator compiled under `orchestration.cacheSources`;
- reference output or trace capture requires an Execution ContentStore;
- reference evaluator evidence requires an Evaluation ContentStore;
- an Evaluator that consumes reference-captured output or trace requires a ContentResolver;
- required EventWriter mode requires a run-scoped writer factory.

Clock and SchemaValidator contracts are checked before factory assembly. Core-owned Analysis validators are always present. A validator key must equal its complete schema identity; reusing one schema URI with another version, digest, or validator fails closed. Built-in Analysis, MissingPolicy, and Decision factories are merged by implementation ID, and a host factory cannot shadow a Core-owned implementation.

EventWriter is deliberately not stored in the static `EvaluationEngineRuntime`. For optional or required delivery, it is created after resource acquisition and before Core start, then passed through `PreparedEvaluation.start()`. Disabled mode never invokes the factory. Missing or malformed Policy-required ports fail before any Runtime factory or run port is invoked. An absent Judge binding therefore causes no Judge factory construction, credential read, connectivity probe, or resource materialization.

## Failure ownership

- malformed input, coverage, duplicate, Definition mismatch, missing factory, factory failure, and invalid port use stable `OmkRuntimeAssemblyError` codes before a Run starts;
- compiled-input, support-port, cache-source, schema conflict, writer construction, active-run, and host cleanup failures use stable `OmkEvaluationRuntimeError` codes;
- capability, schema, protocol support, identity assurance, and version satisfaction remain Core preparation errors;
- credentials, connectivity, and physical readiness remain separate adapter preflight concerns; verified resource materialization is a run-scoped host failure before Core starts;
- provider, session, attempt, cancellation, and dispose failures belong to Runtime ports after the Run starts.

This layer does not modify frozen prompts, scoring stages, statistical formulas, cache semantics, Bundle／Report schemas, or the legacy pipeline.
