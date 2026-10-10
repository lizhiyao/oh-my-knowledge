# Entity extraction v6: an 11-window diagnostic and its limits

**Broad entity recognition met expectations in this self-review; the frozen strict regression did not pass.** All 11 calls produced admissible outputs, matching 39 of 40 critical mentions. The sole miss was the complete name “Rule F9”, absent from the frozen alternatives, leaving three identity pairs not evaluable. Per-output self-review found no entity merge, assignment or unsupported disambiguation errors, and recorded one knowledge-relation wording concern. This does not establish overall entity extraction acceptance.

## Execution scope and evidence

On 2026-10-10, the user authorized an initial 11-call diagnostic. It used prompt v6, corpus v6, guide v4, checks v3 and response Schema v4 frozen for [PR #1135](https://github.com/lizhiyao/oh-my-knowledge/pull/1135): three type-evidence / shared-property / negation regressions and all eight newly reserved broad-domain windows from the 36 author-reviewed synthetic windows, with one pass only. The original 72-call, two-pass full plan was not run; there were no automatic retries or additional calls.

The model was `gpt-6.1-sol` through the existing Codex executor, with concurrency capped at two. Only selected source messages, times / sequence identifiers, coverage limits and the full extraction prompt / Schema were sent. Gold annotations, review criteria and historical outputs were not sent. The corpus and annotations were frozen before capture; answers were not adjusted after outputs. Validation windows are public synthetic data, not a hidden blind set. Their outputs have now been seen and cannot support later blind-test tuning claims.

[Download the evidence JSON](/entity-extraction-v6-diagnostic.json): frozen corpus, bilingual guides, prompt and input digests, all 11 raw final outputs, admission and checks, executor counters, per-output review and capture driver. Full executor results, frozen build and runtime bundle remain outside the repository; the public file retains full-result digests. Counters are executor projections, not raw provider bills.

| Frozen item | Value |
|---|---|
| Measurement identity | `sha256:3713a3acf59a2591c4f7a6bed205ede3422b336ad336bb31491919e901a4b6ea` |
| Raw UTF-8 prompt digest | `sha256:a30cdfe20296d3294bbea7920b839934573bf0b69e27fbc4788493d57fdffffb` |
| Frozen source | `1652257e536580e97f67cf821284fb045843c2e3` |
| Review status | Author and output self-review completed; independent human review not performed; `goldReady: false` |

The measured runtime is that frozen v6 build, not the later directory refactor or storage fix. Runtime, dependencies, bilingual guides and checker digests are bound to the measurement identity. This report differs from the [historical v4 two-pass report](./entity-extraction-v4-repeat-quality.md); without a fixed-input old/new prompt comparison, differences cannot be attributed to prompt improvements. Production merge and UI acceptance of v6 follow the associated PR's status.

## Program results

| Observation | This single pass |
|---|---:|
| Calls / records | 11 / 11 |
| Call / parse failures, cancellations, structural rejections | 0 |
| Strict critical mentions matched | 39 / 40 |
| Not-evaluable identity pairs | 3 |
| Wrong merges / splits among aligned mention pairs | 0 / 0 |
| Program-evaluable identity level / link mismatches | 0 |
| Admitted entities / mentions / knowledge candidates | 28 / 44 / 5 |

The first rule mention in `fresh-negative-requirement` was “Rule F9”; the frozen critical alternative allowed only “F9”. The complete phrase occurs in the source and has a reasonable assignment. Self-review does not call this an omitted entity; the strict miss, rule identity `not_evaluable` and three unjudgeable pairs remain unchanged. Alternatives and scores were not retroactively changed. Development regressions matched 11 / 12, broad validation matched 28 / 28. Only aligned pairs can be checked for merging or splitting; missing evaluations do not count as passes.

This is not acceptance of all 36 windows: 25 windows were not selected, and no second pass ran. The full development summary in the evidence remains `incomplete`, with 25 not attempted; all 11 selected calls completed. Critical mentions are not exhaustive annotations. Precision / F1 and semantic accuracy are `null`; 39 / 40 is not entity accuracy.

## Per-output self-review

All 28 admitted entities, 44 mentions and five knowledge candidates were reviewed, including extra objects, sources, direction, conditions, modality, polarity and assertions versus tool observations. The reviewer is also the implementer and corpus author, not an independent human reviewer.

| Window | Review and coverage limits |
|---|---|
| `fresh-type-evidence` | Lumen retains unknown type; Oriel has persistent-module evidence. Its responsibility remains a source assertion without invented execution results. |
| `fresh-shared-property` | Files remain separate; Their / them share one complete collection. A property is not a file alias; optional knowledge was omitted. |
| `fresh-negative-requirement` | Rule and file references are correct. Disable is negated once; not-failed and no-success-check retain distinct source scopes. The complete-name boundary miss keeps its original score. |
| `held-fruit-shop` | Fruit and shop are separate; shop references are correct, without invented address or business details. |
| `held-mouse-levels` | Category and specific device are separate; the extra input-device concept has a source mention. Optional knowledge was omitted, so downstream cleaning-requirement roles were not tested. |
| `held-policy-terms` | Two insurance concepts and a product are separate. Extra terms have contextual support but unknown content / version; no coverage claims were invented. |
| `held-learning-concepts` | Recursion, call stack and its shorthand are correctly assigned. Call order has an extra source mention. Knowledge uses it as object and the stack as medium, preserving teaching scope; program endpoints are `needs_review`, with the whole statement reasonable in self-review. |
| `held-database-alias` | PostgreSQL / PG / This database share an identity; unspecified version and instance remain unknown. |
| `held-name-ambiguity` | Project and shop Nova remain separate; “it” retains both supported candidates without choosing the nearest one. |
| `held-material-object` | Material and specific scarf are separate with correct references. Knowledge title / source / endpoints have the right direction; “用作制作材料” is unclear when read between subject and object, recorded as a readability concern rather than a proven reversed fact. |
| `held-empty-knowledge` | Ceramic and umbrella remain entity-only results without invented attributes or knowledge. |

Omitting optional knowledge is not an automatic failure, but reduces downstream association coverage. Original program `semanticReview: pending` fields remain unchanged. Self-review is stored separately in `agentReview`; endpoint checking is not presented as a semantic verdict.

## Usage and limits

The executor reported 93,345 uncached input tokens, 135,168 cache-read tokens and 10,003 output tokens. None of the 11 records reported a dollar cost; cost is unknown and unreported placeholder zeros are not measurements. Wall-clock duration was 196.440 seconds. No tool calls or subagents were observed; this is not a general isolation guarantee.

This is one small capture. Backend model revision, seed, sampling parameters and default reasoning effort were not fixed or reported. There is no evidence for real user logs, long conversations, independent review, population stability, factual truth or cross-agent reuse benefits.

## Next steps and reproduction

This diagnostic took priority over a larger, costlier run; it does not automatically authorize more model calls. Before another freeze, name prefixes and reasonable complete boundaries should be defined and their alternatives included in advance. Viewed windows are development regressions; old answers and this report must not be rescored. Knowledge relation wording is a separate follow-up, with entity correctness and knowledge readability reviewed separately. Remaining Chrome folding, correction and shorter-window acceptance is tracked in [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127).

Public evidence supports offline digest checks and replay of the 11 outputs with frozen checks v3 and the admission runtime. Full-corpus replay must preserve `notAttempted` for unselected windows rather than dropping them to imply complete acceptance. A rebuild with changed runtime digests needs a new measurement identity. Reuse the original build and historical reports without impersonating their identities.
