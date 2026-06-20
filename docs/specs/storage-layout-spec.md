# omk storage layout spec

> **Scope**: For omk maintainers. It explains where the various files omk produces should live, why, and when they get cleaned up. Two places are involved: the global directory on your machine, `~/.oh-my-knowledge/`, and each project's own `<project>/.omk/`. Bilingual versions coexist (`docs/specs/` English / `docs/zh/specs/` Chinese). The exact directory names are defined in the source (`src/eval-core/default-dirs.ts` etc.); this doc covers the "why". For everyday usage see the [README](../README.md).

## 1. Storing files has to satisfy three things at once

It looks simple, but miss any one and you've buried a landmine:

- **Every kind of thing needs one home.** You can't have reports default to global while governance files go to the project — two rules means users can't guess where their report landed or where `omk studio` reads it from.
- **You can list across projects, but you can't compare scores across projects.** A report only makes sense within its own set of test cases; change the cases and the score changes. Two projects with different cases, scores side by side — that's cheating (the technical name is construct validity, see [who-omk-is-for](../explanation/who-omk-is-for.md)). If every project's reports default into one global folder, `omk studio` opened from any directory shows a blur with no way to tell which report belongs to which project — welding "compare class A's score against class B's" into how files are stored.
- **Scratch must not mix with real data.** `cache` / `trees` / `isolated-cwd` / `jobs` are scratch — delete them and the program rebuilds them. If they sit flat next to real data like reports and look identical, you won't dare delete anything when reclaiming disk.

## 2. One rule decides where everything goes

Ask two questions, plus one rule that runs through everything:

- **Question 1 · Can it rebuild itself if deleted?** Yes → scratch, toss it into a dedicated `state/` folder where "this whole pile is safe to wipe" is obvious; no, must keep → the real-data area.
- **Question 2 · Does it only mean something inside one project?** Yes (e.g. a report, tied to that set of cases) → into that project's `.omk/` drawer; no, any project can share it (caches, materialized copies) → the machine-global directory.
- **The cross-cutting rule · Identify things by an ID card, not by which folder they're in.** Each thing's identity is its own `id + content fingerprint`; moving it only updates a signpost and never breaks the links that reference it.

By this, omk's artifacts each take their place:

| Artifact | Rebuildable if deleted? | Tied to a project? | Where |
|---|---|---|---|
| `reports` / `observe-health` / `doctors` / `observe-inbox` | No, keep it | tied to the sample set | project-local `.omk/` default, global fallback on read |
| `graphs` | No, keep it | tied to its source run | sidecar tree next to the writer's `.omk/` root |
| `managed` | No, keep it | tied to where the governed skill is installed | project-first → global fallback |
| `cache` / `trees` / `isolated-cwd` | Yes | any project can share | global `state/` subtree |
| `jobs` / `artifact-index` | Yes | derived from measurements | global `state/` subtree |

In one line: keep + tied to a project → local; rebuildable → toss into the wipeable `state/` subtree (anything shareable stays global). **The easiest mistake is to treat a "keep + tied to a project" measurement conclusion as an "anyone can share" cache — which is exactly what a global-default does.**

The measurement outputs in the first row are placed the same way (project-local default + global fallback on read + gitignored). Primary writers reach global through the `--global` switch: `reports` / `observe-health` / `doctors` write global when scoring against a standard sample set (see section 4), and `observe-inbox` supports it too (`omk observe ingest --global` to write, `omk observe inbox --global` to read), completing the observation loop for a global skill. Sidecar trees such as `graphs` inherit the output root of the writer that produced them, instead of inventing their own routing. `managed` is the exception — no switch, routing by where the governed skill is installed.

Doctor graph sidecars keep the sibling layout for the standard report directory:
`.omk/doctors` → `.omk/graphs/doctor`. If a user passes an arbitrary custom
`--output-dir` that is not named `doctors`, graph sidecars stay inside that
explicit directory: `<output-dir>/graphs/doctor`.

## 3. What it ends up looking like

