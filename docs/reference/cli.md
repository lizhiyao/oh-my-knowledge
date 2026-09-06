# omk CLI reference

omk exposes a workflow CLI for knowledge artifacts. Top-level commands cover the full loop: `init` (initialize an omk project) · `install` (install the official omk Agent Skill) · `list` (managed skills & evidence status) · `promote` (accept a version on evidence) · `rollback` (revoke a promotion) · `doctor` (LLM health audit) · `eval` (offline A/B) · `observe` (online trace) · `evolve` (auto-iterate a skill) · `sample` (generate or fill test cases) · `studio` (browse local conversations, task trajectories, and knowledge-artifact reports).

<!-- Maintainers: the Flags blocks in this file are auto-generated from the oclif command source by scripts/build-docs.ts. Run `yarn build:docs` after editing CLI flags; `yarn build:docs:check` runs in CI to catch drift. -->

## `omk init`

```bash
omk init [dir]
```

<!-- omk:cli:init:flags:start -->

**Flags:**

```text
  --force           Allow overwriting existing project scaffold files in the target directory
  --lang <value>    Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --samples <3|20>  Number of first-party starter samples: 3 for a quick run, 20 to meet the default heuristic evidence floor
```

For full descriptions: `omk init --help`.

<!-- omk:cli:init:flags:end -->

Initializes an **omk project** in the target directory: knowledge artifacts to measure (today `skills/<name>/SKILL.md`) plus their eval samples (`eval-samples.json`) — the per-directory workspace that `omk eval` / `doctor` / `evolve` / `observe` / `list` all operate on. Like a git repo, you have one per measurement target (the sample set is the measurement context, so it travels with the artifact, not globally). The managed registry (`install` / `list` / `promote`, optionally global) is a separate layer `init` does not touch. The default three-case A/B template is a low-cost workflow check; `--samples 20` selects the first-party starter pack that meets the default heuristic evidence floor, not an a priori power plan. Starter samples are marked `llm-generated` and must be reviewed or replaced before serving as release evidence. Existing scaffold files are never overwritten unless `--force` is explicit.

## `omk install`

```bash
omk install omk-agent-skill            # built-in official omk Agent Skill (onboarding)
omk install omk-agent-skill --to all
omk install ./skills/review            # register + distribute a local skill (writes a managed record)
omk install git:main:skills/review     # install from a ref of the current repo (SHA is immutable, a branch drifts)
omk install ./skills/review --dest ~/.my-agent/skills
```

<!-- omk:cli:install:flags:start -->

**Flags:**

```text
  --dest <value>                  Custom skill root; a skill installs into <dir>/<name> (the built-in omk-agent-skill into <dir>/omk).
  --dry-run                       Print install targets without writing files.
  --force                         Overwrite an existing skill at the target location.
  --git-ref <value>               Remote git ref (branch / tag / SHA), default HEAD. Only with --git-url.
  --git-url <value>               Remote git repository URL (https / ssh / git@host:path). When set, the positional arg is the in-repo skill path (spec).
  --kind <skill|prompt|agent|workflow>Kind of the user artifact (aligns with Artifact.kind). Optional: inferred from SKILL.md; only skill is supported today.
  --lang <value>                  Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --to <value>                    Install target: auto (default, detected local targets) / codex / claude / all.
```

For full descriptions: `omk install --help`.

<!-- omk:cli:install:flags:end -->

Installs a knowledge input (skill) and distributes it to local supported coding-agent targets. Three sources: the built-in id `omk-agent-skill` (onboarding for the official omk Agent Skill), a local skill path (a directory or a `.md`), and `git:<ref>:<spec>` (a skill at a ref of the current repo). A `registry` / `marketplace` (resolving package names against a registry) is a non-goal.

Installing **your own** skill (local path or git source) also writes a **managed record** to `.omk/governance/managed/<id>.json` — the entry point of the "management" pillar, so evidence travels with the artifact through doctor / eval / promote. The `git:` source is the most reproducible: a SHA is immutable and content-addressed (anyone can re-fetch and verify), while a branch gives real drift semantics.

The default `auto` target writes only to detected targets omk explicitly supports: Codex/AGENTS when `~/.codex` or `~/.agents` exists, and Claude Code when `~/.claude` exists. Use `--to all` to force every target omk currently knows, or `--dest` for a custom skill root.

