# Entity extraction capture tools

[简体中文](./README.zh.md)

These are repository tools, built with `yarn build:runtime` and run from a checkout with its current dependencies. They are not public SDK exports or additional `omk` commands. `entity-extraction-review.js` remains the existing offline review entry; the separate `entity-extraction-capture.js` entry prepares and executes explicitly authorized slots through the production `createExecutor` path. It needs the separately reviewed strict-wire module when built. No production prompt, run format, old capture/v1 or synthetic corpus format changes here.

The default, `prepare`, `check`, `replay` and `compare` send zero requests. Only `execute-one` can send, once for its declared next slot. Prepare a new directory outside the checkout:

```sh
node dist-scripts/bench/entity-extraction-capture.js prepare \
  --source /absolute/source.json --prompt /absolute/prompt.txt \
  --config /absolute/config.json --out /absolute/new-capture-directory
node dist-scripts/bench/entity-extraction-capture.js check --plan /absolute/new-capture-directory
```

`--review-bundle /absolute/frozen-review-directory` can replace `--source`. It validates the existing manifest measurement and corpus hashes, then binds the exact selected input and actual provider request anew. An old review measurement ID is source metadata; it never attests provider, endpoint or execution conditions. Do not tune prompts using reserved validation content. Real messages require the new source protocol below and their own permission, minimization and review.

## Source, configuration and identity

A new input file has `sourceVersion: "omk-entity-capture-source/v1"`, `provenance` containing `sourceKind` (`synthetic`, `public-redacted-real` or `private-real`), `originDigest` (`sha256:...`), a nonempty `transformation` description and `toolPolicy: "excluded"`. It has `review: {"human":"pending","independent":"pending","gold":"none"}` and a `cases` array. Each case contains a unique kebab-case `caseId`, `split: "development"`, nonempty `limitations`, and `excerpts`. Each excerpt contains `evidenceRef: "<caseId>:<recordIndex>"`, a nonnegative integer `recordIndex`, `eventKind: "message"`, `role: "user" | "assistant"`, and exact nonempty `text`. Tools cannot enter this protocol. A provenance declaration records a claim; the collector does not independently verify origin or certify redaction. Never relabel real text as synthetic or author synthetic text under a real-source label.

An official-endpoint configuration example (two slots) is:

```json
{
  "executor": "openai-api",
  "model": "gpt-5.4-2026-03-05",
  "profileId": "openai-gpt54-snapshot-context/v1",
  "timeoutMs": 300000,
  "maxOutputTokens": 4096,
  "maxCalls": 2,
  "maxTokens": 2108192,
  "outputMode": "prompt-json",
  "schemaName": null,
  "promptVariant": "v14-original",
  "caseIds": ["your-selected-case"],
  "split": "development",
  "repeats": 2
}
```

The plan freezes prompt raw UTF-8 bytes, source bytes/provenance, selection, input references and bytes, exact production request body, requested executor/model/endpoint/protocol, consumed configuration, timeout, output mode/schema, no-retry policy, call/token reservations, Node binary, built runtime/checker/collector, dependency lock, actual loaded Zod/Ajv versions and annotation guide identities. Credentials are never copied into evidence; each command freezes its environment, verifies its resulting endpoint/request against the plan and checks key presence before dispatch. Provider defaults, account identity, server-reported model/fingerprint and backend revisions are not attested. The host digest covers the current compiled runtime: rebuild changes invalidate a plan. Actual validator versions participate in the host identity in every output mode; this is not a byte identity of the entire node_modules closure. These are identity checks, not signatures against a malicious local operator.

`v14-original` requires the exact original prompt hash `sha256:e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399`. Changed v14 bytes require `v14-derived`; a new candidate uses `v15-candidate`. Strict mode additionally requires `outputMode: "json-schema"`, a valid `schemaName`, and `--wire-schema` with exact current wire bytes/hash. Original v14 examples are incompatible with nullable wire placeholders, so that combination is rejected. A candidate must adapt its examples separately. Nothing activates a new default or demonstrates quality gains.

## Hard limits and explicit permission

