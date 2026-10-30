# Knowledge extraction storage dogfood

[中文说明](./README.zh.md)

## Purpose

Preview and capture one synthetic Source3 message through an explicit trusted host binding, then prepare and confirm four authored phases separately: source inventory, content, source coverage and entity associations. An actual example-runner Agent records a limited decision after coverage and before associations are prepared. The script saves one complete body and two associated entities, reopens their original records, and checks source bindings and entity search. “Alpha uses Beta” is teaching data, not a fact about real systems.

The script authors a Codex-shaped JSONL fixture locally. It does not run Codex, import a real conversation, or obtain a model-generated quality assessment. Format attribution is not execution evidence.

## Run

From this OMK source repository with Node.js 22 or newer:

```bash
yarn build:runtime
node examples/knowledge-extraction/run.mjs
```

The script uses the checkout's built internal application modules, not a public SDK entrypoint. Installing the npm package and copying this file is not a supported integration recipe. It needs no API credentials, Codex or model account, and never selects a provider executor.

The command prints one JSON line with `fixtureInvocations: 4`, `modelCalls: 0`, `workflowId: "knowledge-body-first/v4"`, `phaseKinds: ["source_ledger", "body", "source_coverage", "association"]`, `runStatus: "completed"`, `candidateCount: 1`, `entityCount: 2`, `sourceBindingVerified: true`, `entitySearchMatches: 1`, `reviewStatus: "pending"` and `associationReview: "pending"`. `sourceCoverageDecision: "proceed_with_limits"` and `sourceReviewActorKind: "agent"` describe the example runner's explicit demonstration-only opinion; `semanticQuality: "not_assessed"` remains separate.

Capture and preparation do not invoke the fixture. Every phase requires its own exact prepared `requestDigest`; the script also checks rejection without confirmation. Coverage keeps every delivered metadata/text unit, ledger item/facet and saved paragraph accounted for as unassessable. Unknown fact time remains unknown. The runner explicitly accepts those visible limitations for this authored demonstration, then separately prepares and confirms associations. Neither model analysis nor a successful save automatically supplies a decision.

The Source3 snapshot, Schema 4 journal, four complete authored original responses, source-ledger/coverage histories, body and entity/association histories live in one owned OS temporary directory. Reopening the completed source set invokes no fixture again. Success or failure removes that directory; the example does not write into itself, `.omk`, user knowledge workspaces or global settings. Missing provider token/cost measurements remain missing.

For isolated repository validation, `OMK_PACKAGE_ROOT` can select another checkout with current built artifacts. This override does not make internal module paths a public API.

## Evidence boundary

This deterministic application/storage demonstration checks bounded source selection, local preview/capture, separate request confirmation, complete source-unit inventories, host-located literal quotes, exact decision references, actor attribution, persistence, idempotent reopening and source-bound entity search. Source metadata quotations identify host-delivered metadata, not original excerpt text. Raw envelopes, host paths and capture time stay local.

The actual Agent decision is explicitly limited to exercising this authored example; it is not human review, Gold, factual certification or a semantic-quality pass. Body and association candidates remain pending and the body is not retained automatically. The example does not measure entity recall, identity semantics, model quality, provider decoding, retries, cost or cross-window resolution. Human and independent quality review remain pending; no saved candidate is promoted to a verified fact or changes `goldReady`.
