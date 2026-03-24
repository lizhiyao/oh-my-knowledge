# oh-my-knowledge

Knowledge artifact evaluation toolkit — benchmark your skills with objective data.

English | [中文](./README.zh-CN.md)

**Fixed model, variable knowledge artifact, data speaks.**

## Why

Teams building AI skills (system prompts, knowledge packages, rule sets) need objective data to prove v2 is better than v1. `oh-my-knowledge` runs controlled experiments: same model, same test cases, only the knowledge artifact changes.

## Quick Start

```bash
# Install globally
npm i -g oh-my-knowledge

# Scaffold a new eval project
omk bench init my-eval
cd my-eval

# Preview the evaluation plan
omk bench run --dry-run

# Run the evaluation
omk bench run --variants v1,v2

# View the report
omk bench report
# Open http://127.0.0.1:7799
```

## How It Works

```
eval-samples.json     skills/v1.md     skills/v2.md
       │                    │                │
       └────────┬───────────┘                │
                │                            │
         ┌──────▼──────┐              ┌──────▼──────┐
         │  sample +   │              │  sample +   │
         │  skill v1   │              │  skill v2   │
         └──────┬──────┘              └──────┬──────┘
                │                            │
         ┌──────▼──────┐              ┌──────▼──────┐
         │  Executor   │              │  Executor   │
         │ claude      │              │ claude      │
         │ openai      │              │ openai      │
         │ gemini      │              │ gemini      │
         └──────┬──────┘              └──────┬──────┘
                │                            │
         ┌──────▼──────────────────────▼──────┐
         │          Grading                    │
         │  ┌─────────────┐ ┌──────────────┐  │
         │  │ Assertions  │ │ LLM Judge    │  │
         │  │ (18 types)  │ │ (rubric or   │  │
         │  │             │ │  dimensions) │  │
         │  └─────────────┘ └──────────────┘  │
         └──────────────────┬─────────────────┘
                            │
                  ┌─────────▼─────────┐
                  │  Report + Analysis │
                  │  (JSON/HTML)       │
                  └───────────────────┘
```

## Eval Sample Format

Supports both JSON and YAML (`eval-samples.json`, `eval-samples.yaml`, `eval-samples.yml`).

The file contains an array of sample objects. Each sample represents one test case for evaluating a skill.

