# Configure evaluation execution and storage

Complete the [service integration guide](./eval-runtime.md) first. Consult the sections you need; this is not a required linear tutorial.

Code fragments use `input`, `variants` and application clients from the [complete integration example](./eval-runtime-scoring.md#exact-match-evaluation) or your application; these are not OMK-provided services.

<a id="executor-contract"></a>

## Service inputs, errors, and credentials

`executor.execute()` receives `variantId` in addition to the values in the [integration example](./eval-runtime-scoring.md#exact-match-evaluation). Comparison roles belong to `comparisons`, not to the Executor invocation. Return `{ errorCode }` for an expected, stable, non-sensitive host failure; throwing an ordinary error becomes the redacted `EVAL_RUNTIME_EXECUTOR_FAILED` failure.

Schemas validate and narrow only. OMK rejects parsers that coerce, add defaults, or drop JSON fields, because that would silently change the measured invocation under the same identity. Perform intentional transformations inside `execute()` and bump `version` or a measurement-relevant `fingerprintFacets` value.

Variant `config` and `runtimeContext` are serialized into the sealed Definition. Put only reproducible, non-secret measurement inputs there. Credentials, clients, and process-local resources stay in the Executor closure and never enter the Definition.
<a id="reference-evidence-and-host-content-storage"></a>

## Store larger or sensitive outputs in your own storage

By default, actual outputs, traces, and scoring evidence are embedded in the run result (`full`). Choose `reference` for larger content or content whose access belongs in your own storage: you store and retrieve it, and OMK keeps a verifiable reference. Scoring must still read referenced content, so supply both `contentStore` and `contentResolver`. Replace `objectStore` below with your storage implementation:

```ts
import { checkContentStore, type ContentResolver, type ContentStore } from 'oh-my-knowledge';

const contentStore: ContentStore = {
  async put(request) {
    // Verify request.digest, persist the canonical JSON value, and return its descriptor.
    return objectStore.putVerified(request);
  },
};

const contentResolver: ContentResolver = {
  async resolve(descriptor) {
    return objectStore.resolveVerified(descriptor);
  },
};

const storageCheck = await checkContentStore({ contentStore, contentResolver });
if (!storageCheck.conformant) throw new Error('Content storage is not conformant.');

const result = await evaluate({
  ...input,
  policy: {
    ...input.policy,
    evidence: {
      output: 'reference',
      trace: 'digest',
      evaluatorEvidence: 'reference',
      maximumClassification: 'sensitive',
    },
  },
  infrastructure: { contentStore, contentResolver },
});
```

`checkContentStore()` writes the same fixed public probe twice and resolves it once; the stable reason codes retain neither payloads nor host exception text. `full` embeds the canonical JSON value, `reference` persists it and records a verified descriptor, `digest` keeps only the canonical value digest, and `none` omits the capture. These choices are independent for output, trace, and `evaluatorEvidence`. A capture above `maximumClassification` fails closed. If an Evaluator declares output or trace as an input, that capture must remain `full` or `reference`; reference input also requires a resolver. OMK validates these dependencies during prepare, before any Target call. Store implementations and credentials never enter the Definition. A returned descriptor does enter the run artifact, so any optional `uri` must be a stable, opaque, credential-free locator rather than a physical path or signed URL; the host remains responsible for authorization and size limits.

The check waits at most five seconds for each operation by default; set `timeoutMs` explicitly when the storage service has a different local SLO. Content ports do not expose cancellation, so the host remains responsible for stopping an operation after a timeout.
<a id="reuse-execution-and-evaluation-results"></a>

## Use caches to reduce repeated calls

Repeated runs can reuse system outputs (execution cache) or scoring results (evaluation cache) separately. Both are off by default and require your cache storage. Execution reuse requires a deterministic executor with independently verified identity; it is not a way to reuse arbitrary stochastic outputs. If only scoring or analysis changed, start with [stage reuse](./eval-runtime-experiments.md#reuse-stages).

Prepare `cacheableInput` for a deterministic executor; do not reuse a stochastic model configuration directly. Your application also supplies the caches and deployment verifier below. OMK derives keys, validates records, and tracks where reused data came from:

```ts
import type {
  EvaluationCache,
  ExecutionCache,
  ExecutorIdentityVerifier,
} from 'oh-my-knowledge';

const executionCache: ExecutionCache = durableExecutionCache;
const evaluationCache: EvaluationCache = durableEvaluationCache;
const executorIdentityVerifier: ExecutorIdentityVerifier = {
  verifierId: 'acme.signed-deployment-registry/v1',
  async verify({ executor, declaredIdentity }) {
    const attestation = await deploymentRegistry.verifyCallable({
      implementation: executor,
      declaredIdentity,
    });
    return { attestationDigest: attestation.digest };
  },
};

const cached = await evaluate({
  ...cacheableInput,
  policy: {
    ...cacheableInput.policy,
    cache: { execution: 'reuse', evaluation: 'reuse' },
  },
  infrastructure: {
    executionCache,
    evaluationCache,
    executorIdentityVerifier,
  },
});
```

`execution: 'reuse'` reuses a hit, executes on a miss, and writes the completed result. It accepts only an Executor declared deterministic, and an independent verifier must bind the captured callable, dependencies, and deployment configuration to a stable attestation. `checkExecutor()` checks behavioral conformance; it does not upgrade a self-reported identity to verified. A verifier must not merely echo `declaredIdentity`. `execution: 'replay-only'` never writes and fails before calling the Target if any coordinate misses, making it suitable for explicit offline replay. `evaluation: 'reuse'` independently reuses completed evaluation records.

`prepareEvaluation()` fails closed when a required cache port or the verifier needed for transparent Execution reuse is absent. Cache implementations and credentials never enter the Definition. `ExecutionCacheEntry` and `EvaluationCacheEntry` are public types, but hosts must not relax or replace Core entry validation. A changed implementation, workspace, tool policy, evaluation input, or measurement policy invalidates the affected cache through sealed identity.
<a id="run-progress"></a>

## Receive progress and cancel a run

Use the second `evaluate()` argument for progress events and a cancellation signal. Keep `controller` in your cancel-button or request lifecycle handler, and call `controller.abort()` when cancellation is requested.

```ts
const controller = new AbortController();
const running = evaluate(input, {
  signal: controller.signal,
  onEvent(event) { console.log(event); },
});
const result = await running;
```

Progress events are for observation and may be dropped; use the returned `result` for the final conclusion. They are not a durable audit log.

`runId`, `signal`, `onEvent`, `clock`, report annotations／summaries, and `eventBufferCapacity` belong to the optional second `EvaluationRunOptions` argument; they are not measurement declarations. `onEvent` is a best-effort progress observer. Delivered events remain ordered, but a slow observer does not backpressure measurement: the bounded Core stream drops the oldest pending progress event and retains recent progress, so sequence gaps are expected. `eventBufferCapacity` controls that memory bound and defaults to 256. An observer failure throws `EvaluationEventConsumptionError` after cleanup and retains the terminal `runResult`; the canonical façade redacts the host callback's original error. Durable, lossless event delivery is intentionally absent from `evaluate()`; advanced hosts pair `runEvaluation()` with an explicit `createMeasurementPolicy({ eventDelivery: ... })` and `eventWriter`. The caller's `AbortSignal` controls cancellation.
<a id="production-policy"></a>

## Set concurrency, timeouts, retries, and budgets

Set `policy` to fit your real service capacity and costs. `execution` limits calls to the system under test; `evaluation` limits scorer or judge calls. Configure them separately. These numbers illustrate configuration and need adjustment for your service; `maxAttempts: 3` includes the initial call and up to two retries. Budgets check reported usage, so concurrent calls may finish above a monetary limit.

```ts
policy: {
  execution: {
    maxConcurrency: 8,
    timeoutMs: 30_000,
    retry: {
      maxAttempts: 3,
      retryableErrorCodes: ['rate-limit', 'timeout'],
      backoff: {
        backoffKind: 'exponential',
        initialDelayMs: 250,
        maxDelayMs: 5_000,
      },
    },
  },
  evaluation: {
    maxConcurrency: 4,
    timeoutMs: 10_000,
    retry: {
      maxAttempts: 2,
      retryableErrorCodes: ['judge-rate-limit'],
      backoff: { backoffKind: 'fixed', initialDelayMs: 200 },
    },
  },
  failure: { failureMode: 'failure-threshold', maxFailures: 2 },
  budget: {
    run: {
      maxInvocations: 1_000,
      maxActiveDurationMs: 300_000,
      maxWallClockMs: 600_000,
      maxProviderCost: { amount: 20, currency: 'USD' },
    },
    execution: { maxInvocations: 800, maxProviderCost: { amount: 12, currency: 'USD' } },
    evaluation: { maxInvocations: 200, maxProviderCost: { amount: 8, currency: 'USD' } },
    coordinate: { maxInvocations: 4 },
    attempt: { maxProviderCost: { amount: 0.25, currency: 'USD' } },
    onUnreportedProviderCost: 'fail-run',
  },
  evidence: { maximumClassification: 'sensitive' },
},
```

`maxAttempts` includes the first attempt. A host-defined, stable error code is retried only when explicitly listed; ordinary thrown errors remain redacted and are not silently classified as retryable. `none` retries immediately, `fixed` uses one delay, and `exponential` grows from `initialDelayMs` up to the optional `maxDelayMs`. `continue` and `fail-fast` do not accept `maxFailures`; `failure-threshold` requires it and stops future scheduling blocks after completed failures exceed the threshold.

Budgets are hierarchical and auditable. `run` covers execution and evaluation together; `execution` and `evaluation` limit their respective stages; `coordinate` applies to each Target／Sample／Trial coordinate; and `attempt` limits the reported provider cost of one attempt. Invocation limits include retries. `maxActiveDurationMs` sums completed attempt durations, while run-only `maxWallClockMs` measures elapsed monotonic time, including queueing and backoff. Every configured provider-cost limit in one run must use the same three-letter uppercase currency.

The canonical façade uses Core's `bounded-overshoot` admission. It checks accumulated reported cost before admitting more work, but it is not a pre-invocation hard monetary cap: already admitted concurrent calls can finish above a limit, and the signed budget summary records that overshoot. Use `onUnreportedProviderCost: 'fail-run'` when missing provider cost must fail closed; the default `mark-unverifiable` preserves the run while marking cost verification indeterminate. Attempt cost is also evaluated from reported usage after the call; stage `timeoutMs`, not the attempt budget, bounds attempt duration.

Defaults are execution／evaluation concurrency 4, no timeout, no retry, failure `continue`, `run.maxInvocations` 10,000, no other budget limits, `onUnreportedProviderCost: 'mark-unverifiable'`, and maximum classification `gold`.
<a id="check-runtime-components"></a>

## Check whether your integration meets OMK requirements

After implementing an executor or scorer, use `checkRuntime()` to check behavior such as success, failure, cancellation, and cleanup. It actually invokes the component, so use dedicated test inputs and disposable resources. Supply the three inputs below: one successful case, one producing the expected error code, and one exercising cancellation.

```ts
import { checkRuntime } from 'oh-my-knowledge';

const runtimeCheck = await checkRuntime({
  runtimeKind: 'executor',
  variant: variants[1],
  success: { input: successInput, expected: expectedOutput },
  failure: { input: failureInput, expectedErrorCode: 'model-unavailable' },
  cancellation: { input: longRunningInput },
});

if (!runtimeCheck.conformant) console.error(runtimeCheck.checks);
```

The `runtimeKind` discriminator also selects `evaluator`, `judge`, `cache`, `content-store`, or `workspace-provider`. `checkExecutor()` and `checkContentStore()` remain focused convenience entries backed by the same existing probes. Invalid declarations reject with `EVAL_RUNTIME_INPUT_INVALID`; host behavioral failures return `conformant: false` with stable reason codes. A passing check does not upgrade self-reported Runtime identity or prove the quality of a model provider. Run the intended component composition through a real `evaluate()` afterward.

The cancellation case must remain bounded if the implementation ignores its signal; an in-process check cannot contain hostile code. Evaluation-cache, Custom Evaluator, and Judge checks exercise overlapping calls through Core; execution-cache behavior is checked on Core's current serial read path without claiming more. Cache and ContentStore checks perform writes, so use disposable resources and a unique `probeNamespace` for cache checks. Workspace checks observe lease isolation, retry reuse, and cleanup but cannot prove physical deletion or sandboxing; `timeoutMs` bounds the check's cleanup wait but cannot stop the provider's underlying promise. Judge checks make up to four provider calls and may incur cost; they require `allowExternalCalls: true`, and every `publicProbeText` is sent to the provider and must be harmless public data. The result reports measured invocation and provider-cost totals. Stable results retain none of the probe payload, provider exception text, prompt, model output, cache entries, workspace roots, locators, or credentials.
<a id="advanced-integration-and-migration"></a>

## When to use advanced APIs

Most applications can use `evaluate()` and the [scoring methods](./eval-runtime-scoring.md) from the package root. Use advanced APIs when you need custom component lifecycles, staged runtime assembly, or lower-level measurement capabilities. Existing code that uses the functions below should import them from the `advanced` subpath:

```ts
import {
  createEvaluationRuntime,
  createExactMatchDefinition,
  createJsonExecutorAdapter,
  runEvaluation,
} from 'oh-my-knowledge/eval-runtime/advanced';
```

The explicit `oh-my-knowledge/eval-runtime` subpath exposes the same canonical façade as the package root. Use `oh-my-knowledge/eval-runtime/advanced` for custom ports, staged host assembly, or the legacy `ExecutorFn` bridge; use `oh-my-knowledge/eval-runtime/contracts` for versioned wire schemas; use `oh-my-knowledge/eval-core` for multi-metric graphs, custom Analysis Runtime implementations, artifact replay, transported cross-process comparability, or custom comparability policies. `eval-workflows` depends on the leaf runtime foundation modules, never on either user façade. Deep paths outside `package.json#exports` are private.

The runnable [minimal example](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/eval-runtime) and packed-package fixtures exercise the canonical API in a clean host.
