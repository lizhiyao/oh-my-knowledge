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

Contributors can run six fixed cases in `test/fixtures/knowledge-extraction-quality.json`: empty content, unverified success, later correction, conditional rules, insufficient evaluation evidence, and a single outcome with gaps. These are synthetic scenarios and a repository rule excerpt, with review criteria written before generation; they are not an independently reviewed gold set or a representative sample of real conversations.

```bash
yarn build:runtime
node dist-scripts/bench/knowledge-extraction-quality.js --model <fixed-model> --output /absolute/outside/repository/new-run
```

This developer tool uses the existing Codex executor and makes one call per case without retries. Inspect the selected message text and authorize its transmission before running; costs are unknown unless reported. It includes the message-only coverage limitation and excludes review criteria from model input. It writes only to a new directory outside the checkout, preserving the prompt, corpus, digests, raw outputs, rejection reasons, and runtime metadata. Interrupting stops further calls. A successful exit means capture and structural validation succeeded; semantic review remains pending.

Review every output against its case criteria and original messages, recording omissions, misinterpretations and unnecessary candidates. Keep self-review distinct from independent human review. For a prompt comparison, preserve the first run’s `prompt.json`, use `--prompt /absolute/first-run/prompt.json` to reproduce that version, keep model and corpus identical, and verify matching input digests. One run per case can expose a failure; it cannot establish stable extraction quality, a population improvement, or carrier effectiveness. Keep the current prompt when no observed failure justifies changing it.
