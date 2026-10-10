# Entity extraction v6: single-round real-conversation diagnostic

## Conclusion

**Extraction quality still needs improvement.** Following explicit user approval, seven real-conversation windows were captured once and reviewed by the author on 2026-10-10. All seven calls produced admissible outputs; all 79 entities, 93 mentions, 12 knowledge candidates and 32 statements were reviewed. Three windows omitted the Session concept, one mention insufficiently retained ambiguity, and one statement mixed positive and negative propositions. Structural admission and successful file storage do not mean semantic acceptance passed.

Of 31 frozen knowledge-relevant object expectations, 28 had corresponding objects and three were missing; three additional referent-kind mismatches remain. Expectations are not exhaustive entity or mention gold: **28/31 is not overall accuracy or recall**. Reasonable extra objects were reviewed individually rather than rejected for being absent from expectations. Independent review was not performed, `goldReady=false`, and overall precision/recall/F1 are not computed.

## Measurement and evidence

[Download the sanitized summary JSON](/entity-extraction-v6-real-pilot.json): measurement identity, input/output and full local-material digests, per-case counts, admission status, self-review categories, executor-projected usage and application replay results. Real messages, raw model outputs, detailed annotations, itemwise rationales and original paths remain local and do not enter the public repository. Digests bind evidence; they do not make every semantic judgment independently reproducible from public materials.

| Item | Recorded in this run |
| --- | --- |
| Measurement identity | `sha256:1f32b9c95a8162966daf64e9702235609a3faccb3a920eec8c4f0fce61603e88` |
| Prompt | Frozen `knowledge-extraction-v6`, including inline Schema; digest `sha256:a30cdfe20296d3294bbea7920b839934573bf0b69e27fbc4788493d57fdffffb` |
| Build source | `9caf1215136e1751a5b6ab3c610c10b22cda049a`; capture repository commit `1173285ee9f349e101e3772ecf2d236f2b8f494e` contains only intervening test/document changes, with identical production sources. Runtime byte digests were bound and checked after calls. |
| Contracts | Response v4, entity history v2, knowledge history v2 and extraction run v4; this run changes no contracts, prompt or historical scores. |
| Input | Two source groups, seven windows, 21 redacted window messages and 18 unique messages; before/after-evidence windows share three messages. |
| Execution | Existing Codex `gpt-6.1-sol`, seven actual calls in one round, concurrency two, no automatic retries; one turn each, without subagents or tool calls. |
| Sent data | Only selected messages, time/index, coverage limits and the frozen prompt/Schema; no annotations, review standards, original paths or historical outputs. |
| Time and usage | 15:40:26.822–15:46:34.520 UTC, wall clock 367.698 seconds; executor-reported inputTokens 63,104, outputTokens 26,463 and cacheReadTokens 86,016. Counters are projections, not provider bills; cache and input fields are not added to estimate cost. Dollar cost is unknown; an unreported placeholder zero is not an actual zero cost. |
| Review | The implementation agent checked every entity, mention, knowledge candidate and statement; this is author self-review, not independent human evidence. |

Call failures, cancellations, parse failures, root structural rejections, entity rejections and knowledge rejections were all zero. The original program check retains its then-current `semanticReview=pending`; subsequent self-review is stored separately without rewriting capture records. All seven authorized calls are spent; no automatic additions or authorization expansion follow.

## Per-case results

| Window | Entities / mentions / knowledge / statements | Author self-review |
| --- | --- | --- |
| `real-symbolication-scope` | 7 / 12 / 2 / 6 | No semantic issue found; concepts, software, mapping files and planned activities remain separate, and example paths are not presented as measured failures. |
| `real-protected-correction` | 18 / 21 / 1 / 4 | No semantic issue found; methods, fields, versions and the asynchronous ownership concept remain separate. A library modeled as component conflicts with the frozen object expectation; the disagreement remains. |
| `real-retained-adapters` | 16 / 16 / 2 / 4 | Session concept omitted; its ownership adaptation and an adaptation collection do not replace the concept. Retained items, plans and unverified status still preserve source limits. |
| `real-session-before-resolution` | 11 / 13 / 2 / 6 | Session concept omitted; counts and status updates are not Session itself. Later explanations were not injected into this earlier window, and counts did not create instance identities. |
| `real-session-after-resolution` | 18 / 21 / 2 / 6 | Session concept omitted; one statement mixes positive and negative propositions with unclear single-polarity scope. Master modeled as version conflicts with the frozen object expectation. |
| `real-historical-product-claim` | 9 / 10 / 3 / 6 | An initially ambiguous Memory mention is assigned solely to the assistant's chosen answer object; fields insufficiently preserve uncertainty about the user's referent. Local Memory modeled as component conflicts with the frozen object expectation. Historical claims remain source assertions. |
| `real-acknowledgement` | 0 / 0 / 0 / 0 | An isolated “OK” has no antecedent object; empty entities and knowledge are correctly retained. |

