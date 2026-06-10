# Evidence-gated knowledge input management

> **Status**: design note for #203. The management entry point — `omk install` registering managed records — `omk list` (evidence status / lifecycle), `omk promote` (evidence-gated acceptance, MVP), and `omk rollback` (revoking that acceptance, MVP) have shipped (#211/#212/#224 + promote/rollback MVP); `promote`'s evolve-candidate canonical-write to source and rollback-to-a-historical-version's content remain design. This document defines the product boundary; it does not change Report schema, judge prompts, scoring, or comparability rules.

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
- A rollback decision must be explicit and recorded; the MVP revokes the current version's acceptance, and restoring a *historical* version's content (future work) must point to that version and the evidence that justified it.
- A production observation must name its attribution confidence and cannot silently overwrite eval evidence.
- A stale or incomparable evidence bundle must be visible to the user, not hidden behind a green status.

This means omk management should prefer "blocked until evidence is valid" over "installed because the file exists".

## 4. Terminology

- **Knowledge input**: user-facing umbrella for what the LLM receives: prompt, skill, RAG/corpus input, agent context, or workflow instructions.
- **Artifact**: the measured object in omk's eval model. See [terminology spec](./terminology-spec.md).
- **Artifact kind**: the concrete `Artifact.kind` value, such as `skill`, `prompt`, `agent`, or `workflow`. Product-level `kind` should reserve this meaning.
- **Candidate**: an artifact version proposed by `evolve` (written only as a snapshot under evolve's working directory) or by a human edit — not yet written to the source of record.
- **Promoted version**: the version `promote` has written back to the source-of-record artifact file and accepted as current, with evidence attached.
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

Mandatory vs derived. For a default `promote` gate, four items are mandatory and must resolve against one comparable report: report id, sample-set hash coverage (the report's `sampleHashes`), verdict, and a comparability marker (matching `cliVersion` / `judgePromptHash` / `debiasMode`). A candidate missing any of these is blocked, not waved through; the rest are advisory context. Note that several listed items are not persisted Report fields but are derived from a Report — verdict, underpowered/cautious flags, and scoring-pipeline version are computed at report time — so Phase 1 should treat them as derived from a referenced Report, not as existing ReportMeta columns. Persisting the scoring-pipeline version is part of the schema-migration question in §9.

## 6. Lifecycle states

Useful states for a managed artifact:

| State | Meaning | Transition (verb → next state) |
|---|---|---|
| `discovered` | omk found a candidate artifact but has no management record (a pre-install `doctor` is advisory only and creates no record) | `install → installed` |
| `installed` | omk knows where the artifact lives, but it has no valid eval evidence | `doctor` / `sample` → `measurable` |
| `measurable` | doctor and samples are sufficient to run controlled eval | `eval → measurable`; `evolve → candidate` |
| `candidate` | a proposed version exists (an `evolve` snapshot or a human edit), not yet written to the source of record | `eval → candidate`; `promote → promoted` (or reject, source untouched) |
| `promoted` | current accepted version, written to the source by `promote`, with attached evidence | `observe → promoted` / `stale`; `rollback → measurable` (or `stale` if drifted); `evolve → candidate` |
| `stale` | evidence no longer matches artifact / runtime / sample context | `doctor` / `sample` → `measurable` |
| `rolled-back` | (future) a historical promoted version's content restored by `rollback` with evidence — not yet a `ManagedLifecycleLabel` | `observe`; `evolve → candidate` |

These states are product concepts, not necessarily a new persistent enum on day one. The MVP `rollback` revokes the current version's acceptance and returns the skill to `measurable` (or `stale` if the source has drifted); `rolled-back` remains a future product concept and is not yet a `ManagedLifecycleLabel`. `reject` is the negative outcome of a `promote` decision (recorded in the evidence bundle, source untouched), not a separate command.

## 7. Command surface

The long-term command loop remains:

```text
install → list → doctor → sample → eval → evolve → promote
                                                   ↘ rollback
observe → studio
```

### `install`

`install` is the management entry point. Sources that ship today:

```bash
omk install omk-agent-skill            # reserved built-in id: the official omk Agent Skill (onboarding)
omk install ./skills/review            # a local skill (directory or .md)
omk install git:<ref>:skills/review    # a skill at a ref of the current repo
omk install --git-url <url> --git-ref <ref> skills/review   # a skill from a remote git repo
```

The built-in id is a reserved onboarding skill, not a registry package and not the user's evaluated artifact. Installing a **user** skill (local path, `git:`, or remote `--git-url`) both distributes it to the detected agent targets and writes a managed record at `.omk/managed/<id>.json`. A remote source records the structured `url` plus the **pinned SHA** (a branch/tag drifts; the SHA is reproducible). Remote URLs flow as structured `url`/`ref`/`spec` fields, never spliced into the `git:<ref>:<spec>` colon syntax (whose `:` / `@` would corrupt an `https://` or `git@host:` URL). The eval side accepts the symmetric structured form via `eval.yaml` (`variants[].git: { url, ref, spec }`); the eval CLI `--control`/`--treatment` reject remote URL strings and point to `eval.yaml`, since their comma/`@cwd` parsing cannot carry a URL safely.

Future managed-input scope (not yet supported — `install` hard-rejects non-skill kinds today):

```bash
omk install ./prompts/rewrite.md --kind prompt
```

Rules:

- `--kind` aligns with `Artifact.kind`; do not use `kind` for runtime/report/event categories. It is optional and inferred from `SKILL.md`; only `skill` is supported today.
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

### `evolve`

`evolve` proposes candidate versions. It writes those candidates only as snapshots under its own working directory (for example `evolve/`); it does not write the source-of-record artifact file. The canonical write to the source artifact is owned exclusively by `promote`. This is a change from `evolve`'s current behavior, which auto-writes the winning candidate back to the source file at the end of a run — see §8 Phase 2 for the migration.

### `promote`

`promote` accepts a managed skill's current version as the blessed one, gated on its evidence, and appends a human decision (with an evidence pointer) to the record. It is the command that owns the canonical write to the source-of-record artifact file.

What ships in the MVP (`omk promote <name>`): the install / human-edit loop, where the measured content already lives at the source. promote does not rewrite the file there; its substance is the gated **acceptance decision** + the lifecycle transition to `promoted` (read-time derived by `deriveManagedState` when the current content carries a `promote` decision). The canonical write-from-a-not-yet-at-source-candidate (the evolve flow) is deferred with the §8 Phase 2 evolve migration — until evolve stops auto-writing the winner to the source, there is nothing for promote to write there.

Default gate (resolved against the latest **current** evidence — `contentHash` matching the record):

- the source is not drifted / unreachable (else the on-disk content is not what was measured)
- current evidence exists (no evidence ⇒ blocked, and `--force` cannot conjure an anchor)
- comparability: the evidence's `judgePromptHash`, if present, is still a current judge-prompt template (a changed judge prompt ⇒ the old verdict is incomparable ⇒ blocked); a missing fingerprint warns but does not block; `cliVersion` is shown, not hard-gated (else every release would invalidate all evidence)
- verdict is `PROGRESS` by default; `CAUTIOUS` only with explicit `--accept-cautious`; everything else is blocked

Of §5's four mandatory items, the MVP gate checks three at promote time (report id via "current evidence exists", verdict, and the comparability marker); **sample-set coverage** is denormalized into the evidence bundle by `eval` (§9, #221) and trusted here — the gate does not re-derive or re-check it. (§5's "mandatory" framing is about what `eval` must write into the bundle, not a separate promote-time re-check.)

`--force` overrides only forceable non-evidence blocks (source unreachable / incomparable / verdict), recorded on the decision as `override.verdict` (plus `override.overriddenBlocks` naming which checks were waved through) with the human's required `--reason` (spec invariant: overrides must be explicit and recorded). A reachable source whose content hash differs from the managed baseline is not forceable: the decision would still point at the old `record.contentHash`, so users must re-run `omk eval` / reinstall instead. Re-running promote on an already-promoted current version is an idempotent no-op.

### `rollback`

`rollback` is the inverse of `promote`: it revokes the current version's promoted acceptance. Decisions are an append-only event stream, so rollback appends a `rollback` decision (actor, timestamp, optional reason) rather than deleting the promote; the `promoted` lifecycle label is then derived from the **latest** promote/rollback decision for the current content (`isCurrentlyPromoted`), so the label derives back to `measurable` — or stays `stale` if the source has since drifted, because rollback does not probe the source. It is content-anchored and ungated — de-escalation is always safe — operating purely on the promote/rollback history for `record.contentHash`.

What ships in the MVP (`omk rollback <name>`): revoking the acceptance of the **current** content. Rolling back a not-promoted version exits non-zero (nothing to revoke); an already-rolled-back version is an idempotent no-op; and `promote → rollback → promote` restores `promoted` (latest wins). Restoring an *older promoted version's content* to the source (a true file restore, pointing back to that version's evidence bundle) is deferred with the §8 Phase 2 evolve canonical-write migration — until `promote` owns canonical writes to the source, there is no prior snapshot for rollback to restore. It must never be a blind file restore.

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

