# Evaluation Runtime Adapter

> **Status**: binding assembly, verified resource leases, and the Core composition root for [#457](https://github.com/lizhiyao/oh-my-knowledge/issues/457). It is additive and does not switch the production `omk eval` pipeline.

## Boundary

The OMK host consumes the complete output of `compileCliEvaluationInput()` and performs effects outside Evaluation Core. Binding assembly does not create a second plan, reinterpret CLI input, or trust a registry declaration as actual Runtime identity.

```text
       compileCliEvaluationInput()
                    │ complete immutable result
                    ▼
       createOmkEvaluationRuntime()
                    │
        ┌───────────┼────────────────┐
        ▼           ▼                ▼
 binding entries  support ports  run lease registry
        └───────────┼────────────────┘
                    ▼
       createEvaluationEngine().prepare()
                    │ actual identity and capabilities
                    ▼
              SealedRunPlan
```

Independent Series analysis is assembled as `EvaluationSeriesRuntimePorts`; it never enters `EvaluationEngineRuntimeBindings`.

## Binding coverage

Assembly requires one exact binding for every:

- Target executor and Evaluator reference;
- AnalysisGraph node and the separate Sampling Estimator requirement;
- MissingPolicy and DecisionPolicy reference;
- Series analysis node and Series decision policy reference.

An analysis binding carries both `referenceId` and Core's `requirementKind`. Sampling Estimator is therefore not inferred from an AnalysisGraph node or silently resolved from a fallback registry.

This complete shape is `omk.runtime-binding-request/v3`. The superseded v2 request lacks the canonical Target execution requirements and is rejected rather than read through a compatibility branch.

Before invoking any factory, assembly validates unique binding IDs and reference keys, exact Definition／Series coverage, implementation and version constraints, executor protocol／model／effort／behavior digest, evaluator measurement／config digest, and resource lease requirements. A validation failure causes zero factory calls.

## Immutable entries and identity

Assembly first clones and deep-freezes Definition, Series, and RuntimeBindingRequest. Each implementation factory is selected by `implementationId`, but it is called once per binding so two references using the same implementation receive distinct port instances.

The factory returns the actual port identity and version-resolution result. Assembly validates the port shape and implementation identity, captures an immutable identity snapshot, and wraps the port methods around the original instance. Executor binding validation also requires exact equality with `TargetDefinition.executionRequirements`; the qualification object reuses that canonical value rather than re-deriving feature semantics. The Core preparation resolver and the captured execution port are then projected from the same entry; later registry or request mutation cannot create split-brain resolution. Only Core compares those requirements with the actual port capability manifest.

Every entry records:

- the complete binding and actual `RuntimeResolution`;
- the captured port;
- explicit resource lease requirements;
- a binding-local `sessionIsolationKey` derived from the complete binding and passed to its factory.
- for Executor and Evaluator factories only, a binding-scoped resource access view that resolves the current Core `runId` and cannot enumerate another binding or analysis-only resources.

Adapters combine `sessionIsolationKey` with Core's `runId` and `trialId`; it is not permission to pool state across runs or bindings.

## Same-process Runtime adapter

`createSameProcessExecutorAdapter()` and `createSameProcessEvaluatorAdapter()` are the reference bridge for binding-local in-process implementations. The host must supply an explicit `RuntimeIdentity` and every lifecycle callback; the adapter does not infer capabilities from the Definition or provide a scoring algorithm.

At construction, the bridge validates and freezes the identity, captures the lease resolver and callback functions, and derives separate content-addressed isolation keys for each run and trial／evaluation record. Later mutation of a factory object therefore cannot change the executing implementation behind an already sealed identity. Duplicate active run and operation identities fail closed, and every disposal callback is invoked at most once even when callers race or retry cleanup.

The Core attempt `AbortSignal`, trial seed, target／Evaluator configuration, verified binding lease, and optional result usage are forwarded without reinterpretation. Missing usage stays missing. The bridge has no timeout, retry, budget, cache, or cancellation race of its own; those remain exclusively owned by the sealed Core policy, and a cooperative implementation must settle its underlying operation after the forwarded signal aborts.

Composition-root conformance uses implementations under the `test.*` namespace whose outputs are derived from their inputs and bindings. They exercise real Core prepare and run paths but are not exported or represented as production Executor／Evaluator algorithms.

## Custom-command Runtime adapter

`createCustomCommandExecutorAdapter()` is the reference out-of-process bridge. It accepts one absolute executable path plus an explicit argument vector, complete classified child environment, and an ephemeral-run or workspace-overlay working-directory policy. Every environment entry is classified as public behavior identity, credential, or effect locator. Behavior identity enters Runtime facets; credential and locator values are neither persisted nor hashed. The adapter never invokes a shell, searches `PATH`, inherits `process.env`／`process.cwd()`, parses a command string, or accepts an arbitrary live directory. Without a workspace lease it creates and later removes a private per-run directory. These choices remove ambient host state, mutable directory locators, and quoting rules from the execution contract.

Each attempt starts one process and sends one canonical `omk.custom-command-exchange/v1` JSON document on stdin. The document contains only Core run／trial／attempt context, content-addressed isolation keys, and the current binding's verified resource-lease projection. Resource entries are canonical by resource ID. A requested workspace working directory must resolve to that exact binding's copy-on-write overlay. Gold classification and analysis-only resource kinds fail before process creation. The response is a strict, source-neutral versioned document: completed output／trace and reported usage are optional; a structured failure exposes only stable code and execution／infrastructure stage. Unknown usage remains absent, extra fields and malformed JSON fail closed, and child stderr never enters the Core error.

This first process-per-attempt contract supports exactly `omk.invoke/v1`. It does not claim `omk.session/v1`; a session adapter must own one isolated per-trial session lifecycle instead of pretending that independent child processes preserve conversational state.

The adapter passes the exact Core attempt `AbortSignal` to the process coordinator, which terminates with SIGTERM and a bounded SIGKILL fallback and waits for child settlement. Cancellation remains authoritative even if a child traps SIGTERM and exits zero. There is no adapter timeout, retry, budget, or cache. A separate explicit byte limit bounds each output stream as host memory protection; that limit is part of Runtime implementation facets rather than measurement Policy.

Custom-command identity is deliberately conservative. Assembly resolves it afresh without a process-level cache. When the host identifies local implementation files, the adapter hashes their actual bytes, records canonical role／digest／size evidence, and reverifies them before every spawn; because the adapter cannot prove that the caller's file list is exhaustive, assurance remains `declared`. Without content evidence, basis is `opaque` and assurance is `unknown`. Arguments, executable-path digest, classified environment identity, working-directory policy, output limit, exchange version, process composition, and identity coverage are captured as non-secret implementation facets. A command string or path alone can therefore never produce `verified` identity. Capabilities are a fixed factory-owned manifest, not synthesized from Target requirements, and must honestly declare this adapter's best-effort cancellation and per-invocation stateless lifecycle.

## Codex CLI Runtime adapter

`createCodexCliExecutorAdapter()` is the first provider-family Core adapter. It binds one compiled Target and its exact Executor binding; target ID, implementation ID, protocol, execution requirements, behavior digest, model, and effort must agree before identity resolution. It supports only `omk.invoke/v1`. Each Core attempt launches a fresh `codex exec --json` process with the sealed model／effort, the binding's workspace overlay or a private per-run directory, and a canonical `omk.codex-cli-prompt/v1` JSON envelope. The envelope contains only the knowledge artifact, sample input, and execution context exposed by `ExecutorTrialContext`; expected output, evaluation context, analysis membership, and Gold never enter the adapter. A file artifact becomes one explicit instruction field. A directory artifact must have a root `SKILL.md`: only that entrypoint is instruction-bearing, while the remaining canonical-path-ordered UTF-8 files are projected as supporting resources and are not promoted to instructions. Missing entrypoints, non-UTF-8 files, symlinks, and special entries fail closed. This preserves the semantic distinction between normative instructions and supporting assets across Codex CLI's single-prompt boundary instead of concatenating the whole tree into a larger instruction; it does not claim native filesystem-backed skill loading.

The process controls follow the current [Codex CLI reference](https://developers.openai.com/codex/cli/reference) and [non-interactive execution guidance](https://developers.openai.com/codex/noninteractive): ephemeral session, ignored user config, ignored project／user execpolicy rules, strict config parsing, non-interactive approval, explicit sandbox, explicit working directory, JSONL output, and closed stdin. The child receives a complete classified environment rather than `process.env`; Codex-created shell commands additionally inherit no host environment. The adapter has no timeout, retry, budget, or cache. It forwards Core's exact `AbortSignal` to the subprocess coordinator and waits for SIGTERM／SIGKILL settlement.

Codex identity is resolved on every adapter assembly. The adapter hashes the actual executable plus explicitly listed implementation files, executes that exact captured launcher with `--version`, checks that the bytes did not change during the probe, and reverifies them before every attempt. The version probe has a separate bounded assembly-safety timeout recorded in implementation facets; it is not a measurement attempt timeout and cannot cancel or retry provider work. The evidence is content-derived, but assurance remains `declared`: a wrapper or caller-supplied file list cannot prove that every native helper, dynamic library, remote deployment, or server-side model revision is covered. Model, effort, behavior digest, adapter composition, prompt projection, fixed controls, limits, classified environment identity, and launcher identity are retained as implementation facets even when they are not part of the binary-content fingerprint.

The capability manifest is intentionally narrower than the legacy CLI executor. It declares prepended system instructions, optional source-neutral trace／usage, copy-on-write workspace, runtime-default tools／skill discovery, best-effort cancellation, and the two explicit read-only／workspace-write sandbox IDs. Execution is serialized because trials in one binding share the run-scoped workspace overlay; claiming parallel safety would allow cross-trial filesystem interference. It does **not** claim deterministic seed control, MCP config, mock interception, tool allow-list, skill disable／allow-list, provider cost, or session protocol. Core therefore rejects a Target requiring any of those features before a provider call. In particular, Codex is stochastic and exposes no exact sampling seed through the current CLI／[configuration surface](https://developers.openai.com/codex/config-reference); a controlled seed-coupling design must not be made to pass by merely adding the trial seed to a prompt.

The JSONL boundary is strict about event／item families, lifecycle closure, terminal status, final assistant output, and safe token counts. Provider events are projected to the existing source-neutral turn／tool-call trace; raw events and stderr are not returned to Core. Missing usage and provider cost remain absent. Reported input／output tokens are preserved, cached／reasoning tokens remain named details, and a trustworthy terminal usage record may accompany a redacted failure without converting it into success. `createCodexCliCoreSchemaValidators()` exports validators derived from the same input／output／trace contracts used to compute the advertised schema identities, so the composition root does not need a permissive or independently maintained provider-schema registry.

## Claude CLI Runtime adapter

`createClaudeCliExecutorAdapter()` binds one Claude Code process-per-attempt Runtime to `omk.invoke/v1`. The Target, binding, model, supported effort, execution requirements, behavior digest, and exact resource requirements are captured before probing the executable. Each attempt receives a private `CLAUDE_CONFIG_DIR`, a canonical user envelope on stdin, and an optional native system-instruction file created from the verified artifact entrypoint. Directory artifacts require root `SKILL.md`; other UTF-8 files remain explicitly labelled supporting resources in the user envelope and are never promoted to system instructions. Expected answers, evaluation context, analysis membership, and Gold resources do not cross the Executor boundary.

The launch contract follows the current [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage), [settings precedence](https://code.claude.com/docs/en/configuration), and [memory controls](https://code.claude.com/docs/en/memory): stream JSON, verbose events, no session persistence, no Chrome integration, no ordinary user／project／local setting sources, strict explicit MCP configuration, disabled CLAUDE.md／auto-memory, literal rather than implicitly expanded `@file` input, disabled persistent background work, disabled updater, and disabled nonessential traffic. Prompt content is not placed in argv. These narrow controls preserve explicit runtime-default skills／plugins; the broader `--bare` mode is not used because it would silently contradict that advertised capability. Assembly rejects versions older than the adapter's audited baseline, prerelease builds, or an exact launcher whose help surface omits any required flag. The child receives only a complete classified environment plus adapter-owned controls; it never inherits `process.env`. Because child tools can inspect that environment, credential entries taint output／trace as secret and effect locators taint them as sensitive. Host-managed settings, managed instructions, and managed MCP policy are deliberately not claimed to be suppressible. Because they and the remote model deployment remain opaque, identity assurance is `declared` even though the executable and every declared implementation file are content-hashed and reverified before spawn.

Native MCP config, PreToolUse mock interception, built-in tool allow-lists, runtime-default skill discovery, and complete skill disablement are supported only in combinations the CLI can enforce. Unsupported combinations fail during adapter assembly or run opening: a built-in allow-list cannot be presented as a complete policy while dynamic MCP tools exist, MCP mock server names cannot collide with sealed MCP config, non-empty skill allow-lists are rejected, and no sandbox ID is advertised. Mock payloads come only from verified leases, are materialized afresh for every retry attempt, and are removed after the child settles. The configured Node launcher is itself content identity and is not introduced into PATH or Runtime identity when mock interception is absent.

Capabilities remain fixed and source-owned: serialized stochastic execution, best-effort cancellation, per-invocation stateless protocol, required source-neutral trace, optional usage and provider-reported USD cost, unsupported seed control, and no sandbox. The adapter owns only bounded stdin／stdout materialization, identity probing, process coordination, and cleanup. Core exclusively owns timeout, retry, cache, budget, and admission. JSONL requires one structurally consistent terminal result; malformed conversation records, inconsistent success flags, duplicate terminals, unsafe counters, overflowing cost, post-terminal conversation, and missing successful output fail closed without exposing stderr or provider error text.

## Claude SDK Runtime adapter

`createClaudeSdkExecutorAdapter()` binds the optional `@anthropic-ai/claude-agent-sdk` Runtime to the same Core protocol without routing through the legacy `ExecutorFn`. It follows the official [TypeScript Agent SDK contract](https://code.claude.com/docs/en/agent-sdk/typescript): every Core attempt creates a fresh `query()`, receives its own `AbortController` and private `CLAUDE_CONFIG_DIR`, consumes the native async message stream, and closes the query before attempt cleanup. Core remains the only timeout／retry／budget／cache owner. The adapter never uses the legacy process-level SDK cache, SIGINT subscriber, wall-clock timeout, debug transcript, or zero-filled usage fallback.

Assembly resolves the SDK package and its platform-specific bundled Claude Code package without a process-level identity cache. The SDK package tree, native package tree, manifests, entrypoint, and exact executable are content-hashed and reverified before each query; the SDK version and bundled Claude Code version are separate identity facets. The remote deployment and host-managed policy remain opaque, so assurance is `declared`. A trusted resolver seam exists only for offline conformance and alternative host resolution, and must provide the same minimum identity coverage.

The SDK receives a complete classified environment rather than `process.env`, an explicit empty MCP config when no MCP lease exists, disabled filesystem setting sources／CLAUDE.md／auto-memory／attachments／session persistence, strict MCP validation, Claude Code preset system instructions with the verified artifact appended, and the same canonical supporting-resource envelope used by the CLI family. Built-in tool allow-lists disable dynamic MCP tools; skill discovery is either runtime-default or fully disabled. SDK PreToolUse mocks are recreated per attempt and can intercept an MCP tool only when the matching server exists in the sealed MCP config. Output and trace inherit the strongest resource／environment classification. Provider messages share the strict Claude terminal／usage／trace parser but use SDK-specific schema identities and stable failure codes.

## Resource requirements

RuntimeBindingRequest records resource role and intended lease mode, not locators or content:

| Role | Lease mode |
|---|---|
| artifact, MCP config, mock payload, evaluator content | immutable snapshot |
| workspace | verified base plus copy-on-write overlay |

These are acquisition requirements only. The verified HostResource lease layer remains responsible for checking kind, classification, size, digest, actual bytes／tree, isolation, and exactly-once release before a port can open a run. Gold resources never appear in executor or evaluator binding requirements.

Lease acquisition snapshots all descriptors and binding requests synchronously before its first effect. It then materializes only resources requested by active bindings, copies source bytes into a private run directory, and verifies the private snapshot rather than continuing to consume the locator. Immutable snapshots are read-only. Each workspace binding receives its own writable overlay over a shared read-only base within that run; different runs never share writable state. The Node backend currently realizes this copy-on-write isolation contract as an eager private copy; the lease mode specifies isolation semantics, not a required filesystem mechanism. Gold is projected only through the analysis-host map.

File identity is SHA-256 over the consumed bytes. Tree identity uses `omk.tree-sha256/v1`: entries are sorted by relative path and framed by entry type, UTF-8 path, file size, executable／non-executable mode, and file bytes. Empty directories participate; symlinks and special files fail closed. Pinned Git additionally verifies the exact `HEAD` commit and a clean regular-file checkout; dirty, untracked, ignored, or submodule content is not accepted as commit content. Root `.git` metadata is excluded from both resolve-stage and lease-stage tree identity. A copied snapshot is accepted only when both its actual size and digest match the v2 descriptor. Acquisition failure cleans the partial run root; successful leases expose one idempotent `dispose()` promise and perform one underlying cleanup attempt.

Per-resource and whole-run byte／entry limits include writable overlays. Planned logical bytes are rejected before copying; entry limits are enforced while bounded resources are materialized. Errors carry stable codes and resource／binding identity but never include locator strings, secret bytes, or Gold content. Structurally valid inventory entries that no active binding requests are not opened, hashed, Git-probed, or copied; this preserves the no-Judge side-effect boundary.

The composition root acquires the complete active-binding lease before Core can call any `openRun()`. It validates exact binding and resource coverage, captures immutable map and descriptor snapshots, and only then registers binding-scoped access. Registration is removed after all Core port teardown has settled, followed by one lease-disposal attempt. Acquisition, cancellation-before-start, EventWriter construction, Core start, Core completion, and failure paths share the same idempotent cleanup promise. Duplicate active `runId` values are rejected before a second acquisition. Gold declared for exploratory post-hoc comparison is not materialized by the single-run Core composition; the separate analysis-host workflow requests that lease when it has an actual consumer.

## Core composition and support ports

`createOmkEvaluationRuntime()` consumes one complete `CliEvaluationCompileResult`; callers cannot pass a replacement Definition or Policy to `prepare()` or `start()`. The composition root validates the compiled canonical digests, snapshots all host-owned configuration, merges Core-owned Analysis schema validators and Runtime factories, assembles bindings, and invokes the real `createEvaluationEngine(...).prepare(...)`. It exposes the independent Series assembly separately rather than placing Series ports in the single-run engine.

Support ports are captured as bound immutable method views. Their presence is derived from the sealed Policy without changing it:

- non-disabled execution or evaluation cache mode requires the corresponding cache port and the exact stage-specific source locator compiled under `orchestration.cacheSources`;
- reference output or trace capture requires an Execution ContentStore;
- reference evaluator evidence requires an Evaluation ContentStore;
- an Evaluator that consumes reference-captured output or trace requires a ContentResolver;
- required EventWriter mode requires a run-scoped writer factory.

Clock and SchemaValidator contracts are checked before factory assembly. Core-owned Analysis validators are always present. A validator key must equal its complete schema identity; reusing one schema URI with another version, digest, or validator fails closed. Built-in Analysis, MissingPolicy, and Decision factories are merged by implementation ID, and a host factory cannot shadow a Core-owned implementation.

EventWriter is deliberately not stored in the static `EvaluationEngineRuntime`. For optional or required delivery, it is created after resource acquisition and before Core start, then passed through `PreparedEvaluation.start()`. Disabled mode never invokes the factory. Missing or malformed Policy-required ports fail before any Runtime factory or run port is invoked. An absent Judge binding therefore causes no Judge factory construction, credential read, connectivity probe, or resource materialization.

## Failure ownership

- malformed input, coverage, duplicate, Definition mismatch, missing factory, factory failure, and invalid port use stable `OmkRuntimeAssemblyError` codes before a Run starts;
- compiled-input, support-port, cache-source, schema conflict, writer construction, active-run, and host cleanup failures use stable `OmkEvaluationRuntimeError` codes;
- capability, schema, protocol support, identity assurance, and version satisfaction remain Core preparation errors;
- credentials, connectivity, and physical readiness remain separate adapter preflight concerns; verified resource materialization is a run-scoped host failure before Core starts;
- provider, session, attempt, cancellation, and dispose failures belong to Runtime ports after the Run starts.

This layer does not modify frozen prompts, scoring stages, statistical formulas, cache semantics, Bundle／Report schemas, or the legacy pipeline.
