# Migrate from 0.54 to the 1.0 preview

This guide covers upgrading from `0.54` or an earlier 1.0 Beta to the current preview on npm’s `next` tag. Beta iteration continues; these are the current migration boundaries, not an API freeze or an RC release plan.

```bash
npm install --global oh-my-knowledge@next
omk --version
```

Use a disposable project or back up both the project `.omk/` directory and `~/.oh-my-knowledge/` before trying the preview. To return to the stable channel, run `npm install --global oh-my-knowledge@latest`.

## Upgrade from Beta.13 to Beta.14

The library, artifact authoring, ongoing revision, and change review require **1.0.0-beta.14 or later**. The website's SDK screenshots come from a main-source acceptance run, not Beta.13. Check `omk --version` after installing, then follow the [knowledge maintenance workflow](../knowledge/extract-knowledge.md); local reading makes no model call.

This release includes `BREAKING-CLI`, `BREAKING-SCHEMA`, and `BREAKING-COMPARABILITY` changes merged after Beta.13:

1. **Back up** the explicitly selected knowledge directory, project `.omk/`, and machine `~/.oh-my-knowledge/`. The knowledge directory may be elsewhere; backing up only global state is insufficient.
2. **Remove retired commands and fields**: `list`, `promote`, `rollback`, `eval --no-evidence`, and `observe --feedback` / `--no-feedback`. Existing managed records are preserved but not read; see the final section of this guide.
3. **Do not treat old extraction output as the current structure**: Beta.14 entity history is v2 and extraction runs are v4. Old entity history v1, run v3, and other old formats are not read, resumed, or migrated. Old knowledge v2 content remains readable, but its old entity-analysis binding is unavailable. Choose a new empty knowledge directory, extract again from original logs, and review manually. Extraction calls a model; review transmission scope and runtime first. Original files remain, and new entities do not take over old knowledge bindings automatically. See the [entity extraction contracts](../../specs/entities/entity-extraction.md).
4. **Give new measurements a new identity**: Beta.14 extraction uses `knowledge-extraction-v14`. Prompt bytes, admission semantics, and run identities changed; historical reports and scores are not recomputed, and incompatible old and new results cannot form one comparison. Reproduce historical results with their frozen baseline. Existing quality reports do not establish overall quality for the new version.

The maintenance path supports sources, precise revisions, and retained history. It does not automatically prove dynamic SDK effects, time saved, or cross-agent reuse benefits.

**Gold limitation:** `omk eval gold init` still creates a generic scaffold; align real sample IDs manually. Gold comparison reports human/judge agreement and post-hoc reliability without changing an existing run’s release decision. See the CLI migration selectors below.

