# Reference Executors API (`oh-my-knowledge/eval-hosts`)

OMK's product host ships vendor adapters inside this repository. This subpath publishes them as **reference Executors**: plain configuration in, one canonical façade `Executor` out. A platform host keeps its own `registryId@version` registry and dispatches only an id plus config, while the vendor protocol itself — argument construction, JSONL parsing, process controls — comes from code OMK verified. `package.json#exports` is the supported boundary; the allowlist locks every value and type below in both languages. The entry is ESM-only, as every published subpath is, so a CommonJS host loads it with `await import()`. The published set today is the Codex CLI adapter alone — the other internal adapters stay private until each clears the same pilot bar.

## What this entry deliberately is not

- **No registry, discovery, download or dynamic loading.** OMK never resolves an adapter by name, fetches one, or loads code at run time. Registration and version governance stay with the host, exactly as in the [id → implementation registry](../guides/platform-host-integration) contract.
- **Not the private host seam.** `src/eval-workflows/hosts/adapters/**` and the composition, input-resolution and resource-lease layers are not exported; a deep import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The published entry reuses the sealed seam's vendor protocol code and exposes none of the seam's plan-bound machinery.
- **Not a capability upgrade.** Every capability that needs plan-bound authority — trial workspace overlays, native MCP configuration, pre-tool-call mock interception, per-trial tool allow-lists, runtime context projection — **fails closed** with a stable code instead of degrading to weaker isolation. Vendor-side account and network isolation remain the host's responsibility.
- **Not a compatibility promise for every vendor release.** `CODEX_CLI_MIN_SUPPORTED_VERSION` is the lowest vendor release this adapter was verified against; see the "Supported surface and version drift governance" section below.

## Exports

| Export | Purpose |
|---|---|
| `createCodexCliReferenceExecutor` | Assemble the Codex CLI reference Executor. Async because it probes the vendor binary before returning. |
| `CreateCodexCliReferenceExecutorInput` | The whole published configuration: `executorId`, `executablePath`, `model`, optional `effort`／`sandbox`／`environment`／`contentIdentityFiles`／`maxOutputBytes`／`maxPromptBytes`／`identityProbeTimeoutMs`／`fingerprintFacets`. |
| `CodexCliEnvironmentEntry` | One environment variable: `value`, plus an `identity` discriminator whose `identityKind` picks the Runtime identity role (`behavior` carries a public `value`, `credential`, `effect-locator`), and an optional `outputTaint` that raises output and trace handling independently of that role. |
| `CodexCliContentIdentityFile` | One extra content-addressed file to fingerprint: `{ facetId, path }`. |
| `CODEX_CLI_MIN_SUPPORTED_VERSION` | Vendor release floor enforced at assembly. |
| `CODEX_CLI_REFERENCE_ADAPTER_VERSION` | Version of this reference adapter, recorded in the identity facets. |
| `DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS` | Default bound for the assembly-time version probe. |

`executorId`, `executablePath` and a non-empty `model` are mandatory. The `codexCli` fingerprint key is reserved by the adapter: passing it in `fingerprintFacets` throws, so a host cannot overwrite vendor identity with its own labels.

## Assembly: what the factory refuses before you hold an Executor

1. **Configuration capture.** `executablePath` must be absolute and free of NUL; `model` non-empty; `sandbox` and `effort` from the published enumerations; limits positive integers; every `CodexCliEnvironmentEntry` validated and classified. A `credential` entry raises output and trace handling to `secret`, and the floor for this seam is `sensitive` — the value never enters an identity facet, only a digest of the classified entry does.
2. **Content identity capture.** Digests for the executable plus every `CodexCliContentIdentityFile`.
3. **Version probe.** One `--version` call under the declared environment within `identityProbeTimeoutMs`. A non-release string (for example `0.146.0-alpha.1` or `nightly`) is rejected as an unsupported format, and a release below `CODEX_CLI_MIN_SUPPORTED_VERSION` is rejected as below the supported floor. The probed release becomes the returned `executor.version`.
4. **Re-verification.** The identity files are re-read after the probe; drift throws instead of pinning a binary that already changed underneath.

