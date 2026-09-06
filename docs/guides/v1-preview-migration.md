# Migrate from 0.54 to the 1.0 preview

`1.0.0-beta.0` is the first public preview of OMK's new Evaluation Core architecture. It is published under npm's `next` tag, while `latest` remains on `0.54.0` during the preview.

```bash
npm install --global oh-my-knowledge@next
omk --version
```

Use a disposable project or back up both the project `.omk/` directory and `~/.oh-my-knowledge/` before trying the preview. To return to the stable channel, run `npm install --global oh-my-knowledge@latest`.

This is a beta, not a frozen 1.0 contract. One important limitation remains: `omk eval gold init` creates a generic annotation scaffold but cannot yet seed it from a real Core run, so Gold authoring still requires manual sample-ID alignment. An explicit Gold comparison reports Krippendorff alpha, but that post-hoc result does not automatically gate the run's release verdict. [Issue #283](https://github.com/lizhiyao/oh-my-knowledge/issues/283) tracks the guided Gold on-ramp and calibration-decision closure required before an RC.

## 1. Start a new evidence history

The preview uses the domain-oriented storage v2 layout. It does not read, move, delete, or convert the earlier layout. Existing data remains on disk but is invisible to the new readers.

- New project records live under `.omk/eval/`, `.omk/doctor/`, `.omk/observe/`, `.omk/governance/`, `.omk/backups/`, and `.omk/state/`.
- Machine-level data uses the same domains under `~/.oh-my-knowledge/`.
- Evaluation runs are authenticated Core bundles addressed by `runId`; their canonical report is `report.json`.
- Reports created by 0.54 cannot be resumed, opened in the new Studio, compared with Gold, or used by `omk evolve`. Keep 0.54 installed separately if you need to inspect them.
- Observation inbox containers still use schema v2, but their embedded `observe-experience` report must use schema v3. Experience v2 reports are no longer converted; inbox readers skip the containing file without modifying it. Re-ingest the original trace with `omk observe ingest <trace-dir>` to create a current report.
- Managed records use schema v3. Reinstall an artifact and run a new evaluation to establish current evidence.

Do not copy scores from an old report into the new layout. Re-run the evaluation so the sealed plan, lineage, Runtime identity, and decision evidence are produced together. See the [Evaluation Core cutover](./eval-core-cutover.md) and [storage layout v2](../specs/storage-layout-spec.md) for the full boundary.

## 2. Create a new eval-samples document

The preview uses the strict `omk.eval-sample-set/v2` contract. Earlier sample documents are not read or converted. Generate a new document with `omk init` or `omk sample`, then review its criteria and weights before using it as evidence.

Each rubric is a map of independently judged dimensions. Every dimension contains one `criterion` and a positive `weight`; weights within a sample must sum to 1. Keep exactly one canonical `eval-samples.json` or `eval-samples.yaml` in each auto-discovery scope.

Validate the result before a paid run:

```bash
omk eval --dry-run --samples eval-samples.yaml \
  --control code-review-v1 --treatment code-review-v2
```

See the [eval sample format](../reference/eval-sample-format.md) and its published JSON Schema for the complete v2 contract.

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

Check the current [CLI reference](../reference/cli.md) rather than copying 0.54 flags into scripts.

## 5. Update embedded Node.js hosts

The published API is ESM-only on Node.js 22 or newer. Imports are restricted to the package export map; `oh-my-knowledge/dist/*` is private.

- Use `oh-my-knowledge` for the ordinary `evaluate()` and `checkExecutor()` façade. The explicit `oh-my-knowledge/eval-runtime` subpath is equivalent.
- Replace the fixed `{ executor, control, treatment, evaluator }` call with `{ variants, evaluators, comparisons }`. Bind each Executor, config, and runtime context under `variant.execution`; declare `experiment.sampling`; move Bootstrap settings to `analysis`; add `decision` only when one analysis result should produce a verdict. The preview does not read the removed shape.
- Move former package-root Core imports to `oh-my-knowledge/eval-core`; use that subpath for Engine construction, staged execution, admission, verification, comparability, Series, and Core JSON Schemas.
- Import `createEvaluationEngine` only from `oh-my-knowledge/eval-core`; the ambiguous narrowed re-export has been removed from `eval-runtime/advanced`. Use `runEvaluation` there for a standard complete run over preassembled inputs.
- Use `oh-my-knowledge/eval-samples`, `oh-my-knowledge/projections`, `oh-my-knowledge/studio`, `oh-my-knowledge/mcp`, or `oh-my-knowledge/dsh-plugin` for those explicit surfaces.
- Replace synchronous `require()` with ESM imports or dynamic `import()`.
- Engine Runtime assembly now uses binding resolvers that return the resolution and configured port together.
- Series Analysis and Decision Runtimes open run-scoped sessions with `openRun()` and `dispose()`; Series runs require a `runId` and return a terminal status union.

The [embedded API reference](../reference/embedded-api.md) is the canonical contract and includes a complete independent-host fixture.

## Measurement boundary

The migration preserves the frozen evaluator prompts, five scoring layers, comparison-family Bootstrap formula, Krippendorff alpha point formula, and length-debias toggle semantics. Agreement interval v2 intentionally adopts Krippendorff's fixed-expected-disagreement reliability bootstrap; v1 remains available only for exact replay. The migration does not preserve artifact schemas, storage paths, digests, Runtime identities, or the interpretation of unresolved external URLs. Compare only runs that the new Core marks compatible; do not splice old and new score histories manually.
