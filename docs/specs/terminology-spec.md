# omk terminology spec

> **Scope**: This is a naming-decisions archive for omk maintainers (why `artifact` instead of `evaluand`, why `--variants` was dropped from v0.16, the `qualityScore` → `judgeScore` migration path, etc.). It is not a getting-started doc — for everyday usage see the [README](../README.md). The source code is the canonical reference, since the key terms are all English anyway.

## 1. Goals

This spec unifies the user-facing copy, command examples, data structures, and code naming used across omk's ongoing iterations.

Three goals:

- Align with industry and open-source conventions, minimizing omk-private jargon.
- Separate the four layers — "thing being evaluated", "runtime environment", "experiment grouping", and "experiment role" — so they don't get conflated.
- Keep a single abstraction that extends to future carriers: skill, agent, workflow, agent team, and beyond.

## 2. Standard terms

### 1. Artifact

`artifact` is omk's standard term for "the thing being evaluated".

It is the object that gets compared, injected, run, or observed in an experiment. It can be:

- `baseline`
- `skill`
- `prompt`
- `agent`
- `workflow`
- a future `team` or other new kind of knowledge carrier

Rules:

- Prefer `artifact` in user-facing docs.
- Prefer `artifact` in core internal types, request structures, and task structures.

### 2. Artifact kind

`artifact kind` is the concrete category of an artifact.

Currently supported:

- `baseline`
- `skill`
- `prompt`
- `agent`
- `workflow`

Rules:

- `baseline` is the empty artifact — no explicit artifact is injected. For most users it just means "nothing at all".
- `skill`, `agent`, and `workflow` are subtypes of artifact, not the top-level umbrella term.
- When adding a new carrier, extend `artifact kind` rather than spinning up a parallel abstraction.

### 3. Variant

A `variant` is the expression of one comparison arm in an experiment, not the domain object itself.

For example:

- `baseline`
- `prd`
- `/path/to/SKILL.md` (the runtime context cwd is declared separately, not encoded into the expression)

Rules:

- Resolving a variant expression yields an artifact plus a runtime context.
- Every variant must be bound to an experiment role (control or treatment); see section 4.
- The CLI declares variants by experiment role (`--control` / `--treatment`); the flat `--variants` parameter is no longer used.

### 4. Experiment role

`experiment role` is the role a variant plays in a given experiment, using standard statistical terminology.

Enum:

- `control` — the control group, providing the baseline measurement.
- `treatment` — the treatment (experimental) group, compared against control to see what changes.

Rules:

- Role is a run-time property of a variant, not an intrinsic property of the artifact; the same artifact can play different roles across runs.
- The CLI declares it via two separate parameters, `--control <expr>` and `--treatment <v1,v2,...>`.
- Reports display control/treatment labels; the role is no longer inferred back from `artifactKind === 'baseline'`.
- `baseline` is an artifact-kind term, not an experiment-role term; see the boundaries in section 3.

### 5. Runtime context

`runtime context` is the run-time environment; the most central piece today is `cwd`.

It is the environment the model or agent runs in, as opposed to "the thing being evaluated" itself.

In project-style agent scenarios, the `runtime context` directly includes the environmental factors that affect behavior:

- the project directory
- `CLAUDE.md`
- local skills
- repo files
- the tool-visibility scope

Rules:

- `cwd` belongs to the runtime context and is declared separately (the CLI's `--control-cwd` / `--treatment-cwd`, or eval.yaml's structured `cwd:` field); it is not encoded into the variant expression.
- To express "empty artifact + a specific runtime context", use a self-describing label as the artifact and supply the cwd separately, e.g. `--treatment project-env --treatment-cwd /path/to/project`.
- Do not collapse the project directory, project-level runtime context, and explicit artifact injection into a single concept.

### 6. Sample

A `sample` is one **test-case** record in the evaluation.

Rules:

