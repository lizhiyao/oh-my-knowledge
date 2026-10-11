# Entity extraction v11: two-window real regression

## Conclusion

**The three modality, code-state and configuration-knowledge targets meet author self-review expectations, but the entity regression batch still needs improvement.** On 2026-10-11, the newly authorized two-window plan completed two single-round Codex `gpt-6.1-sol` calls. All 31 entities, 47 mentions, seven knowledge candidates and 24 statements passed structural admission and received item-by-item self-review. The second window retains an identifier substring mistaken for a concept mention, a mention rationale/location mismatch, a missing core library identity and a MiniappClient frozen-level mismatch. The conclusion is `needs_improvement`.

Of 13 non-exhaustive object expectations, 12 have an object and 11 meet the frozen level expectations; these counts are not overall accuracy or recall. All three required knowledge roles have self-reviewed consistent statements, but complete knowledge content does not remove entity or source-binding errors. Independent review was not performed; `goldReady=false`. The prompt remains v11. Historical outputs and scores 2/3, 10/13 and 6/6 remain unchanged and are not pooled into a new score.

## Measurement and evidence

[Download the sanitized summary JSON](/entity-extraction-v11-real-regression.json): measurement identity, per-case input/output digests, structural and self-review counts, issue classes, executor usage projections, the local driver incident and application replay. Real messages, complete model outputs, detailed annotations and item-level review reasons remain local. Digests bind evidence; they do not make all semantic judgments independently reproducible from public material.

| Item | This run |
|---|---|
| Measurement identity | `sha256:fbe5143227e5f01858879e5d3dd639753b54e211530fc2c11498d509b8d92288`; a separate real-window identity, not the synthetic v12 corpus identity. |
| Prompt | Frozen `knowledge-extraction-v11`, including inline response Schema v4; raw UTF-8 digest `sha256:0e4456776bcce15074b54562eacb06b7426a7d0e3da6c078b46bd4265652015c`. |
| Runtime artifacts | Reused sealed build, runtime digest `sha256:943eddca86a691549954745e475f43b6d9c6f66563237aa00147986b6d535294`; Node 24.21.0. Dependencies, rule snapshots, annotations and inputs were verified before execution. |
| Sources and criteria | Two previously redacted and viewed software windows, nine messages, nine unique messages and one source group. Thirteen object expectations and three required knowledge roles were frozen before new outputs, with author self-review complete. Source examples are not exhaustive mention gold; synthetic critical-mention scores are not applied. |
| Execution and sending | Existing Codex `gpt-6.1-sol`, one round, serial, two actual executor invocations and no acceptance-script automatic retries. Only selected messages, roles, times/indices, coverage limits and prompt/Schema were sent; annotations, guides, native paths and historical outputs were excluded. |
| Review and contracts | The implementation agent checked every entity, mention, extra object, knowledge candidate, statement and citation. Author self-review is not independent human evidence. Response v4, entity/knowledge history v2 and extraction run v4 remain unchanged; no migration. |

Model-call failures, cancellations, JSON parse failures and root/entity/knowledge structural rejections are all zero. Original program `semanticReview=pending` remains; author review is separate. Issues found while reviewing the second output triggered the planned stop. Both authorized calls are consumed and closed; no old quota is transferred and no calls are appended.

## Per-case review

| Window | Entities/mentions/knowledge/statements | Objects found/expected | Result |
|---|---|---|---|
| `real-session-after-resolution` | 14/22/3/11 | 5/5 | master and beta.2 remain separate; both current-master mentions refer to the tested state, and the second excludes the modification property. Negated necessity and the opposing count requirements are expressed correctly; unknown commit and unpublished status remain. |
| `real-protected-correction` | 17/25/4/13 | 7/8 | Configuration knowledge retains exact value, type, owner, scope and rationale; one library object is absent, one level mismatches, and two related mention issues remain. |

### Observed target behavior

In the first window, `p2/s7` uses descriptive/negative to negate the need to modify the SDK for this count difference, preserving the source explanation of API count 1 and overview count 2. It does not turn lack of necessity into prohibition or infer whether a modification occurred. `p1/s1` and `p1/s2` separately express the affirmative initialization requirement and the negative requirement that state updates not increase the denominator.

master uses the prefrozen version option, with commit and owner unknown and results limited to the tested state. `p3/s8`–`s11` retain the two code-state count results, no duplicate sending on repeated flush and the unpublished master modification. They do not invent per-version invocation records or extend results to future master states.

