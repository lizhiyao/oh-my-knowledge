# Integrate as a platform host (evaluation center)

**When do you need this?** You are building an enterprise "evaluation center" platform: the platform dispatches structured evaluation cases, scoring standards, and executor identifiers as tasks; execution-side Node scripts use eval-runtime to chain prepare → execute → score → report; process and results are written back to the platform so every evaluation kind reuses one standard flow. This guide defines the host-side integration contract: what to dispatch, how the execution side resolves implementations, how to write back the process losslessly, how to reload and re-score across processes, and how to govern comparability.

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
| Evaluation cases | Published schema `omk.eval-sample-set/v2` (entry `oh-my-knowledge/eval-samples`; resolve the schema file with `resolveEvalSampleJsonSchema`) | Compiled into `EvaluateInput.dataset.samples` |
| analyses / decision / policy / experiment / comparisons and other serializable measurement declarations | Published Core JSON Schemas (`oh-my-knowledge/eval-core/schemas/v1..v5/*`), resolved by file name at runtime with `resolveEvaluationCoreJsonSchema`; each file name maps to exactly one version directory, e.g. `evaluation-definition.schema.json` in `v5` and `measurement-policy.schema.json` in `v1` | Mapped to `EvaluateInput.analyses`, `decision`, `policy`, `experiment`, `comparisons` |
| executor / evaluator / judge / report logic | Dispatch only a "registry id + config + version digest"; never dispatch code | The execution side resolves the implementation from its own registry by id (next section) and injects it into `variants` / `evaluators` |

Versioning rules:

- The dispatched contract carries its own `schemaVersion`; adding or removing fields requires a version bump — never rely on implicit compatibility.
- **Changing scoring standards = changing measurement semantics.** Any change to rubrics, metric definitions, or decision thresholds must ship as a new contract version marked with `BREAKING-COMPARABILITY` semantics: results under the new version are not directly comparable with results under the old one and must be shown separately on dashboards.
- OMK parsing fails closed: no parser coercion, no filling in defaults, no silently dropping fields. Every published schema is strict; extra or missing fields in a dispatched payload fail during preparation instead of being "repaired" at run time.
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

When a registered implementation does not live in the execution-side process, you do not have to assemble your own subprocess protocol: `createSubprocessCommandExecutor()` from `oh-my-knowledge/eval-runtime/advanced` wraps "one command" into an Executor. The exchange protocol is the versioned `SUBPROCESS_COMMAND_EXCHANGE_SCHEMA_VERSION` (`omk.subprocess-command-exchange/v1`): the request is written to the child's stdin as one line of canonical JSON and the response is read back from stdout as one line of JSON; exceeding `DEFAULT_SUBPROCESS_COMMAND_MAX_OUTPUT_BYTES` (10 MiB) or `timeoutMs` terminates the child and fails closed. The executable path, arguments, and environment come from your own registry and are digested into the `command` identity facet; the child inherits only `PATH` plus the environment variables you declare explicitly.

It carries only the fields an `ExecutorInvocation` legitimately holds and never fabricates run/trial/attempt coordinates or an execution plan digest. Leased controlled resources in the invocation (workspace overlays, native MCP config, tool-call interception) fail closed, and declaring those capabilities is rejected at construction — use an in-process Executor when you need controlled resources. It is also not a plugin loader: OMK performs no implementation discovery, download, or dynamic loading, and registration plus version governance always stays with the host.

## Lossless process write-back

`EvaluationRunOptions.onEvent` is an **ordered, best-effort progress projection**: the buffer is bounded (`eventBufferCapacity`, default 256), the oldest pending progress events are dropped and the newest retained when the consumer falls behind, so event sequence numbers may show gaps; observer failure never changes the measurement end state. It is right for progress bars and **wrong for audit**.

Audit-grade write-back combines two fields:

- Declare the delivery mode in `EvaluateInput.policy.eventDelivery` when preparing or evaluating (the shape is `MeasurementEventDeliveryInput`, nameable from `oh-my-knowledge/eval-runtime/advanced`; on the façade you only write the literal): `writerMode` is `disabled` (the default), `optional`, or `required`, and `writerFailureMode` is `ignore` or `fail-run`. The pairing is strictly validated: `disabled` accepts only `ignore`, `required` accepts only `fail-run` and defaults to it, and `optional` defaults to `ignore`.
- Pass a writer in `EvaluationRunOptions.eventWriter` to persist every event one by one; the event shape is the published schema `evaluation-event.schema.json` (resolvable with `resolveEvaluationCoreJsonSchema`).

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