```
~/.oh-my-knowledge/             # machine-global dir (honors OMK_HOME, relocatable as a whole)
  reports/ observe-health/ doctors/ observe-inbox/ graphs/   # written here only when you run omk ... --global
  managed/                      # governance archive for globally-installed skills
  update-check.json
  state/                        # scratch · wipe anytime
    cache/  isolated-cwd/  trees/  jobs/
    artifact-index/<domain>/<id>.json   # index cards for the cross-project overview (section 6)

<project>/.omk/                 # project-local · keep · tied to this project's sample set
  reports/  observe-health/  doctors/  observe-inbox/  graphs/   # measurement output, inbox, and sidecars — gitignored by default
  backups/                      # pre-fix skill originals saved by doctor --fix (for undo) — gitignored by default
  managed/                      # governance archive for project-vendored skills — committable (decision history)
  eval-samples.yaml / eval.yaml # measurement definition — committed
```

`OMK_HOME` is the master switch for this global tree: change it in one place and `reports` / `doctors` / `observe-health` / `graphs` / `state` (including the `cache` / `trees` / `jobs` / `artifact-index` inside) all move together. Whole-disk migration uses it, and tests use it to point the entire tree at a temp dir in one shot so they never dirty your real home.

### File naming grammar

Directories and filenames deliberately carry different bits of meaning:

- **The directory carries the product domain.** For example, `.omk/doctors/` already says "doctor", and `.omk/graphs/doctor/` already says "doctor graph sidecar"; filenames do not repeat those domain words.
- **Every run-derived artifact uses `<subject>-<runSuffix>.<artifactKind>.<ext>`.** `subject` is usually the skill or artifact name, `runSuffix` is the timestamp/counter/random tail that makes the run unique, `artifactKind` says what the file is, and `ext` says how to parse it.
- **Human and machine twins must differ before the extension.** Prefer `.graph.json`, `.card.md`, `.summary.json`, etc. over sibling files that only differ by `.json` versus `.md`.
- **Fixed source/config files keep human names.** `eval-samples.json`, `<skill>/.omk/samples.json`, `eval.yaml`, `metadata.yaml`, and `review-state.json` are source/config/state conventions, not run sidecars, so they do not need the run-derived grammar.

Legacy migration is one-shot and directory-scoped: old run artifacts in
`reports` / `doctors` / `observe-health` / `observe-inbox` are renamed into
`.report.json` form when those directories are touched. Bare `.json` is not a
normal reader format after migration, and unrelated JSON files in those
directories are skipped.

Examples:

```
.omk/reports/baseline-vs-service-guide-20260620-105109-aqgq.report.json
.omk/doctors/service-guide-20260620T105109-1-aqgq.report.json
.omk/observe-health/20260620T105109-aqgq.report.json
.omk/observe-inbox/20260620T105109-aqgq.report.json
.omk/graphs/doctor/service-guide-20260620T051909-1-aqgq.graph.json
.omk/graphs/doctor/service-guide-20260620T051909-1-aqgq.card.md
```

## 4. Skill, measurement, governance are three layers — don't mix them into one column

Someone will ask: if a skill is installed globally, can it still be governed? That question exposes one thing — the skill itself, the measurements of it, and the governance of it are three layers, each going its own way:

- **The skill itself = a global asset.** The kind installed under `~/.claude/skills`; the machine knows it globally. This layer doesn't move.
- **Measurement results (`reports` / `observe-health` / `doctors` / `graphs`) = tied to the sample set.** Same skill, different cases, different score — so reports and their sidecars travel with the project.
- **Governance archive (`managed`, recording "why this skill was cleared to ship") = travels with where the skill is installed**, not with the measurement. Globally-installed skill → governance archive global; project-vendored → project.

**How they connect**: the governance archive doesn't store the report's file path — it copies the fields it needs (the report `id`, content fingerprint, conclusion) straight in (the technical name is denormalize). So even with a project-local report and a global governance archive, the ship gate still works and moving the report doesn't matter. To give a global skill a "global score": pick a standard set of cases representing common usage (a golden set), run `omk eval --global` against it specifically, and write global — far more honest than pouring each project's unrelated cases into one bucket and pretending it's a global score. `--global` is a proper first-class mode here, not cut.

