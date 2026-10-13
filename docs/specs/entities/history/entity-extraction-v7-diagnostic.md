# Entity extraction v7: six-case diagnostic and granularity dispute

**The intended behaviors of three corrections appeared in these outputs; the frozen strict regression still did not pass.** The central Session concept was retained; an assistant-selected answer did not resolve the user's original Memory reference, while explicit user clarification did; positive and negative requirements became separate statements. Product-name and collective-predicate counterexamples also met itemwise self-review expectations. Strict critical mentions matched 20/22: counting and state updates were expressed as Session property statements rather than the two separate entities required by frozen annotations. Adjudicate independent-retrieval granularity without changing these answers or scores.

## Execution scope and evidence

On 2026-10-11, the user agreed to one diagnostic round for the six proposed new synthetic cases. The run used [PR #1141](https://github.com/lizhiyao/oh-my-knowledge/pull/1141)'s frozen prompt v7, corpus v7/guide v5, checker v3 and response Schema v4. Exactly six existing Codex `gpt-6.1-sol` calls ran with concurrency capped at two, no automatic retries or added calls, and unknown USD cost. Only selected source text, record indices, coverage limits and the complete prompt/Schema were sent; annotations, guide and previous outputs were excluded.

[Download evidence JSON](/entity-extraction-v7-diagnostic.json): complete frozen corpus, bilingual guide, prompt, inputs and measurement digests, six verbatim final outputs, admission/program checks, executor-projected counts, itemwise self-review and capture/offline inspection scripts. Full executor results and frozen builds stay outside the repository. Published material is synthetic, with no real-conversation text. The author reviewed all 42 annotations before outputs; author review is not independent human evidence.

| Frozen item | Value |
|---|---|
| Measurement identity | `sha256:108acc6c8abf6fd382651b074576268ef9ad2987b54aeef747a541faea382976` |
| Raw UTF-8 prompt digest | `sha256:caed40c13847ce1a9c23d4579d49eb9d24187b41e06c4d51fc002682d8b3acd2` |
| Evaluated source | `0242f950854f057447407718cbe6ba7f6fed8b00` |
| Review status | Annotation and output author review complete; independent human review absent; `goldReady: false` |

The unpacked frozen build reproduced an identical manifest and all input digests. Guide text updated after reporting does not reuse old digests; reproduction uses the frozen guide and build in the evidence. Prompt, Schema, corpus alternatives and checker semantics were not changed from these outputs; v6 reports, raw outputs and scores remain intact. There is no paired v6/v7 run with identical inputs, so these behaviors do not establish causal prompt improvement.

## Program results

| Observation | Single round |
|---|---:|
| Planned / actual executor calls / unique records | 6/6/6 |
| Call/parse failures, cancellation, structural rejection | 0 |
| Strict critical mention matches | 20/22 |
| Not-evaluable identity mention pairs | 11 |
| Wrong merges/splits among aligned pairs | 0/0 |
| Evaluable granularity/link mismatches | 0 |
| Admitted entities/mentions/knowledge candidates/statements | 13/22/4/8 |

Development cases matched 15/17 and newly reserved cases 5/5. All strict misses and 11 `not_evaluable` pairs arise from the missing independent counting/state-update objects in `dev-session-properties`; the two corresponding identities also remain `not_evaluable`, never passes. Critical annotations are incomplete: precision/F1 and overall semantic accuracy are `null`. 20/22 is not entity accuracy.

The full corpus contains 42 windows and 150 critical mentions; only six were selected. The other 36 windows and 128 critical mentions remain untested, and the full development summary remains `incomplete`. No second round ran; full acceptance or stability cannot be claimed.

## Itemwise self-review

All 13 entities, 22 mentions, four knowledge candidates and eight statements were reviewed, including two extra mentions, source grounding, identities, direction, conditions, time, modality, polarity and requirements/execution status. Original program `semanticReview: pending` is unchanged; author judgments are separate `agentReview` evidence, never independent semantic acceptance.

| Case | Strict mentions | Self-review and limits |
|---|---:|---|
| `dev-session-properties` | 5/7 | Four Session concept mentions and the separate adaptation object remain, with no invented instance or successful check. Counting/state updates are two of three sourced concept/property statements, preserving meaning and polarity, but two independent objects are absent; granularity needs adjudication. |
| `dev-unconfirmed-memory` | 4/4 | Original Memory stays a separate unresolved object with Atlas/Beacon candidates; an assistant answer is not user clarification. Default-off binds only explicitly named Atlas, preserving source assertion, unknown type/version/environment and lack of verification. |
| `dev-confirmed-memory` | 4/4 | Explicit user clarification merges initial Memory with Atlas while Beacon stays separate. No default-value answer exists, so knowledge is empty. |
| `dev-session-atomic-negation` | 2/2 | Two normative statements have positive/negative polarity, one negation each and separately cited clauses; no implemented or verified behavior is claimed. |
| `held-product-name-substring` | 2/2 | Only the NodeLedger product remains; extra “this product” reference is supported. No Node.js object is split out of its name, and no knowledge is invented. |
| `held-collective-norm` | 3/3 | Teams and complete collection remain distinct; collective exercise requirements and individual-publication prohibition are separate. An extra exercise activity is sourced without claiming completion. The second citation is broader, so the exercise-role projection lists two statements; itemwise review distinguishes their reasonable meanings and retains original program status. |

The extra product reference and exercise activity are sourced, not automatic false positives. Two windows without knowledge support only entity/reference judgments, without proving downstream knowledge links reliable.

## Granularity dispute and next step

Frozen annotations require Session counting and state updates to be independently retrievable objects. Output preserves the central Session identity and expresses counting rules/state-update behavior as sourced property statements. The author considers this a reasonable coarser representation; it does not change strict misses or establish that independent property/process retrieval needs are met.

Next define which properties/processes deserve independent retrieval, maintenance and knowledge association, then adjudicate allowed representations and counterexamples before future outputs. These six outputs are development diagnostics; both viewed reserved windows can only become development regressions. Do not amend answers or scores or mechanically split names to inflate entities. No new real-conversation calls ran; a v7 real pilot needs separate concrete authorization. [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) retains unfinished granularity, independent review and overall quality items.

## Local capture-status error

The reused capture script retained a final `state.recorded === 11` comparison, leaving the original manifest `incomplete` and exit code 1 despite completing the six-call plan. It caused no retries or extra calls. Original driver digest, manifest, six records and full executor results remain intact, without rewriting completion status.

Offline inspection confirms exactly one record for each selected case, six actual executor calls, matching input digests and all raw outputs, separately recorded as `captureCompletion.status: captured`. This local completion-label error is separate from model call/parse failures: records were not lost, and ignoring failure does not establish acceptance. The 36 unselected development windows independently keep the full-corpus status `incomplete`.

## Usage and limits

Executor projections report 55,142 uncached input tokens, 73,728 cache-read tokens and 6,947 output tokens. No record reports USD cost; cost is unknown, and unreported placeholder zeroes are not measurements. Wall-clock duration was 180.506 seconds. No tool calls or subagents were observed in records; this is no general isolation guarantee.

This round checks extraction output and program admission, without new Studio, correction or history-workflow acceptance. Only one small synthetic sample ran. Backend model revision, seed, sampling parameters and default reasoning effort were not fixed or reported. Reviewer is also implementer/corpus author; independent human review is absent. There is no real-log accuracy, population stability, factual truth, causal improvement or cross-Agent benefit evidence. Conclusion is `targeted_behaviors_observed_strict_regression_not_passed`, not comprehensive entity-extraction readiness.
