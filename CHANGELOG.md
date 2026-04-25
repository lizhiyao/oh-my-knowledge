# Changelog

All notable changes to `oh-my-knowledge` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [0.20.0] - 2026-04-25

Major release — statistical rigor as a first-class concern, plus a verdict / diagnostics / RAG / budget surface that turns omk from "evaluation runner" into "evaluation reasoning system."

### Added — Statistical rigor four-piece (业界唯一全栈)

- **Bootstrap CI** (`--bootstrap` / `--bootstrap-samples`) — distribution-free confidence intervals for variant means + pairwise diff CI. t-test breaks on ordinal LLM scores; bootstrap stays valid at small N (< 30) and on skewed data. CI not crossing 0 = significant.
- **Human gold dataset workflow** with **Krippendorff α** — `omk bench gold {init,validate,compare}` and `omk bench run --gold-dir`. Brings external annotation as anchor; omk warns when gold annotator and judge are the same model. Supports α ordinal weights, weighted κ, Pearson, plus bootstrap CI on α itself.
- **Length-controlled judge prompt** (default ON, hash `v3-cot-length`) — research consistently shows LLM judges over-weight verbosity. omk's prompt now explicitly states "length is not a quality signal"; older reports hash-mismatch by design. Audit empirically via `omk bench debias-validate length`.
- **Saturation curves** (`omk bench saturation`, requires `--repeat ≥ 5`) — answers "do I have enough samples?". Three convergence methods (slope / bootstrap-ci-width / plateau-height); CI shrink rate < threshold across 3 windows = saturated.

### Added — Verdict and analysis surface

- `omk bench verdict <reportId>` — six-tier one-line verdict aggregating bootstrap CI / three-layer ci-gate / saturation / human α. Levels: PROGRESS / CAUTIOUS / REGRESS / NOISE / UNDERPOWERED / SOLO. Exit code routes for shell `&&` chains.
- HTML report top-of-page **verdict pill** sharing rules with the CLI.
- `omk bench diagnose <reportId>` — 7 sample-quality issue kinds (`flat_scores`, `all_pass`, `all_fail`, `near_duplicate`, `ambiguous_rubric`, `cost_outlier`, `latency_outlier`, `error_prone`) + 0-100 healthScore. CI-friendly exit code.
- `omk bench failures <reportId>` — single-LLM-call clustering of failure cases into ≤ N clusters with per-cluster root cause + suggested fix.
- `omk bench diff <reportId>` (single-arg) — within-report sample-level drilldown sorted by |Δ|; `--regressions-only` / `--top N` filters. Two-arg form (cross-report) preserved.

### Added — RAG metrics (auto length-debias)

- `faithfulness` / `answer_relevancy` / `context_recall` assertion types — single-call LLM judge with the same length-debias instruction as the main rubric. `reference` falls back to `sample.context` or `sample.prompt` as appropriate.
- `examples/rag-eval/` complete demo (3 samples covering grounded answer / concise summary / refusal).
- `docs/rag-metrics-spec.md` — prompt forms, comparison with RAGAS / DeepEval, known limitations.

### Added — Hard budget caps

- `--budget-usd` / `--budget-per-sample-usd` / `--budget-per-sample-ms` CLI flags.
- `eval.yaml` `budget: { totalUSD?, perSampleUSD?, perSampleMs? }` schema.
- `report.meta.budgetExhausted = true` flag when totalUSD trips abort; partial report persisted.
- Concept boundary documented:budget = workflow-level hard cap (abort);`cost_max` / `latency_max` assertions = per-sample scoring rules (continue).

### Added — Assertion improvements

- Universal `not: true` modifier — works on ANY assertion type (legacy `not_contains` / `not_equals` etc. preserved as aliases).
- `assert-set` combinator with `mode: 'any' | 'all'`, nestable.
- Deterministic similarity assertions: `rouge_n_min` / `levenshtein_max` / `bleu_min` — self-implemented, zero npm dep, supports CJK + Latin tokenization.

### Added — Production polish

- `omk bench verdict` and `omk bench diagnose` exit-code semantics designed for CI/CD chains
- HTML report verdict pill / pairwise CI / human-gold / saturation curve sections all 中英 i18n complete
- `examples/rag-eval/` and `examples/gold-dataset/` zero-config demos

### Changed

- SKILL.md updated:`--variants`(removed since v0.16) → `--control` / `--treatment`;`gen-samples` no longer takes a path;dead `references/commands.md` link replaced with README pointer.
- README zh + en synchronized to v0.20 surface (4 new CLI sections, 5 new feature rows, 3 new RAG assertion rows, budget vs `cost_max` concept boundary).
- Tagline rewritten to surface statistical rigor first ("LLM evaluation framework with built-in statistical rigor...").
- npm `keywords` expanded from 9 → 20 with long-tail SEO terms (bootstrap-ci / krippendorff-alpha / rag-evaluation / llm-judge / evaluation-as-code etc.).

### Removed

- Phase 3b position-aware judge debias permanently dropped — omk does per-(sample × variant) independent scoring rather than pairwise comparison, so classic position bias is not present in this architecture.

### Tests

- 503 → **673 tests passing** (+170 covering Bootstrap / α / Saturation / Verdict / RAG / Budget / Diagnose / Failure clustering)

---

## [0.19.0] - 2026-04-24

First iteration after the initial public release — product polish + open-source day-1 discoverability.

### Production observability (`omk analyze`)

- Renamed `production-analyzer` → `skill-health-analyzer` (closer to what the report actually shows)
- Separated **execution failure rate** from **knowledge gap rate** (a flaky tool chain is not the same as a missing skill)
- Added **cost / duration / turns** dimensions per skill (billable vs. cached tokens shown separately)
- Added **stability** classification per skill (`stable` / `unstable` / `very-unstable`) with 20% / 40% failure-rate thresholds
- Skill attribution signal 3: fallback via `Read SKILL.md` when the session didn't invoke the Skill tool explicitly
- Aligned `omk analyze` output with `omk bench` — JSON-only artifact, HTML rendered on-demand by `omk bench report`

### Report server

- **Skill health trend** page: per-skill time series (gap / weighted-gap / failure / coverage / tokens / duration)
- **Skill health diff** page: side-by-side comparison of two analyses with sort + removed/new tags
- Observability pages fully internationalized (EN / ZH), language choice persists across pages via URL + localStorage
- Version fingerprint UX: labeled "Version fingerprint" / "版本指纹" with tooltip, truncated to first 12 hex of SHA-256

### Offline evaluation (`omk bench`)

- Fixed `--each --repeat N` silently swallowing repeat (each-branch now threads `repeat`/`each` through `EvaluationRequest`)
- Fixed `--each` mode incorrectly requiring `--control` / `--treatment` variant-role arguments
- Per-skill variance now surfaces correctly in `--each` mode (was previously discarded)
- Unified separator in each-mode overview subtitle (`·` instead of mixing `·` and `×`)

### Open source

- English-first README with `README.zh.md` mirror; top-bar language switcher
- Gitflow branching model: `main` for tagged releases, `develop` for integration (see `CONTRIBUTING.md`)
- npm keywords expanded to 9 (added `claude-code`, `prompt-engineering`, `evaluation-framework`); added `homepage` and `bugs` fields
- Community files: `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue forms templates, PR template
- GitHub topics enriched with `claude-code` + `evaluation-framework`

### Developer experience

- Unified "six-dimension" terminology across README / docs / renderer (replaced stale "four-dimension" references)
- Per-page language persistence in report server
- CI runs `yarn build` before `yarn test` (fixes `test/cli.test.ts` dependency on `dist/`)

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