## 5. Living in the project folder ≠ committed to git

Worried that `.omk/` inside the repo dirties git? It doesn't. It behaves like `node_modules` / `.pytest_cache` / `mlruns` — lives in your project folder but stays out of version control by default. Three ways to store:

- **Global bucket** (e.g. promptfoo): doesn't dirty the repo, but you can't tell which file belongs to which project.
- **Project folder + gitignored by default** (MLflow `./mlruns`, Inspect `./logs`, HELM `benchmark_output`): keeps attribution, stays out of PR / diff. **This layout takes this one.**
- **Project folder + deliberately committed** (DVC): commit only a small bit of metadata when sharing.

Inside `.omk/` there are two kinds:

- The ever-growing `reports` / `observe-health` / `doctors` / `observe-inbox` / `graphs` → gitignored, not committed.
- The small but important governance decisions `managed` → committable, like a CHANGELOG / ADR, so a teammate who clones sees "why this version was cleared back then".
- Sample sets / `eval.yaml` → committed.

`omk init` auto-writes a `.omk/.gitignore` (ignoring the growing dirs, allowing `managed` and config), like `dvc init`, so you won't commit it by accident. Whole team wants the full reports? Go through `--global` / a shared server / an exported evidence bundle — the same pattern as MLflow's "don't commit locally, stand up a server to share".

## 6. Reports go home to their own projects, yet studio still sees the whole machine at a glance

With reports defaulting into their own projects, there's a tension: can `omk studio` still be a "whole-machine overview panel" that shows every project's artifacts at once?

**Yes.** The key is one sentence: **"can't compare scores across sample sets" governs *comparison*, not *viewing together*.** Listing different projects' reports on one page to browse is fine; only pulling the scores out to rank them requires locking to one sample set. So a cross-project browse list is legitimate, while the comparison layer still locks scope and still warns on incomparability.

The implementation isn't "move reports back to the global bucket" (that re-welds section 1's ownership problem) but adds a very light **index card** layer:

- The report **body always exists in exactly one copy**, staying in its project.
- Each artifact leaves a **small card** at the global `state/artifact-index/<domain>/<id>.json`: it records only the summary (`meta` + rollup), not the per-item detail, and the card says where the body is (`path` points at it). Three `domain`s: `report` / `doctor` / `observe-health`.
- `omk studio` stitches together "other projects' cards" and "what it live-scans from the current project + global", deduped by `id` (live-scan overrides cards). Click into detail and it follows the card's `path` to read the body; if the project moved the body away, it degrades to the card summary instead of crashing the page.

A few points:

