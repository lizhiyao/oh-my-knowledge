# Contributing
This page is the full contributor guide. GitHub shows the repository's root [`CONTRIBUTING.md`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/CONTRIBUTING.md) when you open a pull request; that file is a pointer to this page, not a second copy of the rules.

Thanks for taking the time to contribute to `oh-my-knowledge`.

## Branch model — GitHub Flow

One long-lived branch:

- **`main`** — the single integration and release branch. All production-ready work lands here through PRs. Do not commit directly to `main`.

All work happens on short-lived topic branches cut from `main`:

| Branch prefix | Cut from | Merges back to | Purpose |
|---|---|---|---|
| `feat/<desc>` | `main` | `main` | new feature |
| `fix/<desc>` | `main` | `main` | bug fix, including urgent production fixes |
| `docs/<desc>` | `main` | `main` | docs only |
| `chore/<desc>` | `main` | `main` | build, tooling, dependency bumps, release version bumps |

The prefix is the Conventional Commits type of the change the branch mainly carries; `refactor/`, `test/`, `perf/` and `ci/` follow the same shape. Never take the prefix from the tool or the person doing the work.

Delete the topic branch after its PR is merged.

## Typical workflow

### Prerequisites

This repo uses **Yarn 4** (Berry), pinned via the `packageManager` field and driven by [Corepack](https://nodejs.org/api/corepack.html). Node ships Corepack but leaves it disabled, so enable it once:

```bash
corepack enable    # makes `yarn` in this repo resolve to the pinned Yarn 4
```

Node ≥ 22 is required (`engines`). After that, the `yarn` commands below Just Work — Corepack downloads the pinned Yarn version on first use.

### Everyday feature / fix

```bash
# sync main first

git checkout main
git pull --ff-only

# cut a topic branch from main

git checkout -b feat/my-feature

# Batch the intended changes, then validate based on risk level.

yarn install
# Review the complete diff and risk-specific evidence first.

# See CODE_REVIEW.md.


# Choose one of the two by risk level: the chosen layer satisfies the local gate.

# For ordinary local changes: targeted validation

yarn ci:quick <相关测试文件>

# For cross-module, dependency, build/packaging, or CI gate changes: full local gate

yarn ci

git commit -m "feat(cli): 中文 subject"
git push -u origin feat/my-feature

# open a PR against **main**

```

Validation triggers, evidence reuse, and exceptions are defined once in
[`AGENTS.md`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/AGENTS.md#开发反馈与验证). The commands below implement that policy;
follow-up fixes do not automatically require another full local gate.

### Local validation strategy

| Scenario | Strategy | Command |
|----------|----------|---------|
| Ordinary local changes | Targeted validation | `yarn ci:quick <test files>` |
| Tests depend on build artifacts | Update build first, then test | `yarn build:runtime && yarn test <test files>` |
| Cross-module, dependency, build/packaging, CI gate changes | Full local gate | `yarn ci` |
| PR merge | Remote gate passes + autonomous CR | See CI checks |

## Code review and definition of done

Every behavior, contract, packaging, documentation-promise, or repository-policy
change receives a risk-proportionate self-review before its first push or handoff.
Do not wait for a maintainer to ask whether CR happened. Follow
[`CODE_REVIEW.md`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/CODE_REVIEW.md) for the risk levels, review dimensions,
finding format, validation ladder, and stopping rules.

A green test suite alone does not establish completion. Use `CODE_REVIEW.md`
for risk-specific evidence and finding resolution, and `AGENTS.md` for when to
run the full gate or clean-room checks; do not independently expand those rules.

The pull request description records user impact, the migration or compatibility
decision, measurement caveats, the autonomous CR conclusion, real validation
evidence, and any accepted residual risk. Keep code-level change lists in the
diff rather than duplicating them in the description.

### Releasing a new version

npm publishing uses GitHub Actions OIDC Trusted Publishing; no long-lived npm token is
stored. The first time it is enabled, configure the `oh-my-knowledge` npm package settings:

- provider: GitHub Actions
- repository: `lizhiyao/oh-my-knowledge`
- workflow: `publish.yml` (file name only)
- environment: leave empty
- allowed action: `npm publish` only

`.github/workflows/publish.yml` pins a GitHub-hosted runner, Node 24 and npm >= 11.5.1.
`id-token: write` lets npm exchange OIDC for a short-lived publishing credential, and npm
generates provenance itself; do not reintroduce `NPM_TOKEN`, `NODE_AUTH_TOKEN` or an
explicit `--provenance`.

```bash
# cut a release version-bump branch from main

git checkout main
git pull --ff-only
# Replace X.Y.Z with the intended version, including any prerelease suffix.

release_version=X.Y.Z
git checkout -b "chore/release-${release_version}"

# bump version in package.json, final polish commits, then verify

yarn ci

# commit and open a PR against main

git commit -m "chore(release): 发布 ${release_version}"
git push -u origin "chore/release-${release_version}"

# after the PR is merged, tag the merge commit on main

git checkout main
git pull --ff-only
git tag -a "v${release_version}" -m "Release ${release_version}"

# Push the release tag separately to trigger publish.yml.

git push origin "v${release_version}"
```

Prerelease versions publish to the `next` dist-tag; stable versions publish to
`latest`. The workflow derives this from the package version. Trusted Publishing
is the current release path; do not restore token-based fallback publishing.
The CLI update notifier follows the installed version’s channel: prereleases
check `next`, stable releases check `latest`, with separate rebuildable caches.

### Hotfix against a released version

Create a short `fix/` branch from `main`, make the fix and version bump, and use
the same validation and PR flow. After merge, follow the annotated-tag release
steps above for the intended patch version.

## Release notes

Release notes are auto-generated by GitHub from merged PRs (no separate `CHANGELOG.md` to maintain). For BREAKING / migration callouts to surface clearly, prefix the PR title with the relevant tag — e.g. `feat(judge)!: BREAKING-COMPARABILITY ...` — and put migration steps in the PR description. The `softprops/action-gh-release` step in `.github/workflows/publish.yml` runs with `generate_release_notes: true` and produces the GitHub Release body from the PR list between tags.

After publish.yml finishes, **review the auto-generated GitHub Release notes** at `https://github.com/lizhiyao/oh-my-knowledge/releases/tag/vX.Y.Z`. The auto-gen lists PR titles only — if any included PR was tagged `BREAKING-*`, the migration steps from that PR's description need to be hoisted into the release notes by hand:

```bash
gh release edit vX.Y.Z --notes "$(cat <<'EOF'
## ⚠️ Breaking changes

<consolidated migration guide pulled from BREAKING-* PR descriptions>

---

<paste the auto-generated body below>
EOF
)"
```

This keeps users who only read release notes (not individual PR descriptions) from missing the migration path.

## Commit messages

Use Conventional Commits with a stable scope and a Chinese subject:

```
feat(cli): 新增工作流命令
fix(eval-core): 修复事实检查误报
docs(readme): 补充评测用例说明
```

## Tests

### Fast development feedback

```bash
# Each edit: select the affected logic and its direct callers.

yarn test test/scripts/test-profile.test.ts
# Checkpoint: lint + typecheck + explicitly selected tests, without a build.

yarn ci:quick test/scripts/test-profile.test.ts test/scripts/ci-quick.test.ts
# Final changes before the first push, high-risk tier: the complete gate.

# Ordinary local changes stop at the checkpoint line above; see AGENTS.md.

yarn ci
```

`yarn test` forwards Vitest arguments through the hermetic wrapper, which fails
if tests mutate repository-owned content. Use that entry point for targeted
runs too. The default is capped at two workers because CLI and package tests
spawn additional processes; a higher worker count can cause SIGKILL under memory
pressure. Explicit Vitest flags remain available for controlled experiments.
`ci:quick` requires existing `.test.ts` / `.test.tsx` files under `test/`;
no arguments, directories, missing files, or Vitest flags exit with code 2 before
checks run. It does not infer affected tests or build artifacts. Every failed
stage stops the command; passing it does not imply full CI coverage.

### Build only what the selected test consumes

| Test boundary / task | Preparation after relevant input changes |
|---|---|
| Imports source directly; no production assets | No build |
| Compiled CLI, package modules, schemas or runtime assets | `yarn build:runtime` |
| Source Next server / React production routes | `yarn build:studio:app` |
| Compiled Studio / distributed package / complete suite | `yarn build` |
| Regenerate CLI documentation | `yarn build:runtime` then `yarn build:docs` |

`build:runtime` compiles source and scripts, checks schemas and copies runtime
assets; it excludes Next. `build` adds Studio compilation and packaging. Changes
to modules imported by Next pages also invalidate the Studio build, even when
no React file changed. A pre-existing `dist` or `.next/BUILD_ID` only proves an
artifact exists, not that it matches current source. Refresh the relevant build
after source, dependency or build-config changes. Removed or renamed emitted
files may require `yarn clean` before rebuilding. Preserve incremental caches
between unchanged checks; use clean builds when the tested boundary requires it.

Keep the writable per-checkout state local to that checkout: incremental build
info, type-check state and lint caches decide work from that tree's file
signatures rather than from whether its output files already exist. A second
checkout that borrows them can finish `tsc -p tsconfig.build.json` with
exit code 0 while emitting almost no output; in a recorded run (PR #1028) it
wrote 22 JavaScript files, where the same tree with a private cache emitted 732.
That observation covers build artifacts only — the file added for the experiment was
still type-checked, so it is not a guarantee that sharing never affects
coverage. The read-only package download cache is a different thing: this
repository uses Yarn's global cache, which lives outside every checkout and
stays shared by default. Linking dependency directories per entry is acceptable
only while dependency versions and install configuration match and the shared
target is not modified concurrently; otherwise install inside the checkout.

- `yarn test` runs the full vitest suite
- `yarn test:profile` runs the full suite once and lists the slowest test files. Use it to locate optimization targets; it is not a performance baseline or CI gate. Pass `--top <n>` to control the list length.
- `yarn typecheck` runs two tsc programs: the root program (Node16, `--jsx` off) covers `.ts` under `src` / `test` / `scripts`; `tsconfig.studio-web.json` extends `src/studio/web/tsconfig.json` and covers the whole Studio web subtree plus `test/studio/web` cases, treating `.ts` and `.tsx` alike. `test/architecture/test-gate-coverage.test.ts` owns the assignment, so a new file never has to guess from its name who checks it.
- Add tests for behaviour you change; a regression test for bug fixes is strongly preferred
- CI classifies the complete event diff on PRs and `main` pushes. The root rule files and the module maintenance docs (`src/<area>/README.md`) listed in `scripts/ci/scope.mjs` use governance tests and whitespace checks. Ordinary `docs/**/*.md` and root README changes additionally run runtime/document-contract checks and the documentation build, without Studio or the full test matrix.
- Source, dependencies, CI/build/site configuration, skills, prompts, generated documentation and unknown paths run the full gate: quality, the four Node 24 shards, and the macOS risk-boundary subset on `macos-latest`. The Node 22 shards stay reserved for non-PR events (`main` pushes, releases, manual dispatch) and PRs labelled `dependencies`, because issue #932 measured roughly 40 runs with no Node 22/24 difference in test outcome. Missing history, empty diffs or classification errors select the full gate. Renames include both old and new paths; mixed changes use the strongest gate.
- Required checks remain `test (22)` and `test (24)`. They require the selected gate to succeed; a failed, cancelled or unexpectedly skipped gate cannot pass. Branch protection and the requirement to stay current with `main` are unchanged.
- Assign test contracts by layer: domain unit tests cover the full branch matrix, command integration tests cover the wiring from arguments to the domain plus the output envelope, and a real `node dist/cli/index.js` covers only process boundaries — dispatcher, startup, exit codes, cwd at module load, packaged assets.
- Command behaviour tests use `test/helpers/run-command.ts` to run the full Oclif lifecycle of a source Command; do not start Node per case. Use a real child process only when the behaviour under test depends on the dispatcher, the environment at module load, or a separate `process`, and go through `runCli` (expects exit 0) / `runCliFailing` (expects a non-zero code, required) from `test/helpers/cli-process.ts` instead of hand-rolling `promisify(execFile)` in the test file; state that boundary in a test comment.
- Pin shared Oclif behaviour (the uniform exit code for an unknown flag, for example) once on a representative command; individual commands add only their own flag validation, copy or historical regression rather than restating the framework contract.

## CLI maintenance

The CLI uses [@oclif/core](https://oclif.io/docs/). Commands extend `BaseCommand` and parse arguments once through `await this.parse(Command)`; never parse again or pass raw argv through.

| Directory | Responsibility |
|---|---|
| `src/cli/commands/` | command, argument and help declarations, plus the product entrypoint wiring |
| `src/cli/lib/` | CLI configuration, interaction, presentation and cross-command helpers |
| `src/cli/oclif/` | `BaseCommand`, help, language selection, argument parsers and the dispatcher |

The evaluation entrypoint calls the Workflow product interface; other commands call the domain they belong to. The CLI never defines scoring, orchestration or storage semantics itself. Simple interaction may stay in `run()`, while cross-domain behaviour belongs back in the domain module.

### Adding or changing a command

1. Place the file according to its route under `src/cli/commands/`: `eval/index.ts` is `omk eval`, `eval/gold/compare.ts` is `omk eval gold compare`.
2. Extend `BaseCommand` and declare `static args / flags / examples / description`. Help copy uses `bilingual({zh, en})`.
3. Call `await this.parse(Command)` in `run()` and read the language from `this.lang`. Behaviour that may throw `CliExit` runs inside `this.runWithCliExit(async () => { ... })`, where the shared error boundary maps it to an exit code.
4. Verify the wiring from arguments to the domain with `test/helpers/run-command.ts`. Only dispatcher, startup or separate-process behaviour needs a real `node dist/cli/index.js` test.
5. After changing command declarations run `yarn build:runtime && yarn build:docs`. Validate the final change set against the repository gate before committing.

`eval/gold/index.ts` is an explicit topic command: a bare `omk eval gold` prints help and exits `1` so scripts can detect the missing subcommand. A new topic that wants this behaviour implements the contract explicitly.

### Language and help boundary

`BaseCommand.lang` uses `resolveLang(process.argv)`, which selects the language from `--lang` / `OMK_LANG`. Do not substitute `flags.lang` for the shared resolution.

`oclif/i18n.ts` provides `bilingual` and language selection for the static help; `lib/i18n.ts` provides the runtime message dictionary. They serve different boundaries, so copy is never maintained in two places.

oclif Help renders through EJS, so user input must never be concatenated into description / flag / arg help. `<%...%>` templates belong only in the controlled `examples[].command`; `bilingual` rejects template markers in help copy.

### Generated documentation

The command description / flags / args / examples and `CLI_EVALUATION_INPUT_REGISTRY` are the single source for the generated content. `scripts/build/docs.ts` maintains five targets:

| Target | Generated content |
|---|---|
| `.agents/skills/omk/references/commands.md` | the full Chinese command reference |
| `docs/reference/cli.md` | English CLI flag sections |
| `docs/zh/reference/cli.md` | Chinese CLI flag sections |
| `docs/specs/cli-evaluation-input-compilation.md` | English input registry table |
| `docs/zh/specs/cli-evaluation-input-compilation.md` | Chinese input registry table |

Run `yarn build:runtime && yarn build:docs` to sync the generated sections; `build:docs:check` and the tests block drift. Prose outside the markers stays hand-maintained.

When adding a top-level command, add the matching `<!-- omk:cli:<id>:flags:start -->` / `<!-- omk:cli:<id>:flags:end -->` markers to both CLI references and update the official `SKILL.md` `argument-hint`. The top-level command set derives from the oclif configuration instead of a hand-written list; subcommands enter the full command reference automatically. Skill prose never copies the generated reference.

### Exit codes

| Code | Situation |
|---|---|
| `0` | completed normally |
| `1` | business failure, a gate rejecting the run, an unknown command, or a topic that requires a subcommand invoked on its own |
| `2` | argument validation failed: unknown flag, missing required arg, or a type error |

The framework error mapping is declared in `oclif.exitCodes` in `package.json`. Commands must not duplicate argument-error handling or change the public exit codes.

## Style

- TypeScript strict; `yarn lint` must be clean
- No unnecessary abstractions; no code for hypothetical future needs
- Keep comments minimal — explain the *why*, not the *what*

## Docs layout

`docs/` is organized by audience — pick the right bucket before creating a new file:

- `docs/reference/` — flag tables, sample format, executor matrix, comparison ↔ what users look up
- `docs/explanation/` — architecture, statistical rigor ↔ how / why omk works
- `docs/specs/` — design specs read by contributors (sample design, gap signal, RAG metrics, terminology, ...)
- `docs/quickstart-skill-eval.md` + `docs/README.md` stay at the top level; `docs/zh/` mirrors the same structure
- `docs/README.md` + `docs/zh/README.md` are the audience-grouped indexes — add new files to the matching section
- **EN/ZH symmetry is required.** Every published page has both an English version under `docs/` and a Chinese version at the same path under `docs/zh/` — the VitePress language switcher relies on this 1:1 mirror, and a strict dead-link build fails otherwise. When adding a doc, add both halves. Prefer putting design rationale and decision records *inside* the relevant published spec (e.g. as an appendix) so users see the full reasoning — keep notes outside `docs/` only when they are genuinely maintainer-only, where they stay exempt from the bilingual rule

## Scope

`oh-my-knowledge` focuses on **offline knowledge-artifact evaluation** and **skill-level production observability**. It deliberately does **not** cover:

- General APM / request-level latency and cost tracing (use Langfuse / Datadog)
- Streaming evaluation / real-time alerting
- Production scoring (no control group = no score)

PRs expanding into those areas will usually be declined. If you're unsure whether your idea fits, open a GitHub Discussion or issue first.

## Security

See the [Security notice](https://github.com/lizhiyao/oh-my-knowledge/blob/main/README.md#security-notice) in the README for risks around custom assertions and the local report server.

## Release reliability and diagnosis

CD waits up to ten minutes for a successful **full** CI run on the exact tag
commit. Evidence must come from this repository's `ci.yml`, from a `main` push
or an explicit CI dispatch, with quality and every Node 22/24 shard successful.
A PR check, ancestor commit, skipped matrix or older success behind a newer
failed run cannot substitute. If the tag commit only has lightweight CI, dispatch
`CI` manually on that same tag, let it finish, and rerun release verification;
do not move/recreate the release tag. CI dispatch always selects the full gate.

Verification has read-only permissions. It builds once, packs with lifecycle
scripts disabled, installs that tarball into an isolated temporary directory,
and checks the CLI, module imports and packaged assets. The immutable artifact
contains the tarball, SHA-512 integrity, commit/version identity, installation
result and CI run/attempt reference. The OIDC publishing job downloads that
artifact and validates its identity and digest again, then publishes the tarball
with `--ignore-scripts`. It does not reinstall dependencies or rebuild the package.
Local `prepublishOnly` remains intact for manual folder publication.

Publication is serialized without cancelling an active upload. A registry
version with the exact same package integrity is treated as already uploaded;
a different or missing integrity fails closed. Tests, installs, builds and npm
publication are never automatically retried. Only read-only GitHub/registry GETs
retry transient timeouts, selected network failures, HTTP 408/429/5xx (at most
three attempts). An uncertain upload requires inspecting the registry and
rerunning the failed publish job with the original artifact. Rerunning all jobs
can rebuild different bytes and is not a substitute for reusing that artifact.

CI/CD bounded commands preserve logs, periodic memory/process samples and a
structured outcome: success, command failure, process timeout, evidence-backed
OOM, cancellation, execution failure, explicit network failure or an unexplained signal. `scripts/ci/diagnostics.mjs report`
aggregates counts into `summary.json` and the Actions job summary. Diagnostic
artifacts include the run, attempt and job identity and are retained for 14 days;
use these categories when comparing failure frequency. SIGKILL alone is not OOM,
and runner loss or a job-level kill may prevent final records/upload: missing
evidence remains unknown. The process deadline precedes the job deadline so
normal hangs leave time for termination, classification and artifact upload.
