# Sample design guide

> **For omk users**: how to declare measurement metadata on a sample, write sandbox fields, and self-check before running an eval. The academic alignment behind it (HELM / IRT / Construct Validity / contamination defense, etc.) and the schema-extension decisions are laid out in the appendix (§6) — we put the full rationale on the table rather than tucking it away in an internal note.

## 1. Why sample design needs to be rigorous

omk's statistical-rigor stack (Bootstrap CI / Krippendorff α / length-debias / saturation curves / verdict) answers "is the **conclusion** computed correctly". But **the conclusion is built on the sample set** — if the samples themselves aren't rigorous, all the downstream statistical rigor is hollow.

The most common construct mismatch: you run baseline-vs-skill intending to measure "is the skill well written" (quality), but what the sample set actually measures is "baseline doesn't know some domain knowledge vs the skill provides it" (necessity). Both produce equally impressive verdict numbers, but they answer different questions — and without sample metadata declaring the construct assumption, that mismatch is invisible at the verdict output layer.

## 2. Sample metadata schema

```yaml
# eval-samples.yaml
samples:
  - sample_id: s001
    prompt: "Draw a line chart in React; data is date + value, give minimal runnable code"
    rubric: "Must identify the Line component + correct data format + include a chart render container"
    assertions:
      - { type: contains, value: "Line", weight: 1 }
      - { type: regex, pattern: "data", weight: 1 }

    # Measurement metadata (docs/diagnostics only, never enter grading)
    capability:
      - component-recognition          # string[], capability dimensions, multiple allowed; normalized case/dash/camelCase-insensitive
      - api-selection
    difficulty: easy                    # 'easy' | 'medium' | 'hard' (strict enum, typo-proof)
    construct: necessity                # 'necessity' | 'quality' | 'capability' suggested, custom string allowed
    provenance: human                   # 'human' | 'llm-generated' | 'production-trace'
    sourceRefs:                         # structured from-traces provenance; never enters grading
      - sourceType: knowledge_gap
        sourceId: knowledge-gap:release-gate
        experienceSessionId: experience:release-session
        sourceTrace: /traces/codex.jsonl
    covers:                             # optional declared structure anchors for Skill Map
      - targetKind: reference
        ref: references/chart-api.md
      - targetKind: workflow_node
        ref: chart.render
```

### Field semantics

- **capability** (`string[]`): the capability dimensions this sample covers. Declare them from a capability-matrix perspective, so you can see "I cover component-recognition × 8 samples / api-selection × 6 samples / fallback × 2 samples, fallback is thin". Normalization rule: case-insensitive, plus dash / camelCase / underscore / space folding, so `api-selection` / `apiSelection` / `API_Selection` / `api selection` all count as the same capability.
- **difficulty** (enum): a simple bucketing (easy / medium / hard). A typo like `difficulty: 'easy?'` is rejected by `loadSamples` with an error that names the sample_id.
- **construct** (`string`): **which kind of thing this sample measures**. Distinct from capability: capability is "which concrete ability is tested" (api-selection), construct is "which construct type is tested". Three suggested values:
  - `necessity`: baseline-vs-skill, measures whether the skill is necessary at all. A large Δ doesn't necessarily mean the skill is well written — it may simply be that baseline doesn't know the domain knowledge (a self-evident conclusion).
  - `quality`: skill-v1 vs skill-v2, measures which phrasing of the same knowledge lets the model answer more accurately. This is where omk's measurement rigor truly earns its keep.
  - `capability`: measures the difference along one concrete capability dimension.
  Custom strings are allowed (e.g. `regression-test` / `cost-efficiency`); the studio won't error on a custom value.
- **provenance** (enum): data source. `human` (hand-curated) / `llm-generated` (auto-injected by `omk sample`) / `production-trace` (sampled from production traces, which you import yourself).
- **sourceRefs** (`SampleSourceRef[]`): structured provenance written by `omk sample --from-traces`. `sourceType` distinguishes an observation signal from a user-confirmed Knowledge Gap and can retain the concrete source ID, observed session, knowledge evidence, and original trace. It answers only “where did this draft come from”; it does not prove causality and never enters grading.
- **covers** (`{ targetKind, ref }[]`): optional declared skill-structure anchors this sample is intended to exercise. This is the structural sibling of `capability`: capability says which ability dimension is tested; covers says which concrete SKILL.md node, reference, script, hard rule, workflow, or workflow node the sample is meant to exercise. Studio uses it to show declared vs undeclared structure edges in Skill Map. It is not inferred from prompt text, and omitting it means "not declared yet", not "not tested".

