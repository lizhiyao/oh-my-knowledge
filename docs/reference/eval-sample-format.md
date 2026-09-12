# Evaluation sample format

OMK uses one `omk.eval-sample-set/v3` envelope for prompt, RAG, skill, agent, and workflow tasks. The envelope separates execution input, execution conditions, expected results, grading declarations, and annotations. Task-specific JSON schemas describe application data; they do not introduce separate sample protocols.

## Storage locations

Automatic discovery recognizes `.omk/eval-samples.json` or `.omk/eval-samples.yaml` in the selected scope. Having both is an ambiguity error. Use `--samples <path>` for another JSON/YAML file or a directory of split files. IDs must be unique across all loaded files. Root `requires` optionally contains `tools`, `files`, `env`, and `preflight` string arrays.

Beta uses **v3 only**. v2 and unversioned inputs are rejected; no compatibility reader or migration tool is provided. Loading never rewrites the old file. Reauthor a new document or generate one with `omk init` / `omk sample`. Existing reports retain their own schemas. New inputs and scoring bindings establish a new measurement identity; do not splice old scores into a new comparison.

The machine contract is [Eval Sample Set v3 JSON Schema](../../schemas/eval-samples/v3/eval-sample-set.schema.json). Unknown fields are rejected, including legacy `prompt`, `context`, and `sample_id` fields.

```json
{
  "schemaVersion": "omk.eval-sample-set/v3",
  "samples": [{
    "sampleId": "review-1",
    "input": { "inputKind": "text", "text": "Review: db.query('SELECT * FROM users WHERE name=' + username)" },
    "evaluationContext": {
      "assertions": [{ "type": "contains", "value": "SQL" }],
      "rubric": { "security": { "criterion": "Identify the injection risk and a concrete fix.", "weight": 1 } }
    },
    "annotations": { "provenance": "human", "difficulty": "easy" }
  }]
}
```

## Fields

| Field | Contract |
| --- | --- |
| `sampleId` | Required stable nonempty identifier; unique within the loaded dataset |
| `input` | Required `text`, `json`, or `messages` input |
| `executionContext` | Optional `cwd`, `allowedTools`, `mocks`, `mocksStrict`, prompt-only `environment`, and application JSON `data` |
| `expected` | Optional JSON reference results; available only through explicit evaluator bindings |
| `evaluationContext` | Optional `assertions`, `rubric`, evaluator-only `reference`, and structured `checks` |
| `annotations` | Optional `capability`, `difficulty`, `construct`, `provenance`, `covers`, and `tripwire`; does not enter execution input |

`rubric` values contain a nonempty `criterion` and positive `weight`; weights sum to 1. `reference` replaces the ambiguous scoring use of `context`: it is **never appended to input**. Faithfulness and context-recall assertions require their own `reference` or `evaluationContext.reference`. Text rubric and LLM assertion scoring require text input. No new judge prompt or scoring formula is introduced.

## Input and adapter support

- `text`: `{ "inputKind": "text", "text": "..." }`. Whitespace is preserved. A declared `executionContext.environment` is explicitly rendered as a prompt-only precondition; it does not create files. HTTP URLs in `input.text` retain the existing host resolution behavior: content is resolved and sealed before compilation, or the run fails. References and structured values are not scanned or fetched.
- `json`: `inputKind`, `value`, `schema`, and `schemaDocument`. `schema` contains Core `schemaVersion`, `schemaUri`, and `schemaDigest`; the digest must equal the canonical JSON digest of the embedded document and the URI must equal its `$id`. A self-contained JSON Schema 2020-12 validates `value` without coercion, defaults, property removal, or remote schema loading.
- `messages`: `inputKind: messages`, `interactionMode: history`, and a nonempty `messages` array. Each message has `messageId`, `role`, and textual `content`. Roles are `system`, `user`, `assistant`, and `tool`. Assistant `toolCalls` contain `toolCallId`, `name`, and JSON-object `arguments`; tool results reference an outstanding earlier `toolCallId`. Duplicate IDs, orphan/duplicate results, incomplete tool calls, and late system messages are rejected.

**Adapter support is explicit:**

| Executor | Text | JSON | Message history |
| --- | --- | --- | --- |
| `openai-api`, `anthropic-api` | Yes | Canonical JSON user envelope | Native system/user/assistant roles |
| `codex`, `codex-sdk`, `claude`, `claude-sdk` | Yes | Rejected | Rejected |
| custom-executor | Yes | Complete input envelope | Complete input envelope; application-owned interpretation |

