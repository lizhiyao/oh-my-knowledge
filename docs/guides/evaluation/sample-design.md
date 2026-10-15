# omk sample design guide

This page helps users author and review current v3 samples. The [sample format](../../reference/evaluation/eval-sample-format.md) owns the complete field contract; [input compilation](../../specs/evaluation/cli-evaluation-input-compilation.md) owns identity, sealing, and execution boundaries. This guide does not define another schema.

## 1. Why sample design needs to be rigorous {#_1-why-sample-design-needs-to-be-rigorous}

Statistical analysis answers questions within the declared samples and measurement design. Comparing a baseline with a skill tests a different hypothesis from comparing two skill revisions; scores alone do not prove necessity, knowledge correctness, or real-world benefit. State the goal, scope, control conditions, and expected evidence before designing samples.

## 2. Sample metadata schema {#_2-sample-metadata-schema}

```yaml
schemaVersion: omk.eval-sample-set/v3
samples:
  - sampleId: s001
    input:
      inputKind: text
      text: Draw a line chart in React; data is date + value, give minimal runnable code
    evaluationContext:
      rubric:
        component_selection:
          criterion: Must identify the Line component and use the correct data format
          weight: 0.6
        completeness:
          criterion: Must include a chart render container
          weight: 0.4
      assertions:
        - type: contains
          value: Line
          weight: 1
        - type: regex
          pattern: data
          weight: 1
    annotations:
      capability:
        - component-recognition
        - api-selection
      difficulty: easy
      construct: necessity
      provenance: human
      covers:
        - targetKind: reference
          ref: references/chart-api.md
        - targetKind: workflow_node
          ref: chart.render
```

### Field semantics {#field-semantics}

- **capability** (string[]): Author-declared capability labels. Keep spelling and case consistent yourself; current implementation promises neither automatic normalization nor capability-distribution aggregation.
- **difficulty** (enum): `easy` / `medium` / `hard`; the schema rejects invalid values before execution. This is an author declaration, not statistically calibrated difficulty.
- **construct** (string): An author-declared measurement hypothesis, such as `necessity`, `quality`, or `capability`. Custom values are allowed; declaring one does not validate the construct.
- **provenance** (enum): `human` / `llm-generated` / `production-trace`. `omk sample` declares generated samples as `llm-generated`; authors must verify imported sources.
- **covers** (`{ targetKind, ref }[]`): Author-declared structural anchors, such as a reference, workflow, or workflow node. Missing declarations do not mean missing coverage; declarations do not prove the model actually used a node.

### Never enters grading / judge / verdict {#never-enters-grading-judge-verdict}

These fields become Sample annotations for auditing and interpretation. The current Rubric judge does not read them; they do not automatically change scoring weights or a registered Decision. Sandbox execution controls have a separate role: fields that actually change execution cannot be treated as inert annotations.

Annotations remain part of the sealed sample. Editing them requires recompiling the measurement design and checking identity; “not used in scoring” is no basis for reusing old artifacts. Input compilation and Core contracts own exact digest and reuse rules.

### Sandbox eval fields (mocks / environment / tripwire / mocksStrict) {#sandbox-eval-fields-mocks-environment-tripwire-mocksstrict}

To run evals decoupled from the real external environment (databases / APIs / filesystem / actual git push, etc.), a sample also carries a group of sandbox fields. The omk runtime matches mocks before a tool call; on a hit it returns fake data instead of really invoking the underlying tool.

```yaml
schemaVersion: omk.eval-sample-set/v3
samples:
  - sampleId: s002
    input:
      inputKind: text
      text: Use antlogs-query to count ERROR logs in the last 1 hour
    executionContext:
      mocks:
        - tool: Bash
          match:
            command_glob: '*log-cli query --filter ERROR*'
          return:
            stdout: '{"count": 42}'
            exit: 0
        - tool: Read
          match:
            file_path_endswith: tasks/state.json
          return: '{"status":"running"}'
        - tool: WebFetch
          match:
            url_glob: https://internal.example.com/api/*
          return: ok
      mocksStrict: true
      environment:
        cli_available:
          - log-cli
        files_available:
          - ~/.config/log-cli.json
        notes: log-cli is authenticated, token in env var
    evaluationContext:
      rubric:
        workflow_quality:
          criterion: Must call the logstore_query tool with an ERROR filter and a one-hour window
          weight: 1
      assertions:
        - type: tool_input_contains
          value: Bash:logstore_query
          weight: 1
        - type: mock_hit
          value: Bash:1
          weight: 1
    annotations:
      tripwire: false
```

