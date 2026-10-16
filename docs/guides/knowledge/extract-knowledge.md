# Accumulate, maintain, and use knowledge

Form candidates from selected work records, review and retain them in a library, revise outdated content, and maintain carriers that cite it. Retention, carrier saving, and effect verification have separate records. Start with Studio for a first use; CLI steps follow.

The core library, artifact authoring, and change review flow requires **1.0.0-beta.14 or later**. This guide describes current main. This round's CLI guidance, read retries, and save recovery fixes are not in the published Beta.14; use a subsequent `@next` release or build current source. Check `omk --version` after installation. Read the [migration guide](../maintenance/v1-preview-migration.md) before upgrading.

## Studio {#studio}

```bash
omk studio
```

Use the returned address and check the current knowledge location first. Changing the default directory does not move saved data.

1. **Select a source**: Open a conversation and choose extraction for a turn, or select a conversation from the knowledge page. Review messages, location, executor, and model before confirming. Only then is a model called, potentially incurring cost.
2. **Review candidates**: Read statements, conditions, exceptions, and unknowns; open source evidence. Record a reason to retain, discard, or revise. New revisions require review again.
3. **Review entities as needed**: Check names, references, levels, and original text from a candidate or entity list. Entity corrections do not rewrite knowledge; explicitly apply the exact revision after review.
4. **Accumulate across records**: Create an object in the knowledge library, check whether source entities from different windows refer to the same object, and confirm with reasons. Equal names do not merge identities; resolve ambiguity and missing sources first.
5. **Revise and update**: Carrier details show items requiring review after knowledge changes. Inspect revisions, retention changes, and sources item by item before selecting update content; old versions remain available.
6. **Generate and save a carrier**: Select matching retained knowledge, choose skill/prompt, check text and exact sources, and save a version. Generation organizes existing content without another model call. Updates rebuild the selected knowledge section while preserving manual content outside it and dependent assets.
7. **Verify a change**: Choose verification from carrier details, declare samples, control, and model, and confirm the preview before starting. Read execution and evidence status before conclusions; saving or use alone does not establish effects.

Candidate pages switch between content and source evidence; entity/library lists support narrow-screen switching. Failure, zero candidates, cancellation, and missing sources have explicit states. Extraction records and knowledge todos reopen saved content.

Library, entity, and artifact pages show the selected knowledge directory; reading an explicit directory does not require model settings. Retry failed reads in place while preserving organization entries. Entity application conflicts retain roles and reasons; reload knowledge before explicitly applying again. Generic server failures or unreadable acknowledgements do not prove no write occurred. Choose “Check saved version”: organization checks the request receipt, while artifacts check content and exact references, avoiding duplicate saves. Pending content stays read-only and copyable; saving and checking make no extra model calls.

### Automatic conversation extraction and project todos

Automatic extraction is optional. Preview the selected conversation's messages, location, model, and invocation/budget limits before authorizing transmission. Authorization is limited to that conversation, 24 hours, and the current service lifecycle. Every initial invocation, retry and validation reask consumes one slot from the conversation-wide `maxCalls`; a run with three invocations consumes three slots. An opted-in token reservation allowance also accumulates across all windows, while capping each run. Reservations are durable before dispatch, recovered from immutable receipts and never refunded, including unknown usage or interruption before sending. Changing the displayed scope, model or limits clears approval. Existing permissions without a policy remain single-invocation permissions; retries require a new explicit approval. Hard failure/interruption stops automation; a terminal transient failure can leave it waiting for a new stable window, without resending that source. An archived server Retry-After is persisted and checked before every dispatch, including new windows and renewed permissions; a wait exceeding the run retry cap is not shortened, and permission expiry still prevents dispatch. Invalid waits stop automation. A fully validated empty dispatch ledger can release a locally rejected source window for fresh explicit approval, without deleting its failed run or evidence; any reservation or uncertain acknowledgement retains source deduplication. Restarting does not resume it automatically. Todos gather candidates for review without deciding retention or rewriting carriers.

## Select and generate a source

CLI and Studio share a knowledge workspace. Declare source scope first: capture archives locally, while generate calls the selected model. Replace paths, identities, and models below with real values.

```bash
omk observe knowledge capture --workspace ./knowledge --source ./session.jsonl --json
```

```bash
omk observe knowledge source --workspace ./knowledge --snapshot <snapshot-id> --json
omk observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model> --json
omk observe knowledge list --workspace ./knowledge --json
```

