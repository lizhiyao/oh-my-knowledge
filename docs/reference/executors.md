# Executors

## Built-in executors

| Executor | When to use | Description |
|---|---|---|
| `claude` | default | invokes `claude -p` via Claude CLI |
| `claude-sdk` | structured output | uses Claude Agent SDK — no stdout parsing, avoids buffer truncation |
| `codex` | OpenAI agent CLI | invokes `codex exec --json` (`@openai/codex` npm); best-effort tool trace; **costUSD not reported** (codex CLI does not emit USD; check usage externally) |
| `codex-sdk` | OpenAI agent SDK | uses `@openai/codex-sdk` with its bundled `@openai/codex` binary and streamed SDK events; **costUSD not reported** |
| `gemini` | cross-vendor comparison | invokes `gemini` CLI |
| `anthropic-api` | no CLI needed | calls Anthropic HTTP API directly (needs `ANTHROPIC_API_KEY`) |
| `openai-api` | no CLI needed | calls OpenAI HTTP API directly (needs `OPENAI_API_KEY`) |

API-direct executors support custom base URLs via env: `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`.

Codex construct-validity notes: (1) `codex` uses the `codex` binary on `PATH`; `codex-sdk` uses the bundled `@openai/codex` binary resolved by `@openai/codex-sdk`. Reports persist per-variant `meta.executorRuntimes`, `meta.executorRuntime`, and per-judge `meta.judgeModels[].runtime` fingerprints (binary or SDK version + capability snapshot), and strict comparability checks warn when runtime fingerprints cannot be audited. If runtime fingerprints differ, treat results as an executor-runtime comparison, not only prompt/template behavior. (2) Both executors isolate user-level config: `codex` passes `--ephemeral` + `--ignore-user-config`; `codex-sdk` redirects `$CODEX_HOME` to a per-process tmp dir (auth.json symlinked through). User-level `~/.codex/config.toml` does not leak into eval runs in either case.

## Custom executor

Any shell command can serve as an executor, communicating via stdin/stdout JSON:

```bash
omk eval --executor "python my_provider.py"
omk eval --executor "./my-executor.sh"
```

**Protocol:**

- **input** (stdin): JSON `{"model":"...","system":"...","prompt":"..."}`
- **output** (stdout): JSON `{"output":"model reply","inputTokens":0,"outputTokens":0,"costUSD":0}`
- stdout only needs to return the fields you care about; others default to 0. Plain-text output (no tokens/cost parsing) is also fine.
- non-zero exit code counts as failure

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

**Variant resolution rules:**

`variant` is the experiment-group expression. After resolution, OMK produces an `artifact` plus an optional `runtime context` (currently mainly `cwd`).

| Format | Meaning |
|---|---|
| `name` | looks up `name.md` or `name/SKILL.md` in the artifact dir, resolves to one artifact |
| `baseline` | empty artifact, no system prompt — think "nothing at all" |
| `project-env` (any non-skill label) | empty artifact; pair with a cwd (below) to run in a project dir — observe project-level runtime context alone |
| `git:name` | reads the last-committed version of an artifact from git HEAD |
| `git:ref:name` | reads an artifact from a specific commit |
| `./path/to/file.md` | path with `/`: read the file directly as an artifact |

The `variant` expression carries **artifact identity only**. Runtime context (`cwd`) is declared separately:

- on the CLI via `--control-cwd <dir>` and `--treatment-cwd <dir,...>` (the latter is comma-separated and index-aligned with `--treatment`; leave a slot blank for "no cwd");
- per-variant in `eval.yaml` via the structured `cwd:` field.

The old `name@cwd` string syntax has been removed.

When both `--control` and `--treatment` are omitted, use `--config eval.yaml` or `--batch`. With `--batch`, `baseline` is auto-added as control and every discovered artifact becomes a treatment.

```bash
# explicit: one control, one or more treatments
omk eval --control v1 --treatment v2
omk eval --control baseline --treatment v1,v2,v3

# compare empty artifact vs explicit artifact
omk eval --control baseline --treatment my-skill

# observe project-level runtime context in isolation (use a self-describing label)
omk eval --control baseline --treatment project-env --treatment-cwd /path/to/target-project

# compare "project-level runtime context" vs "explicit artifact injection"
omk eval \
  --control project-env --control-cwd /path/to/target-project \
  --treatment /path/to/target-project/.claude/skills/prd/SKILL.md --treatment-cwd /path/to/target-project

# before vs after (old version read from git history)
omk eval --control git:my-skill --treatment my-skill

# direct file paths
omk eval --control ./old-skill.md --treatment ./new-skill.md

# config-file driven (evaluation-as-code)
omk eval --config eval.yaml
```

