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
- Managed records use schema v3. Reinstall an artifact and run a new evaluation to establish current evidence.

Do not copy scores from an old report into the new layout. Re-run the evaluation so the sealed plan, lineage, Runtime identity, and decision evidence are produced together. See the [Evaluation Core cutover](./eval-core-cutover.md) and [storage layout v2](../specs/storage-layout-spec.md) for the full boundary.

## 2. Upgrade the eval-samples document

Every sample file must now be a strict, versioned document. Wrap a legacy top-level array as follows:

```json
{
  "schemaVersion": "omk.eval-sample-set/v1",
  "samples": [
    {
      "sample_id": "case-1",
      "prompt": "..."
    }
  ]
}
```

Then apply these changes:

- Rename project `eval-samples.yml` to `eval-samples.yaml`.
- Rename a directory skill's `.omk/samples.json` or `.omk/samples.yaml` to `.omk/eval-samples.json` or `.omk/eval-samples.yaml`.
- Keep exactly one canonical JSON or YAML file in each auto-discovery scope. Flat-skill sidecars and split directories are no longer auto-discovered; pass a custom file or split directory explicitly with `--samples`.
- Remove `expectedTools`. Express tool behavior with assertions and `allowedTools`.
- Remove unknown fields. The root, samples, assertions, mocks, and nested contracts are closed schemas.
- Treat omitted `mocksStrict` as `true`. Set it to `false` only when unmatched calls may intentionally reach the real Runtime.
- Give each mock exactly one of `return`, `return_file`, or `return_seq`.

Validate the result before a paid run:

```bash
omk eval --dry-run --samples eval-samples.yaml \
  --control code-review-v1 --treatment code-review-v2
```

See the [eval sample format](../reference/eval-sample-format.md) and its published JSON Schema for the complete contract.

## 3. Re-check external URL inputs

Real URLs in sample `prompt` or `context` are now resolved before execution, and the resolved bytes are sealed into the Evaluation Definition. Resolution fails closed instead of silently leaving the URL as literal text.

- Configure an MCP resolver for private or authenticated documents.
- HTTP resolution accepts constrained, textual UTF-8 content on standard protocol ports.
- `urlPatterns` entries are exact hostnames or `*.hostname` wildcards, not path or query substrings.
- Use RFC example domains when a URL is intentionally literal documentation text.

Runs that previously measured a real URL as literal text are not directly comparable with runs that measure its resolved content. Start a new comparison series after migration.

## 4. Update CLI automation

- `omk init` still creates three low-cost starter cases. Use `omk init --samples 20` for the larger first-party starter set; review or replace it before treating it as release evidence.
- `omk init` no longer overwrites scaffold files unless `--force` is explicit.
- `omk eval --resume` accepts a Core `runId`, not a report path.
- `omk eval gold compare` accepts a Core `runId` and requires explicit `--target`, `--evaluator`, and `--metric` selectors.
- `omk evolve` no longer accepts the former diagnostic, sample-repair, report-reuse, holdout, significance, or test-split switches. Candidate acceptance and source write-back are governed by the Core decision; run an independent release validation set outside the authoring loop.

Check the current [CLI reference](../reference/cli.md) rather than copying 0.54 flags into scripts.

## 5. Update embedded Node.js hosts

The published API is ESM-only on Node.js 22 or newer. Imports are restricted to the package export map; `oh-my-knowledge/dist/*` is private.

- Use `oh-my-knowledge` for the ordinary `evaluate()` and `checkExecutor()` façade. The explicit `oh-my-knowledge/eval-runtime` subpath is equivalent.
- Move former package-root Core imports to `oh-my-knowledge/eval-core`; use that subpath for Engine construction, staged execution, admission, verification, comparability, Series, and Core JSON Schemas.
- Import `createEvaluationEngine` only from `oh-my-knowledge/eval-core`; the ambiguous narrowed re-export has been removed from `eval-runtime/advanced`. Use `runEvaluation` there for a standard complete run over preassembled inputs.
- Use `oh-my-knowledge/eval-samples`, `oh-my-knowledge/projections`, `oh-my-knowledge/studio`, `oh-my-knowledge/mcp`, or `oh-my-knowledge/dsh-plugin` for those explicit surfaces.
- Replace synchronous `require()` with ESM imports or dynamic `import()`.
- Engine Runtime assembly now uses binding resolvers that return the resolution and configured port together.
- Series Analysis and Decision Runtimes open run-scoped sessions with `openRun()` and `dispose()`; Series runs require a `runId` and return a terminal status union.

The [embedded API reference](../reference/embedded-api.md) is the canonical contract and includes a complete independent-host fixture.

## Measurement boundary

The migration preserves the frozen evaluator prompts, five scoring layers, Bootstrap confidence interval formula, Krippendorff alpha formula, and length-debias toggle semantics. It does not preserve artifact schemas, storage paths, digests, Runtime identities, or the interpretation of unresolved external URLs. Compare only runs that the new Core marks compatible; do not splice old and new score histories manually.
