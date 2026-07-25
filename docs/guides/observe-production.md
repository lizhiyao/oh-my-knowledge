# Observe production traces

`omk observe` turns **real Codex rollouts and Claude Code session traces** into insight: where your knowledge actually got used, where it bumped into gaps, how stable execution was. Unlike [`omk eval`](../reference/cli) (a controlled offline experiment), observe is read-only production observation — **it does not score**, it surfaces signals.

It ships two workflows. For every flag see the [CLI reference](../reference/cli).

## A. Skill-health report (default)

Point it at a Codex or Claude Code trace directory:

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

## Turning observations into samples

Confirmed gaps from observe are exactly the failures your eval set is missing. `omk sample --from-traces` can draft regression cases from those signals — closing the observe → eval loop.

This command calls the sample generator through your configured executor and model, so trace-derived evidence is sent to that model and may incur generation cost:

```bash
omk sample --from-traces
```

It writes `.omk/observe-inbox/sample-drafts.json`. Treat the file as a review queue: inspect the draft, keep only reproducible cases, then merge the accepted ones into your real `eval-samples` file.

## Related

- [The three stages](../explanation/three-stage-workflow) — observe's place in the loop
- [Knowledge-gap signal spec](../specs/knowledge-gap-signal-spec) — what a gap signal is and how it's scored
- [CLI reference: `omk observe`](../reference/cli) — every flag and subcommand
