# Embed OMK in a Node.js service

Use `oh-my-knowledge/eval-runtime` when your service already owns business invocation, credentials, tenancy, queues, and storage, and you want OMK to own the evaluation plan, measurement, comparison, and report.

## Choose the right entry point

| Need | Use |
|---|---|
| Evaluate repository samples with OMK-managed provider configuration and persisted reports | OMK CLI |
| Embed an in-memory evaluation in a FaaS or Node.js service | `oh-my-knowledge/eval-runtime` |
| Build custom stage orchestration, artifact admission, replay, or comparability | `oh-my-knowledge/eval-core` |

`eval-runtime` is an adoption layer, not a service framework. Your host still owns authentication, tenant isolation, model gateways, queues, databases, and operational controls. Importing it does not load the CLI, Studio, MCP, provider adapters, or user configuration.

> **`1.0.0-beta` migration:** the canonical entry now exports only everyday host APIs. Import lifecycle adapters, support-port types, raw Rubric factories, clock helpers, and the legacy `ExecutorFn` bridge from `oh-my-knowledge/eval-runtime/advanced`. Import source-neutral trace and Rubric wire schemas from `oh-my-knowledge/eval-runtime/contracts`. Deep implementation paths remain private.

## Ten-minute exact-match comparison

The package is ESM-only and requires Node.js 22 or newer. Install it in the service:

```bash
npm install oh-my-knowledge zod
```

Create one identity for the deployed invocation implementation. Every field below is measurement-relevant and becomes part of the sealed Runtime fingerprint:

```ts
import { z } from 'zod';
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createExactMatchEvaluator,
  createInvokeExecutorIdentity,
  createJsonExecutorAdapter,
  createMeasurementPolicy,
  runEvaluation,
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

Use any runtime schema with a `parse(unknown)` method to narrow input, Target config, and output. This example uses Zod. The adapter passes Core's `AbortSignal`, continues to use `omk.invoke/v1`, and does not add another invocation protocol. Use a factory because both Targets bind the same implementation but require independent lifecycle scopes:

```ts
const createExecutor = () => createJsonExecutorAdapter({
  identity,
  inputParser: z.object({ prompt: z.string() }).strict(),
  targetConfigParser: z.object({ deployment: z.string() }).strict(),
  outputParser: z.string(),
  outputClassification: 'sensitive',
  async invoke({ input, targetConfig, signal }) {
    const response = await modelGateway.generate({
      deployment: targetConfig.deployment,
      prompt: input.prompt,
      signal,
    });
    return {
      invocationStatus: 'completed',
      output: response.text,
      usage: {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        totalTokens: response.inputTokens + response.outputTokens,
      },
    };
  },
});

const runtime = createEvaluationRuntime({
  executors: [{
    implementationId: identity.implementationId,
    createPort: createExecutor,
  }],
  evaluators: [{ port: createExactMatchEvaluator() }],
});
```

Parser return types flow into `invoke`, so no `as` casts are needed. Parsers also form the runtime trust boundary: invalid sample input, Target config, output, usage, or trace becomes a stable redacted execution failure. Parsers may validate and narrow but may not coerce, add defaults, or drop fields; any JSON transform is rejected so the effective invocation cannot drift silently under the same Runtime identity. Perform an intentional transform inside `invoke`, with the corresponding implementation revision covered by identity. Hosts that already implement OMK's existing `ExecutorFn` can continue to import `createExecutorFnAdapter` from `oh-my-knowledge/eval-runtime/advanced`; it is not the recommended entry for a new service integration.

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

Use `runEvaluation` by default. It owns the bounded event-stream consumer; omit `onEvent` when progress is not needed, or provide it for ordered progress updates:

```ts
const result = await runEvaluation({
  runtime,
  definition,
  policy,
  runId: crypto.randomUUID(),
  onEvent: publishProgress,
});

if (result.status === 'failed') throw new Error(result.error.code);
await reportStore.put(result.report);
```

`onEvent` is an ordered progress observer, not durable delivery. Its failure does not change the measurement result: the helper stops subsequent callbacks, keeps draining and cleans up the Runtime, then throws `EvaluationEventConsumptionError` with the terminal Core `runResult`. Only the caller's `AbortSignal` cancels the evaluation. Use `eventWriter` for durable delivery governed by Core failure policy. Hosts that need to inspect the sealed plan before scheduling can still call `createEvaluationEngine(runtime).prepare(definition, policy)`.

The random `runId` distinguishes executions and affects artifact identity; it is not part of the measurement plan. Rebuilding the same Definition, Policy, and Runtime identity with the same explicit seed produces the same `runContractDigest`.

## Build a service or RAG comparison

`createExactMatchDefinition` is the shortest path when output equality is the metric. For service or RAG evaluations with a custom deterministic metric or Rubric Judge, use `createPairedComparisonDefinition`. It accepts one Evaluator fragment and its matching Metric fragment, and returns the ordinary serializable Core `EvaluationDefinition` rather than a second runtime-specific contract:

```ts
import { createPairedComparisonDefinition } from 'oh-my-knowledge/eval-runtime';