In the second window, `p3/s9` explicitly retains the string value `unhandled`; context includes MiniappClient, core 11.4, browser-like hosts and mini-program scope, and the source rationale that an unhandled JS exception is not a process crash. The reasonableness judgment remains source_assertion. Names, qualifiers or retrievable quotes do not substitute for configuration knowledge, and no runtime mechanism is invented.

These are observations of this batch's new outputs. The target content is present here compared with the earlier v8 gaps, but there is no contemporaneous A/B to attribute differences to the prompt, and historical reports are not rescored.

### Retained identity and source issues

| Issue | Evidence and effect |
|---|---|
| Identifier substring treated as an independent concept mention | Second-window `m11` selects Session occurrence=0 at UTF-16 `[332,339)`, inside `_unhandledSessionStatus`; its rationale instead describes an independent mention of the fixed session. Locatable text does not prove that the span mentions the bound concept. |
| Rationale and location differ | `m12` occurrence=1 is the table's fixed Session at `[473,480)`, but its rationale describes the final late-error/new-Session constraint; that is occurrence=2 at `[833,840)`. The concept may share an identity, but the rationale still does not match the selected evidence. Its occurrence is not automatically moved. |
| Missing core library identity | Frozen criteria require the persistent core library in the override/upgrade discussion. The output contains only the core 11.4 version, no library component, and a null association. A version object does not replace the persistent library identity; other background nouns are not universally treated as omissions. |
| MiniappClient level mismatch | The object is present as object, with an explanation that evidence for a persistent system/module is insufficient. This differs from the component level prefrozen from class/adaptation responsibilities. The explanation and mismatch remain; it is not broadly labeled invented, and answers are not relaxed after output to claim a pass. |

The two mention issues are related; four records are not four independent samples for an error rate. Configuration semantics meet self-review expectations, but `p1` mention grounding still contains errors. Neither the window nor the batch passes. Issues and original outputs remain, without added entities, adjusted occurrences or changed frozen annotations.

## Offline application replay

Both existing outputs were replayed through the sealed build's production application entry for source capture, extraction and persistence, with **zero** new model calls. Only evidenceRef values were rebound one-to-one and normal persistent identities allocated. Original output, message text, roles, times and indices remain; original and reconstructed-source limits are recorded separately.

Reopening file storage retained all payloads and bindings for 31 entities, 47 mentions, seven candidates and 24 statements. Every entity was searchable, every reference located source text, and knowledge bound an explicit entity revision. The application also preserves the incorrect Session substring. A matched position means exact source agreement and cannot repair semantic error. Candidates were not marked user-retained knowledge by this replay.

This run reuses unchanged [Studio correction/history workflow evidence](./entity-extraction-v8-workflow.md). Chrome was not operated again, and merge/split or a complete evaluation report was not retested.

## Local driver incident and recovery

After the first output and its checks were fully saved, the driver's final count print used `proposals.length`; the admitted result actually exposes `accepted`, so the process exited 1. This local script issue is recorded separately from model failure.

The original driver, failed manifest, output, executor result and check digests remain. Offline verification confirmed complete admission and reviewed all 14 entities, 22 mentions, three candidates and 11 statements. The print field was corrected, both driver digests recorded, and the second planned window continued. Recovery used zero new calls and did not rerun the first window; its output and actual invocation count remain unchanged. The original preparation plan retains its zero-call state, while authorized execution and the final two actual calls are stored separately.

## Usage, limits and follow-up

Executor projections report 22,834 uncached input tokens, 24,576 cache-read tokens and 15,122 output tokens; total call wall time is about 382.836 seconds. Neither record reports USD cost, so cost is unknown. A placeholder zero does not mean free execution, and cache fields are not added to input fields to infer billing. Projections observed no tool calls or subagents; this is not a general isolation guarantee. Backend revision, seed, sampling parameters and default reasoning effort were not fixed or reported.

One round, two viewed software windows and one source group do not establish real-log population quality, broad-domain entities, long-conversation performance or cross-Agent value. Selected windows omit tools, system context and surrounding records; another 24 source records could not be parsed, leaving completeness unknown. Redacted offsets only address redacted text. Memory ambiguity and the third earlier Session-omission window were not tested; independent evidence and overall quality remain incomplete.

Next, address identifier substrings versus independent concept mentions and review persistent library/class versus version coverage. These outputs can support offline regression without automatically adding model calls. Current frozen criteria, historical outputs and scores remain unchanged. [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) continues to track these gaps.
