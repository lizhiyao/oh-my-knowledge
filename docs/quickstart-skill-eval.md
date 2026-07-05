# omk quickstart: benchmark a skill

Get your first report in 5 minutes. Target audience: you have one (or several) skill files and want data to answer "is this skill any good?" or "which of v1 vs v2 is the safer bet?"

## Setup (1 minute)

```bash
npm i oh-my-knowledge -g
omk --version    # prints a version number once installed
```

If you want the **agent-driven workflow** (recommended), also install the omk Agent Skill into your coding agent:

```bash
omk install omk-agent-skill
```

By default, this installs only into detected local targets omk explicitly supports: Codex/AGENTS when `~/.codex` or `~/.agents` exists, and Claude Code when `~/.claude` exists. Use `--to all` to force every target omk currently knows, or `--dest` for a custom skill root. Once installed, the agent auto-loads the SKILL context when you mention "omk", "benchmark", "evaluate", "skill eval", etc.

## Prepare your skill (1 minute)

Place skills under `skills/`. **Single `.md` files are the simplest layout**:

```
skills/
├── my-skill-v1.md
└── my-skill-v2.md
```

Switch to a directory layout (one folder per version) only when a skill is large enough to need split-out examples or references:

```
skills/
├── my-skill-v1/
│   └── SKILL.md
└── my-skill-v2/
    ├── SKILL.md
    └── references/     long examples / reference material
        └── examples.md
```

Both layouts are recognized; mixing them is fine. For a v1 vs v2 A/B, drop in two versions. To answer "does this skill help at all" with a baseline control, one version is enough.

## Run the eval (3 minutes)

### Path A: natural language (recommended)

Open Claude Code, `cd` into your project, and say:

> Use omk to compare skills/my-skill-v1 against skills/my-skill-v2

The omk skill takes care of the rest: it auto-generates samples if `eval-samples.json` is missing, runs the eval, and opens the report in your browser. Other useful phrasings:

- "Use omk to compare skills/my-skill-v1 against skills/my-skill-v2"
- "Use omk to run a baseline control for skills/audit (with-skill vs without-skill)"
- "Use omk to batch-evaluate every skill under skills/"
- "Use omk evolve to auto-improve skills/my-skill-v2 over 5 rounds"

### Path B: command line

```bash
omk sample skills/my-skill-v2.md                                  # first time: AI-generate eval samples
omk eval --control my-skill-v1 --treatment my-skill-v2 --dry-run  # preview the task plan
omk eval --control my-skill-v1 --treatment my-skill-v2            # run for real
omk studio                                                        # open the report browser
```

Variant names come from the skill file or directory names under `skills/`; for the layout above, use `my-skill-v1` and `my-skill-v2`.

`--dry-run` prints expected call count and cost estimates — confirm, drop the flag, and run. `omk eval` runs a doctor health check as a preflight gate by default; if a skill has structural problems it gets blocked early. Pass `--skip-doctor` to bypass when you know what you're doing.

## Read the report (1 minute)

The browser auto-opens (default `http://127.0.0.1:7799/`). Look at three things:

**Verdict** (cross-version conclusion): `PROGRESS` (better) / `NOISE` (diff inside the confidence band, undecidable) / `REGRESS` (worse) / `CAUTIOUS` (trends look good but confidence is thin) — plus two edge cases, `UNDERPOWERED` (too few samples to conclude) and `SOLO` (single variant, nothing to compare against). This is the one-line answer to bring to a review meeting.

**Composite score**: each variant's average on a 0–5 scale, with a `+Δ` against the control. The confidence interval next to Δ — 95% by default, raised to a higher level (Bonferroni) when several treatments share one control — is what decides where the verdict lands.

**Low-scoring samples**: drill into the ones where the LLM tripped. Compare "rubric expectation" against "actual LLM output" — usually the gap points right back at a specific paragraph in the skill that wasn't clear enough.

## Act on the verdict

| Verdict | What to do next |
|---|---|
| `PROGRESS` | Ship through your normal release path. Keep the report as release evidence; if this is a managed skill installed with `omk install`, run `omk promote <name>` to record the acceptance decision. |
| `CAUTIOUS` | Do not ship blind. Inspect the warning that fired (layer gate, judge dissent, stability, or holdout), fix the issue, then re-run; loosen the gate only after explicit human review. |
| `REGRESS` | Do not ship. Start from the weakest layer and the failing samples, fix the artifact, then re-run the eval. |
| `NOISE` | No release call yet. Add samples or sharpen the sample set so the diff can separate from noise, then re-run. |
| `UNDERPOWERED` | Grow the sample set to roughly 20+ cases, or at least 2x the current size, then re-run. |
| `SOLO` | Add a control, usually `omk eval --control baseline --treatment <name>`, before making a ship/no-ship call. |

## Things to keep in mind

**Sample generation takes time.** omk asks the AI to generate 10–20 samples per skill by default, but AI-generated samples are **biased**: they cluster around the happy-path scenarios the skill already documents well, and undersample edge cases, counterexamples, and misuse paths. **Spend 30 minutes** after the first run filtering: drop the implausible ones, add the missing boundary cases, add a few "intentionally wrong user instructions" to see whether the skill resists being misled. This is the single biggest variable in how much you can trust your numbers.

**Evaluation costs LLM tokens.** Rough order of magnitude: one sample × one variant ≈ $0.01–0.05, ten samples × two variants ≈ $0.2–1. Always `--dry-run` first.

**Conclusions only generalize to the sample set you wrote.** "This version of the skill is better" is bounded by "better on the N samples I designed". Swap the sample set and the conclusion could flip. So **sample design itself is the source of conclusion credibility** — don't treat it as a chore before running the eval, it *is* the eval.

## Common task cheat-sheet

| Goal | Natural language | Equivalent command |
|---|---|---|
| First-time scoring of a skill | run a baseline control for skills/X | `omk eval --control baseline --treatment X` |
| Before/after a skill change | compare git history skills/X against current | `omk eval --control git:X --treatment X` |
| Auto-improve a skill | use omk evolve on skills/X for 5 rounds | `omk evolve skills/X.md --rounds 5` |
| Batch-eval every skill | run eval on every skill under skills/ | `omk eval --batch` |
| Generate samples only | generate eval samples for skills/X | `omk sample skills/X.md` |
| Run health-check alone | run a doctor health check on skills/X | `omk doctor skills/X.md` |
| View past reports | open omk studio | `omk studio` |

## What to bring to the review meeting after your first run

- Verdict + composite score + Δ + 95% CI band
- Which samples scored lowest, and where the gap between rubric expectation and LLM output was
- Which samples you have doubts about by design (it's healthy to "let data speak, then question the data")
- Doctor health-check result (eval runs it by default; run `omk doctor` alone if you want to audit the skill's structure separately)

## Going deeper

- The mental model — [the three stages: doctor / eval / observe](./explanation/three-stage-workflow.md)
- How a run actually works: [architecture](./explanation/architecture.md)
- Full CLI / executor / judge / observe reference: [README.md](https://github.com/lizhiyao/oh-my-knowledge/blob/main/README.md)
- Five-layer scoring pipeline (assertion / llm / judge / dimension / composite): [scoring.md](./specs/scoring.md)
- Statistical rigor (Bootstrap CI / Krippendorff α / length-debias): [statistical-rigor.md](./explanation/statistical-rigor.md)
- Sample design spec (`mocks` / `environment` / `tripwire` / `mocksStrict`): [sample-design-spec.md](./specs/sample-design-spec.md)
