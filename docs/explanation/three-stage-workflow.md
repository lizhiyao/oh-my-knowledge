# The three stages: doctor / eval / observe

omk is organized around three stages that map onto the lifecycle of a piece of LLM knowledge (a prompt / RAG context / skill / agent). They answer three different questions, but they are not equal entry points. The trunk is the **pre-ship doctor → eval decision**; `observe` is the later production-feedback loop once real traces exist.

| Stage | Command | Question it answers | Software analogy |
|---|---|---|---|
| **doctor** | `omk doctor` | Is this artifact even well-formed enough to measure? | lint + typecheck + smoke test |
| **eval** | `omk eval` | Did this change actually make it better — provably? | the CI test suite |
| **observe** | `omk observe` | Does it hold up on real production traces? | production monitoring |

## The trunk: can I ship this change?

The first useful omk loop should feel like a release checklist:

```text
I changed a skill / prompt / agent artifact
→ doctor says whether it is structured, runnable, and measurable
→ eval says whether it beat the baseline on the same cases
→ the report / Studio view points to the next fix
→ I decide ship / don't ship
```

Until that loop is trustworthy, adding more surfaces around `observe`, export, badges, or bots is secondary. They can amplify a decision later; they cannot replace the controlled doctor → eval decision.

## doctor — preflight health, before you trust any number

`doctor` is a static + single-LLM-call health audit of one artifact: readability, metadata, dependencies, sample-contract alignment (static rules), plus LLM-scored dimensions (trigger boundary, doc clarity, instruction precision, …). It does **not** compare two versions — it tells you whether the artifact is in good enough shape to be measured at all.

It is also a **gate in front of eval**: `omk eval` runs the static doctor rules internally and refuses to run on a broken artifact, the same way CI runs lint before tests. A green doctor means "the measurement you're about to run won't be garbage-in"; a red doctor should point to the structure, dependency, or measurability problem to fix before comparing scores.

→ How-to: [run doctor checks](../guides/run-doctor-checks)

## eval — the measurement core

`eval` is the heart of omk: an **offline A/B** that fixes the model and the samples, varies only the artifact (and its runtime context), and asks "did the new version beat the old one, beyond noise?". It produces the six-dimension report, the statistical machinery (bootstrap CI, length-debias, saturation, inter-judge agreement), and a one-line **verdict** (PROGRESS / REGRESS / CAUTIOUS / NOISE / UNDERPOWERED / SOLO) you can gate CI on.

This is where omk's measurement rigor lives. Everything in [architecture](./architecture), [statistical rigor](./statistical-rigor), and the [scoring pipeline](../specs/scoring) is about making this one number trustworthy enough to support a ship/no-ship decision.

→ Concepts: [how it works](./architecture) · [scoring pipeline](../specs/scoring)
→ How-to: [evaluate an agent](../guides/agent-eval) · [auto-improve a skill](../guides/auto-improve-skills)

## observe — does it hold up in production?

`eval` is a controlled lab experiment on a fixed sample set. `observe` is the opposite end: it ingests **real Claude Code session traces** and turns them into a skill-health report — knowledge usage, [gap signals](../specs/knowledge-gap-signal-spec), execution stability, cost, latency. It is **observation, not scoring**: it tells you where the knowledge base bumped into the unknown in real usage, so your next round of samples can target it.

That makes `observe` a post-ship input, not the first thing to polish. If a team has no real trace flow yet, the best next investment is usually a stronger doctor / eval release loop, not a richer production graph.

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

The release loop is already useful at doctor → eval. The production loop closes later: observe surfaces real-world gaps → those become new eval samples → eval proves the next fix → doctor keeps each iteration well-formed. `omk evolve` automates the inner doctor → eval → rewrite loop; `omk sample` helps generate the test cases that feed it.
