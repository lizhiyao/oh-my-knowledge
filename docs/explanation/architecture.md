# How it works

Core idea: **fix the model and the samples, vary only the artifact and runtime context**, use interleaved scheduling to cancel time drift, score via assertions + LLM judge (dual channel), then layer on knowledge-gap signals to quantify risk exposure.

```mermaid
flowchart TD
    subgraph Input["① Input"]
        S["eval-samples<br/>(JSON / YAML)"]
        A["artifacts<br/>skills/*.md · SKILL.md<br/>baseline · git:name"]
    end

    subgraph Prep["② Preprocess (resolve & fetch)"]
        V["variant resolution<br/>variant → artifact + runtime context<br/>(cwd / project CLAUDE.md / local skills)"]
        U["URL fetching<br/>URLs in prompt / context<br/>MCP Server(private docs) → HTTP"]
    end

    subgraph Schedule["③ Interleaved + concurrent scheduling"]
        Q["s1-v1 → s1-v2 → s2-v1 → s2-v2 …<br/>--concurrency N · --repeat N"]
    end

    subgraph Exec["④ Executor (fixed model)"]
        E["claude / claude-sdk / codex / openai / gemini<br/>anthropic-api / openai-api / custom"]
        T["claude-sdk / codex extract<br/>turns / toolCalls trace"]
        E -.-> T
    end

    subgraph Score["⑤ Dual-channel scoring"]
        AS["assertions<br/>content / structure / cost / latency<br/>agent: tools_called · turns_min …"]
        LS["LLM judge<br/>rubric · dimensions (independent per-dim scores)"]
        CS["composite score<br/>mean of present layers — fact · behavior · judge"]
        AS --> CS
        LS --> CS
    end

    subgraph Analyze["⑥ Auto analysis + knowledge gaps"]
        D["low-discrimination / flat scores / all-pass or all-fail<br/>expensive samples · variance · t-test"]
        G["knowledge-gap signals<br/>(quantify risk exposure, not completeness proof)"]
    end

    subgraph Report["⑦ Report"]
        R["Six dims: Fact / Behavior / LLM-judge / Cost / Efficiency / Stability<br/>JSON + HTML · top verdict pill<br/>CLI/Node/version fingerprint traceable"]
    end

    S --> U
    A --> V
    V --> Q
    U --> Q
    Q --> E
    T --> AS
    E --> AS
    E --> LS
    CS --> D
    CS --> G
    D --> R
    G --> R
```

**Key design choices:**

- **Interleaved scheduling** removes time drift: different variants of the same sample are dispatched alternately rather than "all of v1 then all of v2", so model load / network jitter can't be mis-attributed to the artifact.
- **variant = artifact + runtime context**: the `cwd` (declared via `--control-cwd`/`--treatment-cwd` or eval.yaml's `cwd:` field, separate from the artifact expression) lets control groups explicitly declare the "project directory" input, separating "project-level accumulated knowledge" from "explicit artifact injection".
- **Dual-channel scoring is complementary**: assertions catch deterministic defects (must call tool X, must contain field Y); the LLM judge catches subjective quality (readability, completeness). The composite is the mean of whichever scoring layers (fact / behavior / judge) are actually present.
- **Knowledge-gap signals** are not part of the score — they are an independent tracking channel that tells you "how much risk exposure this evaluation covered", for convergence tracking, not as a completeness proof.

## Six-dim evaluation

Reports display results across six independent dimensions. The three scoring layers — Fact / Behavior / LLM-judge — are shown separately so you see **which layer regressed** instead of a single composite number:

| Dimension | Metric | Description |
|---|---|---|
| 📋 **Fact** | fact-assertion pass rate | rule-verifiable assertions like `contains` / `json_schema` / `fact_check`, mapped to 1-5 |
| 🛠️ **Behavior** | behavior-assertion pass rate | execution-compliance assertions like `tools_called` / `tool_output_contains` / `turns_max` |
| 💬 **LLM-judge** | rubric score | 1-5 scored by the judge model against a predefined rubric; subjective, catches what rules miss |
| 💰 **Cost** | total cost, input/output tokens | API cost based on token usage and model pricing |
| ⚡ **Efficiency** | average latency (ms) | end-to-end latency from request to full response |
| 🛡️ **Stability** | CV (coefficient of variation) | score consistency across repeated runs (`--repeat ≥ 2`); single-run shows `—`, **honestly acknowledging what can't be measured** |