## `omk list`

```bash
omk list                 # managed skills in the current project (.omk/governance/managed)
omk list --global        # globally managed skills (~/.oh-my-knowledge/governance/managed)
omk list --json          # machine-readable output with full comparability markers
```

<!-- omk:cli:list:flags:start -->

**Flags:**

```text
  --global        Show the global managed dir (~/.oh-my-knowledge/governance/managed) instead of project .omk/governance/managed
  --json          Output JSON (with full comparability markers) for scripts
  --lang <value>  Output language zh|en. Priority: CLI > OMK_LANG env > zh.
```

For full descriptions: `omk list --help`.

<!-- omk:cli:list:flags:end -->

Lists managed skills with their **evidence status**, not just files: lifecycle state, the latest verdict bound to the current content, current/total evidence count, and source. The lifecycle is derived at read time — `installed` (no valid evidence), `measurable` (eval evidence bound to the current content fingerprint), `promoted` (current content has a human acceptance decision), `stale` (source content drifted off its evidence). Because the fingerprint covers a directory-skill's whole tree (`SKILL.md` + `references/`), editing any asset flips the skill to `stale`. `--json` emits a versioned envelope `{ schemaVersion, rows }` (rows with current valid evidence carry a comparability marker — `cliVersion`, optionally `judgePromptHash` / `debiasMode`) so scripts can detect shape changes. See [evidence-gated management](../specs/evidence-gated-management.md).

## `omk promote`

```bash
omk promote review                      # accept the current version if its evidence passes the gate
omk promote review --accept-cautious    # also accept a CAUTIOUS verdict
omk promote review --force --reason "manually reviewed"   # override the gate, recorded as a human decision
```

<!-- omk:cli:promote:flags:start -->

**Flags:**

```text
  --accept-cautious  also accept CAUTIOUS (default PROGRESS only)
  --actor <value>    decision actor (defaults to git config user.name)
  --force            override forceable gate blocks and force-promote, recorded as a human override (still refused with no current evidence or changed source hash)
  --global           operate on the global managed dir instead of project .omk/governance/managed
  --json             output JSON (versioned envelope) for scripts
  --kind <value>     artifact kind (only skill today)
  --lang <value>     Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --reason <value>   reason for the promotion / override (stored on the decision)
```

For full descriptions: `omk promote --help`.

<!-- omk:cli:promote:flags:end -->

Accepts a managed skill's current version as `promoted`, gated on its evidence, and appends a human decision (with an evidence pointer) to the record. The gate resolves against the latest **current** evidence (`contentHash` matching the record): the source must not be drifted/unreachable, current evidence must exist (no evidence ⇒ blocked, and `--force` cannot conjure one), the evidence's `judgePromptHash` (if present) must still be a current judge-prompt template, and the verdict must be `PROGRESS` (or `CAUTIOUS` with `--accept-cautious`). `--force` must be paired with a non-empty `--reason` and can only override source-unreachable / incomparable / verdict blocks; it still refuses missing current evidence or a reachable source whose content hash changed, because the decision would keep pointing at the old managed baseline. Re-promoting an already-promoted current version is an idempotent no-op. promote is the write-side counterpart to `omk list`. See [evidence-gated management](../specs/evidence-gated-management.md).

## `omk rollback`

```bash
omk rollback review                          # revoke the current version's promoted acceptance
omk rollback review --reason "regression found in prod"   # roll back and record a reason
```

<!-- omk:cli:rollback:flags:start -->

**Flags:**

```text
  --actor <value>   decision actor (defaults to git config user.name)
  --global          operate on the global managed dir instead of project .omk/governance/managed
  --json            output JSON (versioned envelope) for scripts
  --kind <value>    artifact kind (only skill today)
  --lang <value>    Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --reason <value>  reason for the rollback (stored on the decision)
```

For full descriptions: `omk rollback --help`.

<!-- omk:cli:rollback:flags:end -->

