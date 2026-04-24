# Changelog

All notable changes to `oh-my-knowledge` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [0.18.0] - 2026-04-23

Initial public release.

### Offline evaluation (`omk bench`)

- Controlled-variable experiments: fix the model and samples, vary only the artifact and runtime context
- Six-dimension scoring shown independently: **Fact / Behavior / LLM-judge / Cost / Efficiency / Stability**
- 18 assertion types (substring, regex, JSON Schema, semantic similarity, tool-call behavior, custom JS, cost / latency caps, …)
- Multi-executor support: Claude CLI / Claude SDK / OpenAI / Gemini / Anthropic API / OpenAI API / any custom command
- Batch mode `--each` for evaluating multiple independent artifacts vs baseline in one run
- Multi-run variance analysis `--repeat N` with Welch t-test, Cohen's d, 95% CI independently per scoring layer
- Blind A/B mode, interleaved scheduling, parallel execution, result caching, artifact version fingerprint
- Knowledge-gap signals with severity weighting and LLM-assisted hedging classification (quantify risk exposure, not completeness proof)
- CI gate `omk bench ci` with three-layer all-pass semantics (catches single-layer regressions the composite would hide)
- Self-iterating improvement `omk bench evolve` (LLM rewrites → re-evaluate → keep if better → repeat)
- MCP-based URL fetching for private-doc URLs (SSO-protected knowledge bases)

### Production observability (`omk analyze`)

- Skill-health reports from Claude Code session traces: coverage / gap signals / execution stability / token & latency per skill
- Time-window filtering (`--last 7d` / `--from` / `--to`), skill whitelist, auto-inferred knowledge-base root
- Execution-stability warning when a skill's tool-failure rate exceeds 20% (flags gap signals as possibly environmental noise)
- Skill health **trend** view (per-skill time series: gap / failure / coverage / tokens)
- Skill health **diff** view (side-by-side comparison of two reports)

### Report server

- Local HTML report service (`omk bench report`), browses eval reports and skill-health reports in one place
- EN / ZH one-click language toggle, language choice persists across pages
- Evaluation-as-code via `eval.yaml` config

### Requirements

- Node.js >= 20
- `claude` CLI for the default executor and LLM judge; optional when using other executors with `--no-judge`