Use `--start-record`/`--end-record` to bound non-empty records (zero-based and inclusive); inspect the snapshot scope and limits first. See [extraction contracts](../../specs/entities/entity-extraction.md) for supported executors and current formats. Generation sends selected excerpts, whose private content still needs review.

Before generation, the combined system and input text, including fixed rules and selected excerpts, is limited to 1 MiB in UTF-8. This is not an HTTP-body, token, model-context, or spending budget. Oversized requests make no model call, create no extraction run, and consume no automatic extraction calls; source text is never truncated. Capture a smaller range, or select fewer messages from one turn in Studio. `omk agents extract` also accepts `--start-record`/`--end-record` without changing the collection report.

Export the current build's derived JSON Schema to inspect or freeze the strict structural wire used by default generation; `--json` includes its identity and the checks retained by the host. This reads no knowledge workspace and calls no model:

```bash
omk observe knowledge schema
omk observe knowledge schema --json
```

The strict structural wire requires every field, with nullable placeholders for optional `object` and `occurrence`. Default generation uses that wire and decodes the placeholders before the existing host admission checks. Default configured generation uses no-few-shot strict prompt v15, with its full system digest; domain response Schema v4 is unchanged, and authored prompt-json ports retain original v14. Prompt, wire, rendered request and pipeline have separate identities; this activates no four-demonstration candidate and inherits no historical prompt-json quality result. No new real-model acceptance is claimed. Unsupported executor capabilities fail before dispatch, with no prompt-only fallback. Exact evidence and semantic checks remain the host's responsibility. Exporting a Schema does not verify a provider's support or model quality.

Generation defaults to `knowledge-generation-single/v1`: one OMK invocation, no automatic retry, validation reask or fallback. Studio's advanced configuration and CLI `--generation-policy '<complete policy JSON>'` explicitly opt into `knowledge-generation-bounded/v1`; the same flag is available on `omk agents extract`. A bounded policy declares `maxInvocations` (at most 3), `maxReasks` (at most 2, included in that total), `profileId`, `maxTotalTokens` and `maxOutputTokens`. It also freezes retry, accounting, selection, feedback and backoff rules; pass the complete policy rather than a partial override. Studio starts with that opt-in disabled and shows the effective limits before confirmation.

The production token profile `openai-gpt54-snapshot-context/v1` accepts only `openai-api`, requested snapshot `gpt-5.4-2026-03-05` and the exact official Chat Completions endpoint. It reserves the documented 1,050,000-token context upper bound plus the selected output cap for every invocation, not a prediction from text length. Studio's initial opt-in values are 3 invocations, 2 reasks, 3,162,288 reserved tokens and 4096 output tokens per invocation. Full reservations are charged without refund even when reported use is lower or unknown. Other endpoint/model combinations and Codex remain available under single policy but do not silently acquire this bounded profile or fall back to another provider. Invocation limits are OMK calls, not internal provider request counts or a dollar limit.

The bounded policy retries only classified rate-limit/server/network/timeout failures and can reask after parse/envelope/wire failures or an admission with no accepted items. Any admitted sibling selects that partial result without another call. Each returned outcome is archived before classification; unknown execution, pending archival and storage/commit failures do not authorize another dispatch. No new real-model quality or cost improvement is claimed by this engineering policy.

Default text summaries show the selected knowledge workspace and next commands carrying the same `--workspace`; without a configured model, `generate` still requires `--model`. `--json` preserves the complete machine result without mixing guidance into JSON stdout. Required parameters and JSON syntax are checked before settings or storage access: parameter failures exit `2`, business failures exit `1`, and success exits `0`. Revision conflicts include a reload command. Retry a busy workspace after its current write ends without removing live locks. Maintenance choices remain separate from effectiveness verification.

## Inspect and maintain {#inspect-and-maintain}


```bash
omk observe knowledge show --workspace ./knowledge --id <knowledge-id> --json
omk observe knowledge retain --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --reason 'Useful for later work on this project'
```

Read the revision identity and `history.generation` from the latest detail. `discard` uses the same arguments and records a reason without deleting history. On conflicts, reread and inspect changes before retrying.

For edits, copy only `title`, `content`, `entities` and `evidence` from the returned `revision` into a JSON draft. Edit titles, statements, context, or evidence interpretations. Change labels or assignments in bound analyses through the next section:

```bash
omk observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 2 --input ./draft.json --reason 'Clarify the applicable conditions'
```

Use the actual generation, not the example number. Edits create a new revision without inheriting the previous retention choice. Source positions remain bound. Correct new mentions/entities against the same analysis source; never invent references. New source windows require new extraction. Read old revisions using `show --revision <old-revision-id>`.


## Inspect entities and apply corrections {#inspect-entities-and-apply-corrections}


```bash
omk observe knowledge entities --workspace ./knowledge --analysis <run-id> --json
omk observe knowledge correct-entities --workspace ./knowledge --analysis <run-id> --entity-revision <entity-revision-id> --generation <read-generation> --input ./entities.json --reason 'Separate same-name entities using the source' --json
```

`entities` reads the current revision by default; use `--entity-revision` for history. Correction drafts contain only the returned `revision.entities` and `revision.mentions`. Preserve existing identities; new entities/mentions use distinct `new:<local-name>` identifiers, which the host replaces with UUIDs. An existing mention identity cannot move to different text. Mentions must exactly reference the selected source, and every entity needs an admitted mention. Use `identityStatus: unresolved` with `uncertainties` for unknown entities. `possibleEntityIds` may reference proposed entities; do not select one as an established identity.

Preserve the required `referentKind`, `componentRef`, and `collection` fields. An instance/version links a proposed component in this analysis; collections record known members and `complete`/`partial`/`unknown` completeness. Each link's `mentionIds` must include a mention of its owner, and `rationale` records the source interpretation. Partial or unknown membership needs an uncertainty reason; unknown membership cannot also list definite members. Before removing or reassigning entities/mentions, explicitly correct component, collection, candidate, and evidence references to them; silently removing references must not hide missing information.

Without `--analysis`, `entities` searches current objects across workspace analyses:

```bash
omk observe knowledge entities --workspace ./knowledge --query Atlas --identity-status unresolved --page-size 20 --json
```

Search covers names, source mentions, qualifiers, and origin. `--source-status unavailable` finds unavailable-source results; `--page` selects a page. Same-name results preserve separate analysis/entity identities. JSON includes analysis/entity/revision identities, mention and linked-knowledge counts, and a separate older-binding count. Unreadable knowledge makes counts `null`, not zero. Corrupt analyses contribute to `unavailableAnalyses` rather than disappearing silently.

Corrections append an entity revision without rewriting knowledge. To apply a chosen revision, inspect each statement's subject/object. Copy the referenced catalog entities' `entityId`, `label`, and `description` into the knowledge draft. Explicitly choose roles after a split:

```bash
omk observe knowledge apply-entities --workspace ./knowledge --id <knowledge-id> --revision <knowledge-revision-id> --generation <read-knowledge-generation> --analysis <run-id> --entity-revision <chosen-entity-revision-id> --input ./draft.json --reason 'Clarify entities in the statements' --json
```

This creates a knowledge revision bound to the exact analysis revision. Prior additional identity notes are preserved by default. Explicitly update them with `--identity-uncertainties '["Reviewed remaining note"]'`; `'[]'` clears prior notes, while current catalog uncertainties always remain. Inspect statement conditions/unknowns separately in the knowledge editor. Historical analysis, knowledge, and decisions remain inspectable; make a new retention decision. Only the same source window is supported. Unavailable snapshots prevent corrections or application. Independent analysis may contain zero entities and does not require knowledge candidates. See [entity extraction design and limits](../../specs/entities/entity-extraction.md).


## Organize and find knowledge {#organize-and-find-knowledge}

Save topic tags in knowledge details and search by title or `tag:topic`. Tags organize content without revising content or retention; [knowledge maintenance contracts](../../specs/knowledge/knowledge-maintenance.md) own fields and limits.

## Accumulate knowledge around entities {#accumulate-knowledge-around-entities}

Follow Studio step 4 to confirm source links. Object knowledge defaults to retained items with matching revisions. Link-review, empty-object, and unreadable-count states remain distinct. See [library contracts](../../specs/knowledge/knowledge-library.md) for linking, history, and recovery.

## Generate and save knowledge artifacts {#generate-and-save-knowledge-artifacts}

Follow Studio step 6 to save. Each selected exact revision defines that version’s references. Manual content outside the knowledge section and dependent assets remain, and prior versions are unchanged. [Knowledge maintenance contracts](../../specs/knowledge/knowledge-maintenance.md) own paths and metadata; carrier properties are not a library writeback interface.