**Field semantics:**

- **mocksStrict** (`boolean`, default `true`): a tool call that matches no mock is denied outright (the LLM sees a failure result). The production resolver applies this fail-closed default to generated and hand-written samples alike. Generation always sets `true` when mocks exist, including when the model emits `false`; model output cannot authorize unmatched real calls. Only a human-authored sample may explicitly set `false` for intentional real-runtime passthrough. **BREAKING-PROMPT / BREAKING-COMPARABILITY:** generation uses `omk.sample-generation/v3`; existing files are not regenerated, and new generated sets require review and a fresh comparison baseline.
- **tripwire** (`boolean`, default `false`): declares that this is a trap sample whose prompt deliberately plants a lure that violates the rubric or skill. Evaluation Core preserves the declaration as Sample annotation for audit; it does not turn a failed observation into success or alter the registered Decision.
- **environment** (`object`, optional): prompt-only task assumptions. The LLM may skip availability probes (`which X` / `test -f Y` / `echo $Z`) and go straight into the workflow, but omk does not create files, export variables, or alter `PATH`. It is not a fixture mechanism. The doctor health check can still audit declared physical paths (skippable with `--skip-doctor`).
  - `cli_available: string[]` — assumed already on `PATH`
  - `files_available: string[]` — file/script paths referenced by the task statement; use `executionContext.cwd` or mocks for readable bytes
  - `notes: string` — free-text fallback, describing credential / env-var state, etc.
