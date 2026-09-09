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
