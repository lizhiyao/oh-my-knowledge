# Entity extraction: two-case follow-up under v12 annotations

**The target entity checks meet this batch's expectations: 6/6 critical mentions and both mandatory configuration roles consistent on itemwise self-review. Keyboard cleaning knowledge was not generated and remains unobserved; overall quality, stability and independent evidence have not passed.** Two calls ran, once per case, without automatic retries. Prompt remains v11; original v11 2/3, v10 10/13 and all raw historical results remain unchanged.

## Scope and conclusion

This batch follows the [complete-name coverage audit](./entity-name-annotation-coverage.md), checking only configuration literal types and keyboard category versus a concrete object, the two cases unattempted after the [previous first-case stop](./entity-extraction-v11-boundary-diagnostic.md). The user explicitly approved two synthetic messages and at most two calls through the existing Codex `gpt-6.1-sol` executor, with itemwise implementation-agent review. Unused previous authorization was not transferred.

The sealed build from [PR #1154](https://github.com/lizhiyao/oh-my-knowledge/pull/1154) uses corpus v12/guide v10/checker v4, prompt `knowledge-extraction-v11` and response Schema v4. Runtime, checker, guides, corpus, dependencies and both input digests were verified before execution. Only the synthetic texts, roles, evidence identifiers/indices and coverage limits, plus the frozen prompt/Schema, were sent. Answers, review criteria, source paths and historical outputs were excluded.

The configuration case passed strict checks and full knowledge self-review before the keyboard case ran. Neither triggered the stop rule, and both authorized calls are consumed. The newly frozen complete category name “键盘这一类物品” appears in this batch and matches its v12 alternative, without accepting arbitrary spans containing a short name. This establishes the observed targets for this batch, not a model-capability gain from annotation expansion or exhaustive name-boundary coverage.

## Program results

| Observation | This batch |
|---|---:|
| Call limit/actual executor invocations/unique outputs | 2/2/2 |
| Selected windows attempted/unattempted | 2/0 |
| Configuration/keyboard strict critical mentions | 2/2; 4/4 |
| Total strict critical mentions | 6/6 |
| Mention identity pairs matched/not evaluable | 7/0 |
| Identity levels and associations matched | 4 |
| Accepted entities/mentions/knowledge candidates/statements | 4/7/1/2 |
| Mandatory configuration roles reviewed/unobserved | 2/0 |
| Optional cleaning knowledge | Not observed |
| Call/parse failures, cancellations, structural rejections | 0 |

Program `semanticReview: pending` remains, as do configuration `knowledgeCoverage: needs_review` and keyboard `not_observed`; self-review is separate. The seven actual mentions include one source-supported noncritical phrase, “桌上的那把”, which is not added to frozen annotations or the critical denominator. Only critical mentions are annotated; precision/F1 are `null`, and 6/6 is not overall accuracy.

## Itemwise review

| Case and referent | Original output in this batch | Self-review |
|---|---|---|
| Configuration owner and field | “服务 S” and “enabled 字段” map to separate objects | The field is not split by environment or value type. Complete names, locations and ownership are correct, without invented system/component levels. |
| Test value | Field statement “取值为布尔值 false”, conditioned on service S/test environment | Exact value, type, owner, environment and unknown runtime effect remain; neither disabled status nor tool verification is inferred. |
| Production value | Field statement “取值为字符串 'false'”, conditioned on service S/production environment | Quotes and string type remain, without boolean normalization; source assertion and unknown times remain. |
| Keyboard identities and coreference | Category and concrete keyboard remain separate; “它” and “桌上的那把” refer to the concrete object | Four critical mentions and six identity pairs match. The extra description is source-supported, without mechanical trimming of location qualifiers. |
| Cleaning need | `proposals: []` | This is predeclared optional knowledge and remains unobserved. Empty output cannot establish correct modality/polarity or cleaning-information retention. |

All four entities, seven mentions, two statements in one candidate, one evidence link and one citation were reviewed. Configuration evidence quotes the complete source with `source_assertion`, consistent with assistant-only/unverified coverage limits. Both required roles were checked against full statements, without treating field endpoints, entity descriptions or keyword matches as semantic verdicts. Implementation-agent self-review is not independent human evidence; `goldReady: false`.

## Evidence and reproduction

[Download evidence JSON](/entity-extraction-v12-followup-diagnostic.json): original prepared plan/digest, authorization and actual invocation manifest, frozen corpus-file identity, original bilingual guides/prompt, both verbatim outputs, program admission/checks, itemwise review, usage and full unattempted scope. Frozen corpus bytes come from immutable `test/fixtures/entity-extraction-review-v12.json`; full executor results and sealed builds remain outside the repository. Published material is synthetic.

Measurement identity is `sha256:af1fe5fb4ae3acf7995748e45e7f90cc150049c0a64e002d3b76e204ae34e6ee`, raw UTF-8 prompt digest is `sha256:0e4456776bcce15074b54562eacb06b7426a7d0e3da6c078b46bd4265652015c`, and tested source is `470e513e10df70fbecee393b103dbc3973556f48`. This batch changes no prompt, corpus, guide, checker, response or storage contract.

Offline inspection of both full splits reproduces the identity using the sealed build; each command adds zero model calls and exits 1, preserving `incomplete`. Of 58 development windows/195 mentions, two windows/six mentions were checked, leaving 56/189. Both validation windows/four mentions remain unattempted. In total, 58 windows/193 mentions are untested in this batch. The old main output is not pooled into the new batch; the original three-case run still stopped after its first case.

The executor reports 20,945 uncached input tokens, 24,576 cache-read tokens and 1,945 output tokens; summed call wall-clock time is about 55.654 seconds. USD cost was not reported and remains unknown; placeholder runtime `costUSD: 0` does not mean free. No tool calls or subagents were observed. Reasoning uses the executor default, while backend revision, seed and sampling parameters were not fixed or reported.

## Limits and follow-up

This is one round on two synthetic development cases, without contemporaneous old-prompt controls, independent human review, reserved validation, stability or real-log population evidence. Configuration has an older development output, while keyboard has no prior output; neither is claimed as blind testing. Old scores and evidence digests were verified unchanged; new 6/6 does not replace historical misses or stopping facts.

Conclusion: `two_development_cases_target_checks_consistent_on_self_review_optional_cleaning_not_observed_full_quality_unverified`. [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) retains overall-quality and independent-evidence gaps, along with ungenerated cleaning knowledge. There is no new Studio-flow or cross-Agent reuse-benefit acceptance. Future scope needs a concrete objective; higher synthetic match counts alone cannot establish reliable entity extraction.
