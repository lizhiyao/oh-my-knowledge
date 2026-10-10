# Entity extraction from selected records

Status: the #1119 foundation and #1127 P2/P3 contract and interface changes are implemented. The [P4 evaluation guide and offline checker](./entity-extraction-evaluation.md) prepare draft annotations; independent review and new model acceptance remain pending. Only current data structures are supported, without legacy readers, recovery, or migration. The [v2/v3 comparison report](../explanation/entity-extraction-quality.md) preserves historical results and one pending object-granularity adjudication. Research and structural validation do not prove model performance.

See the [entity identity rules](./entity-identity.md) for components/instances, collections/unresolved identities, renames/versions, and later corrections. Section 8 defines the approved current contracts; Studio supports link/member inspection and correction. Historical acceptance results stay unchanged; independent semantic acceptance of the new prompt remains pending.

## 1. User outcome and scope

Users inspect which objects selected records discuss, which mentions refer to the same object, and which remain uncertain. Multiple knowledge candidates reference the same analysis. People, files, systems, rules, concepts, and plans can be entities; subject and object are statement roles. See [How OMK understands knowledge](../explanation/knowledge.md).

The first release covers one immutable source window. Matching names, paths, types, or similar wording do not establish identity. It does not automatically merge across logs, build a global entity database, or infer a graph. Identifying an object does not verify statements about it.

Users keep the select-records → extract entry point. Results and history provide optional entity inspection and correction, including runs with no knowledge candidates. Entity review is not a mandatory extra step.

The workspace entity catalog is a query projection of existing window analyses, not a canonical cross-log identity registry. Studio and CLI search current entities, mentions, qualifiers, and origins while preserving analysis/entity/revision identities; exact revisions support history inspection. Linked knowledge counts only current knowledge revisions and exposes their actual entity bindings and subject/object roles. Older bindings, discard choices, and unavailable sources remain visible without implying verification.

## 2. Research and decisions

