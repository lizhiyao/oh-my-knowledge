# Executors

An **executor** runs a sample against the system under test, using the selected knowledge artifact and execution conditions, and returns output and available execution evidence. `--executor` selects the invocation method: a CLI, SDK, HTTP API, or your executable adapter. Keep the model, executor, and execution conditions fixed when comparing knowledge versions. Reusing a sample file across executors does not make their runtime identities or scores interchangeable.

## Choose an input and executor

1. Write one [v3 sample set](./eval-sample-format): put the task in `input`, execution conditions in `executionContext`, and references and checks in `expected` / `evaluationContext`. Choose `text`, `json`, or `messages` by the task data, rather than by whether the target is a prompt, RAG, skill, agent, or workflow.
2. Check the [input support matrix](./eval-sample-format#input-and-adapter-support). CLI/SDK adapters accept text; API adapters also accept JSON and plain role history. For application protocols such as tool history, provide a [custom executor](#custom-executor). Input support does not imply tools, workspace access, or a particular output shape.
3. Keep the sample file and grading declarations fixed across version comparisons. Use `--samples ./eval-samples.json --executor openai-api`, or `--executor ./my-executor.mjs` for your adapter, with the chosen control, treatment, and model. `--dry-run` checks compilation and declared requirements; it does not prove the target will execute successfully.

## Built-in executors

| Executor | When to use | Description |
|---|---|---|
| `claude` | skill evals in Claude Code environments | invokes `claude -p` via Claude CLI |
| `claude-sdk` | agent eval (tool / turn traces), structured output | uses Claude Agent SDK — extracts turns / toolCalls traces, no stdout parsing, avoids buffer truncation |
| `codex` | Codex / ChatGPT desktop coding tasks (CLI) | invokes `codex exec --json` (`@openai/codex` npm); best-effort tool trace; **costUSD not reported** (codex CLI does not emit USD; check usage externally) |
| `codex-sdk` | Codex agent eval (SDK) | uses `@openai/codex-sdk` with its bundled `@openai/codex` binary and streamed SDK events; **costUSD not reported** |
| `anthropic-api` | CI / no CLI installed | calls Anthropic HTTP API directly (needs `ANTHROPIC_API_KEY`) |
| `openai-api` | CI / no CLI; or route a non-Claude model | calls OpenAI HTTP API directly (needs `OPENAI_API_KEY`) |

API-direct executors support custom base URLs via env: `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`.

The former built-in `gemini` executor has been removed because it did not expose the trace, isolation, mock, or cost evidence required for a trustworthy built-in integration. Existing `executor: gemini` configurations now fail explicitly instead of silently falling back to the custom-executor protocol. To keep using Gemini CLI, wrap it in a [custom executor](#custom-executor) that translates OMK's JSON stdin/stdout contract.

## Sample mock compatibility

`Sample.mocks` requires the executor to intercept a tool call before the underlying tool runs. Tool traces alone are not enough: an executor that can report `Read` after execution cannot safely replace that call with a fixture.

| Executor | `Sample.mocks` support |
|---|---|
| `claude` / `claude-sdk` | supported through native hooks |
| `codex` / `codex-sdk` | unsupported; the current CLI and SDK expose traces but no tool-interception hook |
| `anthropic-api` / `openai-api` | unsupported |
| custom executor | delegated through `OMK_MOCKS_FILE` / `OMK_MOCK_SETTINGS_FILE`; the command must install or consume the supplied hook |

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

- **Runtime fingerprinting**: `codex` uses the `codex` binary on `PATH`; `codex-sdk` uses the bundled `@openai/codex` binary resolved by `@openai/codex-sdk`. Core artifacts seal executor and evaluator Runtime identities, including the local binary or SDK evidence available to the host. A remote judge deployment remains `opaque/unknown` unless `eval.yaml` explicitly supplies `judgeModels[].deploymentRevision`; a supplied revision is only `self-reported/declared`. If Runtime identities differ, read the result as a runtime comparison, not just prompt/template behavior. See [Statistical rigor](../explanation/statistical-rigor#3-judge-debiasing-and-prompt-identity).
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
/omk observe
/omk observe <session-id>
```

The config path is resolved from the current DSH session `cwd`. Omit the top-level `executor` from `eval.yaml`: the measured executor is always the current DSH host. The evaluated model inherits the current session unless `model` is explicit in the config. A judge can use the public `executor: dsh` alias; `dsh-host` is an internal OMK identifier and is rejected in user config. For every sample, the plugin creates a fresh DSH agent/session and reuses the profile's provider, credentials, tools, sandbox, and persistence. OMK installs a complete system-prompt section for the control/treatment, suppresses runtime context and the ambient `skill` tool, maps DSH `session/event` records in host-observed order into token/turn/tool/subagent evidence, and writes reports under the project's `.omk/eval`.

The plugin composes each measurement agent from the initiating session's active agent preset before applying OMK isolation. When the model is inherited and every judge reuses that same DSH model, the live interactive session itself is the connectivity evidence, so OMK creates no extra probe sessions; an explicit measured-model override, a different DSH judge model, or an external judge still receives connectivity preflight. Omit `effort` from this host-mode config: DSH reasoning effort identifiers are provider-owned and cannot be mapped losslessly to OMK's five generic levels. Fix the desired reasoning behavior in the DSH profile instead. `goldDir` remains supported and attaches human-gold agreement to the persisted report.

This PoC exposes `/omk` through DSH's human-command registry, so the profile needs `ctx.commands` and a command adapter. The built-in `web` profile satisfies that requirement; headless, ACP, and JSON-RPC surfaces do not currently consume the command. `Sample.mocks` remains unsupported. The runtime fingerprint includes the DSH host version, OMK adapter version, provider, agent preset, and effective tool schemas. DSH does not expose a canonical digest for every plugin and policy, so the fingerprint is explicitly marked partially auditable and strict comparability checks emit a warning instead of claiming full runtime parity.

`/omk observe` additionally requires `ctx.sessionPersistence`. It lists recent terminal root sessions while excluding the command's current session. `/omk observe <session-id>` obtains the logical event stream through read-only `listSnapshots()` / `inspect()` calls, compares revisions around the read, converts a stable view into `sourceKind: dsh` Trace IR, and returns a Studio Task Trajectory URL under the actual listening address. DSH backends own JSONL, zstd, and SQLite physical formats; OMK parses none of them. Continuous writes, unknown required events, sequence gaps, unclosed turns / steps, and missing tool results prevent a “complete trajectory” claim. This first version is an offline snapshot and does not live-follow a running session.

For a local checkout, build it and link it directly into the profile:

```bash
npm run build
dsh plugin --profile web add /absolute/path/to/oh-my-knowledge
```

## Custom executor

A **Custom Executor** (`custom-executor`) lets you define how a sample is executed: your program receives the input, invokes your RAG, agent, or workflow, and returns the result. OMK owns the sample format, scoring, comparison, and evidence storage.

`omk eval --executor` accepts **one executable file path**, resolved relative to the evaluation project. Commands with arguments such as `node my-provider.mjs` or `python my-provider.py` are not executed as shell commands. Add a shebang and execution permission to scripts; use an executable wrapper when your service needs arguments.

### Beta rename: BREAKING-PROTOCOL / BREAKING-COMPARABILITY

`custom-command` is now `custom-executor`. Update request checks and response `schemaVersion` in existing scripts from `omk.custom-command-exchange/v1` to `omk.custom-executor-exchange/v1`; old responses are rejected, with no alias or compatibility mode. Error codes now use `OMK_CUSTOM_EXECUTOR_*`. Runtime IDs, resource lineage, and input/output/trace schema identities use the new namespace, so rerun comparisons to establish a new baseline. Stored historical reports are not rewritten. The executable path in your config stays the same; `custom-executor` names the adapter, not a literal `--executor` value.

### Verify stdin/stdout first

Save this as `my-executor.mjs`. It returns fixed text to verify integration, calls no model, and does not measure skill effectiveness:

```js
#!/usr/bin/env node
let text = '';
for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
if (request.schemaVersion !== 'omk.custom-executor-exchange/v1') {
  throw new Error('Unsupported OMK request');
}
// To connect your service, read request.trial.input and return its actual output.
console.log(JSON.stringify({
  schemaVersion: 'omk.custom-executor-exchange/v1',
  resultStatus: 'completed',
  output: { value: 'Integration works', classification: 'public' },
}));
```

In a project created by `omk init`, run:

```bash
chmod +x my-executor.mjs
omk eval --control code-review-v1 --treatment code-review-v2 \
  --executor ./my-executor.mjs --skip-connectivity --no-judge \
  --no-serve --report-only
```

This checks target execution and assertion scoring. `--no-judge` explicitly disables LLM judging; `--report-only` does not use the release gate to choose the exit code. The fixed answer is expected to fail the demo assertions. Check successful execution coverage, then connect your service.

### Connect your service

Each attempt starts a process that receives one JSON request on stdin and must return one JSON response on stdout. Send logs to stderr. The current protocol is `omk.custom-executor-exchange/v1`; it rejects the old `{ ok, output: "..." }` response and plain text.

| Request field | Purpose |
|---|---|
| `trial.input` | Resolved task input, usually a string for CLI text samples. |
| `trial.targetConfig.runtime` | Runtime configuration, including model and effort. |
| `trial.targetConfig.behavior.artifact` | Resource descriptor for the knowledge artifact under test. |
| `resources` | Readable resource snapshots for this execution, matched to descriptors by `resourceId`; `snapshotPath` is temporary. |
| `trial.trialSeed` | Measurement seed; use it only if your service actually supports it. |
| `attempt` | Attempt identity and retry number. |

To measure a prompt or skill change, find the artifact snapshot in `resources` using its descriptor and make the service consume that content. Reading only the task input ignores the knowledge under test. Do not read the original skill outside the snapshot or send expected answers to the target service. Resources last only for this lifecycle; do not persist their temporary paths.

On success, return `resultStatus: 'completed'` and `output: { value, classification }`, where `value` can be a JSON value. Choose `public`, `sensitive`, or `secret` to match the actual content; optional `trace` uses the same structure. Optional `usage` follows Core's `UsageRecord` contract. Omit unreported usage instead of presenting zero as a measurement.

Report invocation failure with a stable error code:

```json
{"schemaVersion":"omk.custom-executor-exchange/v1","resultStatus":"failed","error":{"code":"SERVICE_UNAVAILABLE","stage":"execution"}}
```

`stage` is `execution` or `infrastructure`. Nonzero exits, timeouts, and invalid responses are also execution failures; for example, an old-protocol response produces `OMK_CUSTOM_EXECUTOR_OUTPUT_INVALID`. Inspect execution coverage and failure evidence in the report rather than interpreting failure as a low-scoring answer.

This protocol applies to targets executed by `omk eval`. Model calls from `doctor`, `sample`, and `evolve`, and custom LLM judges still use the old `{ model, system, prompt }` adapter interface. Do not use a script implementing only this section's protocol for those model calls. Configure a supported judge separately through `--judge-models` when needed.

## Diagnose a failed run

Start with execution/scoring coverage and specific reason codes before interpreting model output. `OMK_CODEX_CLI_UPGRADE_REQUIRED` means the CLI cannot run the selected model: check `codex --version`, upgrade, and rerun the same model and cases. Changing the model does not verify that the original knowledge comparison recovered.

Codex `Reconnecting...` events are transport notices. A call succeeds only after a valid completion event and answer; terminal failures, missing completion, and unknown errors still block evaluation. This fix versions the Codex executor and judge adapter identities: older versions may have counted recovered calls as failures. Do not pool results across that boundary as identical measurement conditions; rerun the complete comparison.

`--retry` retries only error codes allowed by the sealed policy, which defaults to `timeout` and `transport-error`. Custom services should classify the actual cause instead of relabeling every business failure as a transport error to obtain retries.

## Prerequisites

The base OMK install omits the optional Agent SDK packages and their large platform binaries. The default `claude` / `codex` CLI executors, API executors, custom executors, and the DSH host plugin do not need them. Install an SDK in the same scope as OMK only when you explicitly select its `*-sdk` executor.

- **claude**: install [Claude Code](https://claude.ai/code) and authenticate
- **claude-sdk**: install the optional Agent SDK locally with `npm i @anthropic-ai/claude-agent-sdk@^0.3.143`, or globally beside a global OMK install with `npm i -g @anthropic-ai/claude-agent-sdk@^0.3.143`; then authenticate Claude
- **codex**: install the Codex CLI (`npm i -g @openai/codex`) and authenticate
- **codex-sdk**: install the compatible optional SDK locally with `npm i @openai/codex-sdk@^0.149.0`, or globally beside a global OMK install with `npm i -g @openai/codex-sdk@^0.149.0` (it bundles the `@openai/codex` binary)
- **DSH plugin**: install `oh-my-knowledge` into an existing command-capable DSH profile and use `/omk eval <eval.yaml>`
- **anthropic-api**: set the `ANTHROPIC_API_KEY` env var
- **openai-api**: set the `OPENAI_API_KEY` env var

## Related

- [Artifact & variant layout](./artifact-layout) — how `variant` resolves to an artifact + runtime context
- [Evaluate an agent](../guides/agent-eval) — source-neutral agent evaluation and intentional project context
- [Use non-Claude models](../guides/non-claude-models) — GLM / Qwen / DeepSeek / Moonshot / Ollama
