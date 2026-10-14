# Accumulate, maintain, and use knowledge {#extract-candidate-knowledge-from-work-logs}

Form candidates from selected work records, review and retain them in a library, revise outdated content, and maintain carriers that cite it. Retention, carrier saving, and effect verification have separate records. Start with Studio for a first use; CLI steps follow.

The library, artifact authoring, and change review in this guide require **1.0.0-beta.14 or later**; Beta.13 does not include this maintenance UI. Install from `@next`, then check `omk --version` before following these steps. Read the [migration guide](../maintenance/v1-preview-migration.md) before upgrading.

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

### Automatic conversation extraction and project todos {#conversation-auto-extraction-and-project-inbox}

Automatic extraction is optional. Preview the selected conversation's messages, location, model, and call allowance before authorizing transmission. Authorization is limited to that conversation, 24 hours, and the current service lifecycle. Call counts are not monetary budgets. Failure/interruption stops it, and restarting does not resume it automatically. Todos gather candidates for review without deciding retention or rewriting carriers.

## Select and generate a source {#capture-and-generate}

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


Use `generate --run-id <UUID>` to identify one request. Retrying that request does not call the model again; do not reuse it for different input or runtime configuration.

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

Resume handles already persisted output or pending writes, never regenerating. If a process exits before persisting output, its run may remain generating. Confirm the original process ended before deliberately starting a new run. Failure or cancellation is not successful delivery.

The workspace contains source snapshots, revisions and raw generation output, which can contain private data. `delete-source --snapshot <snapshot-id>` removes that snapshot and leaves an unavailable marker. It does not alter the original log or erase quoted text in revisions or model output; it is not a complete workspace wipe. Missing, corrupt or deleted sources remain explicitly unavailable.

For initial acceptance, inspect source fidelity, scope and future usefulness, recording omissions, incorrect extraction and revision reasons. Automated checks cannot replace this judgment.


## Reproduce historical quality checks {#reproduce-extraction-quality-checks}

Historical tools and frozen-baseline steps are maintained in the [historical reproduction record](../../specs/entities/history/extraction-quality-reproduction.md). They do not apply to current runs; new artifacts do not rescore old results.
