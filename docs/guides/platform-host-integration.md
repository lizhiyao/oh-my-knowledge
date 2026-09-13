# Integrate as a platform host (evaluation center)

**When do you need this?** You are building an enterprise "evaluation center" platform: the platform dispatches structured evaluation cases, scoring standards, and executor identifiers as tasks; execution-side Node scripts use eval-runtime to chain prepare → execute → score → report; process and results are written back to the platform so every evaluation kind reuses one standard flow. This guide defines the host-side integration contract: what to dispatch, how the execution side resolves implementations, how to write the process back durably, how to reload and re-score across processes, and how to govern comparability.

If you only call `evaluate()` inside a single service, start with the [Node.js service guide](./eval-runtime); this guide assumes you already understand executors, evaluators, variants, and control/treatment roles.

## Positioning and boundaries

- **The host owns effects; Core owns measurement semantics.** Credentials, networking, storage, queues, and tenant isolation are all implemented by the platform host. OMK Core only expresses versionable measurement contracts and deterministic transformations; it never touches those effects.
- **Dispatch, queues, retries, resumption, and tenancy are OMK non-goals.** OMK does not provide task dispatch, cross-process queues, platform-level retries, checkpoint resumption, or multi-tenant isolation — build those in the platform. The retry inside `policy` is only attempt-level retry within one sealed measurement contract, not task rescheduling.
- **The canonical Report is not pluggable.** Report field semantics are the anchor of cross-version comparability and cannot be replaced with host-specific structures. Custom reports have exactly two paths: derive views from canonical results via `oh-my-knowledge/projections`, or put host metadata into the Report's existing host slots — `summaries` and `annotations` are passed as run options and land in the Report verbatim, and `extensions` is a Report field of its own.
- **Derived views never overwrite original evidence.** The platform may cache derived views to speed up dashboards, but the original results and evidence chain must be preserved intact, and every derived view must be regenerable from that evidence at any time.

## Dispatch mapping contract

`EvaluateInput` contains code injection points — `variant.execution.executor`'s `execute()` / `openSession()`, custom evaluator implementations, and the judge's `invoke()` are all callbacks. Therefore **`EvaluateInput` cannot and should not be serialized whole into a single wire schema**. Split the dispatched contract into three parts:

| Dispatched content | Carrier | Execution-side mapping |
|---|---|---|
| Evaluation cases | Published schema `omk.eval-sample-set/v3` (entry `oh-my-knowledge/eval-samples`; resolve the schema file with `resolveEvalSampleJsonSchema`) | Compiled into `EvaluateInput.dataset.samples` |
| analyses / decision / policy / experiment / comparisons and other serializable measurement declarations | Published Core JSON Schemas (`oh-my-knowledge/eval-core/schemas/v1..v5/*`), resolved by file name at runtime with `resolveEvaluationCoreJsonSchema`; each file name maps to exactly one version directory, e.g. `evaluation-definition.schema.json` in `v5` and `measurement-policy.schema.json` in `v1` | Mapped to `EvaluateInput.analyses`, `decision`, `policy`, `experiment`, `comparisons` |
| executor / evaluator / judge / report logic | Dispatch only a "registry id + config + version digest"; never dispatch code | The execution side resolves the implementation from its own registry by id (next section) and injects it into `variants` / `evaluators` |

Versioning rules:

- The dispatched contract carries its own `schemaVersion`; adding or removing fields requires a version bump — never rely on implicit compatibility.
- **Changing scoring standards = changing measurement semantics.** Any change to rubrics, metric definitions, or decision thresholds must ship as a new contract version marked with `BREAKING-COMPARABILITY` semantics: results under the new version are not directly comparable with results under the old one and must be shown separately on dashboards.
- OMK parsing fails closed on shape: no parser coercion, no silently dropping fields. Every published schema is strict, so an extra field or a missing required field in a dispatched payload fails during preparation instead of being "repaired" at run time. Omitted **optional** policy fields are the one thing OMK does complete: `prepareEvaluation` materializes each into its documented canonical default — an absent `policy.eventDelivery` becomes `writerMode: 'disabled'`, `writerFailureMode` follows `writerMode`, an absent `retry` becomes one attempt with no retryable codes — and seals the result into the Plan. Read the sealed `prepared.policy` back for the effective values; never assume the dispatched payload is verbatim what ran.
- The sample set's `requires` block (tools, files, environment variables, preflight commands) is host-side dependency preflight input and never enters Core measurement digests. The execution side must complete that preflight before calling a Target and fail closed, never degrading silently into "run whatever happens to work".