Rolls back a managed skill's current `promoted` acceptance — the inverse of `omk promote`. Because decisions are an append-only event stream, rollback appends a `rollback` decision rather than deleting the promote; the lifecycle is then derived from the **latest** promote/rollback decision for the current content, so the state derives back to `measurable` — or stays `stale` if the source has since drifted off the baseline, since rollback does not probe the source. rollback is content-anchored and needs no gate (de-escalation is always safe): it operates purely on the record's promote/rollback history for `record.contentHash`. Rolling back a version that isn't promoted exits non-zero (nothing to roll back); rolling back an already-rolled-back version is an idempotent no-op; and `promote → rollback → promote` restores `promoted` (latest wins). See [evidence-gated management](../specs/evidence-gated-management.md).

## `omk doctor`

```bash
omk doctor                              # audit current dir / ./skills
omk doctor skills/v1.md                 # audit one skill file
omk doctor skills/ --json > r.json      # JSON for CI / external tools
omk doctor --gate; echo $?              # silent gate; exit 1 on fatal failures, warnings do not block
omk doctor --repeat 1                    # single quick pass (no sampling/merge, cheapest)
omk doctor --static-only                 # static checks only: no LLM, no samples — structural + body-deps
```

<!-- omk:cli:doctor:flags:start -->

**Flags:**

```text
  --concurrency <value>  Concurrency across the repeated passes. Default = --repeat (full parallel; passes are independent, cuts wall-clock). Set 1 for serial. Cost unchanged; only raises peak concurrency (lower it if rate-limited).
  --dimensions <value>   Custom dimensions config file (YAML), appended after builtin 7. Each is either promptSection (LLM audit) or endpoint (POST skill snapshot to your service). Note: endpoint sends the full SKILL.md + sub-files to that URL — only enable for trusted configs/URLs.
  --effort <value>       LLM reasoning effort: low / medium / high / xhigh / max.
  --executor <value>     Executor name. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference. A test fixture path is also accepted in tests.
  --fix                  Interactive fix: use LLM agent to fix skill issues reported by doctor.
  --gate                 Silent mode: only emit stderr summary on fail. Exit code carries the signal.
  --global               Write to global ~/.oh-my-knowledge/doctor instead of project .omk/doctor
  --json                 JSON output to stdout, for CI / external script consumption.
  --lang <value>         Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --model <value>        LLM model name. Codex reads the local configured model; OMK_MODEL sets an environment preference.
  --output-dir <value>   Report output dir, default project-level .omk/doctor (--global for global).
  --repeat <value>       Health-check repeat count (self-consistency). Default 2: runs 2 passes in parallel, unions findings, merges same root cause via an LLM pass, tags k/N support. Set 1 for a single quick pass (no sampling/merge, cheapest).
  --static-only          Static checks only (no LLM, no samples.json): readability / frontmatter / existence of scripts·CLI·files·env referenced in the skill body. For CI without LLM creds / offline.
  --timeout <value>      Single-session LLM timeout sec, default 600 (10 min).
```

For full descriptions: `omk doctor --help`.

<!-- omk:cli:doctor:flags:end -->

By default doctor runs static rules first (skill readability, frontmatter, body dependencies), then the LLM health audit. A single LLM session emits per-dimension grades, findings, and suggestions for the 7 builtin dimensions; results are sorted fail→warn→pass→skipped with errors first within each dim. Dimensions are extensible — call `registerHealthDimension` in your own code and the new section is folded into the same LLM call's prompt and report (order = registration order). To browse a visual report, run `omk studio` and pick the latest run.

Custom dimensions via `--dimensions <yaml>`: each entry is either an **LLM dimension** (`promptSection` — folded into the health LLM call) or an **endpoint dimension** (`endpoint` — doctor POSTs the skill snapshot to your service and maps the response). The two are mutually exclusive per dimension. Endpoint dimensions are "online" checks (run alongside the LLM audit), letting you do deep checks that prompts can't express — e.g. calling an external security-audit service.

```yaml
dimensions:
  # LLM dimension
  - id: tone-check
    displayName: Tone check
    severity: warn
    promptSection: Check that the skill copy is polite and unambiguous.
  # endpoint dimension
  - id: deep-security-audit
    displayName: Deep security audit
    severity: fatal
    endpoint: https://my-service.com/audit   # POST here
    headers: { Authorization: "Bearer xxx" }  # optional auth headers
    params: { env: production }               # optional, passed through verbatim
    includeFiles: true                        # optional (default true): bundle references/scripts
    maxFileBytes: 204800                      # optional: per-file byte cap (default 200KB; larger files truncated)
    maxTotalBytes: 2097152                    # optional: total files byte cap (default 2MB; collection stops beyond)
    allowPrivateHost: false                   # optional: allow private/loopback endpoint (default false — refused to prevent SSRF)
```

