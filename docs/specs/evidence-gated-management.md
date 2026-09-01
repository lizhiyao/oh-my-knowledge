# Evidence-gated knowledge input management

> **Status**: implemented design for #203, updated for the Evaluation Core cutover. Managed records use schema v3 and accept only authenticated Core evidence projections. Schema-v2 records and legacy evaluation reports are rejected without migration. This document does not change frozen evaluator prompts, scoring semantics, or comparability formulas.

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

- A promotion decision must point to an authenticated, decision-ready Core run, or explicitly record an override of a forceable gate.
- A rollback decision must be explicit and recorded; the MVP revokes the current version's acceptance. Restoring historical content is delegated entirely to the source repository. Managed evidence identifies measured content by digest but does not invent a source-control coordinate.
- A production observation must name its attribution confidence and cannot silently overwrite eval evidence.
- Stale, incomplete, or measurement-only evidence must be visible to the user, not hidden behind a green status.

This means omk management should prefer "blocked until evidence is valid" over "installed because the file exists".

## 4. Terminology

- **Knowledge input**: user-facing umbrella for what the LLM receives: prompt, skill, RAG/corpus input, agent context, or workflow instructions.
- **Artifact**: the measured object in omk's eval model. See [terminology spec](./terminology-spec.md).
- **Artifact kind**: the concrete `Artifact.kind` value, such as `skill`, `prompt`, `agent`, or `workflow`. Product-level `kind` should reserve this meaning.
- **Candidate**: an artifact version not yet at the source of record — an `evolve --snapshot-only` snapshot under evolve's working directory, or a human edit in progress. (By default `evolve` writes its winner *to* source, so the default evolve outcome is not a candidate but a measured current version.)
- **Promoted version**: the current source-of-record version a human has accepted via `promote`, with evidence attached. The content is written by whoever produced it (`evolve`, a human edit, or `install`); `promote` records the acceptance, it does not write the file.
- **Evidence bundle**: the minimal evidence needed to explain a management decision.

## 5. Evidence bundle

A management decision stores a denormalized projection authenticated from one Evaluation Core run:

- Artifact identity: name, kind, source path or source URI, content hash, and version/ref.
- Core identity: `runId`, report id/digest, target id, artifact digest, and artifact content hash.
- Comparability identity: run-contract, dataset-revision, execution-plan, evaluation-plan, analysis-plan, and decision-plan digests.
- Decision projection: evidence readiness, verdict when a decision exists, stable reason codes, and sample coverage.
- Sample-design caveats: construct mix, provenance mix, thin capabilities, and explicit warnings.
- Observation links: trace window, attribution confidence, production-gap signals, and whether those signals have been converted into eval samples.
- Human decision: promoted/rejected/rolled back/override, actor, timestamp, and reason.

The managed layer never re-derives these claims from report rows. The Core
downstream projection is produced only after manifest, digest, lineage, and
content-reference authentication. Missing identity or a non-decision-ready
projection fails closed. `promote` still requires current content-bound evidence
and an acceptable verdict; `--force --reason` may override forceable decision
blocks, but cannot invent missing evidence or accept content known to have
changed.

## 6. Lifecycle states

Useful states for a managed artifact:

| State | Meaning | Transition (verb → next state) |
|---|---|---|
| `discovered` | omk found a candidate artifact but has no management record (a pre-install `doctor` is advisory only and creates no record) | `install → installed` |
| `installed` | omk knows where the artifact lives, but it has no valid eval evidence | `doctor` / `sample` → `measurable` |
| `measurable` | doctor and samples are sufficient to run controlled eval | `eval → measurable`; `evolve → measurable` (managed: writes source + records evidence + re-baselines); `evolve --snapshot-only → candidate` |
| `candidate` | a proposed version not yet at the source of record (an `evolve --snapshot-only` snapshot or a human edit) | `eval → candidate`; `promote → promoted` (or reject, source untouched) |
| `promoted` | current accepted version (content written by evolve / human edit / install), accepted via `promote`, with attached evidence | `observe → promoted` / `stale`; `rollback → measurable` (or `stale` if drifted); `evolve → measurable` (re-baselines to the new version) |
| `stale` | a **reachable** source whose content hash no longer matches what was measured — identity drift; an unreachable source (unverified) and runtime / sample-set divergence are separate read-time markers, not this label (§6.1) | `doctor` / `sample` / re-`eval` → `measurable` |
These states are product concepts, not necessarily a new persistent enum on day one. The MVP `rollback` revokes the current version's acceptance and returns the skill to `measurable` (or `stale` if the source has drifted). There is no `rolled-back` lifecycle: file-level restore is delegated to git (§7 `rollback` / §8), so a user who `git checkout`s back to a historical version's bytes simply has omk re-derive state from the now-current content via `deriveManagedState`, with no special state. `reject` is the negative outcome of a `promote` decision (recorded in the evidence bundle, source untouched), not a separate command.