The returned object is frozen and carries exactly the façade `Executor` fields: `executorId`, `version`, `schemas`, `outputClassification`, `traceClassification`, `outputMediaType` (`text/plain`), `traceMediaType` (Source-Neutral Trace), `capabilities`, `fingerprintFacets`, `execute`. Nothing provider-specific leaks through, and the self-declared capabilities are the honest ones for a stochastic vendor CLI: `determinism: 'stochastic'`, `cancellation: 'best-effort'`, `concurrency.safety: 'parallel-safe'`, `seedControl: 'unsupported'`, `telemetry.trace: 'optional'`, `telemetry.usage: 'optional'`, `telemetry.providerCost.reporting: 'unsupported'`.

## Execution: stable codes, no leaked provider detail

Each attempt runs in a private temporary working directory that is removed on every terminal path, and re-verifies the identity files before spawning. A non-cooperative vendor process receives SIGTERM and is escalated to SIGKILL. Provider stderr and raw stdout are never returned: the caller sees one stable code plus, when the protocol yielded them, the usage record.

| Code | Meaning |
|---|---|
| `OMK_CODEX_CLI_ISOLATION_UNSUPPORTED` | A leased workspace, MCP config, or mock-interception plan was handed to a seam that cannot honor it. No spawn happens. |
| `OMK_CODEX_CLI_TOOL_POLICY_UNSUPPORTED` | A per-trial tool allow-list was requested. |
| `OMK_CODEX_CLI_RUNTIME_CONTEXT_UNSUPPORTED` | Host `runtimeContext` values were provided; the carrier this seam projects is the artifact plus `executionContext`. |
| `OMK_CODEX_CLI_ARTIFACT_UNSUPPORTED` | The knowledge carrier is not a non-empty string this seam can hand over — a blank carrier, or a directory-shaped Skill. A `baseline` artifact with `content: null` legitimately runs with no carrier. |
| `OMK_CODEX_CLI_WORKING_DIRECTORY_UNAVAILABLE` | The attempt-private directory could not be created. |
| `OMK_CODEX_CLI_IDENTITY_CHANGED` | A fingerprinted file changed between capture and this attempt. |
| `OMK_CODEX_CLI_EXIT_NONZERO` | The vendor exited unsuccessfully without an upgrade signal. |
| `OMK_CODEX_CLI_UPGRADE_REQUIRED` | The vendor itself reported that this model needs a newer CLI. |
| `OMK_CODEX_CLI_TURN_FAILED` | The stream parsed but reported a failed turn; recorded usage is preserved. |
| `OMK_CODEX_CLI_PROTOCOL_INVALID` | The JSONL stream is not the protocol version this adapter understands. |
| `OMK_CODEX_CLI_OUTPUT_LIMIT_EXCEEDED` | Vendor output passed `maxOutputBytes`. |
| `OMK_CODEX_CLI_STDIN_UNAVAILABLE`／`OMK_CODEX_CLI_SPAWN_FAILED`／`OMK_CODEX_CLI_CANCELLED` | Process-level infrastructure failures, including a timed-out or aborted attempt. |

`OMK_CODEX_CLI_PROTOCOL_INVALID` is the drift detector for a newer vendor release: an unrecognized stream fails closed rather than reporting an answer OMK cannot attribute.

## Measurement identity recorded by the adapter

Facets live under `codexCli`, which the Runtime seals into the `host` half of the execution identity alongside its own `facade` facet. Same configuration plus same binary produces the same digest; anything that can move the model's answer moves the fingerprint.

