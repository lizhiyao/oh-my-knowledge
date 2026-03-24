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
         │  claude -p  │              │  claude -p  │
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

### Grading Strategy

| Criteria | Method | When |
|----------|--------|------|
| `assertions` | Deterministic + custom | Always — fast, reliable |
| `rubric` | LLM judge (1-5 score) | When nuance matters |
| `dimensions` | Per-dimension LLM scoring | When multi-faceted quality matters |
| Both | Weighted composite (50/50) | Best of both worlds |

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
