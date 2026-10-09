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

Local Node code reads and parses the log; the model receives only the prepared selected excerpts. CLI and Studio share this application flow. Codex runs in an empty temporary working directory with the executor’s read-only sandbox and ignore-user-config/ignore-rules arguments, and is instructed not to call tools. Any observed tool call causes rejection of the output; this is not a strict guarantee against all file access. API requests provide no tools. The keyword-excerpt entry has been removed; existing local-rule run records remain readable.

Zero candidates is valid. Invalid proposals retain rejection reasons. Exact quote matching checks location integrity, not truth. Recorded behavior, source assertions and inference remain distinct; missing conditions and times remain unknown.

## Inspect and maintain

```bash
omk observe knowledge show --workspace ./knowledge --id <knowledge-id> --json
omk observe knowledge retain --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 1 --reason 'Useful for later work on this project'
```

Read the revision identity and `history.generation` from the latest detail. `discard` uses the same arguments and records a reason without deleting history. On conflicts, reread and inspect changes before retrying.

For edits, copy only `title`, `content`, `entities` and `evidence` from the returned `revision` into a JSON draft. Correct statements, entity labels, context or evidence interpretations:

```bash
omk observe knowledge revise --workspace ./knowledge --id <knowledge-id> --revision <revision-id> --generation 2 --input ./draft.json --reason 'Clarify the applicable conditions'
```

Use the actual generation, not the example number. Edits create a new revision that awaits review and does not inherit the previous retain choice. Source positions remain bound; new entity identities or source references require new extraction. Read old revisions using `show --revision <old-revision-id>`.

## Studio

Start `omk studio` and use the returned address. The primary **Knowledge** entry opens **Extracted knowledge**. Search titles or filter by undecided, retained, or discarded items. **Knowledge artifacts** opens saved artifacts; doctor and observation data remain in the **Doctor and observe** tab.

While reading an observed conversation, choose **Extract this turn** to confirm that turn’s selected messages, save location, and model directly. On the Knowledge page, **Choose a conversation** or **Extract new knowledge** lets you select a conversation and turn in place. Choose the entire conversation when a wider scope is needed. Expand message and configuration adjustments as needed; the model is called only after **Start extraction**. Successful extraction opens candidate review directly. Empty results, failure, or cancellation keep a result message; recover saved content through **Extraction history** or the conversation’s **Extracted knowledge**.

You can also import a local log through **More** and preview its scope before generating. The save location travels with internal navigation. **Save location** changes this operation only; edit the long-term default through **Settings and help** in the sidebar. Existing data does not move.

Review the content, conditions, and unknowns, then use **Inspect evidence** to locate the source. Narrow screens switch between **Candidate content** and **Source evidence**. Classification, time, and revision history expand on demand. Enter a reason to retain or discard, or select and edit a reason preset; selecting a reason does not make a decision. After saving the decision, review advances to the next undecided candidate in this extraction, without entering other extractions. Revisit the previous item or return to all knowledge. Editing creates a new revision and stays on the current candidate for a new review and decision. Once all items are handled, a batch summary shows retained and discarded counts with actions to revisit or return to the source conversation. **Review this batch** in **Extraction history** reopens the saved candidates from that extraction.

Reopen retained content under **Knowledge → Extracted knowledge**. Retention does not automatically edit artifacts; **Generate knowledge artifact** starts explicit generation and saving.

## Generate and save knowledge artifacts

Choose **Generate knowledge artifact** on a retained candidate or completed batch, or **Generate from retained knowledge** in **Knowledge artifacts**. Choose skill or prompt, enter a name, inspect the selected retained knowledge, and choose **Generate and review**. Initial selections include only the current candidate or retained items from this batch; explicitly add other retained items if needed, up to 100 per operation. Generation organizes existing material while retaining conditions, exceptions, unknowns, claim and evidence classifications, quotes, and source versions. It makes no additional model call.

Review and edit the new content, then choose **Save artifact**. Content is saved directly under the current knowledge directory as `artifacts/<artifact-id>/vN/content/<directory-name>/SKILL.md` or `artifacts/<artifact-id>/vN/content/<directory-name>.md`. The artifact detail opens with the actual artifact path, content, knowledge sources, and version history. Display names may contain Chinese text. New artifacts receive distinct file names; skill frontmatter names match their directory names, and valid frontmatter is checked on save, following the [Agent Skills format](https://agentskills.io/specification). No clipboard step is required. Source links open the exact incorporated knowledge revision. Saving does not verify truth or effectiveness; check applicability and run a controlled evaluation before use.

To update an artifact, select a saved artifact or explicitly provide a local file path. The preview preserves original content and appends new knowledge; switch to the original content to compare, then save a new version. When starting from local `SKILL.md`, distributable assets in the same directory are copied using the existing filtering and content digest rules. The original file is preserved. Choose another knowledge directory if the save location is inside the local skill being copied. Already incorporated knowledge revisions are not appended twice, and old artifact versions remain readable. Select the latest version before generating further updates.

Each `manifest.json` uses `omk-carrier-v1`, recording artifact identity, version, save time, content digest, file directory name, baseline, and exact knowledge revision references. This is an additive artifact storage contract; candidates, source snapshots, and existing evaluation data are preserved. Changes to the current knowledge revision, retain decision, or artifact baseline after preview reject stale saves and require a new preview. External artifact edits are marked as content changes. A complete staged version is published atomically; failure or cancellation does not replace old versions. After a local writer exits, the next save recovers its dead lock once it is over 30 seconds old and removes unpublished staging; locks owned by another host are not taken over. If the save result cannot be read, choose **Check saved version** before attempting another write.

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
