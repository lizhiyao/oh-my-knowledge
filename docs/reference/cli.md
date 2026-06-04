# omk CLI reference

omk exposes a workflow CLI for knowledge artifacts. Seven top-level commands cover the full loop: `init` (scaffold) · `doctor` (static check) · `eval` (offline A/B) · `observe` (online trace) · `evolve` (auto-iterate a skill) · `sample` (generate or fill test cases) · `studio` (local web UI for reports & analysis).

> Flag tables in this file are auto-generated from the oclif command source by `scripts/build-docs.ts`. Run `yarn build:docs` after editing CLI flags; `yarn build:docs:check` runs in CI to catch drift.

## `omk init`

```bash
omk init [dir]
```

<!-- omk:cli:init:flags:start -->

**Flags:**

```text
  --lang <value>  Output language zh|en. Priority: CLI > OMK_LANG env > zh.
```

For full descriptions: `omk init --help`.

<!-- omk:cli:init:flags:end -->

Scaffolds an evaluation project with two starter skill variants and an `eval-samples.json` file.

## `omk doctor`

```bash
omk doctor                              # audit current dir / ./skills
omk doctor skills/v1.md                 # audit one skill file
omk doctor skills/ --json > r.json      # JSON for CI / external tools
omk doctor --gate; echo $?              # silent gate; exit 1 on fatal failures, warnings do not block
omk doctor --static-only                # offline mode: static checks only, no LLM call
```

<!-- omk:cli:doctor:flags:start -->

**Flags:**

```text
  --dimensions <value>  Custom dimensions config file (YAML), appended after builtin 7 dimensions.
  --effort <value>      LLM reasoning effort: low / medium / high / xhigh / max.
  --executor <value>    Executor name, default claude. Pass a test fixture path to use in tests.
  --fix                 Interactive fix: use LLM agent to fix skill issues reported by doctor.
  --gate                Silent mode: only emit stderr summary on fail. Exit code carries the signal.
  --json                JSON output to stdout, for CI / external script consumption.
  --lang <value>        Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --model <value>       LLM model name, default sonnet.
  --output-dir <value>  Report output dir, default ~/.oh-my-knowledge/doctors.
  --samples <value>     Samples file path (.json/.yaml). Auto-detects from target / cwd if omitted.
  --static-only         Offline static mode: only 4 static rules, no LLM call.
  --timeout <value>     Single-session LLM timeout sec, default 600 (10 min).
```

For full descriptions: `omk doctor --help`.

<!-- omk:cli:doctor:flags:end -->

LLM health audit: a single LLM session emits per-dimension grades, findings, and suggestions for the 7 builtin dimensions; results are sorted fail→warn→pass→skipped with errors first within each dim. Dimensions are extensible — call `registerHealthDimension` in your own code and the new section is folded into the same LLM call's prompt and report (order = registration order). To browse a visual report, run `omk studio` and pick the latest run.

Static-only mode (`--static-only`): for CI nodes without claude / codex installed, or local debugging without network — runs the four static rules (readability / metadata / dependencies / samples contract) with zero LLM calls and zero cost. Output goes through the same `DoctorReport` shape and combines with `--json` / `--gate`.

`omk eval` still runs its own static readability / metadata / dependency / samples-contract gates internally to protect eval quality; that path is separate from this user-facing `omk doctor` command and the two roles do not overlap.

## `omk eval`

```bash
omk eval --control baseline --treatment my-skill                # single-skill necessity test (baseline = reserved "no skill" variant)
omk eval --control code-review-v1 --treatment code-review-v2    # multi-variant A/B
omk eval --config eval.yaml
omk eval --batch
omk eval gold compare <report-id> --gold-dir gold-dataset
```

Runs the offline evaluation, applies the verdict gate, persists the report, and returns a ship/no-ship exit code. Bootstrap CI is enabled by default on this workflow.

<!-- omk:cli:eval:flags:start -->

**Flags:**

