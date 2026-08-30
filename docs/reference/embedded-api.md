# Embedded Evaluation Core API

Use the package-root API when a Node.js host owns datasets, credentials, queues, storage, and user-facing workflows but wants OMK to own evaluation planning, execution, measurement, analysis, and report materialization.

The embedded API is ESM-only and requires Node.js 22 or newer:

```ts
import {
  createEvaluationEngine,
  createBuiltinAnalysisNodes,
  createBuiltinAnalysisSchemaValidators,
  createBuiltinDecisionPolicies,
  createBuiltinMissingPolicies,
  resolveBuiltinAnalysisRuntime,
  type EvaluationDefinition,
  type EvaluationEngineRuntime,
  type MeasurementPolicy,
} from 'oh-my-knowledge';
```

CommonJS hosts use dynamic import:

```js
const { createEvaluationEngine } = await import('oh-my-knowledge');
```

Synchronous `require('oh-my-knowledge')` is intentionally unsupported. OMK does not ship a second CommonJS build, avoiding two module instances with diverging runtime registries. Paths below the package root, including `oh-my-knowledge/dist/*`, are private and blocked by the package export map.

## Runtime boundary

An engine receives implementations and infrastructure ports. Functions stay in memory and never enter the serializable Definition:

```ts
const runtime: EvaluationEngineRuntime = {
  preparation: {
    resolveExecutor(requirement) {
      return executorRegistry.resolve(requirement);
    },
    resolveEvaluator(requirement) {
      return evaluatorRegistry.resolve(requirement);
    },
    resolveAnalysis(requirement) {
      return resolveBuiltinAnalysisRuntime(requirement)
        ?? analysisRegistry.resolve(requirement);
    },
  },
  executors,
  evaluators,
  clock,
  schemaValidators: new Map([
    ...createBuiltinAnalysisSchemaValidators(),
    ...hostSchemaValidators,
  ]),
  analysisNodes: new Map([
    ...createBuiltinAnalysisNodes(),
    ...hostAnalysisNodes,
  ]),
  missingPolicies: createBuiltinMissingPolicies(),
  decisionPolicies: createBuiltinDecisionPolicies(),
  executionCache,
  evaluationCache,
  executionContentStore,
  evaluationContentStore,
  contentResolver,
};

const engine = createEvaluationEngine(runtime);
```

The preparation resolvers attest that a runtime identity and its capabilities satisfy the requested implementation and version constraint. The implementation registered in `executors`, `evaluators`, or the Analysis registries must expose the same identity sealed by preparation. This keeps fingerprints, capabilities, and actual code from silently diverging.

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

`runId` is host-assigned and required. OMK derives Bundle and Report identifiers deterministically from it. Definitions, samples, policies, runtime identities, seeds, and fingerprints are sealed into the resulting evidence chain.

Use `await engine.prepare(definition, policy)` when the host wants configuration and capability validation before scheduling. The returned `PreparedEvaluation` contains an opaque `SealedRunPlan` capability and can start multiple isolated runs with the same immutable plan.

## Results and errors

`run.result` resolves to a discriminated `EvaluationRunResult`:

- `completed`, `cancelled`, and `budget-exhausted` include serializable Execution, Evaluation, and Analysis Bundles plus the Report;
- `failed` includes a machine-readable `EvaluationError` and includes partial artifacts and a Report when the pipeline reached materialization;
- configuration, infrastructure, execution, evaluation, analysis, and internal failures remain distinct error stages;
- a failed assertion, a quality regression, or a non-directional decision is report evidence, not a rejected Promise.

`engine.prepare()` rejects invalid configuration because it is an explicit preflight API. `engine.start()` captures preparation and runtime failures in `run.result` so schedulers can use one terminal-result channel.

## Events and durable delivery

Every run owns its event sequencer. Event sequence numbers start at zero and increase across Execution, Evaluation, Analysis, Decision, and Report materialization. Events are serializable and contain stable identities, status, coverage, and reason codes rather than provider secrets.

The async iterable is a bounded, single-consumer progress channel. It never backpressures authoritative evaluation work and drops the oldest buffered event when a consumer falls behind. Consume it concurrently with `run.result` when complete live progress matters.

For lossless persistence, configure `MeasurementPolicy.eventDelivery` and inject `eventWriter` in the run options. The sealed writer mode, backpressure mode, and failure mode define whether durable delivery can fail the run; the in-memory stream remains observational.

## Isolation and side effects

Importing the package root does not read user configuration, initialize CLI or Studio components, create files, write output, or register process hooks. A pure-memory run accesses only the ports supplied by the host. OMK does not provide queues, tenant isolation, cross-process retries, or untrusted-code sandboxing through this API.

See the complete independent-host acceptance fixture in [`test/evaluation-core/fixtures/embedded-host.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/evaluation-core/fixtures/embedded-host.mjs).