Request body (doctor → endpoint): `{ dimensionId, params, skill: { name, content, skillRoot, ref, files } }` — `files` is a relative-path → content map of the skill's sub-files (text only; each file is truncated at `maxFileBytes`, default 200KB, and the whole `files` payload is capped at `maxTotalBytes`, default 2MB — both overridable per dimension). Response (endpoint → doctor): `{ status: "pass"|"warn"|"fail", message: string, hint?: string, detail?: object }`. Any network error / non-2xx / protocol violation maps to a `fail` so problems surface instead of silently passing. Response fields are size-bounded before landing in the report (long `message` / `hint` truncated; oversized `detail` replaced with `{ truncated: true, preview }`).

Endpoint URL validation: only `http` / `https` schemes are accepted, and endpoints pointing at private/loopback hosts — localhost, `*.local`, `::1`, 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (including cloud metadata `169.254.169.254`) — are refused by default: doctor sends the full skill snapshot to the endpoint and echoes its response into the report, which would otherwise make it an SSRF vector. Set `allowPrivateHost: true` on a dimension to opt in for a trusted internal service. This is a literal hostname check (defense-in-depth) — no DNS resolution is performed, so a public domain resolving to a private IP (DNS rebinding) is out of scope.

Sampling & consensus: by default `omk doctor` runs the audit `--repeat 2` times in parallel, takes the union of findings, and merges same-root-cause findings (across differing wording) via one extra LLM clustering pass, tagging each finding with `k/n` support (how many of the n passes reported it). This makes repeated runs converge instead of surfacing a different subset each time. Set `--repeat 1` for a single quick pass; raise it for a deeper, more stable audit. `--concurrency` throttles the parallelism (default = `--repeat`).

Static-only checks (`--static-only`): runs only the same static lint rules included in default doctor with zero LLM calls and **without loading `samples.json`** — skill readability, frontmatter validity, and whether scripts / CLIs / files / env vars referenced in the **skill body** exist. Useful for CI nodes without `claude` / `codex`, or offline debugging. The samples-contract check is intentionally excluded (it needs `samples.json`); it stays as `omk eval`'s pre-evaluation gate, alongside the same dependency check enriched there with the samples' declared `requires`.

## `omk eval`

```bash
omk eval --control baseline --treatment my-skill                # single-skill necessity test (baseline = reserved "no skill" variant)
omk eval --control code-review-v1 --treatment code-review-v2    # multi-variant A/B
omk eval --config eval.yaml
omk eval --batch
omk eval gold compare <run-id> --gold-dir gold-dataset \
  --target <id> --evaluator <id> --metric <id> --minimum-alpha <value>
```

Runs the offline evaluation, applies the verdict gate, persists the report, and returns a ship/no-ship exit code. Bootstrap CI is enabled by default on this workflow.

`eval gold compare` is a separate, exploratory post-hoc calibration. `--minimum-alpha` is optional; when supplied, OMK assesses the Krippendorff alpha confidence-interval lower bound against that explicit threshold. Without it, the assessment is inconclusive with `gold-agreement-threshold-not-configured`—OMK does not assume a universal reliability cutoff. The v2 interval follows Krippendorff's reliability bootstrap: it resamples paired observed disagreement while holding expected disagreement fixed from the original ratings, so degenerate draws are not silently discarded. Perfect observed agreement has a structured “bootstrap not applicable” state rather than a fabricated interval. This assessment does not rewrite the run's preregistered release verdict or change the command's exit status.

<!-- omk:cli:eval:flags:start -->

**Flags:**