```text
  --batch                         Batch mode: baseline vs each skill
  --blind                         Blind judge mode
  --bootstrap                     Add bootstrap CI
  --bootstrap-samples <value>     Bootstrap resamples, default 1000
  --budget-per-sample-ms <value>  Per-sample time cap ms (must be > 0; omit for no cap)
  --budget-per-sample-usd <value> Per-sample budget cap USD (must be > 0; omit for no cap)
  --budget-usd <value>            Total budget cap USD (must be > 0; omit for no cap)
  --concurrency <value>           Concurrency, default 1
  --config <value>                eval.yaml path
  --control <value>               Control variant expr (artifact identity only)
  --control-cwd <value>           Runtime context dir for control
  --dry-run                       Plan only, no real exec
  --effort <value>                Executor LLM reasoning effort low/medium/high/xhigh/max (default low; reports across efforts not strictly comparable).
  --executor <value>              Executor: claude / claude-sdk / codex / codex-sdk / openai-api / gemini / custom (default claude).
  --gold-dir <value>              Gold dataset dir
  --judge-models <value>          Judge config: executor:model[,...]. e.g. claude:haiku or claude:opus,openai:gpt-4o (≥ 2 = ensemble). Default <executor>:haiku.
  --judge-repeat <value>          Judge each dim N times
  --lang <value>                  Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --layered-stats                 Emit layered stats
  --mcp-config <value>            MCP config path
  --model <value>                 Evaluated model
  --no-cache                      Skip executor cache
  --no-debias-length              Disable length-debias (default on)
  --no-diagnostic                 Disable diagnostic LLM call (on by default; emits "what went wrong + how to fix" advice for failed samples).
  --no-gate                       Disable verdict gate
  --no-judge                      Skip LLM judge
  --no-serve                      Do not start report server
  --no-strict-baseline            Disable baseline isolation
  --output-dir <value>            Report output dir
  --repeat <value>                Repeat each sample N times
  --report-only                   Produce the report and print verdict, but always exit 0 (no CI gate).
  --resume <value>                Resume a previous failed run
  --retry <value>                 Per-sample retry count
  --samples <value>               Samples file path. Defaults to eval-samples.json (also .yaml/.yml); auto-discovers <skill>/.omk/samples.json under --skill-dir.
  --skill-dir <value>             Skill dir, default skills
  --skip-connectivity             Skip LLM connectivity preflight
  --skip-doctor                   Escape hatch: skip the doctor health-check gate (on by default). Use when sandbox mocks supply deps; caller owns garbage-in risk.
  --strict-baseline               Force baseline isolation (default true)
  --threshold <value>             Verdict threshold, default 3.5
  --timeout <value>               Per-sample timeout sec, default 600
  --treatment <value>             Treatment variants, comma-separated (artifact identity only)
  --treatment-cwd <value>         Runtime context dirs for treatments, comma-separated, index-aligned with --treatment (blank = none)
  --trivial-diff <value>          Trivial diff tolerance; 0 disables tolerance
  --verbose                       Verbose logging
```

For full descriptions: `omk eval --help`.

<!-- omk:cli:eval:flags:end -->

The HTML report has two tabs:
- **📊 Score view** — the verdict-driven A/B comparison (fact / behavior / judge layers, bootstrap CI, length-debias).
- **✅ Functional view** — each sample as a unit test: design (prompt / rubric / mocks / environment) + execution trace + assertion results + actionable diagnostic. Diagnostic emits root cause (skill_doc_unclear / llm_misread / sample_design / tripwire_intentional / ...), workflow checks (rubric step ✓/✗ with evidence), and failure-mode tags (工作流跳步 / 硬编码值 / 幻觉输出 / 工具误用 / 环境拦截 / 误读约束 / 其他). For the sandbox-mock semantics behind `mocks` / `environment` / `tripwire` / `mocksStrict`, see [sample-design-spec.md §三](../specs/sample-design-spec.md).

## `omk observe`

`omk observe` ships two workflows: the default skill-health report, and the new observe inbox for human review.

### A. Skill-health report (default)

