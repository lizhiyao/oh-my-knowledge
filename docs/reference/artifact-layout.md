# Artifact & variant layout

How OMK turns a `variant` expression into an `artifact` (the thing being evaluated) plus an optional `runtime context`.

## Artifact directory layout

The built-in executors (claude / codex / gemini, etc.) support two artifact layouts, mixable in the same run:

```
skills/
├── v1.md                    # option 1: plain .md file
└── my-skill/                # option 2: full artifact dir
    ├── SKILL.md             #   this file is auto-loaded as system prompt
    ├── config.json          #   other files don't participate in eval, kept for completeness
    └── scripts/
```

## Variant resolution rules

`variant` is the experiment-group expression. After resolution, OMK produces an `artifact` plus an optional `runtime context` (currently mainly `cwd`).

| Format | Meaning |
|---|---|
| `name` | looks up `name.md` or `name/SKILL.md` in the artifact dir, resolves to one artifact |
| `baseline` | empty artifact, no system prompt — think "nothing at all" |
| `project-env` (any non-skill label) | empty artifact; pair with a cwd (below) to run in a project dir — observe project-level runtime context alone |
| `git:name` | reads the last-committed version of an artifact from git HEAD |
| `git:ref:name` | reads an artifact from a specific commit |
| `./path/to/file.md` | path with `/`: read the file directly as an artifact |

## Declaring runtime context (cwd)

The `variant` expression carries **artifact identity only**. Runtime context (`cwd`) is declared separately:

- on the CLI via `--control-cwd <dir>` and `--treatment-cwd <dir,...>` (the latter is comma-separated and index-aligned with `--treatment`; leave a slot blank for "no cwd");
- per-variant in `eval.yaml` via the structured `cwd:` field.

The old `name@cwd` string syntax has been removed.

When both `--control` and `--treatment` are omitted, use `--config eval.yaml` or `--batch`. With `--batch`, `baseline` is auto-added as control and every discovered artifact becomes a treatment.

## Command examples

```bash
# explicit: one control, one or more treatments
omk eval --control v1 --treatment v2
omk eval --control baseline --treatment v1,v2,v3

# compare empty artifact vs explicit artifact
omk eval --control baseline --treatment my-skill

# before vs after (old version read from git history)
omk eval --control git:my-skill --treatment my-skill

# direct file paths
omk eval --control ./old-skill.md --treatment ./new-skill.md

# config-file driven (evaluation-as-code)
omk eval --config eval.yaml
```

For setups that pair an artifact with a project-level `cwd` (agent / project runtime context), see [Evaluate an agent](../guides/agent-eval).
