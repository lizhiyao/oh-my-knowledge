# Entity extraction v8: five-window granularity diagnostic

**Entity granularity and knowledge retention in these five windows match itemwise self-review expectations; overall quality remains unverified.** Ordinary properties remain knowledge statements about their owner; independently discussed metrics and operation concepts without proper names remain separate entities. Frozen critical mentions match 21/21, with no observed identity errors or lost properties/formulas. Two knowledge distinction relations have awkward Chinese wording, recorded for future improvement. This small pilot does not establish comprehensive entity extraction quality.

## Execution scope and evidence

On 2026-10-11, the user agreed to the displayed five-window plan. The diagnostic uses the v8 prompt, corpus v8/guide v6, checker v3 and response Schema v4 frozen in [PR #1144](https://github.com/lizhiyao/oh-my-knowledge/pull/1144). Exactly five existing Codex `gpt-6.1-sol` calls ran once, with concurrency at most two, no automatic retries or additional calls, and unknown USD cost. Only six selected synthetic messages, source indices/coverage limits and the frozen prompt/Schema were sent; annotations, guides, review records, native paths and historical outputs were excluded.

[Download evidence JSON](/entity-extraction-v8-diagnostic.json): complete frozen corpus, bilingual guide, prompt, input digests, annotation self-review before output, original preparation plan, execution records, five verbatim final outputs, admission/program checks, executor projections, self-review and capture/inspection scripts. Published material is entirely synthetic; full executor results and frozen builds remain outside the repository. The original preparation plan retains its unexecuted status; separate execution records preserve authorization and completion without overwriting preparation history.

| Frozen item | Value |
|---|---|
| Measurement identity | `sha256:64bc62416231101ae1b2010da66421202b0c9f2b60bb4868a6fd07146affb8ca` |
| Raw UTF-8 prompt digest | `sha256:e6f220f67c0d4ea9707672ad8737f8aa4d6f0263e5f37da949f0ab41f0f17038` |
| Tested source | `6bfd2f72a2624a78b7c2f040ac15995dcb9b2e47` |
| Review status | Annotation/output author review completed; independent human review not performed; `goldReady: false` |

The extracted frozen build reproduces its manifest and every input. This run changes no prompt, Schema, corpus alternatives or checking semantics. Updated guide status does not impersonate the frozen digest; reproduction uses evidence text and builds. v7 20/22 and v6 39/40 remain unchanged. The new standard's 21/21 is neither a rescore nor evidence of causal prompt improvement.

## Program results

| Observation | This single round |
|---|---:|
| Planned/actual calls/unique records | 5/5/5 |
| Call/parse failures, cancellations, structural rejections | 0 |
| Strict critical mentions matched | 21/21 |
| Not-evaluable identity mention pairs | 0 |
| Wrong merges/wrong splits/identity-level mismatches | 0/0/0 |
| Accepted entities/mentions/knowledge candidates/statements | 13/23/6/16 |

The three selected development windows match 14/14; two newly reserved windows match 7/7. The full corpus has 48 windows and 168 critical mentions: 43 windows and 147 critical mentions remain untested. The full development summary stays `incomplete`. Critical annotations are non-exhaustive, requiring self-review of extras; precision/F1 are `null`, and 21/21 is not overall entity accuracy. Program `semanticReview: pending` remains unchanged; author judgment is separate `agentReview`.

## Itemwise self-review

All 13 entities, 23 mentions, six knowledge candidates, 16 statements and citations were checked for granularity, extras, coreference, knowledge endpoints, values, formulas, polarity, capability versus occurrence and temporal limits.

| Window | Strict mentions | Self-review and limits |
|---|---:|---|
| `dev-session-properties` | 5/5 | Central Session and attribution adaptation remain distinct; four short names and the overlapping complete adaptation phrase refer to different objects. Three definition/property statements preserve counting/update rules, separating initialization increments from no update increments, without claiming the unconfirmed check succeeded. |
| `dev-independent-metrics` | 5/5 | Both metrics and rule R remain separate; the pronoun refers to S_total and R→S_total is correct. Calculation applies only to S_total, with no invented Session or alert execution; distinction wording is awkward but meaningful. |
| `dev-operation-concept` | 4/4 | Update and initialization are concepts, not actual executions; the extra lifecycle has source and classification support. Repeatability belongs to update, not initialization; initialization establishing initial state is retained. |
| `held-policy-properties` | 3/3 | Life insurance, insurance and P7 remain separate; the extra policy pronoun correctly refers to P7. RMB 100,000, 30 days and policy-only scope remain, without independent numeric objects or unsupported life-insurance membership, effectiveness or benefit conditions. |
| `held-unnamed-metric-concepts` | 4/4 | Click-through and conversion concepts remain separate without IDs. Clicks/impressions and transactions/clicks formulas retain the local definition, without default replacements or invented measurements; Chinese distinction wording is awkward. |

The extra lifecycle and two extra mentions have source support and were not judged false extraction. Distinction relations read “是不同于对象的指标” and “是不同的指标概念于”; composing endpoints is awkward and remains a knowledge-wording follow-up. Endpoints and source meanings are correct, without proven reversed relations or rewritten raw outputs.

## Usage and limits

The executor reports 47,369 uncached input tokens, 61,440 cache-read tokens and 9,688 output tokens. None of five records reports USD cost; cost is unknown and placeholder zeros are not measured values. Wall-clock time is 135.232 seconds. Executor projections show no tool calls or subagents, without establishing a general isolation guarantee.

This run verifies outputs and admission, with no new Studio, correction, history or persistence-flow acceptance. Independent human evidence is missing; the reviewer remains the implementer and corpus author. Backend revision, seed, sampling parameters and default reasoning effort are not fixed or reported. No second round, v8 real-conversation validation, overall stability, factual truth or cross-Agent reuse benefit is established. Conclusion: `selected_granularity_behaviors_observed_full_quality_unverified`.

## Next step

These results support the current granularity design, without requiring another prompt version solely for these outputs. Next, reuse outputs for focused application-flow checks and prepare a small real-source batch before new calls, concentrating on concept/property boundaries in complex context; actual sending requires authorization for its concrete scope. Viewed validation windows may only become development regressions, without rewriting frozen splits. The remaining 43 windows, independent review and overall quality remain incomplete in [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127).