The Beta.14 identities above describe that published release. Current main has later extraction and review capabilities with different identities and storage boundaries; use the [capability tiers](../knowledge/extract-knowledge.md#availability) and [current generated contract](../../reference/shared/knowledge-contract.md) before following current-main commands. A main merge is not a release, and the historical instructions above do not supply a migration for later formats.

## 1. Start a new evidence history

The preview uses the domain-oriented storage v2 layout. It does not read, move, delete, or convert the earlier layout. Existing data remains on disk but is invisible to the new readers.

- New project records live under `.omk/eval/`, `.omk/doctor/`, `.omk/observe/`, `.omk/backups/`, and `.omk/state/`.
- Machine-level data uses the same domains under `~/.oh-my-knowledge/`.
- Evaluation runs are authenticated Core bundles addressed by `runId`; their canonical report is `report.json`.
- Reports created by 0.54 cannot be resumed, opened in the new Studio, compared with Gold, or used by `omk evolve`. Keep 0.54 installed separately if you need to inspect them.
- Observation inbox containers still use schema v2, but their embedded `observe-experience` report must use schema v3. Experience v2 reports are no longer converted; inbox readers skip the containing file without modifying it. Re-ingest the original trace with `omk observe ingest <trace-dir>` to create a current report.

Do not copy scores from an old report into the new layout. Re-run the evaluation so the sealed plan, lineage, Runtime identity, and decision evidence are produced together. See the [Core persistence contracts](../../specs/evaluation/evaluation-artifact-persistence.md) and [storage layout v2](../../specs/shared/storage-layout-spec.md) for the full boundary.

## 2. Create a new eval-samples document

The preview uses the strict `omk.eval-sample-set/v3` contract. Earlier sample documents are not read or converted. Generate a new document with `omk init` or `omk sample`, then review its criteria and weights before using it as evidence.

Each rubric is a map of independently judged dimensions. Every dimension contains one `criterion` and a positive `weight`; weights within a sample must sum to 1. Keep exactly one canonical `eval-samples.json` or `eval-samples.yaml` in each auto-discovery scope.

Validate the result before a paid run:

```bash
omk eval --dry-run --samples eval-samples.yaml \
  --control code-review-v1 --treatment code-review-v2
```

See the [eval sample format](../../reference/evaluation/eval-sample-format.md) and its published JSON Schema for the complete v2 contract.

## 3. Re-check external URL inputs

Real URLs in sample `prompt` or `context` are now resolved before execution, and the resolved bytes are sealed into the Evaluation Definition. Resolution fails closed instead of silently leaving the URL as literal text.

- Configure an MCP resolver for private or authenticated documents.
- HTTP resolution accepts constrained, textual UTF-8 content on standard protocol ports.
- `urlPatterns` entries are exact hostnames or `*.hostname` wildcards, not path or query substrings.
- Use RFC example domains when a URL is intentionally literal documentation text.

Runs that previously measured a real URL as literal text are not directly comparable with runs that measure its resolved content. Start a new comparison series after migration.

## 4. Update CLI automation

Remove `--no-cache` from commands and `noCache` from `eval.yaml`. Product evaluations already disable Execution and Evaluation caches; the removed options have no replacement. The existing `--resume` contract is unchanged. Old config fields are rejected with a removal hint.

- `omk init` still creates three low-cost starter cases. Use `omk init --samples 20` for the larger first-party starter set; review or replace it before treating it as release evidence.
- `omk init` no longer overwrites scaffold files unless `--force` is explicit.
- `omk eval --resume` accepts a Core `runId`, not a report path.
- `omk eval gold compare` accepts a Core `runId` and requires explicit `--target`, `--evaluator`, and `--metric` selectors. Pass an optional `--minimum-alpha` only when your domain has chosen a reliability threshold; the post-hoc assessment uses the confidence-interval lower bound and never changes the release verdict.
- `omk evolve` no longer accepts the former diagnostic, sample-repair, report-reuse, holdout, significance, or test-split switches. Candidate acceptance and source write-back are governed by the Core decision; run an independent release validation set outside the authoring loop.

Check the current [CLI reference](../../reference/cli.md) rather than copying 0.54 flags into scripts.

## 5. Update embedded Node.js hosts

The published API is ESM-only on Node.js 22 or newer. Imports are restricted to the package export map; `oh-my-knowledge/dist/*` is private.

- The `oh-my-knowledge/package.json` export is removed, with no replacement `version` export. Remove imports of this metadata; record dependency versions through your package manager or lockfile instead. `omk --version` remains available for CLI diagnostics.
- Use `oh-my-knowledge` for the ordinary `evaluate()` and `checkExecutor()` façade, Runtime assembly, builders, and lifecycle SPI.
- Replace the fixed `{ executor, control, treatment, evaluator }` call with `{ dataset, variants, evaluators, comparisons, analyses, experiment, policy }`. Bind execution and config under `variant.execution`, sampling under `experiment.sampling`, and statistical requests in `analyses[]`. An optional `decision` selects an analysis by `analysisId`. Pass run options such as `runId`, `signal`, and `onEvent` as the second argument; old shapes are not read.
- Move former package-root Core imports to `oh-my-knowledge/eval-core`; use that subpath for Engine construction, staged execution, admission, verification, comparability, Series, and Core JSON Schemas.
- Import `createEvaluationEngine` only from `oh-my-knowledge/eval-core`. Use `runEvaluation` from `oh-my-knowledge` for a standard complete run over preassembled inputs.
- Use `oh-my-knowledge/mcp` or `oh-my-knowledge/dsh-plugin` for those integration surfaces.
- Replace synchronous `require()` with ESM imports or dynamic `import()`.
- Engine Runtime assembly now uses binding resolvers that return the resolution and configured port together.
- Series Analysis and Decision Runtimes open run-scoped sessions with `openRun()` and `dispose()`; Series runs require a `runId` and return a terminal status union.

Use the [Runtime API reference](../../reference/integration/eval-runtime-api.md) for service integration and the [Core API reference](../../reference/integration/embedded-api.md) for advanced staged integration.

## Measurement boundary

The migration preserves the frozen evaluator prompts, five scoring layers, comparison-family Bootstrap formula, Krippendorff alpha point formula, and length-debias toggle semantics. Agreement interval v2 intentionally adopts Krippendorff's fixed-expected-disagreement reliability bootstrap; v1 remains available only for exact replay. The migration does not preserve artifact schemas, storage paths, digests, Runtime identities, or the interpretation of unresolved external URLs. Compare only runs that the new Core marks compatible; do not splice old and new score histories manually.

## Managed lifecycle removal (BREAKING-CLI)

The `list`, `promote`, and `rollback` commands, the `eval` option `--no-evidence`, and the `observe` options `--feedback` / `--no-feedback` have been removed without aliases or compatibility entry points. Remove these calls from scripts and use `doctor` and `eval` results and reports to decide subsequent actions. File restoration and deployment belong to your version-control and release workflows. `omk install` now only installs; it no longer registers a lifecycle. Studio managed-history pages and `/api/managed` have also been removed.

Existing files under `.omk/governance/managed/` or `OMK_HOME/governance/managed/` remain on disk untouched. The new version does not read, rewrite, migrate, or automatically delete them. Archive the original JSON yourself if needed; installed skills do not need reinstalling. Core evaluation artifacts, content identities, and measurement semantics are unchanged.

## Install command surface (BREAKING-CLI)

`omk install` installs only skills. Omit `--kind` or use `--kind skill`; `prompt`, `agent`, and `workflow` are rejected with exit code 2 before source resolution or any installation, including for the built-in `omk-agent-skill`.

Replace `--to all` with `--to codex`. The only target values are `auto` (the default, detects a Codex/AGENTS directory) and `codex` (installs there without prior detection). Comma-separated target lists are also rejected with exit code 2. Use `--dest <dir>` for a custom skill root. No alias for `all` or target lists is retained.

Previously installed skills and historical metadata remain untouched and do not need reinstalling. Explicit installation still follows the existing `--force`, `--dry-run`, and source/target overlap protections. This changes CLI validation, not artifact formats or measurement semantics.