## id → implementation registry

The execution side maintains a versioned registry: resolve implementations by the dispatched id, and write versions and config digests into identity fingerprints.

```ts
import type { JsonValue } from 'oh-my-knowledge/eval-core';
import type {
  CustomEvaluator,
  EvaluationExecutor,
  Judge,
} from 'oh-my-knowledge/eval-runtime';

/** Published invoke/session Executor union — no need to assemble your own. */
type DispatchedExecutor = EvaluationExecutor<JsonValue, JsonValue | undefined, JsonValue>;

/** Implementation reference in the dispatched contract: id, version, config, digest — no code. */
interface DispatchedRef {
  readonly registryId: string;
  readonly version: string;
  readonly configDigest: string; // sha256 over the canonical JSON of config
  readonly config: Readonly<Record<string, JsonValue>>;
}

const executors = new Map<string, (ref: DispatchedRef) => DispatchedExecutor>();
const evaluators = new Map<string, (ref: DispatchedRef) => CustomEvaluator>();
const judges = new Map<string, (ref: DispatchedRef) => Judge>();

function resolveExecutor(ref: DispatchedRef): DispatchedExecutor {
  const build = executors.get(`${ref.registryId}@${ref.version}`);
  if (build === undefined) {
    // Fail closed: never downgrade and never substitute a "close enough" implementation.
    throw new Error(`unregistered executor: ${ref.registryId}@${ref.version}`);
  }
  return build(ref);
}

executors.set('executor:http-qa@2026.09.1', (ref) => ({
  executorId: ref.registryId,
  version: ref.version,
  // parse(value: unknown) validates and narrows only; it never rewrites canonical JSON.
  schemas: { input: parseQaInput, output: parseQaOutput },
  // Write the dispatched config digest and deployment facets into the identity
  // fingerprint so comparability assessment can tell "same id, different config" apart.
  fingerprintFacets: { configDigest: ref.configDigest, endpoint: ref.config.endpoint },
  async execute(invocation) {
    return callQaService(invocation.input, invocation.signal, ref.config);
  },
}));
```

Registry requirements:

- The registration key is `registryId@version`; any behavior-affecting change (config shape, dependency upgrade, prompt edit) must bump the version.
- Identity facets must be complete: executors declare `executorId`, `version`, and `fingerprintFacets`; custom evaluators declare `instrumentId` plus `implementation.implementationId` / `implementation.version` / `implementation.schemas.fingerprintFacets`; judges declare `judgeId`, `version`, and `fingerprintFacets`. These facets are the identity input to comparability assessment.
- **Capability self-declaration is an honesty obligation.** Determinism, concurrency safety, cancellation support, and trace/usage telemetry are all self-declared by the executor (use `createInvokeExecutorIdentity` / `createSessionExecutorIdentity` from `oh-my-knowledge/eval-runtime/advanced` to build the complete capability manifest). Declaring capabilities you do not have corrupts measurement conclusions and is harder to detect than a crash.

