# Run doctor checks

`omk doctor` is a health audit for a single artifact — run it before you trust an eval, and as a CI gate. It does not compare two versions (that's [`omk eval`](../reference/cli)); it tells you whether one artifact is well-formed enough to be worth measuring.

For the full flag list see the [CLI reference](../reference/cli). This guide covers the common tasks.

## Quick health check

```bash
omk doctor                         # audit the current dir or ./skills
omk doctor skills/v1.md            # audit a single skill
```

By default doctor runs static rules first (skill readability, frontmatter, body dependencies), then the multi-dimension health audit (trigger boundary, doc clarity, instruction precision, dependencies, tool conventions, security, examples). You get findings and concrete suggestions, sorted fail → warn → pass. Open the report in `omk studio`.

## Sampling & consensus

By default `omk doctor` runs the audit twice in parallel (`--repeat 2`), takes the union of findings, and merges same-root-cause findings via an extra LLM clustering pass — each finding is tagged with `k/n` support (how many of the `n` passes reported it). Repeated runs converge instead of surfacing a different subset each time.

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

Runs the same static lint rules included in default doctor with **zero LLM calls and without loading `samples.json`**: skill readability, frontmatter validity, and whether scripts / CLIs / files / env vars referenced in the skill body exist. For CI nodes without `claude` / `codex`, or local offline debugging. (The samples-contract check needs `samples.json` and is not part of this — it stays as `omk eval`'s pre-evaluation gate.)

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

Runs an LLM agent that reads the doctor findings and edits the skill to address them. Review the diff before committing.

## Custom dimensions

Append your own LLM-scored dimensions on top of the built-in seven via a YAML file:

```bash
omk doctor --dimensions my-dimensions.yaml
```

(Programmatic registration via `registerHealthDimension` is also supported — the custom dimension is folded into the same LLM call and report.)

## Related

- [The three stages](../explanation/three-stage-workflow) — where doctor sits in the doctor → eval → observe loop
- [CLI reference: `omk doctor`](../reference/cli) — every flag
