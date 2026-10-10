# Entity extraction v3: two-round acceptance failed

The current version **does not meet this run's frozen entity acceptance criteria and still needs user inspection and correction**. All 32 calls produced parseable captured output, but 6 outputs had structural rejections; 2 additional structurally admitted outputs collapsed environment identities that the frozen criteria require to remain separate. Collective-reference and repeated-name location failures occurred in both rounds. This does not support unattended knowledge retention.

This run changed no prompt, admission rule, or storage contract and replaced no failure with a retry. It is a self-reviewed synthetic-window result, not independent human acceptance or real-log accuracy.

## Evidence and review scope

On 2026-10-10 UTC, the configured Codex executor using `gpt-6.1-sol` called each of 16 synthetic windows twice: 32 calls, without automatic retries by the acceptance harness. The 36 source messages, 71 critical mentions, 32 critical local identity groups, 17 separations, 3 unresolved-identity checks, and 8 knowledge-role checks were frozen before output. Inputs contain no previous outputs; per-case input digests match across rounds and inputs are byte-identical to the approved transmission. Expected identities and review criteria were excluded from model input.

[Download the complete evidence JSON](/entity-extraction-v3-repeat-quality.json): frozen identities, exact prompt and corpus bytes, inputs and raw outputs with digests, admission results, frozen checks, reported usage, and 32 per-output Agent reviews. Original capture records retain `semanticReview: pending`; subsequent judgments are separate `agentReview` fields. Independent review remains `not_performed`.

| Identity | SHA-256 |
|---|---|
| Corpus `omk-entity-quality/v2` | `af0fe62c7a3544da8a4d371aaf3e3788b805dd97843b83458746319f841a3eb2` |
| Prompt `knowledge-extraction-v3` | `9738c735598ea69900436fc0f5898563fda1e95a54ce0ff12689a21b62d6b0ec` |

Capture and runtime implementation comes from the entity-library main revision `ef63224837fc6bacb2085a1c21a38534bc5dc2e7`. The original v3 prompt is unchanged, but the corpus expanded from the historical report's 12 cases to 16. This is not a new v2/v3 comparison, and count differences cannot establish a version improvement. Both rounds use the same order; backend revision, temperature, and seed were not proven fixed. No population stability or causal conclusion follows.

## Structural admission and frozen checks

| Observation | Round 1 | Round 2 |
|---|---:|---:|
| Captured calls | 16 | 16 |
| Call / parse capture failures | 0 | 0 |
| Outputs with structural rejections | 3 | 3 |
| Rejected mentions / knowledge proposals | 3 / 2 | 5 / 2 |
| Returned / admitted entities | 41 / 41 | 42 / 42 |
| Returned / admitted mentions | 101 / 98 | 110 / 105 |
| Returned / admitted knowledge proposals | 14 / 12 | 13 / 11 |
| Exactly matched critical positions | 62 / 71 | 63 / 71 |
| Critical positions covered by one quotation | 70 / 71 | 70 / 71 |
| Frozen identity separations satisfied | 13 / 17 | 13 / 17 |
| Frozen unresolved-identity requirements satisfied | 2 / 3 | 2 / 3 |

These counts are **not semantic accuracy**. Longer project-qualified names or complete object descriptions can be valid mentions. Complete critical-span coverage does not excuse extra mentions that cause a knowledge proposal to be rejected. Mapping an identity group to an ID does not prove that distinct groups remain separate. Structural validation admitted all 83 returned entities but did not detect the environment identity-scope defects.

The harness exited 1, and the original `manifest.status` is `capture_failures`: that status uses a `failed` flag that also includes structural rejections. Actual `captureFailures` is 0. The 12 rejected components are 8 mentions and 4 knowledge proposals; they are not 12 failed model calls.

## Per-case semantic review

“Supported” below means the implementing Agent reviewed this case against its source and frozen criteria; it is not independent acceptance. Position counts and detailed rationales are in the evidence.

