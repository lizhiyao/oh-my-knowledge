# Embed the Evaluation Runtime

[中文说明](./README.zh.md)

## Purpose

The old and new answering services each answer three questions about capitals. The old version answers Kyoto for Japan; the new one answers Tokyo. OMK checks the answers, compares accuracy, and returns a report. Both versions use fixed simulated answers, with no model calls or accounts.

## Run

From this repository with Node.js 22 or newer:

```bash
yarn build
node examples/eval-runtime/run.mjs
```

The command prints one JSON line: `runStatus: "completed"` means the run finished; `estimate: 0.3333333333333333` means the candidate exact-match rate is about 33.3 percentage points above the control; `verdict: "NOISE"` means these three samples do not establish improvement or justify release. The output also contains the report ID.

To use it in a separate service, run `npm install oh-my-knowledge@next zod`, copy `run.mjs`, then replace `executor.execute()` with your service invocation and update its schemas, version, and actual capabilities. Follow the [integration guide](../../docs/guides/eval-runtime.md) for a first setup. Credentials, tenant authorization, queues, and storage remain owned by the host.

## Evidence boundary

The example proves that a public `eval-runtime` consumer can complete an in-memory control／treatment measurement without provider or filesystem configuration. Its three deterministic teaching samples are not representative, statistically powered release evidence, and the fake invocation does not validate a production model gateway's timeout, retry, privacy, or cost behavior.

## Mixed retrieval and abstention

This single-file example evaluates retrieval, appropriate empty results, false abstention, and forbidden-ID hits without external credentials.

```bash
yarn build
node examples/eval-runtime/retrieval-abstention.mjs
```

The unmodified example excludes one pending sample and executes two reviewed samples. Correct abstention is `1`; false abstention and forbidden hits are `0`. In a separate project, copy `retrieval-abstention.mjs` and install an OMK version containing this capability plus Zod. Use the corresponding source checkout for features that have not yet shipped.

To connect your system, replace `source`, adapt `executor.execute()`, then inspect each metric's `coverage`. Follow the [four-step guide](../../docs/guides/eval-runtime.md#retrieval-abstention) for data rules, return forms, capability declarations, and result interpretation.

## Result store and load trust boundary

This single-file example implements the host-owned storage ports (`ContentStore.put` / `ContentResolver.resolve`) over `node:fs` in an explicit temporary directory, persists one canonical result with `saveEvaluationResult()`, then simulates a second process that re-declares the same contract, restores the result with `loadEvaluationResult()`, and rescores it with a corrected Gold label without invoking the target again.

```bash
yarn build
node examples/eval-runtime/result-store.mjs
```

Storage belongs to the host: OMK never discovers, provisions, or scans host storage — the Runtime only calls the explicitly injected `put()` / `resolve()` ports, while credentials, tenancy, retention, and the physical root remain on your side. The example also demonstrates the restore trust boundary: the verified provenance-bundle, cache-record, and policy-execution digest sets come from a host-signed audit receipt witnessed at production time, never from re-parsing the stored envelope, and a checksum-only verifier is rejected fail closed. The in-process HMAC key stands in for your real signing／audit service (KMS, transparency log, attestation authority). The command prints the saved reference, the shared plan digest, and a rescore summary with zero extra target invocations.

To use it in a separate service, copy `result-store.mjs`, replace the file-backed store with your object storage or database implementation of the two ports, and replace the receipt verifier with your attestation backend. Certify only the digest sets your host can independently authenticate; the Runtime fails closed on anything unauthenticated.

## Split execution and scoring

This single-file example runs the Target once with `executeEvaluation()`, persists only the execution envelope with `saveExecutedEvaluation()`, re-admits it in a simulated second process through `loadExecutedEvaluation()`, and scores it twice with `scoreExecutedEvaluation()` under two Gold labels.

```bash
yarn build
node examples/eval-runtime/staged-execute-score.mjs
```

The example prints three scoring runs against a single execution: the as-declared Gold answers 2 of 3, the corrected Gold answers 3 of 3, and `targetInvocations` stays at 3 throughout. It also shows the boundary: a declaration whose prompt changed is rejected with `EVAL_RUNTIME_REUSE_INVALID` before scoring, a cloned handle is rejected, and an envelope re-admitted by a checksum-only verifier scores normally but can claim only `provenanceTrust: "unknown"`. Copy `staged-execute-score.mjs` and replace the receipt verifier with your attestation backend when execution and scoring run at different times or on different machines.