The frozen official profile accepts only the exact snapshot and `https://api.openai.com/v1/chat/completions`. It reserves the entire documented 1,050,000-token context capacity plus `max_completion_tokens` per call; the latter cannot exceed 128,000. This deliberately conservative reservation is never reduced using estimated or reported usage, including cache hits. The [official model contract](https://developers.openai.com/api/docs/models/gpt-5.4), [completion ceiling](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), and [token accounting](https://developers.openai.com/api/docs/guides/token-counting) are frozen as cited facts dated 2026-10-16, not an online availability/certification or price quote. This is a token/call limit, not a dollar ceiling. No model self-report establishes a bound.

The actual shared request builder fixes `n: 1`, `stream: false`, and the production fetch rejects redirects. It sends no tools, prediction or configurable retries. Unknown model/endpoint/profile combinations fail closed. Codex cannot enforce the requested output-token ceiling and is rejected before constructing its executor or invoking its binary. `loopback-test/v1` is restricted to an authored test model at HTTP `127.0.0.1`, advertises `loopback-test-only`, and proves only hermetic transport behavior. It never certifies a real service. After dispatch the CLI reports model calls as `not_attested` even for loopback: a local service could forward requests. Only the hermetic fake-transport harness proves zero model calls. Official execution rejects Node preload/loader injection.

`prepare` writes a **pending** permission template; generating it grants nothing. A human must review the frozen data, prompt, endpoint/model and budgets, then provide a separate permission file with `authorizationVersion: "omk-entity-live-permission/v1"`, `authorizationStatus: "granted"`, exactly matching plan/data/model/endpoint/budgets, `action: "send-frozen-selected-inputs-to-the-declared-model"`, nonempty `authorizedBy`, and valid `grantedAt`/future `expiresAt` ISO timestamps. No command generates a grant. Sending any real data/model requests still requires the user's authorization. An explicitly approved command is:

```sh
node dist-scripts/bench/entity-extraction-capture.js execute-one \
  --plan /absolute/new-capture-directory --permission /absolute/approved-permission.json \
  --authorize-plan sha256:THE_REVIEWED_PLAN_ID --slot your-selected-case-repeat-1
```

Each invocation requires one slot explicitly. Its exclusive active lock and durable reservation precede factory creation. The synchronous production dispatch gate rechecks permission expiry and frozen assets/request/host identities. A reservation permanently consumes a call and its full token budget even when the call fails, is cancelled or has unknown usage. An incomplete reservation or unknown/invalid usage blocks all continuation; never delete evidence to retry. A crash may leave an active lock, which also fails closed. Investigate offline and obtain a new reviewed plan/permission rather than automatically recovering or resending.

## Evidence and replay

Each slot keeps its reservation, **complete native `ExecResult` JSON** and attempt projection in separate files, with hashes. Native output/refusal is saved before parsing or admission; unknown usage projects to `null`, not zero. The full native result stays untouched, including its existing four cache/token buckets and failure classification. The production API already translates provider usage into these buckets. In v3, a missing `prompt_tokens_details.cached_tokens` becomes standardized `cacheReadTokens: 0` while overall usage can remain reported; this does not prove provider-reported zero or a cache miss. Per-bucket source-field presence is not archived. This does not archive the raw HTTP body, additional provider response fields, or an externally attested transport count. Diagnostic redaction follows the production executor; raw model output/refusal may contain sensitive text, so evidence directories/files are private (0700/0600). Do not publish them without review.

```sh
node dist-scripts/bench/entity-extraction-capture.js replay \
  --plan /absolute/new-capture-directory --out /absolute/new-replay-report.json
node dist-scripts/bench/entity-extraction-capture.js compare \
  --left /absolute/left-directory --right /absolute/right-directory
```

Replay revalidates host, source/input, plan, reservations and native evidence before using the current production checker. Refusals/truncations/filter/status failures cannot become success merely because their text parses as JSON. Strict-wire errors retain their diagnostics and original native text; itemwise host admission can still accept valid siblings. Invalid envelopes fail as a whole. Native strings that cannot round-trip as UTF-8 retain their exact native JSON and fail before encoding can replace an unpaired surrogate. Compare permits a prompt-byte contrast only when input, host/checker, executor/model/endpoint/protocol, mode/schema, configuration, retry and budgets match. It also replays both ledgers, rejects corrupted native evidence and reports per-slot outcomes, native digests and host-admitted proposal counts. These counts are checker diagnostics. It does not attest interleaving/pair order, semantic review or improvement. Plans retain pending semantic and independent human review; no output is automatically Gold.

Local fake-fetch/fake-binary checks exercise the actual executable and production factory with zero external/model requests. After integration, build current runtime and scripts, then use the existing test entry:

```sh
yarn build:runtime
yarn test test/executors/openai-api.test.ts test/scripts/entity-extraction-review.test.ts test/architecture/dependency-graph.test.ts test/architecture/production-reachability.test.ts
```

Online provider availability, authorization to send real inputs, paired scheduling and independent human review remain separate pending steps.
