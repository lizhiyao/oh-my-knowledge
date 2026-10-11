# Entity annotation v12: complete-name coverage audit

**Complete-name annotations have been systematically revised against all sources; this iteration makes zero model calls and creates no new extraction-quality score.** All 60 windows/199 critical mentions were reviewed, adding 32 alternatives to 26 mentions in 19 windows and recording 60 candidates inappropriate as names for their target referents. Original stopped-v11 2/3, two not-evaluable identity pairs and two unattempted cases remain, as do v10 10/13 and every original record.

## Scope and rules

This follows the [v11 diagnostic stopped after one case](./entity-extraction-v11-boundary-diagnostic.md), beyond adding “已发布 r2”. All messages, old boundaries, bound identities and context were read itemwise, considering contiguous noun descriptions with type words, articles/demonstratives, owners, locations and time qualifiers. Added alternatives preserve source bytes and independently calculated occurrence/UTF-16 positions. They refer to the same source occurrence and object rather than substituting a name elsewhere.

| Source category | Added alternative examples | Excluded binding or expansion |
|---|---|---|
| Projects and owned files | 项目 Pavo; 项目 Pavo 的 a.md | Binding the full file phrase to its project. |
| Types and English instances | Rill 调度器; Its test instance `sieve/dev01`; Plan P8 | Entire definitions/execution claims; binding coordinated deployed instances to one member. |
| Categories, locations and references | 键盘这一类物品; 桌上的这把键盘; 本次说的这家店; 这里的栈 | Discussion/disambiguation predicates; merging a category with a concrete device. |
| Activities and release qualifiers | 昨天的更新活动 U1; 已发布 r2 | 今天计划执行 U2; binding main 上的改造 to code state. |
| Owner-qualified fields | 客户端 L 的 errorStatus; 服务 S 的 enabled 字段 | Binding to the client/service itself; entire assignments including operators, values and environment. |

Ownership depends on the phrase's actual head, without mechanically cutting “的” or “上的”. Owner-qualified file/field descriptions can identify those objects and overlap with shorter owner mentions; an attribute phrase does not become an alias for its owner. Predicates, actions, assignments, member lists and attribute heads remain separate from object names.

## Revision and provenance

Current corpus is `omk-entity-quality/v12`, guide `omk-entity-annotation/v10`; prompt stays `knowledge-extraction-v11` and checker algorithm v4. Source text/roles/limits, entity identities/levels, critical mention identities/count, knowledge roles, semantic criteria, project/conversation groups and splits all remain unchanged (58 development/two reserved validation). Old alternatives are retained; reviewed boundaries and reasons are added only in a new copy. Original v11 corpus bytes remain untouched.

[Download itemwise audit JSON](/entity-name-annotation-v12-audit.json): all 60 cases/199 reviewed mention IDs, source digests, added text/positions/reasons and one excluded example per case. Production admission and location checks pass for 32 added alternatives. The 60 excluded examples may be valid source selections but are not exact matches for the critical mentions to which they are wrongly bound. No automatic trimming, suffix regex, wide-span tolerance or semantic guessing is added.

Changed corpus/guide identities and compiled tool digests are `BREAKING-COMPARABILITY`. Production prompt bytes, checker algorithm, response v4/entity and knowledge histories v2/run v4 remain unchanged, without migration. The current tool accepts only corpus v12, without a legacy reader. Historical report audits read the immutable frozen shape; old results reproduce under their old builds.

## Offline inspection of recorded outputs

[Download replay JSON](/entity-name-annotation-v12-replay.json): five recorded v10 and one recorded v11 synthetic outputs, with original evidence identities, output digests, original admission results and coverage checks against the new corpus. No output is generated, retried or edited, and knowledge text remains unchanged. Structural admission remains identical.

Recorded v11 “已发布 r2” is covered in the new copy, without rewriting the original stop or strict 2/3. Recorded v10 “main 上的改造” remains inappropriate as a code-state name and stays a boundary finding. Covering reasonable complete names does not make every old output correct. Explicitly labeled synthetic span probes check location/matching for the other alternatives; probes are not model output.

The previous five calls plus one stopped-case call still supply only six existing records. Their replay creates no “v12 model score” and cannot substitute for unattempted configuration-type or keyboard cases. No denominator becomes the planned nine mentions; old reports and comparison conclusions stay unchanged.

## Limits and follow-up

This is implementation-agent itemwise source self-review. Viewed gaps and development outputs are not blind labels or independent evidence; `goldReady: false`. Every existing critical mention was audited, but finite alternatives do not claim all synonymous/nested descriptions or annotate every noun. Future reasonable expressions require an explicit new revision while retaining that run's strict miss.

New model calls, real-log collection and Studio-flow acceptance are all zero. Stability, full quality, independent review and model behavior on the two reserved windows remain unverified. [Issue #1127](https://github.com/lizhiyao/oh-my-knowledge/issues/1127) retains these incomplete items. Only future separately decided model acceptance can establish fresh effectiveness evidence under the current rules.
