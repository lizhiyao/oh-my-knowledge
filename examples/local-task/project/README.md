# A multi-file task with an npm dependency

[简体中文](./README.zh.md)

The cart project imports the local npm package `@task/money` from `src/cart.mjs`. Its bug subtracts a discount after tax. Independent acceptance covers discount ordering, quantities, no discount, no tax, rounding and an empty cart. The verifier is excluded from the Agent snapshot.

## Run

Copy this directory into a temporary directory first:

```bash
cd /absolute/path/to/copied/project/snapshot
npm ci --offline --install-links --ignore-scripts --no-audit --no-fund
cd ..
omk eval task task.yaml --dry-run
omk eval task task.yaml --output /absolute/path/to/reports
```

The local dependency requires no registry, model or credentials. `--install-links` installs real files; default symbolic links are rejected by snapshot validation. The lockfile, application source and installed dependency files are explicitly listed in both snapshot and artifact scopes, so Agent execution and independent acceptance load the same versions. Do not snapshot all of `node_modules` or user configuration directories.

The default fixture verifies wiring only: control leaves files unchanged, treatment repairs them. For a real Agent, replace execution as described in the [parent example](../README.md#live-codex-run), fixing model and effort explicitly. Inspect unknown cost and trusted-local boundaries before running.

## Integration effort

Manual steps for an existing project are: establish independent acceptance requirements; write the verifier; choose two knowledge versions; fill file scopes and execution configuration in the task definition; install locked dependencies in the copied project; preview and run. This example contains one source module, one local dependency package, package/lock files and six independent checks.

The only custom integration code needed for the live path is the domain verifier. No custom executor, workspace, collection or cleanup code is required. The fixture is offline regression-test code, not a required user integration layer. Adding files still requires updating explicit snapshot/collection lists. Authors remain responsible for external dependency installation, licensing and provenance.

## Evidence boundary

This is a small project with actual npm installation and cross-file imports, not a production business repository or a third-party network dependency benchmark. It establishes feasibility at this scale, not general integration time or statistical significance.

## Measured run (2026-09-29)

Codex 0.154.0, `gpt-6-astra`, effort `low`, 300 seconds per variant, 1 sample × 2 knowledge variants × 1 trial. In run `run-48f0a89b-dd23-48f7-a0cb-43e56da63ac4`, execution and independent acceptance completed for both variants: control left all files unchanged, passed three of six checks, and failed task acceptance; treatment changed only `src/cart.mjs` and passed all six checks. The other four files and the original project were unchanged. Private credential copies and trial directories were cleaned up; both execution diagnostics and acceptance evidence were persisted.

| Measurement | control | treatment |
| --- | --- | --- |
| Input tokens (including cached) | 43,272 | 58,508 |
| Cached input tokens | 39,680 | 54,400 |
| Output tokens | 225 | 511 |
| Execution duration | 49.5 seconds | 128.9 seconds |

Total CLI duration was 179.4 seconds; the provider did not report a monetary cost. Durations include network reconnection, with tests running concurrently on the machine, and are not performance benchmarks. Integration required 30 lines of task configuration, 16 lines of acceptance code, and one line per knowledge file. Offline dependency installation took 300 milliseconds. Requirements analysis and authoring time were not measured; installation time is not total integration cost.

An earlier run, `run-eaad5832-1098-4cd4-9564-8e1c56a00057`, exposed a protocol parser rejecting Codex after successful recovery from a `request timed out` reconnect. Persisted raw streams and modified files enabled diagnosis. The corrected parser was verified with the new live run above; the earlier failed records were not rewritten as successes.

Result reference digest: `sha256:9a1347ea64a17b37476ca1ccfa089a725ce434b3d07d56a60ce600c14627099d`; snapshot digest: `sha256:0c682164b913a6937a2fc68abc92fdbad754270b6fdaa8457fcfa4b536537866`; acceptance digest: `sha256:cbdb0bee21c53c36a5bbc2c7670d9a8f62abd35caf1c625e49624af216e25ba7`. Raw run artifacts remain local; these digests correlate evidence and are not public download links.

Control explicitly requests no edits and is a negative control. This run establishes a working path through real editing, independent acceptance, and persistence. One paired sample cannot establish general knowledge effectiveness; Decision remains `not-decided`.
