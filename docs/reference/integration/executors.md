# Executors

An **executor** runs a sample against the system under test, using the selected knowledge artifact and execution conditions, and returns output and available execution evidence. `--executor` selects the invocation method: a CLI, SDK, HTTP API, or your executable adapter. Keep the model, executor, and execution conditions fixed when comparing knowledge versions. Reusing a sample file across executors does not make their runtime identities or scores interchangeable.

## Choose an input and executor

1. Write one [v3 sample set](../evaluation/eval-sample-format.md): put the task in `input`, execution conditions in `executionContext`, and references and checks in `expected` / `evaluationContext`. Choose `text`, `json`, or `messages` by the task data, rather than by whether the target is a prompt, RAG, skill, agent, or workflow.
2. Check the [input support matrix](../evaluation/eval-sample-format.md#input-and-adapter-support). CLI/SDK adapters accept text; API adapters also accept JSON and plain role history. For application protocols such as tool history, provide a [custom executor](#custom-executor). Input support does not imply tools, workspace access, or a particular output shape.
3. Keep the sample file and grading declarations fixed across version comparisons. Use `--samples ./eval-samples.json --executor openai-api`, or `--executor ./my-executor.mjs` for your adapter, with the chosen control, treatment, and model. `--dry-run` checks compilation and declared requirements; it does not prove the target will execute successfully.

## Built-in executors

| Executor | When to use | Description |
|---|---|---|
| `codex` | Codex / ChatGPT desktop coding tasks (CLI) | invokes `codex exec --json` (`@openai/codex` npm); best-effort tool trace; **costUSD not reported** (codex CLI does not emit USD; check usage externally) |
| `codex-sdk` | Codex agent eval (SDK) | uses `@openai/codex-sdk` with its bundled `@openai/codex` binary and streamed SDK events; **costUSD not reported** |
| `openai-api` | CI / no CLI; or route an OpenAI-compatible model | calls OpenAI HTTP API directly (needs `OPENAI_API_KEY`) |

`openai-api` supports a custom base URL through `OPENAI_BASE_URL`. Core evaluations use `/v1/responses`; auxiliary model calls and rubric judges use `/v1/chat/completions`. A base URL may end at the service root or `/v1`, with an optional trailing slash. Query strings, fragments, and embedded credentials are rejected. See [endpoint requirements](../../guides/integration/non-claude-models.md).

Auxiliary executors capture their environment when created. API diagnostics redact known credential values and Bearer/Basic credentials before shortening error previews; API responses are limited to 4 MiB, including streamed bodies. These limits do not redact successful output or raw traces, and do not identify every possible secret in provider text.

**BREAKING-RUNTIME / BREAKING-COMPARABILITY:** API judge provider identity now uses `omk.judge-provider-runtime/v3` and seals the `openai-chat-completions/v3` adapter, including refusal, filtering and truncation failure semantics. Other judge providers retain their existing v2 derivation. Node judge calls use the captured invocation environment; API judge identity also seals the endpoint digest, Chat Completions protocol, and response limit. Existing reports remain readable, but establish a new baseline before combining measurements across this runtime boundary. Prompt bytes and scoring formulas are unchanged.

### Structured output for auxiliary calls

The programmatic auxiliary `ExecutorInput` accepts an explicit `outputFormat`: `json-schema` supplies `{ name, schema }` and always requests strict decoding; `json-object` requests JSON mode; `prompt-json` relies on the caller's prompt without a provider format parameter. Omitting the field preserves ordinary text calls. These controls do not add CLI flags or change Core target execution.

| Executor | Supported output modes | `maxOutputTokens` |
|---|---|---|
| `openai-api` | `json-schema`, `json-object`, `prompt-json` | Sent as `max_completion_tokens` |
| `codex` | `json-schema`, `prompt-json` | Unsupported |
| `codex-sdk`, custom scripts and other hosts | No explicit mode in this adapter | Unsupported |

Unsupported explicit requests fail before execution. OpenAI schema mode sends `response_format.json_schema` with `strict: true`; a compatible endpoint or selected model may still reject it. Codex passes a private, temporary schema file through `--output-schema` and removes it after success, failure, timeout or cancellation. A schema only constrains output structure; the caller must still validate literal quotations, identities and other domain requirements. OpenAI strict schemas require every property to be required and every object to use `additionalProperties: false`; represent optional wire values with `null` and map them explicitly into the domain contract. See [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [Codex schema output](https://learn.chatgpt.com/docs/non-interactive-mode).

Each invocation makes one request; there is no automatic downgrade or retry. Failed results retain available assistant text and reported token buckets, including cache reads, alongside typed `failure` diagnostics and the existing display `error`. The original refusal channel is separately preserved as `refusal`; `output` prefers original content and falls back to refusal when content is absent. These raw fields are not diagnostic previews and may contain private text. Refusal, `content_filter` and output-limit truncation remain failures even when their text parses as JSON. HTTP diagnostics retain status and a valid bounded `Retry-After`; missing usage remains explicitly unreported. Callers own fallback, cancellation, cumulative budgets and durable attempt evidence, and must bind the chosen mode, schema and retry policy into their measurement identity. Cache-hit reporting does not guarantee the next request will hit the provider cache; see [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

The former built-in `gemini` executor has been removed because it did not expose the trace, isolation, mock, or cost evidence required for a trustworthy built-in integration. Existing `executor: gemini` configurations now fail explicitly instead of silently falling back to the custom-executor protocol. To keep using Gemini CLI, wrap it in a [custom executor](#custom-executor) that translates OMK's JSON stdin/stdout contract.

## Anthropic removal: BREAKING-RUNTIME / BREAKING-STORAGE / BREAKING-PROMPT

The built-in `claude`, `claude-sdk`, and `anthropic-api` executors and the optional Claude Agent SDK dependency are removed. Explicit old executor IDs fail; no provider or model is substituted. The default executor is now `codex` in every host. Update `executor`, judge entries, `OMK_EXECUTOR`, and model choices before starting a new comparison. Historical trace parsing remains read-only and available; existing execution evidence is not rewritten or treated as Codex evidence.

`omk install` targets Codex/AGENTS or an explicit `--dest`; it no longer installs into Claude Code. `CCV_PROXY_URL` and the Claude hook variable `OMK_MOCK_SETTINGS_FILE` are removed. Custom model-call scripts must consume their manifest or optional fake MCP config themselves. The sample-generation prompt is now `omk.sample-generation/v3`, with generated mocks forced strict; existing authored sample files are not regenerated.

User settings advance to `schemaVersion: 2`; Studio carrier measurements use `omk-carrier-measurement-v2`. Only current versions are read. Back up v1 files before migrating settings: retain the directory and language, select `codex` or `openai-api`, choose that executor's model explicitly, then set `schemaVersion` to 2. Old carrier measurement metadata remains on disk but is not loaded; keep the canonical run reports and create a new measurement preview. See [settings](../shared/settings.md). Changing executor or generated samples changes measurement conditions; establish a fresh baseline.

## Sample mock compatibility

The optional fake MCP server for custom scripts is version `0.0.2`. It applies every declared match condition, including exact and suffix file paths with `~` expansion, and shares `return_seq` positions across its processes for one invocation. Its hit keys use the declared mock tool and ordinal (`Tool:N`, including `*:N`). Shared counters are locked and published atomically; invalid state or a lock held for 5 seconds returns an MCP error instead of resetting the sequence. A crashed lock holder requires a fresh invocation. Existing evidence is preserved; rerun affected mock measurements to establish a new baseline.

`Sample.mocks` requires the executor to intercept a tool call before the underlying tool runs. Tool traces alone are not enough: an executor that can report `Read` after execution cannot safely replace that call with a fixture.

| Executor | `Sample.mocks` support |
|---|---|
| `codex` / `codex-sdk` | unsupported; the current CLI and SDK expose traces but no tool-interception hook |
| `openai-api` | unsupported |
| custom executor | legacy model-call scripts receive `OMK_MOCKS_FILE` / optional `OMK_MOCK_MCP_CONFIG_FILE`; scripts own interception and stats. Core target adapters consume sealed resource descriptors |

When the selected executor does not support interception, `omk sample` automatically generates mockless samples and removes positive evidence that would require a simulated call (`mock_hit`, `tools_called`, `tools_count_min`, `tool_input_contains`, and `tool_output_contains`). If a model still emits `environment`, its facts are moved into explicitly non-materialized `context` rather than discarded or presented as fixtures. `omk eval`, including `--dry-run` and `--skip-doctor`, rejects existing samples with mocks before any model call instead of silently turning harness incompatibility into a model failure.

`environment.files_available` is prompt context only. It tells the model what the task statement assumes; it does not create a file in `cwd`. Put a real fixture under the sample working directory when the task must read physical bytes.

## How the default runtime is selected

Precedence is: explicit CLI flag → `eval.yaml` → `OMK_*` environment preference → `codex`.

- When Codex is selected without `--model`, omk resolves the model from `$CODEX_HOME/config.toml` or `~/.codex/config.toml`: the `model` of the profile named by top-level `profile` (falling back to the top-level `model` when that profile omits it), otherwise the top-level `model`.
- The default judge uses the selected executor and evaluated model. Explicit `judgeModels` / `OMK_JUDGE_MODELS` remain authoritative.
- The same resolver covers `eval`, `doctor`, `sample`, `evolve`, and `observe inbox --llm-enhanced-review`.

To pin Codex in regular terminals, add this to your shell profile (for example `~/.zshrc`):

```bash
export OMK_EXECUTOR=codex
# Optional: export OMK_MODEL="your-codex-model"
# Optional: export OMK_JUDGE_MODELS="codex:your-judge-model"
```

Without the optional variables, the model comes from Codex config and the judge reuses the task model.

**Choosing:** use `codex` directly in Codex environments; it has the strongest measurement isolation. Use `codex-sdk` only when you specifically need SDK event streams. On CI with no CLI, use `openai-api`. For any other vendor, point `openai-api` at its base URL or write a custom executor. Compatible endpoint setup is covered in [OpenAI-compatible models](../../guides/integration/non-claude-models.md).

**Codex construct-validity notes:**

Core Codex adapters currently declare only `runtime-default` skill discovery. A strict `baseline` requests disabled discovery and is rejected before execution; it is not silently weakened to an empty injected prompt. Use two explicit artifact versions for a Codex comparison, or select `openai-api` for the bare-model baseline. User, admin and bundled skills can exist outside `cwd`; an empty working directory alone does not establish complete skill isolation. See [official skill discovery and per-skill controls](https://learn.chatgpt.com/docs/build-skills).

Auxiliary Codex CLI/SDK calls likewise reject explicit `allowedSkills`, including `[]`. Knowledge generation uses a private working directory to exclude project context, while retaining runtime-default skill discovery. Reasoning effort is forwarded to the CLI configuration or SDK `modelReasoningEffort`; the selected model must support the requested level.

- **Runtime fingerprinting**: `codex` uses the `codex` binary on `PATH`; `codex-sdk` uses the bundled `@openai/codex` binary resolved by `@openai/codex-sdk`. Core artifacts seal executor and evaluator Runtime identities, including the local binary or SDK evidence available to the host. A remote judge deployment remains `opaque/unknown` unless `eval.yaml` explicitly supplies `judgeModels[].deploymentRevision`; a supplied revision is only `self-reported/declared`. If Runtime identities differ, read the result as a runtime comparison, not just prompt/template behavior. See [Statistical rigor](../../explanation/statistical-rigor.md#_3-judge-debiasing-and-prompt-identity).
- **Config and session isolation**: before launch, omk resolves only the model from the local Codex config (the profile model when top-level `profile` selects one) and passes it explicitly. `codex` passes `--ephemeral` + `--ignore-user-config` + `--ignore-rules`. `codex-sdk` redirects `$CODEX_HOME` to a fresh tmp dir for every execution, copies `auth.json`, and removes the directory after the child exits; user config and prior SDK sessions therefore do not leak into the run.
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

This PoC exposes `/omk` through DSH's human-command registry, so the profile needs `ctx.commands` and a command adapter. The built-in `web` profile satisfies that requirement; headless, ACP, and JSON-RPC surfaces do not currently consume the command. `Sample.mocks` remains unsupported. The runtime fingerprint includes the DSH host version, OMK adapter version, provider, agent preset, effective tool schemas, and cleanup timeout. DSH does not expose a canonical digest for every plugin and policy, so the fingerprint is explicitly marked partially auditable and strict comparability checks emit a warning instead of claiming full runtime parity.

After cancellation, Core waits at most 5 seconds for host idle and at most another 5 seconds for session disposal. Adapter embedders can set `DshHostCoreConfiguration.cleanupTimeoutMs` to an integer from 1 through 2147483647 milliseconds; the value is part of the runtime fingerprint. A stalled host produces a diagnostic and cancellation or infrastructure failure rather than a successful attempt; stopping the wait does not prove that the host has terminated. The adapter implementation version is `2.0.2`; persisted evidence is preserved, but its runtime identity differs from earlier adapters. Studio uses the fixed default port 7799 or `OMK_REPORT_PORT`; concurrent observe commands share one startup and plugin disposal closes that server.

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

DSH observation compares opaque persistence revision tokens with `Object.is`. A host must return immutable tokens stable across unchanged snapshots (for example, strings). Fresh object tokens are not assumed structurally equal: three unstable reads fail explicitly. OMK cannot infer backend snapshot stability from similar serialized objects.

Start with execution/scoring coverage and specific reason codes before interpreting model output. `OMK_CODEX_CLI_UPGRADE_REQUIRED` means the CLI cannot run the selected model: check `codex --version`, upgrade, and rerun the same model and cases. Changing the model does not verify that the original knowledge comparison recovered.

Codex `Reconnecting...` events are transport notices. A call succeeds only after a valid completion event and answer; terminal failures, missing completion, and unknown errors still block evaluation. This fix versions the Codex executor and judge adapter identities: older versions may have counted recovered calls as failures. Do not pool results across that boundary as identical measurement conditions; rerun the complete comparison.

`--retry` retries only error codes allowed by the sealed policy, which defaults to `timeout` and `transport-error`. Custom services should classify the actual cause instead of relabeling every business failure as a transport error to obtain retries.

## Prerequisites

The base OMK install omits the optional Agent SDK packages and their large platform binaries. The `codex` CLI executor, API executors, custom executors, and the DSH host plugin do not need them. Install an SDK in the same scope as OMK only when you explicitly select its `*-sdk` executor.

- **codex**: install the Codex CLI (`npm i -g @openai/codex`) and authenticate
- **codex-sdk**: install the compatible optional SDK locally with `npm i @openai/codex-sdk@^0.149.0`, or globally beside a global OMK install with `npm i -g @openai/codex-sdk@^0.149.0` (it bundles the `@openai/codex` binary)
- **DSH plugin**: install `oh-my-knowledge` into an existing command-capable DSH profile and use `/omk eval <eval.yaml>`
- **openai-api**: set the `OPENAI_API_KEY` env var

## Related

- [Artifact & variant layout](../evaluation/artifact-layout.md) — how `variant` resolves to an artifact + runtime context
- [Evaluate an agent](../../guides/evaluation/agent-eval.md) — source-neutral agent evaluation and intentional project context
- [OpenAI-compatible models](../../guides/integration/non-claude-models.md) — GLM / Qwen / DeepSeek / Moonshot / Ollama