When a registered implementation does not live in the execution-side process, you do not have to assemble your own subprocess protocol: `createSubprocessCommandExecutor()` from `oh-my-knowledge/eval-runtime/advanced` wraps "one command" into an Executor. The exchange protocol is the versioned `SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION` (`omk.subprocess-command-exchange/v1`): the request is written to the child's stdin as one line of canonical JSON, and the child's **whole stdout must be exactly one response document** — a trailing newline is fine, but any extra output (a debug print, a progress line) fails closed with `OMK_SUBPROCESS_COMMAND_RESPONSE_INVALID`. Diagnostics belong on stderr, which is never parsed and only counted against the byte cap; exceeding `DEFAULT_SUBPROCESS_COMMAND_MAX_OUTPUT_BYTES` (10 MiB) per stream or `timeoutMs` terminates the child and fails closed. The executable path, arguments, and environment come from your own registry and are digested into the `command` identity facet; the child inherits only `PATH` plus the environment variables you declare explicitly. That inherited `PATH` is **not** part of the facet, so a bare executable name can resolve to a different binary on another host while the fingerprint stays identical — declare an absolute `executablePath` when the fingerprint has to pin the binary.

It carries only the fields an `ExecutorInvocation` legitimately holds and never fabricates run/trial/attempt coordinates or an execution plan digest. Leased controlled resources in the invocation (workspace overlays, native MCP config, tool-call interception) fail closed, and declaring those capabilities is rejected at construction — use an in-process Executor when you need controlled resources. It is also not a plugin loader: OMK performs no implementation discovery, download, or dynamic loading, and registration plus version governance always stays with the host.

## Official reference Executors

A `registryId@version` entry usually points at an `execute()` you wrote. When the "implementation" is really a vendor CLI, rewriting its protocol on the host side is where measurement bugs come from: a dropped `--ignore-user-config`, a different argument order, or a lenient JSONL parse all produce plausible answers whose provenance nobody can attribute. OMK therefore publishes its internal vendor adapters as **reference Executors** through `oh-my-knowledge/eval-hosts` — configuration in, a canonical façade `Executor` out, with no registry, discovery, download, or dynamic loading on either side. The Codex CLI adapter is the one shipped here today.

```ts
import {
  createCodexCliReferenceExecutor,
  type CodexCliEnvironmentEntry,
} from 'oh-my-knowledge/eval-hosts';

/** Reference factories are async: they probe the vendor binary before returning. */
const referenceFactories = new Map<
  string,
  (ref: DispatchedRef) => Promise<DispatchedExecutor>
>();

referenceFactories.set('executor.vendor-codex@2026.09.1', async (ref) => {
  const environment: Record<string, CodexCliEnvironmentEntry> = {
    // `behavior` puts a value into measurement identity, so a stable label here is an explicit
    // assertion that this entry does not move the measurement — the binary is already pinned by
    // the adapter's own `launcher` and `binary` facets.
    PATH: { value: process.env.PATH ?? '', identity: { identityKind: 'behavior', value: 'host-managed' } },
    // `credential` records nothing but lifts output and trace handling to `secret`.
    CODEX_SESSION_TOKEN: {
      value: await secrets.read('codex-session-token'),
      identity: { identityKind: 'credential' },
    },
  };
  return createCodexCliReferenceExecutor({
    executorId: ref.registryId,
    executablePath: String(ref.config.executablePath),
    model: String(ref.config.model),
    sandbox: 'read-only',
    environment,
    // Your dispatched config digest still belongs in identity, exactly as in the registry above.
    fingerprintFacets: { configDigest: ref.configDigest },
  });
});

const resolveExecutor = async (ref: DispatchedRef): Promise<DispatchedExecutor> => {
  const build = executors.get(`${ref.registryId}@${ref.version}`)
    ?? referenceFactories.get(`${ref.registryId}@${ref.version}`);
  if (build === undefined) {
    // Fail closed: never degrade, and never substitute a "close enough" implementation.
    throw new Error(`unregistered executor: ${ref.registryId}@${ref.version}`);
  }
  return build(ref);
};
```

What you get for free:

- **Identity assembled from observation.** `executor.version` is the probed vendor release, and the reserved `codexCli` facet records the adapter version, version floor, pinned runtime controls, launcher and binary digests, the classified environment, byte limits, the controls this seam hard-codes, and the input-projection version. Comparability assessment can then separate "same id, different vendor build" from "same vendor build, different config".
- **A supported knowledge-carrier projection.** The artifact's content string is rendered into the same versioned prompt envelope OMK's own host uses — byte for byte — so switching between the product host and your dispatch host cannot move the input.
- **Certification rather than self-report.** Run `checkExecutor()` from `oh-my-knowledge/eval-runtime` once per deployment against the assembled Executor: it drives success, failure, cancellation, cleanup, telemetry and measurement checks through the real Runtime façade.

