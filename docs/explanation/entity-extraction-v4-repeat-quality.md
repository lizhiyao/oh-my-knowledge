# Entity extraction v4: two-round results and limits

**Two rounds and per-output Agent self-review are complete; the frozen regression gate did not pass.** All 32 calls returned structurally admitted output, but each round matched only 45/50 frozen critical mentions and left 9 identity mention pairs not evaluable. Referent kinds still overinterpret sources. Self-review also found a shared-reference attribution defect and one ambiguous knowledge negation. This evidence does not establish reliable entity extraction.

This report uses corrected synthetic corpus v4, guide v2, checks v2, and production `knowledge-extraction-v4` / response Schema v4. It changes no prompt, gold, threshold or user storage and preserves the [historical report](./entity-extraction-repeat-quality.md) and its scores.

## Frozen evidence and execution scope

On 2026-10-10, the user authorized two rounds under corrected standards, reviewed by the implementing Agent. Each round called the existing Codex executor with `gpt-6.1-sol` once for each of 16 synthetic windows: 8 development and 8 reserved validation windows, 32 calls total, no harness retries. Concurrency was limited to 2: each split ran serially, with a barrier before the next round. The model received only frozen source messages, coverage limits and the exact production prompt, excluding gold, review criteria and previous outputs.

[Download the evidence JSON](/entity-extraction-v4-repeat-quality.json): exact corpus and bilingual guide bytes, prompt, inputs and digests, every final output, structural admission, strict checks, per-output self-review, executor usage and capture script. Full OMK executor results remain in this run's external archive; the public file projects counters and metadata and retains full-result digests. The executor does not expose raw provider JSONL, so these counters are not raw provider billing records.

| Frozen item | Value |
|---|---|
| Measurement identity | `sha256:850658605f5c99ad977081b8e3f97eddef4730d3c70e1b27c9a77cfd0f78ce5b` |
| Corpus SHA-256 | `ad31afbbb1db44bc98dc2e8e6f545419f39317e5d83f745382c445d715cf4b67` |
| Raw UTF-8 prompt SHA-256 | `77fc3ef5b0bd8ad1e470cb279c50359a4966c9dedfc6503672b4d307ad8f4715` |
| Source baseline | `f8b6ba7eadd9b9f92eab771314bfdbe82d638625` |
| Annotation status | Author self-review completed; independent human review not performed; `goldReady: false` |

The identity also binds bilingual guides, compiled checker, production runtime, dependency digest and Node 24.21.0. Production prompt/Schema stayed unchanged between rounds. Corrected annotations make this a different measurement from historical runs; old counts are not directly comparable. The validation split is public synthetic data, not a hidden blind set.

## Program check results

| Observation | Round 1 | Round 2 |
|---|---:|---:|
| Recorded calls | 16/16 | 16/16 |
| Call/parse failures, cancellations, structural rejection | 0 | 0 |
| Strict critical mention matches | 45/50 | 45/50 |
| Unchecked critical mentions | 0 | 0 |
| Wrong merges/splits among aligned pairs | 0/0 | 0/0 |
| Not-evaluable identity mention pairs | 9 | 9 |
| Identity kind/link mismatches | 3 | 5 |
| Admitted entities/mentions | 39/65 | 40/63 |
| Admitted knowledge candidates | 12 | 10 |

Structural admission establishes location and reference closure. Each round's 90% is strict-boundary recall for these 50 markers, not entity accuracy. Annotation is not exhaustive, so precision/F1 are `null`. Zero observed wrong merges/splits does not make the 9 not-evaluable pairs pass.

Each round's five strict misses come from the same two windows: `dev-unresolved` quotes “西区对象 W” and “东区对象 E”; `dev-replacement` quotes “旧 config.json”, “另一个 config.json” and “新 config.json”. Self-review finds these meaningful full descriptions with correct object attribution. They were absent from the prefrozen alternatives, so original misses and `not_evaluable` remain. They are not all absent entities, and adding answers after outputs would not legitimately make the score 100%.

Across rounds, development matched 44/54 critical mentions and validation 46/46. Validation still contains kind defects and an extra-mention defect; complete strict boundary coverage does not prove complete semantic correctness.

## Per-output self-review and findings

All 32 outputs and 22 generated knowledge candidates were reviewed for source support, identities, extra mentions, roles, negation, conditions, time and source assertions versus observations. Six outputs contain entity semantic issues; another knowledge candidate contains polarity ambiguity, totaling seven outputs requiring work. No issues were found in the other outputs within this review's scope. This count is not independent semantic accuracy.

