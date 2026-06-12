# omk CLI reference

omk exposes a workflow CLI for knowledge artifacts. Top-level commands cover the full loop: `init` (initialize an omk project) · `install` (install the official omk Agent Skill) · `list` (managed skills & evidence status) · `promote` (accept a version on evidence) · `rollback` (revoke a promotion) · `doctor` (static check) · `eval` (offline A/B) · `observe` (online trace) · `evolve` (auto-iterate a skill) · `sample` (generate or fill test cases) · `studio` (local web UI for reports & analysis).

<!-- Maintainers: the Flags blocks in this file are auto-generated from the oclif command source by scripts/build-docs.ts. Run `yarn build:docs` after editing CLI flags; `yarn build:docs:check` runs in CI to catch drift. -->

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

Initializes an **omk project** in the target directory: knowledge artifacts to measure (today `skills/<name>/SKILL.md`) plus their eval samples (`eval-samples.json`) — the per-directory workspace that `omk eval` / `doctor` / `evolve` / `observe` / `list` all operate on. Like a git repo, you have one per measurement target (the sample set is the measurement context, so it travels with the artifact, not globally). The managed registry (`install` / `list` / `promote`, optionally global) is a separate layer `init` does not touch. The two starter skill variants + three sample cases are just the default A/B template.

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

Installing **your own** skill (local path or git source) also writes a **managed record** to `.omk/managed/<id>.json` — the entry point of the "management" pillar, so evidence travels with the artifact through doctor / eval / promote. The `git:` source is the most reproducible: a SHA is immutable and content-addressed (anyone can re-fetch and verify), while a branch gives real drift semantics.

The default `auto` target writes only to detected targets omk explicitly supports: Codex/AGENTS when `~/.codex` or `~/.agents` exists, and Claude Code when `~/.claude` exists. Use `--to all` to force every target omk currently knows, or `--dest` for a custom skill root.

## `omk list`

```bash
omk list                 # managed skills in the current project (.omk/managed)
omk list --global        # globally managed skills (~/.oh-my-knowledge/managed)
omk list --json          # machine-readable output with full comparability markers
```

<!-- omk:cli:list:flags:start -->

**Flags:**

```text
  --global        Show the global managed dir (~/.oh-my-knowledge/managed) instead of project .omk/managed
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
  --global           operate on the global managed dir instead of project .omk/managed
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
  --global          operate on the global managed dir instead of project .omk/managed
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
omk doctor --static-only                # offline mode: static checks only, no LLM call
```

<!-- omk:cli:doctor:flags:start -->

**Flags:**

```text
  --dimensions <value>  Custom dimensions config file (YAML), appended after builtin 7. Each is either promptSection (LLM audit) or endpoint (POST skill snapshot to your service). Note: endpoint sends the full SKILL.md + sub-files to that URL — only enable for trusted configs/URLs.
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

Custom dimensions via `--dimensions <yaml>`: each entry is either an **LLM dimension** (`promptSection` — folded into the health LLM call) or an **endpoint dimension** (`endpoint` — doctor POSTs the skill snapshot to your service and maps the response). The two are mutually exclusive per dimension. Endpoint dimensions are "online" checks (run by default, skipped under `--static-only`), letting you do deep checks that prompts can't express — e.g. calling an external security-audit service.

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
  --no-evidence                   Do not append this run as evidence to managed records (auto-written for installed skills by default).
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
- **📊 Score view** — the verdict-driven A/B comparison ([fact / behavior / judge layers](../specs/scoring), bootstrap CI, length-debias).
- **✅ Functional view** — each sample as a unit test: design (prompt / rubric / mocks / environment) + execution trace + assertion results + actionable diagnostic. Diagnostic emits root cause (skill_doc_unclear / llm_misread / sample_design / tripwire_intentional / ...), workflow checks (rubric step ✓/✗ with evidence), and failure-mode tags (工作流跳步 / 硬编码值 / 幻觉输出 / 工具误用 / 环境拦截 / 误读约束 / 其他). For the sandbox-mock semantics behind `mocks` / `environment` / `tripwire` / `mocksStrict`, see [sample-design-spec.md §三](../specs/sample-design-spec.md).

## `omk observe`

`omk observe` ships two workflows: `omk observe health` for skill-health reports, and the observe inbox (`ingest` / `inbox` / `show`) for human review. (Bare `omk observe <sessions>` is deprecated and no longer runs analysis — use `omk observe health`.)

### A. Skill-health report (`omk observe health`)

```bash
omk observe health ~/.claude/projects/-Users-you-Documents-my-project
omk observe health ~/.claude/projects/my-project --last 7d
omk observe health ~/.claude/projects/my-project --from 2026-04-01T00:00:00Z --to 2026-04-15T23:59:59Z
omk observe health ~/.claude/projects/my-project --skills audit,polish
omk observe health ~/.claude/projects/my-project --kb /path/to/project
```

<!-- omk:cli:observe:flags:start -->

**Flags:**

```text
  --from <value>        Start time ISO, overrides --last
  --kb <value>          KB root, enables KB-aware analysis
  --lang <value>        Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --last <value>        Time window (7d / 24h / 30m)
  --output-dir <value>  Health report output dir, default ~/.oh-my-knowledge/observe-health
  --skills <value>      Filter to specific skills, comma-separated
  --to <value>          End time ISO
