# Embed the Evaluation Runtime

[中文说明](./README.zh.md)

## Purpose

This minimal Node.js ESM host injects an in-memory business invocation function through the `oh-my-knowledge` package root, compares two service deployments, applies deterministic exact-match scoring, and materializes an Evaluation Report. It does not load the CLI or read user configuration.

## Run

From this repository with Node.js 22 or newer:

```bash
yarn build
node examples/eval-runtime/run.mjs
```

The command prints one JSON line with `runStatus: "completed"`, an estimated treatment improvement of `0.6666666666666666`, a decided status, and the report ID.

To use it in a separate service, run `npm install oh-my-knowledge zod`, copy `run.mjs`, then replace the deterministic `executor` body with the service's Target invocation. Credentials, tenant authorization, queues, and storage remain owned by the host.

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
