# Run doctor checks

`omk doctor` is a health audit for a single artifact — run it before you trust an eval, and as a CI gate. It does not compare two versions (that's [`omk eval`](../reference/cli)); it tells you whether one artifact is well-formed enough to be worth measuring.

For the full flag list see the [CLI reference](../reference/cli). This guide covers the common tasks.

## Quick health check

```bash
omk doctor                         # audit the current dir or ./skills
omk doctor skills/v1.md            # audit a single skill
```

You get per-dimension health scores (trigger boundary, doc clarity, instruction precision, dependencies, tool conventions, security, examples), findings, and concrete suggestions, sorted fail → warn → pass. Open the report in `omk studio`.

## Offline / no-LLM mode

On a CI node without `claude` / `codex`, or when debugging offline, run only the static rules (readability / metadata / dependencies / samples-contract) — zero LLM calls, zero cost:

```bash
omk doctor skills/ --static-only
```

## As a CI gate

```bash
omk doctor --gate; echo $?        # quiet; exit 1 on fatal problems, warnings don't block
```

`--gate` prints only a stderr summary on failure and signals the result via exit code, so you can wire it into a pipeline. Pair with `--static-only` for a fast, LLM-free preflight gate.

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
