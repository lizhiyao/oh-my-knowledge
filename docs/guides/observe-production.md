# Observe production traces

`omk observe` normalizes **real Codex rollouts, Claude Code and OpenClaw sessions, and markdown conversation logs** into source-neutral Trace IR, then shows where knowledge was used, where it bumped into gaps, and how stable execution was. Unlike [`omk eval`](../reference/cli) (a controlled offline experiment), observe is read-only production observation — **it does not score**, it surfaces signals.

It ships two workflows. For every flag see the [CLI reference](../reference/cli).

## A. Skill-health report (default)

Point it at a supported trace directory or log file:

```bash
# ChatGPT desktop / Codex CLI
omk observe ~/.codex/sessions --last 7d

# Claude Code
omk observe ~/.claude/projects/-Users-you-Documents-my-project
omk observe ~/.claude/projects/my-project --last 7d
omk observe ~/.claude/projects/my-project --skills audit,polish
omk observe ~/.claude/projects/my-project --kb /path/to/project   # KB-aware analysis
```

You get a per-skill health report: knowledge usage, [gap signals](../specs/knowledge-gap-signal-spec) (where the agent wanted something and failed to find it), execution stability, tokens, and latency. The point is to find **real-world gaps your eval samples didn't cover** — those gaps become the next round of eval cases.

Scope the window with `--last 7d` / `--from … --to …`, and narrow to specific skills with `--skills`.

## B. Inbox: the reviewer loop

When you want to triage observations one by one, use the inbox. Steps 1-3 below are local-only and LLM-free; drafting regression samples is a separate optional authoring step that calls a generation model.

```bash
# 1. Parse traces, aggregate + de-noise signals, write to .omk/observe/inbox/
omk observe ingest ~/.codex/sessions
omk observe ingest ~/.claude/projects/my-project

# 2. Read the inbox (default top 20, sorted by severity / confidence / lastSeen)
omk observe inbox
omk observe inbox --skill audit          # filter by skill
omk observe inbox --by-skill             # one row per skill (rollup)
omk observe inbox --explore 10           # sample long-tail items from medium/low
omk observe inbox --json                 # JSON for automation

# 3. Inspect one observation with its surrounding messages
omk observe show <inbox_id>
```

Each observation carries its credibility (`confidence` + `attributionConfidence`, shown side by side so you can tell a strong signal from a shaky skill-attribution), a stable `severityReasonCode`, and a `messageWindow` (3 messages before / trigger / 3 after, plus whether the agent recovered) anchored back to the original JSONL.

Supported trace formats: Codex rollout JSONL, Claude Code session JSONL, OpenClaw session JSONL, and markdown conversation logs (`.log`). Codex records preserve the model, parent / child task grouping, tool calls, token usage, and `sourceKind=codex`; skill attribution follows actual `skills/<name>/SKILL.md` reads.

Both workflows persist an ingestion summary. If the source contains malformed records, valid JSON values that are not records, or events the current adapter cannot recognize, the CLI and Studio show a completeness notice. Review that notice before treating absence of a signal as evidence that no problem occurred. Runtime guardian sessions are counted separately as intentional filters.

## Inspect a task inside DeepSeek Harness

When the OMK bundle is installed and the profile provides `sessionPersistence`, no DSH log export is needed:

```text
/omk observe
/omk observe <session-id>
```

The first command lists recent terminal root sessions and excludes the current command session. The second reads the root and descendant logical logs through DSH's read-only `listSnapshots()` / `inspect()` seam, obtains a consistent snapshot, and returns its Studio Task Trajectory URL. JSONL, zstd, and SQLite backends are transparent to the user.

The first version is offline-only and does not follow a session that is still being written. Continuous revision changes, unknown required events, sequence gaps, unclosed turns / steps, or missing tool results prevent OMK from presenting the trace as complete. The page retains observable cwd, provider / model, message origins, tool outcomes, terminal status, and subagent lineage without inferring hidden reasoning.

## Inspect one task

