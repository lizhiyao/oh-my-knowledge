# Extract candidate knowledge from work logs

Select one Codex JSONL log, extract facts, cases or methods, and inspect each candidate against its original records. Retaining a candidate means choosing to maintain it; it does not verify its truth. This workflow does not automatically edit AGENTS.md, skills or other active artifacts.

## Capture and generate

Choose an explicit local workspace shared by CLI and Studio. Replace paths and identities below with your own values:

```bash
omk observe knowledge capture --workspace ./knowledge --source ./session.jsonl --json
```

Capture is local and makes no model call. Optional `--start-record 10 --end-record 30` selects inclusive, zero-based nonempty record indices. Inspect the returned `snapshotId`, record scope, excerpts and limitations before generating.

```bash
omk observe knowledge source --workspace ./knowledge --snapshot <snapshot-id> --json
omk observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --executor codex --model <model> --json
omk observe knowledge list --workspace ./knowledge --json
```

Generation sends selected excerpts and coverage limitations to the configured executor and model and may incur costs. Supported executors are codex, openai-api and anthropic-api; their existing credential configuration applies. Native log paths and raw record envelopes are excluded from model input, but selected text can itself contain sensitive information.

Local Node code reads and parses the log; the model receives only the prepared selected excerpts. CLI and Studio share this application flow. Codex runs in an empty temporary working directory with the executor’s read-only sandbox and ignore-user-config/ignore-rules arguments, and is instructed not to call tools. Any observed tool call causes rejection of the output; this is not a strict guarantee against all file access. API requests provide no tools.

Current generation uses `knowledge-extraction-v4`: one call returns independent entity analysis and knowledge candidates sharing its catalog, distinguishing components, instances, collections, plans and activities. The model supplies exact phrases and optional zero-based occurrence indices; repeated phrases require an index. The host computes UTF-16 positions without normalization or alternative-message search. Invalid positions or entities reject dependent results. Conditions, counterexamples, later corrections and unverified steps still need individual review.

