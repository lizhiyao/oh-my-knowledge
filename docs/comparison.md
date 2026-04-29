# omk vs alternatives

A factual comparison with seven other LLM evaluation tools, as of 2026-04. Corrections welcome via PR — if a competitor adds a feature we mark `✗`, we'll happily update.

[简体中文](./zh/comparison.md)

## TL;DR

omk's moat is **statistical rigor**: every conclusion is auditable by a researcher. Bootstrap CI, Krippendorff α against gold annotations, length-debias judge prompt, saturation curves — none of the other tools surveyed ship all four.

If you need a **hosted SaaS dashboard**, choose LangSmith or Confident AI.
If you want **quick local prompt iteration without statistics**, choose promptfoo.
If you need **academic-grade benchmark coverage**, choose lm-evaluation-harness.
If you need **agent sandbox isolation** for safety evaluations, choose inspect-ai.
**If you ship to production and someone will ask "why should I trust this number?", choose omk.**

## Tools compared

| Tool | Language | Position | License |
|---|---|---|---|
| [**omk**](https://github.com/lizhiyao/oh-my-knowledge) | TS / Node | LLM eval with statistical rigor + Claude Code native | MIT |
| [promptfoo](https://github.com/promptfoo/promptfoo) | TS / Node | Local CLI, red-team focus, OpenAI acquired | MIT |
| [DeepEval](https://github.com/confident-ai/deepeval) | Python | Pytest-style metrics, paid SaaS upsell | Apache 2.0 |
| [RAGAS](https://github.com/explodinggradients/ragas) | Python | RAG-specific metrics, statement decomposition | Apache 2.0 |
| [OpenAI Evals](https://github.com/openai/evals) | Python | Benchmark registry, official OpenAI | MIT |
| [LangSmith](https://docs.smith.langchain.com/) | Python (LangChain) | Hosted SaaS, tracing + eval | Commercial |
| [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) | Python | Academic standard, HuggingFace Open LLM Leaderboard backend | MIT |
| [inspect-ai](https://github.com/UKGovernmentBEIS/inspect_ai) | Python | UK AISI safety evaluations | MIT |

## Statistical rigor

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| Bootstrap CI on variant means + diff | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Krippendorff α (judge ↔ human gold) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Length-debias judge prompt (default) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Saturation curve / sample-size diagnostic | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Paired-sample significance testing | ✓ (bootstrap) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

omk is the only tool surveyed that ships all five rigour pieces. The closest comparable is lm-evaluation-harness (academic reproducibility focus), but its statistical layer is single-point-estimate.

## Scoring architecture

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| Three-layer scoring (Fact / Behavior / Judge) isolation | ✓ | ✗ | partial | ✗ | ✗ | ✗ | ✗ | ✗ |
| Three-layer all-pass CI gate | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Per-variant skill-discovery isolation (construct validity) | ✓ default | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | partial |
| Sample design metadata (capability / difficulty / construct / provenance) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| One-line verdict (PROGRESS / REGRESS / NOISE / ...) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Knowledge gap signals (severity-weighted) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Sample quality diagnostics (7 issue kinds) | ✓ | low-discrim only | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Failure case LLM clustering | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

Three-layer isolation prevents single-axis regressions from being masked by composite averaging — a `fact 4.5 → 2.5` drop with `judge 3 → 5` boost looks fine in composite mean but is caught by all-pass gates.

**Per-variant skill-discovery isolation** closes a subtle construct-validity hole: when comparing `baseline` vs a skill variant, three separate channels could silently let `baseline` see whatever skill the user had in `~/.claude/skills/` — including the very skill being tested. omk defaults to `--strict-baseline`, which closes all three: (1) SDK skill auto-discovery via `options.skills:[]`, (2) subagent Skill tool via `options.disallowedTools:['Skill']`, and (3) the cwd file-system path — baseline's default cwd is `process.cwd()`, which usually contains a `skills/<name>/` symlink prepared for the treatment variant; baseline could `Glob` + `Read` straight through it, completely bypassing SDK isolation. omk redirects baseline's cwd to `~/.oh-my-knowledge/isolated-cwd/` (empty dir) when no explicit cwd is given. `--no-strict-baseline` escape hatch and per-variant `allowedSkills` whitelist in eval.yaml are also supported. inspect-ai's per-sample solver pattern achieves a similar effect for arbitrary tools but requires explicit per-test wiring; promptfoo / DeepEval / OpenAI Evals don't address this dimension.

## Judges

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| Multi-judge ensemble (cross-vendor) | ✓ Pearson + MAD | ✗ | ✗ | ✗ | ✗ | partial | ✗ | ✗ |
| Judge-repeat for stability | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Judge prompt hash traceability | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Length-bias empirical validation | ✓ `debias-validate` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Auto contamination detection (gold annotator vs judge) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

## Specialized metrics

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| RAG: faithfulness / answer_relevancy / context_recall | ✓ (length-debias inherited) | partial | ✓ | ✓ (multi-step) | ✗ | partial | ✗ | ✗ |
| ROUGE-N / Levenshtein / BLEU | ✓ self-impl, zero dep | ✓ | partial | ✗ | ✓ | ✗ | ✓ | ✗ |
| Semantic similarity (LLM-graded) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Tool-call / agent assertions | ✓ 9 types | ✗ | partial | ✗ | ✗ | partial | ✗ | ✓ strong |
| Custom JS/Python assertion | ✓ JS | ✓ JS | ✓ Python | partial | ✓ Python | ✓ Python | ✓ Python | ✓ Python |

## Workflow

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| Native Claude Code skill evaluation | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Production session JSONL parsing (omk analyze) | ✓ Claude Code | ✗ | ✗ | ✗ | ✗ | ✓ LangChain only | ✗ | ✗ |
| Auto self-iteration (`omk bench evolve`) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| eval.yaml (evaluation-as-code) | ✓ | ✓ | ✗ | ✗ | partial | ✗ | partial | ✓ |
| CI/CD `omk bench gate` exit-code routing | ✓ three-layer | ✓ basic | ✓ | ✗ | ✗ | partial | ✗ | ✓ |
| Hard budget caps (workflow abort) | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Resume from interruption | ✓ `--resume` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Blind A/B reveal | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ pairwise | ✗ | ✗ |
| Multi-run variance + t-test | ✓ + bootstrap | ✗ | ✗ | ✗ | ✗ | partial | ✗ | ✗ |

## Documentation & community

| | omk | promptfoo | DeepEval | RAGAS | OpenAI Evals | LangSmith | lm-eval-harness | inspect-ai |
|---|---|---|---|---|---|---|---|---|
| Full Chinese documentation | ✓ | partial (community) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| HTML report with i18n toggle | ✓ EN/ZH | partial | ✗ | ✗ | ✗ | partial | ✗ | ✗ |
| GitHub stars (Apr 2026) | new | 9k+ | 12k+ | 9k+ | 16k+ | (commercial) | 7.5k+ | 2k+ |
| Cloud SaaS dashboard | ✗ | ✗ | ✓ Confident AI | ✗ | ✗ | ✓ | ✗ | ✗ |

## When to choose omk

**Researchers / academia / NIST AI 800-3 alignment.** The four-piece statistical rigor is built specifically to satisfy "is this conclusion robust to small N / non-normal data / judge bias?" If you publish or audit, the bootstrap-CI + α + length-debias triple is the only off-the-shelf option.

**ML platform teams at large companies.** When you ship a skill / prompt to production and someone in the org will ask "why should I trust this number?", omk's audit trail (judge prompt hash, three-layer scores, bootstrap CI, gold α) gives you a defensible answer that survives a postmortem.

**Chinese-speaking AI engineering teams.** omk has the only complete Chinese documentation set among the surveyed tools — README, CLI help, HTML report, terminology spec, gap-signal spec, RAG-metrics spec, all native Chinese (not machine-translated).

**Claude Code users.** omk runs natively on Claude Code skills — `/omk eval` recognises your `skills/` directory automatically. promptfoo / DeepEval / others require shimming a custom executor.

## When NOT to choose omk

**You need a hosted SaaS dashboard with team accounts and shared dataset hubs.** Choose LangSmith or Confident AI. omk is intentionally CLI + local-HTML; we have no plan to ship a SaaS.

**You're red-teaming and need a library of attack prompts.** Choose promptfoo. It has 67+ red-team plugins; omk is general-purpose and doesn't focus on attack libraries.

**You're benchmarking foundation models against academic standards (HumanEval / MMLU / etc.).** Choose lm-evaluation-harness. It is the de-facto leaderboard backend; omk is not optimized for benchmark registry use.

**You need to run agent evaluations in tightly sandboxed Docker / Kubernetes / Modal environments for safety reasons.** Choose inspect-ai. UK AISI built it for that exact use case.

**You only have 5 prompts to test once.** Use a one-off Python script. omk's value compounds when you have repeated runs over time and need statistical comparability.

## Coexistence patterns

omk is happy to live alongside other tools. Common combinations:

- **omk + LangSmith** — omk for offline evaluation rigor + LangSmith for production tracing
- **omk + RAGAS** — RAGAS for fine-grained statement-decomposition faithfulness, then omk for cross-version regression with statistical CI
- **omk + lm-eval-harness** — lm-eval for foundation model leaderboard scores, omk for prompt / skill / RAG layer above it

## Updates and corrections

This page is maintained on a best-effort basis. Competitor capabilities change rapidly (e.g. promptfoo gained `assert-set` and DeepEval added the agentic eval suite during 2025). If you find a stale or wrong cell, please open a PR — we'll merge it.

Last verified: 2026-04-25.