What stays yours, and what fails closed:

- **Leased, plan-bound resources are out of scope at this seam.** Trial workspace overlays, native MCP configuration, pre-tool-call mock interception, per-trial tool allow-lists and `runtimeContext` projection each return a stable `OMK_CODEX_CLI_*_UNSUPPORTED` code with no spawn — the adapter refuses rather than running with weaker isolation than the plan sealed. A dispatch that needs them requires a host-owned adapter.
- **Vendor-side account and network isolation.** The adapter forwards only the environment you declare and gives each attempt a private temporary working directory; it cannot contain what the vendor process does over the network, or which account a credential belongs to.
- **Version-floor governance.** `CODEX_CLI_MIN_SUPPORTED_VERSION` records the lowest vendor release verified against the protocol, not a tested set of later releases. An incompatible upstream change surfaces as `OMK_CODEX_CLI_PROTOCOL_INVALID` or `OMK_CODEX_CLI_UPGRADE_REQUIRED` instead of a silently reinterpreted answer. Raising the floor raises the adapter version and belongs in your registry's version key, so a dashboard can tell the two eras apart.
- **Credentials and cost.** Reading, rotating and paying for the vendor call remain host-side; a credential entry only raises handling classification.

The export list, per-code meanings and drift rules are in the [Reference Executors API](../reference/eval-hosts-api).

## Durable process write-back

`EvaluationRunOptions.onEvent` is an **ordered, best-effort progress projection**: the buffer is bounded (`eventBufferCapacity`, default 256), the oldest pending progress events are dropped and the newest retained when the consumer falls behind, so event sequence numbers may show gaps; observer failure never changes the measurement end state. It is right for progress bars and **wrong for audit**.

Audit-grade write-back combines two fields:

- Declare the delivery mode in `EvaluateInput.policy.eventDelivery` when preparing or evaluating (the shape is `MeasurementEventDeliveryInput`, nameable from `oh-my-knowledge/eval-runtime`; on the façade you only write the literal): `writerMode` is `disabled` (the default), `optional`, or `required`, and `writerFailureMode` is `ignore` or `fail-run`. The pairing is strictly validated: `disabled` accepts only `ignore`, `required` accepts only `fail-run` and defaults to it, and `optional` defaults to `ignore`.
- Pass a writer in `EvaluationRunOptions.eventWriter` to persist events one by one in order; the event shape is the published schema `evaluation-event.schema.json` (resolvable with `resolveEvaluationCoreJsonSchema`). **Completeness is guaranteed only by `required`**: it turns a failed write into a failed run, so a hole in the process record is impossible to mistake for a complete one. `optional` + `ignore` is best-effort — the first failed write silently stops durable delivery for that stage, the run still completes, and nothing in the result reports the truncation, so never use it where the record is the deliverable.

```ts
const prepared = await prepareEvaluation({
  ...input,
  policy: {
    ...input.policy,
    // Audit run: writer failure = run failure; prefer failing over leaving holes
    // in the process record.
    eventDelivery: { writerMode: 'required' },
  },
});

const result = await prepared.run({
  eventWriter: {
    async write(event) {
      await auditLog.append(event); // append-only, one event at a time, no batch drops
    },
  },
});
```

Boundaries:

- **Events never change the measurement end state.** Whether write-back succeeds or fails, the result's scores and evidence — and its verdict when a Decision is declared — are unaffected; `required` + `fail-run` changes the run's pass/fail outcome, not measurement semantics.
- **`required` without an injected writer fails closed before any Target call.** Every Core stage checks the pairing: `evaluate()` and `prepared.run()` resolve with `status: 'failed'` and `error.code` `EXECUTION_RUNTIME_EVENT_WRITER_REQUIRED` at the `configuration` stage. `rescore`/`reanalyze`/`redecide` reject with the reuse boundary's own code and put the underlying Core code on `error.cause`: `EVALUATION_RUNTIME_EVENT_WRITER_REQUIRED`, `ANALYSIS_RUNTIME_EVENT_WRITER_REQUIRED`, and `DECISION_EVENT_WRITER_REQUIRED` respectively. The mirror case fails closed at the same shared guard, on both the standard and the reuse entry points: supplying a writer while delivery is `disabled` rejects with `EVAL_RUNTIME_INPUT_INVALID`.
- **A reuse rejection names its origin without leaking it.** `EVAL_RUNTIME_REUSE_INVALID` stays the single public code for the suffix boundary, but each rejection carries its own sentence and a redacted `cause` whose `failureKind` separates three sources: `configuration` (a run-configuration error, with the stable Core code in `cause.code`), `invariant` (OMK broke one of its own assertions), and `unknown` (anything a stage raised). Failures of the reuse premise itself — a source that does not match the new declaration — keep their distinct message and carry no `cause` at all, so "this stored result cannot be reused" never has to be inferred from a shared sentence. `cause` holds only those stable tokens, never the wrapped error's text, and it is non-enumerable, so it survives an `error.cause` read without entering a serialized payload.
- Consumer-side failures converge into `EvaluationEventConsumptionError` (code `EVAL_RUNTIME_EVENT_OBSERVER_FAILED` or `EVAL_RUNTIME_EVENT_STREAM_FAILED`). The error carries `runResult` with the Core end state, so the host can persist first and alert afterwards.

## Cross-process reload and re-scoring

The standard path for reloading a result in another process (re-scoring party, auditor):

1. **Save.** The execution side calls `saveEvaluationResult({ result, store })`: the result is written into the host-injected `ContentStore` as the versioned envelope `omk.eval-runtime.stored-result/v1`, always with classification `gold` and mediaType `EVALUATION_RESULT_MEDIA_TYPE`, and returns a `ContentDescriptor` reference.
2. **Re-prepare.** The other process runs `prepareEvaluation` with the same dispatched contract to obtain a `PreparedEvaluation`; its sealed plan digest is the admission ticket for reloading — a different contract yields a different plan digest and the load is rejected outright.
3. **Load.** `loadEvaluationResult({ prepared, reference, resolver, verifier })`. Beyond parsing content and checking digests, you must inject an independent `EvaluationResultVerifier`: the verifier must authenticate the envelope digest (`verifiedResultDigest` must equal the reference digest) and independently authenticate the provenance bundle, cache record, and policy execution digest sets. **A checksum-only verifier is insufficient** — storage integrity is not provenance trust. Verification failures close with `EvaluationResultStoreError`; JSON that fails `structuredClone` also closes with no partial recovery.
4. **Re-score.** Use `rescore` (reuse Execution, score again), `reanalyze` (reuse scoring, analyze again), or `redecide` (reuse analysis, decide again) as needed, or compare two canonical results with `assessComparability`.