### Phase 2: promotion records and the canonical-writer migration

- **Shipped (promote MVP):** the gated **acceptance decision** for the install / human-edit loop — `omk promote <name>` requires comparable, current, gate-passing evidence (default `PROGRESS`) and appends a `promote` decision; `deriveManagedState` derives the `promoted` lifecycle label. `ManagedDecision` gained additive evidence-pointer fields (`contentHash` / `reportId` / `override`), still `schemaVersion 2`.
- **Remaining (evolve canonical-writer migration):** today `evolve` auto-writes the winning candidate back to the source artifact file at the end of a run, so nothing is left for `promote` to gate **in the evolve flow**. Decision (B): make `promote` the sole owner of the canonical write to the source artifact; change `evolve` to write candidates only as snapshots under its working directory and stop mutating the source. This is a behavior change to a current `evolve` default and must land before `promote` can write an evolve candidate to the source; ship it with a changelog / deprecation note.
- Let `evolve` produce candidates that `promote` can write with evidence.

### Phase 3: rollback and observation feedback

- **Shipped (rollback MVP):** `omk rollback <name>` revokes the current version's promoted acceptance by appending a `rollback` decision; `isCurrentlyPromoted` (latest promote/rollback wins) derives the state back to `measurable`. `ManagedDecisionKind` already carried `rollback`; no schema change.
- **Remaining:** restoring an evidence-backed *historical* version's content to the source (a true file restore), which depends on the Phase 2 canonical-writer migration giving rollback a prior snapshot to restore.
- Let `observe` mark evidence stale and propose sample additions.
- Show decision history in Studio.