| Case | Round 1 | Round 2 |
|---|---|---|
| `alias-pronouns` | Names, abbreviation, and pronoun supported; extra cache and environment objects have sources. | Also supported; testing scope and unverified production retained. |
| `homonyms` | Project-qualified Atlas identities separate; knowledge admitted. | Main names separate; collective “这” duplicated, rejecting two mentions and one proposal. |
| `role-exchange` | Subject/object direction supported for dependency and storage provision. | Also supported. |
| `later-correction` | Eight critical mentions follow the latest correction; the assistant's guess is not the current attribution. | Also supported; missing tool results retained. |
| `abstract-plan` | Plan and principle separate; non-execution and unknown outcomes retained. | Also supported. |
| `entities-only` | Both names retained without invented knowledge. | Both names plus a source-supported collective object retained; no knowledge. |
| `unresolved-choice` | Unknown object and both possible identities retained; no knowledge proposal. | Also supported; knowledge generation with an unknown subject remains untested. |
| `missing-context` | Unknown pronoun object retained without invented type or identity; no knowledge. | Also supported. |
| `environment-instances` | T/P separate; duplicated “它们” rejects two mentions and one proposal. | Same failure category recurs. |
| `repeated-quote` | Incorrect adjacent suffix rejects the second Echo name mention; not a wrong homonym merge. | Same incorrect suffix recurs. |
| `untrusted-instructions` | Object is BuildKit logs; frozen BuildKit granularity still needs independent adjudication. | Separate BuildKit, path, and attack text; does not adjudicate round 1 or the historical dispute. |
| `empty-window` | Empty entities, mentions, and knowledge supported. | Also supported. |
| `tool-log-granularity` | Explicit tool/log identities separate; pronoun maps to tool; six exact critical mentions. | Also supported. |
| `path-rename-project` | A file retains identity through renaming; B's same path is separate; functional impact not invented. | Also supported. |
| `long-corrected-reference` | Test, production, and unqualified Quartz share one ID, violating frozen instance granularity. | Again one ID; extra environment entities do not separate Quartz instances. |
| `plan-execution-distinction` | Three objects and latest correction supported; a normative case-action reference rejects the proposal. | Case outcomes reference only descriptive statements; proposal admitted with correction and limits retained. |

Reviewed source content did not promote old assistant guesses or corrected success claims into current tool observations. This review chiefly covers entity identity, mentions, and associated roles. It is not a truth certification for all knowledge statements or evidence of carrier effectiveness.

## Priority corrections

1. **Environment instance identity.** Both rounds map unqualified, test, and production Quartz to `e2`; all three separations and the initial unresolved-identity requirement fail. Statements still distinguish test success, production error, and unverified repair through context or an environment object. This is not evidence that production was described as successful. Output uses abstract-component granularity, while frozen criteria require instance granularity. Product rules must specify both and their relationship, with independent adjudication; the current criteria still require separate identities.
2. **One position for collective references.** Both environment outputs and round 2's homonym output copy the same “它们” or “这” position to two objects. Admission rejects these mentions and then the whole proposal that references them. Round 2's entities-only output legally represents “它们” as one collective object, demonstrating inconsistent strategy. Relaxing duplicate-position checks would hide the defect.
3. **Contiguous context for repeated names.** Both Echo outputs set the second name's `suffix` to `"，后者"`, while the adjacent source is “，前者”. Quotation construction is wrong, and `quote_mismatch` correctly rejects it. Reasonable original subject/object interpretation cannot restore the lost name mention.
4. **Case organization and modality.** Round 1's plan/execution output puts normative `s1` in `actionStatementIds`; the current contract allows case actions/outcomes to reference descriptive statements only. The entire proposal is rejected. Round 2's admission does not erase that failure. Align prompt/output constraints through explicit versioning rather than weakening admission rules.

## Limits of program checks and review

The frozen keyword role checker reports 4 `matched`, 1 `mismatched`, and 3 `not_observed` checks in each round. The sole mismatch is the abbreviation case: the criterion requires no object, whereas the statements reasonably reference source-supported cache or production-environment objects. Self-review did not identify a role error. Frozen results remain intact; answers cannot be changed after output to improve counts.

The three unobserved checks are optional knowledge omissions in the ambiguous, missing-context, and Echo cases. They are neither role errors nor evidence of reliable generation for those roles. Keywords, character coverage, and valid references do not replace per-output semantic review. Extra entities were individually checked against source, but there was no independent judge or human adjudication.

## Usage, applicability, and further evidence

| Executor-reported usage | Round 1 | Round 2 |
|---|---:|---:|
| Sum of call durations | 736.358 s | 610.243 s |
| Input tokens | 108,909 | 109,118 |
| Output tokens | 25,091 | 24,668 |
| USD cost | Unknown | Unknown |

These are actual reported values. Unreported cost is not zero, and durations are not a production latency benchmark. The executor reported no tool calls; two synthetic attack-text cases establish no general prompt-injection defense or filesystem isolation guarantee.

The implementing Agent authored the corpus and reviewed outputs, without independent human review. The eleven-short-message case does not represent real long logs, and two calls cannot estimate long-term stability. Real-user log distributions, cross-log entity linking, cross-agent reuse, claim truth, and carrier effectiveness remain uncovered.

Next, specify entity granularity and make explicitly versioned corrections for the observed failures, preserving before/after evidence in new authorized runs. Independent adjudication and a separately authorized real-log sample remain necessary. [Issue #1124](https://github.com/lizhiyao/oh-my-knowledge/issues/1124) tracks the outstanding work. This run changed no prompt and expanded no call scope. Reproduction commands are in the [extraction quality guide](../guides/extract-knowledge.md#reproduce-extraction-quality-checks); the [historical v2/v3 report](./entity-extraction-quality.md) and its original evidence remain intact.
