# Embed OMK in a Node.js service

Use the `oh-my-knowledge` package root when your application owns model invocation and OMK should own measurement, comparison, and reporting. The ordinary integration has one entry point:

```ts
import { evaluate } from 'oh-my-knowledge';
```

The package is ESM-only and requires Node.js 22 or newer. It does not discover credentials, providers, files, environment variables, CLI configuration, or Studio state.

## The evaluation vocabulary

`evaluate()` uses the same terms as the rest of OMK:

| Term | Meaning |
|---|---|
| artifact | The knowledge object being changed: a prompt, skill, agent, workflow, or an empty baseline. |
| variant | One named artifact plus its runtime context and Executor config. |
| control／treatment | Experiment roles. Either role may contain any artifact kind; `baseline` is not an alias for `control`. |
| dataset／sample | The evaluation inputs and expected or evaluation context. |
| executor | Host code that runs an artifact for one sample. |
| evaluator | The measurement method, such as exact match or a Rubric Judge. |
| experiment／policy | Statistical design and operational limits. |
| result | The Core run artifacts, evidence, Decision, and Report. |

Core's compiled `Target` remains an internal execution concept. It is not a second public name for artifact or variant.

In one sentence: the Executor runs the artifact; the Evaluator evaluates the result.

## Exact-match evaluation

Install OMK and a runtime schema library. A schema only needs a `parse(unknown)` method; this example uses Zod:

```bash
npm install oh-my-knowledge zod
```

```ts
import { z } from 'zod';
import { evaluate } from 'oh-my-knowledge';

const result = await evaluate({
  executor: {
    executorId: 'acme.answer-service/v1',
    version: '1.4.0',
    schemas: {
      input: z.object({ prompt: z.string() }).strict(),
      config: z.object({ deployment: z.string() }).strict(),
      output: z.string(),
    },
    outputClassification: 'sensitive',
    capabilities: {
      determinism: 'stochastic',
      cancellation: 'cooperative',
      concurrency: { safety: 'parallel-safe', maxInFlight: 16 },
      seedControl: 'unsupported',
      telemetry: { trace: 'unsupported', usage: 'required' },
    },
    fingerprintFacets: { deploymentRevision: 'sha256:...' },
    async execute({ input, artifact, config, runtimeContext, signal }) {
      const response = await modelGateway.generate({
        deployment: config.deployment,
        prompt: `${artifact.content ?? ''}\n${input.prompt}`,
        context: runtimeContext?.values,
        signal,
      });
      return {
        output: response.text,
        usage: response.usage,
      };
    },
  },
  dataset: {
    datasetId: 'answer-regression',
    samples: [
      { sampleId: 'one', input: { prompt: 'Capital of France?' }, expected: 'Paris' },
      { sampleId: 'two', input: { prompt: '2 + 2?' }, expected: '4' },
    ],
  },
  control: {
    variantId: 'prompt-v1',
    artifact: {
      name: 'answer-prompt-v1',
      kind: 'prompt',
      source: 'inline',
      content: 'Answer concisely.',
    },
    config: { deployment: 'deployment-a' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
  treatment: {
    variantId: 'prompt-v2',
    artifact: {
      name: 'answer-prompt-v2',
      kind: 'prompt',
      source: 'inline',
      content: 'Answer concisely and exactly.',
    },
    config: { deployment: 'deployment-b' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
  evaluator: { evaluatorKind: 'exact-match' },
  experiment: {
    seed: 'release-2026-09-04',
    trials: 1,
    bootstrap: { resamples: 1_000, alpha: 0.05 },
  },
  policy: { maxConcurrency: 4 },
  runId: crypto.randomUUID(),
});

if (result.status !== 'completed') throw new Error(result.error.code);
await reportStore.put(result.report);
```

`result.definition` and `result.policy` are the exact sealed Core Definition and fully materialized Measurement Policy compiled by the façade. The unchanged Core run result fields keep evidence in `result.artifacts`, Decision in `result.artifacts.decision`, and Report in `result.report`.

`executor.execute()` receives the explicit `experimentRole` and `variantId` in addition to the values shown above. Return `{ errorCode }` for an expected, stable, non-sensitive host failure; throwing an ordinary error becomes the redacted `EVAL_RUNTIME_EXECUTOR_FAILED` failure.

Schemas validate and narrow only. OMK rejects parsers that coerce, add defaults, or drop JSON fields, because that would silently change the measured invocation under the same identity. Perform intentional transformations inside `execute()` and bump `version` or a measurement-relevant `fingerprintFacets` value.

