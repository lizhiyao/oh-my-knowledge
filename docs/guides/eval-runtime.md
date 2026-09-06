# Embed OMK in a Node.js service

Use OMK inside an existing Node.js model service, retriever, or Agent to answer: “Did changing the prompt, knowledge base, or workflow improve results?” You provide evaluation samples and call your system; OMK scores outputs, compares results, and builds a report.

Start with `evaluate()`. Use `prepareEvaluation()` when you need to inspect the execution plan before deciding to run it:

```ts
import { evaluate, prepareEvaluation } from 'oh-my-knowledge';
```

The package is ESM-only and requires Node.js 22 or newer. It does not discover credentials, providers, files, environment variables, CLI configuration, or Studio state.

## Where to start

For a first integration, follow “run the example → choose a scoring method → connect your service → read the results.” Use the later cache, workspace, MCP, and session sections as needed.

Run this example from a source checkout. It uses a simulated service and needs no model account or API key:

```bash
yarn install --immutable
yarn build
node examples/eval-runtime/run.mjs
```

The command prints one JSON line: `runStatus: "completed"` means the run finished; `estimate: 0.3333333333333333` means the candidate's exact-match rate is about 33.3 percentage points above the control; `verdict: "NOISE"` means these three teaching samples do not establish improvement. Completing a run, raising a score, and obtaining sufficient release evidence are different outcomes.