- **Code / API / file names / CLI flags keep `sample`**: the `Sample` type, the `sample_id` field, the `eval-samples.json` file name, the `--samples` flag — these are common terms across the open-source API and the English-speaking LLM-eval world, and stay as-is.
- **User-facing Chinese copy defaults to「用例」, not「样本」**: CLI output, report UI, error messages, doc prose, and the Chinese part of commit messages. This includes compounds like「用例数」/「用例难度」/「用例不足」/「跨用例散度」.
- **Rationale**: omk's `eval-samples` are test cases **hand-picked** by developers, not statistical samples **randomly drawn** from some distribution.「样本」implies "just run more and the sample size grows", which misleads users — what they actually need is more design, more cases.「用例」matches the engineering framing (test case) and the user's mental model when writing an evaluation ("I designed 5 cases").
- **Exception: keep「样本」for statistical-terminology contexts** — Cohen's d / Hedges' g "**small-sample correction**", "**sample mean**", "**sample variance**", "**sample size**", bootstrap "**resampling**", etc. These are fixed phrasings in statistics (small-sample correction / sample mean / sample variance / sample size / resampling); forcing them into「用例」would just make a stats-literate reader pause. Decision rule: does the word denote "one random draw from a population" (the statistical concept — then it's 样本), or "one hand-picked test case from a developer" (then it's 用例)? The two don't mix, and context makes it clear.

#### 6.1 Sample metadata fields

The Sample schema has optional metadata fields, purely for documentation / diagnostics; they **do not participate in grading / judge / verdict**. See [docs/specs/sample-design-spec.md](sample-design-spec.md).

- **`capability?: string[]`** — the capability dimension(s) this sample tests (can be multiple). Normalized case-insensitively, with dash / camelCase / underscore insensitivity.
- **`difficulty?: 'easy' | 'medium' | 'hard'`** — difficulty bucket (strict enum).
- **`construct?: string`** — the construct type this sample tests. Suggested: `'necessity'` (tests necessity, baseline-vs-skill) / `'quality'` (tests whether the skill is well-written) / `'capability'` (tests a specific capability). Free-form string allows custom values.
- **`provenance?: 'human' | 'llm-generated' | 'production-trace'`** — data source.
- **`covers?: { targetKind: string; ref: string }[]`** — optional declared skill-structure anchors this sample is intended to exercise, used by Skill Map to show declared / undeclared definition nodes.

**construct vs. capability** (the two fields users most often confuse):
- **construct** = **what class of thing** this sample tests (necessity / quality / capability). It's the experiment-design level — running baseline-vs-skill tests necessity, running skill-v1-vs-skill-v2 tests quality.
- **capability** = **which specific capabilities** this sample tests (api-selection / error-diagnosis / fallback). It's the capability dimension of the object under test.

### 7. Task

A `task` is one concrete execution unit:

> one sample × one artifact × one runtime context

Rules:

- The task layer does not directly represent an experiment conclusion.
- A task is the smallest unit of execution and scoring.

### 8. Trace

A `trace` is the process data produced during one execution, including:

- turns
- tool calls
- timing
- execution metrics like token / cost / cache

Rules:

- A trace belongs to the run result.
- A trace is used to explain differences in agent behavior, not to name the thing being evaluated.

## 3. Term boundaries

### 1. baseline means "nothing at all"

The standard meaning of `baseline` is:

- no explicit artifact injection
- no extra project-level runtime context attached

For most users, `baseline` can be read directly as "nothing at all".

If you want to isolate project-level runtime context, write it explicitly:

- use the self-describing label `project-env` as the artifact, and `--treatment-cwd /path/to/project` for the cwd (or eval.yaml's `cwd:` field)

Here `project-env` is just an experiment-grouping label; the real meaning is "empty artifact + a specific runtime context".

### 2. skill is not the umbrella term

`skill` is used only when the object really is a skill file, a skill directory, or a skill-style system prompt.

Do not use `skill` as the umbrella term in these cases:

- comparing several objects of different kinds
- describing the generic CLI variant syntax
- describing future objects like agent teams, workflows, etc.

### 3. agent is not the umbrella term

`agent` describes an artifact or run form with agent-style runtime characteristics, e.g.:

- has tool calls
- has multi-turn traces
- depends on the runtime environment

But `agent` should not replace `artifact` as the generic term.

### 4. baseline kind and control role are not the same thing

`baseline` is one member of the `ArtifactKind` enum, denoting "empty artifact" (no explicit artifact injected).
`control` is a value of `experimentRole`, denoting "this variant plays the control role in this experiment".

The two are orthogonal:

- A `baseline`-kind artifact usually plays the `control` role, but that's not the definition.
- When comparing two `skill`-kind artifacts (v1 vs v2), one is explicitly declared `control` — here the control role has nothing to do with baseline kind.
- Both reports and code should treat `experimentRole` as the single source of truth for identifying the control group, never inferring it back from `artifactKind === 'baseline'`.

### 5. In omk, CI only ever means Confidence Interval

**In omk, CI always means Confidence Interval**, never Continuous Integration. This rule avoids confusion with the non-statistical "CI".

Rules:

- **Continuous-integration internal helpers always use "gate"**: the `omk eval` gate path / `evaluateLayerGates` / `gateThreshold` / `LayerGateResult`.
- **Confidence-interval contexts always use "CI"**: `bootstrap CI` / `diff CI` / the `bootstrapCI` field / "95% CI".
- Docs / comments / commit messages mentioning "CI" need no clarification — there is a single meaning, so the reader doesn't need context to disambiguate.

### 6. Stability = across repeated runs (test-retest), not cross-sample spread

**The concept of stability aligns with psychometrics' test-retest reliability — score consistency of the same object across repeated runs. omk uses CV (coefficient of variation, an engineering measure of relative dispersion) as the primary metric; it is not fully equivalent to test-retest reliability in the strict psychometric sense (typically ICC or Pearson r), and is not a psychometric reliability measurement but an engineering approximation of the same family of concepts.**

omk's concrete implementation: `--repeat N` runs the same (variant × sample) N times, and `report.variance.perVariant[v]` stores the score series across runs. The primary stability metric is **CV = σ / mean** (coefficient of variation, a dimensionless relative dispersion), with σ + 95% CI as secondary metrics. The thresholds `<5% / 5~15% / >15%` are empirical values on the 1-5 score scale, not figures cited from the literature.

**What is not stability**:

- **The cross-sample min~max score range** is not stability. The score spread of one variant across multiple samples comes mostly from **the samples themselves differing in difficulty** (eval-samples usually deliberately cover varied tasks), not from intrinsic variant fluctuation. Calling that range "stability" is a misreading — a reader who sees "100%" would wrongly assume the variant is very stable, when in fact the sample set may just be too narrow.
- **Success rate** is not stability. Success rate reflects "did the task complete" (execution health); "how much the score jitters across repeats" (measurement stability) is an independent concept. When success rate < 100%, it surfaces as a secondary-area alert, not as the primary stability metric.

**UI conventions**:

- In the six-dim comparison table, the "stability" column primary value: when variance data exists, show `CV X.X%`; when it doesn't (single-run evaluation / no `--repeat`), show `—` plus a secondary-area `需 --repeat ≥ 2`. **Honestly state what cannot be measured.**
- Industry alignment: Anthropic / OpenAI eval docs, Braintrust, Langfuse, etc. all treat variance across repeated runs as the core stability metric, not cross-sample spread.

### 7. Three scoring layers: fact / behavior / LLM judge

`LayeredScores` splits the composite into three orthogonal layers, with fields `factScore` / `behaviorScore` / `judgeScore` in order, displayed in the UI as **"事实" / "行为" / "LLM 评价"** respectively.

| Layer | Field | Source | Nature |
|---|---|---|---|
| Fact | `factScore` | pass rate of fact assertions (`contains` / `json_schema` / `fact_check`, etc.) | rule-verifiable · objective |
| Behavior | `behaviorScore` | pass rate of behavior assertions (`tools_called` / `tool_output_contains` / `turns_max`, etc.) | rule-verifiable · objective |
| LLM judge | `judgeScore` | the LLM judge's subjective rubric-based score (= `results.llmScore`) | model judge · subjective |

**Why "LLM judge" isn't called "quality"**:

- The `composite` score = arithmetic mean of the three layers; external messaging uses the base four-dimension framework (quality / cost / efficiency / accuracy), where **"quality" refers to the composite-score dimension**.
- If `judgeScore` were also called the "quality layer", a single report would carry both a header "quality 3.85" and a detail "quality layer: 4" — two numbers with completely different meanings, and the reader couldn't tell them apart.
- "LLM judge" makes the source (the LLM judge) explicit and contrasts semantically with the rule-verification of "fact / behavior", so the three layers sit side by side without ambiguity.
- `judge` as a field name aligns with the existing terms `judgeExecutor` / `judgeModel`.

**Code conventions**:

- In user-facing docs, UI labels, and changelogs, refer to this layer as "LLM 评价" (Chinese) / "LLM judge" (English).
- Code fields, types, and enum values uniformly use `judge` / `judgeScore` / `avgJudgeScore`.
- Do not reintroduce `qualityScore` / `avgQualityScore` in new code (legacy v0.15 naming, removed in v0.16).

## 4. External expression conventions

### 1. Docs

User-facing docs use the following priority:

- top-level umbrella: `artifact`
- experiment grouping: `variant`
- experiment role: `control` / `treatment`
- runtime environment: `runtime context`
- concrete object type: `skill` / `agent` / `workflow`

### 2. Command examples

In command examples:

- Use `--control <expr>` + `--treatment <v1,v2,...>` to declare variants by experiment role.
- The variant expression resolves to an artifact and a runtime context.
- Prefer concrete paths or concrete names in example objects; don't use a generic placeholder to stand in for every scenario.
- For complex experiment configs, prefer `--config eval.yaml`; CLI parameters only carry the simple cases.

### 3. Reports and acceptance

Reports and acceptance docs should answer, in priority order:

- What artifacts is this comparing?
- What runtime context do they run in?
- Who is control, who is treatment?
- Does the difference come from the artifact itself, or from the runtime context?

## 5. Internal implementation conventions

### 1. Types and fields

New code prefers:

- `Artifact`
- `ArtifactKind`
- `artifacts`
- `task.artifact`
- `artifactHashes`
- `VariantConfig.experimentRole` (added field, enum `'control' | 'treatment'`)

### 2. De-compatibility strategy

omk is still in its 0-1 phase with a very small user base, so it does not proactively keep historical compatibility layers.

Rules:

- New implementations converge directly on the artifact terminology.
- If old naming would cause long-term ambiguity, delete it outright rather than keeping a compatibility alias.
- Make breaking adjustments now rather than snowballing backward-compatibility.
- From v0.16, `--variants` was removed outright (no deprecation warning); users migrate to `--control` / `--treatment`.

### 3. Naming principles

- Generic abstraction: `artifact`
- Concrete subtypes: `skill` / `agent` / `workflow`
- Experiment orchestration: `variant`
- Experiment role: `control` / `treatment` (not `baseline` / `experiment`)
- Runtime environment: `runtime context` / `cwd`

### 4. Reserve bare `kind` for `ArtifactKind`

In omk's product vocabulary, bare `kind` defaults to `Artifact.kind` (`ArtifactKind`: `baseline` / `skill` / `prompt` / `agent` / `workflow`). `baseline` means the empty eval artifact; experiment role still comes from `control` / `treatment`. CLI design follows the same rule: the `--kind` flag on `omk install` means artifact kind (aligned with `Artifact.kind`), not install target, report type, or observe event type.

For other discriminants, use a qualified name when the field is new or safe to rename. Existing published `kind` fields that are already persisted or externally consumed stay as-is unless a dedicated migration changes them:

- `report.kind` stays the canonical public report-schema field
- `doctor.kind` stays the canonical doctor-report field
- `observe-*.kind` stays the canonical observe-report field
- `event.kind` → `eventKind`
- `executorRuntime.kind` → `runtimeKind`
- `standard.kind` → `standardKind`

Two caveats:

- **The persisted report / observe / doctor / diagnosis top-level discriminant is `kind`, cut over from its earlier qualified field name in a deliberate BREAKING-SCHEMA change.** The cutover is hard — no dual-read, no migration shim: files written by older versions (an old qualified top-level discriminant, no `kind`) are simply not read and are skipped. This is serialization back-compat, not statistical comparability — the field name changes no measurement number. (`report.kind` additionally sits in the Report-schema invariant list, so treat further changes there with the usual schema care.)
- Renaming internal non-persisted fields is progressive — done opportunistically when touching that code, not as a big-bang sweep. A CI guard freezes the current set of bare-`kind` declaration sites so new unqualified ones cannot slip in.

## 6. Term mapping

| Old term | New standard term | Note |
|---|---|---|
| evaluand | artifact | unified umbrella for the thing being evaluated |
| EvaluandSpec | Artifact | core object type |
| EvaluandKind | ArtifactKind | object category |
| evaluands | artifacts | object list in the request |
| task.evaluand | task.artifact | the object a single task binds to |
| evaluandHashes | artifactHashes | whole distributable-tree content hash of the artifact (report `schemaVersion >= 2`; same space as the install managed-record `contentHash`) |
| skillHashes | artifactHashes | unified object hash in the report |
| skill as the umbrella | artifact | skill falls back to a concrete subtype |
| agent as the umbrella | artifact / agent runtime | choose by semantics |
| `--variants` CLI parameter | `--control` / `--treatment` | declare variants by experiment role; the flat list is gone |
| inferring the control group from `artifactKind === 'baseline'` | read `experimentRole === 'control'` explicitly | the control group is user-declared, not inferred from artifact kind |
| `LayeredScores.qualityScore` | `LayeredScores.judgeScore` | displayed as "LLM 评价" / "LLM judge"; avoids clashing with the "quality" header (composite) |
| `VariantSummary.avgQualityScore` | `VariantSummary.avgJudgeScore` | same as above |
| `VarianceLayerKey: 'quality'` | `VarianceLayerKey: 'judge'` | same as above |

## 7. Skill isolation (added in v0.22)

### 1. Problem background

When omk runs baseline-vs-skill evaluations, the baseline variant by default reaches every skill under `~/.claude/skills/` through **three channels**, so the baseline is not actually a "bare model" — a **construct invalidity**:

1. **SDK skill auto-discovery**: the Claude Agent SDK scans `~/.claude/skills/` by default and injects the skill list into the main session's system prompt.
2. **subagent Skill tool**: even if the main session has no skills, the SDK's built-in task subagent can still load skill content on demand by calling `Skill(...)`.
3. **cwd file-system access**: the baseline's default cwd is the user's evaluation working directory, which usually has a `skills/<name>/` symlink prepared for the treatment; the baseline can follow that symlink with plain `Glob` / `Read` tools and read `SKILL.md` directly.

Only once all three channels are blocked is the baseline truly "bare". If any one is left open, the baseline routes around the others to reach skill content, and the verdict / Δ reflects a contaminated baseline vs. treatment rather than the real "no knowledge vs. knowledge".

### 2. Terminology

- **`allowedSkills`** (per-variant field, added to `Artifact` / `VariantConfig` / `EvalConfigVariant`):
  - `undefined` → default SDK behavior (full discovery of `~/.claude/skills/`)
  - `[]` → **full isolation**: `options.skills = []` + `options.disallowedTools = ['Skill']`; the main session discovers no skills, and the subagent can't call the Skill tool either
  - `[name1, ...]` (non-empty) → **rejected**: a skill whitelist can't be fully isolated (the subagent Skill tool and cwd filesystem channels leak), so a non-empty `allowedSkills` is no longer supported — use `[]` for full isolation or omit for no isolation. All three executors throw.
- **`--strict-baseline` flag** (default true): automatically sets `allowedSkills = []` for every `kind === 'baseline'` artifact; `--no-strict-baseline` turns it off (explicit opt-out).
- **`meta.skillIsolation`** (new report-meta field): a variantName → allowedSkills snapshot, used to validate comparability when comparing verdict / Δ across reports.

### 3. Defaults and priority

```
eval.yaml variant.allowedSkills (explicit)
  > CLI --strict-baseline / --no-strict-baseline (batch)
  > default (strictBaseline = true)
```

baseline-kind defaults to `[]` (strict); other kinds default to `undefined` (full SDK discovery).

### 4. Isolation coverage

| Channel | Covered? | Mechanism |
|---|---|---|
| Main session skills | ✅ | `options.skills = []` |
| SDK built-in task subagent calling the Skill tool | ✅ (when allowedSkills=[]) | `options.disallowedTools = ['Skill']` |
| **cwd file system (baseline → cwd → skills/ symlink → SKILL.md)** | ✅ (strict + user gave no explicit cwd) | baseline cwd switched to the empty dir `~/.oh-my-knowledge/state/isolated-cwd/` |
| MCP servers | ✅ (blocked by default) | SDK `settingSources` defaults to `[]`, omk passes no `mcpServers` |
| `AgentDefinition.skills` whitelist fine-grained control | ❌ (known hole, not in v1) | follow-up: omk adds an `agents` option |
| script executor | ❌ | stderr warn; user-custom, doesn't participate in isolation |

**Why the cwd channel is listed separately**: after blocking only the two SDK channels (`skills:[]` + `disallowedTools:['Skill']`), the baseline's `Skill` tool calls do drop to 0, but the baseline can still use plain `Glob` / `Read` to follow the `skills/<name>/` symlink under cwd and read `SKILL.md`, completely bypassing the SDK isolation. Root cause: omk defaults to `baseline.cwd === null` → the SDK falls back to `process.cwd()` = the user's evaluation working directory, which usually has a `skills/<name>/` symlink prepared for the treatment. The fix is to switch the baseline's default cwd to `~/.oh-my-knowledge/state/isolated-cwd/` (an empty dir). **When the user explicitly sets a cwd for the baseline, this is left untouched** (explicit cwd = the user is responsible for keeping that dir clean).

Note: isolated-cwd is not a sandbox — the baseline can still Read any absolute path. But the model won't proactively guess the user's private paths (no system-prompt hint). If the evaluation scenario prompts the baseline to read an absolute path, an additional sandbox layer is needed (out of scope).

### 5. Cache key version

The cache key currently carries a `v4:` prefix, with allowedSkills, the executor name, and the executor runtime fingerprint folded into the key — switching strict / non-strict, crossing executors, or a binary / SDK version change will not falsely hit stale output.

### 6. Executor compatibility

| Executor | undefined | `[]` | `[name]` |
|---|---|---|---|
| `claude-sdk` | full discovery (default) | skills:[] + disallowedTools:[Skill] | **throw** |
| `claude-cli` | default | `--disable-slash-commands --disallowedTools Skill` | **throw** |
| `script` | default | stderr warn, non-blocking (no effect) | stderr warn, non-blocking (no effect) |

A non-empty skill whitelist `[name]` is **no longer supported by any executor**: it could never be fully isolated (the subagent Skill tool and cwd filesystem channels leak), so all executors throw on a non-empty `allowedSkills`. Use `[]` for full isolation or omit for none. The `script` executor is user-custom and can't be guaranteed to honor isolation, so it only warns.

## 8. Decision criteria

When adding features, docs, or interfaces later and facing a naming choice, decide in this order:

1. Is it describing the thing being evaluated? If so, use `artifact`.
2. Is it describing the experiment grouping? If so, use `variant`.
3. Is it describing the experiment role? If so, use `control` / `treatment`.
4. Is it describing the run directory or environment? If so, use `runtime context`.
5. Is it describing a concrete object type? If so, use `skill` / `agent` / `workflow`.
6. If a single word mixes object, environment, or role semantics, split it apart and rewrite.