```bash
omk observe ~/.claude/projects/-Users-you-Documents-my-project
omk observe ~/.claude/projects/my-project --last 7d
omk observe ~/.claude/projects/my-project --from 2026-04-01T00:00:00Z --to 2026-04-15T23:59:59Z
omk observe ~/.claude/projects/my-project --skills audit,polish
omk observe ~/.claude/projects/my-project --kb /path/to/project
```

<!-- omk:cli:observe:flags:start -->

**Flags:**

```text
  --from <value>        Start time ISO, overrides --last
  --kb <value>          KB root, enables KB-aware analysis
  --lang <value>        Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --last <value>        Time window (7d / 24h / 30m)
  --output-dir <value>  Analysis output directory
  --skills <value>      Filter to specific skills, comma-separated
  --to <value>          End time ISO
```

For full descriptions: `omk observe --help`.

<!-- omk:cli:observe:flags:end -->

Turns real Claude Code session traces into skill-health reports: knowledge usage, gap signals, execution stability, tokens, and latency. This is production observation, not production scoring.

### B. observe inbox: reviewer loop

Parses, aggregates, and de-noises real session traces into a per-observation list a human can review. The whole pipeline is local-only and LLM-free.

```bash
# 1. Parse traces, aggregate signals, write to .omk/observations/
omk observe ingest ~/.claude/projects/my-project
omk observe ingest ~/.claude/projects/my-project --output-dir ./custom-dir

# 2. Read the inbox (default: top 20, sorted by severity / confidence / lastSeen)
omk observe inbox
omk observe inbox --limit 50
omk observe inbox --skill audit                    # filter by skill
omk observe inbox --by-skill                       # rollup view (one row per skill)
omk observe inbox --explore 10                     # sample 10 long-tail items from medium/low
omk observe inbox --explore 10 --include-noise     # explicitly include the noise bucket
omk observe inbox --llm-enhanced-review            # run LLM enhanced chain review explicitly
omk observe inbox --json                           # JSON output for automation

# 3. Inspect a single observation with its event triplet (surrounding messages)
omk observe show <inbox_id>
```

Every observation carries:

- `confidence` and `attributionConfidence` — signal credibility plus skill-attribution credibility, displayed side by side
- `severityReasonCode` — stable structured reason code for the assigned severity; human-readable reasons are generated by CLI / studio rendering
- `messageWindow` — 3 messages before / trigger / 3 messages after, plus `resolutionAfter` (whether the agent recovered)
- `evidence.{messageIndex,messageUuid,toolUseId}` — anchors for round-tripping back to the original jsonl

Supported trace formats: Claude Code session JSONL (`.jsonl`), OpenClaw session JSONL (`.jsonl`), and markdown conversation logs (`.log`).

## `omk evolve`

```bash
omk evolve <skill>                  # multi-round auto-iteration on a skill
omk evolve skills/foo.md --rounds 10 --target 4.5
```

<!-- omk:cli:evolve:flags:start -->

**Flags:**

```text
  --auto-fix-samples              Fix the skill, then fix samples, then evaluate the combined candidate
  --concurrency <value>           Eval concurrency, default 1
  --effort <value>                Reasoning effort: low/medium/high/xhigh/max
  --executor <value>              Executor name, default claude
  --holdout-ratio <value>         Holdout fraction for the accept decision (0..1, default 0=off). When > 0, candidates are accepted on holdout score and weak samples come only from train — guards against train-on-test
  --improve-mode <agent|rewrite>  Improvement strategy (default: agent)
  --improve-model <value>         LLM that rewrites the skill, default sonnet
  --judge-models <value>          Judge model (single judge required), executor:model format. Default claude:haiku
  --lang <value>                  Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --model <value>                 Evaluated LLM, default sonnet
  --no-diagnostic                 Disable diagnostic LLM call
  --reuse-latest-eval             Reuse the latest comparable eval report as round-0
  --rounds <value>                Max iteration rounds, default 5
  --sample-fix-max-attempts <value>Max auto-fix attempts per sample (default: 2)
  --samples <value>               Samples file, default eval-samples.json
  --skip-connectivity             Skip LLM connectivity preflight
  --skip-doctor                   Skip doctor gate (escape hatch; user takes garbage-in risk)
  --stop-on-assertions-pass       Stop early when normal samples pass assertions
  --target <value>                Target composite score; stop when reached. If omitted, runs all rounds.
  --timeout <value>               Per-sample timeout sec, default 600
```