```text
  --batch                         Batch mode: baseline vs each skill; repeat must be 1
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
  --executor <value>              Executor: claude / claude-sdk / codex / codex-sdk / anthropic-api / openai-api / custom. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference.
  --global                        Write report to global ~/.oh-my-knowledge/eval instead of project .omk/eval
  --gold-dir <value>              Gold dataset dir
  --holdout-ratio <value>         Holdout fraction 0-1 (e.g. 0.3); splits a holdout subset, compares train/holdout composite to flag overfitting
  --judge-models <value>          Judge config: executor:model[,...], e.g. claude:haiku or codex:<model> (≥ 2 = ensemble). Defaults to the selected executor; Codex reuses the evaluated model.
  --judge-repeat <value>          Judge each dim N times
  --lang <value>                  Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --layered-stats                 Emit layered stats
  --mcp-config <value>            MCP config path
  --model <value>                 Evaluated model
  --no-debias-length              Disable length-debias (default on)
  --no-diagnostic                 Disable the diagnostic projection over Core failures, missing evidence, exclusions, and stable reason codes.
  --no-evidence                   Do not append this run as evidence to managed records (auto-written for installed skills by default).
  --no-gate                       Disable verdict gate
  --no-judge                      Skip LLM judge
  --no-serve                      Do not start report server
  --no-strict-baseline            Disable baseline isolation
  --output-dir <value>            Report output dir (default project .omk/eval)
  --repeat <value>                Predeclare the independent run count for the Evaluation Series
  --report-only                   Produce the report and print verdict, but always exit 0 (no CI gate).
  --resume <value>                Reuse a fully verified Core runId; fail closed when rejected
  --retry <value>                 Per-sample retry count
  --samples <value>               Samples path. Auto-discovers eval-samples.json / eval-samples.yaml at project scope or for a single directory-skill treatment; an explicit path may be a JSON / YAML file or split directory.
  --skill-dir <value>             Skill dir, default skills
  --skip-connectivity             Skip LLM connectivity preflight
  --skip-doctor                   Escape hatch: skip the doctor health-check gate (on by default). Use when sandbox mocks supply deps; caller owns garbage-in risk.
  --strict-baseline               Force baseline isolation (default true)
  --threshold <value>             Verdict threshold, default 3.5
  --timeout <value>               Per-sample timeout sec, default 120
  --treatment <value>             Treatment variants, comma-separated (artifact identity only)
  --treatment-cwd <value>         Runtime context dirs for treatments, comma-separated, index-aligned with --treatment (blank = none)
  --trivial-diff <value>          Trivial diff tolerance; 0 disables tolerance
  --verbose                       Verbose logging
```

For full descriptions: `omk eval --help`.

<!-- omk:cli:eval:flags:end -->

`--repeat` creates one preregistered Evaluation Series with a fixed number of independent Runs. Set the count before looking at results and report every member Run. It is not safe to keep launching new Runs after an unfavorable verdict and stop at the first favorable one; that is unadjusted optional stopping. `--retry` is separate and applies only to operationally failed sample attempts under the sealed retry policy.

Studio opens the validated Core run rather than a second report model. The run detail projects operational, evidence, and conclusion status separately; shows numeric observations, Analysis results, Decision reason codes, cost, coverage, and provenance; and links every view back to immutable Core artifacts. Diagnostic post-processing is limited to authenticated Core failures, missing evidence, exclusions, and stable reason codes. For the sandbox-mock semantics behind `mocks` / `environment` / `tripwire` / `mocksStrict`, see [sample-design-spec.md §三](../specs/sample-design-spec.md).

## `omk observe`

`omk observe` ships two workflows: the default skill-health report, and the observe inbox (`ingest` / `inbox` / `show`) for human review.

### A. Skill-health report (default)

```bash
# ChatGPT desktop / Codex CLI
omk observe ~/.codex/sessions --last 7d

# Claude Code
omk observe ~/.claude/projects/-Users-you-Documents-my-project
omk observe ~/.claude/projects/my-project --last 7d
omk observe ~/.claude/projects/my-project --from 2026-04-01T00:00:00Z --to 2026-04-15T23:59:59Z
omk observe ~/.claude/projects/my-project --skills audit,polish
omk observe ~/.claude/projects/my-project --kb /path/to/project
```

<!-- omk:cli:observe:flags:start -->

**Flags:**