- **No backfill**: the current project and global stay fresh via live-scan; cards only cover the "other projects" slice live-scan can't reach.
- **Global writes leave no card**: global is a single directory everyone live-scans, so a card there would just duplicate. A card's only value is another project's local directory.
- **Writing a card is best-effort**: it never errors and never blocks the body landing on disk (the body is the real thing; lose a card and a re-run regenerates it) — which is why cards live in the rebuildable `state/`.
- **Cards are live pointers**: a "dangling card" whose body was deleted is filtered out of lists/merges (the card cache folds in the body's existence as part of its fingerprint, so a long-open studio won't show deleted ones); deleting one in studio deletes the card too, and another project's body is untouched.
- **Escape hatches don't mix in cards**: `--global` and an explicit `--reports-dir` / `--doctors-dir` / `--analyses-dir` look only at the one directory you named, no cards merged — clean.
- **`observe-inbox` is deliberately not indexed**: the `domain`s are only `report` / `doctor` / `observe-health`, not `observe-inbox`. The discovery index serves *comparable review artifacts* (conclusions you'd browse and compare across projects); the inbox is the current project's triage workbench, and browsing project B's to-do queue inside project A's studio is low-value and easy to act on by mistake. So the summary (observe-health) is indexed while the raw queue (observe-inbox) is not — an intentional boundary; it still supports `--global` write / read, it just isn't aggregated machine-wide.

Separately, `id`s get a uniform random suffix to prevent name collisions (two projects producing artifacts in the same second could collide, and dedup would wrongly merge them and silently lose data): report uses "second + random", doctor uses "second + counter + random", observe-health filenames carry a random segment. An `id` is just a label, not a computed score, so this change **does not affect cross-version comparability**.

## 7. What gets auto-cleaned vs kept forever

Split by "can it rebuild itself if deleted":

- **Already auto-cleaning (scratch)**: `doctor` keeps the latest 50 per skill; `cache` caps at 2000; `trees` / `isolated-cwd` cap at 200 (with a lock protecting the in-use process). All three are env-tunable.
- **Deliberately not cleaned (data)**: `reports` / `observe-health` / `observe-inbox` are never background-deleted. Two reasons: (1) `reports` is referenced by `id` from governance archives and task records, so auto-deleting breaks links; (2) a report's entire value is "compare history against the new version", so auto-deleting quietly destroys the basis for comparison. They're just a few JSON files anyway.
- **No cap yet**: `jobs` (studio async task records) are a few KB each and carry an `id` pointing at a report, landing in the "don't randomly delete anything that references a report" rule — so they're not auto-cleaned either. `backups` (pre-fix skill originals saved on every `doctor --fix`) is likewise uncapped — it's the undo safety net, so deleting it early loses the ability to roll back; not auto-cleaned, add a lenient cap if it ever bloats.

## 8. This isn't made up — the industry does it this way

| Convention | Who does it | Maps to this spec |
|---|---|---|
| Project-local first, global fallback | git (`.git/` + `~/.gitconfig`), cargo (`target/`), pytest (`.pytest_cache`), terraform | Question 2: project-bound travels with the project |
| Data / state / cache layering | XDG Base Directory Spec | Question 1: real data vs `state/` scratch |
| Source separated from build output | Bazel (`bazel-out`), Cargo (`target/`), Make | Question 1: scratch is "obviously deletable" and physically isolated from data |
| Experiments grouped by project / experiment | MLflow `./mlruns`, W&B, DVC, Inspect `./logs`, HELM | Question 2 construct validity: a report is comparable only within its own context |
| Identity by content fingerprint | git (content-addressed), Nix (store path = hash) | The cross-cutting rule: identity is `id + fingerprint`, moving doesn't break references |

The one reality friendly to "keep a global default" is that plenty of tools do keep a global cache / registry (cargo `~/.cargo`, npm cache). But what they put global is **rebuildable and shareable by any project** (caches, dependency packages), not a context-bound "measurement conclusion" — which lands exactly in the "rebuildable and shareable → global" cell, consistent with this spec.

## 9. A few key decisions

- **Measurement artifacts default to the project** (reports / observe-health / doctors / graphs default to `.omk/`, `--global` deliberately writes global for the primary writer and sidecars inherit that root). Rationale: consistency with omk's project model (the sample set *is* the context); making "put it in the right place" the default behavior rather than an easily-forgotten convention.
- **reports reads via an overlay** (check the project first, fall back to global; lists merge both, project first), not "pick one directory". Because reports is fetched by `id` (resume, gold comparison, batch sub-reports all rely on it), and "pick one directory" would fail to fetch when the target `id` is in the other directory, breaking reuse.
- **studio is the machine-wide overview** (index cards aggregated), not "default to current project only". Because "can't compare" governs comparison, not viewing (section 6).
- **Project-level keeps a global fallback** (read global when `.omk/x` is absent), not pure project-level. Same as `observe-inbox`; smoother migration.
- **`managed` travels with where the skill is installed**, not with measurement. The three layers decouple: measurement binds to the sample set, governance to the skill, joined by content fingerprint in between.

The whole layout **does not affect cross-version comparability**: it only changed where things default, moved some locations, and added an index layer — touching neither the report format, the judge prompt, the observe-review prompt, nor any computed number.

## Related

- [who-omk-is-for](../explanation/who-omk-is-for.md) — "can't compare across sample sets" and "who omk is for", the upstream basis for this ownership design.
- [terminology-spec](terminology-spec.md) — the naming archive for `artifact` / `kind` / `domain` and friends.
- [evidence-gated-management](evidence-gated-management.md) — the `managed` governance archive and the "report id + content fingerprint" evidence reference mechanism.