For full descriptions: `omk evolve --help`.

<!-- omk:cli:evolve:flags:end -->

Auto-iterates a skill through repeated eval → judge → rewrite loops until it hits `--target` or exhausts `--rounds`. Cost scales with `rounds × samples × variants`; a typical run takes minutes to tens of minutes. Original skill files are versioned under `skills/evolve/*.r0.md`.

## `omk sample`

```bash
omk sample <skill>                  # generate or fill eval-samples test cases for one skill
omk sample --batch                  # generate for skills missing eval-samples
```

<!-- omk:cli:sample:flags:start -->

**Flags:**

```text
  --batch                     Batch mode: scan --skill-dir, generate samples for any skill missing them.
  --count <value>             Number of samples to generate. Defaults to LLM auto-selection by skill type.
  --fix                       Fix mode: auto-fix sample_design failures using the latest eval report.
  --focus <value>             Generation focus (NL hint). Steers LLM toward certain sample types.
  --from-traces               from-traces mode: recycle observe-inbox failure signals into draft regression samples (provenance: production-trace) for review.
  --lang <value>              Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --model <value>             Generation LLM model name, default sonnet.
  --no-mock                   Skip mock generation; all tool calls execute for real during eval.
  --observations-dir <value>  Observe inbox dir (from-traces mode), default project .omk/observations.
  --reports-dir <value>       Reports dir (fix mode), default ~/.oh-my-knowledge/reports.
  --skill-dir <value>         Skill root dir, default skills. Used by batch mode.
  --treatment <value>         Treatment name (fix mode), defaults to skill-path inference.
```

For full descriptions: `omk sample --help`.

<!-- omk:cli:sample:flags:end -->

One-shot generation. Auto-stamps `provenance` on generated cases. Generated assertions use English, numbers, or code tokens so they compare cleanly across bilingual outputs.

## `omk studio`

```bash
omk studio
omk studio --port 7799
omk studio --host 0.0.0.0                          # LAN access (default: 127.0.0.1)
omk studio --reports-dir ~/.oh-my-knowledge/reports
omk studio --observations-dir .omk/observations    # observe inbox data directory
omk studio --no-open
```

<!-- omk:cli:studio:flags:start -->

**Flags:**

```text
  --analyses-dir <value>      Analyses dir (optional)
  --dev                       Dev mode: child process with hot reload
  --host <value>              Listen host, default localhost. Use 0.0.0.0 to expose to LAN
  --lang <value>              Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --no-open                   Do not auto-open browser
  --observations-dir <value>  Observations dir (optional)
  --port <value>              Listen port, default 7799. Pass 0 for OS-assigned
  --reports-dir <value>       Reports dir, default ~/.oh-my-knowledge/reports
```

For full descriptions: `omk studio --help`.

<!-- omk:cli:studio:flags:end -->

Starts the local knowledge workbench for browsing reports and observation analyses. Verdict, sample diffs, regressions, saturation curves, and per-sample drill-downs all live in the studio UI — there is no CLI export / analysis subcommand. For CI gates, use `omk eval`'s exit code (0 on `PROGRESS`, non-zero otherwise) or `jq` over the report JSON.

Studio is skill-centric — the list page (`/`) shows skill cards with health band / 0-100 reference score / open-issue count / trend; the detail page (`/skills/<name>`) puts a prioritized issue checklist on the left (skill issues / sample issues / tool advisories), and a chart.js health trend plus three compact stage cards (doctor / eval / observe) on the right, with modals for deeper drill-down. The legacy run list moved to `/runs`. Visit `/observations/inbox` for the observe inbox dashboard: per-skill rollup view, reviewer action list, observability funnel, and a per-observation detail panel with the event triplet (surrounding messages).
