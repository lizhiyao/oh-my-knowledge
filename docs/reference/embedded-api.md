# Embedded API

When a Node.js host owns model invocation while OMK owns measurement, comparison, and reporting, use the package-root Runtime façade. It is ESM-only and requires Node.js 22 or newer:

```ts
import { evaluate, checkExecutor } from 'oh-my-knowledge';
```

CommonJS hosts use dynamic import:

```js
const { evaluate } = await import('oh-my-knowledge');
```

Synchronous `require('oh-my-knowledge')` is intentionally unsupported. OMK does not ship a second CommonJS build, avoiding two module instances with diverging runtime registries. Only these public entry points are supported:

| Entry point | Ownership |
|---|---|
| `oh-my-knowledge` | recommended `evaluate()` and `checkExecutor()` façade for ordinary hosts |
| `oh-my-knowledge/eval-core` | advanced staged execution, artifact admission and verification, comparability, Series, and Schema discovery |
| `oh-my-knowledge/eval-runtime` | explicit equivalent of the package-root Runtime façade |
| `oh-my-knowledge/eval-runtime/advanced` | low-level Runtime assembly, identities, adapters, builders, and lifecycle SPI |
| `oh-my-knowledge/projections` | downstream artifact projections |
| `oh-my-knowledge/studio` | Studio Core-run catalog and routes |
| `oh-my-knowledge/mcp` / `oh-my-knowledge/dsh-plugin` | integration-specific APIs |

All other paths, including `oh-my-knowledge/dist/*`, are private and blocked by the package export map.

## Evaluation Core boundary

For the standard service-host path, start with the [eval-runtime guide](/guides/eval-runtime). Hosts that need custom Analysis implementations, staged replay, or infrastructure ports import the lower-level Core surface explicitly:

```ts
import {
  createEvaluationEngine,
  createBuiltinAnalysisSchemaValidators,
  type EvaluationDefinition,
  type EvaluationEngineRuntime,
  type MeasurementPolicy,
} from 'oh-my-knowledge/eval-core';
```

An engine receives implementations and infrastructure ports. Functions stay in memory and never enter the serializable Definition:

```ts
const runtime: EvaluationEngineRuntime = {
  bindings: {
    async resolveExecutor(requirement) {
      const { port, satisfiesVersionConstraint } = await executorRegistry.bind(requirement);
      return {
        runtimeKind: 'executor',
        resolution: { identity: port.identity, satisfiesVersionConstraint },
        port,
      };
    },
    async resolveEvaluator(requirement) {
      const { port, satisfiesVersionConstraint } = await evaluatorRegistry.bind(requirement);
      return {
        runtimeKind: 'evaluator',
        resolution: { identity: port.identity, satisfiesVersionConstraint },
        port,
      };
    },
    resolveAnalysis(requirement) {
      return analysisRegistry.bind(requirement);
    },
  },
  clock,
  schemaValidators: new Map([
    ...createBuiltinAnalysisSchemaValidators(),
    ...hostSchemaValidators,
  ]),
  executionCache,
  evaluationCache,
  executionContentStore,
  evaluationContentStore,
  contentResolver,
};

const engine = createEvaluationEngine(runtime);
```

Each binding resolver returns the resolution and the configured port together. OMK verifies that their Runtime identities are identical, captures the port under the Definition's stable reference ID, and uses that same captured binding for every prepared run. Two Targets or Evaluators may therefore share an implementation ID while retaining different models, fingerprints, configurations, sessions, and cancellation boundaries. A resolver/port split-brain fails during preparation before any runtime resource opens.

This is a breaking embedded-API correction. Hosts using the former `preparation` plus implementation-keyed `executors`, `evaluators`, and Analysis maps must move assembly into `bindings`. Low-level stage ports are now named `executorsByTargetId`, `evaluatorsByEvaluatorId`, `analysisNodesByNodeId`, `missingPoliciesByPolicyId`, and `decisionPoliciesByDecisionPolicyId`; no legacy adapter is provided.

The host owns long-lived registries, clients, caches, and stores. Each executor, evaluator, or Analysis implementation opens run-scoped resources and OMK disposes those resources at the matching stage boundary. Starting or cancelling one run never disposes another run's resources.

## Start a run

```ts
const run = engine.start(definition satisfies EvaluationDefinition, {
  policy: measurementPolicy satisfies MeasurementPolicy,
  runId: 'release-candidate-2026-08-30',
  signal: abortController.signal,
  annotations: { release: 'candidate-42' },
  eventBufferCapacity: 512,
});

const collecting = (async () => {
  for await (const event of run.events) {
    await progressView.observe(event);
  }
})();

const result = await run.result;
await collecting;
```

`runId` is host-assigned and required. It must be unique among active runs on the same engine instance because OMK derives Event, Bundle, and Report identifiers deterministically from it. A concurrent duplicate ends immediately with `EVALUATION_ENGINE_RUN_ID_ACTIVE`; the identifier can be reused after the original run reaches any terminal state. Definitions, samples, policies, runtime identities, seeds, and fingerprints are sealed into the resulting evidence chain.

