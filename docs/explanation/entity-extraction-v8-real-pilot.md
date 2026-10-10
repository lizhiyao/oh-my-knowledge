# Entity extraction v8: three-window real-conversation diagnostic

## Conclusion

**Central Session and atomic splitting meet author-review expectations in this batch, but knowledge expression needs improvement and frozen checks do not all pass.** After the user agreed to continue the prepared three-window real evaluation on 2026-10-11, three Codex `gpt-6.1-sol` calls completed in one round with itemwise author review. All 41 entities, 50 mentions, seven knowledge candidates and 19 statements pass structural admission; all 17 expected objects are located. One master-level annotation mismatch, one strengthened-modality issue and one configuration-value coverage gap remain, without changing frozen answers, raw outputs or old reports.

The 17 expectations are not exhaustive entity/mention gold; **17/17 is neither accuracy nor overall recall**. The author finds a reasonable version interpretation for master, but its frozen annotation permits object only, so the mismatch stays. Independent review is absent, `goldReady=false`, and overall precision/recall/F1 is not computed. Comprehensive extraction quality is not established.

## Measurement and evidence

[Download sanitized summary JSON](/entity-extraction-v8-real-pilot.json): measurement identity, input/output and local-artifact digests, case counts, admission, review categories, executor usage projections and reopened-storage replay results. Real messages, raw model outputs, detailed annotations/reasons and native paths stay local. Digests bind material without making full semantic review publicly reproducible.

| Item | Recorded result |
|---|---|
| Measurement identity | `sha256:1a848e2c896ae224180ab83798cb3228f2eeb98349668a0aeba5ce1886c67332` |
| Prompt | Frozen `knowledge-extraction-v8` with inline Schema; raw UTF-8 digest `sha256:e6f220f67c0d4ea9707672ad8737f8aa4d6f0263e5f37da949f0ab41f0f17038`. |
| Build source | Reused frozen v8 runtime from `6bfd2f72a2624a78b7c2f040ac15995dcb9b2e47`; capture repository is `3da58a5e1bd59c91aebe88276c378d400b1b35b1`, with identical extraction/entity/executor sources and dependencies. Runtime bytes are checked before and after calls. |
| Inputs and criteria | One software source group, three windows, 12 redacted window messages and nine unique messages; before/after Session share three messages. The original preparation packet, input bytes, time/indices/limits and 17 expectations were fixed before output and author-reviewed. All were used in v6 and are development regressions. |
| Execution and sending | Existing Codex `gpt-6.1-sol`, three actual calls, one round, concurrency two, no capture-driver retries; each has one turn, no tools or subagents. Only selected sources, time/indices/limits and prompt/Schema are sent, excluding annotations, guides, native paths and historical outputs. |
| Time and usage | 2026-10-10 18:03:14.017–18:06:58.541 UTC, wall clock 224.524 seconds; inputTokens 30,772, outputTokens 13,393, cacheReadTokens 36,864. These are executor projections, not a bill; cache and input fields are not added for cost. USD cost is unknown; unreported placeholder zeros are not actual zero cost. |
| Contracts and review | Response v4, entity history v2, knowledge history v2 and extraction run v4 are unchanged; no prompt or historical score edits. The implementation agent reviews every entity, mention, candidate and statement, as author review rather than independent human evidence. |