| Facet | Contents |
|---|---|
| `adapter` | `adapterVersion`, `seam: 'eval-runtime-facade'`, `sourceProtocol: 'codex exec --json'`, `cancellation: 'sigterm-then-sigkill'`, `processIsolation: 'per-attempt'`. |
| `version-floor` | `minSupportedVersion`, `probeTimeoutMs`. |
| `runtime` | `model`, `effort` (`null` when unset), `sandbox`. |
| `launcher` | Digest of the absolute `executablePath` — a byte-identical binary elsewhere changes this facet, not `binary`. |
| `binary` | `coverage: 'declared-files-reverified-before-spawn'` plus `{ facetId, digest, size }` per file. |
| `environment` | Classified entries: digests for values that must stay private, literal values where behavior is public. |
| `limits` | `maxOutputBytes`, `maxPromptBytes`. |
| `fixed-controls` | The controls this seam hard-codes: `approvalPolicy: 'never'`, `configMode: 'strict-ignore-user-config'`, `rules: 'ignored'`, `session: 'ephemeral'`, `shellEnvironmentInheritance: 'none'`, `workspaceRoot: 'attempt-private-temp-directory'`. |
| `input-projection` | `version: 'omk.codex-cli-prompt/v1'`, `promptSchemaVersion`, `artifact: 'content-string-only'`, `envelope: 'canonical-json'`, `executionContext: 'executionContext-field'`, `task: 'sample-input-verbatim'`. |

The knowledge carrier's **content bytes never enter runtime identity** by design: the carrier is what a controlled comparison varies, and pinning it would make control and treatment incomparable. The sealed plan still records the artifact digest, so the carrier is attributable without being part of Target identity.

## Supported surface and version drift governance

- **What OMK verifies in CI** is the adapter's own behavior against a protocol stand-in: argument construction and ordering, JSONL parse rules, usage and trace mapping, cancellation escalation, cleanup on every terminal path, identity drift, and each fail-closed code above. `checkExecutor()` from `oh-my-knowledge/eval-runtime` then certifies the published Executor through the real Runtime façade — success, failure, cancellation, cleanup, telemetry, terminal-status, coverage, evaluation-observation, paired-analysis and decision checks.
- **What CI cannot verify** is a vendor release: no vendor binary is installed here. `CODEX_CLI_MIN_SUPPORTED_VERSION` therefore records a floor, not a tested set, and OMK makes no claim about untested releases above it. An unexpected upstream change surfaces as `OMK_CODEX_CLI_PROTOCOL_INVALID` or `OMK_CODEX_CLI_UPGRADE_REQUIRED`, never as a silently reinterpreted answer.
- **The regression surface per adapter change** is the protocol stand-in at the floor release: the frozen `codex exec --json` event shapes, the argument vector, and each failure mode above (non-zero exit, upgrade decoy, malformed stream, oversized output, cancellation, identity drift). A host upgrading ahead of the floor treats that release as untested: run `checkExecutor()` plus a real Evaluation of its own fixtures before trusting cross-version comparisons.
- **Raising the floor** requires a verification run against the new vendor release plus a bump of `CODEX_CLI_REFERENCE_ADAPTER_VERSION`, and lands as a release-note callout: hosts pinned below the new floor must upgrade the vendor CLI or select another Executor. It does not by itself change measurement semantics, because `version-floor`, `binary` and `adapter` already partition fingerprints across the change.
- **Changing the input projection** — prompt envelope bytes, `fixed-controls`, or the meaning of any `codexCli` facet — changes what the model sees or how Target identity is derived. That is `BREAKING-COMPARABILITY`: bump `input-projection.version`, mark the PR, and expect old and new results to be shown in separate dashboard partitions.
- **Renaming, removing or reshaping** a published value, type or configuration field is `BREAKING-SCHEMA`: the allowlist test and both API references move in the same change, and no compatibility alias is kept.
- **Credentials, network egress, and vendor accounts** never enter this boundary. The adapter forwards only the environment you declare, and it digests rather than records anything classified private.

## Related reading

- [Integrate as a platform host](../guides/platform-host-integration) — the dispatch contract and a worked reference Executor recipe
- [Runtime API reference](./eval-runtime-api)
- [Executors](./executors)
- [Glossary](./glossary)
