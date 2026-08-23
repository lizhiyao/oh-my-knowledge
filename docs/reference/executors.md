# Executors

An **executor** is the backend that runs an artifact against a model — it turns `(system, prompt, model)` into output. Which one you pick (`--executor`) decides *how* the model is called: the Claude CLI, the Agent SDK, codex, a raw HTTP API, or your own command. **Keep the executor fixed across a run** — comparing variants under different executors compares runtimes, not just the artifact (omk fingerprints the runtime and warns when they differ; see the construct-validity note below).

## Built-in executors

| Executor | When to use | Description |
|---|---|---|
| `claude` | skill evals in Claude Code environments | invokes `claude -p` via Claude CLI |
| `claude-sdk` | agent eval (tool / turn traces), structured output | uses Claude Agent SDK — extracts turns / toolCalls traces, no stdout parsing, avoids buffer truncation |
| `codex` | Codex / ChatGPT desktop coding tasks (CLI) | invokes `codex exec --json` (`@openai/codex` npm); best-effort tool trace; **costUSD not reported** (codex CLI does not emit USD; check usage externally) |
| `codex-sdk` | Codex agent eval (SDK) | uses `@openai/codex-sdk` with its bundled `@openai/codex` binary and streamed SDK events; **costUSD not reported** |
| `gemini` | cross-vendor comparison | invokes `gemini` CLI |
| `anthropic-api` | CI / no CLI installed | calls Anthropic HTTP API directly (needs `ANTHROPIC_API_KEY`) |
| `openai-api` | CI / no CLI; or route a non-Claude model | calls OpenAI HTTP API directly (needs `OPENAI_API_KEY`) |

API-direct executors support custom base URLs via env: `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`.

## Sample mock compatibility

`Sample.mocks` requires the executor to intercept a tool call before the underlying tool runs. Tool traces alone are not enough: an executor that can report `Read` after execution cannot safely replace that call with a fixture.

| Executor | `Sample.mocks` support |
|---|---|
| `claude` / `claude-sdk` | supported through native hooks |
| `codex` / `codex-sdk` | unsupported; the current CLI and SDK expose traces but no tool-interception hook |
| `gemini` / `anthropic-api` / `openai-api` | unsupported |
| custom command | delegated through `OMK_MOCKS_FILE` / `OMK_MOCK_SETTINGS_FILE`; the command must install or consume the supplied hook |

When the selected executor does not support interception, `omk sample` automatically generates mockless samples and removes positive evidence that would require a simulated call (`mock_hit`, `tools_called`, `tools_count_min`, `tool_input_contains`, and `tool_output_contains`). If a model still emits `environment`, its facts are moved into explicitly non-materialized `context` rather than discarded or presented as fixtures. `omk eval`, including `--dry-run` and `--skip-doctor`, rejects existing samples with mocks before any model call instead of silently turning harness incompatibility into a model failure.

`environment.files_available` is prompt context only. It tells the model what the task statement assumes; it does not create a file in `cwd`. Put a real fixture under the sample working directory when the task must read physical bytes.

## How the default runtime is selected

Precedence is: explicit CLI flag → `eval.yaml` → `OMK_*` environment preference → automatic detection.

- Inside a Codex task in the ChatGPT desktop app, omk selects `codex`.
- In a regular terminal where only the Codex CLI is available, omk selects `codex`.
- When both Claude and Codex are installed outside a Codex task, omk keeps the legacy `claude` default to avoid silently switching the measurement runtime after an upgrade.
- When Codex is selected without `--model`, omk reads the top-level `model` from `$CODEX_HOME/config.toml` or `~/.codex/config.toml`.
- The default judge follows the selected executor: Claude uses `claude:haiku`; Codex uses the same model as the evaluated task and never falls back to Claude.
- The same resolver covers `eval`, `doctor`, `sample`, `evolve`, and `observe inbox --llm-enhanced-review`.

To pin Codex in regular terminals, add this to your shell profile (for example `~/.zshrc`):

```bash
export OMK_EXECUTOR=codex
# Optional: export OMK_MODEL="your-codex-model"
# Optional: export OMK_JUDGE_MODELS="codex:your-judge-model"
```

Without the optional variables, the model comes from Codex config and the judge reuses the task model.

**Choosing:** use `codex` directly in Codex environments; it has the strongest measurement isolation. Use `codex-sdk` only when you specifically need SDK event streams. Use `claude` in Claude Code environments, or `claude-sdk` for tool-call / turn assertions and structured output. On CI with no CLI, use an `*-api` executor. For any other vendor, point `openai-api` at its base URL or write a custom executor. Routing a non-Claude model is covered in [use non-Claude models](../guides/non-claude-models).

**Codex construct-validity notes:**