## 9. Open questions

- **Decided:** management records live in per-record files `.omk/managed/<id>.json` (atomic tmp+rename, mirroring report-store), not a single aggregate file.
- **Decided (#214, completed):** the artifact content hash is unified so evidence can bind, keyed on *what the executor actually measures*. Every directory-skill — local **and** git — is materialized before measurement into an isolated content-addressed copy (`materializeIsolatedCopy`), and the executor's `cwd` is anchored to that copy so `references/` assets are real runtime input. `eval` records the same whole-tree `hashArtifactSource` as `install` (report `schemaVersion >= 3`), so `evidence.contentHash === record.contentHash` lives in one space for all directory-skills (the executor cache key carries the same hash, so an asset edit busts the cache). File-skills (local or git) hash the single `.md` bytes and also bind. The isolated copy also means the agent runs against a copy, not the user's real skill directory. `schemaVersion 2` was a transitional era where local directory-skills were tree-hashed but git directory-skills hashed `SKILL.md` bytes only (did not bind); git-directory-skill hashes from v2 are incomparable to v3. Reports with `schemaVersion < 2` carry the legacy SKILL.md-text hash and are treated as incomparable by drift / lineage consumers (re-run `eval`).
- **Decided (#221, completed):** `eval` now writes the evidence. On completion it appends one `ManagedEvidenceRef` to every **already-managed** record it can match to a tested variant (`src/managed/evidence.ts`), moving the skill from `installed` to `measurable` via `deriveManagedState`. Three settled trade-offs: (a) **trigger** — auto on eval completion, but only to records that already exist (`install` is the opt-in; a never-installed skill is never conjured into a record), with `--no-evidence` to disable; (b) **many-to-one** — append-only with `(reportId, contentHash)` dedup, all history retained, current validity still decided read-time by the contentHash match (so old-content evidence survives for rollback without making the new content look measured); (c) **cross-source identity** — install and eval name the same skill differently (record name is the short skill name `review`; the report variant key may be a full expression `git:HEAD:skills/review`, an eval.yaml alias `candidate`, or a blind label `A`), so matching is a three-tier disambiguation: explicit same-name variant, then structural source match (`variantConfigs[].locator/ref` against `record.source`), then a pure-contentHash fallback **only when that hash is unique among managed records** — the uniqueness gate stops a report that tested one skill from writing evidence into a different record that merely happens to share identical current content. `applyBlindMode` blinds `variants` but not `artifactHashes`/`variantConfigs`, so all three tiers work under blind mode. The bundle denormalizes §5's mandatory four (report id, sample-set coverage, verdict, comparability marker) into the record so it stays self-contained and grep-able without re-reading the report. This does not change Report schema or any comparability invariant; the management record stays `schemaVersion 2` (additive optional evidence fields). `promote` (MVP) now gates on these bundles — see §7.
- How should git refs and omk evidence records interact (re-materialize a moving branch vs a pinned SHA on drift checks)?
- What snapshot layout should `evolve` write under its working directory, and what is the deprecation path for users who currently rely on `evolve` writing the winner back to the source file (decision B migration mechanics)?
- **Decided (promote MVP):** default acceptable verdict is `PROGRESS` only (omk's default-strict posture — defaults that affect a "deserves to ship" judgment must be strict); `CAUTIOUS` passes only with explicit `--accept-cautious`; everything else needs `--force` (recorded as an override).
- What is the stale-evidence policy when only samples change, only runtime context changes, or only artifact content changes?
- Should human override be allowed in CLI, Studio, or both?
- When should `omk init` become `omk eval init`, and what compatibility alias policy is acceptable?

## 10. Decision for now

Treat evidence-gated management as a real omk direction, but do not rush broad CRUD commands.

The next implementation work should be a small, evidence-aware inventory/prototype rather than a generic skill registry. That keeps omk's identity anchored in measurement: manage only when evidence travels with the artifact.