In a separate project, install `oh-my-knowledge` and `zod`, copy the [single-file example](https://github.com/lizhiyao/oh-my-knowledge/blob/main/examples/eval-runtime/run.mjs), and run it. Use the corresponding PR checkout for unreleased capabilities. The TypeScript snippets below explain integration points: later snippets reuse earlier variables, and names such as `modelGateway`, `agent`, and storage clients stand for implementations you supply, not services bundled with OMK.

| What do you want to check? | Read | Prepare |
|---|---|---|
| Does output exactly match a fixed answer? | [Exact match](#exact-match-evaluation) | Inputs and expected answers. |
| Is an answer correct, complete, or compliant with requirements? | [LLM scoring criteria](#rubric-judge-evaluation) | Explicit criteria and a judge model integration. |
| Does retrieval find and rank relevant documents? | [Retrieval quality](#retrieval-evaluation) | Ordered returned IDs and labeled relevant IDs. |
| Does the system return nothing when no solution applies? | [Retrieval and empty results](#retrieval-abstention) | Abstention labels and final recommendations. |
| Did an Agent call the required tools? | [Tool-call checks](#tool-trajectory-evaluation) | Normalized call records and expected tools. |
| Does output satisfy your own business rule? | [Custom scoring](#custom-evaluator) | Rule code and its required input fields. |

After connecting your service, [read the results](#read-results), then configure [timeouts, retries, and budgets](#production-policy). Use [component checks](#check-runtime-components) to validate your integration's behavior.

<a id="the-evaluation-vocabulary"></a>

## Names used in the code

An evaluation prepares samples, runs the versions under test, scores their outputs, and summarizes the differences. These fields describe that work:

| Field / term | What you provide or receive |
|---|---|
| `artifact` | The prompt, skill, agent, workflow, or empty baseline being changed. |
| `variant` | An artifact and its execution configuration, such as “old prompt” and “new prompt.” |
| `dataset` / `sample` | Test inputs; `expected` holds answers used for scoring. |
| `executor` | Your invocation code: it receives input and returns actual output. |
| `evaluator` | The scoring method, such as exact match, retrieval metrics, or an LLM judge. |
| `metric` | A reading's name and meaning, such as `correct` for exact equality. |
| `comparison` | The control, candidate (`treatment`), and metrics to compare. |
| `experiment` | Sample allocation, planned repetitions, and measurement seed. |
| `analysis` | How readings become a mean, difference, or confidence interval. |
| `decision` | An optional rule that draws a conclusion from an analysis; a scorer alone does not produce a release conclusion. |
| `policy` | Concurrency, timeouts, retries, budgets, and evidence retention. |
| `result` | Run status, individual evidence, analyses, an optional decision, and a report. |

The executor runs, the evaluator scores, and the analysis summarizes. Below, “host” means your Node.js application, “Core” means OMK's measurement engine, and “sealed” means configuration is fixed before execution. A trial is one planned execution; an attempt is one try within it, so retries increase attempt counts.

## Exact-match evaluation

Use the `exact-match` evaluator when a task must return a fixed answer, a classification label, or structured data. Provide an expected answer in each sample's `expected` field. OMK compares the executor's `output` with it: a match produces `true`, and a mismatch produces `false`. The default metric ID is `correct`. This comparison does not call an LLM judge.

For example, when the expected answer is the string `"Paris"`:

| Actual output | Match? | Reason |
|---|---|---|
| `"Paris"` | Yes | Exactly equals the expected answer. |
| `"The capital of France is Paris"` | No | The meaning is correct, but the content differs. |
| `"Paris."` | No | Contains an extra period. |
| `" Paris "` | No | Contains extra spaces; the evaluator does not trim them. |

This suits tasks that require precise output, such as classification into `"refund"` or `"inquiry"`. For open-ended answers with multiple valid phrasings, consider a [Rubric Judge](#rubric-judge-evaluation) with explicit scoring criteria. Use a [custom evaluator](#custom-evaluator) when you need your own trimming, case folding, or field extraction before comparison.

For JSON output, OMK compares canonical JSON values: object key order does not matter, but array order, value types, and string contents must match. For example, `{"a":1,"b":2}` matches `{"b":2,"a":1}`, while the number `4` does not match the string `"4"`. A string containing JSON is not automatically parsed into an object.

The example below connects a model service, supplies expected answers, and compares the exact-match rates of two prompt versions. `modelGateway` and `reportStore` stand for your own model invocation and report storage code; replace them with your implementations.

Install OMK and a runtime schema library. A schema only needs a `parse(unknown)` method; this example uses Zod:

```bash
npm install oh-my-knowledge zod
```

### 1. Connect your service

The executor declares input, configuration, and output shapes, then calls your service in `execute()`. Declare its actual `capabilities`: a stochastic model is not deterministic, and cooperative cancellation requires forwarding `signal`. Replace the example version and `fingerprintFacets` with identifiers for your implementation.

```ts
import { z } from 'zod';
import { evaluate, type EvaluateInput, type Executor, type Variant } from 'oh-my-knowledge';

type Input = { prompt: string };
type Config = { deployment: string };

const executor: Executor<Input, Config, string> = {
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
};
```

### 2. Declare the versions to compare

Only the prompt changes below; both versions use the same model deployment and execution settings. This isolates the prompt change. If models, knowledge sources, or tools also change, declare them as intentional changes.

```ts
const variants: Variant<Input, Config, string>[] = [{
  variantId: 'prompt-v1',
  artifact: {
    name: 'answer-prompt-v1',
    kind: 'prompt',
    source: 'inline',
    content: 'Answer concisely.',
  },
  execution: {
    executor,
    config: { deployment: 'deployment-a' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
}, {
  variantId: 'prompt-v2',
  artifact: {
    name: 'answer-prompt-v2',
    kind: 'prompt',
    source: 'inline',
    content: 'Answer concisely and exactly.',
  },
  execution: {
    executor,
    config: { deployment: 'deployment-a' },
    runtimeContext: { values: { tenant: 'evaluation' } },
  },
}];
```

### 3. Supply expected answers and run

Sample `input` goes to your service; `expected` is used for scoring. Do not include expected answers in the prompt under test. Both versions answer the same two questions (`paired`), and OMK compares exact-match rates. These two samples demonstrate wiring; real conclusions need representative data and sufficient sample size.

The example service cannot control the model seed, so it explicitly uses `seedCoupling: 'uncontrolled'`. Each sample still runs on both versions, but model randomness is uncontrolled. `experiment.seed` fixes OMK's measurement design; it does not make the model deterministic. The default shared-seed pairing is unsuitable for this executor.

```ts
const input: EvaluateInput = {
  dataset: {
    datasetId: 'answer-regression',
    samples: [
      { sampleId: 'one', input: { prompt: 'Capital of France?' }, expected: 'Paris' },
      { sampleId: 'two', input: { prompt: '2 + 2?' }, expected: '4' },
    ],
  },
  variants,
  evaluators: [{ evaluatorKind: 'exact-match' }],
  comparisons: [{
    comparisonId: 'prompt-v1-vs-v2',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correct'],
  }],
  analyses: [{
    analysisId: 'prompt-v1-vs-v2-correct',
    analysisKind: 'comparison-interval',
    statistic: 'mean-difference',
    comparisonId: 'prompt-v1-vs-v2',
    treatmentVariantId: 'prompt-v2',
    metricId: 'correct',
    confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 1_000 },
  }],
  decision: {
    decisionKind: 'analysis',
    analysisId: 'prompt-v1-vs-v2-correct',
  },
  experiment: {
    seed: 'release-2026-09-04',
    trials: 1,
    sampling: { samplingKind: 'paired', seedCoupling: 'uncontrolled' },
  },
  policy: {
    execution: { maxConcurrency: 4 },
    evaluation: { maxConcurrency: 4 },
  },
};
const result = await evaluate(input);

if (result.status === 'failed') throw new Error(result.error.code);
if (result.status !== 'completed') throw new Error(`Evaluation did not complete: ${result.status}`);
await reportStore.put(result.report);
```

<a id="read-results"></a>

## Read the results

Check run and analysis statuses before reading scores. `result.status === 'completed'` means the workflow finished; it does not mean every invocation succeeded or the candidate is ready to release.

| Location | How to interpret it |
|---|---|
| `result.analysisResults[analysisId]` | The analysis you requested; check `analysisStatus` before reading `value`. |
| Analysis `coverage` | Planned and included observations, missing data, invalid outputs, and failed executions. Paired comparisons also require usable pairs. |
| The example analysis's `value.estimate` | Candidate minus control exact-match rate. `0.1` means 10 percentage points higher, not a 10% relative increase. |
| Interval and analysis status | A positive estimate may still fail to establish improvement; `inconclusive` means insufficient evidence, not a zero score. |
| `result.artifacts.decision` | Status and conclusion when a decision rule was configured; it does not merge or release anything. |
| `result.report` | Pass it to your own report storage or presentation code. |

An evaluator produces individual readings. Declare `analyses` to obtain means or intervals, then add `decision` if you need a rule-based conclusion. Do not count missing or failed responses as correct, or overlook execution failures because successful responses score well.

### When results are unexpected

| Symptom | Check first |
|---|---|
| `EVAL_RUNTIME_INPUT_INVALID` before execution | Data/schema agreement, referenced IDs, and declared executor capabilities. See the [API reference](../reference/eval-runtime-api.md) for field requirements. |
| Scores exist but the desired mean or interval does not | Declare that metric and variant in `analyses`; `comparisons` only declares comparison relationships. |
| A semantically correct answer fails exact match | Look for extra wording, spaces, or punctuation; choose another scorer if multiple phrasings are acceptable. |
| Increasing `sourceUnavailable` or `invalid` counts | For the former, inspect failed calls and missing output; for the latter, check output and label validity. |
| An analysis is `inconclusive` | Read its `reasonCodes` and `coverage` for insufficient usable samples, pairs, or evidence. |
| You need to stop a run | Supply an `AbortSignal` and make the real invocation honor it; see [progress and cancellation](#run-progress). |

### Keep the measurement record

`result.runId` is the effective run identity generated by OMK unless supplied in the optional second argument. `result.definition` and `result.policy` are the exact sealed Core Definition and fully materialized Measurement Policy compiled by the façade. `result.analysisResults[analysisId]` is a read-only index of the same Core Analysis records; it does not recompute statistics. The unchanged Core run result fields keep evidence in `result.artifacts`, Decision in `result.artifacts.decision`, and Report in `result.report`.

<a id="prepare-plan"></a>

## Inspect a plan before running

When a host needs dry-run inspection, budget review, or human approval, prepare first:

```ts
const prepared = await prepareEvaluation(input);

console.log(prepared.definition, prepared.policy);
console.log(prepared.planDigest, prepared.resolvedRuntimes);
console.log(prepared.estimatedWork);

const result = await prepared.run({ runId: 'approved-release-42', signal });
```

Preparation resolves capabilities and seals the complete Core Plan without calling a Target or Evaluator. `prepared.run()` executes that exact immutable Plan; mutating the original input after preparation cannot change its Definition, Policy, digest, or behavior. `estimatedWork` reports planned execution and evaluation coordinates before retries or early termination, and explicitly lists duration and provider cost as runtime-dependent. Direct `evaluate(input, options)` is canonically equivalent to `prepareEvaluation(input).run(options)`.

<a id="compare-runs"></a>

## Check whether two runs are comparable

To check whether two independent Runs support an exact comparison, pass their original results to `assessComparability()` and map every intentionally changed Variant as one subject:

```ts
import { assessComparability } from 'oh-my-knowledge';

const assessment = assessComparability({
  comparisonScope: 'decision',
  subjects: [{
    subjectId: 'candidate-under-test',
    leftVariantId: 'candidate',
    rightVariantId: 'candidate',
  }],
  left: previousResult,
  right: candidateResult,
});

if (assessment.comparabilityStatus !== 'compatible') {
  console.error(assessment.designStatus, assessment.evidenceQualificationStatus);
}
```

The assessment never compares scores or decides whether the candidate improved. It checks whether the measurement design remained invariant after the declared subject change and whether both source chains have enough authenticated evidence. Preserve the exact result objects: a clone or deserialized artifact cannot retain the in-process Core source authority and fails closed. Persistent cross-process admission remains available through the advanced Core surface until the Runtime artifact-store adapter lands.

<a id="repeat-run-stability"></a>

## Repeat an evaluation to check stability

If a result looks better but might change on another run, repeat the complete evaluation. An Evaluation Series holds data, scoring, and the measurement seed fixed, then summarizes a selected statistic across runs. Prepare `repeatableInput` separately: keep the earlier comparison analysis ID, use a deterministic service or an executor that actually supports seed control, and declare controlled seed coupling. The earlier `uncontrolled` example does not meet exact cross-run comparability requirements; passing it directly to Series yields `inconclusive`, not numerical stability statistics.

Once those prerequisites hold, repeat the evaluation and read its result:

```ts
import { prepareEvaluationSeries } from 'oh-my-knowledge';

const preparedSeries = await prepareEvaluationSeries({
  evaluation: repeatableInput,
  seriesInstanceId: 'release-42-repeatability',
  repeatCount: 10,
  stability: {
    sourceAnalysisId: 'prompt-v1-vs-v2-correct',
    projection: 'interval-estimate',
  },
});

// No Target or Evaluator has run yet.
console.log(preparedSeries.memberPlans, preparedSeries.estimatedWork);

const series = await preparedSeries.run({ signal });
if (series.status === 'failed') throw new Error(series.error.code);
if (series.status === 'cancelled') throw new Error('Series was cancelled.');
if (series.stability?.analysisStatus === 'completed') {
  console.log(series.stability.value.mean);
  console.log(series.stability.value.sampleStandardDeviation);
} else {
  console.error(series.stability);
}
```

Declare the full `repeatCount` before execution. OMK captures the Evaluation declaration once, preregisters every membership, and verifies that all stage-plan digests remain identical while each member receives a unique Run contract. Members run sequentially with Execution and Evaluation cache disabled. A failed or cancelled member retains its actual partial, failed, cancelled, or missing coverage state and is never replaced; the API does not stop early based on observed values. Each member receives its own Run budgets.

The Series experimental unit is one complete Run. Trials, retries, samples, and Judge replicates remain nested within that Run and do not increase `runCount`. The measurement seed is held fixed with the rest of the design, so seed-aware Executors receive the same trial seeds in each member; intentionally varying a Run-level seed requires a different experiment contract. The stability table is descriptive: mean, Bessel-corrected sample variance with denominator `n - 1`, standard deviation, minimum, maximum, and range. It does not issue a release verdict, estimate an iid confidence interval, or establish reproducibility across environments. Every preregistered slot must be eligible and comparable; otherwise stability is inconclusive rather than silently dropping failed or missing Runs. Select a scalar Analysis result with `projection: 'scalar'`; selecting the point estimate from an interval requires the explicit `interval-estimate` projection. Complete evidence is required by default. Allow partial evidence only when that missingness policy is defensible for the intended claim.

`PreparedEvaluationSeries` is single-use, and `seriesInstanceId` names that intentional execution. Use a fresh value for a genuinely new Series. For a direct shortcut, `evaluateSeries(input, options)` is equivalent to preparing and running once.

<a id="reuse-stages"></a>

## Reuse outputs after changing labels or analysis

Correcting expected answers or changing scoring and statistics need not call the model again. Choose a function based on what changed and pass the original result object from the earlier run:

| Change | Function | Work performed again |
|---|---|---|
| Expected answers or scoring | `rescore()` | Scoring, analysis, and decision. |
| Statistical analysis | `reanalyze()` | Analysis and decision. |
| Decision rule | `redecide()` | Decision only. |

Run `evaluate()` again if prompts, execution inputs, or execution settings changed. Names such as `correctedGoldDataset` below represent your revised complete declarations:

```ts
import { reanalyze, redecide, rescore } from 'oh-my-knowledge';

const rescored = await rescore(
  { ...input, dataset: correctedGoldDataset },
  originalResult,
  { runId: 'corrected-gold' },
);
const reanalyzed = await reanalyze(
  { ...input, analyses: revisedAnalyses },
  rescored,
  { runId: 'revised-analysis' },
);
const redecided = await redecide(
  { ...input, analyses: revisedAnalyses, decision: revisedDecision },
  reanalyzed,
  { runId: 'revised-decision' },
);
```

`rescore()` reuses Execution, `reanalyze()` reuses Execution plus Evaluation, and `redecide()` reuses Execution plus Evaluation plus Analysis. Each call takes a complete new declaration so defaults and identities are sealed before the suffix runs. Core rejects any change that belongs to a skipped stage, and only exact canonical result objects from the current process carry the required source authority. Run options, progress events, and budget consumption apply to the newly executed suffix; reused bundles retain their original identity and historical evidence without charging their work again. To reuse persisted Bundle documents across processes, use explicit Core admission with independent provenance verification; a report or JSON clone is never sufficient evidence.

<a id="executor-contract"></a>

## Service inputs, errors, and credentials

`executor.execute()` receives `variantId` in addition to the values shown above. Comparison roles belong to `comparisons`, not to the Executor invocation. Return `{ errorCode }` for an expected, stable, non-sensitive host failure; throwing an ordinary error becomes the redacted `EVAL_RUNTIME_EXECUTOR_FAILED` failure.

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

Repeated runs can reuse system outputs (execution cache) or scoring results (evaluation cache) separately. Both are off by default and require your cache storage. Execution reuse requires a deterministic executor with independently verified identity; it is not a way to reuse arbitrary stochastic outputs. If only scoring or analysis changed, start with [stage reuse](#reuse-stages).

Prepare `cacheableInput` for a deterministic executor; do not reuse the earlier stochastic model configuration directly. Your application also supplies the caches and deployment verifier below. OMK derives keys, validates records, and tracks where reused data came from:

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

<a id="content-addressed-workspaces"></a>

## Give Agents isolated file workspaces

If an Agent reads a repository or edits files, give each trial a separate workspace so earlier edits do not affect later scores. `WorkspaceDescriptor` identifies a file snapshot by its content digest; `WorkspaceProvider` creates a working directory and cleans it up afterward. The `cas` object stands for your snapshot storage and directory manager; replace the placeholder digest with the real content digest.

Pass local paths only to the executor, not through `runtimeContext`, so identical file content retains its identity across machines:

```ts
import type {
  Executor,
  WorkspaceDescriptor,
  WorkspaceProvider,
} from 'oh-my-knowledge';

const workspace: WorkspaceDescriptor = {
  resourceId: 'support-repository',
  digest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'application/vnd.acme.source-tree',
  classification: 'sensitive',
  size: 184_320,
};

const workspaceProvider: WorkspaceProvider = {
  providerId: 'acme.cas-overlay/v1',
  version: '2.1.0',
  fingerprintFacets: { materializer: 'overlayfs-v2' },
  async open({ descriptor, runId, trialId }) {
    // Verify descriptor.digest before returning a writable, trial-private overlay.
    const root = await cas.createOverlay(descriptor, { runId, trialId });
    return { root, close: () => cas.removeOverlay(root) };
  },
};

const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.workspace-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  workspaceProvider,
  async execute({ input, workspace, signal }) {
    if (workspace === undefined) return { errorCode: 'workspace-required' };
    return { output: await agent.run(input.task, { cwd: workspace.root, signal }) };
  },
};

const variant = {
  variantId: 'workspace-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: { executor, workspace },
};
```

Use `{ default, bySampleId }` instead of one descriptor when samples need different snapshots; a `null` override explicitly selects no workspace for that sample. OMK seals descriptors and provider identity before execution, opens one fresh lease per Target × Sample × Trial, reuses it only for retries of that trial, and closes it on every terminal path. Physical roots never become measurement identity or automatic evidence. The provider must perform bounded local acquisition and verify content itself; OMK deliberately does not discover files, locators, or credentials. A writable lease isolates measurements but is not a sandbox for untrusted code.

## Per-sample tool access

Use per-sample tool lists when some tasks may search and read while others must not call tools. Confirm that your Agent backend can enforce the exact list before declaring support and forwarding `allowedTools`. OMK does not intercept calls on behalf of the backend:

```ts
const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.tool-restricted-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  capabilities: {
    toolPolicy: 'allow-list',
    cancellation: 'cooperative',
  },
  async execute({ input, allowedTools, signal }) {
    return {
      output: await agent.run(input.task, {
        tools: allowedTools,
        signal,
      }),
    };
  },
};

const variant = {
  variantId: 'restricted-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: {
    executor,
    allowedTools: {
      default: ['Read', 'Search'],
      bySampleId: {
        offline: [],
        unrestricted: null,
      },
    },
  },
};
```

A direct array applies to every sample. In a plan, `[]` denies every tool and `null` deliberately restores the Executor runtime default for that sample. OMK sorts lists for canonical identity, keeps each Sample's list separate, and passes the same immutable list across retries of one Trial. It never discovers tools or enforces provider calls itself. The Executor must translate `allowedTools` into an exact backend restriction; if its backend can only approximate, ignore, or widen the list, it must not declare `toolPolicy: 'allow-list'`. `prepareEvaluation()` fails closed when a Variant requests a list from an Executor without that capability.

## Per-sample native MCP configuration

MCP connects Agents to external tool servers. When samples need different MCP servers, identify each configuration by a descriptor and load its actual configuration and credentials through your `mcpConfigProvider`. OMK does not discover local MCP configuration. The `secretStore` below is your credential store; compute the digest and size from the real configuration:

```ts
const executor: Executor<{ task: string }, undefined, string> = {
  executorId: 'acme.mcp-agent/v1',
  version: '1.0.0',
  schemas: { input: z.object({ task: z.string() }), output: z.string() },
  capabilities: { mcp: 'native-config' },
  mcpConfigProvider: {
    providerId: 'acme.secret-store/v1',
    version: '1.0.0',
    async open({ descriptor }) {
      const config = await secretStore.readJson(descriptor.resourceId);
      return { config, close: () => secretStore.release(descriptor.resourceId) };
    },
  },
  async execute({ input, mcpConfig, signal }) {
    return { output: await agent.run(input.task, { mcp: mcpConfig?.config, signal }) };
  },
};

const variant = {
  variantId: 'mcp-agent',
  artifact: { name: 'agent', kind: 'agent', source: 'inline', content: '...' },
  execution: {
    executor,
    mcpConfig: {
      default: {
        resourceId: 'mcp-config-a',
        digest: 'sha256:<canonical-json-digest>',
        size: 123,
        mediaType: 'application/json',
        classification: 'secret',
      },
      bySampleId: { offline: null },
    },
  },
};
```

OMK verifies the provider's canonical JSON digest and byte size, opens one fresh lease per Trial, reuses it only across that Trial's retries, and closes it on every terminal path. The native config is visible only to the selected Executor invocation or session and never enters results or errors through OMK. The Executor must not return secrets in its own output or trace. A per-sample descriptor change invalidates only coordinates selecting that descriptor; a provider identity change conservatively invalidates every coordinate using that Executor. Runtime deliberately does not discover MCP files or choose provider defaults; product-level discovery and Workflow-to-Runtime assembly belong in `eval-workflows`.

<a id="attempt-scoped-mock-interception"></a>

## Replace selected tool calls with mock results

For example, evaluate a refund Agent with a fixed lookup response without contacting the real business API. A backend that supports interception can use `execution.mockInterception` to provide prepared mock responses for selected tool calls. It accepts one secret `MockInterceptionDescriptor`, or `{ default, bySampleId }` with `null` to disable interception for a sample. Pair it with `capabilities.mockInterception: 'pre-tool-call'` and a `mockInterceptionProvider`:

```ts
const executor: Executor<string, undefined, string> = {
  executorId: 'acme.mockable-agent/v1',
  version: '1.0.0',
  schemas: { input: z.string(), output: z.string() },
  capabilities: { mockInterception: 'pre-tool-call' },
  mockInterceptionProvider: {
    providerId: 'acme.mock-provider/v1',
    version: '1.0.0',
    async open({ descriptor, signal }) {
      const plan = await mockStore.readAndVerify(descriptor, signal);
      const matcher = createMatcher(plan);
      return {
        intercept: ({ callId, toolName, input, signal: callSignal }) =>
          matcher.intercept({ callId, toolName, input, signal: callSignal }),
        close: () => matcher.close(),
      };
    },
  },
  async execute({ input, signal, mockInterception }) {
    return { output: await agent.run(input, { signal, mockInterception }) };
  },
};
```

The descriptor media type is `application/vnd.omk.mock-interception-plan+json`; its digest-bound plan must cover strictness, first-match rule order, and ordered return payload descriptors. The provider owns plan loading and must verify digest, byte size, media type, and classification before returning a lease. Runtime opens a fresh lease per attempt, including retries, so return-sequence and hit state reset. It validates `mocked`, `pass-through`, and `denied` decisions, waits for the Target call to settle before cleanup, and redacts provider failures. Outputs and traces produced under interception are conservatively classified as `secret`. Strict misses must become `denied`; a provider must never silently call the real tool. `checkExecutor()` does not certify interception yet, so validate it with a real Evaluation.

<a id="stateful-agent-sessions"></a>

## Keep a session for a multi-step Agent

Use `SessionExecutor` when an Agent needs multi-step state or a session handle within one task. Each sample and trial gets a new session; retries reuse that session. Keep the earlier `Executor` interface for a stateless request. `Executor` remains the concise stateless `omk.invoke/v1` interface; `EvaluationExecutor` is the union accepted by a Variant, and `InvokeExecutor` is the explicit name for the stateless form:

```ts
import type { SessionExecutor } from 'oh-my-knowledge';

const agentExecutor: SessionExecutor<{ task: string }, undefined, string> = {
  protocol: 'session',
  executorId: 'acme.research-agent/v1',
  version: '1.0.0',
  schemas: {
    input: z.object({ task: z.string() }).strict(),
    output: z.string(),
  },
  capabilities: {
    cancellation: 'cooperative',
    concurrency: { safety: 'parallel-safe' },
    telemetry: { trace: 'unsupported', usage: 'optional' },
  },
  async openSession({ runId, trialId, input }) {
    const handle = agentClient.createLocalHandle({ runId, trialId, task: input.task });
    return {
      async execute({ attemptId, signal }) {
        const response = await handle.run({ idempotencyKey: `${runId}:${attemptId}`, signal });
        return { output: response.text, usage: response.usage };
      },
      close: () => handle.close(),
    };
  },
};
```

OMK opens one new `ExecutorSession` object for each Target × Sample × Trial and rejects object reuse across trials or Runs. Retries call the same session with a new `ExecutorSessionAttempt`. An `attemptId` is stable for its measurement coordinate but may recur in a separate Run, so namespace provider idempotency with `runId` (or an equivalent provider-session scope), and fail closed when a remote commit is ambiguous. `ExecutorSessionContext` contains `runId`, `trialId`, the Variant projection, and execution context; it never contains Gold, evaluation context, or analysis membership. `close()` runs once after success, failure, timeout, or cancellation. `openSession()` and `close()` must be bounded local lifecycle work; opening is unmetered resource acquisition, so it must not perform model inference or other billable attempt work. This lifecycle is a temporary measurement boundary, not a persistent end-user conversation store.

<a id="independent-groups"></a>

## Assign samples to separate version groups

The earlier `paired` design runs both versions on every sample. Use `independent` when each sample should run on just one version, and declare allocation weights. This example stratifies by `locale`; samples must provide `executionContext.locale` and meet the group and stratum minimums. The earlier two teaching samples are insufficient for these settings:

```ts
comparisons: [{
  comparisonId: 'prompt-v1-vs-v2',
  controlVariantId: 'prompt-v1',
  treatmentVariantIds: ['prompt-v2'],
  metricIds: ['correct'],
}],
experiment: {
  seed: 'release-2026-09-04',
  sampling: {
    samplingKind: 'independent',
    allocations: [
      { variantId: 'prompt-v1', weight: 1 },
      { variantId: 'prompt-v2', weight: 1 },
    ],
    minimumSamplesPerVariant: 20,
    minimumSamplesPerVariantPerStratum: 5,
    stratumKey: '/executionContext/locale',
  },
},
```

OMK deterministically seals one Variant per sample before execution. Repeated trials reuse that assignment; changing the seed, weights, strata, or minima produces a different randomization identity.

<a id="multiple-criteria"></a>

## Apply multiple release criteria together

If release requires both “correctness must not fall too far” and “safety must not decline,” declare both comparisons and thresholds before running. Looking at separate 95% intervals does not preserve a 95% joint coverage target as comparisons accumulate; `comparison-family` adjusts intervals for the declared group. This example assumes `correctness` and `safety` metrics already exist:

```ts
analyses: [{
  analysisId: 'release-family',
  analysisKind: 'comparison-family',
  statistic: 'mean-difference',
  members: [
    {
      analysisId: 'v2-correctness',
      comparisonId: 'prompt-v1-vs-v2',
      treatmentVariantId: 'prompt-v2',
      metricId: 'correctness',
    },
    {
      analysisId: 'v2-safety',
      comparisonId: 'prompt-v1-vs-v2',
      treatmentVariantId: 'prompt-v2',
      metricId: 'safety',
    },
  ],
  confidence: {
    method: 'bonferroni-percentile-bootstrap',
    level: 0.95,
    resamples: 10_000,
  },
}],
decision: {
  decisionKind: 'comparison-family',
  analysisId: 'release-family',
  rule: 'all',
  criteria: [
    { analysisId: 'v2-correctness', minimumEffect: -0.01 },
    { analysisId: 'v2-safety', minimumEffect: 0 },
  ],
},
```

The two member records use 97.5% marginal intervals, targeting at least 95% simultaneous coverage when the marginal interval procedure has its stated coverage. Percentile Bootstrap remains an approximate method, so this correction is not an unconditional finite-sample coverage guarantee. The family record is available as `result.analysisResults['release-family']`; each member remains available under its own `analysisId`. Members are fixed before execution, and the preset never derives p-values from bootstrap intervals.

The optional family `decision` names that outer family plus one bounded criterion for every member. Bounds use raw treatment-minus-control effect units and equality is acceptable. With `rule: 'all'`, OMK returns `RELEASE` only when every complete simultaneous interval lies inside its declared bounds, `BLOCK` when at least one interval lies wholly outside a bound, and not-decided when any interval still crosses a bound. Criteria cannot be omitted, duplicated, added after results, weighted, or collapsed into a composite score.

<a id="composite-score"></a>

## Combine metrics into one score

Use a weighted composite when the product explicitly defines quality as, for example, 70% correctness and 30% conciseness. Establish the tradeoff and fix weights before running. Do not use an average to hide failure on safety or quality requirements that must pass separately. This example assumes both metrics are already defined:

```ts
analyses: [{
  analysisId: 'v2-overall-quality',
  analysisKind: 'composite-comparison-interval',
  compositeMetricId: 'overall-quality',
  comparisonId: 'prompt-v1-vs-v2',
  treatmentVariantId: 'prompt-v2',
  components: [
    { metricId: 'correctness', weight: 0.7 },
    { metricId: 'conciseness', weight: 0.3 },
  ],
  aggregation: { method: 'weighted-mean', missing: 'require-complete' },
  confidence: { method: 'percentile-bootstrap', level: 0.95, resamples: 10_000 },
}],
```

Every component must be a boolean Metric or a bounded numeric Metric with a monotonic direction. OMK converts each sealed source Metric to `[0, 1]`, composes complete readings within the experimental unit, and only then bootstraps the derived Metric. Weights are positive, unique by `metricId`, and sum exactly to one; there is no default weighting, scale override, clamp, or renormalization after missing evidence. Use `composite-quality-interval` with `variantId` for one-Variant quality. Use `composite-comparison-interval` with a paired or independent Sampling Design for treatment-minus-control change. A Decision selects either result by its `analysisId`.

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

<a id="retrieval-evaluation"></a>

## Check retrieval relevance and ranking

Retrieval scoring asks how many relevant documents were found and how early they were ranked; it does not judge the final generated answer. Label the known relevant document IDs for each query, then return the actual ordered IDs from your retriever.

Define `retrieverVariant` using the earlier integration pattern: accept `{ query: string }`, return `{ output: { documents: ['refund-policy', 'other-doc'] } }` on success, and declare a matching output schema. `/documents` selects that output field; `/relevantDocumentIds` selects the field in `expected`. `cutoff: 10` checks only the first 10 results. The `solo` design requires deterministic execution or actual support for OMK's supplied seed; see the [API reference](../reference/eval-runtime-api.md).

```ts
import { evaluate, type RetrievalEvaluator } from 'oh-my-knowledge';

const retrieval: RetrievalEvaluator = {
  evaluatorKind: 'retrieval',
  evaluatorId: 'retrieval-quality',
  cutoff: 10,
  ranking: { source: 'output', pointer: '/documents' },
  relevantDocumentIdsPointer: '/relevantDocumentIds',
  metricIds: {
    recallAtK: 'recall-at-10',
    precisionAtK: 'precision-at-10',
    reciprocalRankAtK: 'reciprocal-rank-at-10',
    ndcgAtK: 'ndcg-at-10',
  },
};

const result = await evaluate({
  dataset: {
    datasetId: 'search-regression',
    samples: [{
      sampleId: 'refund-policy',
      input: { query: 'How do refunds work?' },
      expected: { relevantDocumentIds: ['refund-policy', 'billing-faq'] },
    }],
  },
  variants: [retrieverVariant],
  evaluators: [retrieval],
  comparisons: [],
  analyses: [{
    analysisId: 'mean-reciprocal-rank-at-10',
    analysisKind: 'summary',
    statistic: 'mean',
    variantId: retrieverVariant.variantId,
    metricId: 'reciprocal-rank-at-10',
  }],
  experiment: { seed: 'search-v1', sampling: { samplingKind: 'solo' } },
  policy: {},
});
```

| Metric | Question | Interpretation |
|---|---|---|
| Recall@K | How many known relevant documents were found? | Relevant hits in the first K results divided by all known relevant IDs. |
| Precision@K | How many of the first K positions were hits? | Hits divided by K; returning only one correct result with K=10 still yields `0.1`. |
| Reciprocal Rank@K | How early was the first relevant document? | Rank 1 scores `1`, rank 2 scores `0.5`, and no hit within K scores `0`. The mean across samples is MRR. |
| nDCG@K | Are relevant documents near the top overall? | Compares with ideal ranking; ranges from 0 to 1, higher is better. |

The example requests only MRR, available at `result.analysisResults['mean-reciprocal-rank-at-10']`. Declare a separate `summary` for each other metric you want to aggregate. Samples with no applicable document belong in the next section's abstention evaluation; an empty label set is not a zero score.


The ranking must be an ordered array of unique, non-empty string IDs. It can come from `output` or `trace`; relevant IDs always come from `expected`, so they are never passed to the Executor. The preset truncates to `cutoff`, uses `hits / known relevant` for Recall, `hits / cutoff` for Precision, the first relevant rank for Reciprocal Rank, and binary log2-discounted nDCG. An empty returned ranking is a valid zero score. Duplicate or malformed IDs and an empty relevant set are invalid evidence. A mean summary of Reciprocal Rank is MRR; do not label each sample observation as MRR.

<a id="retrieval-abstention"></a>

## Mixed retrieval and empty-result evaluation

To assess correct retrieval, appropriate empty results, and explicitly forbidden recommendations together, start with the single file `examples/eval-runtime/retrieval-abstention.mjs`. OMK provides the retrieval and abstention scorers. Dataset preparation and forbidden-ID checks are editable business examples; you do not need to implement the abstention scorer yourself.

### 1. Run the example first

Use Node.js 22 or newer. From a source checkout containing the example, run:

```bash
yarn install --immutable
yarn build
node examples/eval-runtime/retrieval-abstention.mjs
```

The synthetic example needs no API key or business service. In a separate project, copy this one `.mjs` file and install an OMK version containing `AbstentionEvaluator`, plus Zod, which the example imports directly:

```bash
npm install oh-my-knowledge zod
node retrieval-abstention.mjs
```

If the feature has not yet shipped to npm, use the source-checkout instructions above. Copying a new example alongside an older installed package does not add the new capability.

### 2. Replace the `source` data

Keep every `sampleId` unique. This sample has been reviewed and has no applicable solution:

```js
{
  sampleId: 'no-solution-001',
  input: { query: 'No existing solution applies to this problem' },
  expected: {
    shouldAbstain: true,
    acceptableSolutionIds: [],
    forbiddenSolutionIds: ['solution-wrong'],
  },
  quality: { reviewStatus: 'reviewed' },
}
```

| Situation | Fields |
|---|---|
| An applicable solution exists | `shouldAbstain: false`, with nonempty `acceptableSolutionIds`. |
| No applicable solution exists | `shouldAbstain: true`, with `acceptableSolutionIds: []`. |
| The answer has not been confirmed | `shouldAbstain: null` or `reviewStatus: 'pending_human_annotation'`; AI-generated initial labels do not make it reviewed. |
| Explicitly unusable solutions are known | Put them in `forbiddenSolutionIds`; an empty list excludes the sample from forbidden-hit analysis. |

`prepareRecommendationDataset()` rejects pending samples by default. The demo explicitly sets `pendingPolicy: 'exclude'`, and `audit.excluded` lists excluded samples and reasons. Remove that option to restore rejection for a formal evaluation, and set `sourceRevision` to the actual dataset revision.

`query` is an example field, not an OMK requirement. If your data uses `input.prompt`, map it to `query`, or update the example's `Row`, Executor input schema, and invocation together. Keep expected answers, forbidden labels, and review status on the evaluation side, outside the `input` sent to the system under test.

### 3. Replace `executor.execute()`

Call your retrieval service in this function and map its **final ordered solution IDs**, after application filtering, to one of these results:

| Execution outcome | Return form |
|---|---|
| Successful recommendations | `return { output: { solutionIds: ['solution-a', 'solution-b'] } };` |
| Successful execution without recommendations | `return { output: { solutionIds: [] } };` |
| Failed invocation | Throw or `return { errorCode: 'recommendation-request-failed' };`; never report a successful empty result. |

Forward the received `signal` to your service, and update the Executor's `version`, `fingerprintFacets`, and `capabilities` truthfully. The demo's `deterministic` declaration only describes its synthetic retriever. The current `solo` design requires deterministic execution or actual support for consuming OMK's supplied `seed`. Do not copy a deterministic declaration onto a stochastic service without seed support; choose a measurement design supporting uncontrolled randomness instead. See the [public sampling contract](../reference/eval-runtime-api.md).

With the demonstrated `solutionIds` output, reuse `evaluators` and `analyses` as supplied. For another output shape, update the output schema and scorer bindings together; JSON Pointer `/solutionIds` selects that field from the output object. Retrieval and forbidden checks both default to top-3. To change the range, update retrieval's `cutoff`, the argument to `forbiddenIdEvaluator(3)`, and the corresponding metric names as appropriate. Keep the cohort filters in `analyses` so failure coverage remains scoped to each metric's applicable population.

### 4. Read the output

The unmodified example excludes one pending sample and successfully executes the other two. Expected values in `metrics` are:

| Metric | Meaning | Example value / effective denominator |
|---|---|---|
| `recall-at-3` | Fraction of known correct solutions retrieved on answerable samples; higher is better. | `1` / `1` |
| `precision-at-3` | Correct results in the top three divided by 3; higher is better. Returning only one correct solution still yields one third. | `0.333…` / `1` |
| `rr-at-3`, `ndcg-at-3` | First correct rank and ranking quality; higher is better. Mean `rr-at-3` is MRR. | Both `1` / `1` |
| `correct-abstention` | Empty outputs among successful, valid responses that should abstain; higher is better. | `1` / `1` |
| `false-abstention` | Empty outputs among successful, valid responses that should return a solution; lower is better. | `0` / `1` |
| `forbidden-hit` | Top-three forbidden-ID hits among successful, valid responses with forbidden annotations; lower is better. | `0` / `2` |

Read each metric's `status` and `coverage` first: `planned` counts the selected population, and `included` is the actual denominator. `sourceUnavailable` can mean execution failure or missing output, while `invalid` means invalid evidence. With no valid observations, the example prints `value: null`, not zero. Then check overall `executionCoverage`: 100% among valid responses does not mean all requests succeeded. See the [built-in abstention reference](../reference/eval-runtime-api.md#built-in-abstention-and-mixed-retrieval-evaluation) for the complete protocol and limitations.

<a id="tool-trajectory-evaluation"></a>

## Check whether an Agent called the required tools

For example, check that an Agent searched before reading a document. The configuration below requires `Search` before `Read`, while allowing extra calls. Add `trajectory` to `evaluate()`'s `evaluators` and `sample` to `dataset.samples`.

The executor must return a `trace` conforming to `omk.source-neutral-trace/v2`. Convert provider-native logs into that shared format in your integration first. Checking call order does not establish that tools succeeded or the final answer is correct:

```ts
import { evaluate, type ToolTrajectoryEvaluator } from 'oh-my-knowledge';

const trajectory: ToolTrajectoryEvaluator = {
  evaluatorKind: 'tool-trajectory',
  evaluatorId: 'tool-trajectory',
  metricId: 'tool-trajectory-match',
  tracePointer: '',
  expectedToolNamesPointer: '/expectedToolNames',
  match: 'contains-in-order',
};

const sample = {
  sampleId: 'research-policy',
  input: { request: 'Research and summarize the policy.' },
  expected: { expectedToolNames: ['Search', 'Read'] },
};
```

The modes are intentionally named from actual trajectory to expected trajectory: `exact-order` requires the same sequence, `same-tools` ignores order, `contains-in-order` allows extra calls while preserving the expected subsequence, and `contains-any-order` allows extra calls and arbitrary order. Every mode preserves duplicate-call multiplicity and compares source-neutral tool names case-sensitively. All success, failure, cancelled, and unknown calls participate; tool outcome is a separate construct. Empty actual trajectories are valid. Empty expected trajectories are allowed only by the exact modes to assert that no tool should be called. Combine this boolean Metric with final-output or Rubric Judge evaluators when both path and outcome matter.

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

<a id="custom-evaluator"></a>

## Write your own scoring rule

Use `CustomEvaluator` when a built-in scorer cannot express a business rule, such as forbidden IDs, field formats, or output length. Each custom evaluator produces one metric.

The example counts JavaScript string length after trimming (UTF-16 code units; some emoji occupy two or more), then summarizes the candidate's mean. Its lower-is-better direction demonstrates configuration, not overall answer quality. Replace the callback, metric declaration, and input schema with your own rule:

```ts
import { z } from 'zod';
import { evaluate, type CustomEvaluator } from 'oh-my-knowledge';

const outputLength = {
  evaluatorKind: 'custom',
  evaluatorId: 'output-length',
  instrumentId: 'output-length-v1',
  metric: {
    metricId: 'output-length-chars',
    valueType: 'numeric',
    unit: 'characters',
    direction: 'lower-is-better',
    missingPolicyId: 'exclude/v1',
  },
  bindings: [{ bindingId: 'actual', sourceKind: 'output', pointer: '' }],
  parameters: { trim: true },
  implementation: {
    implementationId: 'acme.output-length/v1',
    version: '1.0.0',
    schemas: {
      bindings: z.object({ actual: z.string() }).strict(),
      value: z.number().int().nonnegative(),
      fingerprintFacets: { bindings: 'actual-string/v1', value: 'nonnegative-integer/v1' },
    },
    fingerprintFacets: { sourceRevision: 'sha256:...' },
    evaluate({ bindings, parameters, signal }) {
      signal.throwIfAborted();
      const actual = parameters?.trim ? bindings.actual.trim() : bindings.actual;
      return { resultKind: 'score', value: actual.length };
    },
  },
} satisfies CustomEvaluator<{ actual: string }, { trim: boolean }>;

const result = await evaluate({
  dataset: input.dataset,
  variants,
  evaluators: [outputLength],
  comparisons: [{
    comparisonId: 'prompt-v1-vs-v2',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['output-length-chars'],
  }],
  analyses: [{
    analysisId: 'candidate-output-length',
    analysisKind: 'summary',
    statistic: 'mean',
    variantId: 'prompt-v2',
    metricId: 'output-length-chars',
  }],
  experiment: { seed: 'length-release-42', sampling: { samplingKind: 'paired', seedCoupling: 'uncontrolled' } },
  policy: { evaluation: { timeoutMs: 5_000 } },
});
```

Read the status, included observation count, and mean in `result.analysisResults['candidate-output-length']`. This summarizes `prompt-v2` only; declare a comparison analysis over the same metric to compare versions.

Bindings are a least-authority allowlist. Declare `expected` or `evaluation-context` only when the evaluator actually needs gold data; undeclared sample fields are not passed to the callback. JSON Pointer narrows each source before delivery. The `execution-facts` source is the exception: its pointer must be empty so the callback consumes the complete canonical, already-redacted facts projection rather than inventing a second projection identity. Binding and value schemas may validate and narrow but must not coerce, add defaults, or remove fields.

The callback may return `score`, `missing`, `invalid`, or `failed`. A score is persisted as measurement data, not classified source content: text, category, and ranking schemas must constrain it to a safe measurement vocabulary and must never echo an answer, trace, secret, or judge explanation. Put such supporting material in classified `CustomEvaluatorContent` evidence instead. Invalid values also use `CustomEvaluatorContent`; an ordinary thrown error is redacted. Do not retry or implement timeouts inside the callback: Core applies the sealed concurrency, timeout, budget, cancellation, accounting, and failure policy. The callback must be stateless, safe to run in parallel, and cooperate with `signal`; use the advanced lifecycle SPI for stateful resources.

Identity is explicit because OMK does not derive provenance from `Function#toString()`. Change `version`, schema `fingerprintFacets`, or implementation `fingerprintFacets` whenever code, dependencies, schemas, or provider configuration changes measurement behavior. One custom evaluator cannot emit multiple Metrics or represent an ensemble member. Numeric and boolean Metrics require a monotonic direction. They become analysis results only when the caller declares a compatible named summary or interval; categorical, text, and ranking Metrics remain evaluation evidence until a compatible estimator is explicitly selected through the advanced API. Comparison estimates are raw treatment-minus-control differences. The single-analysis progress Decision accepts only `higher-is-better`; use an explicit comparison-family criterion when each raw signed effect has its own release boundary.

<a id="rubric-judge-evaluation"></a>

## Ask an LLM to score answers against explicit criteria

A rubric is an explicit scoring guide. For open-ended answers with multiple valid phrasings, an LLM judge can assign 1–5 points against that guide rather than compare wording. You provide the criteria and model invocation; OMK constructs the scoring prompt, parses responses, and aggregates readings.

This example uses one judge model, scores each actual output twice, averages those scores, and summarizes the candidate's mean. Replace `internalGateway` and `judge-model` with your real integration; judging adds model calls. Define each score band and calibrate against human-labeled examples before a formal evaluation.

```ts
const result = await evaluate({
  dataset: input.dataset,
  variants,
  evaluators: [{
    evaluatorKind: 'rubric-judge',
    evaluatorId: 'correctness-judge',
    metricId: 'correctness-score',
    rubric: {
      criterionId: 'correctness',
      prompt: 'Judge whether the answer is factually correct.',
      rubric: '5 is fully correct; 1 is fully incorrect.',
    },
    judges: [{
      memberId: 'primary',
      model: 'judge-model',
      effort: 'low',
      replicateCount: 2,
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
    }],
    aggregation: { method: 'mean', missing: 'require-complete' },
  }],
  comparisons: [{
    comparisonId: 'prompt-v1-vs-v2',
    controlVariantId: 'prompt-v1',
    treatmentVariantIds: ['prompt-v2'],
    metricIds: ['correctness-score'],
  }],
  analyses: [{
    analysisId: 'candidate-correctness',
    analysisKind: 'summary',
    statistic: 'mean',
    variantId: 'prompt-v2',
    metricId: 'correctness-score',
  }],
  experiment: { seed: 'rubric-release-42', sampling: { samplingKind: 'paired', seedCoupling: 'uncontrolled' } },
  policy: {},
});
```

Read the status, included observation count, and mean in `result.analysisResults['candidate-correctness']`. This summarizes `prompt-v2` only; declare a comparison analysis over the same metric to compare versions.

The Judge callback performs exactly one provider invocation and must not retry. `replicateCount` repeats only evaluation, not Target execution or the Bootstrap sample count. With multiple members, `mean` gives every member equal weight after its replicates are averaged; `weighted-mean` requires an explicit positive weight for every `memberId`, summing to one. `require-complete` excludes the whole Target × Sample × Trial panel reading if any planned coordinate is unavailable. Provider failures retain valid accounting facts while removing provider-private reasons and usage details. Use `tracePolicy: 'source-neutral'` only when every Executor returns the versioned trace contract from `oh-my-knowledge/eval-runtime/contracts`.

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

Most applications can use `evaluate()` and the scorers on this page from the package root. Use advanced APIs when you need custom component lifecycles, staged runtime assembly, or lower-level measurement capabilities. Existing code that uses the functions below should import them from the `advanced` subpath:

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
