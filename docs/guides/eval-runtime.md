# Embed OMK in a Node.js service

Use `oh-my-knowledge/eval-runtime` when your service already owns business invocation, credentials, tenancy, queues, and storage, and you want OMK to own the evaluation plan, measurement, comparison, and report.

## Choose the right entry point

| Need | Use |
|---|---|
| Evaluate repository samples with OMK-managed provider configuration and persisted reports | OMK CLI |
| Embed an in-memory evaluation in a FaaS or Node.js service | `oh-my-knowledge/eval-runtime` |
| Build custom stage orchestration, artifact admission, replay, or comparability | `oh-my-knowledge/eval-core` |

`eval-runtime` is an adoption layer, not a service framework. Your host still owns authentication, tenant isolation, model gateways, queues, databases, and operational controls. Importing it does not load the CLI, Studio, MCP, provider adapters, or user configuration.

## Ten-minute exact-match comparison

The package is ESM-only and requires Node.js 22 or newer. Install it in the service:

```bash
npm install oh-my-knowledge
```

Create one identity for the deployed invocation implementation. Every field below is measurement-relevant and becomes part of the sealed Runtime fingerprint:

```ts
import { createEvaluationEngine } from 'oh-my-knowledge/eval-core';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createExecutorFnAdapter,
  createInvokeExecutorIdentity,
  createMeasurementPolicy,
} from 'oh-my-knowledge/eval-runtime';

const identity = createInvokeExecutorIdentity({
  implementationId: 'acme.answer-service/v1',
  version: '1.4.0',
  determinism: 'stochastic',
  cancellation: 'cooperative',
  concurrency: { safety: 'parallel-safe', maxInFlight: 16 },
  seedControl: 'unsupported',
  telemetry: { trace: 'unsupported', usage: 'required' },
  fingerprintFacets: { deploymentRevision: 'sha256:...' },
});
```

Adapt the existing OMK `ExecutorFn`. The adapter passes Core's `AbortSignal`; it does not add another invocation protocol. Use a factory because both Targets bind the same implementation but require independent lifecycle scopes:

```ts
const executorFn = async ({ model, prompt, abortSignal }) => {
  const response = await modelGateway.generate({
    deployment: model,
    prompt,
    signal: abortSignal,
  });
  return {
    ok: true,
    output: response.text,
    durationMs: response.durationMs,
    durationApiMs: response.durationMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    tokenUsageReportedByExecutor: true,
    costUSD: 0,
    costReportedByExecutor: false,
    stopReason: response.stopReason,
    numTurns: 1,
  };
};

const createExecutor = () => createExecutorFnAdapter({
  identity,
  executor: executorFn,
  outputClassification: 'sensitive',
  mapInput: ({ targetConfig, input }) => ({
    model: (targetConfig as { deployment: string }).deployment,
    prompt: (input as { prompt: string }).prompt,
  }),
});

const runtime = createEvaluationRuntime({
  executors: [{
    implementationId: identity.implementationId,
    createPort: createExecutor,
  }],
  evaluators: [{ port: createExactMatchEvaluator() }],
});
```

Build the serializable Definition and Policy. Defaults are materialized into immutable values; the seed is mandatory and never inferred from time, randomness, or environment state:

```ts
const definition = createExactMatchDefinition({
  datasetId: 'answer-regression',
  seed: 'release-2026-09-03',
  samples: [
    { sampleId: 'one', input: { prompt: 'Capital of France?' }, expected: 'Paris' },
    { sampleId: 'two', input: { prompt: '2 + 2?' }, expected: '4' },
  ],
  control: {
    targetId: 'control',
    executorId: identity.implementationId,
    config: { deployment: 'deployment-a' },
  },
  treatment: {
    targetId: 'treatment',
    executorId: identity.implementationId,
    config: { deployment: 'deployment-b' },
  },
});
const policy = createMeasurementPolicy({ maxConcurrency: 4 });
```

Prepare before scheduling, then consume events concurrently with the terminal result:

```ts
const prepared = await createEvaluationEngine(runtime).prepare(definition, policy);
const run = prepared.start({ runId: crypto.randomUUID(), eventBufferCapacity: 256 });
const draining = (async () => {
  for await (const event of run.events) await publishProgress(event);
})();
const result = await run.result;
await draining;

if (result.status === 'failed') throw new Error(result.error.code);
await reportStore.put(result.report);
```

The random `runId` distinguishes executions and affects artifact identity; it is not part of the measurement plan. Rebuilding the same Definition, Policy, and Runtime identity with the same explicit seed produces the same `runContractDigest`.

## Advanced hosts

Register raw Core Executor or Evaluator ports with `{ port }` when one Definition binding owns them. Register `{ implementationId, createPort }` when multiple Targets or Evaluators share an implementation; each binding then gets an isolated run lifecycle. A declared `versionConstraint` fails closed unless its registration supplies `satisfiesVersionConstraint`.

Use `createSameProcessExecutorAdapter` and `createSameProcessEvaluatorAdapter` for custom in-process ports. Use the advanced APIs from `oh-my-knowledge/eval-core` when you need staged execution, persisted artifact admission, custom Analysis Runtime implementations, or explicit cross-run comparability. See [Embedded Evaluation Core API](/reference/embedded-api).

The complete runnable package fixture is in [`test/eval-runtime/fixtures/embedded-host.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/embedded-host.mjs).