### Never enters grading / judge / verdict

These metadata fields are used only for:

- the studio coverage block, plus the `rubric_clarity_low` / `capability_thin` issue detectors
- Skill Map declared anchors (`covers`)
- the `report.analysis.sampleQuality` aggregate (for tools to read)

**They never enter the judge prompt** (`buildJudgePrompt(prompt, rubric, output, traceSummary)` has no sample object in its signature, and `test/grading/judge-prompt-isolation.test.ts` guards against regressions). **They never affect the verdict algorithm.** This is a hard requirement for construct-validity protection — a judge seeing "construct: necessity" is a judge that knows the answer key.

### Sandbox eval fields (mocks / environment / tripwire / mocksStrict)

To run evals decoupled from the real external environment (databases / APIs / filesystem / actual git push, etc.), a sample also carries a group of sandbox fields. The omk runtime matches mocks before a tool call; on a hit it returns fake data instead of really invoking the underlying tool.

```yaml
- sample_id: s002
  prompt: "Use antlogs-query to count ERROR logs in the last 1 hour"
  rubric: "Must call the logstore_query tool, filter containing 'ERROR', time window 1 hour"
  assertions:
    - { type: tool_input_contains, value: "Bash:logstore_query", weight: 1 }
    - { type: mock_hit, value: "Bash:1", weight: 1 }
  mocksStrict: true              # default true (generator-enforced); an unmatched tool call is denied outright, never passed through to the real call
  tripwire: false                # whether this sample is a "trap sample" (deliberately lures the LLM into the wrong move; failing is expected); default false
  environment:                   # prompt-only task assumptions; no files or env vars are materialized
    cli_available: ["log-cli"]
    files_available: ["~/.config/log-cli.json"]
    notes: "log-cli is authenticated, token in env var"
  mocks:
    - tool: Bash                            # intercepted tool name: Bash / Read / Edit / Write / WebFetch / Grep / Glob, etc.
      match:
        command_glob: "*log-cli query --filter ERROR*"   # Bash uses command_glob (* wildcard, spans newlines)
      return:
        stdout: '{"count": 42}'
        exit: 0
    - tool: Read
      match:
        file_path_endswith: "tasks/state.json"           # recommended: suffix match, hits whether the LLM uses an absolute or relative path
      return: '{"status":"running"}'
    - tool: WebFetch
      match:
        url_glob: "https://internal.example.com/api/*"
      return: "ok"
```

**Field semantics:**

- **mocksStrict** (`boolean`, default `true`): a tool call that matches no mock is denied outright (the LLM sees a failure result). **Default behavior**: the `omk sample` generator force-writes `true` and the SYSTEM_PROMPT makes it explicit; for hand-written samples, the loader does not force-inject it when absent — an old sample without the field falls back to non-strict (passes through to the real call). **Strongly prefer `true` for new samples**, to avoid a missing mock letting the eval hit a real production system.
- **tripwire** (`boolean`, default `false`): this sample is a "trap sample" whose prompt deliberately plants a lure that violates the rubric/skill (e.g. "I already know it's X, just use it"), testing whether the LLM blindly follows the user's wrong instruction. The LLM **failing is the expected outcome**; diagnostics seeing `tripwire: true` won't suggest changing the skill, and the UI uses a purple verdict pill to distinguish it from a bug.
- **environment** (`object`, optional): prompt-only task assumptions. The LLM may skip availability probes (`which X` / `test -f Y` / `echo $Z`) and go straight into the workflow, but omk does not create files, export variables, or alter `PATH`. It is not a fixture mechanism. The doctor health check can still audit declared physical paths (skippable with `--skip-doctor`).
  - `cli_available: string[]` — assumed already on `PATH`
  - `files_available: string[]` — file/script paths referenced by the task statement; use `sample.cwd` or mocks for readable bytes
  - `notes: string` — free-text fallback, describing credential / env-var state, etc.