Use `await engine.prepare(definition, policy)` when the host wants configuration and capability validation before scheduling. The returned `PreparedEvaluation` contains an opaque `SealedRunPlan` capability and the captured binding snapshot, and can start multiple isolated runs with the same immutable plan and ports.

## Advanced staged runs

Import the explicit advanced entry point when a host must persist a stage, change only downstream inputs, and recompute the affected suffix:

```ts
import { createEvaluationEngine } from 'oh-my-knowledge/eval-core';

const original = await createEvaluationEngine(runtime).prepare(definition, policy);
const executionSession = original.stages({ runId: 'execute-v1' });
const execution = await executionSession.execute().source;
await executionSession.close();

const changed = await createEvaluationEngine(runtime).prepare(changedDefinition, policy);
const admittedExecution = changed.admitExecutionBundle(
  persistedExecutionBundle,
  executionVerification,
);
const session = changed.stages({ runId: 'rescore-v2' });
const evaluation = await session.evaluate({ execution: admittedExecution }).source;
const analysis = await session.analyze({
  execution: admittedExecution,
  evaluation,
}).source;
const decision = await session.decide({
  execution: admittedExecution,
  evaluation,
  analysis,
}).source;
const report = await session.materializeReport({
  execution: admittedExecution,
  evaluation,
  analysis,
  ...(decision === undefined ? {} : { decision }),
}).result;
```

Each stage call exposes a serializable `.result` and, except for Report materialization, a non-serializable `.source` capability. The source envelope carries the matching `.bundle` or Decision `.result`. Only a source issued by the current runtime or by the matching `admit*` method can authorize a downstream stage. Admission recursively verifies plan identity and parent lineage; transported provenance remains indeterminate unless the host supplies valid external verification facts. Tampered digests, Runtime identity, cache provenance, or parent lineage fail closed.

A session allows each stage at most once and never permits overlapping stage calls. Report materialization closes it automatically. If a workflow intentionally stops earlier, call `await session.close()` to cancel any in-flight stage, wait for teardown, and release the `runId`.

Shipped JSON Schemas use versioned package paths. Code should avoid constructing package internals and use the current-contract resolver:

```ts
import { resolveEvaluationCoreJsonSchema } from 'oh-my-knowledge/eval-core';

const schemaUrl = resolveEvaluationCoreJsonSchema('execution-bundle.schema.json');
```

Each published file uses its canonical raw catalog URL as `$id`, so JSON Schema tooling can
resolve the document identity. The catalog contains 21 root contract names. Analysis Bundle,
Comparability Assessment, Evaluation Report, and Series Analysis Bundle currently use v2; the
other 17 current contracts use v1. Their package paths are respectively
`oh-my-knowledge/eval-core/schemas/v2/<file>.schema.json` and
`oh-my-knowledge/eval-core/schemas/v1/<file>.schema.json`. Frozen v1 snapshots of the four
upgraded contracts remain in the source catalog for historical identity resolution, but the
runtime does not read them. Node.js hosts should prefer the `eval-core` package subpath or
`resolveEvaluationCoreJsonSchema()` to use the installed current contract.

## Results and errors

`run.result` resolves to a discriminated `EvaluationRunResult`:

- `completed`, `cancelled`, and `budget-exhausted` include serializable Execution, Evaluation, and Analysis Bundles plus the Report;
- `failed` includes a machine-readable `EvaluationError` and includes partial artifacts and a Report when the pipeline reached materialization;
- configuration, infrastructure, execution, evaluation, analysis, and internal failures remain distinct error stages;
- a failed assertion, a quality regression, or a non-directional decision is report evidence, not a rejected Promise.

`engine.prepare()` rejects invalid configuration because it is an explicit preflight API. `engine.start()` and `PreparedEvaluation.start()` capture façade option, preparation, and runtime failures in `run.result` so schedulers can use one terminal-result channel. In particular, `eventBufferCapacity` must be a positive safe integer; an invalid value produces `EVALUATION_ENGINE_EVENT_BUFFER_CAPACITY_INVALID` and an already-closed, empty event stream instead of a synchronous exception.

## Events and durable delivery

Every run owns its event sequencer. Event sequence numbers start at zero and increase across Execution, Evaluation, Analysis, Decision, and Report materialization. Events are serializable and contain stable identities, status, coverage, and reason codes rather than provider secrets.

The async iterable is a bounded, single-consumer progress channel. It never backpressures authoritative evaluation work and drops the oldest buffered event when a consumer falls behind. Consume it concurrently with `run.result` when complete live progress matters.

For lossless persistence, configure `MeasurementPolicy.eventDelivery` and inject `eventWriter` in the run options. The sealed writer mode, backpressure mode, and failure mode define whether durable delivery can fail the run; the in-memory stream remains observational.

## Isolation and side effects

Importing the package root does not read user configuration, initialize CLI or Studio components, create files, write output, or register process hooks. A pure-memory run accesses only the ports supplied by the host. OMK does not provide queues, tenant isolation, cross-process retries, or untrusted-code sandboxing through this API.

See the complete independent-host acceptance fixture in [`test/eval-core/fixtures/embedded-host.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-core/fixtures/embedded-host.mjs).
