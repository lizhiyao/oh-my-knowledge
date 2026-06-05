# Sample design guide

> **For omk users**: how to declare measurement metadata on a sample, write sandbox fields, and self-check before running an eval. Academic alignment (HELM / IRT / Construct Validity / contamination defense, etc.) and schema-extension decisions live in the maintainer's internal notes and are out of scope here.

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

    # 4 optional metadata fields (docs/diagnostics only, never enter grading)
    capability:
      - component-recognition          # string[], capability dimensions, multiple allowed; normalized case/dash/camelCase-insensitive
      - api-selection
    difficulty: easy                    # 'easy' | 'medium' | 'hard' (strict enum, typo-proof)
    construct: necessity                # 'necessity' | 'quality' | 'capability' suggested, custom string allowed
    provenance: human                   # 'human' | 'llm-generated' | 'production-trace'
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

### Never enters grading / judge / verdict

These 4 fields are used only for:

- the studio coverage block, plus the `rubric_clarity_low` / `capability_thin` issue detectors
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
  environment:                   # pre-eval "already provisioned" declaration; the LLM sees it and skips environment probing
    cli_available: ["log-cli"]
    files_available: ["~/.config/log-cli.json"]
    env_required: ["LOG_TOKEN"]
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
- **environment** (`object`, optional): a "ready" precondition declaration for the eval environment — after reading it the LLM skips environment probing (`which X` / `test -f Y` / `echo $Z`) and goes straight into the workflow. Think of it as a unit test's fixture / setup. **It is only a prompt hint to the LLM; it does not actually create files or export variables.** The doctor health check scans it for physical-path checks (skippable with `--skip-doctor`).
  - `cli_available: string[]` — assumed already on `PATH`
  - `files_available: string[]` — assumed-existing files/scripts
  - `env_required: string[]` — assumed already-exported environment variables
  - `notes: string` — free-text fallback, describing credential state, etc.
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

**Relationship to grading / judge**: the sandbox fields (mocks / environment / tripwire / mocksStrict) **never enter the judge prompt** — the judge sees only prompt + rubric + LLM output + trace summary. tripwire only affects the diagnostic's attribution suggestion (the `tripwire_intentional` rootCause); it does not affect the layered scores or the verdict.

## 3. Sample-design analysis features

### Coverage block (rendered on the studio report page)

The studio renders each report's sample-design coverage into a summary like this:

```
  用例质量诊断 — health score 87/100
  用例总数: 20, flagged: 3 (errors=0, warnings=1, infos=2)

📋 Sample design coverage:
  capability:  componentrecognition (8) | apiselection (6) | errordiagnosis (4) | fallback (2)    [20/20 声明 = 100%]
  difficulty:  easy (5) | medium (10) | hard (5)
  construct:   necessity (18) | quality (2)
  provenance:  human (15) | llm-generated (5)
  avgRubric:   45 字符

  [warning] capability_thin: 1 sample(s)
    ⚠ s019: capability "fallback" 只 2 个 sample 撑（阈值 4，N=20）—— 单 sample 失败会让该维度结论不稳

  [info] rubric_clarity_low: 1 sample(s)
    ℹ s007: rubric 仅 12 字且未含评分级别词 —— 评委标准模糊，可能 judge 分数不稳
```

The underlying data is persisted in `report.analysis.sampleQuality`, which tools can read directly as JSON.

### Two issue kinds

- **`rubric_clarity_low`** (severity: info): the rubric is shorter than 20 characters **AND** contains no scoring-level word (a 22-word zh/en list including "优秀/良好/合格/不合格/及格/满分/评分标准/至少包含" and English "excellent/good/poor/criterion/must include/at least", etc.). It's **AND** not OR, to avoid false-flagging a long rubric that just doesn't use a keyword. This is a **prior/static** signal, complementary to the existing `ambiguous_rubric` (posterior/runtime, derived from judge stddev).
- **`capability_thin`** (severity: warning): a capability declared by only ≤ `max(2, totalSamples * 0.2)` samples — that dimension has thin coverage, so a single sample failure makes the conclusion unstable. **Small-N guard**: when the total sample count is < 10 this check is **skipped entirely**, to avoid flagging everything in a small set.

## 4. Self-check checklist: is my sample design rigorous enough?

Run through this before an eval; any "no" is a reason to stop and think:

- [ ] **Construct declared**: does each sample know whether it measures necessity / quality / capability?
- [ ] **Capability coverage**: you claim to test N capability dimensions — does the sample set actually cover N? (the studio coverage block shows the real distribution)
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

> Academic alignment (HELM / IRT / the Construct Validity trio / contamination defense), the 8-point mapping to industry consensus, and the v2 schema-extension candidate-and-rejection list: see the maintainer's internal notes at `design-notes/sample-design-theory.md`.