Start `omk studio` directly; `observe ingest` is not required. Studio reads the local Codex conversation index and organizes Codex rollouts as **Thread → Turn**:

```bash
omk studio
```

Select a conversation from the overview, then choose one task to open **Task Trajectory**. The overview supports title and workspace search and separates running, unarchived, and archived conversations. The homepage currently indexes local Codex sessions directly; Claude Code, OpenClaw, and markdown traces still enter observation reports through `omk observe`.

Task boundaries prefer a source-native `turnId`, then lifecycle events such as `turn_started` / `turn_completed`. Only sources without native turn boundaries fall back to user-message segmentation. Skill attribution annotates knowledge related to the selected turn; it never defines the task boundary.

Task Trajectory projects source-neutral Trace IR into four observable lanes:

- **Conversation**: the original request, AI responses, and later user corrections;
- **Actions**: tool calls initiated by the AI;
- **Results**: paired tool returns and system events;
- **Knowledge**: runtime context and knowledge entering the task.

### Follow a running task live

Studio marks the most recent task as **Running** only while it is still active and has no terminal evidence, and brings it to the top. Opening that task starts a local event stream that updates the trajectory incrementally:

- **Following** keeps inspector state and smoothly advances the visible trajectory as new events arrive;
- **View updates** appears after you manually inspect an earlier position, so Studio does not steal the viewport;
- **Task ended** stops live following after a completion, interruption, or terminal event;
- **End status not recorded** replaces Running when an old unclosed log falls outside the activity window.

Live updates only reread local logs and refresh the current view; they do not call a model. `omk studio` uses the fixed port `7799` by default; pass `--port` explicitly to change it.

The page exposes three traceable layers with distinct responsibilities:

- **Semantic trajectory** projects Trace IR into the four lanes for human understanding. When a long task exceeds the display bound, the projection keeps tool calls paired with their results, retains the request, final answer, task boundaries, and failures first, then samples the remaining nodes across time instead of blindly dropping the middle;
- **Normalized events** list source-neutral Trace IR in source order so you can verify what the adapter extracted;
- **Raw logs** show the redacted, bounded JSONL archive stored beside the report so you can inspect the adapter input. Old reports, missing sources, and archive limits are reported explicitly. Opaque `encrypted_content` is acknowledged but never decrypted or presented as model reasoning.

**View raw log** in a semantic node detail first locates the corresponding source record, then falls back to the normalized event when raw logs are unavailable. This link uses source locators preserved by Trace IR; the renderer does not parse Codex-specific logs.

Codex session metadata is normalized as `session_context`, including the observable runtime version, Memory / History modes, context-window identity, dynamic tool names, and base instructions. Per-turn workspace, model, approval, and sandbox settings are recorded as `execution_context` or `settings`. These fields describe task inputs; they do not prove that the model used or followed them.

When needed, the page also surfaces integrity notices for truncation, malformed records, unknown events, and unmatched tool results. Unknown protocol records remain inspectable instead of being dropped silently.

Task Trajectory states only facts observable in the trace. Knowledge being injected, read, or returned does not prove that the model used it or that it caused the outcome.

## Turning observations into samples

Confirmed gaps from observe are exactly the failures your eval set is missing. `omk sample --from-traces` can draft regression cases from those signals — closing the observe → eval loop.

This command calls the sample generator through your configured executor and model, so trace-derived evidence is sent to that model and may incur generation cost:

```bash
omk sample --from-traces
```

It writes `.omk/observe/drafts/sample-drafts.json`. Treat the file as a review queue: inspect the draft, keep only reproducible cases, then merge the accepted ones into your real `eval-samples` file.

## Related

- [Reproduce Codex parent/subagent observation](./codex-observe-case) — executable Trace IR and compact-report case
- [The three stages](../explanation/three-stage-workflow) — observe's place in the loop
- [Knowledge-gap signal spec](../specs/knowledge-gap-signal-spec) — what a gap signal is and how it's scored
- [CLI reference: `omk observe`](../reference/cli) — every flag and subcommand