- **mocks** (`object[]`, optional): the tool-call interception list. At runtime, mocks are matched in array order, and the first hit returns one of `return` / `return_file` / `return_seq[hitCount]` as the tool_result.
  - **the `tool` field**: tool name (e.g. `"Bash"` / `"Read"` / `"Grep"`). The special value `"*"` wildcards any tool name, paired with `input_contains` for intent-level mocking.
  - **all entries under `match` are AND-ed**:
    - `file_path: string` — strict equality (`~` expanded). **Use only when you can predict the full path** (e.g. `~/.config/x.json`).
    - `file_path_endswith: string` — suffix match: `actual === suffix`, or `actual` ends with `suffix` right after a path separator (`/` or `\`). **The recommended default** (claude-cli internally normalizes relative paths to cwd-absolute paths, so strict equality always misses).
    - `url: string` / `url_glob: string` — for WebFetch / WebSearch, pick one.
    - `command_glob: string` — for Bash, `*` wildcards across newlines (so the LLM's multi-line commands still hit).
    - `input: object` — generic deep-equal subset match (any tool_input field).
    - `input_contains: string` — recursively scans all string values in tool_input; a hit if any contains the substring (case-insensitive). **Pair with `tool: "*"` for intent-level mocking**: when the LLM searches code it might use Bash grep / the Grep tool / Glob / Read / Agent / any tool; use `input_contains` to match intent by keyword instead of enumerating tools one by one. Example: `{tool: "*", match: {input_contains: "MyServiceName"}, return: "<service .../>"}` — any tool hits as long as its input mentions MyServiceName.
  - **`return` has three forms**: string / `{stdout, stderr, exit}` (simulates Bash) / `return_file` external file / `return_seq[]` state machine (the Nth hit on the same mock returns in order, falling back to `return` once exhausted).
- **assertion-side mock_hit / tool_input_contains**: used together with mocks. `mock_hit: "Bash:2"` means "the 2nd Bash mock must be hit at least once", proving the LLM reached that step. `tool_input_contains: "Bash:logstore_query"` checks that the Bash command string contains `logstore_query`.
  - Every `mock_hit` must reference a declared per-tool mock ordinal. The loader rejects missing or out-of-range references before execution.
  - Mock support is an executor capability, not a trace capability. `claude` / `claude-sdk` install interception hooks; `codex`, `codex-sdk`, Gemini, and direct API executors currently do not. Unsupported executors auto-generate mockless samples and reject existing mocked samples before evaluation.

**Relationship to grading / judge**: the sandbox fields (mocks / environment / tripwire / mocksStrict) **never enter the judge prompt** — the judge sees only prompt + rubric + LLM output + trace summary. tripwire only affects the diagnostic's attribution suggestion (the `tripwire_intentional` rootCause); it does not affect the layered scores or the verdict.

## 3. Sample-design analysis features

### Coverage block (rendered on the studio report page)

The studio renders each report's sample-design coverage into a summary like this:

```
  Sample-design diagnosis — health score 87/100
  Total samples: 20, flagged: 3 (errors=0, warnings=1, infos=2)

📋 Sample design coverage:
  capability:  componentrecognition (8) | apiselection (6) | errordiagnosis (4) | fallback (2)    [20/20 declared = 100%]
  difficulty:  easy (5) | medium (10) | hard (5)
  construct:   necessity (18) | quality (2)
  provenance:  human (15) | llm-generated (5)
  avgRubric:   45 chars

  [warning] capability_thin: 1 sample(s)
    ⚠ s019: capability "fallback" backed by only 2 samples (threshold 4, N=20) — a single sample failure makes this dimension's conclusion unstable

  [info] rubric_clarity_low: 1 sample(s)
    ℹ s007: rubric is only 12 chars and has no scoring-level word — ambiguous judge standard, judge scores may be unstable
```

The underlying data is persisted in `report.analysis.sampleQuality`, which tools can read directly as JSON.

### Two issue kinds

- **`rubric_clarity_low`** (severity: info): the rubric is shorter than 20 characters **AND** contains no scoring-level word (a 22-word zh/en list including "优秀/良好/合格/不合格/及格/满分/评分标准/至少包含" and English "excellent/good/poor/criterion/must include/at least", etc.). It's **AND** not OR, to avoid false-flagging a long rubric that just doesn't use a keyword. This is a **prior/static** signal, complementary to the existing `ambiguous_rubric` (posterior/runtime, derived from judge stddev).
- **`capability_thin`** (severity: warning): a capability declared by only ≤ `max(2, totalSamples * 0.2)` samples — that dimension has thin coverage, so a single sample failure makes the conclusion unstable. **Small-N guard**: when the total sample count is < 10 this check is **skipped entirely**, to avoid flagging everything in a small set.

## 4. Self-check checklist: is my sample design rigorous enough?

Run through this before an eval; any "no" is a reason to stop and think:

- [ ] **Construct declared**: does each sample know whether it measures necessity / quality / capability?
- [ ] **Capability coverage**: you claim to test N capability dimensions — does the sample set actually cover N? (the studio coverage block shows the real distribution)
- [ ] **Structure anchors**: for key references / workflows / hard rules, do at least 1-2 representative samples declare `covers`, so Skill Map can show which edges are explicit and which are still unstated?
- [ ] **Difficulty stratified**: do you have easy / medium / hard, or is everything hard so noise dominates?
- [ ] **Provenance transparent**: is the human-curated / LLM-generated / production-trace ratio reasonable? When LLM-generated is > 50%, watch for self-instruct risk (a self-reinforcing judge-bias loop).
- [ ] **Sample count**: `N < 5` (exploratory) / `N < 20` (only large effects detectable) / `N ≥ 20` (medium effects detectable) — omk pre-flight already warns.
- [ ] **Rubric clarity**: rubric ≥ 20 characters, with at least one scoring-level word (优秀/良好/必须包含/至少包含, etc.), so the judge has an actionable level standard.
- [ ] **Prompt doesn't leak the answer**: terms in the prompt shouldn't directly hand over the answer the rubric/assertion expects. If the prompt must contain some keyword (a product / library / API name) and the rubric also needs that word, you've weakened the "baseline has no knowledge" assumption — that's a natural sample trade-off and should be called out explicitly at design time.
- [ ] **Construct matches the experiment design**: when running baseline-vs-skill, `construct: necessity` is the right call. When running skill-v1-vs-skill-v2, it should be `construct: quality`.
- [ ] **Provenance guards against contamination**: an LLM-generated sample may share a source with the model's own training data (self-instruct bias); after `omk sample` marks it `'llm-generated'`, a manual review pass is the v1 contamination defense.
- [ ] **Capability_thin guard**: when N≥10, if a capability is propped up by only 1-2 samples, that dimension's conclusion is extremely unstable. Either add samples, or drop the capability (explicitly out of test scope).

## 5. How verdict interpretation pairs with construct

`omk eval` emits a verdict of PROGRESS / NOISE / REGRESS / CAUTIOUS / UNDERPOWERED / SOLO, and **the verdict does not distinguish construct types** — but your interpretation should:

- If the sample set is dominated by `construct: necessity` → PROGRESS means "the skill is necessary", and **must not be read as "the skill is well written"**. To measure quality, follow up with a skill-v1-vs-skill-v2 run (`construct: quality`).
- If the sample set is dominated by `construct: quality` → PROGRESS / REGRESS is the genuine "skill quality comparison" signal.

---

## 6. Appendix — design rationale (academic alignment & schema decisions)

This appendix lays out the reasoning behind the metadata schema: how omk's sample-design choices map to academic / industry consensus, which capabilities are deliberately out of v1 scope, and which v2 fields were considered and rejected (with reasons). It's here for the sake of full transparency — the practical guidance above is all you need to write good samples; this section answers "why it's designed this way."

### 6.1 Industry-consensus checklist & omk v1 coverage

omk's statistical-rigor stack (Bootstrap CI / Krippendorff α / length-debias / saturation curves / verdict) settles whether the **conclusion** is computed correctly — but the conclusion rests on the sample set. If the samples themselves aren't rigorous, all the downstream statistical rigor is built on sand. The table maps sample design to academic / industry consensus and marks omk v1's coverage.

| # | Industry gap | Academic / industry source | omk v1 status |
|---|---|---|---|
| 1 | **IRT item discrimination**: each item gets a (discrimination) / b (difficulty) / c (guessing) parameters; a < 0.3 is a junk item | [IrtNet (2510.00844)](https://arxiv.org/pdf/2510.00844), [Columbia IRT primer](https://www.publichealth.columbia.edu/research/population-health-methods/item-response-theory) | **out-of-scope** (IRT is unreliable at N<30; left as follow-up — the v1 `flat_scores` heuristic already covers part of it) |
| 2 | **Difficulty stratification**: stratify samples by difficulty (MMLU-Pro filters difficulty via multi-model majority-correct) | [MMLU-Pro](https://intuitionlabs.ai/articles/mmlu-pro-ai-benchmark-explained) | **in-scope**: `Sample.difficulty` enum + studio bucketing |
| 3 | **Construct-validity trio** (structural / convergent / discriminant) | [Measuring what Matters (2511.04703)](https://arxiv.org/abs/2511.04703), [Measurement to Meaning (2505.10573)](https://arxiv.org/html/2505.10573v3) | **in-scope**: `Sample.construct` field (suggested: necessity / quality / capability) + verdict-interpretation callout; convergent / discriminant auto-detection is follow-up |
| 4 | **Capability-matrix coverage** (HELM's 16×7 matrix) | [HELM (2211.09110)](https://arxiv.org/abs/2211.09110) | **partial**: `Sample.capability` string[] field + studio coverage bucketing + `capability_thin` issue; `Sample.covers` adds optional declared structure anchors for Skill Map; detailed matrix visualization is follow-up |
| 5 | **Contamination detection** (canary / paraphrase / timestamp-locked) | [BIG-Bench canary](https://www.lesswrong.com/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4), [LiveBench](https://livebench.ai/livebench.pdf), [contamination survey (2404.00699)](https://arxiv.org/html/2404.00699v4) | **partial**: `Sample.provenance` does "declarative" contamination tracking; real auto-detection is follow-up (needs an embedding model or training-data access) |
| 6 | **Sample provenance / dataset card** (the annotations_creators standard) | [HF Dataset Cards](https://huggingface.co/docs/hub/datasets-cards), [Synthetic Data survey (2503.14023)](https://arxiv.org/html/2503.14023v1) | **in-scope**: `Sample.provenance` enum + `omk sample` auto-injects `'llm-generated'` |
| 7 | **Adversarial / failure-driven mining** (Dynabench) | [Dynabench (2104.14337)](https://arxiv.org/abs/2104.14337) | **out-of-scope**: `omk evolve` is currently one-directional; adversarial mining is follow-up |
| 8 | **Production-trace natural-distribution sampling** | [Chatbot Arena (2403.04132)](https://arxiv.org/pdf/2403.04132) | **out-of-scope**: depends on external trace-system integration |

### 6.2 Acknowledged but not in v1 (follow-ups)

- IRT-style item discrimination (needs N≥30 + multi-model data)
- Multi-judge convergent / discriminant test (needs a ≥ 2-judge ensemble + aggregate analysis)
- Adversarial mining loop
- Production-trace natural-distribution sampling
- HTML renderer showing sample-design coverage (v1 is CLI-only)
- Evolve strategy upgrades (diversification signal / saturation-aware stop / health-weighted improvement)
- Gold-dataset auto-generation (reframed as an "annotation-process standardization" doc)
- Detailed N×D coverage-matrix visualization (v1 emits aggregate buckets + users visualize themselves)
- Contamination-detection algorithm implementation (canary string / paraphrase detection)
- User-defined rubric keyword list (`diagnostics.rubricKeywords` config)

### 6.3 v2 schema-extension candidates & rejection list

The initial schema kept four measurement-validity fields (capability / difficulty / construct / provenance) that answer *does this sample measure what it claims to measure?* `covers` extends that same diagnostic-only philosophy to the structural axis: *which concrete skill nodes does the author declare this sample is intended to exercise?* Another common community ask sits on the **asset-governance** axis: tags / risk_level / expected_facts / owner — answering *who owns this sample, where it came from, how important it is.* The axes are orthogonal and don't conflict, but governance assumes measurement is already solid; v1 chose to solve measurement first. This section records the v2 candidates and the rejection list so future decisions don't re-litigate them.

Concrete provenance has since shipped with Knowledge Debugger as structured `sourceRefs`, replacing the earlier flat `source_ids` idea. It preserves the Gap / observation, session, knowledge-evidence, and trace relationship while explicitly avoiding causal claims.

**v2 candidates (high-value, low-risk; add when real user demand triggers it)**

- **`status?: 'active' | 'deprecated' | 'superseded'`**: a lifecycle field. As a sample set evolves, knowing whether a sample is "primary" or "being retired" matters for verdict interpretation — a `deprecated` sample still runs but its Δ shouldn't count toward the headline conclusion. More important than `owner`.

**Rejected (with reasons, to avoid re-litigating)**

- **`tags?: string[]`**: semantically muddled with `capability`. capability is "which specific ability is tested"; the "regression / p0 / edge-case" tags want to add belong either to `capability` (an ability dimension) or to `status` (lifecycle). A free-form string with no enum constraint rots into a mess. **Decision**: don't add; force users to express it via capability + status.
- **`expected_facts?: string[]`**: heavily overlaps `rubric` + `assertions: contains`. omk's judge already does semantic scoring; expected_facts is just another alias for the same abstraction. **Decision**: don't add — it would create two places to write expectations during sample design, prone to drift.
- **`owner?: string`**: a governance field, mismatched with omk's measurement mission. omk doesn't consume `owner` for routing / notification; git blame / CODEOWNERS is the better home. **Decision**: don't add.
- **`risk_level?: 'p0' | 'p1' | 'p2'`**: raises a real question (should aggregation weight samples by risk?), but solving it would touch the verdict formula — a **measurement invariant**. Today verdict / Δ are sample-uniform; weighting them into the verdict breaks cross-version comparability. Pure noise without a consumer, breaks the invariant with one — a dilemma. **Decision**: don't add; if it's ever needed, it must be its own project, designing a weighted aggregator alongside verdict v2.

**Hard constraints before adding any new field**

- Must not enter the `buildJudgePrompt` signature (`test/grading/judge-prompt-isolation.test.ts` guards the regression)
- Must enter the complete-contract `sampleHash` by default. `sample_id` is the only excluded map key; any field that changes execution or interpretation must invalidate reuse and cross-report comparability.
- Must not enter the verdict / Δ algorithm
- Must not semantically overlap the existing metadata fields + `rubric` / `assertions`

### 6.4 Sources

- [Holistic Evaluation of Language Models (HELM, 2211.09110)](https://arxiv.org/abs/2211.09110)
- [Measuring what Matters: Construct Validity in LLM Benchmarks (2511.04703)](https://arxiv.org/abs/2511.04703)
- [Measurement to Meaning: A Validity-Centered Framework (2505.10573)](https://arxiv.org/html/2505.10573v3)
- [Position: Medical LLM Benchmarks Should Prioritize Construct Validity](https://openreview.net/pdf?id=YuMEUNNpeb)
- [Learning Compact Representations of LLM Abilities via Item Response Theory (IrtNet, 2510.00844)](https://arxiv.org/pdf/2510.00844)
- [IRT primer — Columbia Mailman](https://www.publichealth.columbia.edu/research/population-health-methods/item-response-theory)
- [MMLU-Pro Benchmark methodology](https://intuitionlabs.ai/articles/mmlu-pro-ai-benchmark-explained)
- [Synthetic Data Generation Survey (2503.14023)](https://arxiv.org/html/2503.14023v1)
- [Auto Evol-Instruct (2406.00770)](https://arxiv.org/html/2406.00770v1)
- [Dynabench (2104.14337)](https://arxiv.org/abs/2104.14337)
- [Comprehensive Survey of Contamination Detection (2404.00699)](https://arxiv.org/html/2404.00699v4)
- [LiveBench: Contamination-Free Benchmark](https://livebench.ai/livebench.pdf)
- [BIG-Bench Canary in GPT-4](https://www.lesswrong.com/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4)
- [How to Publish Benchmarks Without True Answers (2505.18102)](https://arxiv.org/html/2505.18102v1)
- [Hugging Face Dataset Cards](https://huggingface.co/docs/hub/datasets-cards)
- [Judging LLM-as-a-Judge with MT-Bench / Chatbot Arena (2306.05685)](https://arxiv.org/abs/2306.05685)
- [Chatbot Arena Open Platform (2403.04132)](https://arxiv.org/pdf/2403.04132)
