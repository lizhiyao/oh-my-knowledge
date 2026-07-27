# Evaluate an agent (project-level runtime context)

**When do you need this guide?** A plain skill eval (`omk eval --control baseline --treatment my-skill`) injects one `SKILL.md` and measures it in isolation. But a real agent's behavior also depends on its **runtime context** — the project directory it runs in, project instructions such as `AGENTS.md` or `CLAUDE.md`, locally discovered skills, and repository state. When the thing you actually want to measure is "how does this agent behave inside this project", a plain skill eval cannot see all of that. This guide covers evaluating under an intentional project context.

Codex and Claude executors both emit the same source-neutral turns / toolCalls contract, so agent assertions do not depend on one provider. Executor choice is part of the construct:

- use `codex` for the strongest artifact-isolation measurement; it ignores user config and project rules
- use `codex-sdk` when the **Codex project context itself** is intentional measured input
- use `claude-sdk` when the **Claude Code project context itself** is intentional measured input

Keep the executor, model, and working directory fixed across variants. Reports persist their runtime fingerprints and execution strategy so incompatible runs are not presented as artifact-only comparisons.

## Concepts worth keeping separate

- `artifact`: the thing being evaluated — baseline, skill, prompt, agent
- `variant`: the CLI expression for an experiment group (see [Artifact & variant layout](../reference/artifact-layout))
- `runtime context`: the runtime environment; currently mainly `cwd`. In project-type agent scenarios it includes the project directory, provider instruction files, local skills, and any other environmental factors that affect behavior

In omk, `agent` is not a catch-all term and neither is `skill`. A cleaner phrasing: **you are comparing how different artifacts behave under different runtime contexts.**

## Recommended executor

For a Codex project-context experiment:

```bash
omk eval --executor codex-sdk
```

For a strict isolated artifact experiment, use `--executor codex`. For a Claude Code project-context experiment, substitute `claude-sdk`.

## Agent-related assertions

Assertions on tool-call and turn behavior (`tools_called` / `tools_not_called` / `tools_count_min` / `tools_count_max` / `tool_output_contains` / `tool_input_contains` / `turns_min` / `turns_max`) are documented in the [assertion types reference](../reference/eval-sample-format#assertion-types).

## Three common control setups

**1. Bare-model baseline**

No system prompt and no knowledge-carrying project dir. Requires at least one treatment to compare against:

```bash
omk eval \
  --executor codex \
  --control baseline \
  --treatment my-skill
```

**2. Empty artifact + project-level runtime context**

No system prompt, but runs inside a project dir. This is **not** a strict "bare baseline" — it is "empty artifact + project-level runtime context".

```bash
omk eval \
  --executor codex-sdk \
  --control baseline \
  --treatment project-env --treatment-cwd /path/to/target-project
```

**3. Explicit artifact injection**

Inject an external `SKILL.md` as the artifact while also keeping the project dir. Good for contrasting "project-level runtime context" vs "explicit single-artifact injection".

```bash
omk eval \
  --executor codex-sdk \
  --control project-env --control-cwd /path/to/target-project \
  --treatment /path/to/target-project/.agents/skills/prd/SKILL.md --treatment-cwd /path/to/target-project
```

## Recommended first-round design

For PRD / complex business-knowledge scenarios, start with:

```bash
omk eval \
  --executor codex-sdk \
  --samples skills/evaluate-review/eval-samples.yaml \
  --control baseline \
  --treatment /path/to/target-project/.agents/skills/prd/SKILL.md --treatment-cwd /path/to/target-project
```

If you want to prove whether "the knowledge sitting inside the project directory" is effective on its own, add a second treatment:

```bash
omk eval \
  --executor codex-sdk \
  --samples skills/evaluate-review/eval-samples.yaml \
  --control baseline \
  --treatment project-env,/path/to/target-project/.agents/skills/prd/SKILL.md \
  --treatment-cwd /path/to/target-project,/path/to/target-project
```

## Design tips

- **Always start with `--dry-run`** to confirm samples, variants, and `cwd` are parsed correctly
- **Project-level controls must differ in `cwd`**: the same prompt under different project dirs hits different runtime contexts
- **Do not compare `codex` directly with `codex-sdk` as an artifact-only A/B**: their project-rule isolation differs, so executor choice becomes part of the treatment
- **Try PRD scenarios first**: compared to pure coding, they make it easier to validate knowledge completeness, impact-area detection, and business correctness
