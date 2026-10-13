# Entity extraction v11: small-batch mention-boundary diagnostic

**The first output selects the second `main` correctly, but this batch stops early on an annotation-coverage gap; the three-case acceptance has not passed.** At most three calls were authorized; one ran, without retries. Strict critical mentions match 2/3: the output's complete source name “已发布 r2” identifies the release, while the frozen alternative only allows “r2”. Itemwise self-review finds the qualified name reasonable, but preserves the strict miss without adding alternatives or rescoring. Historical v10 remains 10/13.

## Execution scope and evidence

On 2026-10-11, the user explicitly authorized the three-case plan with itemwise review by the implementation agent. The sealed build from [PR #1152](https://github.com/lizhiyao/oh-my-knowledge/pull/1152) uses prompt v11, corpus v11/guide v9, checker v4 and response Schema v4. The plan checks code state without a SHA, configuration literal types, then keyboard category versus a concrete keyboard. All are development cases, once per case, sequentially. An annotation dispute triggers stopping rather than spending remaining calls past a failure.

Only the first case's one synthetic assistant message, role/index and coverage limits, together with the frozen prompt/Schema, were sent to the existing Codex `gpt-6.1-sol` executor. Answers, review criteria, native paths and historical outputs were excluded. Runtime, checker, guides, corpus, dependencies and all three input digests were verified before capture. Execution stopped after reviewing the first output; neither remaining case was called.

[Download evidence JSON](/entity-extraction-v11-boundary-diagnostic.json): original preparation plan, authorization and actual invocation manifest, frozen corpus/bilingual guides/prompt, verbatim final output, program admission/checks, usage projection, itemwise self-review and unattempted scope. Published material is synthetic; full executor results and sealed builds remain outside the repository.

| Frozen item | Value |
|---|---|
| Measurement identity | `sha256:a4e9a505139b44d0a933b50a7ecc8d542f794057398bcd28f85909d4eb62ecb5` |
| Raw UTF-8 prompt digest | `sha256:0e4456776bcce15074b54562eacb06b7426a7d0e3da6c078b46bd4265652015c` |
| Tested source | `05c63f048538b49d236e2b0802088c39b4ffb5e2` |
| Review status | Itemwise author self-review completed; independent human review not performed; `goldReady: false` |

## Program results

| Observation | This run |
|---|---:|
| Planned limit/actual executor invocations/unique outputs | 3/1/1 |
| Selected windows attempted/unattempted | 1/2 |
| Selected critical mentions checked/unchecked | 3/6 |
| Strict matches among checked mentions | 2/3 |
| Annotation-coverage gaps/not-evaluable mention pairs | 1/2 |
| Call/parse failures, cancellations, structural rejections | 0 |
| Accepted entities/mentions/knowledge candidates/statements | 3/4/1/3 |
| Selected required knowledge roles reviewed/unobserved | 1/2 |

There are no confirmed wrong merges, wrong splits or level errors; the two not-evaluable pairs follow from the unmatched release boundary and do not count as identity passes. Program `semanticReview: pending`, mandatory-role endpoint `not_observed` and knowledge coverage `needs_review` remain verbatim. Self-review explanations are separate, without converting full-text semantic judgments into automatic matches. Annotations are non-exhaustive; precision/F1 are `null`.

Offline inspection of both full splits uses the same sealed build and reproduces the measurement identity. Each command makes zero model calls and exits 1, preserving `incomplete`. Of 60 windows/199 critical mentions, this run checks one window/three mentions; 59 windows/196 mentions remain untested (57 development and two validation windows unattempted). This is neither 2/9 nor overall accuracy. Updated guide status does not impersonate frozen bytes; reproduction uses the evidence text.

## Itemwise self-review and stop reason

| Referent | Strict result | Self-review |
|---|---|---|
| Current tested state | `当前 main 的被测代码`, UTF-16 `[2,15)`, matched | A reasonable complete qualified name for this round's code state, without inventing a SHA or forcing a shorter name. |
| State in the unreleased sentence | Second `main`, occurrence=1, `[34,38)`, matched | Corefers with the tested state, without treating the entire change-property phrase as its name. |
| Release | `已发布 r2`, `[16,22)`, missing; frozen `r2` only at `[20,22)` | A complete source-qualified name for e2, distinct from current state; an annotation-coverage gap with the strict miss preserved. |
| Collection “两者” | Noncritical additional mention `[23,25)` | e3 has explicitly sourced members e1/e2 rather than an invented object. |

All three entities, four mentions, three statements in one candidate, two evidence links and two citations were reviewed. s1 retains the current state's pass this round, unknown commit and no future branch guarantee; s2 separately retains r2's pass; s3 uses “其上的改造已发布” with negative polarity to express unreleased changes. Citations cover the corresponding two sentences; both evidence links use `source_assertion`, without claiming tool verification. Mandatory `current-result` is jointly covered by s1/s3, `observed_consistent_on_self_review`; optional `release-result` was generated and checked rather than using empty output as evidence of correct semantics.

“已发布 r2” reveals incomplete frozen allowed names. Under the preregistered rule, execution stops immediately with `stopped_annotation_coverage_gap`: no added alternatives, prompt upgrade, retry or remaining-case calls. Two authorized calls remain unused and do not automatically become a budget for a revised run. Configuration types and keyboard levels remain unobserved in this batch; old outputs cannot establish their v11 acceptance.

## Historical comparison, usage and limits

Only a qualitative comparison uses the identical code-state input in the [recorded v10 diagnostic](./entity-extraction-v10-diagnostic.md): the previous “main 上的改造” becomes the second `main`, while the complete current-state name remains. Previous `r2` becomes “已发布 r2”, revealing a separate annotation-coverage gap. There is no contemporaneous old-prompt control; model randomness or backend drift cannot be excluded. A single change is not causal evidence of the prompt repair, and historical 10/13 is not recalculated.

The executor reports 10,486 uncached input tokens, 12,288 cache-read tokens and 1,403 output tokens; wall-clock time is 27.718 seconds. USD cost was not reported and remains unknown; placeholder `costUSD: 0` does not mean free. The runtime projection shows no tool calls or subagents; reasoning uses the executor default, while backend revision, seed and sampling parameters are not fixed or reported.

Conclusion: `target_main_boundary_observed_stopped_annotation_coverage_gap_full_quality_unverified`. This output's target main boundary and required knowledge match self-review expectations; the three-case strict gate has not passed. There is no stability, independent review, reserved-validation, real-log population quality, cross-Agent reuse benefit or new Studio-flow acceptance evidence. [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) retains these incomplete items. Next, systematically review allowed qualified names in a newly frozen revision before deciding the smallest validation scope; this output, score and stop remain preserved.