## Evaluate an artifact change {#evaluate-an-artifact-change}

Follow Studio step 7 to preview and run. Check status before repeating a start request whose response was lost. Failures, cancellation, and interruption remain distinct. See [evaluation guides](../evaluation/index.md) for formal samples, exit codes, and report scope.

## Codex version check {#codex-version-check}


OMK uses `codex` from the current process PATH. Check `codex --version`; if the server reports that the model requires a newer client, update or explicitly select an existing compatible client rather than changing models or APIs. The desktop app and shell may use different versions.


## Recovery and data {#recovery-and-data}


Use `generate --run-id <UUID>` to identify one request and its frozen policy. Repeating that request does not call the model again; do not reuse it for different input, policy or runtime configuration. The default v5 run remains single-invocation; an explicitly bounded run records each permitted attempt and reservation separately. Neither policy uses fallback.

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

Resume archives the original outcome still held by the same application instance, reads a persisted native outcome, or finishes stable pending writes; it never calls the model. If a started invocation loses its unsaved result when the process exits, its outcome and usage remain unknown. Process exit does not prove the request was unsent or cost zero, and does not refund or authorize resending. Inspect the record before explicitly starting a new request under a fresh run identity. Failure or cancellation is not successful delivery.

New metadata lives at `extraction-runs/<run-id>.json`, with immutable complete native outcomes at `extraction-runs/outcomes/<run-id>/<attempt-id>.json`. Former `runs/` v4 files remain untouched and are neither read nor migrated: their details, resume, conversation/project batches and admission statistics are unavailable. Existing current source snapshots, entity history v2 and knowledge history v2 remain readable in the same workspace; no empty workspace is required.

The workspace contains source snapshots, revisions and raw generation output, which can contain private data. `delete-source --snapshot <snapshot-id>` removes that snapshot and leaves an unavailable marker. It does not alter the original log or erase quoted text in revisions or model output; it is not a complete workspace wipe. Missing, corrupt or deleted sources remain explicitly unavailable.

For initial acceptance, inspect source fidelity, scope and future usefulness, recording omissions, incorrect extraction and revision reasons. Automated checks cannot replace this judgment.


## Admission statistics

`omk observe knowledge quality --workspace ./knowledge --json` and Studio’s **Extraction history → Admission statistics** share the read-only `omk.extraction-quality/v3` projection of current v5 runs in the selected workspace’s `extraction-runs/`. They make no model calls and do not replay historical checkers. Former `runs/` files are outside this projection; their absence does not mean that workspace was never extracted. Groups bind prompt version/hash, executor, requested model, run Schema version, policyId and the complete policy configuration, initial timeout/output-token cap, outputMode, wireId (or null), producerId and producerRevision. This is a `BREAKING-COMPARABILITY` change from projection v2: different retry/budget limits no longer share a group merely because policyId matches. These dimensions do not establish matching endpoints or complete runtime conditions, and the counts are not a causal quality experiment. Each run contributes its final selected birth admission once; retries and native outcome evidence add no run or candidate denominators. Later entity corrections, knowledge edits and maintenance choices do not change generation counts.

Entity, mention and knowledge-proposal admission rates divide summed accepted items by summed accepted plus rejected items, rather than averaging run percentages. Identifier-fragment rejections use all recorded mention items as the denominator. Exact localization separately reports passed, rejected, not checked and unknown: accepted mentions and saved post-location rejection reasons prove position checking; structural/duplicate-ID rejection precedes checking. Unknown reasons are not interpreted. Not-checked items are excluded from the localization denominator; any unknown check records, missing historical entity rejection lists or absent admission records make the corresponding rate unknown. Empty denominators are `null`, never 100%.

Failed/cancelled/generating runs, runs without admission records and zero-admission/zero-knowledge runs remain visible. Reason counts can overlap on one item. Reference/dependency rejection counts do not establish causal cascades; exact position and structural admission do not prove semantic accuracy, recall or knowledge usefulness. Corrupt or unsupported files inside the current run directory fail the query; Studio offers a reload instead of displaying a healthy empty workspace. Preserved files in the former directory do not enter the query. No source, prompt, raw output, saved run or historical score is rewritten.

## Extraction quality checks

Use the [current annotation guide and offline tool](../../specs/entities/entity-extraction-evaluation.md). Generating a review package makes no model calls and does not establish overall quality acceptance. Historical results are reproduced only at their frozen revisions, without rescoring using current artifacts.


