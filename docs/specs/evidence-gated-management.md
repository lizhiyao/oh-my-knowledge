# Evidence-gated knowledge input management

> **Status**: design note for #203. This document defines the product boundary before adding broad management commands. It does not change Report schema, judge prompts, scoring, or comparability rules.

## 1. Product thesis

omk should manage knowledge inputs only where measurement gives it a defensible advantage.

Generic skill management is already crowded by platform-native systems: Claude plugins / skills, Codex skills, Cursor rules, and similar registries. omk should not compete on generic CRUD such as "copy this skill somewhere", "list a package registry", or "archive a folder".

omk's unique asset is evidence: verdicts, deltas, confidence intervals, judge agreement, sample-set hashes, runtime observations, and comparability diagnostics. So management in omk should mean:

- deciding what can be promoted because evidence supports it
- keeping a version history with attached evaluation evidence
- rolling back to a version whose evidence is known
- detecting when evidence is stale, incomparable, or contradicted by production traces

In short: omk does not manage knowledge inputs because it is a better file copier. It manages them because it can say why a version deserves to ship.

## 2. Scope and non-goals

### In scope

- Evidence-gated management of knowledge artifacts: skills first, then prompts, agent context, workflows, and RAG/corpus-like inputs once their artifact model is defined.
- Decisions that sit after existing omk stages:
  - `doctor` proves the artifact is structurally testable.
  - `sample` creates or repairs the measurement set.
  - `eval` decides whether a change is progress, noise, or regression.
  - `evolve` proposes candidate versions.
  - `observe` finds production gaps that should feed the next eval set.
- A management layer that records and explains decisions: promoted, rejected, rolled back, stale, or needs more evidence.

### Out of scope

- A general marketplace or registry for arbitrary skills.
- Platform-specific plugin management beyond install targets omk explicitly supports.
- Declaring one skill "better than another" without a shared eval design.
- Using production observation as absolute scoring. `observe` is a signal source, not a replacement for controlled eval.
- Closing #203 by the onboarding helper `omk install omk-agent-skill`; that work is scoped separately in #208.

## 3. Core invariant: comparability before convenience

Every management decision must preserve omk's measurement posture:

- A promotion decision must point to comparable reports or explicitly mark why comparability is limited.
- A rollback decision must point to a historical version and the evidence that justified it.
- A production observation must name its attribution confidence and cannot silently overwrite eval evidence.
- A stale or incomparable evidence bundle must be visible to the user, not hidden behind a green status.

This means omk management should prefer "blocked until evidence is valid" over "installed because the file exists".

## 4. Terminology

- **Knowledge input**: user-facing umbrella for what the LLM receives: prompt, skill, RAG/corpus input, agent context, or workflow instructions.
- **Artifact**: the measured object in omk's eval model. See [terminology spec](./terminology-spec.md).
- **Artifact kind**: the concrete `Artifact.kind` value, such as `skill`, `prompt`, `agent`, or `workflow`. Product-level `kind` should reserve this meaning.
- **Candidate**: an artifact version proposed by `evolve` or by a human edit, not yet promoted.
- **Promoted version**: the version accepted as the current managed version, with evidence attached.
- **Evidence bundle**: the minimal evidence needed to explain a management decision.

## 5. Evidence bundle

A management decision should store or reference an evidence bundle containing:

- Artifact identity: name, kind, source path or source URI, content hash, and version/ref.
- Runtime context: executor, model, cwd/runtime context, allowed skill/tool isolation, and relevant dependency fingerprint.
- Eval identity: report id, omk CLI version, judge prompt hash, sample-set hash coverage, scoring pipeline version, and length-debias setting.
- Verdict summary: verdict, control/treatment names, delta, confidence interval, sample count, underpowered/cautious flags, and cost.
- Sample-design caveats: construct mix, provenance mix, thin capabilities, and explicit warnings.
- Observation links: trace window, attribution confidence, production-gap signals, and whether those signals have been converted into eval samples.
- Human decision: promoted/rejected/rolled back/override, actor, timestamp, and reason.

The bundle can start as references to existing reports instead of a new heavy schema. If Report schema fields must change, that should be a separate migration with comparability impact called out.