| Case | Review across both rounds |
|---|---|
| `dev-rename` | Rename names and pronoun retain one file identity; an extra content object is supported. A two-ended file/content statement is valid despite program endpoints requiring review. |
| `dev-environment` | Rill's conditions and unverified repair are preserved; both rounds call Pavo a system and label it `component` without sufficient source or kind uncertainty. |
| `dev-instances` | Explicit instances remain distinct and linked to Sieve; pass/fail belongs to each instance, not the entire component. |
| `dev-collective` | One complete collection mention; round 1 retains total 3, round 2 omits optional knowledge. No per-member allocation of the total. |
| `dev-unresolved` | Distinct objects and two candidates for the unresolved error pronoun; valid longer descriptions still miss strict alternatives. |
| `dev-repeated-code` | Three occurrences individually located and grouped as one command; neither round generates optional knowledge. |
| `dev-plan-run` | Plan, rehearsal and production release are separate; rehearsal completion is neither validation success nor release completion. Both fact/case organizations are source-supported. |
| `dev-replacement` | Same-path replacement preserves separate identities and opposing format claims without assuming execution; boundary differences do not alter scores. |
| `val-rename` | Rename identity persists; checklist is a supported extra content object. No invented content change or tool verification. |
| `val-environment` | Environments remain conditions and repair remains a suggestion, without assuming execution or success. |
| `val-versions` | Component and two archived versions remain distinct and linked; immutability remains a user assertion. |
| `val-partial-members` | Both retain partial membership and gaps; round 2 infers `instance` for Cedrus/Dahlia from checking nodes without explicit deployment-instance evidence. |
| `val-truncated` | Unknown antecedent stays unresolved without candidates or invented identity; neither generates optional knowledge, leaving uncertain-subject generation uncovered. |
| `val-namespaces` | Files remain distinct. Round 1 s2 says “do not merge” in relation text and also marks `negative`, creating polarity ambiguity. Round 2 extra m3 assigns shared “their basenames” only to repo-a, losing shared reference; its knowledge does not cite m3. |
| `val-late-correction` | Correction and opposing earlier assertion are retained without verified causal attribution; both rounds label Flint/Garnet `component` without support. The extra outage event's granularity lacks independent adjudication. |
| `val-tool-log` | Writer and log remain distinct; round 1's next overwrite remains future and unexecuted, round 2 omits optional knowledge. |

All eight program identity mismatches concern `referentKind`: one Pavo per round, two Flint/Garnet per round, and two Cedrus/Dahlia in round 2. Actual types may be unknown; the defect is choosing greater specificity without adequate source or uncertainty. The round-2 shared-property error lies outside frozen critical markers, so perfect marker coverage misses it. Negation ambiguity is recorded as an interpretability issue, not a proven opposite knowledge claim.

Self-review found no generated knowledge generalizing environment results, treating plans as completed, inventing time or elevating user assertions to observations. One of 22 candidates retains the polarity ambiguity. Optional omission is permitted; round 2's missing collective/log knowledge is not automatically an error, but reduces downstream coverage. Original program `semanticReview: pending` is unchanged; a separate `agentReview` records completed self-review.

## Usage, cost and coverage limits

| Executor-reported counter | Round 1 | Round 2 |
|---|---:|---:|
| Uncached input tokens | 123,850 | 123,848 |
| Cache-read tokens | 196,608 | 196,608 |
| Output tokens | 21,820 | 19,532 |
| Summed call duration | 736.507 s | 560.003 s |
| USD cost | Unknown | Unknown |

The existing executor normalizes input counters; uncached input and cache reads are separate. Their sum gives 640,914 inclusive input tokens across both rounds. Unreported cache-creation and dollar-cost placeholder zeros are not measured values. All 32 records include usage counters; none reports dollar cost. Concurrent call durations overlap, so their sum is not elapsed wall time; capture wall time was 663.796 s. No tool calls or subagents appeared in executor records; this does not establish a general isolation guarantee.

The implementing Agent authored annotations and reviewed outputs, without independent human evidence. Self-review permits engineering progress but does not replace the independent quality gate. Backend model revision, sampling parameters, seed and default reasoning effort were not fixed or reported. Short synthetic windows and two samples do not establish real-log distributions, long-conversation performance, population stability, cross-Agent knowledge reuse, factual truth or carrier benefits. There is no new/old prompt comparison here and no causal prompt-improvement claim.

## Follow-up and reproduction

Prioritize conservative kind selection under insufficient sources, shared references/property spans, and a single unambiguous representation of relation negation/polarity. Reasonable description boundaries absent from alternatives need adjudication and a new freeze before another run, without rescoring this one. Validation outputs have been inspected; do not tune on them and claim blind gains. Improvement evidence needs separately defined windows unused for tuning.

The [annotation guide](../specs/entity-extraction-evaluation.md) defines the unmet original gate and offline tool. Export each public `captures` item outside the repository and inspect it with the frozen build and corpus; that command makes no model calls. A rebuild changing compiled digests creates a new identity and must not claim this report's identity.

The external run bundle preserves build-freeze information, full executor results, failure records, self-review and scripts. Public evidence supports input/output digest verification, admission and strict-check replay. This authorization and cost scope ends at the completed 32 calls. This delivery does not claim independent quality acceptance; [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) still requires independent review.
