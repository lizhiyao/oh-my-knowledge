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
# 1. Parse traces, aggregate + de-noise signals, write to .omk/observe-inbox/
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

## Turning observations into samples

Open **Debug Knowledge** from a task in Studio's observation inbox to inspect the timeline and the knowledge that was injected, read, or returned by tools. You can then record missing, stale, conflicting, or out-of-scope knowledge. A recorded Gap is a user diagnosis, not a system-proven root cause.

After recording a Gap, the page provides a precise recycling command:

```bash
omk sample --from-traces --gap knowledge-gap:<id>
```

The generated drafts retain structured `sourceRefs` to the Gap, observed session, knowledge evidence, and original trace. Omitting `--gap` still drafts from all eligible failure signals in the observation inbox:

This command calls the sample generator through your configured executor and model, so trace-derived evidence is sent to that model and may incur generation cost:

```bash
omk sample --from-traces
```

It writes `.omk/observe-inbox/sample-drafts.json`. Treat the file as a review queue: keep only reproducible cases, merge accepted drafts into the real `eval-samples` file, then use `doctor → eval` to determine whether the candidate knowledge actually improves the result.

## Related

- [Reproduce Codex parent/subagent observation](./codex-observe-case) — executable Trace IR and compact-report case
- [The three stages](../explanation/three-stage-workflow) — observe's place in the loop
- [Knowledge-gap signal spec](../specs/knowledge-gap-signal-spec) — what a gap signal is and how it's scored
- [CLI reference: `omk observe`](../reference/cli) — every flag and subcommand
