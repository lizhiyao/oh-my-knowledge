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

Start `omk studio` and use the returned address. The primary **Knowledge** entry opens **Extracted knowledge**. Search titles or filter by undecided, retained, or discarded items. **Knowledge artifacts** separately presents doctor and observation data.

Choose **Choose a conversation** or **Extract new knowledge**, then select **Extract knowledge** in a conversation or task detail. Confirm the selected messages, save location, and model first. You can also import a local log and preview its scope before generating. The save location travels with internal navigation. **Save location** changes this operation only; edit the long-term default through **Settings and help** in the sidebar. Existing data does not move.

Review the content, conditions, and unknowns, then use **Inspect evidence** to locate the source. Narrow screens switch between **Candidate content** and **Source evidence**. Classification, time, and revision history expand on demand. Enter a reason to retain or discard. Editing creates a new revision that needs a new decision. Revisit older revisions or continue with the next undecided item.

Reopen retained content under **Knowledge → Extracted knowledge**. Before using it in a task, review its conditions, manually update AGENTS.md, a skill, or another artifact, then evaluate the change in a controlled comparison. Retention does not automatically update artifacts or verify effects.

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
