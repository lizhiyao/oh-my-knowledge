# omk terminology spec

> **Scope**: This is a naming-decisions archive for omk maintainers (why `artifact` instead of `evaluand`, why `--variants` was dropped from v0.16, the `qualityScore` → `judgeScore` migration path, etc.). It is not a getting-started doc — for everyday usage see the [README](../../README.md). The source code is the canonical reference, since the key terms are all English anyway.

## 1. Goals

This spec unifies the user-facing copy, command examples, data structures, and code naming used across omk's ongoing iterations.

Three goals:

- Align with industry and open-source conventions, minimizing omk-private jargon.
- Separate the four layers — "thing being evaluated", "runtime environment", "experiment grouping", and "experiment role" — so they don't get conflated.
- Keep a single abstraction that extends to future carriers: skill, agent, workflow, agent team, and beyond.

## 2. Standard terms

This section specifies preferred names rather than redefining concepts or API fields. See [knowledge principles](../../explanation/knowledge.md) and the [glossary](../../reference/shared/glossary.md).

| Identifier | Expression |
|---|---|
| `evaluation` | evaluation |
| `artifact` | knowledge carrier |
| `variant` | comparison arm |
| `control` | control role |
| `treatment` | treatment role |
| `runtime context` | runtime context |
| `dataset` | dataset |
| `sample` | test case |
| `executor` | executor |
| `evaluator` | evaluator |
| `metric` | named metric |
| `judge` | LLM judge |
| `rubric` | rubric |
| `experiment` | experiment design |
| `policy` | measurement policy |
| `run` | one run |
| `comparison` | comparison declaration |
| `verdict` | decision label |
| `evidence` | evidence |
| `report` | report view |

`executionContext` constrains execution, `evaluationContext` supplies evaluator-only material, and `annotations` retains author declarations. Sample format and Core API own complete shapes. Chinese user copy prefers 用例; established statistical phrases such as sample mean and sample variance retain 样本.

<a id="_1-artifact"></a>
<a id="_2-artifact-kind"></a>
<a id="_3-variant"></a>
<a id="_4-experiment-role"></a>
<a id="_5-runtime-context"></a>
<a id="_6-sample"></a>
<a id="_6-1-sample-metadata-fields"></a>
<a id="_7-task"></a>
<a id="_8-trace"></a>
<a id="_9-evaluation-runtime-vocabulary"></a>
<a id="_10-knowledge"></a>

## 3. Term boundaries

### 1. baseline means an empty artifact

The standard meaning of `baseline` is:

- no explicit artifact injection
- no implied experiment role or runtime context

`baseline` describes only the artifact. A host may bind an explicit runtime context to an empty artifact; control or treatment still comes from the variant's experiment role. The CLI keeps its reserved `baseline` expression stricter and refuses a cwd binding so the shorthand remains an unambiguous empty-artifact／empty-context reference.

If you want to isolate project-level runtime context, write it explicitly:

- use the self-describing variant label `project-env`, and `--treatment-cwd /path/to/project` for the cwd (or eval.yaml's `cwd:` field)

Here `project-env` is an experiment-grouping label; the real meaning is "empty artifact + a specific runtime context".

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

### 5. Distinguish confidence intervals and continuous integration {#_5-in-omk-ci-only-ever-means-confidence-interval}

In measurement results, CI means Confidence Interval. Repository workflows also use continuous-integration CI. Distinguish by context instead of reading repository checks as statistical intervals.

Rules:

- **Continuous-integration internal helpers always use "gate"**: the `omk eval` gate path / `evaluateLayerGates` / `gateThreshold` / `LayerGateResult`.
- **Confidence-interval contexts always use "CI"**: `Bootstrap CI` / `comparison CI` / `interval` Analysis result / "95% CI".
- Mixed contexts should spell out confidence interval or continuous integration/repository gates; do not incidentally rename public fields or Actions names.

### 6. Stability = across independent Runs, not cross-sample spread

Stability is a test-retest concept: the same sealed measurement design is executed as independent Runs in an Evaluation Series. The current Series Analysis reports the unbiased sample variance of run-mean composite values. A single Run contains no cross-run stability evidence, and a Run Decision must never infer it.

Cross-sample score range and success rate are not stability. Samples intentionally vary in difficulty, while success rate is an operational-health fact. Both remain separate from Series variance.

### 7. Three composite layers: fact / behavior / judge

Core Composite Analysis binds up to three named layers: `fact`, `behavior`, and `judge`.

| Layer | Source | Nature |
|---|---|---|
| Fact | explicitly classified Boolean criterion observations | rule-verifiable |
| Behavior | explicitly classified execution-compliance criterion observations | rule-verifiable |
| Judge | an ensemble consensus or dimension aggregate | model-evaluated |

The terms name Analysis responsibilities, not mutable report fields. New code uses qualified table entries and source bindings; it must not reintroduce deleted `LayeredScores`, `factScore`, `behaviorScore`, `judgeScore`, or `avg*Score` report-row fields. User-facing English uses "LLM judge" when referring to the evaluator source and "judge layer" when referring to Composite Analysis.

### 8. A conversation is what the user reads; a session is what the host wrote

Interface wording follows what each reference denotes; **the number of terms on one screen is not restricted**:

- **conversation**: the work record the user reads, filters and extracts from inside Studio. Lists, list counters, navigation, empty states, buttons and page titles all live on this layer.
- **session**: the raw record the host itself wrote — log files, trace sources, `--session` style parameters, source identities and fields inside snapshot metadata. Prefer the qualified **source session** when naming it, so it cannot be confused with the reading unit.

The rule is **one referent, one name**. Both of these co-presences are legitimate: a conversation view that labels its origin "来源会话：…" (which is what the candidate page renders today); and the "来源会话数" column in the health report, whose value is the source-side `sessions.length` aggregated in `report-assembly.ts` and was never a count of conversation rows.

Rejected usage is one referent named two ways — a page title that reads "All conversations" while the very same list counts "N sessions". Where English has only `conversation` but Chinese distinguishes the layers, the Chinese follows what is actually meant; never rewrite a source field into "conversation" just to match the English surface. The precedent already exists in `evaluation-studio-projection.md`: the four Observe lanes read "conversation, execution, outcome, knowledge", while "reuse the session and trajectory projection … never serialize the whole source session" speaks of sessions.

### 9. Two object layers: knowledge content and knowledge carrier; a candidate is a state

The `/knowledge` side has exactly two object layers:

| Object layer | Chinese interface term | English interface term | What it denotes |
|---|---|---|---|
| Content | 知识内容 (the domain model also calls this layer **知识条目**) | knowledge item | one reviewable fact, experience or method: stable identity plus immutable revisions |
| Carrier | **知识载体** | `Knowledge artifact` | one skill, prompt or project rule file |

**「候选知识」 ("candidate knowledge") is not a third object layer; it is a state of a knowledge item.** The authority is `knowledge-domain-model.md` §2: the knowledge-item layer already carries a stable identity and immutable revisions, while "Unknown or conflicting claims may remain candidates" and the rule that background-only inference may become a pending-review candidate both speak of a claim's **review state**. That document never creates a separate object for candidates.

The two senses of "candidate" refer to content and carriers respectively: on the content layer, candidate knowledge is a knowledge item awaiting review; on the carrier-change layer, a candidate version is a carrier version proposed for adoption and can exist before it enters an evaluation. In an evaluation, a `variant` expresses a comparison-arm configuration that resolves to an artifact and runtime context (section 2.3); `control` / `treatment` expresses that arm's role in that experiment (section 2.4). Carrier version identity, comparison-arm configuration and experiment role are expressed separately; the same version can be referenced by multiple arms in different runtime contexts or experiments.

One more constraint must be inherited rather than mis-quoted: the sentence in `knowledge-domain-model.md` §4.2 about proposal, review, candidate creation, evaluation links and adoption or rejection has **changes** as its subject — the layer that applies revisions to carriers — and the same sentence continues that evaluation, application and publication are recorded separately and must not be collapsed into one linear status shared by every scenario. Do not restate it as a single linear review order for knowledge items.

Interfaces may therefore say 候选知识, but it must read as "this knowledge item has not been reviewed yet": it must not be presented alongside the content layer as a different kind of object, and a terminology gate must not treat candidate and content as mutually exclusive categories. For the same reason this side of the interface is not a closed vocabulary — revisions, supporting evidence and knowledge gaps remain valid concepts wherever their own definitions apply.

Two consistency checks; any rename or gate must pass both: a candidate that survives review is still the same knowledge item (identity retained, only the state changes), and one carrier can hold several items in different states at the same time.

This follows sections 2.1 and 2.10 of this document: knowledge content and knowledge carrier are two layers, one carrier can hold many pieces of knowledge and one piece can appear in several carriers; these forms do not extend `ArtifactKind` and do not replace existing artifact identity.

**「知识对象」 ("knowledge object") is rejected because it cannot tell the two layers apart** — the same phrase can mean one knowledge item or one skill, and separating them is exactly what this section exists for. Corroborating evidence: before this change it appeared zero times across all specs and guides and lived only in interface copy, so naming it here records the rejection rather than licensing the word. Decide by the data, not by habit: a row in the `/knowledge` list is one skill (its key is the skill name), i.e. the carrier layer, so that column plus the counters, search placeholder and tab title read 知识载体 / `Knowledge artifact`; only a count of items uses 知识内容. Renaming the shipped interface is the implementation change's job — this document settles the vocabulary first.

**In Chinese interfaces `skill` keeps its Latin spelling `Skill`／`skill` and is not rendered as 「技能」.** Here it is a product identity word, not a common noun: one skill is the key of a `/knowledge/skills/[skillName]` row, in the same family as `ArtifactKind`, `AGENTS.md` and `.agents/skills/`. Before this change exactly one Chinese interface string read 「技能」 — a column header on the health page — while every other one used the Latin form (`Skill 健康度日报`, `Skill 趋势`, `各 skill 健康度`), and 「技能」 appeared zero times across the specs and guides. One referent with two spellings is the "one thing, two names" case this section defines, and the spelling with existing coverage wins. `test/studio/web/terminology-guard.test.ts` therefore rejects 「技能」 in Chinese interface copy; comments inside the collection core and the Chinese keyword lists that match skill mentions in user text are out of scope, since they are not interface copy.

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

### 5. Retire `admission`: one scene, one qualified name

`admission` used to carry at least five unrelated meanings in this repo (provider-cost budget reservation, Core's plan-bound capability API, in-memory stage reuse, knowledge draft validation, persisted resume trust). The term is retired scene by scene; each scene keeps exactly one qualified name.

| Scene | Standard name | Note |
|---|---|---|
| In-memory stage reuse against a freshly sealed Plan | plan-bound conformance verification (`verifyExecutedStageAgainstPlan`) | fail-closed verification, not an eligibility check |
| Knowledge draft / evidence / grounding validation | knowledge validation (`src/knowledge/validation.ts`, `KnowledgeValidationProblem`) | pure validator, no governance meaning |
| Persisted resume trust decision | resume disposition (`src/eval-workflows/resume-disposition/`, `CoreResumeDisposition*`) | `disposition` was already the module's own word |
| Provider-cost budget reservation | unchanged for now | the field `policy.budget.providerCostAdmission.admissionMode` is published and persisted; renaming it would make stored plans unreadable, so it waits for a schema version bump (target name `providerCostOvershoot.mode`) |

Two identities are deliberately frozen and keep the old word:

- the digest derivation tag `omk.core-resume-admission/v1` — a versioned identity string, not vocabulary; changing it would silently change every resume disposition digest;
- enum values such as `'admitted'` / `'rejected'` — values stay stable so the rename cannot alter a measurement or a persisted decision.

Core's published `admit*` capability API (`admitExecutionBundle` and siblings) and the Series member field `admissionStatus` are two further senses. Both are external surface, so they are renamed only after an explicit vocabulary decision, not as part of an internal sweep.

### 6. Bilingual completeness of user-facing copy

Every user-facing string must exist in both languages. Two mechanisms already satisfy this and stay in use: the CLI runtime dictionary (`tCli()` plus `src/cli/lib/i18n-dict/`, whose zh/en key parity is asserted by `test/cli-i18n.test.ts`) and oclif's `bilingual({ zh, en })` for static help. Studio keeps its copy inline as `lang === 'zh' ? … : …`; that is a deliberate choice, not debt to be paid down with a framework.

Do not introduce i18next / vue-i18n and do not sweep inline Studio copy into a central dictionary. The gap this rule closes is missed translation, and a dictionary does not detect it — a key added on one side only is exactly as easy to forget as a branch. What carries the rule instead:

- `test/studio/web/bilingual-copy.test.ts` fails when the English branch of a language conditional still carries Chinese. It deliberately checks only that direction: measured over the current tree, the opposite test (the Chinese branch must contain Chinese) fires on separators, language codes, brand plurals and file names, which would only produce an exemption list.
- Where copy is shared across components, use the stronger existing construct — `Record<Lang, Record<Key, string>>` with an accessor (`src/observability/inbox/metric-semantics.ts`, `src/studio/application/knowledge/candidate-status.ts`), or `const enCopy: typeof zhCopy` (`src/studio/web/components/observe/health.tsx`). A missing key there is a compile error, which beats any runtime lookup.
- Copy that belongs to one component stays in that component.
- On a read path, separate what OMK authored from what was recorded. Studio's knowledge findings render OMK's own rule text in the request language, while evidence persisted earlier — a doctor rule's own message, a Diagnosis title, summary or recommendation — is shown in the language it was recorded in. Re-translating stored evidence at render time would rewrite the record behind the view.
- Where that language is chosen per request, it also belongs in the cache identity: a cached projection holding display text must not serve the first requester's language to everyone else.

## 6. Term mapping

| Old term | New standard term | Note |
|---|---|---|
| admission (stage reuse) | plan-bound conformance verification | `verifyExecutedStageAgainstPlan`; fail-closed, not eligibility |
| admission (knowledge drafts) | knowledge validation | `src/knowledge/validation.ts`, `KnowledgeValidationProblem` |
| resume-admission | resume-disposition | persisted resume trust decision; digest tag stays frozen |
| evaluand | artifact | unified umbrella for the thing being evaluated |
| EvaluandSpec | Artifact | core object type |
| EvaluandKind | ArtifactKind | object category |
| evaluands | artifacts | object list in the request |
| task.evaluand | task.artifact | the object a single task binds to |
| evaluandHashes | Target artifact descriptor | full SHA-256 content identity sealed in Target config |
| skillHashes | Target artifact descriptor | unified artifact identity in Core lineage |
| skill as the umbrella | artifact | skill falls back to a concrete subtype |
| agent as the umbrella | artifact / agent runtime | choose by semantics |
| `--variants` CLI parameter | `--control` / `--treatment` | declare variants by experiment role; the flat list is gone |
| inferring the control group from `artifactKind === 'baseline'` | read `experimentRole === 'control'` explicitly | the control group is user-declared, not inferred from artifact kind |
| `LayeredScores.qualityScore` | Composite `judge` layer entry | the deleted result-row field is replaced by an explicitly bound Analysis source |
| `VariantSummary.avgQualityScore` | Studio projection from Composite Analysis | display data is rebuilt from authenticated Core artifacts |
| `VarianceLayerKey: 'quality'` | Evaluation Series run-mean composite variance | Series does not reuse a legacy layer key |

## 7. Skill isolation (added in v0.22)

### 1. Problem background

When omk runs baseline-vs-skill evaluations through a native coding-agent runtime, the baseline may discover local knowledge that was never declared as measured input. That makes the baseline something other than a "bare model" — a **construct invalidity**.

Claude runtimes expose three relevant channels: SDK / CLI skill discovery, the subagent `Skill` tool, and ordinary cwd file access. Codex discovers `AGENTS.md`, `.agents/skills/`, project rules, and related context from its workspace and local profile. Both families can also read a `skills/<name>/` path under cwd with ordinary tools.

The strict baseline therefore combines a clean per-attempt cwd with executor-specific controls. If any discovery channel remains open, verdict / Δ reflects a contaminated baseline vs. treatment rather than the intended "no knowledge vs. knowledge".

### 2. Terminology

- **`allowedSkills`** (per-variant field, added to `Artifact` / `VariantConfig` / `EvalConfigVariant`):
  - `undefined` → executor-default runtime discovery; no isolation is requested
  - `[]` → **strict isolation requested**: omk supplies an empty per-attempt cwd and applies every isolation control supported by the selected executor
  - `[name1, ...]` (non-empty) → **rejected at the shared execution-plan boundary**: a portable whitelist cannot be enforced across native agent, API, and custom executors; use `[]` for strict isolation or omit for none
- **`--strict-baseline` flag** (default true): automatically sets `allowedSkills = []` for every `kind === 'baseline'` artifact; `--no-strict-baseline` turns it off (explicit opt-out).
- **Isolation identity**: input compilation seals isolation declarations into execution controls; Runtime identity and execution coordinates govern reuse verification. Current reports have no `meta.skillIsolation` field; see [input compilation](../evaluation/cli-evaluation-input-compilation.md).

### 3. Defaults and priority

```
eval.yaml variant.allowedSkills (explicit)
  > CLI --strict-baseline / --no-strict-baseline (batch)
  > default (strictBaseline = true)
```

baseline-kind defaults to `[]` (strict); other kinds default to `undefined` (executor-default context).

### 4. Isolation coverage

| Runtime / channel | Covered? | Mechanism |
|---|---|---|
| Common cwd file access | yes, for implicit baseline cwd | fresh empty per-attempt cwd under `~/.oh-my-knowledge/state/isolated-cwd/` |
| Codex CLI profile, sessions, and rules | yes | `--ephemeral --ignore-user-config --ignore-rules` plus isolated `-C` |
| Codex SDK profile and sessions | yes | fresh `CODEX_HOME` with copied credentials plus isolated working directory |
| Codex SDK project execpolicy | SDK limitation | SDK does not expose `--ignore-rules`; use the `codex` executor when this final boundary matters |
| Claude SDK skill discovery / subagent Skill tool | yes | `skills: []` plus `disallowedTools: ['Skill']` |
| Claude CLI skill commands | yes | `--disable-slash-commands --disallowedTools Skill` |
| Custom script executor | not enforceable | one-time warning; omk cannot prove what the user command loads |

**Why the cwd channel is listed separately**: provider-specific flags cannot prevent ordinary file tools from reading `skills/<name>/` under an evaluation workspace. A strict baseline without an explicit cwd therefore gets a fresh empty directory for each execution. **An explicitly supplied baseline cwd is not replaced**, because the directory is intentional runtime context in the measurement.

Note: isolated-cwd is not a sandbox. A baseline may still read absolute paths. An empty cwd and discovery controls do not prevent prompt-directed reads; scenarios needing file-access isolation require a separate sandbox.

### 5. Cache key version

Core owns stage-specific caches rather than the old executor `v9:` prefix. The Execution key uses `omk.execution-cache-key/v2`, binding `executionCoordinateDigest` and `trialId`. The Evaluation key uses `omk.evaluation-cache-key/v2`, binding the evaluation plan, evaluation id, evaluator Runtime, source trust, and bindings. Readback also verifies records, plans, and source identity; a matching digest does not replace trust verification.

[Input compilation](../evaluation/cli-evaluation-input-compilation.md) and the [Runtime Adapter](../evaluation/evaluation-runtime-adapter.md) specify how isolation, inputs, and external dependencies enter sealed identity. Old report fields or cache prefixes do not establish current comparability.

### 6. Executor compatibility

| Executor | undefined | `[]` | `[name]` |
|---|---|---|---|
| `codex` | executor-default cwd | isolated cwd + ignored user config / rules | **throw at shared planner** |
| `codex-sdk` | project cwd; isolated `CODEX_HOME` | isolated cwd + isolated `CODEX_HOME` | **throw at shared planner** |
| `claude-sdk` | full discovery (default) | skills:[] + disallowedTools:[Skill] | **throw** |
| `claude-cli` | default | `--disable-slash-commands --disallowedTools Skill` | **throw** |
| API executors | no implicit local skill discovery | no additional effect | **throw at shared planner** |
| custom script | command-defined | stderr warning; cannot guarantee isolation | **throw at shared planner** |

A non-empty skill whitelist `[name]` is rejected before executor dispatch, including programmatic callers that bypass eval.yaml validation. Use `[]` for strict isolation or omit the field for executor-default context. A custom script cannot prove strict isolation even with `[]`, so omk warns and records the isolation declaration for audit rather than silently claiming it was enforced.

## 8. Decision criteria

When adding features, docs, or interfaces later and facing a naming choice, decide in this order:

1. Is it describing the thing being evaluated? If so, use `artifact`.
2. Is it describing the experiment grouping? If so, use `variant`.
3. Is it describing the experiment role? If so, use `control` / `treatment`.
4. Is it describing the run directory or environment? If so, use `runtime context`.
5. Is it describing a concrete object type? If so, use `skill` / `agent` / `workflow`.
6. If a single word mixes object, environment, or role semantics, split it apart and rewrite.