## 6. Lifecycle states

Useful states for a managed artifact:

| State | Meaning | Allowed next step |
|---|---|---|
| `discovered` | omk found a candidate artifact but has no management record | `doctor`, `install` |
| `installed` | omk knows where the artifact lives, but it has no valid eval evidence | `doctor`, `sample`, `eval` |
| `measurable` | doctor and samples are sufficient to run controlled eval | `eval`, `evolve` |
| `candidate` | a proposed version exists, usually from `evolve` | `eval`, `promote`, `reject` |
| `promoted` | current accepted version with attached evidence | `observe`, `rollback`, `evolve` |
| `stale` | evidence no longer matches artifact/runtime/sample context | `doctor`, `eval` |
| `rolled-back` | historical promoted version restored with evidence | `observe`, `evolve` |

These states are product concepts, not necessarily a new persistent enum on day one.

## 7. Command surface

The long-term command loop remains:

```text
install → list → doctor → sample → eval → evolve → promote
                                      ↘ rollback
observe → studio
```

### `install`

Current release scope:

```bash
omk install omk-agent-skill
```

This installs the official omk Agent Skill for onboarding. It is a reserved built-in id, not a registry package and not the user's evaluated artifact.

Future managed-input scope:

```bash
omk install ./skills/review/SKILL.md --kind skill
omk install ./prompts/rewrite.md --kind prompt
```

Rules:

- `--kind` should align with `Artifact.kind`; do not use `kind` for runtime/report/event categories.
- Installing a user artifact creates a managed record but does not imply promotion.
- Installed artifacts start as `installed` or `measurable`, depending on doctor/sample state.

### `list`

`list` should show evidence status, not just files:

- discovered vs managed
- artifact kind
- latest promoted version
- latest verdict and whether it is comparable
- stale evidence markers
- production observation warnings

### `promote`

`promote` turns a candidate into the accepted managed version.

Default gate:

- comparable report exists
- verdict is `PROGRESS` or a configured acceptable result
- confidence interval / underpowered state is visible
- sample-design warnings are surfaced

Overrides may exist, but must be explicit and recorded as human decisions.

### `rollback`

`rollback` restores a previous promoted version and points to its evidence bundle. It should not be a blind file restore.

### `observe`

`observe` should feed management decisions by marking evidence stale, discovering production gaps, or suggesting new samples. It must not silently promote or demote artifacts.

### `studio`

Studio should make the decision trail inspectable: why this version is current, what evidence supported it, what warnings remain, and what changed since the last promotion.

## 8. Phasing

### Phase 0: onboarding install

Done in #208 / PR #207:

- npm package carries the official omk Agent Skill.
- `omk install omk-agent-skill` installs only to detected or explicitly requested supported targets.
- This does not close the evidence-gated management design.

### Phase 1: design and read-only inventory

- Land this design note.
- Add read-only `list` semantics or a prototype inventory that reports discovered/managed/evidence status without changing artifacts.
- Define the first evidence-bundle storage shape.

### Phase 2: promotion records

- Add candidate/promoted records.
- Let `evolve` produce candidates that can be promoted with evidence.
- Require comparable eval evidence for default promotion.

### Phase 3: rollback and observation feedback

- Add rollback to evidence-backed historical versions.
- Let `observe` mark evidence stale and propose sample additions.
- Show decision history in Studio.

## 9. Open questions

- Where should management records live: `.omk/managed.json`, `.omk/artifacts/`, or another store?
- How should git refs and omk evidence records interact?
- Which verdicts are acceptable for promotion by default: only `PROGRESS`, or `CAUTIOUS` with explicit caveats?
- What is the stale-evidence policy when only samples change, only runtime context changes, or only artifact content changes?
- Should human override be allowed in CLI, Studio, or both?
- When should `omk init` become `omk eval init`, and what compatibility alias policy is acceptable?

## 10. Decision for now

Treat evidence-gated management as a real omk direction, but do not rush broad CRUD commands.

The next implementation work should be a small, evidence-aware inventory/prototype rather than a generic skill registry. That keeps omk's identity anchored in measurement: manage only when evidence travels with the artifact.

