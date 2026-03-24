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
         │  │ (contains,  │ │ (rubric or   │  │
         │  │  regex...)  │ │  dimensions) │  │
         │  └─────────────┘ └──────────────┘  │
         └──────────────────┬─────────────────┘
                            │
                     ┌──────▼──────┐
                     │   Report    │
                     │  (JSON/HTML)│
                     └─────────────┘
```

## Eval Sample Format

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
      { "type": "not_contains", "value": "looks good", "weight": 0.5 }
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
| `assertions` | Deterministic (contains, regex, length) | Always — fast, reliable |
| `rubric` | LLM judge (1-5 score) | When nuance matters |
| `dimensions` | Per-dimension LLM scoring | When multi-faceted quality matters |
| Both | Weighted composite (50/50) | Best of both worlds |

### Assertion Types

| Type | Fields | Description |
|------|--------|-------------|
| `contains` | `value`, `weight` | Output contains substring (case-insensitive) |
| `not_contains` | `value`, `weight` | Output does NOT contain substring |
| `regex` | `pattern`, `flags`, `weight` | Output matches regex |
| `min_length` | `value`, `weight` | Output length >= value |
| `max_length` | `value`, `weight` | Output length <= value |

## CLI Reference

### `omk bench run`

```bash
omk bench run [options]

Options:
  --samples <path>       Sample file (default: eval-samples.json)
  --skill-dir <path>     Skill directory (default: skills)
  --variants <v1,v2>     Variant names (default: v1,v2)
  --model <name>         Model under test (default: sonnet)
  --judge-model <name>   Judge model (default: haiku)
  --output-dir <path>    Output directory (default: ~/.oh-my-knowledge/reports/)
  --no-judge             Skip LLM judging
  --dry-run              Preview only
  --executor <name>      Executor (default: claude)
```

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