- **Events never change the measurement end state.** Whether write-back succeeds or fails, the result's verdict, scores, and evidence are unaffected; `required` + `fail-run` changes the run's pass/fail outcome, not measurement semantics.
- Consumer-side failures converge into `EvaluationEventConsumptionError` (code `EVAL_RUNTIME_EVENT_OBSERVER_FAILED` or `EVAL_RUNTIME_EVENT_STREAM_FAILED`). The error carries `runResult` with the Core end state, so the host can persist first and alert afterwards.

## Cross-process reload and re-scoring

The standard path for reloading a result in another process (re-scoring party, auditor):

1. **Save.** The execution side calls `saveEvaluationResult({ result, store })`: the result is written into the host-injected `ContentStore` as the versioned envelope `omk.eval-runtime.stored-result/v1`, always with classification `gold` and mediaType `EVALUATION_RESULT_MEDIA_TYPE`, and returns a `ContentDescriptor` reference.
2. **Re-prepare.** The other process runs `prepareEvaluation` with the same dispatched contract to obtain a `PreparedEvaluation`; its sealed plan digest is the admission ticket for reloading — a different contract yields a different plan digest and the load is rejected outright.
3. **Load.** `loadEvaluationResult({ prepared, reference, resolver, verifier })`. Beyond parsing content and checking digests, you must inject an independent `EvaluationResultVerifier`: the verifier must authenticate the envelope digest (`verifiedResultDigest` must equal the reference digest) and independently authenticate the provenance bundle, cache record, and policy execution digest sets. **A checksum-only verifier is insufficient** — storage integrity is not provenance trust. Verification failures close with `EvaluationResultStoreError`; JSON that fails `structuredClone` also closes with no partial recovery.
4. **Re-score.** Use `rescore` (reuse Execution, score again), `reanalyze` (reuse scoring, analyze again), or `redecide` (reuse analysis, decide again) as needed, or compare two canonical results with `assessComparability`.

For a runnable reference sample, see [`examples/eval-runtime/result-store.mjs`](https://github.com/lizhiyao/oh-my-knowledge/blob/main/examples/eval-runtime/result-store.mjs) (a file-backed ContentStore/ContentResolver over a temporary directory that checks digests at the store boundary, plus an independent audit-receipt verifier); the same flow from a single-process perspective is in [Restore a stored result in a new process](./eval-runtime#restore-stored-results).

## Comparability governance workflow

- **Identity facets enter the dispatch protocol from day one.** The executor's `executorId` / `version` / `fingerprintFacets`, the evaluator's `instrumentId` and implementation version, the judge's `judgeId` / `version`, and the digests of the schemas in use are all measurement identity — fixed fields of the dispatched contract, not afterthoughts.
- **Version the evaluation sample set too.** An `omk.eval-sample-set/v2` document carries its own `schemaVersion`, but `EvaluateInput.dataset` only has `datasetId`, the sample content, and optional `analysisCohorts` / `annotations` — no version field. Changing sample content changes the sealed plan digest (a cross-process reload requires the same declaration), while `datasetId` alone never tells you whether the gold answers were edited. Put the sample-set version and content digest into the dispatched contract as fixed fields and record them in `dataset.annotations`, so dashboards and `assessComparability` reasons can tell "same id, different gold" apart. A `rescore()` after correcting gold is a new measurement version and must be shown separately from the pre-correction results.
- **Scoring-standard changes go through versioning**: publish a new contract version → mark `BREAKING-COMPARABILITY` → show old and new results in separate dashboard partitions. In this repository, rubric judge prompts are frozen and governed by the `test/measurement-governance` prompt registry, and any byte drift is caught by tests; platform-owned judge prompts deserve the same freeze and version management.
- **Interpret the three `assessComparability` statuses independently**: `designStatus` (compatible / incompatible) covers whether the measurement designs are comparable; `evidenceQualificationStatus` (verified / conditional / rejected) covers whether evidence authentication is complete; `comparabilityStatus` (compatible / conditional / incompatible) is the derived overall verdict. A comparable design does not imply qualified evidence, or vice versa.
- **Partition dashboards.** Show incompatible results in a separate partition with their reason codes; never mix them into the same trend line as comparable results. Annotate conditional results with their limiting conditions.

## Gold and access control

Stored results are always classified `gold` — they contain raw outputs, traces, and the full evidence chain. The host `ContentStore` must enforce access control matching gold: least privilege, tenant isolation, and access auditing.

Copies written back to the evaluation center should be positioned as **dispatched config + derived state/views** (progress, verdict summaries, report projections) for display and lookup. The gold originals and their evidence chain stay in the controlled store; derived copies never replace them.

## Related reading

- [Use in a Node.js service](./eval-runtime)
- [Runtime API reference](../reference/eval-runtime-api)
- [Core API (advanced)](../reference/embedded-api)
- [Eval sample format](../reference/eval-sample-format)
- [Glossary](../reference/glossary)
