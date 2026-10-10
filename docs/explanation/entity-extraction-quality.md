# Entity extraction v3: observed results and limits

The latest [two-round acceptance on 16 cases](./entity-extraction-repeat-quality.md) found recurring mention failures and environment identity-scope defects. This page preserves the original 2026-10-09 v2/v3 comparison; the new corpus does not recalculate historical results.

The current result supports independent entity inspection and more precise mention records on this small synthetic corpus. It does **not** establish fewer object errors in extracted knowledge, reliable performance on real-user logs, or cross-agent reuse benefits. One object-granularity question remains unresolved. This report records a completed comparison, not a release-quality certification.

## Evidence and review scope

On 2026-10-09 UTC, `knowledge-extraction-v2` and `knowledge-extraction-v3` each ran once on the same 12 synthetic windows through the configured Codex executor with `gpt-6.1-sol`: 24 calls, no automatic retries. The corpus, 38 critical mention positions, 20 important local objects, identity separations, unresolved references, and role checks were frozen before outputs. Review criteria were excluded from model input. Per-case input digests match across versions.

[Download the complete evidence JSON](/entity-extraction-v3-quality.json): exact prompt bytes and hashes, corpus bytes and hash, inputs, frozen mention positions, raw outputs and hashes, admitted results, actual reported usage, and per-case Agent review. Capture records originally mark semantic review as pending; the separate `agentReview` records this subsequent review without rewriting raw outputs. That JSON preserves the original 12-case corpus text; `test/fixtures/entity-extraction-quality.json` now contains an expanded 16-case corpus with a different digest.

| Identity | SHA-256 |
|---|---|
| Corpus | `65294ba9d9e5ab333ca3ed1ad87ccc37c2d6404b55603081321b0fdadcc22222` |
| v2 prompt | `6437b1e895e5d0a89fa6873876ffc84d6887227bf8166607ff4f28d2a7d7b648` |
| v3 prompt | `9738c735598ea69900436fc0f5898563fda1e95a54ce0ff12689a21b62d6b0ec` |

The implementing Agent authored the corpus and reviewed both outputs. Frozen criteria are output-independent, but this is **not independent human review**. Backend model revision and sampling parameters were not proven fixed. v2 ran before v3; there were no randomized or repeated trials. Prompt, output contract, and entity identity scope changed together (`BREAKING-COMPARABILITY`), so observed differences are not attributed solely to prompt wording.

## Observed comparison

Both versions completed 12 calls without structural rejection. No tool call was reported by the executor. Structural admission proves valid locations and references, not correct identities or true claims.

| Observation | v2 | v3 |
|---|---:|---:|
| Returned entities | 12 | 22 |
| Returned mentions | 15 | 42 |
| Knowledge candidates | 7 | 7 |
| Critical positions exactly matched | 3 / 38 | 33 / 38 |
| Critical positions contained in some quotation | 24 / 38 | 38 / 38 |
| Clearly represented important objects, Agent review | 12 / 20 | 19 / 20, with 1 pending |
| Entity / knowledge structural rejections | 0 / 0 | 0 / 0 |

The span counts are location checks, **not semantic accuracy**. A whole-sentence quote can contain several names without assigning each occurrence to its correct object. A longer project-qualified name can be a valid mention despite differing from the frozen shorter span. v3's five non-exact critical positions comprise two project-qualified Atlas names, two “instance T/P” aliases, and “BuildKit logs”; only the last has pending object granularity.

v2 lacks eight important catalog objects: Cache in the correction case, both names in the entities-only case, Queue/Cache/unknown in the ambiguous case, the missing-context unknown, and BuildKit. Its entities are attached to knowledge proposals, so zero proposals also lose entity results. v3 separates these results. This architecture change explains part of the coverage difference; it is not evidence that the model itself became more capable.

## Per-case semantic findings

The fractions below count exact critical spans. The final column records source-based Agent judgments separately.