```json
[
  {
    "sample_id": "s001",
    "prompt": "Review this code",
    "context": "function auth(u, p) { db.query('SELECT * FROM users WHERE name=' + u); }",
    "rubric": "Should identify SQL injection and suggest parameterized queries",
    "assertions": [
      { "type": "contains", "value": "SQL injection", "weight": 1 },
      { "type": "contains", "value": "parameterized", "weight": 1 },
      { "type": "not_contains", "value": "looks good", "weight": 0.5 },
      { "type": "json_valid" },
      { "type": "cost_max", "value": 0.01 },
      { "type": "custom", "fn": "my-assertion.mjs", "weight": 1 }
    ],
    "dimensions": {
      "security": "Should identify injection vulnerability",
      "actionability": "Should provide concrete fix with code"
    }
  }
]
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sample_id` | `string` | **Yes** | Unique identifier for the sample (e.g., `"s001"`). Used in reports and analysis to reference this test case. |
| `prompt` | `string` | **Yes** | The user prompt sent to the model. This is the task or question the model should answer. |
| `context` | `string` | No | Additional context appended to the prompt (e.g., code snippet, document text). If provided, it is wrapped in a code block and concatenated after `prompt`. |
| `rubric` | `string` | No | Natural language scoring criteria for the LLM judge. The judge model reads this rubric and scores the output 1-5. Use when you need semantic/qualitative evaluation. |
| `assertions` | `array` | No | List of deterministic and async checks applied to the model output. Each assertion is an object with a `type` field (see [Assertion Types](#assertion-types)). |
| `assertions[].type` | `string` | **Yes** | The assertion type (e.g., `"contains"`, `"json_valid"`, `"custom"`). See full list below. |
| `assertions[].value` | `string\|number` | Varies | The value to check against. Required for `contains`, `starts_with`, `equals`, `min_length`, `cost_max`, etc. |
| `assertions[].values` | `array` | Varies | Array of strings. Required for `contains_all` and `contains_any`. |
| `assertions[].pattern` | `string` | Varies | Regex pattern. Required for `regex` type. |
| `assertions[].flags` | `string` | No | Regex flags (default: `"i"`). Only used with `regex` type. |
| `assertions[].schema` | `object` | Varies | JSON Schema object. Required for `json_schema` type. Validated via [ajv](https://ajv.js.org/) (full JSON Schema spec). |
| `assertions[].reference` | `string` | Varies | Reference text for semantic comparison. Required for `semantic_similarity` type. |
| `assertions[].threshold` | `number` | No | Minimum score (1-5) to consider a semantic similarity match passing. Default: `3`. |
| `assertions[].fn` | `string` | Varies | Path to a `.mjs` file exporting the check function. Required for `custom` type. Resolved relative to the samples file directory. |
| `assertions[].weight` | `number` | No | Weight of this assertion in the composite score calculation. Default: `1`. Higher weight = more influence on the final assertion score. |
| `dimensions` | `object` | No | Key-value map for multi-dimensional LLM scoring. Each key is a dimension name (e.g., `"security"`), and the value is the rubric text the LLM judge uses to score that dimension (1-5). Scores are averaged into a single LLM score. |

**Scoring priority:** If both `assertions` and `rubric`/`dimensions` are present, the composite score is a 50/50 weighted average. If only one is present, that score is used directly. If none are present, the score is 0.

**Prompt construction:** The final prompt sent to the model is: `prompt` alone if no `context`, or `prompt + "\n\n```\n" + context + "\n```"` if `context` is provided.

### Grading Strategy

Each sample can use up to three grading methods. They can be used alone or combined.

#### 1. Assertions (deterministic scoring)

Assertions are rule-based checks that run locally without any LLM calls (except `semantic_similarity` and `custom`). Each assertion produces a **pass/fail** result.

**How the assertion score is calculated:**

1. Each assertion has a `weight` (default: 1)
2. Sum the weights of all passing assertions → `passedWeight`
3. Sum the weights of all assertions → `totalWeight`
4. Compute ratio: `passedWeight / totalWeight` (0.0 ~ 1.0)
5. Normalize to 1-5 scale: **`score = 1 + ratio × 4`**

Example: 3 assertions (weight 1 each), 2 pass → ratio = 2/3 → score = 1 + 2.67 = **3.67**

#### 2. Rubric (single LLM judge)

A judge model (default: `haiku`, configurable via `--judge-model`) reads the model output and scores it against the rubric text. Returns an integer score from **1** (fail) to **5** (excellent) with a brief reason.

Only one of `rubric` or `dimensions` should be used per sample. If both are present, `dimensions` takes priority.

#### 3. Dimensions (multi-dimensional LLM judge)

Each dimension is scored independently by the judge model (1-5). The dimension scores are **averaged** to produce a single LLM score.

Example: `security: 5`, `actionability: 3` → LLM score = **(5 + 3) / 2 = 4.0**

#### Composite Score

| What's present | Composite score formula |
|----------------|----------------------|
| Assertions only | `assertionScore` |
| LLM only (rubric or dimensions) | `llmScore` |
| Both | `(assertionScore + llmScore) / 2` |
| Neither | `0` |

All scores are on a **1-5 scale**. A score of 0 means no grading criteria were defined.

### Assertion Types

**Deterministic (sync, no LLM):**

| Type | Fields | Description |
|------|--------|-------------|
| `contains` | `value`, `weight` | Output contains substring (case-insensitive) |
| `not_contains` | `value`, `weight` | Output does NOT contain substring |
| `regex` | `pattern`, `flags`, `weight` | Output matches regex |
| `min_length` | `value`, `weight` | Output length >= value |
| `max_length` | `value`, `weight` | Output length <= value |
| `json_valid` | `weight` | Output is valid JSON |
| `json_schema` | `schema`, `weight` | Output matches JSON Schema (full spec via ajv) |
| `starts_with` | `value`, `weight` | Output starts with string (case-insensitive) |
| `ends_with` | `value`, `weight` | Output ends with string (case-insensitive) |
| `equals` | `value`, `weight` | Output exactly equals value (after trim) |
| `not_equals` | `value`, `weight` | Output does not equal value (after trim) |
| `word_count_min` | `value`, `weight` | Word count >= value |
| `word_count_max` | `value`, `weight` | Word count <= value |
| `contains_all` | `values`, `weight` | Output contains ALL substrings |
| `contains_any` | `values`, `weight` | Output contains at least one substring |
| `cost_max` | `value`, `weight` | Execution cost (USD) <= value |
| `latency_max` | `value`, `weight` | Execution latency (ms) <= value |

**Async (LLM-based):**

| Type | Fields | Description |
|------|--------|-------------|
| `semantic_similarity` | `reference`, `threshold`, `weight` | LLM judges similarity to reference text (threshold default: 3) |
| `custom` | `fn`, `weight` | Load external JS function (see below) |

### Custom Assertions

Create a `.mjs` file that exports a function:

```js
// my-assertion.mjs
export default function(output, { sample, assertion }) {
  const hasKeyword = output.includes('SQL');
  return { pass: hasKeyword, message: 'Checked for SQL keyword' };
}
```

Reference it in your sample: `{ "type": "custom", "fn": "my-assertion.mjs" }`. The `fn` path is resolved relative to the samples file directory.

## CLI Reference

### `omk bench run`

```bash
omk bench run [options]

Options:
  --samples <path>       Sample file (default: eval-samples.json, auto-detects .yaml/.yml)
  --skill-dir <path>     Skill directory (default: skills)
  --variants <v1,v2>     Variant names (default: v1,v2)
  --model <name>         Model under test (default: sonnet)
  --judge-model <name>   Judge model (default: haiku)
  --output-dir <path>    Output directory (default: ~/.oh-my-knowledge/reports/)
  --no-judge             Skip LLM judging
  --dry-run              Preview only
  --blind                Blind A/B mode: hide variant names in report
  --concurrency <n>      Number of parallel tasks (default: 1)
  --repeat <n>           Run evaluation N times for variance analysis (default: 1)
  --executor <name>      Executor (default: claude)
```

### `omk bench ci`

Run evaluation in CI and exit with pass/fail code.

```bash
omk bench ci [options]

Options:
  (same as "bench run", plus:)
  --threshold <number>   Minimum composite score to pass (default: 3.5)
```

Exit code 0 = all variants pass, 1 = at least one variant below threshold.

### `omk bench report`

```bash
omk bench report [options]

Options:
  --port <number>        Server port (default: 7799)
  --reports-dir <path>   Reports directory (default: ~/.oh-my-knowledge/reports/)
```

### `omk bench init`

```bash
omk bench init [dir]    # Scaffold a new eval project
```

## Features

### Blind A/B Testing

Use `--blind` to hide variant names in reports. Variants are randomly labeled as "Variant A", "Variant B", etc. A reveal button in the HTML report shows the mapping.

### Parallel Execution

Use `--concurrency N` to run N tasks in parallel. Tasks maintain interleaved scheduling order to reduce time bias.

### Multi-run Variance Analysis

Use `--repeat N` to run the evaluation N times. The report includes:
- Per-variant mean, standard deviation, 95% confidence interval
- Pairwise Welch's t-test between variants (significance at p < 0.05)

### Auto-analysis

After each evaluation, the toolkit automatically detects:
- **Low-discrimination assertions**: assertions with identical results across all variants
- **Uniform scores**: samples where variants score within 0.5 of each other
- **All-pass / all-fail**: assertions that may be too loose or too strict
- **High-cost samples**: samples with disproportionately high cost

Insights and suggestions are shown in the HTML report.

### Human Feedback

The HTML report includes star rating (1-5) and comment forms for each sample-variant pair. Feedback is persisted to the report JSON via `POST /api/run/:id/feedback`.

### Traceability

Reports include `cliVersion`, `nodeVersion`, and `skillHashes` (SHA-256 of each skill file) in metadata for reproducibility.

## Executors

Use `--executor` to select which model provider to use.

| Executor | CLI Tool | Default Model | Auth |
|----------|----------|---------------|------|
| `claude` | `claude -p` | `sonnet` | Claude Max plan or API key |
| `openai` | `openai api chat.completions.create` | `gpt-4o` | `OPENAI_API_KEY` env var |
| `gemini` | `gemini` (stdin pipe) | Default Gemini model | Google account or `GOOGLE_API_KEY` |

```bash
# Use OpenAI
omk bench run --executor openai --model gpt-4o --variants v1,v2

# Use Gemini
omk bench run --executor gemini --model gemini-2.5-pro --variants v1,v2

# Compare the same skill across providers (run separately, compare reports)
omk bench run --executor claude --model sonnet --variants v1,v2
omk bench run --executor openai --model gpt-4o --variants v1,v2
```

**Prerequisites:**
- **claude**: Install [Claude Code](https://claude.ai/code) and authenticate
- **openai**: `pip install openai` and set `OPENAI_API_KEY`
- **gemini**: `npm i -g @google/gemini-cli` and authenticate with Google

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CCV_PROXY_URL` | Route requests through cc-viewer proxy for real-time visualization |
| `OMK_BENCH_PORT` | Report server port (default: 7799) |

## Requirements

- Node.js >= 20
- `claude` CLI installed and authenticated (Max plan works, no API key needed)

## License

MIT
