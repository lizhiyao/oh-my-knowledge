# Artifact & variant layout

An `omk eval` run is built from three things — this page explains each and how a CLI **variant** expression resolves into one:

- **artifact** — the thing being evaluated: a skill, prompt, agent, or workflow file (or `baseline`, meaning *nothing injected*).
- **variant** — the expression you write on the CLI (e.g. `--control v1 --treatment v2`). Each variant resolves to exactly one artifact.
- **runtime context** — the environment the artifact runs in; currently the working directory (`cwd`), which pulls in that project's `CLAUDE.md`, local skills, and repo state.

In one line: **a variant expression → an artifact (+ an optional runtime context)**. The expression carries artifact identity *only*; runtime context is declared separately ([below](#declaring-runtime-context-cwd)).

## Variant resolution rules

| Format | Resolves to |
|---|---|
| `name` | looks up `name.md` or `name/SKILL.md` in the artifact dir → one artifact |
| `baseline` | empty artifact, no system prompt — "nothing injected" (reserved name; cannot be bound to a cwd) |
| any other label (e.g. `project-env`) | empty artifact too; pair it with a cwd (below) to measure project-level runtime context alone |
| `git:name` | the last-committed version of an artifact from git HEAD |
| `git:ref:name` | an artifact from a specific commit |
| `./path/to/file.md` | a path (contains `/`): read the file directly as the artifact |

To observe a project's runtime context by itself, use a non-`baseline` label plus a cwd (e.g. `--treatment project-env --treatment-cwd /path`) — binding `baseline` to a cwd is rejected.

## Artifact directory layout

For the `name` form, the built-in executors (claude / codex, etc.) support two layouts, mixable in the same run:

```
skills/
├── v1.md                    # option 1: plain .md file
└── my-skill/                # option 2: full artifact dir
    ├── SKILL.md             #   this file is auto-loaded as system prompt
    ├── config.json          #   other files don't participate in eval, kept for completeness
    └── scripts/
```

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
