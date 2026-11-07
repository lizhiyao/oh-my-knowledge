# Knowledge extraction storage dogfood

[中文说明](./README.zh.md)

## Purpose

Preview and capture one synthetic Source3 message, separately confirm the unverified writing draft and grounded body, then explicitly generate pending entities and semantic relations. The script saves one body, two entities and one relation, reopens records and checks source binding, graph output and entity search. Prior source coverage or a continuation decision is not required. “Alpha uses Beta” is teaching data, not a fact about real systems.

The script uses locally authored Codex-shaped JSONL and authored responses. It does not run Codex, import real conversations or call a model.

## Run

From this OMK source repository with Node.js 22 or newer:

```bash
yarn build:runtime
node examples/knowledge-extraction/run.mjs
```

It uses the checkout's built internal modules, not a public SDK integration recipe, and needs no API credentials or model account. For isolated validation, `OMK_PACKAGE_ROOT` may select another source checkout with current build artifacts.

Output includes `fixtureInvocations: 3`, `modelCalls: 0`, `workflowId: "knowledge-body-first/v10"`, `phaseKinds: ["body_draft", "body", "association"]`, `candidateCount: 1`, `entityCount: 2`, `relationCount: 1`, `sourceBindingVerified: true`, `entitySearchMatches: 1`, `reviewStatus: "pending"` and `associationReview: "pending"`.

Capture and preparation make no invocation; each transmission confirms its own exact requestDigest. Schema 10 journals, three complete authored responses and source/body/entity/association histories stay in an owned OS temporary directory. Reopening a completed source set makes no new call. Success or failure removes that directory without writing user workspaces or global settings; unmeasured tokens and costs remain missing.

## Evidence boundary

This deterministic application/storage demonstration checks source scope, request confirmation, host-located literal evidence, exact body versions, persistence, idempotent recovery, pending graph output and entity navigation. Raw envelopes, host paths and capture time stay local. Optional source review uses independent entrypoints and is not a prerequisite here.

`semanticQuality: "not_assessed"`. Content, entities and relations remain pending, without automatic retention. This does not establish real model quality, entity recall, cross-window identity, human experience or OMK net benefit. Unmeasured usage and costs are not zero; human and independent quality reviews remain pending.