Variant `config` and `runtimeContext` are serialized into the sealed Definition. Put only reproducible, non-secret measurement inputs there. Credentials, clients, and process-local resources stay in the Executor closure and never enter the Definition.

`exact-match` compares the canonical JSON value of the actual output with the sample's `expected` value. It is not byte-for-byte string comparison.

`onEvent` is an optional, best-effort progress observer. Delivered events remain ordered, but a slow observer does not backpressure measurement: the bounded Core stream drops the oldest pending progress event and retains recent progress, so sequence gaps are expected. `eventBufferCapacity` controls that memory bound and defaults to 256. An observer failure throws `EvaluationEventConsumptionError` after cleanup and retains the terminal `runResult`; the canonical façade redacts the host callback's original error. Durable, lossless event delivery is intentionally absent from `evaluate()`; advanced hosts pair `runEvaluation()` with an explicit `createMeasurementPolicy({ eventDelivery: ... })` and `eventWriter`. The caller's `AbortSignal` controls cancellation.

## Rubric Judge evaluation

Use `evaluatorKind: 'rubric-judge'` when exact equality is not meaningful. The host provides one model call; OMK owns the frozen prompt, output parser, 1–5 metric, evidence, retry, timeout, budget, and cancellation semantics:

```ts
const result = await evaluate({
  executor,
  dataset,
  control,
  treatment,
  evaluator: {
    evaluatorKind: 'rubric-judge',
    evaluatorId: 'correctness-judge',
    metricId: 'correctness-score',
    model: 'judge-model',
    effort: 'low',
    rubric: {
      criterionId: 'correctness',
      prompt: 'Judge whether the answer is factually correct.',
      rubric: '5 is fully correct; 1 is fully incorrect.',
    },
    judge: {
      judgeId: 'acme.model-gateway/v1',
      version: '2026.09.04',
      providerCost: { reporting: 'optional' },
      fingerprintFacets: { deploymentRevision: 'sha256:...' },
      async invoke(request) {
        const response = await internalGateway.generate({
          model: request.model,
          system: request.system,
          prompt: request.prompt,
          signal: request.signal,
        });
        return { invocationStatus: 'completed', output: response.text, usage: response.usage };
      },
    },
  },
  experiment: { seed: 'rubric-release-42' },
  policy: {},
  runId: crypto.randomUUID(),
});
```

The Judge callback performs exactly one provider invocation and must not retry. Provider failures retain valid accounting facts while removing provider-private reasons and usage details. Use `tracePolicy: 'source-neutral'` only when every Executor returns the versioned trace contract from `oh-my-knowledge/eval-runtime/contracts`.

## Certify an Executor

Run `checkExecutor()` before adopting an adapter. It drives the same declaration through real successful, failed, and cancelled Core runs, and checks binding isolation, lifecycle cleanup, telemetry, observations, paired analysis, and Decision:

```ts
import { checkExecutor } from 'oh-my-knowledge';

const certification = await checkExecutor({
  executor,
  variant: treatment,
  success: { input: successInput, expected: expectedOutput },
  failure: { input: failureInput, expectedErrorCode: 'model-unavailable' },
  cancellation: { input: longRunningInput },
});

if (!certification.conformant) console.error(certification.checks);
```

The cancellation input must remain bounded if the implementation ignores its signal; the in-process check does not isolate hostile code.

## Advanced integration and migration

The canonical entry intentionally does not export Core builders, Runtime registration, adapter lifecycle SPI, or raw Rubric factories. Existing integrations should move those imports without changing behavior:

```ts
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createJsonExecutorAdapter,
  runEvaluation,
} from 'oh-my-knowledge/eval-runtime/advanced';
```

The explicit `oh-my-knowledge/eval-runtime` subpath exposes the same canonical façade as the package root. Use `oh-my-knowledge/eval-runtime/advanced` for custom ports, staged host assembly, or the legacy `ExecutorFn` bridge; use `oh-my-knowledge/eval-runtime/contracts` for versioned wire schemas; use `oh-my-knowledge/eval-core` for multi-metric graphs, custom Analysis Runtime implementations, artifact replay, or explicit cross-run comparability. `eval-workflows` depends on the leaf runtime foundation modules, never on either user façade. Deep paths outside `package.json#exports` are private.

The runnable [minimal example](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/eval-runtime) and packed-package fixtures exercise the canonical API in a clean host.
