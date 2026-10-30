# Accumulate, maintain, and use knowledge

Form candidates from selected work records, review and retain them in a library, revise outdated content, and maintain carriers that cite it. Retention, carrier saving, and effect verification have separate records. Start with Studio for a first use; CLI steps follow. To use saved knowledge in a new task, see [complete a task with existing knowledge](#task-knowledge-reuse).

This guide describes current main. Check the capability’s version boundary before choosing an installed package or source build. Run `omk --version` after installation and read the [migration guide](../maintenance/v1-preview-migration.md) before upgrading.

## Capabilities and versions {#availability}

| Capability | Availability boundary |
|---|---|
| Core library, artifact authoring, ongoing revision and change review | Available since published `1.0.0-beta.14`; Beta.13 does not include this maintenance UI. |
| Canonical body-first generation, independent derived associations, current journals, complete native archives, task retrieval and explicit migration adapters | This guide describes current main; published Beta.14 does not contain these later capabilities. Build current source, and inspect release notes when subsequent versions ship. |
| Later read-retry, save-recovery and CLI-guidance fixes | Also described against current main; the published Beta.14 version is not evidence that these fixes are present. |

The [current knowledge extraction contract](../../reference/shared/knowledge-contract.md) generates prompt, Schema and capacity values from runtime code. It identifies the build rather than replacing [release records](https://github.com/lizhiyao/oh-my-knowledge/releases). `@next` is a release channel and does not automatically contain unpublished main changes.

## Studio {#studio}

```bash
omk studio
```

Use the returned address and check the current knowledge location first. Changing the default directory does not move saved data.

1. **Select a source**: Open a conversation and choose extraction for a turn, or select a conversation from the knowledge page. Review messages, location, executor, and model before confirming. Only then is a model called, potentially incurring cost.
2. **Review candidates**: Read complete body segments, conditions, attribution, exceptions and unknowns; open source evidence. Record a reason to retain, discard, or revise. New revisions require review again.
3. **Review entities as needed**: Check names, references, levels, and original text from a candidate or entity list. Entity corrections do not rewrite body; independently apply and review exact segment/entity associations.
4. **Accumulate across records**: Create an object in the knowledge library, check whether source entities from different windows refer to the same object, and confirm with reasons. Equal names do not merge identities; resolve ambiguity and missing sources first.
5. **Revise and update**: Carrier details show items requiring review after knowledge changes. Inspect revisions, retention changes, and sources item by item before selecting update content; old versions remain available.
6. **Generate and save a carrier**: Select matching retained knowledge, choose skill/prompt, check text and exact sources, and save a version. Generation organizes existing content without another model call. Updates rebuild the selected knowledge section while preserving manual content outside it and dependent assets.
7. **Verify a change**: Choose verification from carrier details, declare samples, control, and model, and confirm the preview before starting. Read execution and evidence status before conclusions; saving or use alone does not establish effects.

Candidate pages switch between content and source evidence; entity/library lists support narrow-screen switching. Failure, zero candidates, cancellation, and missing sources have explicit states. Extraction records and knowledge todos reopen saved content.

Manual and automatic extraction previews explicitly cover user and assistant messages from the selected turns. Separate tool calls and results, project files and original attachments are excluded; content quoted within messages is still sent. The manual preview can expand its source version; message selection and the pre-generation version check remain separate. This does not establish complete project coverage or turn assistant-reported results into direct execution evidence.

Library, entity, and artifact pages show the selected knowledge directory; reading an explicit directory does not require model settings. Retry failed reads in place while preserving organization entries. Association conflicts preserve the body and draft; reread exact body/catalog/projection heads before applying again. Generic server failures or unreadable acknowledgements do not prove no write occurred. Choose “Check saved version”: organization checks the request receipt, while artifacts check content and exact references, avoiding duplicate saves. Pending content stays read-only and copyable; saving and checking make no extra model calls.

### Find knowledge for a task in Studio {#studio-task-retrieval}

In **Knowledge → Knowledge library**, switch to **Find for a task** and enter the question you need to resolve. Search retained content by default; explicitly choose **Include candidates without a retain decision** when inspecting undecided content. Discarded revisions are excluded. Reading does not require organizing an object or generating an artifact first.

Expand **Source scope and response budget** to select an exact source version and adjust the UTF-8 byte budget. Results show complete provided segments, the provided scope for each knowledge item and budget omissions. No returned content does not mean no knowledge exists. Increase the budget and search again, or open complete content and exact evidence. Opening a result uses the actual revision returned by retrieval; later revisions do not silently replace it.

Task retrieval uses the same deterministic literal search as the CLI, without a generation model call; different wording can still miss relevant content. A search hit, matching quotation position or retain decision does not establish truth or applicability to the current task. Follow content omissions, wrong associations and insufficient sources back to their respective revision or review entry points.

### Record reviews and task feedback {#review-feedback}

Open an exact body and enter **Content review**. Content opinions remain separate from retain/discard choices, association acceptance and independent human acceptance. A new record changes neither content nor carriers automatically.

1. Read the original and necessary context, then record issues requiring revision or a review with explicit limits. Findings may target segments or an entirely omitted topic; source passages not cited in the body can also support an omission.
2. Inspect existing entity mappings per segment, distinguishing linked, no reliable object, observed gaps and unknown. No mapping does not mean no object exists; exact quotations establish neither contextual correctness nor identity.
3. When recording feedback from a task result, retain the actually provided body revision, segments and task query. Separately record provided, read, reported use, observed help or controlled effect reports. The last two require task/comparison references or valid evidence, without automatic system certification.
4. Distinguish missing content, wrong associations and unavailable sources, then enter the appropriate revision, mapping review or source view. Historical-version feedback never follows the latest version automatically. Content changes explicitly create a new revision, require a fresh retain decision and review of affected associations/carriers.
5. Earlier revision-needed opinions are resolved only by explicit supersession; a new positive opinion does not silently replace them. An unclear acknowledgement requires checking saved records for the same requestId before redispatch. Conflicts preserve the draft; reread and confirm a new decision.

The CLI first reads status for the actually consumed exact revision, then accepts a complete draft from a regular UTF-8 JSON file. Replace the following identifiers with real values:

```bash
omk observe knowledge review-status --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --json
omk observe knowledge review-content --workspace ./knowledge --input ./content-review.json --json
omk observe knowledge review-coverage --workspace ./knowledge --input ./coverage-review.json --json
omk observe knowledge record-use --workspace ./knowledge --input ./use-feedback.json --json
```

For example, a content review draft:

```json
{
  "requestId": "<stable-request-uuid>",
  "bodyRef": { "knowledgeId": "<knowledge-id>", "revisionId": "<revision-id>", "bodyDigest": "sha256:<digest>" },
  "sources": [{ "snapshotId": "<snapshot-uuid>", "sourceVersion": "sha256:<source-digest>" }],
  "expectedGeneration": 0,
  "expectedHeadEventId": null,
  "supersedesEventIds": [],
  "status": "needs_revision",
  "reason": "Applicable conditions in the source are missing from the content.",
  "limitations": ["Only the selected source was reviewed; truth is not established."],
  "findings": [{ "problemKind": "omission", "description": "Add the conditions that change subsequent decisions.", "segmentIds": [], "evidence": [] }]
}
```

Read bodyRef, generation and head from the exact status. Copy only snapshotId/sourceVersion into `sources`, excluding current availability fields. An unavailable ledger's unknown generation is not zero. Replaying the same intent preserves its requestId and draft; changing content or CAS creates a new explicit decision. The three CLI writes require [trusted-host attribution context](../../specs/knowledge/knowledge-reviews.md#review-operations); unknown terminals are not recorded as humans. Status reads need no actor context.

See the [review and feedback contract](../../specs/knowledge/knowledge-reviews.md) for complete fields, classifications and non-inheritance rules. These operations call no generation model; persistence establishes neither truth nor benefits.

### Trace and correct graph associations {#graph-review}

In **Knowledge → Knowledge library**, first find knowledge by title, tags and maintenance state, then switch to **Graph**. Inspect the current knowledge's neighborhood or the filtered collection. Knowledge without a valid entity mapping still has readable content and source entry points. Nodes identify exact knowledge revisions, source-window entity revisions and source snapshots; equal names never merge identities.

1. Select a knowledge node to read its complete content. Select a “segment concerns entity” edge to inspect its segments, mentions and complete original source. This edge represents a saved segment mapping, not a verified relationship between entities. Semantic relations, possible identities and revision parents are presented separately when present in the stored records.
2. Open entity inspection or **Edit entity mappings** from the reader. Catalog choices match the content's exact source snapshots and versions. Check the source and entity revision, then explicitly choose segments, entities and mentions. Correcting an entity does not rebind knowledge automatically; applying a new mapping remains a separate confirmation.
3. In **Entity relations**, inspect, edit, remove or add relations individually. A readable projection for the exact current body preserves existing relation drafts; stale or failed projections are not carried over automatically. Choose the subject and optional object from entities mapped to the selected segments, and choose evidence from those segments' existing exact citations. Preserve assertion or inference basis, interpretation and unresolved issues; saving does not establish truth. If a segment, catalog or mapping change invalidates a relation, its draft remains and must be explicitly corrected or removed before saving.
4. Enter a reason, save the selected mappings and relations, and read back the new projection's exact revision and pending state. Association operations do not change content, its digest or retention decision. A new projection does not inherit acceptance of the old one; earlier relations and their revisions remain inspectable.
5. Refresh or reopen the current address and check filters, graph selection, content revision and sources; expand history as needed. An unclear acknowledgement requires checking the saved version first. Conflicts preserve the draft; reread current state before deciding, rather than resending a stale save.

Incomplete coverage still shows known readable associations in the graph, entity detail and library object detail, alongside unknown counts, failed, stale, rejected or unavailable-source states. Historical edges describe their exact past bindings and do not apply to current content. Multi-source content can trace each source; manual mapping can retain several exact source catalogs, selecting entities and mentions per catalog before saving them together. A source without a catalog is not replaced by a same-name entity from another source. Browsing, manual correction and reopening call no generation model. Separately requesting model-assisted rebuilding requires reviewing the transmission scope.

### Automatic conversation extraction and project todos

Automatic extraction is optional. Preview the selected conversation's messages, location, model, and invocation/budget limits before authorizing transmission. Authorization is limited to that conversation, 24 hours, and the current service lifecycle. Every initial invocation, retry and validation reask consumes one slot from the conversation-wide `maxCalls`; a run with three invocations consumes three slots. An opted-in token reservation allowance also accumulates across all windows, while capping each run. Reservations are durable before dispatch, recovered from immutable receipts and never refunded, including unknown usage or interruption before sending. Changing the displayed scope, model or limits clears approval. Existing permissions without a policy remain single-invocation permissions; retries require a new explicit approval. Hard failure/interruption stops automation; a terminal transient failure can leave it waiting for a new stable window, without resending that source. An archived server Retry-After is persisted and checked before every dispatch, including new windows and renewed permissions; a wait exceeding the run retry cap is not shortened, and permission expiry still prevents dispatch. Invalid waits stop automation. A fully validated empty dispatch ledger can release a locally rejected source window for fresh explicit approval, without deleting its failed run or evidence; any reservation or uncertain acknowledgement retains source deduplication. Restarting does not resume it automatically. Todos gather candidates for review without deciding retention or rewriting carriers.

## Select and generate a source

CLI and Studio use the same explicitly selected workspace. Capture archives selected records locally; generate sends only the selected excerpts, limitations and explicit source attribution to the configured model.

```bash
omk observe knowledge capture --workspace ./knowledge --source ./session.jsonl --json
omk observe knowledge source --workspace ./knowledge --snapshot <snapshot-id> --json
omk observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model> --run-id <uuid> --json
```

Use `--start-record`/`--end-record` for zero-based inclusive record ranges. Review privacy and scope before generating. Unsupported capabilities or unarchivable requests fail before dispatch; source text is not truncated. The host source file path is not sent as semantic metadata.

The current `knowledge-body-first/v2` workflow first calls the body model, archives its complete returned outcome, checks exact evidence and saves admitted complete body revisions **pending and unretained**. Only then does a separate association call propose entities and optional typed relations. Each phase defaults to 300 seconds and has its own request/profile/wire/producer/original outcome. A failed or unresolved projection does not remove the saved body. There is no automatic model retry, validation reask or provider fallback; old `--generation-policy` flags are no longer current generation contracts.

Export either current structural wire without accessing a workspace or invoking a model:

```bash
omk observe knowledge schema --stage body --json
omk observe knowledge schema --stage association --json
```

The result includes profile/prompt/wire identities and Schema. Current body output v2 / prompt v7 and association output v3 / prompt v6 use exact quotes with nullable adjacent `contextBefore`/`contextAfter`; the host requires a unique match and computes UTF-16 positions. Body proposals declare source-backed shared `requiredContexts`, whose literals must occur in every segment; the host adds their evidence without rewriting text. Association proposals own mentions within each entity and explicitly map or abstain for every segment with a reason. These checks neither recover omitted content nor establish complete entity coverage, source fidelity or truth. Quotes, titles and catalogs cannot replace missing body meaning. See the [generated contract](../../reference/shared/knowledge-contract.md) and [extraction specification](../../specs/entities/entity-extraction.md).

An active run from an older generation profile requires its matching preserved build: the current build does not decode its archived output or redispatch its requests. Already prepared publication intents can still replay exactly with zero model calls; completed and failed runs remain inspectable. Independent historical extraction/measurement protocols retain their frozen locator rules and identities.

Required parameters and JSON syntax are checked before settings/storage access. Parameter errors exit 2, business failures exit 1 and success exits 0. `--json` emits machine output without prose guidance. Inspect saved state after an unknown acknowledgement rather than blindly invoking again.

## Inspect and maintain {#inspect-and-maintain}

```bash
omk observe knowledge show --workspace ./knowledge --id <knowledge-id> --json
omk observe knowledge retain --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation <read-generation> --reason 'Reviewed source and applicability'
```

Use the actual revision and `history.generation` from the latest detail; `discard` records the same exact-revision decision without deleting history. Retention is not truth verification.

For a revision draft copy only `title`, `content` and `reuseRationale`. Preserve every segment's stable `segmentId`, complete `text` and inline `evidence`. Evidence includes exact `source: {snapshotId, sourceVersion}`, `selection: {evidenceRef, start, end, quote}`, `basis` and optional `interpretation`. Positions are zero-based UTF-16 into the exact excerpt. Read the source before changing them; the host independently rereads each source/version and rejects mismatches.

```bash
omk observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation <read-generation> --input ./body.json --reason 'Preserve the changed condition'
```

Studio computes positions from selected exact quotes; CLI drafts supply the complete inline evidence. The old `--citations`, `citationLocators` and parallel grounding API are replaced. New body revisions remain pending and do not inherit retention; previous derived projections become stale. Source-unavailable edits are rejected, while the previously stored body remains readable. Inspect historical bodies with `show --revision <old-revision-id>`.

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

Search covers names, source mentions, qualifiers, and origin. `--source-status unavailable` finds unavailable-source results; `--page` selects a page. Same-name results preserve separate analysis/entity identities. JSON includes analysis/entity/revision identities, mention and linked-knowledge counts, and a separate older-binding count. Corrupt analyses contribute to `unavailableAnalyses` rather than disappearing silently.

Corrections append an entity revision without rewriting body. To connect segments to a chosen catalog, inspect the exact body and catalog, then write a separate projection:

```bash
omk observe knowledge apply-associations --workspace ./knowledge --id <knowledge-id> --revision <body-revision-id> --body-digest sha256:<digest> --generation <association-generation> --input ./associations.json --reason 'Reviewed source-backed segment links' --json
omk observe knowledge review-associations --workspace ./knowledge --id <knowledge-id> --revision <projection-revision-id> --generation <association-generation> --choice accept --reason 'Reviewed this projection' --json
```

The draft contains `catalogRefs:[{analysisId,entityRevisionId}]`, `segmentEntityRefs`, optional `typedRelations` and `issues`. Segment references are `{segmentId,analysisId,entityRevisionId,entityId,mentionIds}`; typed subjects/objects use the same catalog-qualified entity triple. Combine catalogs matching body sources without merging local names or IDs. The old --analysis/--entity-revision flags are no longer accepted by apply-associations. Read association generation from `derivedAssociations.generation`, **not** body `history.generation`; absent association starts at 0. Manual application and model rebuilding create a new pending projection, preserving the body/revision/digest and its maintenance decision. Accept/reject review applies only to that projection and does not confirm external truth. A rejected or stale projection is not a current library binding. See the [domain contract](../../specs/knowledge/knowledge-domain-model.md).

## Organize and find knowledge {#organize-and-find-knowledge}

Topic tags organize content without changing its body or maintenance. For task consumption, retrieve complete segments from retained bodies by default:

```bash
omk observe knowledge retrieve --workspace ./knowledge --query 'What are the initialization conditions?' --max-bytes 65536
omk observe knowledge retrieve --workspace ./knowledge --query 'What remains unknown?' --include-candidates --snapshot <snapshot-id>
```

For the default JSON view, **65536 UTF-8 bytes counts the entire single-line JSON plus newline**, not stored knowledge or a model context limit. Explicit `--max-bytes 8192` remains supported; the maximum stays 1 MiB. Complete segments and their inline evidence are atomic: oversized or budget-excluded segments are reported in `omitted`, never condition-truncated. This initial budget does not establish complete task coverage or optimal selection, and does not upgrade previously recorded smaller-budget failures. The optional text view below is budgeted against its own complete output.

Recall and ordering use deterministic literal ASCII/code identifiers and Han runs/bigrams. The response records `rankingPolicyId: knowledge-body-literal-topic-priority/v3`. After source/entity scoping, each body's title, tags and eligible segment text determine its matched query ASCII/code term set. A strict subset lowers packing priority only: it does not prove redundant content or remove candidates. Equal sets tie, and incomparable sets do not demote each other; pure Han queries and queries with no ASCII hits retain the existing ordering. Among fitting segments, maximal topic sets come first, followed by incremental literal coverage/cost; lower-priority candidates remain eligible for remaining budget. All oversized or budget-excluded candidates count in `omitted`. This uses no embeddings and infers no semantic identity. `--include-candidates` explicitly includes unretained pending bodies; discarded revisions remain excluded. `--snapshot` and optional `--source-version` scope exact source references. `--entity-id` requires both `--analysis` and `--entity-revision` and uses an available matching derived projection, without automatic name merging; rejected/unavailable/stale associations cannot supply that scope. Unavailable source evidence remains explicitly unavailable while stored body text is readable.

### Complete a task with existing knowledge {#task-knowledge-reuse}

The official OMK Agent Skill prefers `retrieve --format text` for reading historical knowledge, with JSON, `show` and `source` for precise readback when needed. It skips evaluation-project and `eval-samples` scanning for this branch. Use the user's selected workspace or the CLI's configured default; do not invent a directory or automatically install, upgrade, migrate, or change knowledge. Check installed command capabilities against the version boundaries above.

Keep the complete natural task for reading and final checking. Each trimmed `--query` allows at most 512 JavaScript string units (UTF-16). Use the original question when it fits; split longer tasks faithfully into natural subquestions while retaining names, versions and constraints, without cutting conditions or replacing them with expected answers. Start with an adjustable per-read budget appropriate to the tool's visible capacity, for example:

```bash
omk observe knowledge retrieve --workspace <selected-workspace> --query '<current-task>' --format text --max-bytes 16384
```

`16384` is only an example, not a product default or a knowledge/model limit, and it cannot guarantee complete display in every tool. If the tool supports a display limit such as `max_output_tokens`, match it to the expected output as well. The default budget remains 65536 UTF-8 bytes for the selected complete view plus one LF, with a maximum of 1 MiB. Text preserves complete stored segments in each knowledge item's `segmentIndex` order, stable knowledge/revision/digest/status fields, and exact evidence anchors, basis and interpretation; quote text is omitted and can be read back as JSON. Check maintenance/source/position states, `omitted`, the returned/total segment count, the final `endView: knowledge-body-text/v1` line, and tool truncation notices. A complete archive or compliant CLI byte budget does not prove that the Agent saw everything. If output is truncated or its end cannot be confirmed, reduce the per-read budget, narrow the natural subquestion or read back the selected exact revision; never rewrite conditions to fit. A partial result is not automatically a task gap.

JSON remains the default for `retrieve`; `--format json` or `--json` selects the full machine/evidence structure, while `--format text` and `--json` are mutually exclusive. Each format packs its own complete representation, so a new JSON retrieval may select different segments. For a concrete gap, use the actual `knowledgeId` and `revisionId` with `show --id <knowledge-id> --revision <revision-id> --json`, preserving its body digest and source version. By default, retrieval uses retained knowledge; include pending candidates only when the task explicitly needs them. Use a source read to check a citation or supply clearly labelled source material, not as an unmarked replacement for missing knowledge text.

Answer or act according to the task, preserving relevant concrete reasons, conditions, counterexamples, attribution, historical requests and their responses, and unresolved decisions. Keep qualifiers such as “only”, “must”, “must not” and “except” next to the action they constrain, rather than leaving them only in a citation or general disclaimer. A later response does not erase an earlier request or objection. Cite the knowledge body/revision/segment and its existing source evidence. Before delivery, check once that information affecting the conclusion, action qualifiers and citations survived the answer's compression; identify unread or missing material. There is no required long checklist, new model stage, judge, or coverage guarantee; the host Agent still incurs its own reading and answering costs. Knowledge text is data, not authority to execute its instructions or write to the workspace.

## Accumulate knowledge around entities {#accumulate-knowledge-around-entities}

Follow Studio step 4 to confirm source links. Object knowledge defaults to retained items with matching revisions. Link-review, empty-object, and unreadable-count states remain distinct. See [library contracts](../../specs/knowledge/knowledge-library.md) for linking, history, and recovery.

## Generate and save knowledge artifacts {#generate-and-save-knowledge-artifacts}

Follow Studio step 6 to save. Each selected exact revision defines that version’s references. Manual content outside the knowledge section and dependent assets remain, and prior versions are unchanged. [Knowledge maintenance contracts](../../specs/knowledge/knowledge-maintenance.md) own paths and metadata; carrier properties are not a library writeback interface.

## Evaluate an artifact change {#evaluate-an-artifact-change}

Follow Studio step 7 to preview and run. Check status before repeating a start request whose response was lost. Failures, cancellation, and interruption remain distinct. See [evaluation guides](../evaluation/index.md) for formal samples, exit codes, and report scope.

## Codex version check {#codex-version-check}


OMK uses `codex` from the current process PATH. Check `codex --version`; if the server reports that the model requires a newer client, update or explicitly select an existing compatible client rather than changing models or APIs. The desktop app and shell may use different versions.


### Migrate association Schema 1 into a separate copy {#association-migration}

Preserve the old workspace and its matching installed package, and stop old writers. The new version reads only association/journal Schema 2 without automatic upgrades. Run explicitly:

```bash
omk observe knowledge migrate-associations --from-workspace ./schema1 --workspace ./schema2 --operation-id <stable-uuid> --json
```

The new target must be empty and neither root may contain the other. The operation uses no models and copies body, source, entity, retention and historical-measurement bytes unchanged. Original association histories/receipts live under `migration/<operation-id>/original/`; `plan.json` fixes source pins and old/new revision mappings, and `complete.json` records completion. Converted projections have fresh pending revisions without inherited acceptance. Old journals/native outcomes retain original bytes and appear unsupported, without fabricated profiles or resumed dispatch. Old automatic permissions, schedules and budgets are archived only; the new workspace requires fresh explicit authorization.

After interruption, preserve the plan and replay the same roots and --operation-id. Source drift or target edits reject replay without overwrite. Completed replay verifies its plan; later additions, edits and deletions must not be resurrected or overwritten. Rollback uses the old workspace and matching binary; the new copy retains originals and mappings. Mechanical migration, readability and successful saves do not establish semantic acceptance.

## Recovery and data {#recovery-and-data}

Use `generate --run-id <UUID>` to pin one request. An identical request only restores its journal and makes zero new model calls; a different source/model/runtime cannot reuse that identity.

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge inspect --workspace ./knowledge --id <run-id> --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

`resume` archives an original still held in the same process, attaches a persisted original or completes fixed publication intents using the same request IDs. It never calls models. A claimed phase without recoverable output remains `outcome_unknown_do_not_redispatch`; process exit proves neither no dispatch nor zero cost. If body is already saved and association remains never-claimed, only an explicit `continue-stage --id <run-id> --generation <journal-generation>` can send that stage. The original model configuration must match.

Rebuild associations for an existing exact body without generating another body:

```bash
omk observe knowledge rebuild-associations --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --run-id <new-uuid> --executor codex --model <model>
```

This creates a new independent pending projection. Association generation/rebuild supports all exact available body sources, keeping an independent catalog per source; review all sources before sending. Invalid catalog output fails dependent body projections while preserving healthy catalogs and stored bodies. Later catalog read failures expose local gaps while retaining other readable mappings.

Current journals live at `generation-journals/<run-id>.json`; each complete original is at `generation-journals/outcomes/<run-id>/<invocation-id>.json`. Body histories use Schema 3. Old typed knowledge v2 and run5 are explicitly unsupported, not a healthy empty workspace. See the [explicit new-workspace migration](../../specs/knowledge/knowledge-domain-model.md#body-migration); use `omk observe knowledge migrate --from-workspace ./old-knowledge --workspace ./new-knowledge` with both paths explicit. There is no automatic overwrite. Keep the old workspace and matching binary for rollback.

`delete-source` leaves a deletion marker without changing the original log, saved body quotes or archived model output. It is not a complete data wipe. All workspace material may contain private data. Missing/corrupt/deleted evidence is explicitly unavailable; saving, quote matching and reopening are not semantic acceptance.

## Admission statistics

`omk observe knowledge quality --workspace ./knowledge --json` and Studio read the current `knowledge-body-admission` projection. It shows each journal's status, recorded bodies, phase state, body rejection count and issues; `semanticQuality: not_assessed` is explicit. Unsupported legacy inventory remains separate.

These are mechanical observations, not extraction accuracy, completeness, causal comparisons, truth, task success or cost acceptance. A completed workflow can contain a failed derived projection while its body remains saved; inspect phase and body details. Original native usage/reporting flags remain available through CLI `inspect`. Old run5 quality denominators and historical typed study scores are not recomputed or mixed into the new journal identity.

## Extraction quality checks

The [historical typed annotation guide and offline tool](../../specs/entities/entity-extraction-evaluation.md) retain their measurement identities. Current CLI/Studio study inspection and portable archive replay are read-only; old typed generation plans are explicitly unsupported and start no model calls. These records do not certify the body-first workflow. Body source fidelity and real task usefulness still require explicit validation with its own source/request/version evidence; do not rescore old runs using the new contract.

Use [review knowledge quality](review-knowledge-quality.md) to check complete meaning against selected sources, separate failures, revise and reopen content, and record actual cost and review limits before deciding whether to use, continue or stop.


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
