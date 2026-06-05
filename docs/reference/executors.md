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