| Case | v2 | v3 | Review finding |
|---|---:|---:|---|
| `alias-pronouns` | 0 / 4 | 4 / 4 | Both map full name, abbreviation, and pronoun to the engine and retain testing-only / production-unverified scope. v3 separates all four occurrences; its extra cache object and two mentions are source-supported. |
| `homonyms` | 0 / 2 | 0 / 2 | Both distinguish project-qualified Atlas services. Longer qualified mentions are valid; zero exact bare-name matches is not a semantic failure. |
| `role-exchange` | 0 / 4 | 4 / 4 | Both preserve Quartz depending on Cedar and Cedar providing Quartz storage. v2's clause quotes are not four individually mapped occurrences; they do not prove a mistaken merge. |
| `later-correction` | 1 / 8 | 8 / 8 | Both use the latest correction: Runner failed, with no tool results. v2 omits Cache from its catalog; v3 retains both objects and all eight mentions. A negated name inside v2's quotation is not proof of a merge. |
| `abstract-plan` | 2 / 3 | 3 / 3 | Both distinguish the plan from the principle and preserve the not-yet-executed limitation. v3 adds the separate pronoun mention. |
| `entities-only` | 0 / 2 | 2 / 2 | v3 retains both names without inventing types, relationships, or knowledge. v2 returns neither knowledge nor entities. |
| `unresolved-choice` | 0 / 3 | 3 / 3 | v3 keeps an unknown local object, both possible targets, and the reason for uncertainty; it does not choose the nearest name. Neither version proposes knowledge. |
| `missing-context` | 0 / 1 | 1 / 1 | v3 keeps an unknown object without invented type or target. Neither version proposes knowledge. |
| `environment-instances` | 0 / 6 | 4 / 6 | Both distinguish test T/version 1 and production P/version 2. v3's two longer “instance T/P” mentions are valid and later aliases map correctly. |
| `repeated-quote` | 0 / 4 | 4 / 4 | Both preserve service Echo calling tool Echo. v3 separately locates both names and former/latter references, including UTF-16 positions after an emoji. |
| `untrusted-instructions` | 0 / 1 | 0 / 1 | v3 represents “BuildKit logs”; whether this satisfies the frozen “BuildKit” object requires independent granularity adjudication. Its external-path object and file pronoun are source-supported, with existence/content explicitly unknown. No knowledge or observed tool call. |
| `empty-window` | 0 / 0 | 0 / 0 | Both correctly allow empty entity and knowledge results. |

No wrong identity merge or unjustified resolution was observed in the clearly reviewed v3 objects. This small self-reviewed result is not a precision estimate. In the seven comparable knowledge-producing windows, neither version showed a subject/object error under the frozen checks. Therefore **a reduction in knowledge object errors is not established**. Optional omissions are not automatically role errors; the ambiguous cases' zero knowledge outputs also leave downstream uncertain-subject generation untested. The quoted attack case provides no general prompt-injection or filesystem-isolation guarantee.

## Usage, cost, and remaining limits

| Executor-reported aggregate | v2 | v3 |
|---|---:|---:|
| Duration across 12 calls | 203.522 s | 298.172 s |
| Input tokens | 71,731 | 80,547 |
| Output tokens | 5,422 | 9,693 |
| USD cost | Unknown | Unknown |

These are actual reported values from this run, not a production latency benchmark. v3 used more tokens and time here. Unreported dollar cost is unknown, not zero; the evidence contains no estimated price substituted for a reported charge.

The cases are short, synthetic, and selected by the implementing Agent. They do not cover real-log distributions, long conversations, independently judged object granularity, cross-log linking, cross-agent reuse, repeated-run stability, claim truth, or carrier effectiveness. The appropriate next quality evidence is independent adjudication of this corpus and a separately authorized real-log sample. Current functionality lets users inspect and correct results; that usability does not replace semantic validation.

For reproduction, use the [extraction quality guide](../guides/extract-knowledge.md#reproduce-extraction-quality-checks). A new run is new evidence; it cannot silently replace this record. Entity and current storage contracts are described in the [entity extraction specification](../specs/entity-extraction.md).

This report preserves the original v2/v3 evidence captured at the time. Current runtime and quality tools support only v3, without replay or migration of older formats; historical results have not been recalculated.