- **Runtime fingerprinting**: `codex` uses the `codex` binary on `PATH`; `codex-sdk` uses the bundled `@openai/codex` binary resolved by `@openai/codex-sdk`. Reports persist per-variant `meta.executorRuntimes` / `meta.executorRuntime` and per-judge `meta.judgeModels[].runtime` fingerprints (binary or SDK version + capability snapshot); strict comparability checks warn when a fingerprint can't be audited. If fingerprints differ across variants, read the result as an executor-runtime comparison, not just prompt/template behavior.
- **Config and session isolation**: before launch, omk reads only the top-level Codex `model` and passes it explicitly. `codex` passes `--ephemeral` + `--ignore-user-config` + `--ignore-rules`. `codex-sdk` redirects `$CODEX_HOME` to a fresh tmp dir for every execution, copies `auth.json`, and removes the directory after the child exits; user config and prior SDK sessions therefore do not leak into the run.
- **SDK execpolicy limitation**: the current `@openai/codex-sdk` API does not expose the CLI's `--ignore-rules` switch. Project execpolicy discovered from an explicitly selected working directory can therefore still affect `codex-sdk`. Keep the executor and runtime context fixed, or prefer `codex` when project-rule isolation is required.

## DeepSeek Harness: prefer the host plugin

If DSH is already your local harness, load OMK into the existing profile instead of making OMK start another runtime:

```bash
dsh plugin --profile web add oh-my-knowledge
dsh --profile web
```

Then run this inside DSH:

```text
/omk eval eval.yaml
```

The config path is resolved from the current DSH session `cwd`. Omit the top-level `executor` from `eval.yaml`: the measured executor is always the current DSH host. The evaluated model inherits the current session unless `model` is explicit in the config. A judge can use the public `executor: dsh` alias; `dsh-host` is an internal OMK identifier and is rejected in user config. For every sample, the plugin creates a fresh DSH agent/session and reuses the profile's provider, credentials, tools, sandbox, and persistence. OMK installs a complete system-prompt section for the control/treatment, suppresses runtime context and the ambient `skill` tool, maps DSH `session/event` records in host-observed order into token/turn/tool/subagent evidence, and writes reports under the project's `.omk/reports`.

The plugin composes each measurement agent from the initiating session's active agent preset before applying OMK isolation. Omit `effort` from this host-mode config: DSH reasoning effort identifiers are provider-owned and cannot be mapped losslessly to OMK's five generic levels. Fix the desired reasoning behavior in the DSH profile instead. `goldDir` remains supported and attaches human-gold agreement to the persisted report.

This PoC exposes `/omk` through DSH's human-command registry, so the profile needs `ctx.commands` and a command adapter. The built-in `web` profile satisfies that requirement; headless, ACP, and JSON-RPC surfaces do not currently consume the command. `Sample.mocks` remains unsupported. The runtime fingerprint includes the DSH host version, OMK adapter version, provider, agent preset, and effective tool schemas. DSH does not expose a canonical digest for every plugin and policy, so the fingerprint is explicitly marked partially auditable and strict comparability checks emit a warning instead of claiming full runtime parity.

For a local checkout, build it and link it directly into the profile:

```bash
npm run build
dsh plugin --profile web add /absolute/path/to/oh-my-knowledge
```

## Custom executor

Any shell command can serve as an executor, communicating via stdin/stdout JSON:

```bash
omk eval --executor "python my_provider.py"
omk eval --executor "./my-executor.sh"
```

**Protocol:**

- **input** (stdin): JSON `{"model":"...","system":"...","prompt":"..."}`
- **output** (stdout): JSON `{"ok":true,"output":"model reply","inputTokens":0,"outputTokens":0,"costUSD":0}`; `ok` may be omitted for compatibility
- return `{"ok":false,"error":"reason"}` to report a structured execution failure
- stdout only needs to return the fields you care about; others default to 0. Plain-text output (no tokens/cost parsing) is also fine.
- to expose source-neutral agent evidence, add `turns`, `toolCalls`, `fullNumTurns`, and `numSubAgents`. Each tool call includes `tool`, JSON `input` / `output`, `success`, and optionally `status` (`success` / `failure` / `cancelled` / `unknown`) plus source identity fields. Malformed trace fields fail the execution instead of being dropped.
- token usage is authoritative only when all four counters are present: `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheCreationTokens`. Otherwise the report marks token usage as unreported.
- local script or executable bytes referenced by the command are part of the runtime fingerprint; changing the file invalidates cache and strict comparability even when the command string stays unchanged.
- an empty JSON `output` or whitespace-only plain-text output counts as failure
- non-zero exit code counts as failure

## Prerequisites

- **claude**: install [Claude Code](https://claude.ai/code) and authenticate
- **claude-sdk**: install [Claude Code](https://claude.ai/code) and authenticate (uses Agent SDK, no CLI stdout parsing)
- **codex**: install the Codex CLI (`npm i -g @openai/codex`) and authenticate
- **codex-sdk**: `npm i @openai/codex-sdk` (bundles the `@openai/codex` binary)
- **DSH plugin**: install `oh-my-knowledge` into an existing command-capable DSH profile and use `/omk eval <eval.yaml>`
- **anthropic-api**: set the `ANTHROPIC_API_KEY` env var
- **openai-api**: set the `OPENAI_API_KEY` env var
- **gemini**: `npm i -g @google/gemini-cli` and authenticate

## Related

- [Artifact & variant layout](./artifact-layout) — how `variant` resolves to an artifact + runtime context
- [Evaluate an agent](../guides/agent-eval) — source-neutral agent evaluation and intentional project context
- [Use non-Claude models](../guides/non-claude-models) — GLM / Qwen / DeepSeek / Moonshot / Ollama
