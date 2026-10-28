# Knowledge extraction storage dogfood

[中文说明](./README.zh.md)

## Purpose

Capture one synthetic source message, pass two authored responses through the production body-first application, save one complete knowledge body before its independent two-entity association, reopen them from disk, and check their original source bindings and entity search. The source says “Alpha uses Beta”; this is teaching data, not a claim about real systems.

The script authors a Codex-shaped JSONL teaching fixture locally; it does not run Codex or import a real conversation. Format attribution is not execution evidence.

## Run

From this OMK source repository with Node.js 22 or newer:

```bash
yarn build:runtime
node examples/knowledge-extraction/run.mjs
```

The script uses the checkout's built internal application modules. They are not a public SDK entrypoint; installing the npm package and copying this file is not a supported integration recipe. This example does not need API credentials, Codex, or a model account. It never selects a provider executor.

The command prints one JSON line with `fixtureInvocations: 2`, `modelCalls: 0`, `workflowId: "knowledge-body-first/v1"`, `phaseKinds: ["body", "association"]`, `runStatus: "completed"`, `candidateCount: 1`, `entityCount: 2`, `sourceBindingVerified: true`, `entitySearchMatches: 1`, `reviewStatus: "pending"`, and `associationReview: "pending"`. It also checks that reopening the same run does not invoke the fixture again and that the search result links to the saved knowledge. Missing provider token/cost measurements remain missing.

The source, evidence snapshot, two-phase generation journal with separate authored original responses, entity analysis, body history and independent association history are created in one owned OS temporary directory. The script removes that directory on success or failure; it does not write into this example, `.omk`, the user's knowledge workspace, or global settings.

For isolated repository validation, `OMK_PACKAGE_ROOT` can explicitly select another source checkout with current built artifacts. This override does not turn internal module paths into a public API.

## Evidence boundary

This is a deterministic, authored-response application/storage dogfood. It checks capture, literal quotations, host-assigned identity links, idempotent reopening, persistence, source provenance and entity search. Body segments carry complete prose and inline exact evidence; entity associations are separate derived candidates and cannot complete or rewrite the body. It does not measure entity recall, identity semantics, model quality, provider decoding, retries, cost, or cross-window resolution. Human review and independent review remain pending; the saved candidate is not promoted to a verified fact. The fixture is not a real model capture or a gold annotation and does not change `goldReady`.