## Review cross-window entity links {#review-cross-window-entity-links}

`omk observe entity-links` reviews two entities from different source windows. Name normalization only recalls candidates; it does not confirm identity. Original entity UUIDs, analyses and knowledge revisions remain separate. Accepted reviews organize references in the library; they do not merge entity records or rewrite knowledge.

1. Run `candidates --workspace ./knowledge --analysis <analysis-id> --entity <entity-id> --json`, then inspect the selected sources and mentions.
2. Freeze one plan and save its complete JSON. Use `preview --input` to inspect that **same file**; a new preview creates new stable IDs and a different confirmation digest.

```bash
omk observe entity-links preview --workspace ./knowledge \
  --analysis <left-analysis> --entity <left-entity> \
  --right-analysis <right-analysis> --right-entity <right-entity> \
  --executor openai-api --model <model> --json > link-plan.json
omk observe entity-links preview --input link-plan.json
omk observe entity-links propose --input link-plan.json \
  --confirm-input <confirmedDigest> --json
```

`preview` makes no model request. Review the complete fixed rules, selected content, model, endpoint and nonsecret producer context before explicitly copying the file’s **top-level** `confirmedDigest`. This CLI confirmation binds the normalized absolute workspace and complete shared preview; the nested host confirmation remains a separate identity. Optional repeated `--mention` / `--right-mention` flags limit the selected mentions. The saved plan binds its absolute workspace; `propose` rejects another workspace, changed request/proof content, or changed observable producer configuration before starting. The plan must be a regular JSON file of at most 2 MiB, not a symlink. It contains selected source text: store and share it accordingly.

The API producer is currently supported. It freezes the API request, endpoint, relevant environment and archive-capacity proof; it is not a complete binary, provider or host attestation. Codex is rejected before process dispatch until its archive bound is proven. The invocation budget is one explicitly confirmed call, not a USD spending ceiling; unavailable usage or costs stay unknown. There is no fallback or automatic retry. This command does not restore Anthropic execution.

`propose` durably prepares before starting. Repeating the same plan inspects its saved review without dispatching again, including when configuration or credentials have since changed. After an uncertain acknowledgement, run `show --workspace ./knowledge --id <review-id> --json` first. Only a review still at `prepared` can explicitly continue the same attempt with `propose ... --start-prepared`; the source, owner and producer proof are rechecked. To abandon an unstarted reservation, use `resume --workspace ./knowledge --id <review-id> --cancel-before-start --request-id <stable-UUID> --generation <generation> --reason "cancel reviewed plan"`.

`list` and `show` expose the shared projection and immutable evidence. `show --json` includes the complete raw result, refusal, usage and event history. Inspecting a failed review succeeds with exit 0; a mutating operation that remains running, unknown, failed or in application conflict exits 1. Invalid parameters or plans exit 2. When produced, JSON stdout contains one machine result; diagnostics use stderr.

Accept only after a person confirms both original UUIDs refer to the same object; the model assessment, even `same_object`, is not acceptance. Keep the request UUID stable when replaying a decision and use the generation returned by `show`.

```bash
omk observe entity-links accept --workspace ./knowledge --id <review-id> \
  --request-id <stable-UUID> --generation <generation> \
  --reason "checked both sources and identity" --confirm-identity --object-label "complete object label" --json
omk observe entity-links reject --workspace ./knowledge --id <review-id> \
  --request-id <stable-UUID> --generation <generation> --reason "insufficient identity evidence" --json
omk observe entity-links resume --workspace ./knowledge --id <review-id> --json
```

A rejection suppresses the same pair of source/entity revisions in either order. `resume` never calls a model; it handles already held archival facts in the same live host or a stable pending library intent. A fresh CLI process cannot recover raw output lost before archival. For a crashed running owner, `resume --recover-unknown --request-id <stable-UUID>` records unknown only after the local owner is proven exited; no TTL makes that decision, and the consumed slot is not refunded. Inspect failed/unknown evidence before creating a **new** preview with `--retry-of <prior-review-id>` and explicitly confirming the new plan. Cancellation and process loss are not successful delivery. See [entity-link contracts](../../specs/entities/entity-links.md) for the storage and recovery boundaries. Studio exposes the same workflow from the current entity detail’s “Find cross-window identities” action; see the [Studio review surface](../../specs/studio/studio-entity-links.md). Real-model quality acceptance and independent human review remain pending.
