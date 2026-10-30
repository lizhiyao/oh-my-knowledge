# Accumulate, maintain, and use knowledge

Form candidates from selected conversation records, UTF-8 project files or fixed local Git files, review and retain them in a library, revise outdated content, and maintain carriers that cite it. Retention, carrier saving, and effect verification have separate records. Start with Studio for a first use; CLI steps follow. To use saved knowledge in a new task, see [complete a task with existing knowledge](#task-knowledge-reuse).

This guide describes current main. Check the capability’s version boundary before choosing an installed package or source build. Run `omk --version` after installation and read the [migration guide](../maintenance/v1-preview-migration.md) before upgrading.

## Capabilities and versions {#availability}

| Capability | Availability boundary |
|---|---|
| Core library, artifact authoring, ongoing revision and change review | Available since published `1.0.0-beta.14`; Beta.13 does not include this maintenance UI. |
| Source3 project/trace selection, four-stage source-ledger/body/coverage/association generation with separate request confirmation, independent derived associations, current journals and explicit copy migration | This guide describes current main; published Beta.14 does not contain these later capabilities. Build current source, and inspect release notes when subsequent versions ship. |
| Later read-retry, save-recovery and CLI-guidance fixes | Also described against current main; the published Beta.14 version is not evidence that these fixes are present. |

The [current knowledge extraction contract](../../reference/shared/knowledge-contract.md) generates prompt, Schema and capacity values from runtime code. It identifies the build rather than replacing [release records](https://github.com/lizhiyao/oh-my-knowledge/releases). `@next` is a release channel and does not automatically contain unpublished main changes.

## Studio {#studio}

```bash
omk studio
```

Use the returned address and check the current knowledge location first. Changing the default directory does not move saved data. Connected conversations use the host's conversation catalog. For project files, local Git files or configured trace files, the host first supplies a [finite source scope](#source-scope), then starts Studio with `omk studio --source-scope ./scope.json`. The browser chooses configured IDs and relative paths; it cannot grant an arbitrary project root.

1. **Select and preview sources**: Choose explicitly authorized material from a conversation turn or **Choose sources and extract knowledge**. Read complete excerpts and separate read/save/send scopes. **Capture selected sources only** saves locally. Independently prepare and confirm source ledger, body and coverage; review sources, ledger and bodies, record an actual decision, then separately confirm association. Every sent stage may incur cost; model analysis never approves itself.
2. **Review candidates**: Read complete body segments, conditions, attribution, exceptions and unknowns; open source evidence. Record a reason to retain, discard, or revise. New revisions require review again.
3. **Review entities as needed**: Check names, references, levels, and original text from a candidate or entity list. Entity corrections do not rewrite body; independently apply and review exact segment/entity associations.
4. **Accumulate across records**: Create an object in the knowledge library, check whether source entities from different windows refer to the same object, and confirm with reasons. Equal names do not merge identities; resolve ambiguity and missing sources first.
5. **Revise and update**: Carrier details show items requiring review after knowledge changes. Inspect revisions, retention changes, and sources item by item before selecting update content; old versions remain available.
6. **Generate and save a carrier**: Select matching retained knowledge, choose skill/prompt, check text and exact sources, and save a version. Generation organizes existing content without another model call. Updates rebuild the selected knowledge section while preserving manual content outside it and dependent assets.
7. **Verify a change**: Choose verification from carrier details, declare samples, control, and model, and confirm the preview before starting. Read execution and evidence status before conclusions; saving or use alone does not establish effects.

Candidate pages switch between content and source evidence; entity/library lists support narrow-screen switching. Failure, zero candidates, cancellation, and missing sources have explicit states. Extraction records and knowledge todos reopen saved content.

Conversation selection retains the selected messages' complete original records. Every readable event projected from those records appears in the preview and proposed model material. For example, a Claude record can contain both a message and tool events; those same-record events are included. Independent unselected records, project files and attachment originals are not added automatically. Readable previews, raw records retained locally and the complete prepared model request have separate views. Host root paths stay outside model metadata, while paths already written in source text remain source text. This establishes neither complete project coverage nor the truth of assistant-reported execution.

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

### Explicit stages and project todos {#automatic-extraction}

This build provides explicit stages only; conversation scheduling is retired. Old auto3 permissions, schedules, reservations and unknown claims retain their originals and are archive-only during independent migration. They are not upgraded into four-stage grants, and migration does not re-enable automatic mode. Preview/enable refuse, status reports `explicit_stages_required`, and stop/close do not rewrite old history.

Use **Extract conversation** or **Choose sources and extract knowledge**, reviewing each complete request and the coverage decision. The inbox still gathers candidates; explicit refresh or scoped maintenance events update it without automatically retaining knowledge, confirming cross-window identity or rewriting carriers.

## Select sources and generate knowledge {#select-sources}

CLI and Studio use the same selected knowledge workspace. Preview reads; capture saves; preparing a request makes it inspectable; sending requires an explicit confirmation. See the [source contract](../../specs/knowledge/knowledge-sources.md) for exact formats and limits.

### Configure trusted source bindings {#source-scope}

Create `scope.json` on the host. Replace these paths with actual authorized locations:

```json
{
  "scopeVersion": "knowledge-source-scope/v1",
  "projects": [{ "projectId": "project", "root": "/absolute/project" }],
  "traces": [{ "sourceId": "worklog", "traceKind": "codex", "path": "/absolute/session.jsonl" }]
}
```

Only this host configuration contains filesystem roots and trace paths. Selection JSON contains logical IDs, relative paths and explicit ranges. Optional material declarations apply to exact relative paths; undeclared material stays unknown. Reading test code does not establish that a test ran. Binary files, invalid UTF-8 and paths escaping the configured root are rejected.

For example, `selections.json` selects real lines from one project file:

```json
{
  "selections": [{
    "sourceKind": "project_file",
    "projectId": "project",
    "relativePath": "PRODUCT.md",
    "lineRanges": [{ "startLine": 1, "endLine": 20 }]
  }]
}
```

Adjust the file and range to existing content. File/Git line ranges are one-based and inclusive; `lineRanges: null` explicitly selects the whole bounded file. A `git_blob` selector also supplies `revision`, such as `HEAD`, which preview resolves to fixed local objects. An `agent_trace` selector uses `sourceId`, `traceKind` and zero-based inclusive `recordRanges`; it selects whole original nonempty records and all their readable events. Disjoint selections remain separate. No remote Git fetch or whole-project scan occurs.

### Preview and save {#source-preview}

```bash
omk observe knowledge preview-sources --workspace ./knowledge --scope ./scope.json --input ./selections.json --json > preview.json
omk observe knowledge capture --workspace ./knowledge --scope ./scope.json --input ./preview.json --json > capture.json
```

Read `preview.json` before saving: it contains literal selected text, original records and separate actual-read, proposed-send and save manifests. A reader may read a whole file or scan a trace prefix to locate the selection; only selected units are retained. Preview saves no formal snapshot and calls no model. Capture rebuilds the fixed selection and checks the preview digest and host scope. Source changes require a new preview; a moving Git branch cannot replace the pinned preview silently. Capacity failures reject rather than truncate. These exports can contain private source text.

Capture also calls no model and grants no send permission. From `capture.json` → `saveManifest.items`, copy each exact `snapshotId` and `sourceVersion` into `sources.json`, with no availability or ordinal fields:

```json
{
  "sources": [{ "snapshotId": "<saved-snapshot-uuid>", "sourceVersion": "sha256:<saved-source-digest>" }]
}
```

Use actual saved values. The two fields together form the `SourceRef`; an ID alone cannot select or delete a captured version.

### Prepare and confirm each model request {#source-generation}

```bash
omk observe knowledge prepare-generation --workspace ./knowledge --input ./sources.json --executor codex --model <model> --json > request.json
omk observe knowledge generate --workspace ./knowledge --input ./sources.json --executor codex --model <model> --confirm-request <ledger-request-digest> --json
```

The default is four explicit stages: **source ledger → body → source coverage → association**. Preparation calls no model. Read the complete prepared `system`, `input`, model, producer and `requestDigest`; `generate` sends only the initial source-ledger request. Capture approval is not model-send approval. Raw envelopes and host roots stay local; selected text, portable attribution and limitations are transmitted. The ledger is fallible model advice, not a Gold set or permission to discard unlisted source meaning.

After the ledger completes, prepare and confirm body generation with the same run and exact sources. After body completes, repeat this pair for source coverage, inspecting the newly prepared request and using its current generation/digest each time:

```bash
omk observe knowledge prepare-generation --workspace ./knowledge --input ./sources.json --run-id <run-id> --executor codex --model <model> --json > next-request.json
omk observe knowledge continue-stage --workspace ./knowledge --id <run-id> --generation <journal-generation> --executor codex --model <model> --confirm-request <prepared-stage-digest> --json
```

Each stage claims once and archives the complete returned outcome before decoding. Admitted bodies are **pending and unretained**; even zero bodies proceed to coverage without placeholders. Coverage independently checks all original sources, ledger items/facets, exclusions, pending opinions and body segments, and may find errors or omissions in the ledger itself. A model’s all-covered/no-findings is not actual approval.

Read the exact analyses and record an actual decision:

```bash
omk observe knowledge inspect --workspace ./knowledge --id <run-id> --json
omk observe knowledge source-ledger --workspace ./knowledge --id <ledger-id> --revision <ledger-revision-id> --json
omk observe knowledge source-coverage-status --workspace ./knowledge --id <coverage-id> --revision <coverage-revision-id> --json
omk observe knowledge review-source-coverage --workspace ./knowledge --input ./coverage-decision.json --json
```

`coverage-decision.json` is the complete `record_decision` command, without an operation wrapper or client-supplied actor. Copy the exact coverage/ledger/body/SourceSet bindings, generation/head and unresolved IDs from the readback. Give every unresolved item a disposition, reasons and limitations; choose `proceed_with_limits`, `needs_revision` or `stop`. Missing trusted actual-actor context refuses writes; do not invent an actor. A `revoke_decision` command names the prior event and preserves history. See the [decision contract](../../specs/knowledge/knowledge-source-review.md#decisions).

To proceed, add the exact `sourceCoverageDecisionRef` alongside `sources` in `association-input.json`. Prepare with the same run, then independently confirm the association request:

```bash
omk observe knowledge prepare-generation --workspace ./knowledge --input ./association-input.json --run-id <run-id> --executor codex --model <model> --json > association-request.json
omk observe knowledge continue-stage --workspace ./knowledge --id <run-id> --generation <journal-generation> --executor codex --model <model> --confirm-request <association-request-digest> --json
```

Preparation and the shared-lock dispatch claim both recheck that exact active, nonconflicting decision and its upstream identities. An invalidated decision makes no new model call. Revocation after dispatch preserves the request/original and leaves the result pending with the invalidated review context. Association failure never deletes saved bodies.

Each model stage defaults to 300 seconds; there is no automatic retry, validation reask or fallback. Enriched complete input must fit the 1 MiB request limit; capacity failure never trims sources, ledger or bodies. Default imports bind the workflow and sorted exact SourceSet, reusing completed, failed and unknown journals. A completed reimport makes no new call or duplicate body. A new run is only for deliberately independent generation, never an unknown-claim bypass. Calls/tokens/time and unreported costs remain separate from quality.

Export structural wires without a workspace or model call:

```bash
omk observe knowledge schema --stage source_ledger --json
omk observe knowledge schema --stage body --json
omk observe knowledge schema --stage source_coverage --json
omk observe knowledge schema --stage association --json
```

The ledger uses wire2/prompt3, coverage uses wire2/prompt3 and both histories stay v1; body uses wire2/prompt9, journal4/workflow4/default input2, Source3 and body3/entity2/association2/reviews1. Association retains the exact prompt7/profile/wire3 bytes and its v1 input envelope; this is distinct from the journal’s input2. Exact quotes and host-computed UTF-16 positions establish location, not semantic completeness or truth. Read current values in the [generated contract](../../reference/shared/knowledge-contract.md). Historical sources, originals, scores and measurement identities remain unchanged; this implementation does not establish that their raw quality passed.

Older journals require their matching preserved build or the [supported workflow copy](#workflow-migration). Parameter errors exit 2, business failures exit 1 and success exits 0. After an unclear acknowledgement, inspect durable state before repeating a mutation.

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
omk observe knowledge retrieve --workspace ./knowledge --query 'What remains unknown?' --include-candidates --snapshot <snapshot-id> --source-version sha256:<source-digest>
```

For the default JSON view, **65536 UTF-8 bytes counts the entire single-line JSON plus newline**, not stored knowledge or a model context limit. Explicit `--max-bytes 8192` remains supported; the maximum stays 1 MiB. Complete segments and their inline evidence are atomic: oversized or budget-excluded segments are reported in `omitted`, never condition-truncated. This initial budget does not establish complete task coverage or optimal selection, and does not upgrade previously recorded smaller-budget failures. The optional text view below is budgeted against its own complete output.

Recall and ordering use deterministic literal ASCII/code identifiers and Han runs/bigrams. The response records `rankingPolicyId: knowledge-body-literal-topic-priority/v3`. After source/entity scoping, each body's title, tags and eligible segment text determine its matched query ASCII/code term set. A strict subset lowers packing priority only: it does not prove redundant content or remove candidates. Equal sets tie, and incomparable sets do not demote each other; pure Han queries and queries with no ASCII hits retain the existing ordering. Among fitting segments, maximal topic sets come first, followed by incremental literal coverage/cost; lower-priority candidates remain eligible for remaining budget. All oversized or budget-excluded candidates count in `omitted`. This uses no embeddings and infers no semantic identity. `--include-candidates` explicitly includes unretained pending bodies; discarded revisions remain excluded. `--snapshot` and `--source-version` must be provided together to scope an exact source reference. `--entity-id` requires both `--analysis` and `--entity-revision` and uses an available matching derived projection, without automatic name merging; rejected/unavailable/stale associations cannot supply that scope. Unavailable source evidence remains explicitly unavailable while stored body text is readable.

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


## Migrate an older workspace {#workspace-migration}

### Copy workflow3 into an independent workflow4 workspace {#workflow-migration}

Preserve the old directory and matching installable package, then stop old writers. This slice supports only healthy active Source3/body3/entity2/association2/reviews1/tags. All bytes, identities, history, retention and review opinions stay unchanged; they do not become source-coverage approval. Library, carriers, entity-links or other unsupported content require retaining the old directory and reporting unsupported, never silent dropping or retargeting.

```bash
omk observe knowledge migrate-workflow --from-workspace ./workflow3 --workspace ./workflow4 --operation-id <stable-uuid> --matching-build ./omk-old.tgz --matching-build-id <old-build-id> --plan-only --json > workflow-plan.json
omk observe knowledge migrate-workflow --input ./workflow-plan.json --confirm-plan <plan-digest> --json
```

Planning writes nothing. Review actual roots, full inventory/digests, old package, capacity and limits before applying that fixed plan and digest. Old journal3 (including outcomes), auto-extraction and old migration/marker are archive-only: no old call or automatic allowance resumes. Roots must be independent and non-overlapping. Interrupted steps/receipts resume only the same plan; unknown temporary files stop for inspection. Completed additions/edits/deletions are never overwritten or resurrected. Explicit requests start the new stages; rollback uses the old directory and matching build. Source2 reference conversion remains the separate path below, without upgrading historical measurements.

### Migrate association Schema 1 into a separate copy {#association-migration}

Preserve the old workspace and its matching installed package, and stop old writers. An association Schema 1 workspace first needs its explicit Schema 2 copy migration; that operation does not create Source3 or make an old journal current. Run explicitly:

```bash
omk observe knowledge migrate-associations --from-workspace ./schema1 --workspace ./schema2 --operation-id <stable-uuid> --json
```

The new target must be empty and neither root may contain the other. The operation uses no models and copies body, source, entity, retention and historical-measurement bytes unchanged. Original association histories/receipts live under `migration/<operation-id>/original/`; `plan.json` fixes source pins and old/new revision mappings, and `complete.json` records completion. Converted projections have fresh pending revisions without inherited acceptance. Old journals/native outcomes retain original bytes and appear unsupported, without fabricated profiles or resumed dispatch. Old automatic permissions, schedules and budgets are archived only; the new workspace executes only explicitly confirmed stages, without a new automatic grant.

After interruption, preserve the plan and replay the same roots and --operation-id. Source drift or target edits reject replay without overwrite. Completed replay verifies its plan; later additions, edits and deletions must not be resurrected or overwritten. Rollback uses the old workspace and matching binary; the new copy retains originals and mappings. Mechanical migration, readability and successful saves do not establish semantic acceptance.

### Migrate Source2 into a separate Source3 copy {#source-migration}

Keep the original workspace and matching installable build archive, and stop its writers. The Source3 migration slice accepts a healthy body Schema 3 / Source2 workspace with current entity/association formats; it refuses missing or deleted required sources, corrupt data and unsupported versions. Resolve earlier format boundaries with their explicit migration procedures and matching builds; do not upgrade the original in place.

```bash
omk observe knowledge migrate-sources --from-workspace ./source2 --workspace ./source3 --operation-id <stable-uuid> --matching-build ./omk-old.tgz --matching-build-id <old-build-id> --plan-only --json > migration-plan.json
omk observe knowledge migrate-sources --input ./migration-plan.json --confirm-plan <plan-digest> --json
```

The first command is read-only. Review its actual source/target, archive and limitations, then copy the exported `planDigest` into the second command. The target is an independent non-overlapping copy. Old raw material, journals/outcomes, review records, permissions, library/carrier references and the matching build retain their bytes in the archive; the original remains unchanged. New source/body/catalog/projection references are mapped explicitly and remain pending. Old retention, identity acceptance, reviews, task feedback and automatic grants are not transferred; ordinary organization tags stay separate.

After interruption, preserve the fixed plan and replay that same input and digest. An incomplete target cannot open as a normal workspace. Changed target data is not overwritten, and deleted completed output is not resurrected. A crash before durable target ownership can require owner inspection rather than automatic recovery. Rollback uses the untouched old workspace and matching build. Copying an archive does not prove that installation or rollback has been tested; see the [source migration contract](../../specs/knowledge/knowledge-sources.md#migration).

## Recovery and data {#recovery-and-data}

Default imports already reuse the exact source set's journal. If an explicit run UUID was chosen, keep it for the same request. A different source/model/runtime cannot reuse that identity.

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge inspect --workspace ./knowledge --id <run-id> --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

`resume` can archive an original still held in the same process, attach a persisted original or finish fixed writes, without calling a model. A claimed phase without recoverable output stays `outcome_unknown_do_not_redispatch`; process exit proves neither no dispatch nor zero cost. Only a never-claimed prepared phase can be sent after reviewing and explicitly confirming its exact `requestDigest`, with the original model configuration.

### Review revised sources and rebuild {#source-review-corrections}

A revised body does not inherit source-coverage approval. Put the complete original `sources`, new exact `bodyRefs` and optional matching `ledgerRef` in `source-review.json`, never only the sources still cited by the body. No ledgerRef runs inventory then coverage; a matching reference runs coverage only. It generates no body or automatic association.

```bash
omk observe knowledge prepare-source-review --workspace ./knowledge --input ./source-review.json --run-id <review-run-id> --executor codex --model <model> --json
omk observe knowledge continue-stage --workspace ./knowledge --id <review-run-id> --generation <journal-generation> --executor codex --model <model> --confirm-request <prepared-stage-digest> --json
```

Without ledgerRef, the first continuation sends inventory. After it completes, repeat `prepare-source-review` with the same input and review-run-id, then inspect and confirm coverage. With a matching ledgerRef, only the coverage request is needed.

Read the analysis and record a new decision with `review-source-coverage` as above. To withdraw one, pass a complete `revoke_decision` command with targetEventId, reason and CAS/idempotence fields. For rebuilding, `association-decision.json` contains only the complete `sourceCoverageDecisionRef`; its coverage record supplies the full sources. Reuse the same explicit new run UUID in both commands:

```bash
omk observe knowledge prepare-rebuild-associations --workspace ./knowledge --input ./association-decision.json --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --run-id <new-stable-uuid> --executor codex --model <model> --json > association-request.json
omk observe knowledge rebuild-associations --workspace ./knowledge --input ./association-decision.json --id <knowledge-id> --revision <revision-id> --body-digest sha256:<digest> --run-id <new-stable-uuid> --executor codex --model <model> --confirm-request <prepared-request-digest> --json
```

Rebuilding creates an independent pending projection without another body generation. Manual `correct-entities`/`apply-associations` retain their explicit maintenance paths and do not fabricate source-coverage approval.

Current journal4 records live at `generation-journals/<run-id>.json`, with complete originals at `generation-journals/outcomes/<run-id>/<invocation-id>.json`. Journal3, old typed and source formats are explicitly unsupported, never healthy empty data. Preserve the original directory and matching build; follow the applicable [workflow copy](#workflow-migration), [body migration](../../specs/knowledge/knowledge-domain-model.md#body-migration) or [source migration](#source-migration), without resuming old claims.

### Check source changes {#source-updates}

Save an exact check request as `source-check.json`:

```json
{ "source": { "snapshotId": "<saved-snapshot-uuid>", "sourceVersion": "sha256:<saved-source-digest>" } }
```

```bash
omk observe knowledge source-updates --workspace ./knowledge --scope ./scope.json --input ./source-check.json --json
```

This reads current material and known exact body/catalog/projection references without a model call or knowledge change. Read both currentness and impact completeness: a partial inventory cannot establish zero impact. A changed file can leave selected bytes unchanged; review conditions before creating a new pending revision. Default Git checking reopens the captured objects, not the latest branch; checking a branch needs an explicit `replacementSelection`. A different path is only a possible move for review, even if bytes match. An unavailable root does not prove the original file was deleted.

After capturing a Git source in Studio, explicitly enter another local commit or branch under “Source change impact” and choose “Compare revision and check impact”. This keeps the old source reference and its original project, path and fixed line ranges, without automatically selecting `HEAD` or recapturing the new version. The interface keeps the old fixed commit visible and shows the entered revision, actual resolved commit, source state, exact body/entity catalog/association version reference counts and review suggestions separately. Checking preserves model-send approval; suggestions do not mean knowledge has been updated. Comparing does not replace this capture or model input; to use the new version, preview and capture it separately.

For existing knowledge, expand “Check changes affecting the saved source” below the quotation in the “Evidence” tab to check that exact source reference without recapturing. A saved snapshot can still be checked after its upstream file is deleted. An unreadable historical snapshot retains its unavailable state and incomplete-impact limitations; it is not treated as confirmed upstream deletion. Explicit Git comparison is offered only when the saved Git identity and selection for that reference are available.

### Read or delete captured evidence {#source-data}

```bash
omk observe knowledge source --workspace ./knowledge --snapshot <snapshot-id> --source-version sha256:<source-digest> --json
omk observe knowledge delete-source --workspace ./knowledge --snapshot <snapshot-id> --source-version sha256:<source-digest> --json
```

Historical captured evidence remains readable after upstream changes or deletion. Explicit `delete-source` leaves a content-free marker; it changes neither upstream files, stored quotations nor archived model outcomes, and is not a complete data wipe. Default recapture of that deleted version is refused. An explicit `afterDeletion: "new_snapshot"` in a fresh selection preview can authorize a new reference without reviving the old one. All source and workspace exports can contain private data; saving, quote matching and reopening are not semantic acceptance.

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
