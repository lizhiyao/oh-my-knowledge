# The three stages: doctor / eval / observe

OMK uses doctor, eval, and observe to answer different questions across an artifact’s lifecycle. Start with **doctor → eval** when you have a change, or **Studio → observation and review** when you have work logs. Real tasks can come from development, trials, or production; observation does not require a prior evaluation.

| Stage | Command | Question it answers | Software analogy |
|---|---|---|---|
| **doctor** | `omk doctor` | Is this artifact even well-formed enough to measure? | lint + typecheck + smoke test |
| **eval** | `omk eval` | Does current evidence support this change? | the CI test suite |
| **observe** | `omk observe` | Does it hold up on real production traces? | log analysis |

<a id="knowledge-entities-and-carriers"></a>

See [How OMK understands knowledge](./knowledge.md) for the conceptual foundation of knowledge, entities, and carriers. This page focuses on how the three stages work together.

## The trunk: can I ship this change?

The first useful omk loop should feel like a release checklist:

```text
I changed a skill / prompt / agent artifact
→ doctor says whether it is structured, runnable, and measurable
→ eval says whether it beat the baseline on the same cases
→ the report / Studio view points to the next fix
→ I decide ship / don't ship
```

You can also start in Studio, inspect a real task, extract knowledge items from selected log excerpts, or turn confirmed problems into evaluation cases. Knowledge review helps decide what to change; controlled comparison tests whether an artifact change helps. These evidence types cannot replace each other.

## doctor — preflight health, before you trust any number

`doctor` combines static checks and an LLM health audit of one artifact (repeated sampling and consolidation by default): readability, metadata, dependencies, sample-contract alignment (static rules), plus LLM-scored dimensions (trigger boundary, doc clarity, instruction precision, …). It does **not** compare two versions — it tells you whether the artifact is in good enough shape to be measured at all.

It is also a **gate in front of eval**: `omk eval` runs the static doctor rules internally and refuses to run on a broken artifact, the same way CI runs lint before tests. Passing checks does not guarantee representative cases or a valid conclusion. Failed checks point to structure, dependency, or measurability problems to fix before comparing scores.

→ How-to: [run doctor checks](../guides/run-doctor-checks)

## eval — the measurement core

`eval` is the heart of omk: an **offline A/B** that fixes the model and samples, varies only the artifact and its sealed runtime context, and asks "did the new version beat the old one, beyond noise?". It produces authenticated Execution／Evaluation／Analysis evidence, Bootstrap uncertainty, coverage and agreement diagnostics, and a registered **Decision** (`PROGRESS` / `REGRESSION` / `CAUTIOUS` / `NOISE` / `UNDERPOWERED` / `SOLO`) that can route CI.

This is where omk's measurement rigor lives. Everything in [architecture](./architecture), [statistical rigor](./statistical-rigor), and the [scoring pipeline](../specs/scoring) explains how decisions, coverage, uncertainty, and source evidence together support a ship/no-ship decision.

→ Concepts: [how it works](./architecture) · [scoring pipeline](../specs/scoring)
→ How-to: [evaluate an agent](../guides/agent-eval) · [auto-improve a skill](../guides/auto-improve-skills)

## observe — does it hold up in production?

`eval` is a controlled lab experiment on a fixed sample set. `observe` is the opposite end: it normalizes **real Codex rollouts, Claude Code and OpenClaw sessions, and markdown conversation logs** into source-neutral Trace IR and turns them into a skill-health report — knowledge usage, [gap signals](../specs/knowledge-gap-signal-spec), execution stability, token use, and latency. It is **observation, not scoring**: it tells you where the knowledge base bumped into the unknown in real usage, so your next round of samples can target it.

`omk studio` directly browses local Codex conversations and four-lane task trajectories without prior ingest; active tasks support live following. Reading logs makes no model calls and does not treat knowledge access as a cause of outcomes.

[Knowledge extraction](../guides/extract-knowledge.md) generates content for review from selected Codex excerpts, preserving sources, conditions, revisions, and reasons. Generation calls a model; retaining content neither verifies it nor writes it into an artifact. [MCP feedback](../guides/mcp-integration.md) records observations with user confirmation; draft cases only after review confirms a real issue.

→ How-to: [observe production traces](../guides/observe-production)

## How they chain

```
write / change an artifact
        │
        ▼
   omk doctor      → is it well-formed?  (gate)
        │ green
        ▼
   omk eval        → is the change a real improvement?  (verdict → CI gate)
        │ shipped
        ▼
   omk observe     → does it hold up in production?  → feeds new samples back into eval
```

The release loop is already useful at doctor → eval. The production loop closes later: observe surfaces real-world gaps → those become new eval samples → eval measures the next fix → doctor keeps each iteration well-formed. `omk evolve` automates the inner doctor → eval → rewrite loop; `omk sample` helps generate the test cases that feed it.