### Missing central objects

Session statistics, status updates and ownership adaptations can be separate objects, but cannot replace the Session concept explicitly discussed in a window. Three omissions come from related software conversations, with overlapping messages in two windows; this is a reproducible diagnostic direction, not three independent population samples. Future rules and counterexamples should distinguish central concepts from their attributes and processes without splitting every compound word into unhelpful entities.

### Referential ambiguity

The historical product window explicitly offers several possible meanings without subsequent user disambiguation. The model's rationale describes the final answer object and lack of user confirmation, yet structurally assigns the initial mention to a single identity. That inference has contextual support and is not an invented object; the issue is that explanatory uncertainty does not reach identity/candidate fields. The assistant's choice of answer cannot automatically confirm the user's original referent.

### Statements and negation scope

The later-evidence window puts a positive norm and a negative norm into one relation with one negative polarity. Context explains that negation applies only to the latter clause, but the structural fields do not clearly express both propositions. The author judges that two statements are needed; this does not prove the source fact was reversed. The earlier window already separates them, and its correct representation does not override the later output's issue.

### Referent-kind annotation disagreements

A library, the local Memory feature and master produce component, component and version respectively, while frozen expectations permit only object. The source continuously discusses implementation functions or compares code state with releases; the author finds reasonable modeling explanations rather than treating all three as proven semantic errors. Frozen mismatches remain. Reasonable alternatives must be adjudicated before a future freeze, without changing answers after outputs to improve this run's counts.

## Application replay

Original redacted messages were captured through the current application entry point in an isolated workspace, with an adapter returning this run's recorded outputs: **zero additional external model calls**. Only evidenceRef values were rebound bijectively to new snapshots; original outputs remain unchanged. Original/rebound digests and mappings remain local, with original coverage limits and replay capture limits preserved separately. Message text, roles, times and indices were checked itemwise.

All seven extraction runs completed: 79 entities are searchable, 93 mentions are locatable and entity bindings for 12 knowledge candidates are readable. This verifies current file-storage and query wiring for these outputs, not repairs to omissions or ambiguity; candidates are not thereby treated as user-accepted knowledge. Chrome correction/history interaction acceptance was not repeated in this run; UI evidence reuses the [previous 11-output workflow acceptance](./entity-extraction-v6-diagnostic.md#workflow-acceptance-with-recorded-outputs).

## Coverage limits and follow-up

The sample is software-heavy and reuses material whose historical knowledge outputs were already viewed; it is neither blind nor representative of real logs. Only selected messages enter the model; tool, system and unselected surrounding records are omitted. Another 24 source records could not be parsed, leaving overall source completeness unknown. Redaction changes strings, and all locations target redacted text. Source assertions are not independently verified facts; historical product statements are not current official capability conclusions.

This is one small round. Backend model revision, seed, sampling parameters and default reasoning effort were not fixed or reported. Results do not establish population stability, causal prompt gains, long-conversation performance or cross-agent reuse benefits. Viewed windows can only become development regressions. The earlier synthetic 39/40 uses different units and remains unchanged rather than combined or rescored.

Next corrections focus on missing central concepts, structural retention of ambiguity and polarity scope in atomic statements; referent-kind alternatives require adjudication before freezing. Completed execution and reporting do not mean entity capabilities are complete; independent review and full quality gates remain in [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127). This report follows the [small real-conversation preparation](./entity-extraction-v6-diagnostic.md#preparing-a-small-real-conversation-evaluation) without rewriting historical preparation records.
