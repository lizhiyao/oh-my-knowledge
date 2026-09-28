# Reproducible local task acceptance

[中文](./README.zh.md)

This example fixes `absolute()` in an isolated copy of `snapshot/math.mjs`. The independent verifier checks negative numbers and regressions on positive numbers and zero. Node.js 22+ and an installed OMK are required. No dependencies, credentials or model calls are needed for the offline fixture.

```bash
omk eval task examples/local-task/task.yaml --dry-run
omk eval task examples/local-task/task.yaml --output /tmp/omk-task-reports
```

Run from the repository root, or pass the absolute path to a copied example. In a source checkout, build first with `yarn build:runtime` and replace `omk` with `node dist/cli/index.js`. Output goes only to the selected report directory and temporary directories; the source snapshot stays unchanged.

The offline executor deliberately makes three controlled outcomes. Control claims success without editing; treatment fixes the function. In a copy of `task.yaml`, set `variants.treatment: regression.md` to demonstrate a negative-number fix that breaks positive numbers. These cases test integration, not skill effectiveness. Every response says the bug is fixed; only the independently collected files determine acceptance.

## Live Codex run

Copy the example into a temporary directory and replace `execution` with:

```yaml
execution:
  runtimeKind: codex
  executable: /absolute/path/to/codex
  model: YOUR_EXPLICIT_MODEL
  effort: low
  timeoutMs: 120000
```

Use a native binary or an npm Node launcher. For a launcher, explicitly declare the Codex binary and other dependencies it loads in `execution.identityFiles` as `{facetId, path}` entries so the runtime identity covers indirect implementation files; OMK records Node automatically. The installed Codex CLI must support the same flags as OMK's Codex adapter. Run the preview before execution. The CLI uses the current Codex `auth.json` only to authenticate, copying it into an attempt-private home that is removed afterward; it does not copy global skills, rules or configuration. API-key-only setups and custom provider configurations are not supported by this first slice. Cost in USD is unknown (`null`), not zero; usage is retained when reported. A single sample produces two Agent calls. Provider-side model changes and external conditions remain uncontrolled.

## Authoring and evidence

The user prepares six inputs: a task YAML, snapshot source files, two knowledge files, an independent Node verifier, and its declared dependency files (none here). Real execution needs no custom executor or workspace code. The offline fixture is test-only integration code. Preview and run are the two CLI steps. The author must still write domain-specific acceptance checks and explicitly enumerate snapshot/collected files; OMK owns isolation, collection, invocation, cleanup and report persistence.

The task definition uses `omk.local-task/v1` and embeds existing sample v3. This first slice supports text inputs and annotations, and rejects unsupported execution/evaluation contexts instead of ignoring them. Verifier logic owns acceptance; expected answers and test programs are not sent to the Agent. `snapshot.files`, `artifacts.files`, and `acceptance.files` contain explicit relative paths, not globs. Symbolic links, traversal, special files and known credential paths are rejected. Do not include credentials in any declared file. The collection byte cap also bounds the initial snapshot; the verifier bundle is capped at 16 MiB. The only writable execution surface promised by this adapter is a fresh trial workspace; attempts in one trial share it. There is no implicit retry.

The verifier uses a private HOME and temporary directory and runs in a separate directory containing only collected artifacts, with its own copied program and declared dependencies. It reads an optional `{sampleId}` JSON message on stdin and writes one `omk.local-task-acceptance/v1` object to stdout; see `acceptance/verify.mjs`. Exit zero with `passed: false` means task rejection. Nonzero exit, invalid output, timeout, cancellation or missing artifacts means missing evidence with a distinct reason code, never a zero score or a pass. Task outputs, checks and their identities are retained in canonical Runtime artifacts. Snapshot and verifier bytes are also archived in the content store. Studio's existing evaluation report expands task file metadata and acceptance checks; original bytes and traces remain in stored artifacts.

Fatal run failures, such as workspace cleanup failure, archive the raw failure result and return its content reference without creating a normal Studio run row.

## Evidence boundary

This is trusted local execution, **not a hostile-code sandbox**. The verifier may import code produced by the Agent. Workspace copies and separate verifier directories do not prevent malicious same-user processes from accessing the host. Strong-isolation requirements are unsupported and must not be represented as `trusted-local`.

## Programmatic rescore

```js
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLocalTask } from 'oh-my-knowledge';

const temporaryRoot = await mkdtemp(join(tmpdir(), 'omk-task-'));
try {
  const task = await prepareLocalTask({
    definitionPath: '/absolute/path/task.yaml', temporaryRoot,
    outputDirectory: '/absolute/path/reports',
  });
  const first = await task.run();
  const revised = await task.rescore(first.result, {
    root: 'revised-acceptance', files: ['verify.mjs'],
    entrypoint: 'verify.mjs', timeoutMs: 10000,
  }, '/absolute/path');
  console.log(first.reference, revised.reference);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
```

Rescore accepts a canonical result retained in the same process and rejects insufficient collected artifacts. It creates a new scoring identity and a new immutable Runtime result reference; the original result remains unchanged. The existing run-directory store accepts a single run contract, so suffix results use Runtime's existing result store and do not appear as a second Studio run. Cross-process replay and Studio rescore controls are outside this slice. New verifier rules are explicitly post hoc, not preregistered confirmation. One sample, repeated trials and these public examples are not statistically powered release evidence or independent holdout data.

### Recorded live smoke run

On 2026-09-29 (Asia/Shanghai), Codex CLI 0.154.0, `gpt-6-astra`, low effort, one sample and one trial ran with a 120,000 ms execution limit on macOS arm64. Control completed, made no repair, and failed the negative-number check while preserving positive/zero behavior. Treatment exceeded the execution limit, so its acceptance was not evaluated. The report was inconclusive with unresolvable evidence; this is an observed limitation, not a successful live A/B comparison. Control reported 42,532 input and 149 output tokens; treatment usage and USD cost were unavailable. No run was retried automatically.

The source run was `run-381c102b-5024-49cd-b35b-ded118f1431d`; snapshot digest `sha256:f5311bed1e2b773820d4c2c69a09bebabfa004b165ec5361da382bcb6ec44f3c`, verifier digest `sha256:af09894f74c5d3cf5851d226ae0328944ca4ad60697b46e1713d3e67224d7e17`. Subsequent storage/projection fixes require their own checks; this smoke run establishes only the stated live execution behavior.
