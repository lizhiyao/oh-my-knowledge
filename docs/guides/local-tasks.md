# Verify local task outcomes

As checked on 2026-09-29, this entry is implemented on main but is not included in npm `@next` version `1.0.0-beta.12`. The following is a source preview, not installation guidance for that release.

## Preview from source

Install dependencies and run `yarn build` as described in the [contributor guide](./contributing), then run from the repository root:

```bash
node dist/cli/index.js eval task examples/local-task/task.yaml --dry-run
node dist/cli/index.js eval task examples/local-task/task.yaml --output /absolute/path/to/task-reports
```

This example defaults to an offline fixture and makes no model calls. It verifies wiring, not real agent performance. Before switching to Codex, inspect the model, credentials, file list, and cost boundaries in the runnable example below.

## Tasks and evidence

Use `omk eval task <definition> --dry-run` to inspect a trusted local task, then omit `--dry-run` to run control and treatment. A task combines existing sample v3 text input, an explicit file snapshot, two knowledge versions, a fixed executor configuration, a file collection list and an independent Node verifier. See the [runnable example and complete authoring contract](https://github.com/lizhiyao/oh-my-knowledge/tree/main/examples/local-task).

The CLI previews model, snapshot and verifier identities, write boundaries, file lists, timeouts and unknown USD cost. Fresh writable copies isolate each Target × Sample × Trial. Attempts within a trial share state; the first version does not add retries. Relative file paths are explicit, without globs or traversal. Known credential paths, symbolic links and special files are rejected; declared source files must not contain credentials.

Acceptance checks the collected files, never the Agent's assertion that work is complete. A valid negative result is a task failure; missing files, invalid verifier output, infrastructure errors, timeout, cancellation and cleanup failure have separate diagnostics. Missing evidence never becomes a passing result or zero score. Studio's existing report provides expandable file metadata and check results. Raw artifacts and execution traces remain in the persisted evidence.

The experiment measures the effect of explicitly provided knowledge content. It does not measure native skill installation or discovery. The fixed local snapshot, declared dependencies and captured runtime identity improve comparability; external provider conditions remain uncontrolled. Workspace copies are not a security sandbox: only trusted local tasks and verifiers are supported.

The example includes correct repair, a claimed repair without changes, and repair with a regression. It records the manual inputs and remaining verifier code. The offline fixture proves integration only; small live runs, repeated trials and public examples are not release evidence or independent holdout data.

`prepareLocalTask()` exposes the same application to Node callers. Its `rescore()` method reuses sufficient execution evidence from a canonical result retained in the same process, seals a new verifier identity and stores a new Runtime result reference. It preserves the original result and marks the change as post hoc. Missing artifacts cause rejection. The first version does not offer cross-process result import or Studio rescore interaction; see the example for the copyable API flow and storage limits.

Every started execution retains declared files and bounded stdout/stderr before cleanup; verifier infrastructure failures also retain diagnostics. CLI `diagnosticsDirectory` and `diagnosticReferences` connect private content storage with run identity, and report annotations retain the same directory. Diagnostics do not reclassify failed execution as success. The cart project within the example covers multi-file integration, local npm dependency installation, six independent checks and operational effort.