- **mocks** (`object[]`, optional): the tool-call interception list. At runtime, mocks are matched in array order, and the first hit returns one of `return` / `return_file` / `return_seq[hitCount]` as the tool_result.
  - **the `tool` field**: tool name (e.g. `"Bash"` / `"Read"` / `"Grep"`). The special value `"*"` wildcards any tool name, paired with `input_contains` for intent-level mocking.
  - **all entries under `match` are AND-ed**:
    - `file_path: string` — strict equality (`~` expanded). **Use only when you can predict the full path** (e.g. `~/.config/x.json`).
    - `file_path_endswith: string` — suffix match: `actual === suffix`, or `actual` ends with `suffix` right after a path separator (`/` or `\`). **The recommended default** (tool calls may use absolute paths even when the sample uses relative paths).
    - `url: string` / `url_glob: string` — for WebFetch / WebSearch, pick one.
    - `command_glob: string` — for Bash, `*` wildcards across newlines (so the LLM's multi-line commands still hit).
    - `input: object` — generic deep-equal subset match (any tool_input field).
    - `input_contains: string` — recursively scans all string values in tool_input; a hit if any contains the substring (case-insensitive). **Pair with `tool: "*"` for intent-level mocking**: when the LLM searches code it might use Bash grep / the Grep tool / Glob / Read / Agent / any tool; use `input_contains` to match intent by keyword instead of enumerating tools one by one. Example: `{tool: "*", match: {input_contains: "MyServiceName"}, return: "<service .../>"}` — any tool hits as long as its input mentions MyServiceName.
  - **return source**: every mock declares exactly one of `return`, `return_file`, or `return_seq`. `return` accepts a string or `{stdout, stderr, exit}`; `return_file` loads an external fixture; `return_seq[]` is a state machine whose Nth hit returns the Nth value and remains at the final value after the sequence is exhausted.
- **assertion-side mock_hit / tool_input_contains**: used together with mocks. `mock_hit: "Bash:2"` means "the 2nd Bash mock must be hit at least once", proving the LLM reached that step. `tool_input_contains: "Bash:logstore_query"` checks that the Bash command string contains `logstore_query`.
  - Every `mock_hit` must reference a declared per-tool mock ordinal. The loader rejects missing or out-of-range references before execution.
  - Mock support is an executor capability, not a trace capability. `codex`, `codex-sdk`, and direct API executors do not install interception hooks; use a custom executor that implements the mock protocol. Unsupported executors auto-generate mockless samples and reject existing mocked samples before evaluation.

**Relationship to grading / judge**: the sandbox fields (mocks / environment / tripwire / mocksStrict) **never enter the judge prompt** — the judge sees only prompt + rubric + LLM output + trace summary. `tripwire` is audit metadata and does not affect scoring or the registered Decision. The current Core diagnostic projection reports only authenticated failures, missing evidence, exclusions, and stable reason codes; it does not infer a `tripwire_intentional` recommendation.

## 3. Current report reading boundaries

### What coverage currently means

The current Studio evaluation page projects authenticated Core artifacts. Report evidence coverage expresses whether measurement evidence satisfies declarations. It is neither the distribution of author-written `capability` or `covers` nor knowledge-base completeness. This guide promises no Sample design coverage panel or sample-coverage coloring in Skill Map.

## 4. Self-check checklist: is my sample design rigorous enough? {#_4-self-check-checklist-is-my-sample-design-rigorous-enough}

- The question, control group, and `construct` declaration agree; declarations are not treated as validation results.
- Every claimed capability has representative samples; review content instead of just counting labels.
- Structural anchors in `covers` exist, and actual execution evidence supports any usage behavior being tested.
- Difficulty and sources represent the intended scenarios; generated samples have human review, and self-reported provenance is not treated as contamination detection.
- Choose sample counts from effect size, variation, and the declared measurement design; there is no universal “enough” threshold of 5 or 20 samples.
- Rubrics state checkable standards; character counts or keywords alone do not establish clarity.
- Inputs do not leak the answers being tested; required context is explicitly included in experimental conditions.
- Execution controls, mocks, fixtures, and executor support are checked; failures and missing evidence remain visible.

## 5. How verdict interpretation pairs with construct {#_5-how-verdict-interpretation-pairs-with-construct}

PROGRESS / NOISE / REGRESSION / CAUTIOUS / UNDERPOWERED / SOLO are conclusions under the registered measurement design. Algorithms do not switch automatically based on `construct`. `necessity` is an author hypothesis: PROGRESS can support a difference under those experimental conditions, but cannot directly prove that a skill is necessary. Nor can `quality` turn improvement on selected samples into overall knowledge quality.

## 6. Appendix — design rationale and extension boundaries

### 6.1 Current metadata trade-offs

Separating input, execution controls, evaluation expectations, and author annotations helps reviewers identify what was actually measured. Labels describe intent. Automatic normalization, difficulty calibration, contamination detection, coverage matrices, and construct validation each need their own implementation and acceptance; fields alone do not establish delivery.

### 6.2 Uncommitted analysis capabilities

This guide promises no IRT parameter estimation, automatic adversarial mining, Sample design health score, capability-coverage threshold, or automatic contamination assessment. Research directions require actual demand and a separate measurement design; arbitrary small-sample counts or percentages provide no universal scientific guarantee.

### 6.3 Field extension boundaries

The current v3 Schema is strict. Author only supported fields; new metadata requires an explicit contract change and must not silently exclude samples or change Δ weights.

### 6.4 Sources {#_6-4-sources}

- [Sample format](../../reference/evaluation/eval-sample-format.md): Current public envelope, validation, and support.
- [Statistical rigor](../../explanation/statistical-rigor.md): Evidence, comparison, and conclusion limits.
- [Scoring specification](../../specs/evaluation/scoring.md): Current scoring and registered Decision responsibilities.

## Implementation boundaries {#implementation-boundaries}

`eval-workflows/inputs/contracts` defines sample types, `inputs/schemas` owns validation and machine schemas, and `inputs/sample-mapping.ts` maps the public v3 envelope to internal DTOs. Internal DTOs are neither a second public protocol nor a v2 reader.

`orchestration/measurement-design.ts` compiles Core declarations. `measurement/evaluators` and `eval-runtime/evaluators` own their respective evaluators; hosts assemble executors and scoring in `hosts/composition`. Core depends on neither sample authoring, filesystems, nor concrete executors.

Before adding a field, identify its consumer, identity impact and public contract version. Disclose scoring and reuse-semantic changes separately.