```

For full descriptions: `omk observe --help`.

<!-- omk:cli:observe:flags:end -->

Turns real Claude Code session traces into skill-health reports: knowledge usage, [gap signals](../specs/knowledge-gap-signal-spec), execution stability, tokens, and latency. This is production observation, not production scoring.

### B. observe inbox: reviewer loop

Parses, aggregates, and de-noises real session traces into a per-observation list a human can review. The whole pipeline is local-only and LLM-free.

```bash
# 1. Parse traces, aggregate signals, write to .omk/observe-inbox/
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
  --edit-budget <value>           Max fraction of skill lines a round may change (default 0.2). Over-budget candidates are rejected before evaluation, saving eval cost
  --effort <value>                Reasoning effort: low/medium/high/xhigh/max
  --executor <value>              Executor name, default claude
  --holdout-ratio <value>         Holdout fraction for the accept decision (0..1, default 0=off). When > 0, candidates are accepted on holdout score and weak samples come only from train — guards against train-on-test
  --improve-mode <agent|rewrite>  Improvement strategy (default: agent)
  --improve-model <value>         LLM that rewrites the skill, default sonnet
  --judge-models <value>          Judge model (single judge required), executor:model format. Default claude:haiku
  --lang <value>                  Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --model <value>                 Evaluated LLM, default sonnet. Also used as the sample-generation model when no samples exist.
  --no-diagnostic                 Disable diagnostic LLM call
  --no-edit-budget                Disable the edit budget (allow arbitrarily large single-round edits)
  --no-reject-memory              Disable rejected-edit memory (do not feed rejected edits back into the next prompt)
  --no-significance-gate          Disable the significance accept gate, reverting to point-estimate accept (default: gate on — accept only statistically significant gains)
  --reuse-latest-eval             Reuse the latest comparable eval report as round-0
  --rounds <value>                Max iteration rounds, default 5
  --sample-fix-max-attempts <value>Max auto-fix attempts per sample (default: 2)
  --samples <value>               Samples file, default eval-samples.json
  --significance-alpha <value>    Significance level for the accept gate diff CI (default 0.05 = 95% CI)
  --skip-connectivity             Skip LLM connectivity preflight
  --skip-doctor                   Skip doctor gate (escape hatch; user takes garbage-in risk)
  --snapshot-only                 Produce candidates only, do not write back to source: the winner stays in evolve/<skillName>.r{N}.md for you to pick and then omk promote. By default a managed skill is written back and evidence is recorded (measurable).
  --stop-on-assertions-pass       Stop early when normal samples pass assertions
  --target <value>                Target composite score; stop when reached. If omitted, runs all rounds.
  --test-ratio <value>            Locked test fraction (0..1, default 0=off); requires --holdout-ratio. Never used for selection; read once at the end for an unbiased generalization score
  --timeout <value>               Per-sample timeout sec, default 600
```

For full descriptions: `omk evolve --help`.

<!-- omk:cli:evolve:flags:end -->

Auto-iterates a skill through repeated eval → judge → rewrite loops until it hits `--target` or exhausts `--rounds`. Cost scales with `rounds × samples × variants`; a typical run takes minutes to tens of minutes. Original skill files are versioned under `skills/evolve/*.r0.md`.

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
  --batch                     Batch mode: scan --skill-dir, generate samples for any skill missing them.
  --count <value>             Number of samples to generate. Defaults to LLM auto-selection by skill type.
  --executor <value>          Executor name, default claude (same as omk eval / doctor / evolve). When using another executor like codex, also pass a --model it recognizes.
  --fix                       Fix mode: auto-fix sample_design failures using the latest eval report.
  --focus <value>             Generation focus (NL hint). Steers LLM toward certain sample types.
  --from-traces               from-traces mode: recycle observe-inbox failure signals into draft regression samples (provenance: production-trace) for review.
  --lang <value>              Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --model <value>             Generation LLM model name, default sonnet.
  --no-mock                   Skip mock generation; all tool calls execute for real during eval.
  --observations-dir <value>  Observe inbox dir (from-traces mode), default project .omk/observe-inbox.
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
omk studio --observations-dir .omk/observe-inbox    # observe inbox data directory
omk studio --no-open
```

<!-- omk:cli:studio:flags:start -->

**Flags:**

```text
  --analyses-dir <value>      Observe-health reports dir (optional, default ~/.oh-my-knowledge/observe-health)
  --dev                       Dev mode: child process with hot reload
  --host <value>              Listen host, default localhost. Use 0.0.0.0 to expose to LAN
  --lang <value>              Output language zh|en. Priority: CLI > OMK_LANG env > zh.
  --no-open                   Do not auto-open browser
  --observations-dir <value>  Observe-inbox data dir (optional, default .omk/observe-inbox)
  --port <value>              Listen port, default 7799. Pass 0 for OS-assigned
  --reports-dir <value>       Reports dir, default ~/.oh-my-knowledge/reports
```

For full descriptions: `omk studio --help`.

<!-- omk:cli:studio:flags:end -->

Starts the local knowledge workbench for browsing reports and observation analyses. Verdict, sample diffs, regressions, saturation curves, and per-sample drill-downs all live in the studio UI — there is no CLI export / analysis subcommand. For CI gates, use `omk eval`'s exit code (0 on `PROGRESS`, non-zero otherwise) or `jq` over the report JSON.

Studio is skill-centric — the list page (`/`) shows skill cards with health band / 0-100 reference score / open-issue count / trend; the detail page (`/skills/<name>`) puts a prioritized issue checklist on the left (skill issues / sample issues / tool advisories), and a chart.js health trend plus three compact stage cards (doctor / eval / observe) on the right, with modals for deeper drill-down. The legacy run list moved to `/runs`. Visit `/observations/inbox` for the observe inbox dashboard: per-skill rollup view, reviewer action list, observability funnel, and a per-observation detail panel with the event triplet (surrounding messages).
