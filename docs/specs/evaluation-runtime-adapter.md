# Evaluation Runtime Adapter

> **Status**: binding-assembly foundation for [#457](https://github.com/lizhiyao/oh-my-knowledge/issues/457). It is additive and does not switch the production `omk eval` pipeline.

## Boundary

The OMK host consumes the complete output of `compileCliEvaluationInput()` and performs effects outside Evaluation Core. Binding assembly does not create a second plan, reinterpret CLI input, or trust a registry declaration as actual Runtime identity.

```text
EvaluationDefinition + RuntimeBindingRequest
                    │ exact coverage and immutable snapshot
                    ▼
        assembleOmkRuntimeBindings()
                    │ implementation factory resolution
                    ▼
  immutable binding entries + Core Runtime ports
                    │ actual identity and capabilities
                    ▼
       createEvaluationEngine().prepare()
                    │
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

Adapters combine `sessionIsolationKey` with Core's `runId` and `trialId`; it is not permission to pool state across runs or bindings.

## Resource requirements

RuntimeBindingRequest records resource role and intended lease mode, not locators or content:

| Role | Lease mode |
|---|---|
| artifact, MCP config, mock payload, evaluator content | immutable snapshot |
| workspace | verified base plus copy-on-write overlay |

These are acquisition requirements only. The verified HostResource lease layer remains responsible for checking kind, classification, size, digest, actual bytes／tree, isolation, and exactly-once release before a port can open a run. Gold resources never appear in executor or evaluator binding requirements.

## Failure ownership

- malformed input, coverage, duplicate, Definition mismatch, missing factory, factory failure, and invalid port use stable `OmkRuntimeAssemblyError` codes before a Run starts;
- capability, schema, protocol support, identity assurance, and version satisfaction remain Core preparation errors;
- credentials, connectivity, filesystem readiness, and resource materialization belong to later adapter preflight／lease layers;
- provider, session, attempt, cancellation, and dispose failures belong to Runtime ports after the Run starts.

This layer does not modify frozen prompts, scoring stages, statistical formulas, cache semantics, Bundle／Report schemas, or the legacy pipeline.