v4 changes identity/quote contracts, prompt bytes and admission semantics (`BREAKING-COMPARABILITY`): admission counts do not establish better knowledge quality. Current formats are knowledge history v2, entity history v2, extraction run/model response v4, and `knowledge-extraction-v4`. Old entities and runs are not read, resumed or migrated; files remain untouched. Old knowledge v2 bodies stay readable with unavailable old entity analyses. Choose an empty knowledge directory and re-extract from original logs; recovery of new runs never calls the model again. See [current storage contracts](../specs/entity-extraction.md#_6-current-storage-contracts).

Historical v3 quality scripts require the report's frozen base `ef63224837fc6bacb2085a1c21a38534bc5dc2e7`; current code refuses before invocation even with an old prompt file. Historical reports and corpora are not recalculated. New corpus/check identities and independent quality acceptance are not frozen yet.

Zero candidates is valid. Invalid proposals retain rejection reasons. Exact quote matching checks location integrity, not truth. Recorded behavior, source assertions and inference remain distinct; missing conditions and times remain unknown.

## Inspect and maintain

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

## Inspect entities and apply corrections

```bash
omk observe knowledge entities --workspace ./knowledge --analysis <run-id> --json
omk observe knowledge correct-entities --workspace ./knowledge --analysis <run-id> --entity-revision <entity-revision-id> --generation <read-generation> --input ./entities.json --reason 'Separate same-name entities using the source' --json
```

`entities` reads the current revision by default; use `--entity-revision` for history. Correction drafts contain only the returned `revision.entities` and `revision.mentions`. Preserve existing identities; new entities/mentions use distinct `new:<local-name>` identifiers, which the host replaces with UUIDs. An existing mention identity cannot move to different text. Mentions must exactly reference the selected source, and every entity needs an admitted mention. Use `identityStatus: unresolved` with `uncertainties` for unknown entities. `possibleEntityIds` may reference proposed entities; do not select one as an established identity.

Without `--analysis`, `entities` searches current objects across workspace analyses:

```bash
omk observe knowledge entities --workspace ./knowledge --query Atlas --identity-status unresolved --page-size 20 --json
```

Search covers names, source mentions, qualifiers, and origin. `--source-status unavailable` finds unavailable-source results; `--page` selects a page. Same-name results preserve separate analysis/entity identities. JSON includes analysis/entity/revision identities, mention and linked-knowledge counts, and a separate older-binding count. Unreadable knowledge makes counts `null`, not zero. Corrupt analyses contribute to `unavailableAnalyses` rather than disappearing silently.

Corrections append an entity revision without rewriting knowledge. To apply a chosen revision, inspect each statement's subject/object. Copy the referenced catalog entities' `entityId`, `label`, and `description` into the knowledge draft. Explicitly choose roles after a split:

```bash
omk observe knowledge apply-entities --workspace ./knowledge --id <knowledge-id> --revision <knowledge-revision-id> --generation <read-knowledge-generation> --analysis <run-id> --entity-revision <chosen-entity-revision-id> --input ./draft.json --reason 'Clarify entities in the statements' --json
```

This creates a knowledge revision bound to the exact analysis revision. Prior additional identity notes are preserved by default. Explicitly update them with `--identity-uncertainties '["Reviewed remaining note"]'`; `'[]'` clears prior notes, while current catalog uncertainties always remain. Inspect statement conditions/unknowns separately in the knowledge editor. Historical analysis, knowledge, and decisions remain inspectable; make a new retention decision. Only the same source window is supported. Unavailable snapshots prevent corrections or application. Independent analysis may contain zero entities and does not require knowledge candidates. See [entity extraction design and limits](../specs/entity-extraction.md).

## Studio

### Conversation auto extraction and project inbox

Choose **Enable auto extraction** in the conversation header. Review the initial messages from the latest 3 finished turns, specify the candidate folder, executor, model and maximum calls (1–20), check the sending permission, then choose **Approve and enable**. USD cost is unknown; a call limit is not a dollar budget. Opening the preview does not call a model.

Permission covers only this conversation for 24 hours while the current Studio server runs. Subsequent windows include up to 3 new finished turns plus 2 preceding turns of context, after records remain stable for 30 seconds. Open or unknown turns wait until finished; the entire history is not reconciled for every correction. An identical source window is not sent twice; this does not guarantee semantic deduplication. Failure or interruption stops scheduling without a fresh model retry. **Stop auto extraction** cancels the owning server’s in-flight call; output already produced may still be saved. Enable again after restart. To regenerate a failed window, use manual extraction and confirm again.

The header’s **Knowledge inbox** shows the undecided count. Open it to retain, discard or revise candidates in place, inspect entities as needed, then generate and save artifacts from retained knowledge. **Extract this turn** and **Extract conversation** still support manual message selection and in-place review. Projects have the same **Knowledge inbox**, collecting candidates and decisions from currently indexed project conversations. This is source grouping, not an automatic ownership, similarity or conflict judgment. Unreadable folders and empty scopes have explicit states.

Scheduling permission and call reservations use `auto-extraction/<thread-hash>.json` under the selected knowledge folder, with `schemaVersion: 1` and `automationKind: conversation-knowledge-extraction`. Calls and window digests are persisted before invocation; reservations count against the limit even if interruption prevents sending, with no refund or re-send. Each Studio registers at most 32 conversation scopes and invokes models serially; each conversation stores at most 2,000 finished turns and 1,000 attempted windows, then stops. Immutable `permission-<id>.json` and `attempt-<run-id>.json` records preserve each permission and its call/window associations across re-enabling; the directory is limited to 3,000 files. Existing source, knowledge, entity and run formats remain unchanged, and raw evidence is preserved. Complete, explicitly injected AGENTS.md instructions are collapsed only in the reading view; original messages remain expandable and present in source snapshots and sending previews.

Start `omk studio` and use the returned address. The primary **Knowledge** entry opens **Extracted knowledge**. Search titles or tags, or filter by undecided, retained, or discarded items. **Knowledge artifacts** opens saved artifacts; doctor and observation data remain in the **Doctor and observe** tab.

While reading an observed conversation, choose **Extract this turn** to confirm that turn’s selected messages, save location, and model directly. On the Knowledge page, **Choose a conversation** or **Extract new knowledge** lets you select a conversation and turn in place. Choose the entire conversation when a wider scope is needed. Expand message and configuration adjustments as needed; the model is called only after **Start extraction**. Successful extraction opens candidate review directly. Empty results, failure, or cancellation keep a result message; recover saved content through **Extraction history** or the conversation’s **Knowledge inbox**.

You can also import a local log through **More** and preview its scope before generating. The save location travels with internal navigation. **Save location** changes this operation only; edit the long-term default through **Settings and help** in the sidebar. Existing data does not move.

Review the content, conditions, and unknowns, then use **Inspect evidence** to locate the source. Narrow screens switch between **Candidate content** and **Source evidence**. Classification, time, and revision history expand on demand. Enter a reason to retain or discard, or select and edit a reason preset; selecting a reason does not make a decision. After saving the decision, review advances to the next undecided candidate in this extraction, without entering other extractions. Revisit the previous item or return to all knowledge. Editing creates a new revision and stays on the current candidate for a new review and decision. Once all items are handled, a batch summary shows retained and discarded counts with actions to revisit or return to the source conversation. **Review this batch** in **Extraction history** reopens the saved candidates from that extraction.

Reopen retained content under **Knowledge → Extracted knowledge**. Retention does not automatically edit artifacts; **Generate knowledge artifact** starts explicit generation and saving.

Results, extraction history, and a conversation's extracted knowledge offer **Inspect entities and references**, including zero-candidate results. Candidate details open the bound entity revision. Inspect names, qualifiers, ambiguity, mention assignments, and source text. Add an entity and reassign mentions to split it, or explicitly merge/remove false entities. Select source text to add an omitted mention. Save with a correction reason, then choose **Apply current entity revision** in knowledge details and inspect every subject/object before saving a knowledge revision. Entity inspection is optional for each extraction.

**Knowledge → Entities** provides separate search and pagination, with identity-ambiguity and source-availability filters. Select an entity to inspect qualifiers, possible identities, highlighted source spans, message roles/times, and its actual subject/object roles in linked knowledge. Switch historical revisions, return to the source conversation, or open corrections. Narrow screens switch between list and detail. Knowledge links show the entity revision actually bound by the current knowledge revision; older bindings have an explicit notice and inspection link. Corrections do not automatically rewrite knowledge. Saved mentions remain visible after source deletion, but cannot be rechecked or corrected. Entity links carry workspace, analysis, entity, and optional exact revision identities; identical names never merge results.

## Organize and find knowledge

Edit **Topic tags** in candidate details and explicitly save them. Use Chinese characters, letters, numbers, underscores, hyphens, or `/` for nesting, without spaces or purely numeric names. Each knowledge item allows up to 32 tags of 80 characters each. Duplicate tags are case-insensitive. Tags are user-maintained, make no additional model call, and do not verify knowledge. Editing tags leaves claims, sources, revisions, and retention decisions unchanged.

The library searches titles and tags. `tag:debugging` matches “debugging” and nested tags such as “debugging/evidence”, together with the decision filter. Tags organize topics; knowledge types, applicability conditions, and evidence classifications still come from the selected knowledge revision.

Tag history is stored separately in `tags/<identity-digest>.json` under the knowledge directory, using `omk-knowledge-tags/v1`. Records bind the knowledge identity and preserve tags, modification time, and actor. Saving tags does not change knowledge, source, or run records. Unset tags are empty; concurrent updates reject stale generations and require reloading and review. Tags persist across knowledge revisions as organization information; check that they still apply.

## Generate and save knowledge artifacts

Choose **Generate knowledge artifact** on a retained candidate or completed batch, or **Generate from retained knowledge** in **Knowledge artifacts**. Choose skill or prompt, enter a name, inspect the selected retained knowledge, and choose **Generate and review**. Initial selections include only the current candidate or retained items from this batch; explicitly add other retained items if needed, up to 100 per operation. Generation organizes existing material while retaining conditions, exceptions, unknowns, claim and evidence classifications, quotes, and source versions. It makes no additional model call.

Generation also exports a property snapshot: title, summary, topic tags, knowledge types, scenarios, evidence classifications, and exact knowledge/source versions. The summary uses knowledge titles, scenarios come from claim contexts, and multiple evidence classifications can coexist. `verification_status: not_assessed` means this generation provides no truth or task-effect validation. Prompts use top-level YAML properties with `tags` as a list, readable by tools such as [Obsidian](https://obsidian.md/help/properties). Skills retain required `name`/`description` fields and put additional properties in the specification's `metadata` string mapping; lists are encoded as JSON strings.

Properties use `omk-knowledge-metadata/v1` and describe knowledge incorporated in this artifact version; editing them does not update the knowledge library. Updating an OMK-generated artifact recomputes these properties. The first import of a local prompt preserves custom fields and existing tags. Tag changes after preview also reject stale saves. Older artifacts are not rewritten in the background; `manifest.json` remains authoritative for artifact and knowledge revision associations.

Review and edit the new content, then choose **Save artifact**. Content is saved directly under the current knowledge directory as `artifacts/<artifact-id>/vN/content/<directory-name>/SKILL.md` or `artifacts/<artifact-id>/vN/content/<directory-name>.md`. The artifact detail opens with the actual artifact path, content, knowledge sources, and version history. Display names may contain Chinese text. New artifacts receive distinct file names; skill frontmatter names match their directory names, and valid frontmatter is checked on save, following the [Agent Skills format](https://agentskills.io/specification). No clipboard step is required. Source links open the exact incorporated knowledge revision. Saving does not verify truth or effectiveness; check applicability and run a controlled evaluation before use.

To update an artifact, select a saved artifact or explicitly provide a local file path. The preview preserves original content and appends new knowledge; switch to the original content to compare, then save a new version. When starting from local `SKILL.md`, distributable assets in the same directory are copied using the existing filtering and content digest rules. The original file is preserved. Choose another knowledge directory if the save location is inside the local skill being copied. Already incorporated knowledge revisions are not appended twice, and old artifact versions remain readable. Select the latest version before generating further updates.

Each `manifest.json` uses `omk-carrier-v1`, recording artifact identity, version, save time, content digest, file directory name, baseline, and exact knowledge revision references. This is an additive artifact storage contract; candidates, source snapshots, and existing evaluation data are preserved. Changes to the current knowledge revision, retain decision, or artifact baseline after preview reject stale saves and require a new preview. External artifact edits are marked as content changes. A complete staged version is published atomically; failure or cancellation does not replace old versions. After a local writer exits, the next save recovers its dead lock once it is over 30 seconds old and removes unpublished staging; locks owned by another host are not taken over. If the save result cannot be read, choose **Check saved version** before attempting another write.

## Evaluate an artifact change

Select “Evaluate this version” in artifact details. Updates preselect the original version; new artifacts require another saved version or an explicit local skill directory/SKILL.md or prompt file as control. Both versions must have the same form and different content. Select a local sample file or directory, executor and fixed model, configure model judges if needed, then preview the evaluation plan. This entry supports 1–100 local samples and excludes samples requiring remote content resolution.

Preview shows both versions, identical samples and scoring criteria, the task model, actual scoring models and planned task count, without calling models. Only “Confirm and evaluate” starts execution, including required preflight. Cost cannot be estimated precisely; preflight and model grading may add calls. There are no automatic retries. Previews expire after 15 minutes; changed artifacts, samples or runtime plans require a new review.

Evaluation attempts bind the exact artifact revision and source knowledge. Finished, failed, cancelled and interrupted states remain visible; cancel active work, open the existing Core results and evidence, then return to the evaluated version. Cancellation cannot undo calls or charges already incurred. If the start response is lost, check run status before another attempt. Server shutdown cancels owned work; attempts whose local process has exited show interruption and never restart model calls automatically. Existing Studio evaluation records remain accessible.

The selected knowledge directory is the operation root. Core artifacts use the existing `.omk/eval` contract; additive `.omk/state/jobs/carrier-measurements/<measurement-id>.json` records use `omk-carrier-measurement-v1` for previews and attempt associations, without changing artifact manifests or existing measurement schemas. Records may contain private samples and artifact content; manage them as local data. A finished run, saved artifact or retained knowledge does not establish effectiveness. Review report conclusions and evidence scope; generated samples require review and are not automatically independent release evidence.

## Codex version check

OMK uses `codex` from the current process PATH. Check `codex --version`; if the server reports that the model requires a newer client, update or explicitly select an existing compatible client rather than changing models or APIs. The desktop app and shell may use different versions.

## Recovery and data

Use `generate --run-id <UUID>` to identify one request. Retrying that request does not call the model again; do not reuse it for different input or runtime configuration.

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

Resume handles already persisted output or pending writes, never regenerating. If a process exits before persisting output, its run may remain generating. Confirm the original process ended before deliberately starting a new run. Failure or cancellation is not successful delivery.

The workspace contains source snapshots, revisions and raw generation output, which can contain private data. `delete-source --snapshot <snapshot-id>` removes that snapshot and leaves an unavailable marker. It does not alter the original log or erase quoted text in revisions or model output; it is not a complete workspace wipe. Missing, corrupt or deleted sources remain explicitly unavailable.

For initial acceptance, inspect source fidelity, scope and future usefulness, recording omissions, incorrect extraction and revision reasons. Automated checks cannot replace this judgment.

## Reproduce extraction quality checks

Entity coverage uses the 16-case `test/fixtures/entity-extraction-quality.json` corpus (`omk-entity-quality/v2`). Beyond the original 12 cases it covers tool/log granularity, project-scoped paths and explicit renaming, corrections across turns with environment separation, and plans versus execution. Critical positions, identity separations, uncertainty, and role checks are frozen before output; the model receives source messages and coverage limits, never these answers. These remain synthetic cases, not a real-log distribution.

```bash
yarn build:runtime
node dist-scripts/bench/entity-extraction-quality.js --model <fixed-model> --repeat 2 --output /absolute/outside/repository/new-entity-run
```

Each case defaults to one call; `--repeat 2` makes two independent samples, at most 32 calls, without automatic retries. Separate subdirectories preserve each output. `critical-checks.json` uses `omk-entity-critical-checks/v1` to distinguish exact/containing spans, identity groups, separation, ambiguity, and observed knowledge roles. Optional knowledge omissions differ from role errors; extra entities still need semantic review. Repeated sampling is not deterministic replay or population-level stability evidence. Use `--prompt /absolute/previous-run/prompt.json` for a frozen prompt using the current v3 format; retain exact prompt bytes, corpus and input digests, and review outputs separately. Output must be a new directory outside the checkout. A successful exit means capture and structural admission succeeded, not semantic acceptance. Inspect and authorize message transmission before model calls; unreported cost remains unknown. The completed [v2/v3 report](../explanation/entity-extraction-quality.md) includes original evidence and its self-review limits; v2 is historical evidence and can no longer be replayed with the current tool.

Actual results on the current 16 cases are in the [two-round entity acceptance report](../explanation/entity-extraction-repeat-quality.md): collective references, quotation location, environment identity scope, and case organization still fail. Raw outputs, rejections, and self-review are retained separately; retries have not replaced failures.

Contributors can run six fixed cases in `test/fixtures/knowledge-extraction-quality.json`: empty content, unverified success, later correction, conditional rules, insufficient evaluation evidence, and a single outcome with gaps. These are synthetic scenarios and a repository rule excerpt, with review criteria written before generation; they are not an independently reviewed gold set or a representative sample of real conversations.

```bash
yarn build:runtime
node dist-scripts/bench/knowledge-extraction-quality.js --model <fixed-model> --output /absolute/outside/repository/new-run
```

This developer tool uses the existing Codex executor and makes one call per case without retries. Inspect the selected message text and authorize its transmission before running; costs are unknown unless reported. It includes the message-only coverage limitation and excludes review criteria from model input. It writes only to a new directory outside the checkout, preserving the prompt, corpus, digests, raw outputs, rejection reasons, and runtime metadata. Interrupting stops further calls. A successful exit means capture and structural validation succeeded; semantic review remains pending.

Review every output against its case criteria and original messages, recording omissions, misinterpretations and unnecessary candidates. Keep self-review distinct from independent human review. For a prompt comparison, preserve the first run’s `prompt.json`, use `--prompt /absolute/first-run/prompt.json` to reproduce a prompt using the current v3 format, keep model and corpus identical, and verify matching input digests. One run per case can expose a failure; it cannot establish stable extraction quality, a population improvement, or carrier effectiveness. Keep the current prompt when no observed failure justifies changing it.