For a runnable reference sample, see [`examples/eval-runtime/result-store.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/examples/eval-runtime/result-store.mjs) (a file-backed ContentStore/ContentResolver over a temporary directory that checks digests at the store boundary, plus an independent audit-receipt verifier); the same flow from a single-process perspective is in [Restore a stored result in a new process](./eval-runtime#restore-stored-results).

### Execute once, score later

When Target work must finish before the scoring standard exists — an annotation queue still running, a judge rubric still under review, or one execution serving several release candidates — split the two stages instead of reloading a scored Run:

1. **Execute.** `executeEvaluation(input, options)` runs only the Execution stage and resolves to an `ExecutedEvaluation` handle (`runId`, `executionPlanDigest`, `executionInputDigest`, the `ExecutionBundle`, `bundleOrigin: 'runtime'`). No Evaluator, judge, analysis, decision, or report is attempted.
2. **Seal.** `saveExecutedEvaluation({ executed, store })` writes the envelope `omk.eval-runtime.stored-executed/v1` under `EXECUTED_EVALUATION_MEDIA_TYPE`, always with classification `gold`. It carries Target evidence only — never hand it back to a Target as context.
3. **Re-admit.** `loadExecutedEvaluation({ reference, resolver, verifier })` checks storage integrity plus the host attestation and returns a handle with `bundleOrigin: 'store'`. Unlike a stored result, an execution envelope is declaration-agnostic: no plan digest is compared here, because one envelope is meant to serve many later scoring declarations.
4. **Score.** `scoreExecutedEvaluation(newInput, executed, options)` seals the new declaration, admits the envelope against it with the same Core rule `rescore` uses, and runs Evaluation onward with zero Target calls. Repeat per scoring version.

Two limits belong in the host's records, not in OMK:

- **Bind every scoring Run to the envelope it reused.** Persist `executed.bundle.bundleDigest` next to each scored `runId`. A dashboard that shows three scored Runs without saying they share one execution invites readers to treat three scoring versions as three independent measurements.
- **A re-admitted envelope cannot regain trust through storage.** A verifier that does not attest the provenance bundle leaves that status indeterminate: the scored Report still completes, but it may claim only `unknown` provenance and a declared Decision stays gated. Re-admission under a checksum-only verifier is a diagnostic path, not release evidence.

The runnable sample [`examples/eval-runtime/staged-execute-score.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/examples/eval-runtime/staged-execute-score.mjs) performs the whole split offline; the caller-side narrative is in [Split execution and scoring](./eval-runtime#staged-execute-score).

## Comparability governance workflow

- **Identity facets enter the dispatch protocol from day one.** The executor's `executorId` / `version` / `fingerprintFacets`, the evaluator's `instrumentId` and implementation version, the judge's `judgeId` / `version`, and the digests of the schemas in use are all measurement identity — fixed fields of the dispatched contract, not afterthoughts.
- **Version the evaluation sample set too.** An `omk.eval-sample-set/v3` document carries its own `schemaVersion`, but `EvaluateInput.dataset` only has `datasetId`, the sample content, and optional `analysisCohorts` / `annotations` — no version field. Changing sample content changes the sealed plan digest (a cross-process reload requires the same declaration), while `datasetId` alone never tells you whether the gold answers were edited. Put the sample-set version and content digest into the dispatched contract as fixed fields and record them in `dataset.annotations`, so dashboards and `assessComparability` reasons can tell "same id, different gold" apart. A `rescore()` after correcting gold is a new measurement version and must be shown separately from the pre-correction results.
- **Scoring-standard changes go through versioning**: publish a new contract version → mark `BREAKING-COMPARABILITY` → show old and new results in separate dashboard partitions. In this repository, rubric judge prompts are frozen and governed by the `test/measurement-governance` prompt registry, and any byte drift is caught by tests; platform-owned judge prompts deserve the same freeze and version management.
- **Interpret the three `assessComparability` statuses independently**: `designStatus` (compatible / incompatible) covers whether the measurement designs are comparable; `evidenceQualificationStatus` (verified / conditional / rejected) covers whether evidence authentication is complete; `comparabilityStatus` (compatible / conditional / incompatible) is the derived overall verdict. A comparable design does not imply qualified evidence, or vice versa.
- **Partition dashboards.** Show incompatible results in a separate partition with their reason codes; never mix them into the same trend line as comparable results. Annotate conditional results with their limiting conditions.

## Gold and access control

Stored results are always classified `gold` — they contain raw outputs, traces, and the full evidence chain. The host `ContentStore` must enforce access control matching gold: least privilege, tenant isolation, and access auditing.

Copies written back to the evaluation center should be positioned as **dispatched config + derived state/views** (progress, verdict summaries, report projections) for display and lookup. The gold originals and their evidence chain stay in the controlled store; derived copies never replace them.

## Related reading

- [Use in a Node.js service](./eval-runtime)
- [Runtime API reference](../reference/eval-runtime-api)
- [Reference Executors API](../reference/eval-hosts-api)
- [Core API (advanced)](../reference/embedded-api)
- [Eval sample format](../reference/eval-sample-format)
- [Glossary](../reference/glossary)