| Primary source | Relevant practice | OMK decision |
|---|---|---|
| [End-to-end Neural Coreference Resolution](https://aclanthology.org/D17-1018/) (2017) | Spans and context support mention and antecedent decisions. | Retain mention positions and correspondence rationale; do not resolve pronouns mechanically to the nearest name. |
| [GLiNER](https://aclanthology.org/2024.naacl-long.300/) (2024) | Open entity types in named entity recognition. | Keep open types; evaluate recognition separately from identity. Do not introduce another Python model dependency initially. |
| [Joint entity-level relation extraction](https://aclanthology.org/2021.eacl-main.319/) (2021) | Joint use of local mentions, coreference, and entity relations. | Prefer one invocation with independent results and a shared window catalog referenced by candidates. Logical boundaries do not require two invocations. |
| [GraphRAG Dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/) | TextUnit provenance; joint entity/relation extraction; default merging by name and type. | Retain provenance; name/type merging violates OMK's homonym boundary, so do not adopt it or full graph indexing. |
| [W3C Web Annotation](https://www.w3.org/TR/annotation-model/#text-quote-selector) | Quotes with surrounding text distinguish repeated passages. | Use exact quote occurrences selected explicitly by the model; the host computes positions and never chooses the first ambiguous match. This is OMK's selector, not complete protocol compatibility. |
| [LLM coreference evaluation](https://aclanthology.org/2024.lrec-main.145/) (2024) | Automatic and manual analysis examines prompts and failures. | Report structural admission separately from semantic errors against cases frozen before output. |
| [LEA coreference evaluation research](https://aclanthology.org/P16-1060/) (2016) | Entity links inform coreference evaluation. | Check required links and separations independently; do not substitute entity counts or name matches. Do not claim a full LEA implementation. |

These sources inform decisions; they do not demonstrate performance on OMK logs. A single invocation is the current architecture choice. Adding another invocation requires controlled evidence of benefit, cost, and failure behavior with fixed inputs, model, and review criteria.

## 3. Contracts and identity

An independent entity analysis contains entities, mentions, identity ambiguity, and source limitations. Model identifiers are local to the window. The host assigns UUIDs once for the analysis, shared across candidates.

- Mentions retain exact quotes, references, UTF-16 positions, explicit/inferred basis, and correspondence rationale.
- Descriptions identify objects; qualifiers describe project, version, and environment. Substantive knowledge belongs in contextual statements with evidence.
- An unresolved mention refers to a local unknown object with possible targets and uncertainty, never an arbitrarily chosen target.
- Every entity has an admitted mention; mentions, possible targets, and statements have closed references. Empty entity and knowledge results are valid.
- Model quotes use `evidenceRef`, exact continuous `quote`, and optional zero-based `occurrence`, counting overlapping matches. Multiple matches require an explicit occurrence; missing or out-of-range indices are rejected. The host computes UTF-16 offsets without normalization, fuzzy matching, or model-supplied offsets. Old prefix/suffix selectors are rejected.
- Required `referentKind` distinguishes object, component, instance, version, collection, plan, and activity. `componentRef` is null or a source-backed link from an instance/version to a proposed component; `collection` is null except for collections and records known members, completeness, supporting mention IDs, and rationale. References remain within this analysis. Unknown membership differs from unresolved identity; candidates must have the same referent level. Duplicate, missing, or cyclic members are rejected.
- Link evidence must include an own-entity mention. A collective phrase has one mention, without copied spans for its members. Cases use only descriptive statements as actions/outcomes. Structural admission does not verify any identity judgment or statement.
- Partial rejection records individual reasons. Invalid mentions cannot support entities; invalid entities cannot support statements. Admission does not silently repair results or drop ambiguity.

## 4. Corrections and knowledge revisions

Entity analysis has immutable revisions, parent revisions, authors, timestamps, and reasons, with generation/head checks and idempotent write identities. Users can reassign mentions, split/merge local objects, add omitted mentions, remove false mentions, and retain ambiguity. A mention identity cannot move to different source text; relocation creates another mention. Studio explicitly corrects level, component links, collection members/completeness and evidence. Field changes do not silently remove other information; inconsistent drafts must be corrected. Before merging/removing entities or reassigning mentions, explicitly correct dependent component, membership, candidate and evidence references. The UI lists dependent entities for inspection; it does not drop references or infer membership completeness. Before merging, explicitly remove the original entity's own link information and inspect the target; removal deletes its own information but does not rewrite other entities. Original revisions and source snapshots remain preserved.

Knowledge grounding binds an exact analysis revision. Later corrections do not overwrite old knowledge. Applying a correction requires checking statement roles and evidence, and produces another knowledge revision. Splitting an old object does not let the workflow pick one replacement subject arbitrarily.

Corrections remain human or agent judgments, not automatic truth verification, and do not inherit retention decisions. Deleted or unreadable sources remain explicitly unavailable; saved quotes alone do not establish that original text was checked again.

Applying entities preserves prior additional identity uncertainty notes by default; users may explicitly review and change them, while historical notes remain in old revisions. Current catalog uncertainties are mandatory and cannot be erased with empty input. Inspect statement conditions, exceptions, and unknowns separately; renaming or merging entities does not delete them automatically.

## 5. Domain and runtime boundaries

`knowledge` owns pure contracts, references, and revision invariants. `observability/knowledge-extraction` owns selected windows, model transport, admission, and application workflows; file adapters implement storage. Studio and CLI share the workflow. Evaluation Core does not own observed entities or filesystem effects.

Persist a reservation before invoking the model, and raw output/reported usage before preparing entity and knowledge write intents. Recovery uses allocated identities, the current prompt identity, and idempotent commands without invoking the model again. Commit entities before knowledge; interrupted knowledge intents remain resumable.

Only selected excerpts and scope limitations are sent. Native paths stay local; instructions in logs cannot expand reading or invoke tools. Unreported cost is unknown, not zero.

## 6. Current storage contracts

`entities/<analysis-id>.json` uses `entity-analysis-history` v2 with immutable entity revisions, source bindings, and write receipts. `items/<identity-digest>.json` uses `knowledge-item-history` v2; knowledge generated by this extraction workflow binds grounding to an exact entity analysis revision.

`runs/<run-id>.json` uses `knowledge-extraction-run` v4. Storage validates the file Schema; `promptVersion` preserves the provenance identity `knowledge-extraction-vN` (positive integer version), with v5 used for new generations. Prompt identity is independent of file format. Reading/resuming existing Schema v4 runs preserves their original version, hash, raw output and entity/knowledge intents, without re-extraction or result upgrades. New request digests bind the current prompt and cannot reuse a runId for another prompt. This is not a legacy-format reader: old formats such as Schema v3 remain rejected.

This approved replacement is `BREAKING-SCHEMA` and `BREAKING-COMPARABILITY`: entity history changes from v1 to v2, run and model response from v3 to v4, and prompt identity to `knowledge-extraction-v4`. New prompt bytes and admission semantics require a new digest and new quality measurement identity. Historical reports, corpora, and evidence are not recalculated or modified. Historical v3 acceptance scripts fail before configuring a model under the v4 runtime, including when passed a frozen v3 prompt; reproduce them at their frozen base revision. P4 must define a new corpus/check identity before new model acceptance.

There is no compatibility reader, migration, automatic rewrite, or deletion. Old entity histories are unavailable, and old runs cannot resume; old knowledge v2 bodies stay readable, with their old entity analysis unavailable. Choose a new empty knowledge directory and extract again from original logs. Newly extracted entities never automatically take over old knowledge bindings.

v5 changes type-evidence, shared-reference and negation instructions only; model response v4, entity history v2, knowledge history v2 and run v4 remain unchanged, with no migration. Prompt bytes and corpus/guide/checker identities change, so this is `BREAKING-COMPARABILITY`. Historical quality tools remain pinned to their original runtime, including when handed an old prompt under v5. New model evaluation is pending.

Current v5 raw UTF-8 prompt digest: `sha256:8d7174c13f2b336979c5da01330ef00e3076309d194364e74d0abef11c2d39ad`. Run `promptHash` retains canonical JSON hashing; this digest freezes raw bytes, not model quality acceptance.

Writes serialize through the workspace's `.knowledge-write.lock`. Only a local PID proven exited by SIG0 returning ESRCH permits recovery; lock age and run status are insufficient. Recoverers serialize by the original owner identity to avoid deleting a later live lock. Interrupted recovery guards follow the same rule.

The entity catalog reads current `entities` histories without writing duplicate entities or a persistent index. Corrupt, unsupported, and symlink files count as unreadable analyses; healthy analyses remain searchable with an explicit incomplete-result notice. One scan allows at most 4,096 JSON files and 64 MiB total file size, then fails rather than silently truncating. Queries default to 20 entities per page, allow at most 100, and sort by revision time and stable identities. Unreadable linked knowledge makes counts unknown, not zero. Unavailable sources prevent correction.

## 7. Quality and completion evidence

Before model runs, freeze important mentions, allowed correspondences, mandatory separations, unresolved referents, and statement subject/object roles. Synthetic cases do not establish coverage of real users. Reports identify authorship and review limitations.

Report important omissions, false mentions, wrong links/merges, unjustified resolution, and downstream role errors separately. Exact quote matching proves location; reference closure proves structure; neither alone proves semantics. Comparisons retain per-case output, input/prompt digests, actual usage, and failures.

Completion requires independent results, usable inspection/correction, shared knowledge identities and revision binding, empty/partial/interrupted behavior, current-format and unsupported-version rejection evidence, semantic quality reporting, real entry acceptance, bilingual documentation, autonomous review, and delivery gates. Cross-log and cross-agent value is not inferred from this work.

The completed [quality report and original evidence](../explanation/entity-extraction-quality.md) separate structural results, exact positions, Agent semantic review, and unknown cost. It supports independent entity coverage on the frozen synthetic cases; it does not establish fewer object errors in knowledge or independently reviewed real-log quality.
