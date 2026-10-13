---
title: Entity extraction v12 targeted regression
description: Identity targets appear, but two required real-window mentions are missing; one call completed and the synthetic control was not attempted.
---

# Entity extraction v12 targeted regression

## Conclusion

**Library, adapter-class and version identities meet this case's self-review expectations, but two required Session mentions are missing; this batch still needs improvement.** The two-window plan authorized on 2026-10-11 actually executed one Codex `gpt-6.1-sol` call. The real window returned 18 entities, 21 mentions, two knowledge candidates and six statements without structural rejection. Item-by-item self-review found neither the table nor final-paragraph target mention. The frozen stop rule prevented the synthetic call and closed its unused quota.

All nine non-exhaustive object expectations have an object at an allowed level; the one required configuration role retains the exact string, owner, scope and source rationale. **An existing entity, complete knowledge content or a covering citation does not satisfy required mention coverage.** Missing mentions with no incorrect rationale cannot establish a rationale repair. The conclusion is `needs_improvement`; author self-review is not independent evidence, and `goldReady=false`.

## Measurement and evidence

[Download the sanitized summary JSON](/entity-extraction-v12-target-regression.json): frozen identity, input/output digests, invocation and stop records, self-review projections, unattempted scope and historical evidence bindings. Real messages, synthetic input, complete output, detailed annotations and item-level reasons remain local. Digests bind private evidence; public projections do not independently reproduce every semantic judgment.

| Item | This batch |
|---|---|
| Measurement identity | `sha256:f2efcb39a00eaf7d99277af8d96ed20fd96f7d4d1c5e16412beb4888ce77ef4c`; a new mixed-development identity, not the synthetic v12 corpus measurement identity. |
| Prompt and runtime | Sealed `knowledge-extraction-v12`, raw UTF-8 digest `sha256:c7a4a4a3a1b5e5a07d7469e3a8ecf1a7af11f89c1e970f0653f22b207fa7b9fc`; runtime digest `sha256:89ac074ba27dae1d72983e0f4544c93e5271170824d4a77f723741e840807fdf`, Node 24.21.0. |
| Sources and criteria | Four existing redacted real messages and one authored synthetic message. Fifteen non-exhaustive objects, eight target mentions and one required configuration role were frozen with author self-review before output. Only the real window ran: nine objects, two target mentions and one knowledge role were checked; six synthetic objects and six mentions remain untested. |
| Sending and calls | Only selected messages, roles, existing times/indices, coverage limits and prompt/Schema were sent. Annotations, guides, native paths and historical outputs were excluded. Once per window at most, serial and no automatic retries; one actual call, with no prior quota transfer. |
| Contracts | Response Schema v4, entity/knowledge history v2 and extraction run v4 remain unchanged; no migration. This change delivers a report without changing production code, prompt or frozen answers. |

Call/parse failures, cancellations, structural rejections and local driver failures are all zero. Original program `semanticReview=pending` remains, with author self-review stored separately; program records are not rewritten to claim independent semantic acceptance.

## First-case self-review

| Check | Observation and limit |
|---|---|
| Concept substring inside a field | Raw output does not extract Session from `_unhandledSessionStatus`; the complete field remains. This observation was not obtained by discarding a program-rejected error. |
| Persistent library, adapter class and version | core and MiniappClient are components; core 11.4 is a version linked to core with source mention evidence. All nine object expectations meet this case's self-review criteria. |
| Table Session | Prefrozen occurrence=1 at UTF-16 `[473,480)` is absent, as is its allowed fixed-Session alternative. Rationale/location agreement for this target is not evaluable. |
| Final new Session | Prefrozen occurrence=2 at `[833,840)` is absent, as is its allowed new-Session alternative. Rationale/location agreement for this target is not evaluable. |
| Existing Session identity and knowledge | Only `m9` refers to Session in the earlier assistant message. `p1/s5` and its citation retain the late-error constraint, but do not replace either missing entity mention. |
| Required configuration knowledge | `p2/s6` retains string `unhandled`, MiniappClient/core 11.4 adaptation scope, browser-like hosts and mini-programs, and the source rationale that an unhandled JS exception is not a process crash. It remains source_assertion. |

Every one of the 18 entities, 21 mentions, two candidates, six statements and five citations received self-review, including extra objects. Source reports of a regression and comparison are not promoted to tool evidence. Unknown exact beta version/npm correspondence and absent repair/follow-up validation remain. The two missing positions belong to one concept and are not two independent error-rate samples.

Compared with the [older v11 output for this real window](./entity-extraction-v11-real-regression.md), the persistent library and class-level targets appear, and the identifier-substring issue is not observed. Neither target involved in the previous rationale mismatch remains. Without contemporaneous A/B, differences cannot be attributed to the prompt, and new observations do not turn historical results into passes.

## Stop scope and usage

Synthetic `synthetic-source-boundaries` was not attempted. Its ordinary Markdown/Chinese-adjacent mentions, complete field and two-release comparison have no generated evidence in this batch, so absence of false rejection is unverified. Raw output, checks, self-review, pre-review manifest and final quota closure remain. Criteria were not relaxed after output, and the call was not rerun.

No new application storage replay or Chrome acceptance followed the failed batch. [PR #1157](https://github.com/lizhiyao/oh-my-knowledge/pull/1157) offline source-admission/persistence evidence and unchanged [Studio correction/history evidence](./entity-extraction-v8-workflow.md) remain; they do not establish storage verification for this new output.

Executor projections report 12,136 uncached input tokens, 12,288 cache-read tokens and 5,758 output tokens; call wall time was about 135.623 seconds. USD cost was not reported and remains unknown; placeholder zero does not mean free execution. Cache and input fields are not added to infer billing. Projections observed no tool calls or subagents, without establishing a general isolation guarantee. Backend revision, seed, sampling parameters and default reasoning effort were not fixed or reported.

## Limits and follow-up

The real case is a previously viewed software-development window used in the repair, while the implementation agent authored the synthetic control for a known mechanism. This is not blind or representative sampling. Tools, system context and surrounding records are omitted; another 24 source records failed parsing, leaving completeness unknown. Non-exhaustive objects/mentions do not support overall precision/recall/F1. One single-round output does not establish stability, overall quality or cross-Agent value, and independent review remains absent.

Historical 2/3, 10/13, 6/6 and eight public evidence files remain unchanged and are not pooled into this batch's score. Next, use this output to inspect full-window critical-mention retention and add the two omissions to offline regression; any additional model validation needs a separately frozen and authorized plan. [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) continues to track incomplete scope.
