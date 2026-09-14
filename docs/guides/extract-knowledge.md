# Extract candidate knowledge from work logs

Select one Codex JSONL log, extract facts, cases or methods, and inspect each candidate against its original records. Retaining a candidate means choosing to maintain it; it does not verify its truth. This workflow does not automatically edit AGENTS.md, skills or other active artifacts.

## Capture and generate

Choose an explicit local workspace shared by CLI and Studio. Replace paths and identities below with your own values:

```bash
omk observe knowledge capture --workspace ./knowledge --source ./session.jsonl --json
omk observe knowledge source --workspace ./knowledge --snapshot <snapshot-id> --json
omk observe knowledge generate --workspace ./knowledge --snapshot <snapshot-id> --json
omk observe knowledge list --workspace ./knowledge --json
```

Capture is local and makes no model call. Optional `--start-record 10 --end-record 30` selects inclusive, zero-based nonempty record indices. Inspect the captured scope, excerpts and limitations before generating.

By default, `generate` runs entirely locally without global model defaults, agent processes or network calls. Node reads and parses the source; the shared application selects candidates, validates citations and persists them. CLI and Studio provide the interaction layer.

Local rules select single-line user/assistant entries starting with `Lesson:`, `Rule:`, `Method:`, `经验：`, `规则：`, `方法：`, or `教训：`, with optional list prefixes. Tool output, quote lines and fenced blocks are skipped. Entries are limited to 4096 characters and the first 12 matches per run; no matches means zero candidates. Text is preserved verbatim. Business entities, conditions and semantics are not parsed: this is excerpt selection, not completed knowledge synthesis. Narrow the source record range to process further entries.

For semantic synthesis, explicitly supply both `--executor openai-api --model <model>` (or `anthropic-api`). This sends selected excerpts and scope limitations using the configured API credentials and may incur charges; requests provide no tools. Agent executors without a verified isolation boundary are unavailable. Native paths and raw envelopes are excluded, but the selected text may contain sensitive information, so preview it first.

Runs record `knowledge-local-rules-v1` separately from model extraction versions. Existing runs and revisions remain readable.

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

Run `omk studio` and open its returned address. On Knowledge, choose the work-log extraction entry, enter the same workspace and open it. Select a log, inspect the scope and generate locally. Explicitly choose an API executor and model only when semantic synthesis is needed. Candidates and original records appear side by side, including links to entity mentions. Editing, retaining, discarding and reopening use the same application and persistence protocol as CLI.

## Recovery and data

Use `generate --run-id <UUID>` to identify one request. Retrying that request does not call the model again; do not reuse it for different input or runtime configuration.

```bash
omk observe knowledge runs --workspace ./knowledge --json
omk observe knowledge resume --workspace ./knowledge --id <run-id> --json
```

Resume handles already persisted output or pending writes, never regenerating. If a process exits before persisting output, its run may remain generating. Confirm the original process ended before deliberately starting a new run. Failure or cancellation is not successful delivery.

The workspace contains source snapshots, revisions and raw generation output, which can contain private data. `delete-source --snapshot <snapshot-id>` removes that snapshot and leaves an unavailable marker. It does not alter the original log or erase quoted text in revisions or model output; it is not a complete workspace wipe. Missing, corrupt or deleted sources remain explicitly unavailable.

For initial acceptance, inspect source fidelity, scope and future usefulness, recording omissions, incorrect extraction and revision reasons. Automated checks cannot replace this judgment.