The API adapters validate JSON against its authored schema and send the complete typed envelope as canonical JSON in user content. This is an explicit text projection, not a provider-side JSON input channel or an output-schema guarantee. Message history is sent using native roles; supporting files and execution data are a separate content block on the first user message. OpenAI uses `instructions` for the knowledge artifact and native system messages for sample system content. Anthropic puts the artifact and sample system messages in ordered top-level `system` blocks. Message IDs remain in OMK evidence and are not fabricated as provider IDs.

API history must contain non-empty content, optional leading system messages, then alternating user/assistant messages starting and ending with user. Tool-call history, assistant prefill and other sequences fail before transport; use custom-executor for those application protocols. Input history is supplied context, not observed execution: output traces still describe only the newly generated turn. No tools, remote conversation state or user simulator are enabled.

API adapter identity advances to 1.3.0 and its input Schema to v2; the supported projection policy participates in the fingerprint. Existing raw Core JSON and text rendering remain supported, but a raw Core object with `inputKind` explicitly opts into authored-input validation. Start a new comparison series after changing adapter identity. Sample files remain v3. Vendor mappings follow [Responses](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create) and [Messages](https://platform.claude.com/docs/en/api/messages/create).

Custom executor's `omk.custom-executor-exchange/v1` request receives the complete structured input envelope and `trial.executionContext`. Expected answers and evaluation context are excluded from every executor request.

## Structured checks

A `checkKind: exact-match` check binds a JSON pointer in actual output or trace to a JSON pointer in `expected`. OMK reuses the Evaluation Runtime canonical JSON exact-match evaluator; object key order is irrelevant, while array order and JSON types remain significant. There is no fuzzy coercion. Each check declares whether it contributes to the `fact` or `behavior` layer and optionally a positive weight.

```json
{
  "sampleId": "classification-1",
  "input": { "inputKind": "text", "text": "Classify this invoice dispute." },
  "expected": { "category": "billing" },
  "evaluationContext": {
    "checks": [{
      "checkKind": "exact-match",
      "checkId": "category",
      "actual": { "sourceKind": "output", "pointer": "/category" },
      "expectedPointer": "/category",
      "layer": "fact"
    }]
  }
}
```

This sample expects a structured executor output such as `{ "category": "billing" }`. Missing output, trace, or pointer evidence remains missing; it is not a successful match. Separate checks can compare ranked document IDs, tool arguments, and actual state snapshots. An exact ranking comparison is not nDCG, semantic answer quality, or proof of an external state change. State evidence must be produced by the executor from the actual system being tested. Runtime API retrieval and trajectory evaluators retain their separate documented declarations; this file format does not implicitly activate them.

## Metadata & sandbox fields

`annotations.covers` declares structure anchors using `targetKind` and `ref`; it never proves node execution. `tripwire` marks an intentionally difficult sample and does not invert grading. `executionContext.mocks` requires an executor that supports interception; `mocksStrict` defaults to deny unmatched calls. `mock_hit` must reference an existing mock. `executionContext.cwd` supplies the workspace fixture; resources are managed by the existing host isolation mechanism. See [executors](./executors#sample-mock-compatibility).

For former v2 `prompt: Q` plus `context: C`, write the intended full input explicitly, for example `input.text: "Q\n\n```\nC\n```"`. If C is grading-only evidence, put it in `evaluationContext.reference` instead. These are different experiments. Do not infer one from the other or silently rewrite user data.

## Scoring strategy

### 1. Assertion score

Rule-based local checks; each assertion yields pass/fail.

**Formula:**

- Pass rate = sum of passed assertion weights / total weight (0–1)
- Score = 1 + pass_rate × 4 (mapped to 1–5)
- Example: 3 assertions (weight 1 each), 2 pass → pass rate 2/3 → score = 1 + 0.67 × 4 = **3.67**

For the composite, assertions are split into two independent layers — a **factScore** (factual checks) and a **behaviorScore** (behavioral checks) — each scored with the formula above over its own assertions.

### 2. Rubric score

Each rubric dimension is compiled into a separate judge call, so one criterion cannot gain priority from its position beside another criterion in the same prompt. The judge scores every applicable dimension from 1–5. OMK then computes the sealed weighted mean only when every planned dimension is observed; one missing dimension makes the rubric aggregate missing. Every applicable dimension also participates in release-time judge dissent and uncertainty gates.

### 3. Composite score

The composite is the **mean of the layered scores that are present** — there are three layers:

| Layer | Source |
|---|---|
| `factScore` | factual assertions (`contains` / `regex` / `json_*` / `equals` / `semantic_similarity` / `tool_*_contains` …) |
| `behaviorScore` | behavioral assertions (length / word-count / `cost_max` / `latency_max` / `turns_*` / `tools_*` / `custom` …) |
| `judgeScore` | Weighted aggregate of independently judged rubric dimensions |

`composite = mean(present layers)`. A layer with no assertions (or no judge configured) is **dropped from the mean**, not counted as zero. A sample with no observed layer has no numeric composite score.

See the [scoring pipeline](../specs/scoring) for the full derivation, the equal-weight caveat, and how the multi-layer verdict gate relates to the composite.

## Assertion types

30+ types in two families. **Deterministic** ones are checked locally (no model call); **LLM-scored** ones invoke the judge and return a 1-5 score gated by `threshold`.

**Deterministic** (local, no LLM call):

| Type | Description |
|---|---|
| `contains` / `not_contains` | substring must / must-not appear |
| `regex` | regex match |
| `min_length` / `max_length` | length bounds |
| `json_valid` / `json_schema` | JSON validation |
| `starts_with` / `ends_with` | prefix / suffix |
| `equals` / `not_equals` | exact match |
| `word_count_min` / `word_count_max` | word-count bounds |
| `contains_all` / `contains_any` | multi-value match |
| `cost_max` / `latency_max` | cost / latency caps |
| `tools_called` / `tools_not_called` / `tools_count_min` / `tools_count_max` | agent tool-call assertions |
| `tool_output_contains` / `tool_input_contains` / `tool_input_not_contains` | a tool's input/output must (or, for `_not_`, must not) contain the given content |
| `mock_hit` | a declared sandbox mock was actually hit by a tool call (see [sample design](../specs/sample-design-spec)) |
| `turns_min` / `turns_max` | conversation-turn bounds |
| `rouge_n_min` | ROUGE-N recall ≥ threshold (`reference` holds the gold text; `n` defaults to 1; `threshold` defaults to 0.5) |
| `levenshtein_max` | edit distance ≤ value (for "output should be near-identical to reference") |
| `bleu_min` | BLEU-4 ≥ threshold (unsmoothed; degenerates to 0 on short text) |
| `custom` | custom JS function (30 s timeout) |

**LLM-scored** (invoke the judge, 1-5, `threshold` defaults to 3):

| Type | Description |
|---|---|
| `faithfulness` | output stays grounded in `evaluationContext.reference` (anti-hallucination) |
| `answer_relevancy` | output directly answers `input.text`; catches dodging, topic drift, verbosity |
| `context_recall` | gold facts in `evaluationContext.reference` are actually used in the output (`reference` may enumerate the gold facts) |
| `semantic_similarity` | holistic semantic similarity to `reference` |

**Universal modifier:**

Any assertion takes `not: true` to invert (replaces paired `not_contains` / `not_equals` etc; legacy types remain as aliases):

```yaml
- type: regex
  pattern: "TODO|FIXME"
  not: true              # output must NOT contain TODO/FIXME
```

For async judge-backed and custom assertions, inversion happens only after a valid raw pass/fail reading exists. Provider failure, timeout, cancellation, budget censoring, missing input, and invalid output remain failures or missing evidence; `not: true` never turns infrastructure or protocol failure into a pass.

**Composition (assert-set):**

`assert-set` combines child assertions with `any` (OR) or `all` (AND) and supports nesting:

```yaml
- type: assert-set
  mode: any              # at least one child must pass (mode: 'all' = all must pass)
  children:
    - { type: contains, value: "parameterized" }
    - { type: contains, value: "prepared statement" }
    - { type: regex, pattern: "bind\\(.*\\?" }
```

Children can independently use `not: true`; nested `assert-set`s can express any boolean shape over **deterministic assertions**. Async judge-backed assertions (`semantic_similarity`, `faithfulness`, `answer_relevancy`, `context_recall`, and `custom`) must remain top-level because an `assert-set` is evaluated synchronously; nesting one is rejected before execution.

> **Layered scoring note.** An `assert-set` is attributed to the fact/behavior layered score only when its leaf children are *homogeneous* — all fact-type or all behavior-type. A **mixed-layer** `assert-set` (e.g. one `contains` + one `max_length`) has no single honest layer, so it is left out of the layered composite (it still counts toward the flat assertion pass/fail). If you want a sample's signal to land in the layered composite, prefer leaf assertions, or keep each `assert-set` within one layer.

## Custom assertion

```js
// my-assertion.mjs
export default function(output, { sample, assertion }) {
  return { pass: output.includes('SQL'), message: 'checked for SQL keyword' };
}
```