```text
  --feedback            Feed production-health observations back to managed skills of the same name (--no-feedback to disable)
  --from <value>        Start time ISO, overrides --last
  --global              Write to global ~/.oh-my-knowledge/observe/health instead of project .omk/observe/health
  --kb <value>          KB root, enables KB-aware analysis
  --lang <value>        Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --last <value>        Time window (7d / 24h / 30m)
  --output-dir <value>  Health report output dir, default project-level .omk/observe/health (--global for global)
  --skills <value>      Filter to specific skills, comma-separated
  --to <value>          End time ISO
```

For full descriptions: `omk observe --help`.

<!-- omk:cli:observe:flags:end -->

Normalizes real Codex rollouts, Claude Code and OpenClaw sessions, and markdown conversation logs into source-neutral Trace IR, then produces skill-health reports: knowledge usage, [gap signals](../specs/knowledge-gap-signal-spec), execution stability, tokens, and latency. This is production observation, not production scoring.

### B. observe inbox: reviewer loop

Parses, aggregates, and de-noises real session traces into a per-observation list a human can review. The base pipeline is local-only and LLM-free; `--llm-enhanced-review` is an explicit optional model call.

```bash
# 1. Parse traces, aggregate signals, write to .omk/observe/inbox/
omk observe ingest ~/.codex/sessions
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

Supported trace formats: Codex rollout JSONL (`.jsonl`), Claude Code session JSONL (`.jsonl`), OpenClaw session JSONL (`.jsonl`), and markdown conversation logs (`.log`).

## `omk evolve`

```bash
omk evolve <skill>                  # multi-round auto-iteration on a skill
omk evolve skills/foo.md --rounds 10 --target 4.5
```

<!-- omk:cli:evolve:flags:start -->

**Flags:**

```text
  --concurrency <value>           Eval concurrency, default 1
  --edit-budget <value>           Max fraction of skill lines a round may change (default 0.2). Over-budget candidates are rejected before evaluation, saving eval cost
  --effort <value>                Reasoning effort: low/medium/high/xhigh/max
  --executor <value>              Executor name. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference.
  --improve-mode <agent|rewrite>  Improvement strategy (default: agent)
  --improve-model <value>         LLM that rewrites the skill; defaults to the evaluated model
  --judge-models <value>          Judge model (single judge required), executor:model format. Defaults to the selected executor; Codex reuses the evaluated model.
  --lang <value>                  Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --model <value>                 Evaluated LLM. Codex reads the local configured model. Also used to generate samples when none exist.
  --no-edit-budget                Disable the edit budget (allow arbitrarily large single-round edits)
  --no-reject-memory              Disable rejected-edit memory (do not feed rejected edits back into the next prompt)
  --rounds <value>                Max iteration rounds, default 5
  --samples <value>               Samples file, default eval-samples.json
  --skip-doctor                   Skip doctor gate (escape hatch; user takes garbage-in risk)
  --snapshot-only                 Produce candidates under evolve/ without writing the source. Managed skills normally write back only after a final Core gate and record Core evidence.
  --target <value>                Target composite score; stop when reached. If omitted, runs all rounds.
  --timeout <value>               Per-sample timeout sec, default 600