Call failures, cancellations, parse failures, root rejections, entity rejections and knowledge rejections are zero. Admission retains `semanticReview=pending`; subsequent review is saved separately, preserving capture records. The three-call quota is consumed without extension. The earlier [preparation report](./entity-extraction-v8-workflow.md#preparing-the-real-pilot) records its then-unexecuted state; this report separately records subsequent capture.

## Itemwise author review

| Window | Entities/mentions/knowledge/statements | Results and reservations |
|---|---|---|
| `real-session-before-resolution` | 13/15/2/4 | Central Session survives, with positive initialization and negative updates separate. Count=2, one initialization/SID, blocked reading and unknown attribution remain without later explanations. Two additional operation concepts have explicit contrast evidence and are allowed, not required identities. |
| `real-session-after-resolution` | 11/17/3/8 | Session, API=1 versus overview=2, earlier doubt and later explanation survive. Master/beta.2 remain separate with unpublished status and remaining gaps. Master is version against frozen object, with its reasonable interpretation separately noted; lack of a need to modify becomes a negative normative requirement. |
| `real-protected-correction` | 17/18/2/7 | Session, MiniappClient, core and separately discussed methods/fields survive. The concrete regression narrows earlier judgment, distinguishing source reports from tool evidence and plans from completion. Field identity/source remain, but its value is absent from derived knowledge, missing a frozen coverage check. |

### Target behaviors observed

Both counting windows retain Session. One also identifies initialization/update operations; the other uses Session statements directly. Explicit operation contrast permits reasonable independent granularity under v8; object counts do not determine quality. The earlier window stays unresolved, with API/page explanations appearing only in the later window. Neither numbers nor one SID fabricate a particular instance.

Counting rules separate positive initialization from negative updates, without repeating the later v6 output's polarity mixture. The code window separates methods, fields, versions and return values, preserving the local regression, absent repair results and the constraint against late errors polluting a new Session. It does not generalize all protected overrides as wrong.

These are itemwise observations of current outputs. Sources are assistant reports, with tool results absent; linked references or source claims of passing verification are not independent proof. Historical v6 28/31 and 39/40 and v7 20/22 stay unchanged; this batch establishes no causal prompt benefit.

### Level dispute, modality and knowledge coverage gap

Master is separately compared with released beta.2. The output treats it as an unpublished development version with an unknown commit; the author finds a reasonable code-state interpretation. However, the frozen criterion permits object only, so one mismatch remains. Multiple reasonable levels must be adjudicated before a future freeze, without expanding current answers after seeing outputs to declare success.

The later window's `p2/s5` turns “no need to modify the SDK” into `modality: normative`, `polarity: negative` and a base predicate of modifying for this Session display-count difference. Project rules interpret this combination as a negative requirement, suggesting “should not modify,” while the source only denies necessity. Preserving the source judgment in context does not restore the missing necessity scope in statement fields. This is a strengthened-modality knowledge error; atomic splitting and structural admission do not resolve it.

The `_unhandledSessionStatus` field identity and original position remain, but its `unhandled` value appears in neither derived entity qualifiers nor knowledge statements. The frozen criterion requires associating the value with the field/owner, so one knowledge coverage gap is recorded. The source stays traceable; this is not a missing field entity or a requirement to create a value entity. Entity extraction permits few or no knowledge candidates; every unselected source fact is not thereby an error. Future work must define association coverage for independently discussed configuration points.

## Application replay

Only recorded outputs are reused through the current production application in an isolated knowledge directory for capture, generation and persistence, with **zero additional external model calls**. Only evidenceRef binds bijectively to new snapshots; messages, roles, time/indices and original outputs stay unchanged. The application allocates fresh persistent identities, with mappings, original/rebound digests and both limitation sets recorded, without impersonating model-run identities.

Reopened file stores match all 41 entities, 50 mentions, seven candidates, 19 statements and citations against admitted payloads, including the core-version component association. All entities are searchable, mentions resolve and knowledge binds explicit entity revisions. This proves wiring and persistence, without repairing the level mismatch or missing value; candidates are not marked user-retained. Chrome correction/history, merge/split and four-lane reports are not rerun; unchanged UI evidence reuses the [recorded-output workflow acceptance](./entity-extraction-v8-workflow.md).

## Limits and next work

One round, three software windows, one source group and deliberate overlap do not generalize to broad-domain entities, long conversations, cross-Agent reuse or overall stability. All windows were viewed in v6, neither blind, independent nor representative. Selected windows exclude tools, system and surrounding context; another 24 source records failed parsing, leaving completeness unknown. Positions target redacted text.

Backend model revision, seed, sampling parameters and default reasoning effort are not fixed or reported. Forty-three synthetic windows/147 critical mentions remain untested. This batch also excludes the earlier real Memory ambiguity and third Session-omission window; two observations do not establish that all prior problems are fixed.

Next, cover the distinction among unnecessary, forbidden and not prohibited, and define reasonable code-state identity levels and configuration-point association coverage, then address actual gaps with rules/regressions. This run adds no model calls or entity-module scope. [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) retains the level dispute, modality error, knowledge gap and missing independent evidence and incomplete overall quality.
