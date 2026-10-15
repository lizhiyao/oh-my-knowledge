# Run doctor checks

`omk doctor` is a health audit for a single artifact — run it before you trust an eval, and as a CI gate. It does not compare two versions (that's [`omk eval`](../../reference/cli.md)); it tells you whether one artifact is well-formed enough to be worth measuring.

For the full flag list see the [CLI reference](../../reference/cli.md). This guide covers the common tasks.

## Quick health check

```bash
omk doctor                         # audit the current dir or ./skills
omk doctor skills/v1.md            # audit a single skill
```

By default doctor runs static rules first (skill readability, frontmatter, body dependencies), then the multi-dimension health audit (trigger boundary, doc clarity, instruction precision, dependencies, tool conventions, security, examples). You get findings and concrete suggestions, sorted fail → warn → pass. Open the report in `omk studio`.

## Sampling & consensus

By default `omk doctor` runs the audit twice in parallel (`--repeat 2`), takes the union of findings, and merges same-root-cause findings via an extra LLM clustering pass — each finding is tagged with `k/n` support (how many of the `n` passes reported it). Support describes these repeated audit results; it guarantees neither convergence nor complete issue coverage.

```bash
omk doctor skills/v1.md --repeat 1             # single quick pass, cheapest
omk doctor skills/v1.md --repeat 3             # deeper, more stable audit
omk doctor skills/ --repeat 3 --concurrency 1  # serial (lower peak concurrency)
```

`--concurrency` defaults to `--repeat` (full parallel); lower it if you're rate-limited. Cost scales with `--repeat`; wall-clock is roughly one pass (parallel) plus the merge.

## Static checks (no LLM)

```bash
omk doctor skills/ --static-only
```

Runs the same static lint rules included in default doctor with **zero LLM calls and without loading `samples.json`**: skill readability, frontmatter validity, and whether scripts / CLIs / files / env vars referenced in the skill body exist. For CI nodes without `codex`, or local offline debugging. (The samples-contract check needs `samples.json` and is not part of this — it stays as `omk eval`'s pre-evaluation gate.)

Review and trust the skill before running doctor: frontmatter `preflight` and `requires.preflight` commands run in the resolved dependency working directory with the host environment and a 10-second timeout per command, including with `--static-only` and during evaluation preflight. Zero model calls does not imply a command sandbox.

## As a CI gate

```bash
omk doctor --gate; echo $?        # quiet; exit 1 on fatal problems, warnings don't block
```

`--gate` prints only a stderr summary on failure and signals the result via exit code, so you can wire it into a pipeline.

## Machine-readable output

```bash
omk doctor skills/ --json > doctor.json
```

Emits the full `DoctorReport` as JSON for CI or external tooling to consume.

## Auto-fix

```bash
omk doctor skills/v1.md --fix
```

Choose a proposed direction for each finding, then confirm before files are changed. OMK backs up selected files under `.omk/backups/doctor-fix/` and prints the backup location. Findings for the same physical file are grouped into one edit request; each request contains only that file's content and selected findings. Closed input does not confirm a repair.

The model returns `omk.skill-edits/v1` JSON; OMK validates and applies it rather than granting the model write access. Each nonempty `oldText` must match exactly once after earlier edits, and an invalid response changes nothing in that file. A failed file makes the command fail even if earlier files were repaired; their backups remain available. A completed edit does not establish that a new health audit would pass. Review the diff before committing.

Custom executors must follow the versioned `omk.doctor-fix-plan/v2` and `omk.doctor-fix/v2` prompts. Replace integrations that directly edited files with responses shaped as `{"summary":"…","edits":[{"oldText":"…","newText":"…"}]}`. OMK publishes complete text atomically, preserves existing permissions and symlink targets, and refuses writeback if the source text changed while preparing the edit. Temporary files live in the carrier-excluded `.omk/` directory on the same filesystem; they do not enter carrier hashes or snapshots.

## Custom dimensions

Append your own LLM-scored dimensions on top of the built-in seven via a YAML file:

```bash
omk doctor --dimensions my-dimensions.yaml
```

(Programmatic registration via `registerHealthDimension` is also supported — the custom dimension is folded into the same LLM call and report.)

## Related

- [The three stages](../../explanation/three-stage-workflow.md) — where doctor sits in the doctor → eval → observe loop
- [CLI reference: `omk doctor`](../../reference/cli.md) — every flag