### 6.1 Evidence currency: three drift axes

A record's evidence certifies *one artifact version, measured on one dataset revision under one sealed Core contract*. Currency is therefore derived from content identity plus the authenticated Core readiness/comparability projection.

| Axis | Drift detector | Lifecycle effect | Promote-gate consequence |
|---|---|---|---|
| **Content** (artifact identity) | reachable source and `currentContentHash !== record.contentHash` | → `stale` | non-forceable block; re-run `eval` or reinstall. |
| **Source reachability** | current content cannot be verified | keeps the evidence-derived label plus an unverified marker | forceable only when current Core evidence exists. |
| **Dataset** (coverage) | `sampleCoverage.hash` identifies the sealed dataset revision | none | trusted only as part of the authenticated projection; the managed layer does not reconstruct it. |
| **Core decision readiness** | `evidenceReadiness !== decision-ready` or no decided verdict | none | forceable decision block, recorded as an override. |

The asymmetry is deliberate: a known content change means OMK measured a
different artifact and cannot be overridden. An unreachable source is unknown,
not known-different, so an attributable human may override it. Core plan and
dataset identity are persisted as digests on the evidence instead of being
guessed later from CLI versions or prompt hashes.

A fourth read-time marker, fed by `observe` rather than by evidence currency (#235): a **production-gap** marker. The three drift axes ask whether the *evidence* is still current; this asks whether *production traffic* shows the skill failing (knowledge gaps, hedging, repeated failures). It is **version-agnostic**: `observe` measures the *deployed* skill's behavior, and the record carries no reliable source↔deployed time anchor (`evolve` rebaselines `contentHash` without redistributing, so production keeps running the old copy) — so the marker is **not attributed to a source version and there is no version gate**. A gate would only add false precision and could even hide a still-valid gap after a source bump. The **latest** observation (by observed window end) wins; it **never flips the `stale` lifecycle** (only content drift does) and **never gates `promote`** — `observe` is a signal source, not controlled eval (§2). A red, sufficiently-powered observation reads as a gap; an `underpowered` one is `unknown` (too few production segments — surfaced, not treated as a gap). The marker reflects the deployed copy and can lag the current source. See §7 `observe`.

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

`evolve` runs a Core-native improvement loop and, by default, writes the winning version back to the source-of-record file. Each round's candidate is also kept under `evolve/`. Every candidate is measured as an explicit Core control/treatment comparison, and acceptance comes from the authenticated Core decision projection rather than an authoring-layer reimplementation of statistics. When the evolved skill is **managed**, evolve first verifies that the winning target's sealed artifact digest matches the written source, then re-baselines `contentHash` and appends that exact Core evidence. Ambiguous digest matches fail closed. It does **not** write a `promote` decision; production acceptance remains an explicit human `omk promote` call. `--snapshot-only` leaves both the source and managed record unchanged.

This supersedes the once-planned "evolve writes snapshots only, `promote` owns the sole canonical write" migration (former Decision B, §8), which was **rejected**: evolve already accepts candidates through a Core decision, while `promote` is a distinct human production-acceptance decision. Making promote the writer would break the one-command authoring flow and force users to install a skill before evolve could update its source.

### `promote`

`promote` accepts a managed skill's current version as the blessed one, gated on its evidence, and appends a human decision (with an evidence pointer) to the record. It is the **human acceptance gate**, not an exclusive writer of the source file — `evolve` and human edits also write the source. promote's substance is the gated *decision* + the lifecycle transition to `promoted`, never a file rewrite of its own.

`omk promote <name>` works on the install / human-edit / **evolve** loops alike — in all three the measured content already lives at the source by the time you promote (evolve writes it back; see §7 `evolve`). promote does not rewrite the file; its substance is the gated **acceptance decision** + the lifecycle transition to `promoted` (read-time derived by `deriveManagedState` when the current content carries a `promote` decision). After an `evolve` run on a managed skill, the skill is already `measurable` with current evidence, so `omk promote` accepts it directly (no drift) — this is the evolve→promote path, with the human keeping the final acceptance call.

Default gate (resolved against the latest **current** evidence — `contentHash` matching the record):

- the source is not drifted / unreachable (else the on-disk content is not what was measured)
- current evidence exists (no evidence ⇒ blocked, and `--force` cannot conjure an anchor)
- the authenticated Core projection is `decision-ready`
- verdict is `PROGRESS` by default; `CAUTIOUS` only with explicit `--accept-cautious`; everything else is blocked

The gate trusts the authenticated projection's sealed dataset and plan digests;
it does not reload a report or reproduce Core authentication. A
`measurement-only` or `insufficient` projection is blocked even if it contains
scores.

`--force` overrides only forceable non-evidence blocks (source unreachable / incomparable / verdict), recorded on the decision as `override.verdict` (plus `override.overriddenBlocks` naming which checks were waved through) with the human's required `--reason` (spec invariant: overrides must be explicit and recorded). A reachable source whose content hash differs from the managed baseline is not forceable: the decision would still point at the old `record.contentHash`, so users must re-run `omk eval` / reinstall instead. Re-running promote on an already-promoted current version is an idempotent no-op.

### `rollback`

`rollback` is the inverse of `promote`: it revokes the current version's promoted acceptance. Decisions are an append-only event stream, so rollback appends a `rollback` decision (actor, timestamp, optional reason) rather than deleting the promote; the `promoted` lifecycle label is then derived from the **latest** promote/rollback decision for the current content (`isCurrentlyPromoted`), so the label derives back to `measurable` — or stays `stale` if the source has since drifted, because rollback does not probe the source. It is content-anchored and ungated — de-escalation is always safe — operating purely on the promote/rollback history for `record.contentHash`.

What ships in the MVP (`omk rollback <name>`) is revocation of the **current** content's acceptance. Rolling back a version that is not promoted exits non-zero; repeating an already-recorded rollback is an idempotent no-op; and `promote → rollback → promote` restores `promoted` because the latest decision wins. Restoring older content to the source is out of scope. Core evidence deliberately carries authenticated content and plan digests, not a guessed working-tree ref or checkout command. Users restore bytes through their source repository and rerun Evaluation Core to establish evidence for the restored content.

### `observe`

`observe` feeds the management pillar without ever silently promoting or demoting an artifact (a signal source, not controlled eval — §2). On completion it appends one denormalized `ManagedObservation` (production gap rate, severity-weighted rate, statistical confidence, gap-type counts) to every **already-managed** `skill` record whose name matches an observed skill. Matching is by **name + kind** — `observe` traces carry no `contentHash`, only the invocation name, which equals the install name by convention; a skill whose frontmatter `name:` differs from its install directory name records nothing (fail-safe). The record gains a read-time **production-gap** marker (§6.1) and the CLI prints which gap areas to add coverage for. It does **not** edit the sample set (suggest-only), flip the `stale` lifecycle (the gap is a marker, not content drift), or promote/demote. `--no-feedback` disables the write; an unmanaged skill is never conjured into a record (mirrors `eval`'s evidence opt-in).

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

### Phase 2: promotion records and evolve↔management integration

- **Shipped (promote):** `omk promote <name>` requires current, authenticated Core evidence (default verdict `PROGRESS`) and appends a `promote` decision carrying `contentHash`, Core `runId`, and any explicit override. `deriveManagedState` derives the `promoted` lifecycle label.
- **Shipped (evolve managed-evidence integration):** `omk evolve` on a managed skill re-baselines the winning content and records an authenticated Core evidence projection, moving the record to `measurable`; it does not write the human `promote` decision. `--snapshot-only` leaves the managed record untouched.
- **Rejected (former Decision B, the canonical-writer migration):** making `promote` the *sole* writer to source and stripping `evolve`'s source write. Evolve already accepts candidates through a Core decision; promote is the separate human production-acceptance decision. The management gap is closed by recording authenticated evidence, not by rerouting the write.

### Phase 3: rollback and observation feedback

- **Shipped (rollback MVP):** `omk rollback <name>` revokes the current version's promoted acceptance by appending a `rollback` decision; `isCurrentlyPromoted` (latest promote/rollback wins) derives the state back to `measurable` (or `stale` if the source has since drifted — rollback doesn't probe the source). `ManagedDecisionKind` already carried `rollback`; no schema change.
- **Out of scope (delegated to source control):** restoring historical bytes. Core identifies the measured artifact by authenticated digest; it does not synthesize a git ref or mutate the working tree. The shipped decision-level rollback (revoking acceptance) remains the piece omk owns.
- **Shipped (#235):** `observe` records a production-health observation (`ManagedObservation`, append-only) on matching managed skills, surfaces a read-time production-gap marker, and prints sample-addition suggestions. It does not flip the lifecycle (the gap is a marker, not `stale` — §6.1) and does not edit the sample set.
- Show decision history in Studio.

## 9. Settled decisions

- Management records live in per-record files `.omk/managed/<id>.json` with atomic writes, not a single aggregate file.
- Schema v3 is a clean Core-only boundary. Schema-v2 records are rejected without migration; users reinstall and run a new Core evaluation.
- Artifact content identity is keyed on what the executor actually measures. Directory skills are materialized as isolated whole-tree, content-addressed copies; file skills hash their bytes.
- `eval` appends authenticated Core projections only to already-managed records. Matching prefers an exact target name, then a content hash that is unique among managed records. Evidence is append-only and deduplicated by Core run/report identity plus content.
- **Decided (#237):** drift is content-addressed against the source's **current resolution**, and the ref you install *is* the snapshot-vs-live choice. An immutable ref (a commit SHA) resolves to constant content by construction — it can never drift; a remote-pinned SHA skips the re-fetch entirely, while a local SHA is still re-materialized from the repo object DB to an identical hash. A **local** moving ref (`git:main:…` / `HEAD` / a tag) is a *live pointer*: each drift check re-materializes the ref and re-hashes the skill tree, so the record goes content-`stale` exactly when the skill's content moves under that ref — it is never frozen to its install-time SHA, because a green status over a moved branch would hide drift (§3). A **remote** install pins to the SHA resolved at install (records the SHA, not the branch): a deliberate reproducibility + offline carve-out — a distributed version should be a frozen, re-fetchable snapshot, and a drift check must not depend on network reachability. The local/remote split is therefore **intentional and persona-driven** (local = iterate on a working branch; remote = distribute a vetted snapshot), not an accident; to advance a remote-pinned record you reinstall (re-pin + re-baseline). See §6.1, content axis.
- **Decided:** `evolve` keeps writing the winner back to source by default (no deprecation needed); `--snapshot-only` is the opt-out for candidate-only runs (snapshots stay under `evolve/`). On a managed skill, evolve records evidence + re-baselines the record (→ `measurable`) instead of rerouting the write through `promote` — former Decision B (promote as sole canonical writer) is rejected; see §7 `evolve` and §8.
- **Decided (promote MVP):** default acceptable verdict is `PROGRESS` only (omk's default-strict posture — defaults that affect a "deserves to ship" judgment must be strict); `CAUTIOUS` passes only with explicit `--accept-cautious`; everything else needs `--force` (recorded as an override).
- Content drift is the only lifecycle `stale` transition and is non-forceable when the changed bytes are known. Source unreachability is forceable with attribution; Core readiness/verdict blocks are forceable; missing current evidence is never forceable.
- `observe` remains an independent, version-agnostic production signal. It may add a production-gap marker but never impersonates controlled Core evidence or changes the lifecycle by itself.
- **Decided (#238):** human override is **CLI-only** — `promote --force --reason`, with the decision's `actor` recorded from `--actor` / git / env so the waved gate is auditable. Studio stays **read-only**: it surfaces overrides for audit (the `/managed/<id>` decision timeline renders the waved blocks; the `/managed` list flags a current version that was force-promoted) but never performs one. An override waves measurement gates, so it must be attributable to a person; a local Studio web UI has no account model and omk does not add one, so it cannot record a trustworthy actor — keeping the write in the CLI preserves both the audit trail and Studio's read-only posture.

## 10. Decision for now

Treat evidence-gated management as a real omk direction, but do not rush broad CRUD commands.

The next implementation work should be a small, evidence-aware inventory/prototype rather than a generic skill registry. That keeps omk's identity anchored in measurement: manage only when evidence travels with the artifact.
