# Executors

An **executor** is the backend that runs an artifact against a model — it turns `(system, prompt, model)` into output. Which one you pick (`--executor`) decides *how* the model is called: the Claude CLI, the Agent SDK, codex, a raw HTTP API, or your own command. **Keep the executor fixed across a run** — comparing variants under different executors compares runtimes, not just the artifact (omk fingerprints the runtime and warns when they differ; see the construct-validity note below).

## Built-in executors

| Executor | When to use | Description |
|---|---|---|
| `claude` | default — most skill evals | invokes `claude -p` via Claude CLI |
| `claude-sdk` | agent eval (tool / turn traces), structured output | uses Claude Agent SDK — extracts turns / toolCalls traces, no stdout parsing, avoids buffer truncation |
| `codex` | compare against an OpenAI agent (CLI) | invokes `codex exec --json` (`@openai/codex` npm); best-effort tool trace; **costUSD not reported** (codex CLI does not emit USD; check usage externally) |
| `codex-sdk` | compare against an OpenAI agent (SDK) | uses `@openai/codex-sdk` with its bundled `@openai/codex` binary and streamed SDK events; **costUSD not reported** |
| `gemini` | cross-vendor comparison | invokes `gemini` CLI |
| `anthropic-api` | CI / no CLI installed | calls Anthropic HTTP API directly (needs `ANTHROPIC_API_KEY`) |
| `openai-api` | CI / no CLI; or route a non-Claude model | calls OpenAI HTTP API directly (needs `OPENAI_API_KEY`) |

API-direct executors support custom base URLs via env: `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`.

**Choosing:** default to `claude`; switch to `claude-sdk` when you need tool-call / turn assertions or structured output (agent eval); use `codex` / `codex-sdk` to A/B against an OpenAI agent; use an `*-api` executor on CI with no CLI; for any other vendor, point `openai-api` at its base URL or write a custom executor. Routing a non-Claude model is covered in [use non-Claude models](../guides/non-claude-models).

**Codex construct-validity notes:**

- **Runtime fingerprinting**: `codex` uses the `codex` binary on `PATH`; `codex-sdk` uses the bundled `@openai/codex` binary resolved by `@openai/codex-sdk`. Reports persist per-variant `meta.executorRuntimes` / `meta.executorRuntime` and per-judge `meta.judgeModels[].runtime` fingerprints (binary or SDK version + capability snapshot); strict comparability checks warn when a fingerprint can't be audited. If fingerprints differ across variants, read the result as an executor-runtime comparison, not just prompt/template behavior.
- **Config isolation**: both executors isolate user-level config — `codex` passes `--ephemeral` + `--ignore-user-config`; `codex-sdk` redirects `$CODEX_HOME` to a per-process tmp dir (auth.json symlinked through). Your `~/.codex/config.toml` never leaks into an eval run.

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

## Prerequisites

- **claude**: install [Claude Code](https://claude.ai/code) and authenticate
- **claude-sdk**: install [Claude Code](https://claude.ai/code) and authenticate (uses Agent SDK, no CLI stdout parsing)
- **codex**: install the Codex CLI (`npm i -g @openai/codex`) and authenticate
- **codex-sdk**: `npm i @openai/codex-sdk` (bundles the `@openai/codex` binary)
- **anthropic-api**: set the `ANTHROPIC_API_KEY` env var
- **openai-api**: set the `OPENAI_API_KEY` env var
- **gemini**: `npm i -g @google/gemini-cli` and authenticate

## Related

- [Artifact & variant layout](./artifact-layout) — how `variant` resolves to an artifact + runtime context
- [Evaluate an agent](../guides/agent-eval) — agent-aware evaluation with `claude-sdk`
- [Use non-Claude models](../guides/non-claude-models) — GLM / Qwen / DeepSeek / Moonshot / Ollama
