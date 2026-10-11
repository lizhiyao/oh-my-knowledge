# Entity extraction v10: five-case knowledge-retention diagnostic

**Modality, code-state scope and configuration knowledge in the five selected cases match itemwise self-review expectations, but strict regression does not pass and overall quality remains unverified.** Critical mentions match only 10/13: three outputs use longer source boundaries than the frozen alternatives. Answers remain unchanged and are not re-scored as passing. Self-review finds all four mandatory knowledge roles retain exact values, types, source reasons or code-state limits; this does not replace independent human review.

## Execution scope and evidence

On 2026-10-11, the user explicitly authorized the existing five-case plan. The sealed runtime from [PR #1150](https://github.com/lizhiyao/oh-my-knowledge/pull/1150) uses prompt v10, corpus v10/guide v8, checker v4 and response Schema v4. Exactly five Codex `gpt-6.1-sol` executor invocations ran once, sequentially, with no automatic retries or additional calls and unknown USD cost. Only nine synthetic messages, timestamps/indices, coverage limits and the frozen prompt/Schema were sent; annotations, guides, native paths and historical outputs were excluded.

[Download evidence JSON](/entity-extraction-v10-diagnostic.json): frozen corpus, bilingual guides, prompt, annotation author review, original preparation plan, authorized execution records, five verbatim final outputs, admission/program checks, usage projections and itemwise semantic self-review. Published material is synthetic; full executor results and sealed builds remain outside the repository.

| Frozen item | Value |
|---|---|
| Measurement identity | `sha256:b689da755d928803c8f237d1d33c0a333df782de0463648fcb0c4fb61bc4b257` |
| Raw UTF-8 prompt digest | `sha256:639253ead5f92f7d05f69cc85c06396068a8974363cba5334205388722fcdc9b` |
| Tested source | `f5f27fd69bdb695b589ef324ecc017514acebbad` |
| Review status | Annotation/output author review completed; independent human review not performed; `goldReady: false` |

Runtime, checker, guides, corpus, dependencies and every selected input digest were verified before calls. Offline inspection of both splits using the same sealed build reproduces the measurement identity and full-split summaries. Both offline commands exit 1 because each split still has unattempted windows; both make zero new model calls. Updated guide status does not impersonate frozen digests; reproduction uses evidence text and the sealed build.

The capture manifest mistakenly inherited the preparation plan's `modelCalls: 0` label. Its `attempted`, `recorded` and `executorInvocations` are all five, with five complete unique outputs. Evidence preserves that manifest verbatim and explicitly reports five actual calls and the reason in the derived execution projection. No calls were rerun to repair bookkeeping. The original preparation plan stays unexecuted; authorization and results are separate records.

## Program results

| Observation | This single round |
|---|---:|
| Planned/actual executor invocations/unique records | 5/5/5 |
| Call/parse failures, cancellations, structural rejections | 0 |
| Strict critical mentions matched | 10/13 |
| Not-evaluable identity mention pairs | 4 |
| Wrong merges/wrong splits/identity-level mismatches | 0/0/0 |
| Accepted entities/mentions/knowledge candidates/statements | 17/22/5/12 |

Three development windows match 8/8; two reserved validation windows match only 2/5. Four not-evaluable mention pairs follow from three unaligned boundaries and do not count as identity passes. The full corpus has 60 windows/199 critical mentions; 55 windows/186 critical mentions remain untested. Both full splits are `incomplete`. Annotations are non-exhaustive; precision/F1 are `null`, and 10/13 is not overall entity accuracy.

Program `semanticReview: pending` and knowledge-coverage `needs_review` remain unchanged. Different endpoint expressions, collective subjects or unmatched boundaries produce `needs_review`/`not_observed`/`not_evaluable` cues explained by full-text self-review, without conversion into automatic program passes. Independent semantic review remains incomplete.

## Itemwise self-review

All entities, mentions, knowledge statements and citations were reviewed. Evidence separately records each entity's rationale, complete reviewed IDs, statement mappings for every knowledge role and three boundary findings.

| Window | Strict mentions | Self-review and limits |
|---|---:|---|
| `dev-necessity-versus-prohibition` | 3/3 | Three SDK mentions corefer. Negated necessity uses descriptive/negative; negative and positive norms remain separate with scenario and unknown-time scope. Page, signature and interface are source action targets, without invented products or executions. |
| `dev-absence-versus-permission` | 3/3 | Absence of prohibition is not promoted into authorization. Administrator permission and production-policy prohibition remain distinct. The script concept does not assert the same physical file. Source-supported policy/administrator subjects differ from frozen shorthand endpoints, but full-text review confirms modality, direction, environment and citations. |
| `dev-config-rationale` | 2/2 | Mandatory knowledge retains string `'unhandled'`, client C, this browser host and the source reason distinguishing unhandled exceptions from process crashes. Two extra concepts have source-comparison support. No tool verification, invented mechanism or universal effect. |
| `held-code-state-without-sha` | 1/3 | Current tested code and r2 are distinct versions; “both” is a sourced collection. Statements retain this round's pass, unreleased changes, unknown commit and no future generalization. Two longer boundaries fail frozen alternatives. In particular, “main 上的改造” treats a change-property phrase as a code-state mention, an imprecise boundary, while knowledge content remains. |
| `held-config-literal-types` | 1/2 | Two mandatory facts distinguish test boolean `false` from production string `'false'`, preserving owner, environment and unknown runtime effects. The field does not split by environment. `enabled 字段` exceeds frozen `enabled`; strict failure remains. |

All four mandatory roles are `observed_consistent_on_self_review`. The current-state result is expressed through explicit “both passed” and collection membership; release status is a separate statement. Lack of a direct endpoint projection does not establish mandatory knowledge absence. Optional roles were also generated and reviewed, without using empty results to prove modality correctness. Self-review finds no source error in extra entities, without establishing an overall false-extraction rate or independent quality evidence.

## Strict boundary findings

| Window/mention | Frozen alternative | Actual contiguous source |
|---|---|---|
| Tested code/first mention | `当前 main` | `当前 main 的被测代码` |
| Tested code/second mention | Second `main` | `main 上的改造` |
| Field | `enabled` | `enabled 字段` |

All three have contiguous source text, but differ: `当前 main 的被测代码` and `enabled 字段` are reasonable complete names absent from frozen alternatives. `main 上的改造` centers a change property; treating the entire phrase as the code-state mention is imprecise. Select the `main` owner span without inventing a separate change entity. Self-review finds no missing corresponding thing or configuration fact, without automatically tolerating every span containing a target word. Future work may preregister the first two expressions and continue requiring actual object names for property-owner mentions, without changing this run's answers, alternatives, scores or not-evaluable counts, or treating viewed windows as fresh validation gains.

## Usage and limits

The executor reports 51,191 uncached input tokens, 61,440 cache-read tokens and 9,357 output tokens. None of five records reports USD cost; cost is unknown and placeholder zeros are not measurements. Wall-clock time is 192.528 seconds. Projections show no tool calls or subagents, without a general isolation guarantee. Default reasoning effort, backend revision, seed and sampling parameters are not fixed or reported.

This run establishes no real-conversation, second-round stability, causal comparison, full-quality or cross-Agent reuse evidence, and adds no Studio/storage/correction-flow acceptance. Owner isolation and background configuration were unselected. Three strict misses and four not-evaluable identity pairs remain, so the frozen strict gate does not pass. Conclusion: `selected_semantics_observed_strict_boundary_regression_not_passed`.

Next, clarify allowed mention boundaries and annotation quality before upgrading prompts or increasing calls based on this batch. Viewed validation windows may only become development regressions, without rewriting frozen splits. The other 55 windows, independent review and full quality remain incomplete in [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127).