```

For full descriptions: `omk evolve --help`.

<!-- omk:cli:evolve:flags:end -->

Auto-iterates a skill through repeated eval → judge → rewrite loops until it hits `--target` or exhausts `--rounds`. Cost scales with `rounds × samples × variants`; a typical run takes minutes to tens of minutes. Original skill files are versioned under `skills/evolve/*.r0.md`.

The CLI completion summary reports the whole evolve process cost: rewrites, optional sample fixes, and all evaluations performed during selection. In the merged evolve report, `meta.totalCostUSD` is deliberately narrower: it is the measurement cost represented by the retained round results. The end-to-end amount is persisted separately as `meta.evolve.processCostUSD`. Either value is a lower bound when its corresponding `*CostReported` flag is `false`.

`omk evolve` is a one-shot loop: it runs the doctor gate before each round by default (`--skip-doctor` to bypass), and **if the target skill has no eval samples yet, it auto-generates a batch first** (equivalent to running `omk sample`) before evolving. So for a brand-new skill, `omk evolve skills/foo.md` alone walks the full "doctor → generate samples → self-iterate" path. Existing samples are used as-is, never regenerated.

On a **managed** skill (registered via `omk install`), a successful evolve also feeds the management layer: it records the winner as evidence and re-baselines the record to the new content, so `omk list` shows the skill `measurable` instead of `stale`. Advancing it to `promoted` stays a separate human `omk promote` call (evolve's statistical accept-gate is not a production-acceptance decision). `--snapshot-only` skips the source write entirely — the winner stays under `evolve/` for you to inspect and apply, and the managed record is left untouched.

## `omk sample`

```bash
omk sample <skill>                  # generate or fill eval-samples test cases for one skill
omk sample --batch                  # generate for skills missing eval-samples
```

<!-- omk:cli:sample:flags:start -->

**Flags:**

```text
  --append                    Append newly generated samples to the existing samples file (colliding sample_id auto-suffixed, original json/yaml shape kept). Single-skill mode only; not supported with --batch / --from-traces. Without it, an existing file errors out. Often paired with --focus.
  --batch                     Batch mode: scan --skill-dir, generate samples for any skill missing them.
  --count <value>             Number of samples to generate. Defaults to LLM auto-selection by skill type.
  --executor <value>          Executor name. Defaults to codex inside Codex tasks; OMK_EXECUTOR sets an environment preference.
  --focus <value>             Generation focus (NL hint). Steers LLM toward certain sample types.
  --from-traces               from-traces mode: recycle observe-inbox failure signals into draft regression samples (provenance: production-trace) for review.
  --lang <value>              Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --model <value>             Generation LLM model name. Codex reads the local configured model; OMK_MODEL sets an environment preference.
  --no-mock                   Skip mocks. Automatically enabled when the executor cannot intercept tools, preventing impossible mock_hit assertions.
  --observations-dir <value>  Observe inbox dir (from-traces mode), default project .omk/observe/inbox.
  --skill <value>             Only draft from observe-inbox signals for the specified skill (from-traces mode only).
  --skill-dir <value>         Skill root dir, default skills. Used by batch mode.
```

For full descriptions: `omk sample --help`.

<!-- omk:cli:sample:flags:end -->

One-shot generation. Auto-stamps `provenance` on generated cases. Generated assertions use English, numbers, or code tokens so they compare cleanly across bilingual outputs.

## `omk studio`

```bash
omk studio
omk studio --port 7799
omk studio --host 0.0.0.0                          # LAN access (default: 127.0.0.1)
omk studio --reports-dir ~/.oh-my-knowledge/eval
omk studio --observations-dir .omk/observe/inbox    # observe inbox data directory
omk studio --no-open
```

<!-- omk:cli:studio:flags:start -->

**Flags:**

```text
  --analyses-dir <value>      Observe-health reports dir (optional, default project .omk/observe/health, falls back to global)
  --dev                       Dev mode: child process with hot reload
  --doctors-dir <value>       Doctor reports dir (optional, default project .omk/doctor, falls back to global)
  --global                    View only global eval, observe/health, doctor, and observe/inbox directories under ~/.oh-my-knowledge/; does not affect governance/managed
  --host <value>              Listen host, default localhost. Use 0.0.0.0 to expose to LAN
  --lang <value>              Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --no-open                   Do not auto-open browser
  --observations-dir <value>  Observe-inbox data dir (optional, default .omk/observe/inbox)
  --port <value>              Listen port, default 7799. Pass 0 for OS-assigned
  --reports-dir <value>       View only this Core reports dir (optional; default aggregates current project + global)
```

For full descriptions: `omk studio --help`.

<!-- omk:cli:studio:flags:end -->

Starts the local knowledge workbench. The homepage indexes local Codex conversations directly and prioritizes running work. Select a conversation and task to inspect its four-lane Task Trajectory, then cross-check the semantic trajectory against normalized events and raw logs. Running tasks support live following; stale unclosed tasks are labeled **End status not recorded**. This browsing path does not require `omk observe ingest` first.

The top-level **Knowledge artifacts** entry exposes doctor, Core eval, and observe views. Core run pages project operational status, evidence coverage, numeric observations, Analysis results, Decision reason codes, and lineage from validated artifacts. Visit `/observe-inbox` for the observation reviewer queue. CI gates use `omk eval`'s exit route, while automation should read the Core report artifacts.
