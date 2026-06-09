# Evaluate an agent (project-level runtime context)

**When do you need this guide?** A plain skill eval (`omk eval --control baseline --treatment my-skill`) injects one `SKILL.md` and measures it in isolation. But a real agent's behavior also depends on its **runtime context** — the project directory it runs in, that project's `CLAUDE.md`, the local skills it auto-loads, the repo state. When the thing you actually want to measure is "how does this agent behave inside this project", a plain skill eval can't see any of that. This guide covers evaluating under a real project context.

The enabler is the `claude-sdk` executor: it auto-extracts turns / toolCalls traces, supports assertions on tool-call behavior, and can run under a specified `cwd` so Claude Code auto-loads the project's `CLAUDE.md`, skills, and local runtime context.

## Concepts worth keeping separate

- `artifact`: the thing being evaluated — baseline, skill, prompt, agent
- `variant`: the CLI expression for an experiment group (see [Artifact & variant layout](../reference/artifact-layout))
- `runtime context`: the runtime environment; currently mainly `cwd`. In project-type agent scenarios it includes the project dir, its `CLAUDE.md`, local skills, and any other environmental factors that affect behavior

In omk, `agent` is not a catch-all term and neither is `skill`. A cleaner phrasing: **you are comparing how different artifacts behave under different runtime contexts.**

## Recommended executor

```bash
omk eval --executor claude-sdk
```

## Agent-related assertions

Assertions on tool-call and turn behavior (`tools_called` / `tools_not_called` / `tools_count_min` / `tools_count_max` / `tool_output_contains` / `tool_input_contains` / `turns_min` / `turns_max`) are documented in the [assertion types reference](../reference/eval-sample-format#assertion-types).

## Three common control setups

**1. Bare-model baseline**

No system prompt and no knowledge-carrying project dir. Requires at least one treatment to compare against:

```bash
omk eval \
  --executor claude-sdk \
  --control baseline \
  --treatment my-skill
```

**2. Empty artifact + project-level runtime context**

No system prompt, but runs inside a project dir. This is **not** a strict "bare baseline" — it is "empty artifact + project-level runtime context".

```bash
omk eval \
  --executor claude-sdk \
  --control baseline \
  --treatment project-env --treatment-cwd /path/to/target-project
```

**3. Explicit artifact injection**

Inject an external `SKILL.md` as the artifact while also keeping the project dir. Good for contrasting "project-level runtime context" vs "explicit single-artifact injection".

```bash
omk eval \
  --executor claude-sdk \
  --control project-env --control-cwd /path/to/target-project \
  --treatment /path/to/target-project/.claude/skills/prd/SKILL.md --treatment-cwd /path/to/target-project
```

## Recommended first-round design

For PRD / complex business-knowledge scenarios, start with:

```bash
omk eval \
  --executor claude-sdk \
  --samples skills/evaluate-review/eval-samples.yaml \
  --control baseline \
  --treatment /path/to/target-project/.claude/skills/prd/SKILL.md --treatment-cwd /path/to/target-project
```

If you want to prove whether "the knowledge sitting inside the project directory" is effective on its own, add a second treatment:

```bash
omk eval \
  --executor claude-sdk \
  --samples skills/evaluate-review/eval-samples.yaml \
  --control baseline \
  --treatment project-env,/path/to/target-project/.claude/skills/prd/SKILL.md \
  --treatment-cwd /path/to/target-project,/path/to/target-project
```

## Design tips

- **Always start with `--dry-run`** to confirm samples, variants, and `cwd` are parsed correctly
- **Project-level controls must differ in `cwd`**: the same prompt under different project dirs hits different runtime contexts
- **Try PRD scenarios first**: compared to pure coding, they make it easier to validate knowledge completeness, impact-area detection, and business correctness