**Prerequisites:**

- **claude**: install [Claude Code](https://claude.ai/code) and authenticate
- **claude-sdk**: install [Claude Code](https://claude.ai/code) and authenticate (uses Agent SDK, no CLI stdout parsing)
- **codex**: install the Codex CLI (`npm i -g @openai/codex`) and authenticate
- **codex-sdk**: `npm i @openai/codex-sdk` (bundles the `@openai/codex` binary)
- **anthropic-api**: set the `ANTHROPIC_API_KEY` env var
- **openai-api**: set the `OPENAI_API_KEY` env var
- **gemini**: `npm i -g @google/gemini-cli` and authenticate

## Agent evaluation and project-level runtime context

When the executor is `claude-sdk`, OMK supports a first pass of agent-aware evaluation.

A few concepts worth keeping separate:

- `artifact`: the thing being evaluated — baseline, skill, prompt, agent
- `variant`: the CLI expression for an experiment group
- `runtime context`: the runtime environment; currently mainly `cwd`. In project-type agent scenarios it includes the project dir, its `CLAUDE.md`, local skills, and any other environmental factors that affect behavior

In OMK, `agent` is not a catch-all term and neither is `skill`. A cleaner phrasing: **you are comparing how different artifacts behave under different runtime contexts.**

- auto-extracts turns / toolCalls traces
- supports assertions on tool-call behavior
- supports running under a specified `cwd`, so Claude Code auto-loads the project's `CLAUDE.md`, skills, and local runtime context

### Recommended executor

```bash
omk eval --executor claude-sdk
```

### Agent-related assertions

| Assertion | Meaning |
|---|---|
| `tools_called` | must call the specified tool(s) |
| `tools_not_called` | must not call the specified tool(s) |
| `tools_count_min` / `tools_count_max` | tool-call-count bounds |
| `tool_output_contains` | output of a specific tool must contain given content |
| `turns_min` / `turns_max` | turn-count bounds |

### Three common control setups

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

### Recommended first-round design

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

### Design tips

- **Always start with `--dry-run`** to confirm samples, variants, and `cwd` are parsed correctly
- **Project-level controls must differ in `cwd`**: the same prompt under different project dirs hits different runtime contexts
- **Try PRD scenarios first**: compared to pure coding, they make it easier to validate knowledge completeness, impact-area detection, and business correctness

## Common model configurations

**Don't have Claude?** Most Chinese LLMs (GLM, Qwen, Moonshot, DeepSeek, etc.) are OpenAI-API compatible — use the `openai-api` executor directly:

```bash
# GLM (Zhipu)
export OPENAI_API_KEY="your Zhipu API key"
export OPENAI_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
omk eval --executor openai-api --model glm-4-plus \
  --judge-models openai-api:glm-4-plus --no-cache

# Qwen (Alibaba)
export OPENAI_API_KEY="your Qwen API key"
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
omk eval --executor openai-api --model qwen-plus \
  --judge-models openai-api:qwen-plus

# DeepSeek
export OPENAI_API_KEY="your DeepSeek API key"
export OPENAI_BASE_URL="https://api.deepseek.com"
omk eval --executor openai-api --model deepseek-chat \
  --judge-models openai-api:deepseek-chat

# Moonshot (Kimi)
export OPENAI_API_KEY="your Moonshot API key"
export OPENAI_BASE_URL="https://api.moonshot.cn/v1"
omk eval --executor openai-api --model moonshot-v1-8k \
  --judge-models openai-api:moonshot-v1-8k
```

**Ollama local model:**

```bash
omk eval --executor "python examples/custom-executor/ollama-executor.py" \
  --model llama3 --no-judge
```

**About the judge:**

- `--judge-models <list>` picks the LLM judge(s). Format: `executor:model[,executor:model]`. Default: `${executor}:haiku` (or claude:haiku when no `--executor` set)
- 1 entry = single judge; ≥ 2 entries = multi-judge ensemble + inter-judge agreement
- If you don't have Claude, point `--judge-models` at whatever you have, e.g. `--judge-models openai-api:glm-4-plus`
- Add `--no-judge` to skip the LLM judge and rely on assertions alone
