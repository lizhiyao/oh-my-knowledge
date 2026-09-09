# Choose a scoring method

Complete the [service integration guide](./eval-runtime.md) first. Consult the sections you need; this is not a required linear tutorial.

Code fragments use `input`, `variants` and application clients from the [complete integration example](./eval-runtime-scoring.md#exact-match-evaluation) or your application; these are not OMK-provided services.

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

This suits tasks that require precise output, such as classification into `"refund"` or `"inquiry"`. For open-ended answers with multiple valid phrasings, consider a [Rubric Judge](./eval-runtime-scoring.md#rubric-judge-evaluation) with explicit scoring criteria. Use a [custom evaluator](./eval-runtime-scoring.md#custom-evaluator) when you need your own trimming, case folding, or field extraction before comparison.

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

If the feature has not yet shipped to npm, use the [source-checkout instructions](./eval-runtime.md). Copying a new example alongside an older installed package does not add the new capability.

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
