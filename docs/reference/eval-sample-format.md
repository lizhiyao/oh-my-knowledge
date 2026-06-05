# Eval sample format

An **eval-samples** file is the test set `omk eval` / `omk doctor` run against — a list of cases, each a `prompt` plus optional `rubric`, `assertions`, and metadata. Supports JSON and YAML (`eval-samples.json`, `eval-samples.yaml`, `eval-samples.yml`); YAML is easier to hand-write.

For *designing* a rigorous sample set (what to test, how many, the metadata fields), see [sample design](../specs/sample-design-spec) — this page is the field-by-field format reference.

```json
[
  {
    "sample_id": "s001",
    "prompt": "Review this code for security issues",
    "context": "function auth(u, p) { db.query('SELECT * FROM users WHERE name=' + u); }",
    "rubric": "Should identify SQL injection risk and recommend parameterized queries",
    "assertions": [
      { "type": "contains", "value": "SQL injection", "weight": 1 },
      { "type": "contains", "value": "parameterized", "weight": 1 },
      { "type": "not_contains", "value": "looks fine", "weight": 0.5 }
    ],
    "dimensions": {
      "security": "did it identify the injection vulnerability?",
      "actionability": "did it give directly usable fix code?"
    }
  }
]
```

## Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `sample_id` | `string` | **yes** | Unique sample ID |
| `prompt` | `string` | **yes** | User prompt sent to the model |
| `context` | `string` | no | Extra context (e.g. code). Wrapped in a code block and appended to the prompt. URLs are auto-fetched at runtime. |
| `cwd` | `string` | no | Per-sample working-directory override (runtime context for this one case) |
| `rubric` | `string` | no | Scoring guideline for the LLM judge (1-5 scale) |
| `assertions` | `array` | no | Assertion checks; see [assertion types](#assertion-types) |
| `assertions[].type` | `string` | **yes** | Assertion type |
| `assertions[].value` | `string\|number` | depends | Check value (required for `contains`, `min_length`, `cost_max`, etc.) |
| `assertions[].values` | `array` | depends | String array (required for `contains_all`, `contains_any`) |
| `assertions[].pattern` | `string` | depends | Regex pattern (required for `regex`) |
| `assertions[].flags` | `string` | no | Regex flags (default `"i"`) |
| `assertions[].schema` | `object` | depends | JSON Schema object (required for `json_schema`, via [ajv](https://ajv.js.org/)) |
| `assertions[].reference` | `string` | depends | Reference text (required for `semantic_similarity`) |
| `assertions[].threshold` | `number` | no | Pass threshold; default depends on type — `3` for LLM-scored types, `0.5` for `rouge_n_min` / `bleu_min`, `1` for `mock_hit` |
| `assertions[].fn` | `string` | depends | Path to a custom assertion JS file (required for `custom`) |
| `assertions[].weight` | `number` | no | Weight (default 1) |
| `assertions[].not` | `boolean` | no | Invert this assertion's pass/fail; works with any type |
| `assertions[].n` | `number` | no | n-gram order for `rouge_n_min` (default 1) |
| `dimensions` | `object` | no | Multi-dimension scoring; key = dimension name, value = scoring guideline |

## Metadata & sandbox fields

A sample can also carry **metadata** (documentation / diagnostics only — these never enter grading / judge / verdict) and **sandbox** fields (for evals decoupled from the real environment). Full guidance lives in [sample design](../specs/sample-design-spec); here is the field index:

| Field | Type | Purpose |
|---|---|---|
| `capability` | `string[]` | capability dimensions this sample covers (drives coverage diagnostics) |
| `difficulty` | `'easy' \| 'medium' \| 'hard'` | difficulty bucket (strict enum) |
| `construct` | `string` | what it measures: `necessity` / `quality` / `capability` (custom allowed) |
| `provenance` | `'human' \| 'llm-generated' \| 'production-trace'` | data source |
| `mocks` | `object[]` | tool-call interception list — return fake data instead of really calling the tool |
| `mocksStrict` | `boolean` | deny any tool call that matches no mock (default `false`) |
| `tripwire` | `boolean` | trap sample: the LLM is **expected** to fail (default `false`) |
| `environment` | `object` | declared "already provisioned" preconditions: `cli_available` / `files_available` / `notes` |

## URL auto-fetching

URLs in `prompt` and `context` are auto-fetched before evaluation and inlined into the text. Useful when referencing online docs, API references, etc.:

```json
{
  "sample_id": "s001",
  "prompt": "Generate test cases from this PRD: https://wiki.example.com/prd/feature-x"
}
```

At runtime, URLs are replaced with the actual content. Fetch order: MCP Server first for matching URLs (e.g. SSO-protected private docs), then plain HTTP for the rest. URLs already resolved by MCP are not re-fetched via HTTP.

**Private-doc URLs**: drop a `.mcp.json` config file into the project dir, or pass `--mcp-config <path>`:

```json
{
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["@example/docs-mcp-server"],
      "env": { "DOCS_API_TOKEN": "xxx" },
      "urlPatterns": ["docs.example.com"],
      "fetchTool": {
        "name": "fetch_doc",
        "urlTransform": {
          "regex": "docs\\.example\\.com/([^/]+/[^/]+)/([^/?#]+)",
          "params": { "namespace": "$1", "slug": "$2" }
        },
        "contentExtract": "data.body"
      }
    }
  }
}
```

**Public URLs**: fetched via plain HTTP. If they require auth, make sure the shell already has network access configured (VPN, proxy, etc.).

## Scoring strategy

### 1. Assertion score

Rule-based local checks; each assertion yields pass/fail.

**Formula:**

- Pass rate = sum of passed assertion weights / total weight (0–1)
- Score = 1 + pass_rate × 4 (mapped to 1–5)
- Example: 3 assertions (weight 1 each), 2 pass → pass rate 2/3 → score = 1 + 0.67 × 4 = **3.67**

For the composite, assertions are split into two independent layers — a **factScore** (factual checks) and a **behaviorScore** (behavioral checks) — each scored with the formula above over its own assertions.

### 2. Rubric / Dimensions score

The judge model (default `haiku`) scores 1–5 against the rubric, producing the **judgeScore**. In `dimensions` mode, each dimension is scored independently and then averaged.

### 3. Composite score

The composite is the **mean of the layered scores that are present** — there are three layers:

| Layer | Source |
|---|---|
| `factScore` | factual assertions (`contains` / `regex` / `json_*` / `equals` / `semantic_similarity` / `tool_*_contains` …) |
| `behaviorScore` | behavioral assertions (length / word-count / `cost_max` / `latency_max` / `turns_*` / `tools_*` / `custom` …) |
| `judgeScore` | LLM judge (rubric / dimensions) |

`composite = mean(present layers)`. A layer with no assertions (or no judge configured) is **dropped from the mean**, not counted as zero; with neither assertions nor judge the composite is `0`.

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
| `faithfulness` | output stays grounded in `sample.context` (anti-hallucination) |
| `answer_relevancy` | output directly answers `sample.prompt`; catches dodging, topic drift, verbosity |
| `context_recall` | gold facts in `sample.context` are actually used in the output (`reference` may enumerate the gold facts) |
| `semantic_similarity` | holistic semantic similarity to `reference` |

**Universal modifier:**

Any assertion takes `not: true` to invert (replaces paired `not_contains` / `not_equals` etc; legacy types remain as aliases):

```yaml
- type: regex
  pattern: "TODO|FIXME"
  not: true              # output must NOT contain TODO/FIXME
```

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

Children can independently use `not: true`; nested `assert-set`s can express any boolean shape.

## Custom assertion

```js
// my-assertion.mjs
export default function(output, { sample, assertion }) {
  return { pass: output.includes('SQL'), message: 'checked for SQL keyword' };
}
```