const definition = createPairedComparisonDefinition({
  datasetId: 'retrieval-regression',
  seed: 'index-release-42',
  samples,
  control: {
    targetId: 'control',
    targetKind: 'rag',
    executorId: identity.implementationId,
    config: { indexRevision: 'baseline' },
  },
  treatment: {
    targetId: 'treatment',
    targetKind: 'rag',
    executorId: identity.implementationId,
    config: { indexRevision: 'candidate' },
  },
  evaluator,
  metric,
});
```

The builder deliberately supports one higher-is-better numeric or boolean metric with `exclude/v1`. Use the lower-level `oh-my-knowledge/eval-core` contract for multi-metric graphs, lower-is-better metrics, or a different missing-data policy instead of silently approximating those designs.

## Add a Rubric Judge through an internal model gateway

The host provides one model invocation port. OMK owns the frozen prompt, output parsing, 1–5 metric contract, evidence, failure semantics, and Evaluator identity. The port must not retry: Core already owns retry, timeout, budget, cache, and cancellation.

```ts
import {
  createRubricJudgeKit,
  createRuntimeIdentity,
  type OmkLlmJudgeInvocationPort,
} from 'oh-my-knowledge/eval-runtime';

const gatewayIdentity = createRuntimeIdentity({
  implementationId: 'acme.model-gateway/v1',
  version: '2026.09.03',
  capabilities: { invocation: 'single-call', cancellation: 'cooperative' },
  fingerprintFacets: { deploymentRevision: 'sha256:...' },
});
const invocation: OmkLlmJudgeInvocationPort = {
  identity: gatewayIdentity,
  providerCost: { reporting: 'optional' },
  async invoke(request) {
    const response = await internalGateway.generate({
      model: request.model,
      system: request.system,
      prompt: request.prompt,
      signal: request.signal,
    });
    return { invocationStatus: 'completed', output: response.text, usage: response.usage };
  },
};
const judge = createRubricJudgeKit({
  evaluatorId: 'correctness-judge',
  metricId: 'correctness-score',
  model: 'judge-model',
  effort: 'low',
  invocation,
});
const criterion = judge.createCriterion({
  criterionId: 'correctness',
  prompt: 'Capital of France?',
  rubric: 'The answer must state Paris.',
});
```

Let the kit place `criterion` at its sealed path in each sample's `evaluationContext`, then use the matching serializable fragments and Runtime registration:

```ts
const runtime = createEvaluationRuntime({
  executors: [/* business Target registrations */],
  evaluators: [judge.evaluatorRegistration],
});

const definition = createPairedComparisonDefinition({
  datasetId: 'rubric-release-gate',
  seed: 'rubric-release-42',
  samples: samples.map((sample) => ({
    ...sample,
    evaluationContext: judge.createEvaluationContext(criterion),
  })),
  control: {
    targetId: 'control',
    executorId: identity.implementationId,
    config: { deployment: 'baseline' },
  },
  treatment: {
    targetId: 'treatment',
    executorId: identity.implementationId,
    config: { deployment: 'candidate' },
  },
  evaluator: judge.evaluatorDefinition,
  metric: judge.metricDefinition,
});
```

The kit captures one provider identity and invocation method, then derives its instrument, prompt hash, criterion JSON Pointer, runtime config, Evaluator identity, Metric and registration from that frozen setup. `createEvaluationContext()` materializes the exact context shape, so the host never synchronizes that pointer by hand. When one Definition contains multiple Rubric evaluators, use `createRubricJudgeRegistration([firstKit, secondKit])` for the Runtime and `createRubricJudgeEvaluationContext([{ kit: firstKit, criterion: first }, { kit: secondKit, criterion: second }])` for each sample. Use `tracePolicy: 'source-neutral'` only when every Target produces the public `SourceNeutralTrace` contract from `oh-my-knowledge/eval-runtime/contracts`; otherwise keep the default `none`. Invalid JSON, malformed or out-of-range scores, and missing reasons become structured invalid observations rather than zero scores. Provider failures retain accounting facts but redact provider-private details. Omitting the Judge registration performs no provider discovery, credential lookup, or preflight.

## Advanced hosts

Register raw Core Executor or Evaluator ports with `{ port }` when one Definition binding owns them. Register `{ implementationId, createPort }` when multiple Targets or Evaluators share an implementation; each binding then gets an isolated run lifecycle. A declared `versionConstraint` fails closed unless its registration supplies `satisfiesVersionConstraint`.

Use `createSameProcessExecutorAdapter` and `createSameProcessEvaluatorAdapter` from `oh-my-knowledge/eval-runtime/advanced` for custom in-process ports. That subpath also contains the legacy `createExecutorFnAdapter`, raw Rubric assembly factories, clock and registration SPI. Runtime wire contracts and schema descriptors live at `oh-my-knowledge/eval-runtime/contracts`. Use `oh-my-knowledge/eval-core` when you need staged execution, persisted artifact admission, custom Analysis Runtime implementations, or explicit cross-run comparability. Deep imports outside `package.json#exports` are unsupported. See [Embedded Evaluation Core API](/reference/embedded-api) and the [eval-runtime API layers](/reference/eval-runtime-api).

Before accepting a new Executor adapter, run `runExecutorConformance({ implementationId, createExecutor, success, failure, cancellation })` from `oh-my-knowledge/eval-runtime`. It exercises distinct binding instances, balanced run／trial cleanup, the original `AbortSignal`, telemetry declarations, stable structured failures, exact-match observation, paired analysis, and Decision through three real Core runs. The cancellation callback must remain bounded if it ignores cancellation because the in-process probe does not isolate hostile code. Use `assertExecutorConformance(result)` in an adapter test to fail with stable check IDs. The probe performs no filesystem, network, credential, or environment discovery by itself.

Start with the runnable [minimal public example](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/eval-runtime). Package fixtures additionally cover a [host-owned Rubric Judge gateway](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/rubric-judge-host.mjs) and an [advanced five-stage host](https://github.com/lizhiyao/oh-my-knowledge/blob/main/test/eval-runtime/fixtures/advanced-host.mjs). CI executes the public example and fixtures against the packed package from an isolated home directory.
